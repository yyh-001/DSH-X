/**
 * MCP 服务器管理：读写 profile 补丁层 cordis.patch.yml 里的 dsh-mcp-client 条目。
 *
 * 官方的 MCP 接入形态（dsh-mcp-client README）：每个外部 MCP 服务器就是组合树里的
 * 一条插件条目——`name: '@deepseek-ai/dsh-mcp-client'`，config 带 serverName/transport/...；
 * 工具以 `mcp__<serverName>__<tool>` 暴露给模型。profile 树里默认没有 client 条目，
 * 所以 DSH-X 新增条目时用补丁层的 insert 语义（cordis-plugin-include 的 applyEntryPatches：
 * 普通 patch 条目只覆盖已有 id，只有不带 id 的 `insert:` 才往顶层树里 push 新行）。
 *
 * 补丁层里的 MCP 行不一定都是本启动器写的：用户手写、dsh-skill-mcp-panel 之类的工具
 * 也会往同一个文件里写 `@deepseek-ai/dsh-mcp-client` 行。页面必须把它们都列出来，
 * 否则 profile 里明明配着服务器，MCP 页却显示 0 台（issue #125）。
 * 所以这里有两套定位：
 * - 本启动器自己的条目：一对 begin/end 标记 + 单行 flow JSON，整块重写；
 * - 外来条目：按 YAML 的常见块写法扫出行/insert 成员的字节跨度，启停只动 `disabled`
 *   那一行、删除只切那一段、编辑只重写那一条，文件其他字节不动。
 *
 * 为什么自己的条目用「标记区块 + 单行 JSON」：
 * - 补丁层允许 `!!js` 表达式（用户的其他条目可能在用），零依赖手写 YAML 解析器接不住；
 *   JSON 是 YAML 的子集，自己的条目用单行 flow JSON 写，读写都只需文本手术，
 *   区块之外的字节永远不动；
 * - 每个服务器一对 begin/end 标记，plugins.js 追加的禁用块落在文件末尾（标记之外），两边互不踩。
 * 外来行只读 YAML 的保守子集（块状映射/列表、引号标量、JSON 流式写法）；认不出的写法
 * 标成 opaque：仍能列出、启停、删除，但不做猜测性重写（宁可拒绝也不写坏用户配置）。
 *
 * 热生效：dsh-hmr 会 watch profile 的 patchPath 和 `$DSH_HOME/cordis.patch.yml`，改动会
 * 原地重载（新条目启动、改动条目重连），不用重启。（注意：profile 的 package.json 里那个
 * `patchReload: live` 不是 dsh 认识的键，热重载跟它无关。）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { backupOnce } from './fs-utils.js'
import { looksLikeEntryList } from './plugins.js'
// 探测远端 MCP 端点也走带代理的 fetch（本机端点它自动直连）
import { netFetch } from './proxy.js'

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

/** 完整命令只拆 argv，不交给 shell；只转义引号和反斜杠，不能把 Windows 的 \t 当成制表符。 */
export function parseMcpCommand(text) {
  const tokens = []
  let token = '', quote = '', started = false
  const input = String(text || '')
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) quote = ''
      else if (quote === '"' && ch === '\\' && /["\\]/.test(input[i + 1] || '')) token += input[++i]
      else token += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(token)
      token = ''
      started = false
    } else {
      token += ch
      started = true
    }
  }
  if (quote) throw new Error('启动命令的引号没有闭合')
  if (started) tokens.push(token)
  if (!tokens[0]) throw new Error('stdio 传输需要填写启动命令')
  return { command: tokens[0], args: tokens.slice(1) }
}

/**
 * 只放行认识的配置字段，别的键一律丢弃——写进补丁层的东西必须是我们能解释的
 * （官方 config 是 schemastery 校验的 union，塞未知键会让整行加载失败）。
 * 上一次条目里认识、这次没提到的字段会原样带回来，编辑不再丢配置。
 */
function buildConfig(spec, previous) {
  if (typeof spec.commandLine === 'string' && spec.transport !== 'streamable-http') spec = { ...spec, ...parseMcpCommand(spec.commandLine) }
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

/* ------------------------------------------------------------------ *
 * 补丁层里的外来 MCP 行（手写 / 其它面板写的 dsh-mcp-client 条目）。
 *
 * 只读 YAML 的保守子集：块状映射与列表、引号标量、JSON 流式写法。
 * 遇到 !!js、锚点、块状标量、非 JSON 的 flow 写法则把那一行标成 opaque——
 * 列出来、能启停能删，但不做猜测性重写。这样零依赖也不会写坏用户配置。
 * ------------------------------------------------------------------ */

const SEQ_ITEM_RE = /^-(?:[ \t]|$)/
const KEY_LINE_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_.$@/-]+))[ \t]*:(?:[ \t]+(.*))?$/
/** 外来行里“这一段是启动器自己写的表单字段”，编辑重写时会被条目替换。 */
const ENTRY_KEYS = new Set(['id', 'name', 'disabled', 'config'])
/** 已知 schema 字段：编辑切换传输方式时不能把上一个传输的字段原样带回来。 */
const KNOWN_CONFIG_KEYS = new Set([
  'serverName', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers',
  'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect',
])

/** 每行记字节跨度与缩进；行号即数组下标，改文件时按 [start, next) 切。 */
function indexLines(text) {
  const lines = []
  let offset = 0
  const rawLines = String(text ?? '').split('\n')
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const indentText = /^[ \t]*/.exec(content)[0]
    const body = content.slice(indentText.length)
    lines.push({
      index,
      start: offset,
      contentEnd: offset + content.length,
      next: offset + raw.length + 1,
      indent: indentText.length,
      tabbed: indentText.includes('\t'),
      body,
      blank: body.trim() === '',
      comment: body.trimStart().startsWith('#'),
    })
    offset += raw.length + 1
  }
  return lines
}

function skipNoise(lines, index) {
  let cursor = index
  while (cursor < lines.length && (lines[cursor].blank || lines[cursor].comment)) cursor += 1
  return cursor
}

function rangeEndOf(lines, index, length) {
  if (index < 0) return 0
  return Math.min(length, lines[index]?.next ?? length)
}

function keyTextOf(match) {
  if (match[1] !== undefined) {
    try {
      return JSON.parse(`"${match[1]}"`)
    } catch {
      return match[1]
    }
  }
  if (match[2] !== undefined) return match[2].replace(/''/g, "'")
  return match[3]
}

/** 引号标量的收尾位置（支持 YAML 单引号里的 '' 转义）。 */
function quotedEndOf(text, quote, doubled = false) {
  for (let index = 1; index < text.length; index += 1) {
    if (doubled) {
      if (text[index] !== quote) continue
      if (text[index + 1] === quote) {
        index += 1
        continue
      }
      return index
    }
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === quote) return index
  }
  return -1
}

/** 行内注释只在空白后的 # 开始（值以 # 开头也算注释）；URL 里的 # 不算。 */
function stripInlineComment(text) {
  const value = String(text)
  const at = value.search(/(?:^|[ \t])#/)
  if (at < 0) return value.trim()
  return (at === 0 ? '' : value.slice(0, at)).trim()
}

function parseScalar(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '' || trimmed.startsWith('#')) return { value: null }
  if (/^!!/.test(trimmed) || trimmed.startsWith('!<')) return { value: null, opaque: '!!js 或自定义标签' }
  if (trimmed.startsWith('&') || trimmed.startsWith('*')) return { value: null, opaque: '锚点或别名' }
  if (trimmed.startsWith('|') || trimmed.startsWith('>')) return { value: null, opaque: '块状标量' }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { value: JSON.parse(trimmed) }
    } catch {
      // 行尾注释是 YAML 语法，不是 JSON；去掉再试一次
    }
    try {
      return { value: JSON.parse(stripInlineComment(trimmed)) }
    } catch {
      return { value: null, opaque: '流式结构不是 JSON 写法' }
    }
  }
  if (trimmed.startsWith('"')) {
    const end = quotedEndOf(trimmed, '"')
    if (end < 0) return { value: null, opaque: '双引号没有闭合' }
    try {
      return { value: JSON.parse(trimmed.slice(0, end + 1)) }
    } catch {
      return { value: null, opaque: '双引号字符串的转义看不懂' }
    }
  }
  if (trimmed.startsWith("'")) {
    const end = quotedEndOf(trimmed, "'", true)
    if (end < 0) return { value: null, opaque: '单引号没有闭合' }
    return { value: trimmed.slice(1, end).replace(/''/g, "'") }
  }
  const plain = stripInlineComment(trimmed)
  if (/^(?:true|True|TRUE)$/.test(plain)) return { value: true }
  if (/^(?:false|False|FALSE)$/.test(plain)) return { value: false }
  if (/^(?:null|Null|NULL|~)$/.test(plain)) return { value: null }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(plain)) return { value: Number(plain) }
  return { value: plain }
}

/** 块状标量（| / >）要整段吞掉，别把内容行当成新键。 */
function consumeBlockScalar(lines, start, parentIndent) {
  let index = start
  let endLine = start - 1
  while (index < lines.length) {
    const line = lines[index]
    if (line.blank) {
      index += 1
      continue
    }
    if (line.indent <= parentIndent) break
    endLine = index
    index += 1
  }
  return { index, endLine }
}

/** 空值键后面跟的缩进块；缩进不够就当作 null。 */
function parseNodeAfter(lines, start, parentIndent) {
  const index = skipNoise(lines, start)
  if (index >= lines.length || lines[index].indent <= parentIndent) {
    return { value: null, index: start, endLine: start - 1, opaque: [], selfOpaque: [], items: null, meta: null }
  }
  if (lines[index].tabbed) {
    return { value: null, index: index + 1, endLine: index, opaque: ['缩进里有制表符'], selfOpaque: ['缩进里有制表符'], items: null, meta: null }
  }
  return SEQ_ITEM_RE.test(lines[index].body)
    ? parseSequence(lines, index, lines[index].indent)
    : parseMapping(lines, index, lines[index].indent, null)
}

/**
 * 解析一层块状映射。firstPair 用于 `- id: x` 这种条目首键写在横线后面的写法；
 * 此时后续键的对齐列是横线后第一个非空字符的位置。
 */
function parseMapping(lines, start, keyIndent, firstPair) {
  const value = {}
  const meta = { keyLines: new Map(), children: new Map(), disabledSpan: null, disabledLine: -1, keyIndent }
  const selfOpaque = []
  const nested = []
  let pending = firstPair
  let index = start
  let endLine = start
  while (true) {
    let line = null
    let text = ''
    let textOffset = 0
    if (pending) {
      line = lines[start]
      text = pending.text
      textOffset = pending.offset
      pending = null
      index = start
    } else {
      index = skipNoise(lines, index)
      if (index >= lines.length) break
      line = lines[index]
      if (line.indent === keyIndent && SEQ_ITEM_RE.test(line.body)) break
      if (line.indent > keyIndent) {
        selfOpaque.push(`缩进对不上：${line.body.trim().slice(0, 30)}`)
        index += 1
        endLine = index - 1
        continue
      }
      if (line.indent < keyIndent) break
      if (line.tabbed) {
        selfOpaque.push('缩进里有制表符')
        index += 1
        endLine = index - 1
        continue
      }
      text = line.body
      textOffset = line.start + line.indent
    }
    const match = KEY_LINE_RE.exec(text)
    if (!match) {
      selfOpaque.push(`认不出的行：${text.trim().slice(0, 30)}`)
      index = line.index + 1
      endLine = line.index
      continue
    }
    const key = keyTextOf(match)
    if (meta.keyLines.has(key)) selfOpaque.push(`字段 ${key} 重复`)
    meta.keyLines.set(key, line.index)
    if (key === 'disabled') meta.disabledLine = line.index
    // `key: # 注释` 的值是空的，注释不能算成字符串
    const rest = /^\s*#/.test(match[4] ?? '') ? '' : (match[4] ?? '')
    let itemValue = null
    let itemEnd = line.index
    if (rest === '') {
      const child = parseNodeAfter(lines, line.index + 1, keyIndent)
      itemValue = child.value
      nested.push(...child.opaque)
      meta.children.set(key, child)
      itemEnd = Math.max(line.index, child.endLine)
      index = Math.max(child.index, line.index + 1)
    } else if (/^[|>]/.test(rest)) {
      const child = consumeBlockScalar(lines, line.index + 1, keyIndent)
      nested.push(`字段 ${key} 用了块状标量`)
      itemEnd = Math.max(line.index, child.endLine)
      index = Math.max(child.index, line.index + 1)
    } else {
      const scalar = parseScalar(rest)
      itemValue = scalar.value
      if (scalar.opaque) nested.push(`字段 ${key}：${scalar.opaque}`)
      itemEnd = line.index
      index = line.index + 1
      if (key === 'disabled') {
        const token = /^[^\s#]+/.exec(rest)
        const restOffset = textOffset + text.length - rest.length
        meta.disabledSpan = token ? { lineIndex: line.index, start: restOffset, end: restOffset + token[0].length } : null
      }
    }
    value[key] = itemValue
    endLine = itemEnd
  }
  return { value, index, endLine, opaque: [...selfOpaque, ...nested], selfOpaque, items: null, meta }
}

function parseSequence(lines, start, indent) {
  const items = []
  const selfOpaque = []
  const nested = []
  let index = start
  let endLine = start
  while (true) {
    index = skipNoise(lines, index)
    if (index >= lines.length) break
    const line = lines[index]
    if (line.indent < indent) break
    if (line.indent > indent) {
      selfOpaque.push(`缩进对不上：${line.body.trim().slice(0, 30)}`)
      index += 1
      endLine = index - 1
      continue
    }
    if (!SEQ_ITEM_RE.test(line.body)) break
    if (line.tabbed) {
      selfOpaque.push('缩进里有制表符')
      index += 1
      endLine = index - 1
      continue
    }
    const afterDash = line.body.slice(1)
    const gap = /^[ \t]*/.exec(afterDash)[0]
    const rest = afterDash.slice(gap.length)
    const keyIndent = line.indent + 1 + gap.length
    let value = null
    let itemEnd = line.index
    let itemMeta = null
    let itemOpaque = []
    let itemSelfOpaque = []
    if (rest === '') {
      const child = parseNodeAfter(lines, line.index + 1, line.indent)
      value = child.value
      itemOpaque = child.opaque
      // 条目写成 `-` 换行再缩进映射时，键列在子节点那边，不能按横线推算
      itemMeta = child.meta
      itemEnd = Math.max(line.index, child.endLine)
      index = Math.max(child.index, line.index + 1)
    } else if (KEY_LINE_RE.test(rest)) {
      const child = parseMapping(lines, line.index, keyIndent, { text: rest, offset: line.start + keyIndent })
      value = child.value
      itemOpaque = child.opaque
      itemSelfOpaque = child.selfOpaque
      itemMeta = child.meta
      itemEnd = Math.max(line.index, child.endLine)
      index = Math.max(child.index, line.index + 1)
    } else if (/^[|>]/.test(rest)) {
      const child = consumeBlockScalar(lines, line.index + 1, line.indent)
      itemOpaque = ['块状标量']
      itemEnd = Math.max(line.index, child.endLine)
      index = Math.max(child.index, line.index + 1)
    } else {
      const scalar = parseScalar(rest)
      value = scalar.value
      if (scalar.opaque) itemOpaque = [scalar.opaque]
      index = line.index + 1
    }
    nested.push(...itemOpaque)
    items.push({
      value,
      startLine: line.index,
      endLine: itemEnd,
      keyIndent: itemMeta?.keyIndent ?? keyIndent,
      dashIndent: line.indent,
      meta: itemMeta,
      opaque: itemOpaque,
      selfOpaque: itemSelfOpaque,
    })
    endLine = itemEnd
  }
  return { value: items.map((item) => item.value), index, endLine, opaque: [...selfOpaque, ...nested], selfOpaque, items, meta: null }
}

/** 扫描一条外来行；只有 name 是官方 MCP 客户端的行才算。 */
function foreignRowFromItem(item, range, insertParent) {
  const fields = item.value
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  if (String(fields.name ?? '') !== MCP_CLIENT_PKG) return null
  const config = fields.config && typeof fields.config === 'object' && !Array.isArray(fields.config) ? fields.config : null
  const serverName = config && typeof config.serverName === 'string' ? config.serverName : ''
  const id = typeof fields.id === 'string' ? fields.id : ''
  const broken = !serverName
  const opaque = item.opaque || []
  const disabledProblem = fields.disabled !== undefined && fields.disabled !== null && typeof fields.disabled !== 'boolean'
  return {
    kind: 'row',
    serverName: serverName || id || '(未命名 MCP 行)',
    id,
    disabled: fields.disabled === true,
    config,
    fields,
    range,
    start: range.start,
    end: range.end,
    insertParent,
    // 顶层行只覆盖已有 id；只有 insert 成员才会往树里 push 新服务器
    inserted: Boolean(insertParent),
    keyIndent: item.keyIndent,
    dashIndent: item.dashIndent,
    startLine: item.startLine,
    endLine: item.endLine,
    disabledSpan: item.meta?.disabledSpan ?? null,
    disabledLine: item.meta?.disabledLine ?? -1,
    opaque: opaque[0] || (disabledProblem ? 'disabled 不是 true/false' : ''),
    opaqueAll: opaque,
    editable: !broken && !opaque.length && !disabledProblem,
    // flow 写法（`- {…}`）没法在条目末尾补行，启停只能手工改原文。
    toggleable: Boolean(item.meta) && !(item.selfOpaque || []).length && !disabledProblem,
    broken,
    error: broken ? '缺少 config.serverName（这一行读不出服务器名）' : '',
  }
}

/** 补丁层里所有 MCP 行（本启动器的标记区块 + 外来行），按文件位置排序。 */
function collectMcpRefs(text) {
  const blocks = scanBlocks(text)
  const blockRefs = blocks.map((block) => ({
    kind: 'block',
    serverName: block.serverName,
    id: block.entry && typeof block.entry.id === 'string' ? block.entry.id : '',
    disabled: block.entry?.disabled === true,
    config: block.entry && block.entry.config && typeof block.entry.config === 'object' ? block.entry.config : null,
    entry: block.entry,
    start: block.start,
    end: block.end,
    closed: block.closed,
    broken: !block.entry,
    error: block.error,
    startLine: -1,
    endLine: -1,
  }))
  const lines = indexLines(text)
  const length = text.length
  const top = parseSequence(lines, 0, 0)
  const closedBlocks = blocks.filter((block) => block.closed)
  const entryIds = new Set(blocks.map((block) => block.entry?.id).filter((id) => typeof id === 'string' && id !== ''))
  // 缺结束标记的区块范围会一直算到文件尾：只把紧跟在 begin 标记后的第一个顶层条目当成
  // 它自己的 insert，否则同一个损坏区块会既按区块列一次、又按外来行再列一次。
  const unclosedOwnLines = new Set()
  for (const block of blocks.filter((entry) => !entry.closed)) {
    const next = (top.items ?? []).find((item) => lines[item.startLine].start >= block.start)
    if (next) unclosedOwnLines.add(next.startLine)
  }
  const rows = []
  for (const item of top.items ?? []) {
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) continue
    const itemStart = lines[item.startLine].start
    const itemEnd = rangeEndOf(lines, item.endLine, length)
    const insertChild = item.meta?.children?.get('insert')
    if (insertChild && Array.isArray(insertChild.items)) {
      const insideClosed = closedBlocks.some((block) => itemStart >= block.start && itemEnd <= block.end)
      const isOwnEntry = insertChild.items.some((member) => typeof member.value?.id === 'string' && entryIds.has(member.value.id))
      if (insideClosed || isOwnEntry || unclosedOwnLines.has(item.startLine)) continue
      for (const member of insertChild.items) {
        const row = foreignRowFromItem(
          member,
          { start: lines[member.startLine].start, end: rangeEndOf(lines, member.endLine, length) },
          {
            start: itemStart,
            end: itemEnd,
            memberCount: insertChild.items.length,
            // `insert:` 键的行号：删掉最后一个成员时要把值写成 `[]`，
            // 不能把整条 insert 拔掉（别的工具可能正靠这条 insert 维持受管块结构）。
            keyLineIndex: item.meta?.keyLines?.get('insert') ?? item.startLine,
          },
        )
        if (row) rows.push(row)
      }
      continue
    }
    // 标记区块里手写的顶层条目也照样列出来（标记只圈住我们的 insert，不圈别人的行）。
    const row = foreignRowFromItem(item, { start: itemStart, end: itemEnd }, null)
    if (row) rows.push(row)
  }
  return [...blockRefs, ...rows].sort((a, b) => a.start - b.start)
}

function locatorOf(input) {
  if (input && typeof input === 'object') {
    return { serverName: String(input.serverName || '').trim(), id: String(input.id || '').trim() }
  }
  return { serverName: String(input || '').trim(), id: '' }
}

/** 按 id/serverName 找唯一一条；先两个都对上，再退回单字段。 */
function matchRefs(refs, locator) {
  const { serverName, id } = locator
  if (!serverName && !id) throw new Error('缺少服务器名')
  let hits = refs.filter((ref) => (!serverName || ref.serverName === serverName) && (!id || ref.id === id))
  if (!hits.length && id) hits = refs.filter((ref) => ref.id === id)
  if (!hits.length && serverName) hits = refs.filter((ref) => ref.serverName === serverName)
  if (!hits.length) throw new Error(`没有找到名为 ${serverName || id} 的 MCP 服务器`)
  if (hits.length > 1) {
    throw new Error(`补丁层里有 ${hits.length} 条 ${serverName || id} 的 MCP 条目（id 或 serverName 重复），先手工清掉多余的再操作`)
  }
  return hits[0]
}

/** 行对象 → 页面/探测用的统一形状；config 缺字段时给安全默认值。 */
function serverFromConfig(config, base) {
  const cfg = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  return {
    serverName: String(cfg.serverName || base.serverName || base.id || ''),
    id: String(base.id || ''),
    disabled: base.disabled === true,
    transport: cfg.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: String(cfg.command || ''),
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    env: cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? cfg.env : null,
    cwd: String(cfg.cwd || ''),
    url: String(cfg.url || ''),
    headers: cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers) ? cfg.headers : null,
    toolCallTimeoutMs: Number(cfg.toolCallTimeoutMs) || undefined,
    maxInstructionBytes: Number(cfg.maxInstructionBytes) || undefined,
    failOnStartupError: cfg.failOnStartupError === true,
    reconnect: cfg.reconnect && typeof cfg.reconnect === 'object' && !Array.isArray(cfg.reconnect) ? cfg.reconnect : null,
    config,
    ...base.extra,
  }
}

/** 列出补丁层里所有 MCP 服务器（本启动器的 + 外来的，不动文件）。 */
export function listMcpServers(patchPath) {
  let text = ''
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return { servers: [], patchExists: false }
  }
  const servers = collectMcpRefs(text).map((ref) => {
    if (ref.kind === 'block') {
      if (!ref.entry) {
        return {
          serverName: ref.serverName,
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
          error: ref.error,
          broken: true,
          source: 'dshx',
          editable: false,
          toggleable: false,
          opaque: '',
        }
      }
      return serverFromConfig(ref.config, {
        serverName: ref.serverName,
        id: ref.id,
        disabled: ref.disabled,
        extra: { error: '', broken: false, source: 'dshx', editable: true, toggleable: true, opaque: '', inserted: true },
      })
    }
    return serverFromConfig(ref.config, {
      serverName: ref.serverName,
      id: ref.id,
      disabled: ref.disabled,
      extra: {
        error: ref.error,
        broken: ref.broken,
        source: 'profile',
        editable: ref.editable,
        toggleable: ref.toggleable,
        opaque: ref.opaque,
        inserted: ref.inserted,
      },
    })
  })
  return { servers, patchExists: true }
}

/** 写之前把结果整份过一遍条目数组校验，宁可拒绝也不写出让 profile 起不来的文件。 */
function assertWritable(patchPath, text) {
  if (looksLikeEntryList(text)) return
  throw new Error(`写入后 ${patchPath} 会不再是合法的条目数组，已拒绝保存；请先修正 cordis.patch.yml`)
}

/**
 * 保存（新增或更新）一个 MCP 服务器条目。
 *
 * - 命中本启动器的标记区块：整块重写成单行 JSON；
 * - 命中补丁层里的外来行：只重写那一条（保留 id、停用状态和表单没建模的配置键）；
 * - 没命中：追加一个新的标记区块。
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
  const locator = { serverName, id: String(spec.id || '').trim() }
  const refs = collectMcpRefs(text)
  let hits = refs.filter((ref) => ref.serverName === serverName && (!locator.id || ref.id === locator.id))
  if (!hits.length && locator.id) hits = refs.filter((ref) => ref.id === locator.id)
  if (!hits.length) hits = refs.filter((ref) => ref.serverName === serverName)
  if (hits.length > 1) {
    throw new Error(`补丁层里有 ${hits.length} 条名为 ${serverName} 的 MCP 条目（id 或 serverName 重复），先手工清掉多余的再保存`)
  }
  const target = hits[0] ?? null
  if (target?.kind === 'row' && !target.editable) {
    const reason = target.opaque || target.error || '写法不在表单能安全重写的范围内'
    throw new Error(`这条 MCP 服务器是补丁层里的手写条目，没法用表单改写（${reason}）；可以先开关、检测或删除，或到原文里改`)
  }
  const previousConfig = target?.kind === 'block' ? (target.entry?.config ?? null) : (target?.config ?? null)
  const { config, warnings } = buildConfig(spec, previousConfig)
  if (target?.kind === 'row') carryExtraConfig(config, previousConfig)
  const entry = { id: target?.id || `dshx-mcp-${serverName}`, name: MCP_CLIENT_PKG }
  const disabled = typeof spec.disabled === 'boolean' ? spec.disabled : target?.disabled === true
  if (disabled) entry.disabled = true
  entry.config = config

  let next
  let repaired = false
  if (!target) {
    next = appendBlock(text, renderBlock(serverName, entry))
  } else if (target.kind === 'block') {
    repaired = !target.entry
    next = text.slice(0, target.start) + renderBlock(serverName, entry) + text.slice(target.end)
  } else {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    next = text.slice(0, target.start) + renderProfileRow(target, entry, eol) + text.slice(target.end)
  }
  assertWritable(patchPath, next)
  backupOnce(patchPath)
  ensureParent(patchPath)
  writeFileSync(patchPath, next)
  return { ok: true, warnings, replaced: Boolean(target), repaired, adopted: target?.kind === 'row' }
}

/** 外来行里表单没建模的配置键原样带回；已知 schema 键不在这里处理（buildConfig 管）。 */
function carryExtraConfig(config, previous) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return
  for (const [key, value] of Object.entries(previous)) {
    if (KNOWN_CONFIG_KEYS.has(key) || has(config, key)) continue
    config[key] = value
  }
}

/** 把一条外来行重写成规范块写法（JSON 是 YAML 子集，值不会被误解）。 */
function renderProfileRow(ref, entry, eol) {
  const indent = ' '.repeat(Math.max(0, ref.dashIndent))
  const gap = Math.max(2, ref.keyIndent - ref.dashIndent)
  const keyIndent = `${indent}${' '.repeat(gap)}`
  const lines = [
    `${indent}- id: ${JSON.stringify(entry.id)}`,
    `${keyIndent}name: ${JSON.stringify(entry.name)}`,
  ]
  if (entry.disabled === true) lines.push(`${keyIndent}disabled: true`)
  for (const [key, value] of Object.entries(ref.fields || {})) {
    if (ENTRY_KEYS.has(key) || value === undefined) continue
    lines.push(`${keyIndent}${key}: ${JSON.stringify(value)}`)
  }
  lines.push(`${keyIndent}config: ${JSON.stringify(entry.config)}`)
  return `${lines.join(eol)}${eol}`
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

/**
 * 外来行的启停：只动 `disabled` 这一处。
 * - 有键：原地换值（独占一行的整行删掉；条目首行 `- disabled:` 不行，只能换值）；
 * - 无键：在行末补一行同缩进的 `disabled: true`（追加在末尾，不插在嵌套块前面）。
 */
function toggleForeignRow(text, ref, disabled) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (ref.disabledSpan) {
    const lines = indexLines(text)
    const span = ref.disabledSpan
    const line = lines[span.lineIndex]
    if (!disabled && line && line.index !== ref.startLine && /^disabled[ \t]*:[ \t]*(?:true|false)[ \t]*$/.test(line.body.trim())) {
      const end = Math.min(text.length, line.next)
      return text.slice(0, line.start) + text.slice(end)
    }
    return text.slice(0, span.start) + (disabled ? 'true' : 'false') + text.slice(span.end)
  }
  // `disabled:` 写了键但没写值：在冒号后补值，别再加一个重复键。
  if (ref.disabledLine >= 0) {
    const lines = indexLines(text)
    const line = lines[ref.disabledLine]
    const colon = line.body.indexOf(':')
    const at = line.start + line.indent + colon + 1
    return text.slice(0, at) + (disabled ? ' true' : ' false') + text.slice(at)
  }
  if (!disabled) return text
  const at = ref.range.end
  const indent = ' '.repeat(Math.max(0, ref.keyIndent))
  const needsEol = at > 0 && text[at - 1] !== '\n'
  return text.slice(0, at) + (needsEol ? eol : '') + `${indent}disabled: true${eol}` + text.slice(at)
}

/** 启用/禁用一个 MCP 服务器（本启动器的重写区块，外来的只改 disabled 那行）。 */
export function setMcpEnabled(patchPath, locatorInput, enabled) {
  const locator = locatorOf(locatorInput)
  const text = readFileSync0(patchPath, '补丁层文件不存在，没有可开关的 MCP 服务器')
  const target = matchRefs(collectMcpRefs(text), locator)
  const want = enabled === false
  if (target.disabled === want) return { ok: true, changed: false }

  let next
  if (target.kind === 'block') {
    const entry = target.entry
    if (!entry) throw new Error(`MCP 服务器 ${target.serverName} 的条目损坏，无法开关：${target.error}`)
    if (want) entry.disabled = true
    else delete entry.disabled
    next = text.slice(0, target.start) + renderBlock(target.serverName, entry) + text.slice(target.end)
  } else {
    if (!target.toggleable) {
      throw new Error(`MCP 服务器 ${target.serverName} 的 disabled 写法表单接不住，没法自动开关；请手工改原文`)
    }
    next = toggleForeignRow(text, target, want)
  }
  assertWritable(patchPath, next)
  backupOnce(patchPath)
  writeFileSync(patchPath, next)
  return { ok: true, changed: true }
}

/** 删除一个 MCP 服务器（本启动器的区块 / 外来行；损坏的孤儿块也能删）。 */
export function removeMcpServer(patchPath, locatorInput) {
  const locator = locatorOf(locatorInput)
  const text = readFileSync0(patchPath, '补丁层文件不存在，没有可删除的 MCP 服务器')
  const target = matchRefs(collectMcpRefs(text), locator)
  let next = text.slice(0, target.start) + text.slice(target.end)
  // insert 里只剩这一条：成员删掉后把 `insert:` 改成 `insert: []`。
  // 不把整条 insert 拔掉——受管块可能是别的工具（比如 dsh-skill-mcp-panel）围起来的，
  // 空掉它的内容会让对方的解析器报「受管块内容必须是 YAML 数组」。
  if (target.kind === 'row' && target.insertParent && target.insertParent.memberCount === 1) {
    const lines = indexLines(text)
    const line = lines[target.insertParent.keyLineIndex]
    const colon = line ? line.body.indexOf(':') : -1
    if (line && colon >= 0) {
      const at = line.start + line.indent + colon + 1
      next = next.slice(0, at) + ' []' + next.slice(at)
    }
  }
  assertWritable(patchPath, next)
  backupOnce(patchPath)
  writeFileSync(patchPath, ensurePlaceholder(next))
  return { ok: true, broken: target.kind === 'block' ? !target.entry : false }
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
  if (needsShell && [resolved, ...args].some((part) => /[\r\n\0]/.test(part))) {
    return { ok: false, stage: 'config', detail: '命令参数包含非法控制字符' }
  }
  // cmd.exe 元字符（& | < > ^ ( ) % ! 空白 引号）必须整体加引号，并用 ^ 转义 % 防止环境变量展开与命令注入
  const quoteCmdArg = (part) => {
    const text = String(part)
    if (!text) return '""'
    if (!/[\s"&|<>^()%!]/.test(text)) return text
    return `"${text.replace(/"/g, '""').replace(/%/g, '%%')}"`
  }
  const child = needsShell
    // Windows 上经 cmd 起进程：命令行里带空格的路径必须自己加引号，否则 C:\Program Files\...
    // 会被 cmd 当成 `C:\Program` + 参数（npx/pnpm 这些 .cmd 包装器全在带空格的目录里）。
    // 每个参数单独加引号，再按 cmd 的规矩把整行包一层（cmd /s /c "…"）。
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteCmdArg).join(' ')}"`], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 命令行已经按 cmd 的规矩自己引好了，别再让 Node 转义一层（否则引号叠加、cmd 解析失败）
      windowsVerbatimArguments: true,
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
    return netFetch(url, {
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
