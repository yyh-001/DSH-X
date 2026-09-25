/**
 * MCP 服务器管理：读写 profile 补丁层 cordis.patch.yml 里的 dsh-mcp-client 插入条目。
 *
 * 官方的 MCP 接入形态（dsh-mcp-client README）：每个外部 MCP 服务器就是组合树里的
 * 一条插件条目——`name: '@deepseek-ai/dsh-mcp-client'`，config 带 serverName/transport/...；
 * 工具以 `mcp__<serverName>__<tool>` 暴露给模型。profile 树里默认没有 client 条目，
 * 所以这里用补丁层的 insert 语义新增条目（cordis-plugin-include 的 applyEntryPatches：
 * 普通 patch 条目只覆盖已有 id，只有不带 id 的 `insert:` 才往顶层树里 push 新行）。
 *
 * 为什么用「标记区块 + 单行 JSON」而不是整文件 YAML 解析：
 * - 补丁层允许 `!!js` 表达式（用户的其他条目可能在用），零依赖手写 YAML 解析器接不住；
 *   JSON 是 YAML 的子集，自己的条目用单行 flow JSON 写，读写都只需文本手术，
 *   区块之外的字节永远不动；
 * - 每个服务器一对 begin/end 标记，plugins.js 追加的禁用块落在文件末尾（标记之外），两边互不踩。
 *
 * 热生效：dsh-hmr 会 watch profile 的 patchPath 和 `$DSH_HOME/cordis.patch.yml`，改动会
 * 原地重载（新条目启动、改动条目重连），不用重启。（注意：profile 的 package.json 里那个
 * `patchReload: live` 不是 dsh 认识的键，热重载跟它无关。）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { looksLikeEntryList } from './plugins.js'

export const MCP_CLIENT_PKG = '@deepseek-ai/dsh-mcp-client'

/** serverName 是工具名前缀的一部分，官方约束：1-32 位 [A-Za-z0-9_-]，同一注册范围内唯一。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/** 官方只认这两种传输（dsh-mcp-client 的 config union 里就是这两个字面量）。 */
const TRANSPORTS = new Set(['stdio', 'streamable-http'])

const BEGIN_LINE = (serverName) => `# ==== dshx-mcp:begin ${serverName} ====`
const END_LINE = '# ==== dshx-mcp:end ===='
/** begin / end 标记行（end 行允许是文件最后一行、没有换行）。 */
const MARK_RE = /^# ==== dshx-mcp:(begin (.+?)|end) ====[ \t]*(?:\r?\n|$)/gm
const ENTRY_JSON_RE = /^[ \t]+- (\{.*\})[ \t]*$/

/** 编辑保存时要从上一次条目里带回来的字段（都是官方 schema 认识的键）。 */
const CARRY_KEYS = ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect']

const has = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key) && object[key] !== undefined

/**
 * 只放行认识的配置字段，别的键一律丢弃——写进补丁层的东西必须是我们能解释的
 * （官方 config 是 schemastery 校验的 union，塞未知键会让整行加载失败）。
 * 上一次条目里认识、这次没提到的字段会原样带回来，编辑不再丢配置。
 */
function buildConfig(spec, previous) {
  const serverName = String(spec.serverName || '').trim()
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error('名称只能用字母、数字、下划线、连字符（1-32 个字符）')
  }
  const warnings = []
  const rawTransport = String(spec.transport ?? '').trim()
  const hasCommand = Boolean(String(spec.command ?? '').trim())
  const hasUrl = Boolean(String(spec.url ?? '').trim())
  let transport
  if (!rawTransport) {
    transport = hasUrl && !hasCommand ? 'streamable-http' : 'stdio'
  } else if (TRANSPORTS.has(rawTransport)) {
    transport = rawTransport
  } else if (rawTransport === 'sse') {
    throw new Error('dsh 的 MCP 客户端只支持 stdio 和 streamable-http：SSE 服务请填 http(s) 地址并把传输选成 HTTP')
  } else {
    throw new Error(`认不出传输方式「${rawTransport}」，只能是 stdio 或 streamable-http`)
  }

  const config = { serverName, transport }
  if (transport === 'stdio') {
    const command = String(spec.command ?? '').trim()
    if (!command) throw new Error('stdio 传输需要填写启动命令')
    config.command = command
    const args = Array.isArray(spec.args)
      ? spec.args
      : String(spec.args ?? '').split(/\s+/)
    const clean = args.map((item) => String(item)).filter((item) => item !== '')
    if (clean.length) config.args = clean
    const env = stringRecord(spec.env)
    if (env) config.env = env
    const cwd = String(spec.cwd ?? '').trim()
    if (cwd) config.cwd = cwd
    if (hasUrl) warnings.push('stdio 传输用不到 url，已忽略')
  } else {
    const url = String(spec.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('streamable-http 传输需要 http(s) 服务地址')
    config.url = url
    const headers = stringRecord(spec.headers)
    if (headers) config.headers = headers
    if (hasCommand) warnings.push('HTTP 传输用不到启动命令，已忽略')
  }

  for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) {
    if (!has(spec, key)) continue
    if (spec[key] === '' || spec[key] === null) continue // 显式清空
    const value = Number(spec[key])
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 要是正整数`)
    config[key] = value
  }
  if (has(spec, 'failOnStartupError')) {
    if (spec.failOnStartupError === true) config.failOnStartupError = true
    else if (spec.failOnStartupError !== false) throw new Error('failOnStartupError 只能是 true 或 false')
  }
  const reconnect = normalizeReconnect(spec.reconnect)
  if (reconnect) config.reconnect = reconnect

  if (previous && typeof previous === 'object') {
    const carry = [...CARRY_KEYS, ...(transport === 'stdio' ? ['args', 'env', 'cwd'] : ['headers'])]
    for (const key of carry) {
      if (has(config, key)) continue
      if (!has(spec, key) && previous[key] !== undefined) config[key] = previous[key]
    }
  }
  return { config, warnings }
}

/** reconnect 是官方 schema 里的自动重连策略对象，只放行认识的键。 */
function normalizeReconnect(input) {
  if (input === undefined || input === null || input === '') return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('reconnect 要是一个对象，例如 {"maxAttempts":5}')
  }
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('reconnect.enabled 只能是 true 或 false')
      out.enabled = value
    } else if (['initialDelayMs', 'maxDelayMs', 'maxAttempts'].includes(key)) {
      const number = Number(value)
      if (!Number.isInteger(number) || number <= 0) throw new Error(`reconnect.${key} 要是正整数`)
      out[key] = number
    } else {
      throw new Error(`reconnect 里认不出字段 ${key}`)
    }
  }
  return Object.keys(out).length ? out : null
}

/** KEY=VALUE 文本行 / 普通对象 → 干净的 string→string 记录（null 表示不用写）。 */
function stringRecord(input) {
  const out = {}
  if (Array.isArray(input)) {
    for (const line of input) {
      const text = String(line ?? '')
      if (!text.trim()) continue
      const at = text.indexOf('=')
      if (at <= 0) throw new Error(`环境变量每行要写 KEY=VALUE，看不懂这行：${text}`)
      out[text.slice(0, at).trim()] = text.slice(at + 1)
    }
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (!String(key).trim()) continue
      out[String(key)] = String(value ?? '')
    }
  }
  const keys = Object.keys(out)
  if (!keys.length) return null
  if (keys.some((key) => /[\r\n=]/.test(key))) throw new Error('键名里不能有换行或等号')
  return out
}

/** 从区块体里解出条目对象（找不到/解不动返回 null，由调用方标记损坏）。 */
function parseEntry(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = ENTRY_JSON_RE.exec(line)
    if (!match) continue
    try {
      return { entry: JSON.parse(match[1]), error: '' }
    } catch {
      return { entry: null, error: '条目 JSON 解析失败（区块可能被手改过）' }
    }
  }
  return { entry: null, error: '区块里没有条目行' }
}

/**
 * 扫出补丁层里所有本启动器管理的区块（只认标记行，不解析整份 YAML）。
 *
 * 缺 end 标记的区块照样报出来：那种块以前会整个隐身——补丁层里明明写着、dsh 也照样加载，
 * 页面却看不见、也删不掉。现在标成 broken 列出来，允许直接删掉重加。
 */
function scanBlocks(text) {
  const source = String(text ?? '')
  const marks = []
  for (const match of source.matchAll(MARK_RE)) {
    const isBegin = match[1].startsWith('begin')
    marks.push({
      kind: isBegin ? 'begin' : 'end',
      serverName: isBegin ? String(match[2] || '').trim() : '',
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  const blocks = []
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    if (mark.kind !== 'begin') continue
    const next = marks[index + 1]
    const closed = Boolean(next && next.kind === 'end')
    const bodyEnd = closed ? next.start : (next ? next.start : source.length)
    const rangeEnd = closed ? next.end : bodyEnd
    const parsed = closed
      ? parseEntry(source.slice(mark.end, bodyEnd))
      : { entry: null, error: '区块缺少结束标记（文件被手改过或上次写入被打断）' }
    blocks.push({
      serverName: mark.serverName,
      start: mark.start,
      end: rangeEnd,
      closed,
      entry: parsed.entry,
      error: parsed.error,
    })
    if (closed) index += 1
  }
  return blocks
}

function renderBlock(serverName, entry) {
  return `${BEGIN_LINE(serverName)}\n- insert:\n    - ${JSON.stringify(entry)}\n${END_LINE}\n`
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 列出补丁层里由本启动器管理的 MCP 服务器（不动文件）。 */
export function listMcpServers(patchPath) {
  let text = ''
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return { servers: [], patchExists: false }
  }
  const servers = scanBlocks(text).map((block) => {
    const entry = block.entry
    if (!entry) {
      return {
        serverName: block.serverName,
        id: '',
        disabled: false,
        transport: 'stdio',
        command: '',
        url: '',
        args: [],
        env: null,
        headers: null,
        cwd: '',
        config: null,
        error: block.error,
        broken: true,
      }
    }
    const config = entry.config && typeof entry.config === 'object' ? entry.config : {}
    return {
      serverName: String(config.serverName || block.serverName),
      id: String(entry.id || ''),
      disabled: entry.disabled === true,
      transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      command: String(config.command || ''),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: config.env && typeof config.env === 'object' ? config.env : null,
      cwd: String(config.cwd || ''),
      url: String(config.url || ''),
      headers: config.headers && typeof config.headers === 'object' ? config.headers : null,
      toolCallTimeoutMs: Number(config.toolCallTimeoutMs) || undefined,
      maxInstructionBytes: Number(config.maxInstructionBytes) || undefined,
      failOnStartupError: config.failOnStartupError === true,
      reconnect: config.reconnect && typeof config.reconnect === 'object' ? config.reconnect : null,
      config,
      error: '',
      broken: false,
    }
  })
  return { servers, patchExists: true }
}

function backupOnce(patchPath) {
  try {
    if (existsSync(patchPath)) copyFileSync(patchPath, `${patchPath}.bak`)
  } catch {
    // 备份失败不阻塞写入本身
  }
}

/** 写之前把结果整份过一遍条目数组校验，宁可拒绝也不写出让 profile 起不来的文件。 */
function assertWritable(patchPath, text) {
  if (looksLikeEntryList(text)) return
  throw new Error(`写入后 ${patchPath} 会不再是合法的条目数组，已拒绝保存；请先修正 cordis.patch.yml`)
}

/**
 * 保存（新增或更新）一个 MCP 服务器条目。按标记区块定位：同 serverName 的区块整体重写，
 * 新的追加到文件末尾；区块之外的内容一个字节都不碰。
 *
 * 编辑语义（修掉老版本的坑）：
 * - 表单没提交 disabled 时沿用原条目的停用状态，不再「编辑一下就把停用的服务器打开了」；
 * - 上次条目里认识、这次没提到的字段（env/cwd/timeout/maxInstructionBytes/reconnect…）原样带回。
 */
export function saveMcpServer(patchPath, spec) {
  const serverName = String(spec.serverName || '').trim()
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error('名称只能用字母、数字、下划线、连字符（1-32 个字符）')
  }
  const text = readText(patchPath)
  const sameName = scanBlocks(text).filter((block) => block.serverName === serverName)
  const usable = sameName.filter((block) => block.closed && block.entry)
  if (usable.length > 1) {
    throw new Error(`补丁层里有 ${usable.length} 个名为 ${serverName} 的区块，先手工清掉多余的再保存`)
  }
  const previous = usable[0]?.entry ?? null
  const { config, warnings } = buildConfig(spec, previous?.config)
  const entry = { id: `dshx-mcp-${serverName}`, name: MCP_CLIENT_PKG }
  const disabled = typeof spec.disabled === 'boolean' ? spec.disabled : previous?.disabled === true
  if (disabled) entry.disabled = true
  entry.config = config

  const block = renderBlock(serverName, entry)
  const target = usable[0] ?? sameName[0] ?? null
  const repaired = Boolean(target && !usable[0])
  const next = target
    ? text.slice(0, target.start) + block + text.slice(target.end)
    : appendBlock(text, block)
  assertWritable(patchPath, next)
  backupOnce(patchPath)
  ensureParent(patchPath)
  writeFileSync(patchPath, next)
  return { ok: true, warnings, replaced: Boolean(target), repaired }
}

/** profile 目录还没被 dsh 建出来时也别 ENOENT——先把父目录补上再写。 */
function ensureParent(file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // 建不出来就让后面的写入自己报错，别在这里吞掉原因
  }
}

function appendBlock(text, block) {
  let head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  // 文件还停在 `[]` 占位：先把它注释掉再追加真实条目——`[]` 是完整的根节点，
  // 后面再跟内容整个文件就不是合法 YAML 了（和 plugins.js 追加禁用块同一处理）
  head = head.replace(/^[ \t]*\[[ \t]*\][ \t]*$/m, '# []')
  return `${head}${block}`
}

/** 启用/禁用一个 MCP 服务器（重写它的标记区块）。 */
export function setMcpEnabled(patchPath, serverName, enabled) {
  const name = String(serverName || '').trim()
  const text = readFileSync0(patchPath, '补丁层文件不存在，没有可开关的 MCP 服务器')
  for (const block of scanBlocks(text)) {
    if (block.serverName !== name) continue
    if (!block.entry) throw new Error(`MCP 服务器 ${name} 的条目损坏，无法开关：${block.error}`)
    const entry = block.entry
    const want = enabled === false
    if (Boolean(entry.disabled) === want) return { ok: true, changed: false }
    if (want) entry.disabled = true
    else delete entry.disabled
    const next = text.slice(0, block.start) + renderBlock(name, entry) + text.slice(block.end)
    assertWritable(patchPath, next)
    backupOnce(patchPath)
    writeFileSync(patchPath, next)
    return { ok: true, changed: true }
  }
  throw new Error(`没有找到名为 ${name} 的 MCP 服务器`)
}

/** 删除一个 MCP 服务器的标记区块（损坏的孤儿块也能删）。 */
export function removeMcpServer(patchPath, serverName) {
  const name = String(serverName || '').trim()
  const text = readFileSync0(patchPath, '补丁层文件不存在，没有可删除的 MCP 服务器')
  for (const block of scanBlocks(text)) {
    if (block.serverName !== name) continue
    const next = text.slice(0, block.start) + text.slice(block.end)
    assertWritable(patchPath, next)
    backupOnce(patchPath)
    writeFileSync(patchPath, ensurePlaceholder(next))
    return { ok: true, broken: !block.entry }
  }
  throw new Error(`没有找到名为 ${name} 的 MCP 服务器`)
}

function readFileSync0(file, missingMessage) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new Error(missingMessage)
  }
}

/** 区块删空了就把模板的 `[]` 占位恢复回来（否则 dsh 拒绝启动整个 profile）。 */
function ensurePlaceholder(text) {
  const content = String(text ?? '').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  if (content.length) return text
  if (/^[ \t]*#[ \t]*\[[ \t]*\]/m.test(text)) {
    return text.replace(/^([ \t]*)#[ \t]*\[[ \t]*\][ \t]*$/m, '$1[]')
  }
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${head}[]\n`
}

/* ------------------------------------------------------------------ *
 * 状态检测：真起一次进程 / 真连一次端点，走 MCP 的 initialize 握手，
 * 成功了再问一次 tools/list，把服务器名和工具数报回页面。
 * ------------------------------------------------------------------ */

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_PROBE_TIMEOUT_MS = 20000

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** 在 PATH / 相对路径里找可执行文件（Windows 会按 PATHEXT 逐个试）。 */
function resolveCommandPath(command, env, cwd) {
  const name = String(command || '').trim()
  if (!name) return ''
  if (name.includes('/') || name.includes('\\')) {
    const candidate = isAbsolute(name) ? name : resolve(cwd || process.cwd(), name)
    return existsSync(candidate) ? candidate : ''
  }
  const pathValue = String(env?.PATH ?? process.env.PATH ?? '')
  const extensions = process.platform === 'win32'
    ? String(env?.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

function initRequest(id, clientName) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName || 'dsh-x-manager', version: '1.0.0' },
    },
  }
}

function toolsListRequest(id) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} }
}

/** 把 stdio 子进程包成「发一条 JSON-RPC、等对应 id 的回应」的小会话。 */
function createStdioInspector(child) {
  const pending = new Map()
  let buffer = ''
  let stderr = ''
  let settled = false
  let failure = null

  const failAll = (error) => {
    settled = true
    failure = error
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '').trim()
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const entry = message && message.id !== undefined ? pending.get(message.id) : undefined
      if (!entry) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 2000) stderr += chunk
  })
  child.on('error', (error) => failAll(error))
  child.on('exit', (code, signal) => {
    if (settled) return
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)
    failAll(new Error(`进程提前退出（code=${code}${signal ? `, signal=${signal}` : ''}）${tail ? `：${tail}` : ''}`))
  })

  return {
    get stderr() {
      return stderr
    },
    request(message, timeoutMs) {
      if (failure) return Promise.reject(failure)
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(message.id)
          rejectRequest(new Error(`等了 ${timeoutMs}ms 没有响应`))
        }, timeoutMs)
        pending.set(message.id, { resolve: resolveRequest, reject: rejectRequest, timer })
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`)
        } catch (error) {
          pending.delete(message.id)
          clearTimeout(timer)
          rejectRequest(error)
        }
      })
    },
    notify(message) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {
        // 通知发不出去不影响判定
      }
    },
    dispose() {
      settled = true
      try {
        child.stdin.end()
      } catch {
        // 已经关了就无所谓
      }
      killTree(child)
    },
  }
}

/** 探测完要收拾干净：Windows 上 npx 会带一串子进程，得整棵树干掉。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed || !child.pid) return
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      // 杀不掉就算了，探测不该因此报错
    }
  }
}

async function probeStdio(spec, options) {
  const serverEnv = stringRecord(spec.env)
  const env = { ...(options.env ?? process.env), ...(serverEnv ?? {}) }
  const cwd = String(spec.cwd || '').trim() || options.cwd || process.cwd()
  const command = String(spec.command || '').trim()
  if (!command) return { ok: false, stage: 'config', detail: 'stdio 传输没有配置启动命令' }
  const resolved = resolveCommandPath(command, env, cwd)
  if (!resolved) return { ok: false, stage: 'command', detail: `在 PATH 里找不到「${command}」` }

  const args = (Array.isArray(spec.args) ? spec.args : []).map((item) => String(item))
  // Windows 上 npx/npm 这类是 .cmd 批处理，不能直接 CreateProcess，得借 cmd.exe 跑
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)
  const child = needsShell
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', resolved, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    : spawn(resolved, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

  const inspector = createStdioInspector(child)
  try {
    const firstWait = Math.max(4000, Math.round(options.timeoutMs * 0.6))
    const init = await inspector.request(initRequest(1, options.clientName), firstWait)
    if (init.error) return { ok: false, stage: 'protocol', detail: `initialize 被拒绝：${init.error.message ?? '未知错误'}`, command: resolved }
    const result = init.result ?? {}
    let tools = null
    try {
      inspector.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      const listed = await inspector.request(toolsListRequest(2), Math.max(3000, Math.round(options.timeoutMs * 0.3)))
      if (Array.isArray(listed.result?.tools)) {
        tools = listed.result.tools.map((tool) => String(tool?.name ?? '')).filter(Boolean)
      }
    } catch {
      // 拿不到工具清单不算离线：有些服务器要初始化完才认 tools/list
    }
    return {
      ok: true,
      stage: 'ok',
      detail: `stdio 已握手（协议 ${result.protocolVersion || '未知'}）`,
      serverInfo: result.serverInfo ?? null,
      tools,
      command: resolved,
      stderr: inspector.stderr.trim().slice(0, 300) || undefined,
    }
  } catch (error) {
    const text = errorMessage(error)
    const stage = /没有响应/.test(text) ? 'timeout' : /提前退出/.test(text) ? 'spawn' : 'error'
    const detail = stage === 'timeout'
      ? `进程起来了但 ${Math.round(Math.max(4000, options.timeoutMs * 0.6) / 1000)}s 内没回应 MCP 握手（可能不是 MCP 服务，或首次运行还在下载依赖）`
      : text
    return { ok: false, stage, detail, command: resolved, stderr: inspector.stderr.trim().slice(0, 300) || undefined }
  } finally {
    inspector.dispose()
  }
}

/** 从响应体里挖出 JSON-RPC 对象（streamable-http 可能回 SSE 流）。 */
function parseJsonRpcBody(text, contentType) {
  const raw = String(text ?? '')
  if (/text\/event-stream/i.test(String(contentType ?? '')) || /^data:/m.test(raw)) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      try {
        return JSON.parse(trimmed.slice(5).trim())
      } catch {
        continue
      }
    }
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function probeHttp(spec, options) {
  const url = String(spec.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, stage: 'config', detail: 'streamable-http 传输没有配置 http(s) 地址' }
  const extra = stringRecord(spec.headers) ?? {}
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value

  const send = (body, sessionId) => {
    const merged = { ...headers }
    if (sessionId) merged['mcp-session-id'] = sessionId
    return fetch(url, {
      method: 'POST',
      headers: merged,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  }

  let response
  try {
    response = await send(initRequest(1, options.clientName))
  } catch (error) {
    const text = errorMessage(error)
    return { ok: false, stage: /timeout|timed out/i.test(text) ? 'timeout' : 'network', detail: text.slice(0, 300) }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, stage: 'auth', detail: `HTTP ${response.status}：端点要授权或密钥（页面上填的请求头可能就是缺的那个）` }
  }
  if (!response.ok) return { ok: false, stage: 'http', detail: `HTTP ${response.status} ${response.statusText}`.trim() }

  const sessionId = response.headers.get('mcp-session-id') ?? ''
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  const payload = parseJsonRpcBody(bodyText, response.headers.get('content-type'))
  if (!payload) return { ok: false, stage: 'protocol', detail: '端点回了内容，但不是 JSON-RPC（可能不是 MCP 端点）' }
  if (payload.error) return { ok: false, stage: 'protocol', detail: `initialize 被拒绝：${payload.error.message ?? '未知错误'}` }

  const result = payload.result ?? {}
  let tools = null
  try {
    const listed = await send(toolsListRequest(2), sessionId)
    if (listed.ok) {
      const listPayload = parseJsonRpcBody(await listed.text(), listed.headers.get('content-type'))
      if (Array.isArray(listPayload?.result?.tools)) {
        tools = listPayload.result.tools.map((tool) => String(tool?.name ?? '')).filter(Boolean)
      }
    }
  } catch {
    // 工具清单拿不到不影响在线判定
  }
  return {
    ok: true,
    stage: 'ok',
    detail: `HTTP 已握手（协议 ${result.protocolVersion || '未知'}）`,
    serverInfo: result.serverInfo ?? null,
    tools,
    url,
  }
}

/**
 * 检测一个 MCP 服务器是否真的能用。
 *
 * stdio：解析启动命令 → 起进程 → 发 MCP initialize → 再问一次 tools/list → 收拾进程。
 * http：POST initialize → 认状态码 → 解析 JSON-RPC（含 SSE 响应）→ 用会话 id 问 tools/list。
 *
 * 注意这是**真起一次进程 / 真连一次端点**，不是干看配置：stdio 服务器可能会因此跑一次
 * 初始化（npx 首次还可能下载依赖），所以超时给得比较宽，超时会整棵进程树干掉。
 */
export async function probeMcpServer(spec, options = {}) {
  const started = Date.now()
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_PROBE_TIMEOUT_MS
  const transport = spec?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const serverName = String(spec?.serverName || '')
  try {
    const outcome = transport === 'stdio'
      ? await probeStdio(spec, { ...options, timeoutMs })
      : await probeHttp(spec, { ...options, timeoutMs })
    return { serverName, transport, ms: Date.now() - started, ...outcome }
  } catch (error) {
    return { serverName, transport, ok: false, stage: 'error', detail: errorMessage(error).slice(0, 300), ms: Date.now() - started }
  }
}
