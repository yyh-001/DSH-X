import { isIP } from 'node:net'

/**
 * 远程启动的通用部分：错误分档、身份探测、代理探测与改写、POSIX shell 拼装。
 *
 * 这层不碰 wsl.exe / ssh / Electron，任何 transport 都能用。WSL 实现在 wsl.js；
 * #97 的 SSH backend 只要实现同一组方法，server.js 的启动分支不用再改。
 * 身份探测和回环代理改写对齐 ZCode 3.17.2 的 WSLBackend（MIT）。
 */

/** 启动失败的原因码。页面按码给可操作文案，不再从 stderr 里猜。 */
export const REMOTE_REASON = Object.freeze({
  wslUnavailable: 'wsl-unavailable',
  distroMissing: 'distro-missing',
  userMissing: 'user-missing',
  wslTimeout: 'wsl-timeout',
  dshMissing: 'dsh-missing',
  workspaceUnavailable: 'workspace-unavailable',
  wslFailed: 'wsl-failed',
})

/** 只有「等一会儿再试可能就好」的失败才标 retryable；配置/环境类失败重试只会重复报错。 */
const RETRYABLE_REASONS = new Set([REMOTE_REASON.wslTimeout])

/**
 * 带原因码的启动错误。
 * @param {string} code REMOTE_REASON 里的值
 * @param {string} message 给用户看的中文原文
 * @param {{ retryable?: boolean, cause?: unknown }} [options]
 */
export function remoteError(code, message, options = {}) {
  const error = new Error(message)
  error.reasonCode = code
  error.retryable = options.retryable === undefined ? RETRYABLE_REASONS.has(code) : options.retryable === true
  if (options.cause !== undefined) error.cause = options.cause
  return error
}

/** 把错误上的原因码取出来，挂进 lastFailure / publicFailure 时用。 */
export function remoteErrorFields(error) {
  if (!error || typeof error !== 'object') return {}
  const code = typeof error.reasonCode === 'string' ? error.reasonCode : ''
  const retryable = typeof error.retryable === 'boolean' ? error.retryable : null
  return {
    ...(code ? { code } : {}),
    ...(retryable === null ? {} : { retryable }),
  }
}

/* ------------------------------------------------------------------ 身份 */

/** 身份探测的输出标记；脚本可能被登录 profile 污染，解析时取最后一次出现。 */
export const IDENTITY_MARKER = '__DSHX_IDENTITY__'

/**
 * 身份探测脚本。走 `bash --noprofile --norc -c`，不加载用户的 .bashrc：
 * 探测只要 distro / 用户 / 真实 HOME 三项，profile 的输出只会添乱。
 */
export function buildIdentityScript() {
  return `printf '%s\\n' '${IDENTITY_MARKER}' "$WSL_DISTRO_NAME" "$(id -un)" "$HOME"`
}

/**
 * 解析身份探测输出。
 * @param {unknown} text
 * @returns {{ ok: boolean, distro: string, user: string, home: string, error: string }}
 */
export function parseIdentityOutput(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const index = lines.map((line) => line.trim()).lastIndexOf(IDENTITY_MARKER)
  if (index < 0) {
    return { ok: false, distro: '', user: '', home: '', error: '探测输出里缺少 WSL 身份标记' }
  }
  const [rawDistro = '', rawUser = '', ...rest] = lines.slice(index + 1)
  // HOME 可能被拆成多行（极少见），按 ZCode 的做法整段接回来再 trim。
  const home = rest.join('\n').trim()
  const distro = rawDistro.trim()
  const user = rawUser.trim()
  if (!home) return { ok: false, distro, user, home: '', error: '没读到 WSL 用户的 HOME' }
  return { ok: true, distro, user, home, error: '' }
}

/**
 * 用户名校验，沿用 ZCode 的规则：1–64 字符、禁控制字符、禁 `: / \`。
 * 空串表示「用发行版的默认用户」，是合法的。
 */
export function isValidWslUser(value) {
  const text = String(value ?? '').trim()
  if (!text) return true
  if (text.length > 64) return false
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return false
  }
  return !text.includes(':') && !text.includes('/') && !text.includes('\\')
}

/**
 * 发行版名大小写不敏感归一。列表拿不到时按用户填的原样用，不凭空判失败。
 * @param {string} requested
 * @param {Array<{ name: string }>} distros
 * @returns {{ name: string, entry: object|null, listed: boolean, missing: boolean }}
 */
export function pickDistro(requested, distros) {
  const wanted = String(requested ?? '').trim()
  const list = Array.isArray(distros) ? distros.filter((item) => item && item.name) : []
  if (wanted) {
    if (!list.length) return { name: wanted, entry: null, listed: false, missing: false }
    const entry = list.find((item) => item.name.localeCompare(wanted, undefined, { sensitivity: 'base' }) === 0) || null
    return entry
      ? { name: entry.name, entry, listed: true, missing: false }
      : { name: wanted, entry: null, listed: true, missing: true }
  }
  const fallback = list.find((item) => item.default) || list[0] || null
  return fallback
    ? { name: fallback.name, entry: fallback, listed: true, missing: false }
    : { name: '', entry: null, listed: false, missing: false }
}

/* ------------------------------------------------------------------ shell */

/** POSIX shell 单引号转义。值里的单引号按 `'` → `'\''` 拆开。 */
export function shellQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'"
}

/**
 * 把环境变量拼成 export 行。键名不合法或值里有换行就跳过——代理 URL 是唯一来源，
 * 正常不会出现这两种情况，这里只是不给注入留口子。
 */
export function buildExportsScript(env) {
  const lines = []
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const text = String(value ?? '')
    if (/[\r\n]/.test(text)) continue
    lines.push('export ' + key + '=' + shellQuote(text))
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ 代理 */

/** 解析成 http/https 代理地址；不是这两种协议就当作没有代理。 */
export function proxyUrlObject(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * 回环代理判断：localhost / ::1 / 0.0.0.0 / 127.*。
 * WSL2 NAT 模式下这些地址在 Linux 侧指向 WSL 自己，必须换成宿主网关。
 */
export function isLoopbackProxyHostname(hostname) {
  const name = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (name === 'localhost' || name === '::1' || name === '0.0.0.0') return true
  return isIP(name) === 4 ? name.startsWith('127.') : false
}

/** 换掉代理地址的 host，保留协议、端口和用户名密码；IPv6 自动补方括号。 */
export function replaceProxyHostname(value, hostname) {
  const url = new URL(String(value))
  const bare = String(hostname ?? '').replace(/^\[|\]$/g, '')
  url.hostname = isIP(bare) === 6 ? `[${bare}]` : bare
  return url.toString()
}

/**
 * 在 Linux 侧探一次「这个代理端口通不通」。
 * `:</dev/tcp/host/port` 是 `:` 加读重定向：不依赖 bash 的 `exec 3<>`，
 * 端口关着时立刻失败，超时由 `timeout 1` 兜住。
 */
export function buildProxyPortProbeCommand(value) {
  const url = proxyUrlObject(value)
  if (!url) return ''
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const target = isIP(host) === 6 ? `[${host}]` : host
  return [
    'if command -v timeout >/dev/null 2>&1 &&',
    `timeout 1 bash -c ${shellQuote(`:</dev/tcp/${target}/${port}`)} >/dev/null 2>&1; then`,
    'printf reachable;',
    'else',
    'printf unreachable;',
    'fi',
  ].join(' ')
}

/** 探测输出只有两种结论；其它输出（比如命令不存在）当作「不知道」。 */
export function parseProxyPortProbeOutput(text) {
  const value = String(text ?? '').trim()
  if (value === 'reachable') return true
  if (value === 'unreachable') return false
  return undefined
}

/**
 * 找宿主网关：`ip route` 的默认路由优先，`/etc/resolv.conf` 的 nameserver 兜底。
 * 输出 `route=<ip>` / `resolv=<ip>`，交给 parseHostGatewayOutput 过滤。
 */
export function buildHostGatewayCommand() {
  return [
    'gateway=',
    'if command -v ip >/dev/null 2>&1; then gateway=$(ip route show default 2>/dev/null | awk \'$1=="default" && $2=="via" {print $3; exit}\'); fi',
    'if [ -n "$gateway" ]; then printf "route=%s " "$gateway"; fi',
    'if [ -r /etc/resolv.conf ]; then awk \'$1=="nameserver" {print "resolv=" $2}\' /etc/resolv.conf; fi',
  ].join('; ')
}

/** 私有网段 / 链路本地地址：resolv.conf 里的 nameserver 只有这类才可能是宿主网关。 */
export function isPrivateOrLinkLocalAddress(value) {
  const family = isIP(value)
  if (family === 6) {
    const name = value.toLowerCase()
    return name.startsWith('fc') || name.startsWith('fd') || /^fe[89ab]/.test(name)
  }
  if (family !== 4) return false
  const [first, second] = value.split('.').map(Number)
  return first === 10
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || value.startsWith('169.254.')
}

function isGatewayCandidate(value, source) {
  const family = isIP(value)
  if (family !== 4 && family !== 6) return false
  if (value === '::1' || (family === 4 && value.startsWith('127.'))) return false
  // 默认路由里的 IP 就是网卡对端，不要求私有段（容器/自定义网络常见公网段）；
  // nameserver 可能是 8.8.8.8 这类公共 DNS，只有私有/链路本地才像宿主。
  return source === 'resolv' ? isPrivateOrLinkLocalAddress(value) : true
}

/** 解析网关探测输出；按 token 顺序取第一个候选。 */
export function parseHostGatewayOutput(text) {
  for (const token of String(text ?? '').trim().split(/\s+/)) {
    if (!token) continue
    const match = /^(route|resolv)=(.+)$/.exec(token)
    const source = match ? match[1] : 'resolv'
    const value = (match ? match[2] : token).replace(/^\[|\]$/g, '')
    if (isGatewayCandidate(value, source)) return value
  }
  return ''
}

/** 日志里只留协议/主机/端口，不把代理的用户名密码写进启动日志。 */
export function formatProxyForLog(value) {
  const url = proxyUrlObject(value)
  if (!url) return '<invalid-proxy>'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const shown = isIP(host) === 6 ? `[${host}]` : host
  return `${url.protocol}//${shown}${url.port ? `:${url.port}` : ''}`
}

/**
 * @typedef {object} RemoteBackend
 * @property {'wsl'|'ssh'} kind
 * @property {() => boolean} available
 * @property {(options?: { force?: boolean }) => Promise<{ distro: string, user: string, home: string, version: number|null }>} resolveIdentity
 * @property {() => Promise<{ platform: string, arch: string }>} detect
 * @property {(script: string, options?: object) => Promise<object>} exec
 * @property {(script: string, options?: object) => object} stream
 * @property {(path: string, options?: object) => Promise<boolean>} exists
 * @property {(path: string, options?: object) => Promise<boolean>} isDirectory
 * @property {(path: string, options?: object) => Promise<string>} readFile
 * @property {(data: Buffer|string, path: string, options?: object) => Promise<void>} upload
 * @property {(proxyUrl: string) => Promise<object>} resolveRuntimeProxy
 * @property {() => void} dispose
 * @property {(options?: object) => Promise<void>} disposeAndWait
 */
