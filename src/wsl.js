/*
MIT License

Copyright (c) 2026 Nexus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, posix as posixPath } from 'node:path'
import { WSL_AGENT_SCRIPT } from './wsl-scripts.js'
import { proxyEnv } from './proxy.js'
import {
  REMOTE_REASON,
  buildExportsScript,
  buildHostGatewayCommand,
  buildIdentityScript,
  buildProxyPortProbeCommand,
  isLoopbackProxyHostname,
  isValidWslUser,
  parseHostGatewayOutput,
  parseIdentityOutput,
  parseProxyPortProbeOutput,
  pickDistro,
  proxyUrlObject,
  remoteError,
  replaceProxyHostname,
  shellQuote,
} from './remote.js'

// 允许用 DSH_WSL_EXE 指向自定义 wsl.exe；默认先找 System32，找不到再交给 PATH。
// 不把 wsl.exe 的存在当成 DSH-X 的运行前提：只有探测/启动 WSL 时才 spawn 它。
const WSL_EXE = (() => {
  if (process.env.DSH_WSL_EXE) return process.env.DSH_WSL_EXE
  const system = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'wsl.exe') : ''
  if (system && existsSync(system)) return system
  return 'wsl.exe'
})()
const HELPER_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine-.*|wslenv)$/i
const DEFAULT_HOME = '~/.dsh'
/** wsl.exe 自己会在 stderr 写一条「localhost 代理没镜像到 WSL」的警告；它不是执行失败的原因。 */
const WSL_PROXY_WARNING_RE = /localhost.*代理|localhost proxy/i

/** 首版只支持 wrapper：脚本前台 exec dsh，wsl.exe 的 stdout 就是 dsh 的 stdout。 */
export const WSL_SERVICE_MODE = 'wrapper'

export function wslAvailable(exe = WSL_EXE) {
  if (process.platform !== 'win32') return false
  // 回退到 PATH 上的 wsl.exe 时无法用 existsSync 判断（它不是绝对路径）；
  // 真找不到时交给 listWslDistros 的 spawn 错误处理，页面会显示 WSL 的提示。
  return exe === 'wsl.exe' || existsSync(exe)
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 20000
  const raw = Boolean(options.raw)
  return new Promise((resolve) => {
    let child
    try {
      // WSL_UTF8：让 wsl.exe 自己的提示（包括 localhost 代理警告）也用 UTF-8 输出，
      // 不和 bash 的 UTF-8 错误混成一段 UTF-16/UTF-8 交错、解不干净的 stderr。
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } })
    } catch (error) {
      resolve({ ok: false, code: null, stdout: raw ? Buffer.alloc(0) : '', stderr: String(error && error.message || error), error })
      return
    }
    const out = []
    const err = []
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = raw ? Buffer.concat(out) : Buffer.concat(out).toString('utf8')
      // wsl.exe 连报错也是 UTF-16LE；bash 的是 UTF-8。统一过同一套解码，
      // 否则「没有已安装的发行版」这类提示会在页面上变成乱码。
      const stderr = decodeWslOutput(Buffer.concat(err))
      resolve(Object.assign({}, result, { stdout: stdout, stderr: stderr }))
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      finish({ ok: false, code: null, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish({ ok: false, code: null, error: error }))
    // 用 close 而不是 exit：exit 触发时 stdio 可能还没排空，探测输出会被截断。
    child.on('close', (code) => finish({ ok: code === 0, code: code }))
  })
}

/** 严格 UTF-8：字节不合法时返回 null，而不是拿替换字符冒充解码成功。 */
function decodeUtf8Strict(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return null }
}

/** wsl.exe --list 的输出是 UTF-16LE；bash 的输出是 UTF-8。中间用这个函数兜住两种。 */
export function decodeWslOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (!buf.length) return ''
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  // 用偶数位 NUL 的比例判断 UTF-16LE：中文文本的 UTF-16 也会在奇数位出现非零，所以只看 NUL。
  const sample = buf.subarray(0, Math.min(buf.length, 256))
  let zeros = 0
  for (let index = 1; index < sample.length; index += 2) if (sample[index] === 0) zeros += 1
  if (zeros >= Math.max(1, sample.length / 8)) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  const strict = decodeUtf8Strict(buf)
  if (strict !== null) return strict
  // 不是合法 UTF-8：短的中文 UTF-16LE 没有 ASCII 帮忙，奇数位一个 NUL 都没有，上面认不出来；
  // 偶数长度、且 UTF-16 解得干净时按 UTF-16LE 处理（wsl.exe 自己的错误提示就是这种）。
  if (buf.length % 2 === 0) {
    const utf16 = buf.toString('utf16le')
    if (!utf16.includes('\uFFFD')) return utf16.replace(/^\uFEFF/, '')
  }
  return buf.toString('utf8')
}

/**
 * 解析 wsl --list --verbose。名字里可能有空格，所以按两个以上空格切列。
 * 表头和状态会跟着 Windows 显示语言变（中文系统是「名称 状态 版本」），不能按
 * 英文单词判断；只认行尾的版本号，前面的部分再按列宽/最后一个空格拆。
 */
export function parseWslDistroList(text) {
  const distros = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\u0000/g, '').trimEnd()
    if (!line.trim()) continue
    const isDefault = /^\s*\*/.test(line)
    const body = line.replace(/^\s*\*\s*/, '').trim()
    // 版本号是每行唯一的稳定锚点；没有数字的表头/提示行直接跳过。
    const versionMatch = /(\d+)\s*$/.exec(body)
    if (!versionMatch) continue
    const version = Number(versionMatch[1]) || 2
    const rest = body.slice(0, versionMatch.index).trim()
    let name = ''
    let state = ''
    const columns = rest.split(/\s{2,}/).filter(Boolean)
    if (columns.length >= 2) {
      name = columns[0].trim()
      state = columns[columns.length - 1].trim()
    } else {
      // 没有对齐空格的输出：状态通常是最后一个词（Running / 运行中 / 已停止）。
      const split = rest.lastIndexOf(' ')
      if (split <= 0) continue
      name = rest.slice(0, split).trim()
      state = rest.slice(split + 1).trim()
    }
    if (!name || HELPER_DISTRO_RE.test(name)) continue
    distros.push({ name: name, state: state, version: version, default: isDefault })
  }
  return distros
}

let distroCache = { at: 0, value: null }
const inspectCache = new Map()

/** stderr 里去掉 wsl.exe 的 localhost 代理警告，剩下的才是真错误。 */
function cleanWslStderr(result) {
  return decodeWslOutput(result?.stderr)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !WSL_PROXY_WARNING_RE.test(line))
    .join('\n')
    .trim()
}

/** wsl.exe 自己的错误（发行版/用户不存在）写在 stdout，带 `WSL_E_*` 错误码。 */
function wslServiceError(result) {
  const text = decodeWslOutput(result?.stdout).trim()
  return /WSL_E_[A-Z_]+/.test(text) ? text : ''
}

/** 失败原因优先用 wsl.exe 的 WSL_E_*（在 stdout），其次才是 bash 的 stderr。 */
function wslFailureMessage(result) {
  return wslServiceError(result)
    || cleanWslStderr(result)
    || decodeWslOutput(result?.stdout).trim()
    || (result?.timedOut ? 'WSL 没有响应（超时）' : `wsl 退出码 ${result?.code}`)
}

function wslReasonFromResult(result) {
  if (result?.timedOut) return REMOTE_REASON.wslTimeout
  const text = decodeWslOutput(result?.stdout) + '\n' + decodeWslOutput(result?.stderr)
  if (/WSL_E_DISTRO_NOT_FOUND|不存在具有所提供名称的分发/.test(text)) return REMOTE_REASON.distroMissing
  if (/WSL_E_USER_NOT_FOUND|找不到用户/.test(text)) return REMOTE_REASON.userMissing
  return REMOTE_REASON.wslFailed
}

function cachedDistros(value) {
  distroCache = { at: Date.now(), value: value }
  return value
}

export async function listWslDistros(options = {}) {
  const exe = options.exe || WSL_EXE
  const run = options.run || ((args, opts) => runProcess(exe, args, opts))
  const cacheable = !options.run
  if (!wslAvailable(exe)) {
    return { available: false, distros: [], error: '当前不是 Windows，或找不到 wsl.exe', reasonCode: REMOTE_REASON.wslUnavailable, retryable: false }
  }
  if (!options.force && cacheable && distroCache.value && Date.now() - distroCache.at < 10000) return distroCache.value
  const result = await run(['--list', '--verbose'], { timeoutMs: 15000, raw: true })
  if (!result.ok) {
    // 真正的错误在 stdout（UTF-16LE）；stderr 通常只有 localhost 代理警告，不能当成原因。
    const value = {
      available: true,
      distros: [],
      error: wslFailureMessage(result),
      reasonCode: wslReasonFromResult(result),
      retryable: result.timedOut === true,
    }
    return cacheable ? cachedDistros(value) : value
  }
  const value = { available: true, distros: parseWslDistroList(decodeWslOutput(result.stdout)), error: '', reasonCode: '', retryable: null }
  return cacheable ? cachedDistros(value) : value
}

export function invalidateWslCache() {
  distroCache = { at: 0, value: null }
  inspectCache.clear()
}

/**
 * wsl.exe 的参数。`--exec` 直接 execve，不经过默认 shell，脚本里的 `$变量`、
 * 引号和多行内容都原样到达；`--` 会走默认 shell，才需要 base64 兜住展开。
 * 对齐 ZCode 的 buildWslArgs（`-d` → `-u` → `--exec`）。
 */
export function buildWslArgs(options, argv) {
  const args = []
  const distro = String(options?.distro ?? '').trim()
  const user = String(options?.user ?? '').trim()
  if (distro) args.push('-d', distro)
  if (user) args.push('-u', user)
  args.push('--exec', ...argv)
  return args
}

function expandRemotePath(value, home) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return String(home || '')
  if (text.indexOf('~/') === 0) return posixPath.join(String(home || ''), text.slice(2))
  return text
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timer
    const done = () => {
      clearTimeout(timer)
      child.removeListener('close', done)
      resolve(true)
    }
    timer = setTimeout(() => {
      child.removeListener('close', done)
      resolve(false)
    }, timeoutMs)
    child.once('close', done)
  })
}

function normalizeArch(machine) {
  const value = String(machine || '').trim().toLowerCase()
  if (value === 'x86_64' || value === 'amd64') return 'x64'
  if (value === 'aarch64' || value === 'arm64') return 'arm64'
  if (value === 'i386' || value === 'i686') return 'ia32'
  if (value.startsWith('armv')) return 'arm'
  return value
}

/**
 * 一个 WSL 发行版的 transport。接口形状对齐 ZCode 的 WSLBackend：
 * available / resolveIdentity / detect / exec / stream / exists / isDirectory /
 * readFile / upload / resolveRuntimeProxy / dispose / disposeAndWait。
 *
 * 与 ZCode 的差别：
 * - exec 不自动探测身份，调用方给了 distro/user 就直接用（省一次 wsl.exe 启动）；
 *   要规范发行版名/真实 HOME 时显式调 resolveIdentity()。
 * - dispose 只回收自己 stream 出来的子进程；启动 dsh 的那扇门由调用方持有。
 */
export function createWslBackend(options = {}) {
  const exe = options.exe || WSL_EXE
  const run = options.run || ((args, opts) => runProcess(exe, args, opts))
  const spawnChild = options.spawn || spawn
  const state = {
    distro: String(options.distro ?? '').trim(),
    user: String(options.user ?? '').trim(),
  }
  let identity = options.identity
    ? {
        distro: String(options.identity.distro ?? '').trim(),
        user: String(options.identity.user ?? '').trim(),
        home: String(options.identity.home ?? '').trim(),
        version: Number.isFinite(options.identity.version) ? options.identity.version : null,
      }
    : null
  if (identity) {
    state.distro = identity.distro || state.distro
    state.user = identity.user || state.user
  }
  let identityPromise = null
  const owned = new Set()

  function track(child) {
    owned.add(child)
    const done = () => owned.delete(child)
    child.once('error', done)
    child.once('close', done)
    return child
  }

  async function resolveIdentity(opts = {}) {
    if (identity && !opts.force) return identity
    if (identityPromise && !opts.force) return identityPromise
    identityPromise = (async () => {
      const listed = await listWslDistros({ force: opts.force === true, exe, run })
      if (!listed.available) throw remoteError(REMOTE_REASON.wslUnavailable, listed.error || '当前系统没有可用的 WSL 环境')
      const picked = pickDistro(state.distro, listed.distros)
      if (picked.missing) {
        throw remoteError(REMOTE_REASON.distroMissing, `未找到名为 ${state.distro} 的 WSL 发行版（先在终端运行 wsl -l -v 核对名称）`)
      }
      if (!picked.name) throw remoteError(REMOTE_REASON.distroMissing, '没有可用的 WSL 发行版（先在终端里安装一个）')
      const result = await run(buildWslArgs({ distro: picked.name, user: state.user }, ['bash', '--noprofile', '--norc', '-c', buildIdentityScript()]), { timeoutMs: 15000 })
      if (!result.ok) {
        throw remoteError(wslReasonFromResult(result), `无法读取 WSL 身份：${wslFailureMessage(result)}`)
      }
      const parsed = parseIdentityOutput(decodeWslOutput(result.stdout))
      if (!parsed.ok) throw remoteError(REMOTE_REASON.wslFailed, `无法解析 WSL 身份：${parsed.error}`)
      const user = parsed.user || state.user
      if (!isValidWslUser(user)) throw remoteError(REMOTE_REASON.userMissing, `WSL 用户名不合法：${user}`)
      const canonical = pickDistro(parsed.distro || picked.name, listed.distros)
      identity = {
        distro: canonical.name || picked.name,
        user,
        home: parsed.home,
        version: picked.entry?.version ?? null,
      }
      state.distro = identity.distro
      state.user = identity.user
      return identity
    })()
    identityPromise.catch(() => {
      if (identityPromise) identityPromise = null
    })
    return identityPromise
  }

  /** 调用方给了身份就用给的；否则有发行版就按配置直接跑，连默认发行版都没有才去探测。 */
  async function whoFor(opts = {}) {
    if (opts.identity) return opts.identity
    if (state.distro) return { distro: state.distro, user: state.user, home: '' }
    return resolveIdentity()
  }

  async function exec(script, opts = {}) {
    const who = await whoFor(opts)
    return run(buildWslArgs(who, ['bash', '-lc', String(script)]), opts)
  }

  /** 探测类命令不加载登录 profile：只要 `ip`/`uname`/`/dev/tcp`，profile 只会添乱。 */
  async function execProbe(script, opts = {}) {
    const who = await whoFor(opts)
    return run(buildWslArgs(who, ['bash', '--noprofile', '--norc', '-c', String(script)]), opts)
  }

  async function stream(script, opts = {}) {
    const who = await whoFor(opts)
    let child
    try {
      child = spawnChild(exe, buildWslArgs(who, ['bash', '-lc', String(script)]), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } })
    } catch (error) {
      throw remoteError(REMOTE_REASON.wslFailed, '启动 wsl.exe 失败：' + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
    return track(child)
  }

  async function checkPath(path, flag, opts = {}) {
    const who = opts.identity || await resolveIdentity()
    const target = expandRemotePath(path, who.home)
    if (!target) return false
    const result = await exec(`test ${flag} ${shellQuote(target)} && printf yes || printf no`, { ...opts, identity: who, timeoutMs: opts.timeoutMs || 8000 })
    // `test ... && printf yes || printf no` 正常总是退出 0；非 0 说明 wsl.exe 本身没跑成，
    // 不能当成「路径不存在」——超时/发行版没起来要按原代码报出去。
    if (!result.ok) throw remoteError(wslReasonFromResult(result), wslFailureMessage(result))
    return decodeWslOutput(result.stdout).trim() === 'yes'
  }

  async function readFile(path, opts = {}) {
    const who = opts.identity || await resolveIdentity()
    const target = expandRemotePath(path, who.home)
    const result = await exec(`cat -- ${shellQuote(target)}`, { ...opts, identity: who, timeoutMs: opts.timeoutMs || 20000 })
    if (!result.ok) throw remoteError(wslReasonFromResult(result), wslFailureMessage(result))
    return decodeWslOutput(result.stdout)
  }

  async function upload(data, path, opts = {}) {
    const who = opts.identity || await resolveIdentity()
    const target = expandRemotePath(path, who.home)
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
    if (buffer.length > 256 * 1024) throw new Error('WSL 上传内容过大（上限 256 KB）')
    const dir = posixPath.dirname(target)
    const script = `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(buffer.toString('base64'))} | base64 -d > ${shellQuote(target)}`
    const result = await exec(script, { ...opts, identity: who, timeoutMs: opts.timeoutMs || 20000 })
    if (!result.ok) throw remoteError(wslReasonFromResult(result), wslFailureMessage(result))
  }

  async function probeProxy(value) {
    const command = buildProxyPortProbeCommand(value)
    if (!command) return undefined
    try {
      const result = await execProbe(command, { timeoutMs: 5000 })
      if (!result.ok) return undefined
      return parseProxyPortProbeOutput(decodeWslOutput(result.stdout))
    } catch {
      return undefined
    }
  }

  /**
   * 回环代理在 WSL2 NAT 下到不了。先探 localhost；不通就把 host 换成宿主网关再探。
   * 两边都不通时返回 via='unreachable'，由调用方决定「不注代理」——注一个死地址
   * 再开 NODE_USE_ENV_PROXY，dsh 的所有 fetch 都会直接失败。
   */
  async function resolveRuntimeProxy(proxyValue) {
    const raw = String(proxyValue ?? '').trim()
    if (!raw) return { url: '', original: '', via: 'none', gateway: '', note: '' }
    const url = proxyUrlObject(raw)
    if (!url) return { url: raw, original: raw, via: 'none', gateway: '', note: 'invalid-proxy' }
    const normalized = url.toString()
    if (!isLoopbackProxyHostname(url.hostname)) return { url: normalized, original: normalized, via: 'direct', gateway: '', note: '' }
    if (await probeProxy(normalized) === true) return { url: normalized, original: normalized, via: 'local', gateway: '', note: '' }
    let gateway = ''
    try {
      const result = await execProbe(buildHostGatewayCommand(), { timeoutMs: 8000 })
      if (result.ok) gateway = parseHostGatewayOutput(decodeWslOutput(result.stdout))
    } catch { /* 拿不到网关就当没有 */ }
    if (gateway) {
      const rewritten = replaceProxyHostname(normalized, gateway)
      if (await probeProxy(rewritten) === true) return { url: rewritten, original: normalized, via: 'gateway', gateway, note: '' }
    }
    return { url: normalized, original: normalized, via: 'unreachable', gateway, note: gateway ? 'proxy-unreachable' : 'gateway-missing' }
  }

  async function detect() {
    const result = await execProbe('uname -s; uname -m', { timeoutMs: 8000 })
    if (!result.ok) throw remoteError(wslReasonFromResult(result), wslFailureMessage(result))
    const [system = '', machine = ''] = decodeWslOutput(result.stdout).trim().split(/\r?\n/).map((line) => line.trim())
    return { platform: system.toLowerCase() === 'linux' ? 'linux' : system.toLowerCase(), arch: normalizeArch(machine) }
  }

  async function disposeAndWait(opts = {}) {
    const grace = Math.max(0, Number(opts.graceTimeoutMs ?? 300))
    const killWait = Math.max(0, Number(opts.killWaitTimeoutMs ?? 250))
    const children = [...owned]
    owned.clear()
    for (const child of children) {
      try { child.stdin?.end() } catch { /* 已经关了 */ }
    }
    await Promise.all(children.map(async (child) => {
      if (await waitForClose(child, grace)) return
      try { child.kill() } catch { /* 已经退出 */ }
      await waitForClose(child, killWait)
    }))
  }

  return {
    kind: 'wsl',
    available: () => wslAvailable(exe),
    resolveIdentity,
    detect,
    exec,
    execProbe,
    stream,
    exists: (path, opts) => checkPath(path, '-e', opts),
    isDirectory: (path, opts) => checkPath(path, '-d', opts),
    readFile,
    upload,
    resolveRuntimeProxy,
    dispose: () => { void disposeAndWait() },
    disposeAndWait,
  }
}

/** 通用的 bash 执行入口（测试和旧调用点用）；给了 user 就以该用户身份跑。 */
export async function wslBash(distro, script, options = {}) {
  const backend = createWslBackend({ distro, user: options.user, exe: options.exe, run: options.run })
  return backend.exec(script, options)
}

/** 兼容旧签名：第 4 个参数可以是注入的 run 函数，也可以是 { run, user }。 */
function runnerOptions(value) {
  if (typeof value === 'function') return { run: value, user: '' }
  if (value && typeof value === 'object') {
    return {
      run: typeof value.run === 'function' ? value.run : null,
      user: String(value.user || '').trim(),
    }
  }
  return { run: null, user: '' }
}

/**
 * 在 WSL 与 Windows 路径之间转换（目录选择器用）：wslpath -w / -a -u。
 * direction='windows'：Linux → Windows（给原生文件夹对话框当初始目录）；
 * direction='linux'：Windows → Linux（对话框选完存回页面）。
 * `~` 在 wslpath 里不会展开，先交给远端 shell 用 $HOME 展开。
 */
export async function wslPath(distro, value, direction = 'linux', options = null) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (!distro) throw new Error('先选择一个 WSL 发行版')
  const { run, user } = runnerOptions(options)
  const toWindows = direction === 'windows'
  const script = toWindows
    ? `p=${shellQuote(text)}; case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac; wslpath -w "$p"`
    : `wslpath -a -u ${shellQuote(text)}`
  const backend = createWslBackend({ distro, user, run })
  const result = await backend.exec(script, { timeoutMs: 10000 })
  if (!result.ok) throw new Error(wslFailureMessage(result) || 'WSL 路径转换失败')
  const converted = decodeWslOutput(result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  if (!converted) throw new Error('WSL 路径转换失败')
  return converted
}

/** 探测一个发行版：dsh 在不在、什么版本、有哪些 profile。 */
export async function inspectWslDistro(distro, home, options = {}) {
  const wantedHome = home || DEFAULT_HOME
  const wantedCommand = options.dshCommand || 'dsh'
  const user = String(options.user || '').trim()
  const key = [distro, wantedHome, wantedCommand, user].join('\0')
  const cacheable = !options.run
  const cached = inspectCache.get(key)
  if (!options.force && cacheable && cached && Date.now() - cached.at < 5000) return cached.value
  const backend = createWslBackend({ distro, user, exe: options.exe, run: options.run })
  const info = {
    ok: false, distro: String(distro || ''), user, home: '', dshHome: '', dshCommand: '', dshPath: '',
    version: '', profiles: [], missing: false, error: '', reasonCode: '', retryable: null, raw: '',
  }
  let identity
  try {
    identity = await backend.resolveIdentity({ force: options.force === true })
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error)
    info.reasonCode = error?.reasonCode || REMOTE_REASON.wslFailed
    info.retryable = typeof error?.retryable === 'boolean' ? error.retryable : null
    if (cacheable) inspectCache.set(key, { at: Date.now(), value: info })
    return info
  }
  info.distro = identity.distro
  info.user = identity.user
  info.home = identity.home
  const command = [
    'dsh_cmd=' + shellQuote(wantedCommand),
    'home=' + shellQuote(wantedHome),
    'case "$home" in',
    '  "~") home="$HOME" ;;',
    '  "~/"*) home="$HOME/${home:2}" ;;',
    'esac',
    'case "$dsh_cmd" in',
    '  "~") dsh_cmd="$HOME" ;;',
    '  "~/"*) dsh_cmd="$HOME/${dsh_cmd:2}" ;;',
    'esac',
    'printf \'__DSHX_DSH_HOME__%s\\n\' "$home"',
    'printf \'__DSHX_DSH_CMD__%s\\n\' "$dsh_cmd"',
    'if command -v "$dsh_cmd" >/dev/null 2>&1; then',
    '  printf \'__DSHX_DSH_PATH__%s\\n\' "$(command -v "$dsh_cmd")"',
    '  printf \'__DSHX_VERSION__%s\\n\' "$("$dsh_cmd" --version 2>&1 | head -n 1)"',
    'else',
    '  printf \'__DSHX_MISSING__1\\n\'',
    'fi',
    'printf \'__DSHX_PROFILES__\\n\'',
    'if [ -d "$home/profiles" ]; then ls -1 "$home/profiles" 2>/dev/null; fi',
  ].join('\n')
  const result = await backend.exec(command, { identity, timeoutMs: 20000 })
  const lines = decodeWslOutput(result.stdout).split(/\r?\n/)
  let inProfiles = false
  for (const line of lines) {
    if (line.indexOf('__DSHX_DSH_HOME__') === 0) info.dshHome = line.slice('__DSHX_DSH_HOME__'.length)
    else if (line.indexOf('__DSHX_DSH_CMD__') === 0) info.dshCommand = line.slice('__DSHX_DSH_CMD__'.length)
    else if (line.indexOf('__DSHX_DSH_PATH__') === 0) info.dshPath = line.slice('__DSHX_DSH_PATH__'.length)
    else if (line.indexOf('__DSHX_VERSION__') === 0) info.version = line.slice('__DSHX_VERSION__'.length).trim()
    else if (line === '__DSHX_MISSING__1') info.missing = true
    else if (line === '__DSHX_PROFILES__') inProfiles = true
    else if (inProfiles && line.trim()) info.profiles.push(line.trim())
  }
  info.raw = decodeWslOutput(result.stdout).slice(0, 4000)
  if (!result.ok) {
    info.error = wslFailureMessage(result)
    info.reasonCode = wslReasonFromResult(result)
    info.retryable = info.reasonCode === REMOTE_REASON.wslTimeout
  } else if (info.missing) {
    info.error = 'WSL 里找不到 ' + (info.dshCommand || 'dsh') + '，先在该发行版里安装 dsh'
    info.reasonCode = REMOTE_REASON.dshMissing
    info.retryable = false
  } else {
    info.ok = Boolean(info.version)
    if (!info.ok) {
      info.error = '没读到 WSL 里 dsh 的版本号，先在 WSL 里运行 dsh --version 确认'
      info.reasonCode = REMOTE_REASON.dshMissing
      info.retryable = false
    }
  }
  if (cacheable) inspectCache.set(key, { at: Date.now(), value: info })
  return info
}

/**
 * 生成安装脚本。文件先写同目录临时文件再 mv 原子替换：bash 可能正在读旧脚本，
 * 直接覆盖会读到半截内容；内容 hash 没变就完全不动目标文件。
 * 锁按发行版/用户目录共享，多个启动同时来也只能有一个在写。
 */
export function buildAgentInstallScript(text = WSL_AGENT_SCRIPT, name = 'dsh-x-wsl.sh') {
  const base64 = Buffer.from(String(text), 'utf8').toString('base64')
  const digest = createHash('sha256').update(String(text), 'utf8').digest('hex')
  const fileName = String(name).replace(/[^A-Za-z0-9._-]/g, '') || 'dsh-x-wsl.sh'
  return [
    'set -eu',
    'd="$HOME/.dsh-x/bin"',
    'mkdir -p "$d"',
    'target="$d/' + fileName + '"',
    'lock="$d/.' + fileName + '.lock"',
    'tmp="$target.tmp.$$"',
    'cleanup() { rm -rf "$lock" "$tmp"; }',
    "trap 'cleanup' EXIT HUP INT TERM",
    'while :; do',
    '  if mkdir "$lock" 2>/dev/null; then',
    '    printf \'%s\\n\' "$$" > "$lock/pid"',
    '    break',
    '  fi',
    '  if [ -f "$lock/pid" ] && ! kill -0 "$(cat "$lock/pid" 2>/dev/null)" 2>/dev/null; then',
    '    rm -rf "$lock"',
    '    continue',
    '  fi',
    '  if [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then',
    '    rm -rf "$lock"',
    '    continue',
    '  fi',
    '  sleep 0.1',
    'done',
    'if [ -f "$target" ] && command -v sha256sum >/dev/null 2>&1 && [ "$(sha256sum "$target" | awk \'{print $1}\')" = "' + digest + '" ]; then',
    '  printf "%s\\n" "$target"',
    '  exit 0',
    'fi',
    "printf '%s' '" + base64 + "' | base64 -d > \"$tmp\"",
    'chmod 755 "$tmp"',
    'mv -f "$tmp" "$target"',
    'printf "%s\\n" "$target"',
  ].join('\n')
}

async function installAgentScript(backend, identity) {
  const result = await backend.exec(buildAgentInstallScript(), { identity, timeoutMs: 20000 })
  if (!result.ok) throw remoteError(wslReasonFromResult(result), '写入 WSL 启动脚本失败：' + wslFailureMessage(result))
}

export function wslHomeKey(distro, home) {
  return 'wsl://' + encodeURIComponent(distro || '') + '/' + encodeURIComponent(home || DEFAULT_HOME)
}

export function parseWslHomeKey(key) {
  const text = String(key || '')
  const match = /^wsl:\/\/([^/]*)\/(.*)$/.exec(text)
  if (!match) return null
  try {
    return { distro: decodeURIComponent(match[1]), home: decodeURIComponent(match[2]) }
  } catch {
    // 手工改坏的键不能让停止/状态查询整条崩掉；当成不是 WSL 实例处理。
    return null
  }
}

export function resolveWslHome(home) {
  const value = String(home || '').trim() || DEFAULT_HOME
  if (value === '~') return '~'
  if (value.indexOf('~/') === 0) return value.replace(/\/+$/, '') || '~/'
  if (value.charAt(0) !== '/') throw new Error('WSL 路径要填绝对路径（例如 /root/.dsh）')
  const normalized = value.replace(/\/+$/, '')
  return normalized || '/'
}

export async function wslPortAvailable(distro, port, options = {}) {
  const script = [
    'port=' + shellQuote(String(port)),
    'if command -v ss >/dev/null 2>&1; then',
    '  if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then exit 1; fi',
    '  exit 0',
    'fi',
    'timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null && exit 1 || exit 0',
  ].join('\n')
  const backend = createWslBackend({ distro, exe: options.exe, run: options.run })
  const result = await backend.exec(script, { timeoutMs: 5000 })
  return result.ok
}

/** 由启动器统一挑端口：优先沿用钉住的，再随机试；同时检查 Windows 侧和 WSL 侧。 */
export async function allocateWslPort(distro, preferred, windowsFree) {
  const checkWindows = windowsFree || (async () => true)
  const candidates = []
  if (preferred > 0) candidates.push(preferred)
  for (let index = 0; index < 40; index += 1) {
    const port = 42000 + Math.floor(Math.random() * 12000)
    if (candidates.indexOf(port) === -1) candidates.push(port)
  }
  for (const port of candidates) {
    if (!(await wslPortAvailable(distro, port))) continue
    if (!(await checkWindows(port))) continue
    return port
  }
  throw new Error('WSL 里没有找到可用端口')
}

/**
 * 启动脚本：代理/Node 的 export 行 + 前台 exec agent。
 * `$HOME` 也交给远端 shell 展开；脚本经 `wsl --exec bash -lc` 传入，不需要 base64。
 */
export function buildStartScript(options = {}) {
  const exports = buildExportsScript(options.env)
  const args = [
    options.instanceId,
    options.profile,
    options.home || DEFAULT_HOME,
    options.workdir || '',
    String(options.port),
    options.dshCommand || 'dsh',
  ].map(shellQuote).join(' ')
  const body = 'script="$HOME/.dsh-x/bin/dsh-x-wsl.sh"\nexec "$script" start ' + args
  return exports ? exports + '\n' + body : body
}

/** 启动一个 WSL 实例；返回的 child 就是 wsl.exe，stdout/stderr 由 attachProcess 读。 */
export async function startWslInstance(options) {
  const serviceMode = options.serviceMode || WSL_SERVICE_MODE
  if (serviceMode !== WSL_SERVICE_MODE) throw new Error('暂不支持 WSL 服务模式：' + serviceMode)
  const backend = createWslBackend({
    distro: options.distro,
    user: options.user,
    exe: options.exe,
    run: options.run,
    spawn: options.spawn,
    identity: options.identity,
  })
  const identity = options.identity || await backend.resolveIdentity()
  const workdir = String(options.workdir || '').trim()
  if (workdir && !(await backend.isDirectory(workdir, { identity }))) {
    throw remoteError(REMOTE_REASON.workspaceUnavailable, `WSL 里的项目目录不存在：${workdir}`)
  }
  await installAgentScript(backend, identity)
  const proxy = await backend.resolveRuntimeProxy(options.proxy?.url ?? options.proxy ?? '')
  const env = proxy.via === 'unreachable' || proxy.via === 'none'
    ? {}
    : {
        ...proxyEnv({ url: proxy.url, bypass: options.proxy?.bypass || [] }),
        // dsh 在 WSL 里跑的是 Node 24：不加这个开关，它的 fetch 完全不看 HTTP_PROXY。
        NODE_USE_ENV_PROXY: '1',
      }
  const instanceId = randomBytes(8).toString('hex')
  const script = buildStartScript({
    instanceId,
    profile: options.profile,
    home: options.home || DEFAULT_HOME,
    workdir,
    port: options.port,
    dshCommand: options.dshCommand || 'dsh',
    env,
  })
  const child = await backend.stream(script, { identity })
  return {
    child,
    instanceId,
    distro: identity.distro,
    user: identity.user,
    port: options.port,
    serviceMode,
    home: options.home || DEFAULT_HOME,
    workdir,
    proxy: { url: proxy.url, original: proxy.original, via: proxy.via, gateway: proxy.gateway, note: proxy.note },
  }
}

/** 停一个 WSL 实例：先让 Linux 侧按 pidfile 收尸，再由调用方杀 wsl.exe 门。 */
export async function stopWslInstance(options) {
  if (!options.distro || !options.instanceId) return { ok: true, skipped: true }
  const command = 'script="$HOME/.dsh-x/bin/dsh-x-wsl.sh"; if [ -x "$script" ]; then exec "$script" stop ' + shellQuote(options.instanceId) + ' ' + shellQuote(String(options.port || '')) + '; fi'
  const backend = createWslBackend({ distro: options.distro, user: options.user, exe: options.exe, run: options.run })
  const result = await backend.exec(command, { timeoutMs: 20000 })
  return { ok: result.ok, stderr: cleanWslStderr(result) || result.stderr, stdout: result.stdout }
}

/**
 * 读一个 WSL Profile 里装了什么：package.json 的依赖 + dsh.profile.bundles。
 * 目录选择窗的右栏要和本机一样列出插件，WSL 侧没有 /api/packs，只能把清单读回来。
 */
export async function readWslProfile(distro, home, profile, options = null) {
  const name = String(profile || '').trim()
  if (!distro) throw new Error('先选择一个 WSL 发行版')
  if (!name) throw new Error('Profile 名称不能为空')
  const { run, user } = runnerOptions(options)
  const script = [
    'set -e',
    `p=${shellQuote(name)}`,
    `h=${shellQuote(String(home || '').trim() || '~/.dsh')}`,
    'case "$h" in "~") h="$HOME" ;; "~/"*) h="$HOME/${h:2}" ;; esac',
    'f="$h/profiles/$p/package.json"',
    'if [ ! -f "$f" ]; then echo __DSHX_MISSING__; exit 0; fi',
    'cat "$f"',
  ].join(String.fromCharCode(10))
  const backend = createWslBackend({ distro, user, run })
  const result = await backend.exec(script, { timeoutMs: 10000 })
  if (!result.ok) throw new Error(wslFailureMessage(result) || '读取 WSL Profile 失败')
  const text = decodeWslOutput(result.stdout).trim()
  if (!text || text === '__DSHX_MISSING__') return { ok: false, profile: name, error: '这个 Profile 还没初始化' }
  let manifest = null
  try { manifest = JSON.parse(text) } catch { return { ok: false, profile: name, error: 'Profile 的 package.json 读不出来' } }
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : null
  const plugins = Object.keys(dependencies).sort().map((plugin) => ({
    name: plugin,
    version: String(dependencies[plugin] || ''),
    mounted: !bundles || bundles.includes(plugin),
  }))
  return { ok: true, profile: name, home: String(home || '').trim() || '~/.dsh', plugins, bundles: bundles || [] }
}

/**
 * 删除 WSL 里的一个 Profile 目录（插件与配置一起删；会话和记忆在 ~/.dsh 别处，不动）。
 * 名字由调用方用 safeProfile 校验过；这里只负责进发行版删目录，存在性由远端脚本判断。
 */
export async function removeWslProfile(distro, home, profile, options = null) {
  const name = String(profile || '').trim()
  if (!distro) throw new Error('先选择一个 WSL 发行版')
  if (!name) throw new Error('Profile 名称不能为空')
  const { run, user } = runnerOptions(options)
  const script = [
    'set -e',
    `p=${shellQuote(name)}`,
    `h=${shellQuote(String(home || '').trim() || '~/.dsh')}`,
    'case "$h" in "~") h="$HOME" ;; "~/"*) h="$HOME/${h:2}" ;; esac',
    'd="$h/profiles/$p"',
    'if [ ! -d "$d" ]; then echo __DSHX_MISSING__; exit 0; fi',
    'rm -rf -- "$d"',
    'echo __DSHX_REMOVED__',
  ].join(String.fromCharCode(10))
  const backend = createWslBackend({ distro, user, run })
  const result = await backend.exec(script, { timeoutMs: 10000 })
  if (!result.ok) throw new Error(wslFailureMessage(result) || '删除 WSL Profile 失败')
  const text = decodeWslOutput(result.stdout)
  if (text.includes('__DSHX_MISSING__')) return { ok: false, profile: name, error: '这个 Profile 还没初始化' }
  return { ok: true, profile: name }
}

export { WSL_EXE, DEFAULT_HOME }
