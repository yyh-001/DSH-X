/**
 * 统一远程反向代理网关：单端口承接公网隧道（Cloudflare Tunnel）/ 局域网 / Tailscale，
 * 同时服务 DSH-X 移动控制台（`/_dshx/*`）与多个并发运行的本机回环 `dsh` 实例（HTTP + WebSocket）。
 *
 * 为什么不能按路径前缀（如 `/i/<key>/`）反代 dsh：
 * dsh 原版 Web UI 与 `/api/*`、`/api/remote.mux` 假定挂在站点根路径下，直接加前缀会破坏前端静态资源与
 * API/WS 路径；而 DSH-X 坚持不魔改 dsh 前端源码。因此改用「保留 `/_dshx/*` 命名空间 + 已认证设备按
 * `dsh-x-instance` Cookie 动态选择当前活跃实例」的单入口方案，手机端无需为每个实例单独开端口或隧道。
 *
 * 为什么由网关做 dsh 认证桥接并隔离 `dsh-auth-*` Cookie：
 * 1. 多实例动态端口与一次性 `?token=` 不该让用户在手机上反复复制；
 * 2. 浏览器同域名下若叠加多个实例的 `dsh-auth-*` Cookie，会互相串扰并把 Cookie 头顶到 16KB 触发 HTTP 431；
 * 3. `dsh-x-device` / `dsh-x-instance` 等网关凭证绝对不能透传给上游 dsh（或 dsh 里的第三方插件）。
 * 因此上游 `dsh-auth-*` 只保存在网关内存表（按 `deviceId + instanceKey` 隔离），对手机浏览器完全隐藏。
 *
 * 转发头信任边界与 `lan-proxy.js` 对齐：只有直接 TCP 对端是本机回环（本地 `cloudflared` / 本机反代）时，
 * 才信任请求带来的 `X-Forwarded-*` / `CF-Connecting-IP`；来自非回环的客户端自带转发头一律剥离。
 *
 * 不记录请求完整 URL：启动桥接时的 query 里带有 launch token。
 */
import http from 'node:http'
import net from 'node:net'

const HTTP_OK = 200
const HTTP_NO_CONTENT = 204
const HTTP_FOUND = 302
const HTTP_SEE_OTHER = 303
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL_ERROR = 500
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503

/** 网关保留命名空间：任何以此开头的路径绝不转发到上游 dsh。 */
export const GATEWAY_PREFIX = '/_dshx/'
export const MOBILE_ROOT_PATH = '/_dshx/m/'
export const HEALTH_PATH = '/_dshx/api/health'
export const PAIR_COMPLETE_PATH = '/_dshx/api/pair/complete'
export const OPEN_INSTANCE_PREFIX = '/_dshx/open/'

/** 网关与上游 dsh 的 Cookie 命名约定。 */
export const DEVICE_COOKIE_NAME = 'dsh-x-device'
export const INSTANCE_COOKIE_NAME = 'dsh-x-instance'
export const GATEWAY_COOKIE_PREFIX = 'dsh-x-'
export const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 注入到代理 HTML 文档末尾的轻量悬浮返回胶囊脚本（同源外链，不触碰内联脚本策略）。 */
export const PILL_SCRIPT_TAG = '<script src="/_dshx/m/pill.js" defer></script>'

const URL_BASE = 'http://remote-gateway.invalid'
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** 非回环客户端自带的转发头一律丢弃，免得伪造来源 IP 或 HTTPS 协议。 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip']
/** 仅缓冲常规 HTML 入口页做胶囊注入；超过上限直接流式透传，避免大响应占内存。 */
const MAX_HTML_INJECT_BYTES = 4 * 1024 * 1024
/** 内部回环 token 桥接超时，防止假死的上游实例拖住网关。 */
const BRIDGE_TIMEOUT_MS = 5000
/** WebSocket 上游 TCP 建连超时与保活探测间隔，避免半开连接长期挂死。 */
const WS_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
const WS_KEEPALIVE_INITIAL_DELAY_MS = 30_000

/** 规范化 IPv4-mapped IPv6 地址（如 `::ffff:127.0.0.1` -> `127.0.0.1`）。 */
export function normalizeRemoteAddress(addr) {
  if (typeof addr !== 'string') return ''
  const trimmed = addr.trim()
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    const v4 = trimmed.slice(7)
    if (net.isIPv4(v4)) return v4
  }
  return trimmed
}

/** 判断 TCP 对端是否本机回环（本地 `cloudflared` / 本机反代）。 */
export function isLoopbackAddress(addr) {
  const normalized = normalizeRemoteAddress(addr).toLowerCase()
  if (!normalized) return false
  if (normalized === '::1') return true
  if (net.isIPv4(normalized)) return normalized.startsWith('127.')
  return false
}

/** 取逗号分隔转发头的首个有效值。 */
function firstHeaderToken(value) {
  if (Array.isArray(value)) value = value[0]
  if (typeof value !== 'string') return ''
  return value.split(',')[0].trim()
}

/**
 * 规范化 HTTP Host 头（小写主机、去掉默认端口），拒绝含换行或空白的畸形值，
 * 避免原始 TCP 升级写头时出现请求走私或 CRLF 注入。
 */
export function normalizeAuthority(hostHeader, proto = 'http') {
  if (typeof hostHeader !== 'string') return ''
  const trimmed = hostHeader.trim()
  if (!trimmed || /[\r\n\s]/.test(trimmed)) return ''
  try {
    return new URL(`${proto}://${trimmed}`).host
  } catch {
    return ''
  }
}

/** 判断公网入口是否 HTTPS（仅在回环对端时采信 `X-Forwarded-Proto`）。 */
export function isSecureRequest(req, isLoopbackPeer) {
  if (req.socket?.encrypted) return true
  if (isLoopbackPeer) {
    return firstHeaderToken(req.headers?.['x-forwarded-proto']).toLowerCase() === 'https'
  }
  return false
}

/**
 * 推导本次请求的真实客户端 IP：
 * 非回环对端强制使用 socket 地址；回环对端（如本地 `cloudflared`）优先读取
 * `CF-Connecting-IP` 与 `X-Forwarded-For`。
 */
export function extractClientIP(req, isLoopbackPeer) {
  if (isLoopbackPeer) {
    const cf = firstHeaderToken(req.headers?.['cf-connecting-ip'])
    if (cf) return cf
    const xff = firstHeaderToken(req.headers?.['x-forwarded-for'])
    if (xff) return xff
  }
  return normalizeRemoteAddress(req.socket?.remoteAddress || '')
}

/**
 * 推导对外公网 Origin（用于改写上游 `Location` 以及识别同源 `Origin` / `Referer`）。
 * 返回 `{ proto, authority, origin, rawAuthority }`；Host 畸形时 `authority` 为空串。
 */
export function resolvePublicOrigin(req, { isLoopbackPeer = false } = {}) {
  const proto = isSecureRequest(req, isLoopbackPeer) ? 'https' : 'http'
  const rawHost = typeof req.headers?.host === 'string' ? req.headers.host.trim() : ''
  const forwardedHost = isLoopbackPeer ? firstHeaderToken(req.headers?.['x-forwarded-host']) : ''
  const rawAuthority = normalizeAuthority(rawHost, proto)
  const forwardedAuthority = forwardedHost ? normalizeAuthority(forwardedHost, proto) : ''
  const authority = forwardedAuthority || rawAuthority
  return {
    proto,
    authority,
    rawAuthority,
    origin: authority ? `${proto}://${authority}` : '',
  }
}

/** 解析 Cookie 头为有序的 `[name, value]` 对列表。 */
export function parseCookies(cookieHeader) {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : String(cookieHeader || '')
  const pairs = []
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    const name = segment.slice(0, at).trim()
    if (!name) continue
    pairs.push([name, segment.slice(at + 1).trim()])
  }
  return pairs
}

/** 读取指定名称的 Cookie 值。 */
export function getCookieValue(cookieHeader, targetName) {
  for (const [name, value] of parseCookies(cookieHeader)) {
    if (name === targetName) return value
  }
  return undefined
}

/**
 * 组装发往上游 dsh 的单行 `Cookie` 头：
 * 剥离所有 `dsh-x-*` 网关 Cookie（防密钥泄漏与 16KB 膨胀）与客户端自带的 `dsh-auth-*`
 * （防跨实例串扰或伪造），再注入网关为当前 `(deviceId, instanceKey)` 托管的 `dsh-auth-*`。
 */
export function filterUpstreamCookies(clientCookieHeader, managedCookies) {
  const kept = []
  for (const [name, value] of parseCookies(clientCookieHeader)) {
    const lower = name.toLowerCase()
    if (lower.startsWith(GATEWAY_COOKIE_PREFIX) || lower.startsWith(DSH_AUTH_COOKIE_PREFIX)) continue
    kept.push(`${name}=${value}`)
  }
  if (managedCookies && typeof managedCookies.entries === 'function') {
    for (const [name, value] of managedCookies.entries()) {
      kept.push(`${name}=${value}`)
    }
  }
  return kept.join('; ')
}

/**
 * 解析上游响应里的 `Set-Cookie`：
 * - `dsh-auth-*` 被网关截留进内存表（含删除语义 `Max-Age=0` / 空值），绝不下发给手机浏览器；
 * - 其余普通 Cookie 原样保留返回给浏览器。
 */
export function processUpstreamSetCookies(setCookieHeader, targetMap) {
  if (!setCookieHeader) return { kept: [], captured: 0 }
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [String(setCookieHeader)]
  const kept = []
  let captured = 0
  for (const raw of list) {
    const firstPart = String(raw).split(';', 1)[0].trim()
    const at = firstPart.indexOf('=')
    if (at === -1) {
      kept.push(raw)
      continue
    }
    const name = firstPart.slice(0, at).trim()
    const value = firstPart.slice(at + 1).trim()
    if (name.toLowerCase().startsWith(DSH_AUTH_COOKIE_PREFIX)) {
      const expired = !value || /;\s*max-age\s*=\s*0(?:\s*;|$)/i.test(raw)
      if (targetMap) {
        if (expired) targetMap.delete(name)
        else targetMap.set(name, value)
      }
      captured++
    } else {
      kept.push(raw)
    }
  }
  return { kept, captured }
}

/** 地址前缀替换：精确相等或以 `from/` 开头才替换，防止端口前缀相近误换或误改外来域名。 */
export function swapOrigin(value, from, to) {
  if (!from || typeof value !== 'string') return value
  if (value === from) return to
  if (value.startsWith(`${from}/`)) return to + value.slice(from.length)
  return value
}

/**
 * 将匹配公网入口的 `Origin` / `Referer` 改写为回环上游 Origin，外来的原样保留给 dsh 拒绝。
 * 为什么同时匹配 `https://<authority>` 与 `http://<authority>`：
 * 经 Cloudflare Tunnel 或本地反代访问时，浏览器发送 `https://<host>` 而本机监听 HTTP，
 * dsh 的 `api-request-trust` 严格要求 `Origin` authority 与 `Host` 一致，否则 `/api/*` 与 WS 会 403。
 */
function rewriteSameSiteOriginHeader(value, publicAuthorities, upstreamOrigin, { isOrigin = false } = {}) {
  if (typeof value !== 'string' || !value || !publicAuthorities.length) return value
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return value
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value
  if (!publicAuthorities.includes(parsed.host)) return value
  if (isOrigin) return upstreamOrigin
  return `${upstreamOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/**
 * 生成转发给上游 dsh 的请求头：
 * - `Host` 改为回环 `127.0.0.1:<port>`，匹配当前入口的 `Origin` / `Referer` 同步改写；
 * - 剥离客户端转发头（除非直接 TCP 对端是本机回环），始终写准确 `x-forwarded-for`；
 * - 剥离网关 `Cookie` 与用于网关鉴权的 `Authorization`，防止设备密钥泄漏到上游 dsh；
 * - 对可能返回 HTML 且开启悬浮胶囊注入的请求强制 `accept-encoding: identity`，避免 gzip 破坏注入。
 */
export function buildUpstreamHeaders(headers, {
  publicAuthorities = [],
  upstreamAuthority,
  upstreamOrigin,
  isLoopbackPeer = false,
  remoteAddress = '',
  cookieHeader = '',
  stripAuthorization = false,
  forceIdentityEncoding = false,
}) {
  const rewritten = { ...headers, host: upstreamAuthority }
  const normalizedPeer = normalizeRemoteAddress(remoteAddress)

  if (!isLoopbackPeer) {
    for (const name of FORWARDING_HEADERS) delete rewritten[name]
    if (normalizedPeer) rewritten['x-forwarded-for'] = normalizedPeer
  } else {
    const existingXff = firstHeaderToken(rewritten['x-forwarded-for'])
    const cfIp = firstHeaderToken(rewritten['cf-connecting-ip'])
    if (!existingXff) {
      const ip = cfIp || normalizedPeer
      if (ip) rewritten['x-forwarded-for'] = ip
    }
  }

  if (rewritten.origin !== undefined) {
    rewritten.origin = rewriteSameSiteOriginHeader(rewritten.origin, publicAuthorities, upstreamOrigin, { isOrigin: true })
  }
  if (rewritten.referer !== undefined) {
    rewritten.referer = rewriteSameSiteOriginHeader(rewritten.referer, publicAuthorities, upstreamOrigin, { isOrigin: false })
  }

  if (cookieHeader) rewritten.cookie = cookieHeader
  else delete rewritten.cookie

  if (stripAuthorization) delete rewritten.authorization
  if (forceIdentityEncoding) rewritten['accept-encoding'] = 'identity'

  return rewritten
}

/** 从实例描述里提取 launch token（优先显式字段，其次从 `instance.url` 的 `?token=` 解析）。 */
export function extractLaunchToken(instance) {
  if (!instance || typeof instance !== 'object') return ''
  if (typeof instance.launchToken === 'string' && instance.launchToken.trim()) {
    return instance.launchToken.trim()
  }
  if (typeof instance.url === 'string' && instance.url) {
    try {
      return new URL(instance.url).searchParams.get('token') || ''
    } catch {
      return ''
    }
  }
  return ''
}

/** 在 HTML 文档的最后一个 `</body>` 前插入悬浮返回胶囊脚本（已存在时不重复注入）。 */
export function injectReturnPillHtml(html, scriptTag = PILL_SCRIPT_TAG) {
  if (typeof html !== 'string' || !scriptTag) return html
  if (html.includes('/_dshx/m/pill.js') || html.includes(scriptTag)) return html
  const lower = html.toLowerCase()
  const bodyClose = lower.lastIndexOf('</body>')
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + scriptTag + html.slice(bodyClose)
  }
  const htmlClose = lower.lastIndexOf('</html>')
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + scriptTag + html.slice(htmlClose)
  }
  return html + scriptTag
}

/** 是否属于保留命名空间 `/_dshx` 或 `/_dshx/*`。 */
function isControlNamespace(pathname) {
  return pathname === '/_dshx' || pathname.startsWith(GATEWAY_PREFIX)
}

/** 是否属于静态移动壳页面 `/_dshx/m` 或 `/_dshx/m/*`（未配对设备也必须能打开配对页）。 */
function isPublicMobileAsset(pathname) {
  return pathname === '/_dshx/m' || pathname.startsWith(MOBILE_ROOT_PATH)
}

/** API 路径未鉴权时一律返回 401 JSON，不走浏览器 302 跳转。 */
function isApiPath(pathname) {
  return pathname.startsWith('/_dshx/api/') || pathname.startsWith('/api/')
}

/** 判断未鉴权请求是否浏览器顶层页面导航：是则 302 到 `/_dshx/m/`，否则返回 401。 */
function isBrowserHtmlNavigation(req, pathname) {
  if (req.method !== 'GET' || isApiPath(pathname)) return false
  const dest = String(req.headers?.['sec-fetch-dest'] || '').toLowerCase()
  if (dest && dest !== 'document' && dest !== 'iframe') return false
  return String(req.headers?.accept || '').toLowerCase().includes('text/html')
}

/** 判断请求是否可能返回需要注入胶囊脚本的 HTML 文档。 */
function mayReturnHtmlDocument(req, pathname) {
  if (req.method !== 'GET' || isApiPath(pathname)) return false
  const accept = String(req.headers?.accept || '').toLowerCase()
  return accept.includes('text/html') || pathname === '/' || pathname.endsWith('.html')
}

/** 从 WS 升级 URL 中剥离网关短票据参数 `ws_ticket`，不把网关票据暴露给上游 dsh。 */
function stripWsTicketFromUrl(rawUrl) {
  if (!rawUrl || !rawUrl.includes('ws_ticket=')) return rawUrl
  try {
    const parsed = new URL(rawUrl, URL_BASE)
    parsed.searchParams.delete('ws_ticket')
    const query = parsed.searchParams.toString()
    return query ? `${parsed.pathname}?${query}` : parsed.pathname
  } catch {
    return rawUrl
  }
}

/** 从请求构造无 CRLF 风险的 URL 对象。 */
function parseRequestUrl(req) {
  const raw = req.url || '/'
  if (/[\r\n]/.test(raw)) return null
  try {
    return new URL(raw, URL_BASE)
  } catch {
    return null
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function sendRedirect(res, status, location, extraHeaders = {}) {
  res.writeHead(status, {
    location,
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end()
}

function rejectUpgrade(socket, status, reason) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  }
}

/** 为 `/_dshx/api/health` 附加跨域探测头，支持 PWA 从局域网/公网多入口并发测速。 */
function applyHealthCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
  res.setHeader('cache-control', 'no-store')
}

/** 构造 `dsh-x-instance` 活跃实例 Cookie（HttpOnly + SameSite=Lax，HTTPS 时附带 Secure）。 */
function buildInstanceCookie(instanceKey, { secure = false, clear = false } = {}) {
  const base = clear
    ? `${INSTANCE_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`
    : `${INSTANCE_COOKIE_NAME}=${encodeURIComponent(instanceKey)}; Path=/; HttpOnly; SameSite=Lax`
  return secure ? `${base}; Secure` : base
}

/** 解码 `dsh-x-instance` Cookie 值，损坏的编码返回空串。 */
function readInstanceCookie(req) {
  const raw = getCookieValue(req.headers?.cookie, INSTANCE_COOKIE_NAME)
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

/** 推断鉴权来源：优先用回调返回的 `source`，缺失时按请求头形态兜底判断。 */
function resolveAuthSource(auth, req) {
  if (auth?.source) return auth.source
  const authorization = String(req.headers?.authorization || '')
  if (/^bearer\s+/i.test(authorization)) return 'bearer'
  if (getCookieValue(req.headers?.cookie, DEVICE_COOKIE_NAME)) return 'cookie'
  return 'unknown'
}

/**
 * 启动统一远程反向代理网关。
 *
 * @param {object} [options]
 * @param {string} [options.host='127.0.0.1'] 监听地址（默认回环给 cloudflared，也可填局域网 IP / 0.0.0.0）
 * @param {number} [options.port=0] 监听端口（0 表示由系统分配）
 * @param {boolean} [options.exclusive=true]
 * @param {(req: http.IncomingMessage) => (object | null | Promise<object | null>)} [options.authenticateRequest]
 *   设备 HTTP 鉴权回调，返回 `{ deviceId, deviceName?, source? } | null`
 * @param {(req: http.IncomingMessage, url: URL) => (object | null | Promise<object | null>)} [options.authenticateWs]
 *   WebSocket 鉴权回调（支持 `?ws_ticket=`）；未命中且未传 `ws_ticket` 时自动回退到 `authenticateRequest`
 * @param {(req: http.IncomingMessage) => boolean} [options.csrfCheck]
 *   Cookie 写请求 CSRF 校验回调（来自 `device-auth.js` 的 `cookieWriteCsrfOk`）
 * @param {(clientIP: string, req: http.IncomingMessage) => ({ allowed: boolean, retryAfterMs?: number } | Promise<{ allowed: boolean, retryAfterMs?: number }>)} [options.checkPairRateLimit]
 *   `/_dshx/api/pair/complete` 限流回调
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, ctx: object) => (boolean | void | Promise<boolean | void>)} [options.handleControlRequest]
 *   处理 `/_dshx/*` 控制面与移动 PWA 静态资源请求的回调
 * @param {(req: http.IncomingMessage, socket: net.Socket, head: Buffer, ctx: object) => (boolean | void | Promise<boolean | void>)} [options.onControlUpgrade]
 *   可选的 `/_dshx/*` 控制面 WebSocket 升级回调
 * @param {(instanceKey: string) => (object | null | Promise<object | null>)} [options.resolveInstance]
 *   按实例键解析运行中的 dsh 实例：`{ key, port, upstreamHost?, url?, launchToken? } | null`
 * @param {() => (Array<object> | Promise<Array<object>>)} [options.listRunningInstances]
 *   返回当前所有运行中实例列表，用于在未设置 `dsh-x-instance` 且恰好仅有 1 个实例运行时自动回落
 * @param {boolean} [options.injectReturnPill=true] 是否向代理的 200 HTML 文档注入悬浮返回胶囊
 * @param {string} [options.pillScriptTag] 自定义注入标签
 * @param {(message: string) => void} [options.onError] 异步/代理错误日志回调
 */
export function startRemoteGateway(options = {}) {
  const {
    host = '127.0.0.1',
    port = 0,
    exclusive = true,
    authenticateRequest = () => null,
    authenticateWs = null,
    csrfCheck = null,
    checkPairRateLimit = null,
    handleControlRequest = null,
    onControlUpgrade = null,
    resolveInstance = () => null,
    listRunningInstances = () => [],
    injectReturnPill = true,
    pillScriptTag = PILL_SCRIPT_TAG,
    onError = () => {},
  } = options

  /**
   * 网关内部托管的上游 dsh 认证 Cookie：`${deviceId}\0${instanceKey}` -> Map<cookieName, cookieValue>。
   * 不同设备、不同实例完全隔离，互不串扰，也不下发给手机浏览器。
   */
  const upstreamCookies = new Map()
  /** 同一 `(deviceId, instanceKey)` 并发冷启动时合并为一次回环 token 交换，避免雪崩请求。 */
  const bridgingInFlight = new Map()
  /** 按实例记录清理代数，防止实例重启清缓存后，重启前在途的旧桥接把过期 Cookie 写回。 */
  const instanceGenerations = new Map()
  /** 活跃连接追踪：按 `deviceId` 分组，吊销设备时立刻销毁该设备所有活跃 WS 与在途长连接。 */
  const deviceSockets = new Map()
  /** 独占型升级连接（WebSocket 两侧 socket）：不在 `http.Server` 的连接表里，关停与全量踢人时必须显式销毁。 */
  const dedicatedSockets = new Set()
  const allSockets = new Set()
  /** 避免对同一 keep-alive socket 反复绑定 `close` 监听器触发 MaxListeners 告警。 */
  const trackedInAll = new WeakSet()
  /** 记录已被吊销过的设备当前代数，防止在途异步 WS 握手在吊销后继续建连。 */
  const deviceRevokeGeneration = new Map()

  const cacheKeyOf = (deviceId, instanceKey) => `${deviceId}\0${instanceKey}`
  const getInstanceGen = (instanceKey) => instanceGenerations.get(instanceKey) || 0

  function ensureCookieBucket(deviceId, instanceKey) {
    const key = cacheKeyOf(deviceId, instanceKey)
    let bucket = upstreamCookies.get(key)
    if (!bucket) {
      bucket = new Map()
      upstreamCookies.set(key, bucket)
    }
    return bucket
  }

  function registerAllSocket(socket) {
    if (!socket || socket.destroyed || trackedInAll.has(socket)) return
    trackedInAll.add(socket)
    allSockets.add(socket)
    socket.once('close', () => {
      allSockets.delete(socket)
    })
  }

  /**
   * 追踪独占型连接（如升级后的 WebSocket 两侧 socket），绑定到 `deviceId` 直到连接关闭。
   */
  function trackDedicatedSocket(socket, deviceId) {
    if (!socket || socket.destroyed) return
    registerAllSocket(socket)
    if (!dedicatedSockets.has(socket)) {
      dedicatedSockets.add(socket)
      socket.once('close', () => dedicatedSockets.delete(socket))
    }
    if (!deviceId) return
    let set = deviceSockets.get(deviceId)
    if (!set) {
      set = new Set()
      deviceSockets.set(deviceId, set)
    }
    if (set.has(socket)) return
    set.add(socket)
    socket.once('close', () => {
      const current = deviceSockets.get(deviceId)
      if (current) {
        current.delete(socket)
        if (current.size === 0) deviceSockets.delete(deviceId)
      }
    })
  }

  /**
   * 追踪在途 HTTP 请求（如 SSE 长流）与设备的绑定关系；响应结束即解绑，
   * 既保证吊销时立即掐断在途流，又不误伤 cloudflared 复用的空闲 keep-alive 连接。
   */
  function trackInFlightHttp(socket, res, deviceId) {
    if (!socket || socket.destroyed || !deviceId) return
    registerAllSocket(socket)
    let set = deviceSockets.get(deviceId)
    if (!set) {
      set = new Set()
      deviceSockets.set(deviceId, set)
    }
    set.add(socket)
    const release = () => {
      const current = deviceSockets.get(deviceId)
      if (current) {
        current.delete(socket)
        if (current.size === 0) deviceSockets.delete(deviceId)
      }
    }
    res.once('finish', release)
    res.once('close', release)
  }

  /**
   * 立即断开指定设备的所有活跃连接（WS / 长连接 / keep-alive）并清除其缓存的上游 dsh Cookie。
   * 在管理页吊销设备时调用，保证已打开的 WS 会话立刻下线。
   */
  function disconnectDevice(deviceId) {
    if (!deviceId) return 0
    deviceRevokeGeneration.set(deviceId, (deviceRevokeGeneration.get(deviceId) || 0) + 1)
    let destroyed = 0
    const set = deviceSockets.get(deviceId)
    if (set) {
      for (const socket of [...set]) {
        socket.destroy()
        destroyed++
      }
      deviceSockets.delete(deviceId)
    }
    const prefix = `${deviceId}\0`
    for (const key of [...upstreamCookies.keys()]) {
      if (key.startsWith(prefix)) upstreamCookies.delete(key)
    }
    return destroyed
  }

  /** 断开全部设备的活跃连接（WS 与在途流）并清空所有上游 Cookie 缓存（如一键吊销全部设备）。 */
  function disconnectAll() {
    for (const deviceId of deviceSockets.keys()) {
      deviceRevokeGeneration.set(deviceId, (deviceRevokeGeneration.get(deviceId) || 0) + 1)
    }
    const toDestroy = new Set(dedicatedSockets)
    for (const set of deviceSockets.values()) {
      for (const socket of set) toDestroy.add(socket)
    }
    let destroyed = 0
    for (const socket of toDestroy) {
      socket.destroy()
      destroyed++
    }
    dedicatedSockets.clear()
    deviceSockets.clear()
    upstreamCookies.clear()
    server.closeIdleConnections()
    return destroyed
  }

  /** 清理某个实例的所有上游 dsh Cookie（在实例停止或重启时调用）。 */
  function clearInstanceCookies(instanceKey) {
    if (!instanceKey) return
    instanceGenerations.set(instanceKey, getInstanceGen(instanceKey) + 1)
    const suffix = `\0${instanceKey}`
    for (const key of [...upstreamCookies.keys()]) {
      if (key.endsWith(suffix)) upstreamCookies.delete(key)
    }
    for (const key of [...bridgingInFlight.keys()]) {
      if (key.endsWith(suffix)) bridgingInFlight.delete(key)
    }
  }

  /**
   * 透明 dsh 认证桥接：向本机回环实例发起 `GET /?token=<launchToken>`，
   * 从上游 303（或 200/302）响应的 `Set-Cookie` 中提取 `dsh-auth-*` 存入内存表。
   */
  async function bridgeUpstreamAuth(deviceId, instanceKey, instance, { force = false } = {}) {
    const launchToken = extractLaunchToken(instance)
    if (!launchToken) return { bridged: false }
    const key = cacheKeyOf(deviceId, instanceKey)
    const existing = upstreamCookies.get(key)
    if (!force && existing && existing.size > 0) return { bridged: true, cached: true }

    if (!force && bridgingInFlight.has(key)) {
      return bridgingInFlight.get(key)
    }

    const upstreamHost = instance.upstreamHost || '127.0.0.1'
    const upstreamPort = instance.port
    const startInstanceGen = getInstanceGen(instanceKey)
    const startDeviceGen = deviceRevokeGeneration.get(deviceId) || 0

    const task = new Promise((resolve, reject) => {
      const req = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: 'GET',
        path: `/?token=${encodeURIComponent(launchToken)}`,
        headers: {
          host: `${upstreamHost}:${upstreamPort}`,
          'accept-encoding': 'identity',
        },
        timeout: BRIDGE_TIMEOUT_MS,
      }, (res) => {
        res.resume()
        // 实例已重启或设备已吊销时丢弃过期的桥接结果
        if (getInstanceGen(instanceKey) !== startInstanceGen || (deviceRevokeGeneration.get(deviceId) || 0) !== startDeviceGen) {
          resolve({ bridged: false, stale: true })
          return
        }
        const bucket = ensureCookieBucket(deviceId, instanceKey)
        if (force) bucket.clear()
        const { captured } = processUpstreamSetCookies(res.headers['set-cookie'], bucket)
        resolve({ bridged: captured > 0, statusCode: res.statusCode })
      })
      req.on('timeout', () => {
        req.destroy(new Error('上游 dsh 认证桥接超时'))
      })
      req.on('error', reject)
      req.end()
    }).finally(() => {
      if (bridgingInFlight.get(key) === task) bridgingInFlight.delete(key)
    })

    bridgingInFlight.set(key, task)
    return task
  }

  /**
   * 为非 `/_dshx/` 请求解析目标 dsh 实例：
   * 1. 优先读 `dsh-x-instance` Cookie 对应的运行中实例；
   * 2. 若未设置 Cookie 且当前恰好仅有 1 个运行中实例，自动回落到该唯一实例；
   * 3. 否则返回 null（由调用方重定向到 `/_dshx/m/` 或返回 503）。
   */
  async function resolveActiveInstance(req) {
    const cookieKey = readInstanceCookie(req)
    if (cookieKey) {
      const inst = await resolveInstance(cookieKey)
      if (inst && Number.isInteger(inst.port) && inst.port > 0 && inst.port <= 65535) {
        return { instance: inst, instanceKey: inst.key || cookieKey, staleCookie: false }
      }
      return { instance: null, instanceKey: '', staleCookie: true }
    }
    const running = await listRunningInstances()
    if (Array.isArray(running) && running.length === 1) {
      const only = running[0]
      if (only && Number.isInteger(only.port) && only.port > 0 && only.port <= 65535) {
        return { instance: only, instanceKey: only.key || '', staleCookie: false }
      }
    }
    return { instance: null, instanceKey: '', staleCookie: false }
  }

  /** 处理 `GET /_dshx/open/:instanceKey`：校验实例、种实例 Cookie、桥接 dsh 认证并 303 到 `/`。 */
  async function handleOpenInstance(req, res, { pathname, auth, isSecure }) {
    if (req.method !== 'GET') {
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { ok: false, error: 'method_not_allowed' })
      return
    }
    const rawKey = pathname.slice(OPEN_INSTANCE_PREFIX.length)
    if (!rawKey) {
      sendJson(res, HTTP_BAD_REQUEST, { ok: false, error: 'missing_instance_key' })
      return
    }
    let instanceKey
    try {
      instanceKey = decodeURIComponent(rawKey)
    } catch {
      sendJson(res, HTTP_BAD_REQUEST, { ok: false, error: 'invalid_instance_key' })
      return
    }
    const instance = await resolveInstance(instanceKey)
    if (!instance || !Number.isInteger(instance.port) || instance.port <= 0 || instance.port > 65535) {
      sendJson(res, HTTP_NOT_FOUND, { ok: false, error: 'instance_not_found' })
      return
    }
    const resolvedKey = instance.key || instanceKey
    try {
      await bridgeUpstreamAuth(auth.deviceId, resolvedKey, instance)
    } catch (error) {
      onError(`dsh 认证桥接失败: ${error.message}`)
      sendJson(res, HTTP_BAD_GATEWAY, { ok: false, error: 'upstream_auth_bridge_failed' })
      return
    }
    sendRedirect(res, HTTP_SEE_OTHER, '/', {
      'set-cookie': buildInstanceCookie(resolvedKey, { secure: isSecure }),
    })
  }

  /** 转发普通 HTTP 请求到目标回环 dsh 实例，支持 401 自动重桥接与 HTML 返回胶囊注入。 */
  async function proxyHttpToInstance(req, res, {
    pathname,
    auth,
    authSource,
    isLoopbackPeer,
    publicInfo,
    instance,
    instanceKey,
  }) {
    const upstreamHost = instance.upstreamHost || '127.0.0.1'
    const upstreamPort = instance.port
    const upstreamAuthority = `${upstreamHost}:${upstreamPort}`
    const upstreamOrigin = `http://${upstreamAuthority}`
    const publicAuthorities = [...new Set([publicInfo.authority, publicInfo.rawAuthority].filter(Boolean))]
    const cacheKey = cacheKeyOf(auth.deviceId, instanceKey)
    const launchToken = extractLaunchToken(instance)

    // 首次访问某实例（或实例刚清理过 Cookie）且手头有 launchToken 时，先透明换好 dsh-auth-* Cookie
    if (launchToken && !(upstreamCookies.get(cacheKey)?.size > 0)) {
      try {
        await bridgeUpstreamAuth(auth.deviceId, instanceKey, instance)
      } catch (error) {
        onError(`dsh 认证桥接失败: ${error.message}`)
        sendJson(res, HTTP_BAD_GATEWAY, { ok: false, error: 'upstream_auth_bridge_failed' })
        return
      }
    }

    const canAutoRetry = (req.method === 'GET' || req.method === 'HEAD') && Boolean(launchToken)
    const wantPillCheck = injectReturnPill !== false && mayReturnHtmlDocument(req, pathname)
    const startInstanceGen = getInstanceGen(instanceKey)

    const sendUpstream = (attempt) => {
      const managedCookies = upstreamCookies.get(cacheKey)
      const cookieHeader = filterUpstreamCookies(req.headers.cookie, managedCookies)
      const headers = buildUpstreamHeaders(req.headers, {
        publicAuthorities,
        upstreamAuthority,
        upstreamOrigin,
        isLoopbackPeer,
        remoteAddress: req.socket?.remoteAddress || '',
        cookieHeader,
        stripAuthorization: authSource === 'bearer',
        forceIdentityEncoding: wantPillCheck,
      })

      const upstreamReq = http.request({
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      }, (upstreamRes) => {
        // 上游返回 401 且手头有 launchToken（例如 dsh 刚重启换了签名密钥）：重跑一次桥接并透明重试 GET/HEAD
        if (upstreamRes.statusCode === HTTP_UNAUTHORIZED && attempt === 0 && canAutoRetry) {
          upstreamRes.resume()
          bridgeUpstreamAuth(auth.deviceId, instanceKey, instance, { force: true })
            .then(() => {
              if (!res.writableEnded && !res.destroyed) sendUpstream(1)
            })
            .catch((error) => {
              onError(`dsh 401 自动重桥接失败: ${error.message}`)
              if (!res.headersSent) res.writeHead(HTTP_BAD_GATEWAY).end()
              else res.destroy()
            })
          return
        }
        // 非 GET/HEAD 无法安全重放请求体，但仍清掉可能已过期的上游 Cookie，让下一次请求自动重新桥接
        if (upstreamRes.statusCode === HTTP_UNAUTHORIZED && launchToken) {
          upstreamCookies.delete(cacheKey)
        }

        const outHeaders = { ...upstreamRes.headers }
        // 截留上游 dsh-auth-* Cookie 存进内存表，绝不发给手机浏览器
        if (outHeaders['set-cookie'] !== undefined) {
          const targetBucket = getInstanceGen(instanceKey) === startInstanceGen
            ? ensureCookieBucket(auth.deviceId, instanceKey)
            : null
          const { kept } = processUpstreamSetCookies(outHeaders['set-cookie'], targetBucket)
          if (kept.length > 0) outHeaders['set-cookie'] = kept
          else delete outHeaders['set-cookie']
        }

        if (outHeaders.location !== undefined && publicInfo.origin) {
          outHeaders.location = swapOrigin(outHeaders.location, upstreamOrigin, publicInfo.origin)
        }

        const contentType = String(outHeaders['content-type'] || '').toLowerCase()
        const contentEncoding = String(outHeaders['content-encoding'] || '').trim().toLowerCase()
        const shouldInjectPill = wantPillCheck
          && upstreamRes.statusCode === HTTP_OK
          && contentType.startsWith('text/html')
          && (!contentEncoding || contentEncoding === 'identity')

        if (!shouldInjectPill) {
          res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, outHeaders)
          upstreamRes.pipe(res)
          return
        }

        // 仅对未压缩的 200 HTML 缓冲注入悬浮返回胶囊，超过体积上限立即退回流式透传
        const chunks = []
        let totalBytes = 0
        let passthrough = false

        upstreamRes.on('data', (chunk) => {
          if (passthrough) {
            res.write(chunk)
            return
          }
          totalBytes += chunk.length
          if (totalBytes > MAX_HTML_INJECT_BYTES) {
            passthrough = true
            res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, outHeaders)
            for (const prev of chunks) res.write(prev)
            chunks.length = 0
            res.write(chunk)
            return
          }
          chunks.push(chunk)
        })

        upstreamRes.on('end', () => {
          if (passthrough) {
            res.end()
            return
          }
          const rawHtml = Buffer.concat(chunks, totalBytes).toString('utf8')
          const modified = injectReturnPillHtml(rawHtml, pillScriptTag)
          const outBuf = Buffer.from(modified, 'utf8')
          delete outHeaders['transfer-encoding']
          delete outHeaders['content-md5']
          delete outHeaders.etag
          outHeaders['content-length'] = String(outBuf.byteLength)
          res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, outHeaders)
          res.end(outBuf)
        })

        upstreamRes.on('error', (error) => {
          onError(error.message)
          if (!res.headersSent) res.writeHead(HTTP_BAD_GATEWAY).end()
          else res.destroy()
        })
      })

      upstreamReq.on('error', (error) => {
        onError(error.message)
        if (res.headersSent) res.destroy()
        else res.writeHead(HTTP_BAD_GATEWAY).end()
      })

      res.on('close', () => {
        if (!res.writableEnded) upstreamReq.destroy()
      })

      if (attempt === 0 && req.method !== 'GET' && req.method !== 'HEAD') {
        req.pipe(upstreamReq)
      } else {
        upstreamReq.end()
      }
    }

    sendUpstream(0)
  }

  /** HTTP 主分发入口。 */
  async function handleHttpRequest(req, res) {
    const url = parseRequestUrl(req)
    const isLoopbackPeer = isLoopbackAddress(req.socket?.remoteAddress || '')
    const publicInfo = resolvePublicOrigin(req, { isLoopbackPeer })

    if (!url || !publicInfo.authority) {
      sendJson(res, HTTP_BAD_REQUEST, { ok: false, error: 'bad_request' })
      return
    }

    const pathname = url.pathname
    const isSecure = publicInfo.proto === 'https'
    const clientIP = extractClientIP(req, isLoopbackPeer)
    const activeInstanceKey = readInstanceCookie(req)

    // 1. 保留命名空间 `/_dshx/*`：绝不转发到上游 dsh
    if (isControlNamespace(pathname)) {
      if (pathname === '/_dshx') {
        sendRedirect(res, HTTP_FOUND, MOBILE_ROOT_PATH)
        return
      }

      // 1a. 健康检查 / 多链路延迟探测：公开 + 允许跨域
      if (pathname === HEALTH_PATH) {
        applyHealthCorsHeaders(res)
        if (req.method === 'OPTIONS') {
          res.writeHead(HTTP_NO_CONTENT).end()
          return
        }
        const ctx = {
          url,
          pathname,
          auth: null,
          clientIP,
          isLoopbackPeer,
          isSecure,
          publicOrigin: publicInfo.origin,
          activeInstanceKey,
        }
        if (handleControlRequest) {
          const handled = await handleControlRequest(req, res, ctx)
          if (handled !== false || res.writableEnded || res.headersSent) return
        }
        sendJson(res, HTTP_OK, { ok: true })
        return
      }

      // 1b. 移动壳 PWA 静态资源：公开（未配对设备需要打开扫码/配对页）
      if (isPublicMobileAsset(pathname)) {
        const ctx = {
          url,
          pathname,
          auth: null,
          clientIP,
          isLoopbackPeer,
          isSecure,
          publicOrigin: publicInfo.origin,
          activeInstanceKey,
        }
        if (handleControlRequest) {
          const handled = await handleControlRequest(req, res, ctx)
          if (handled !== false || res.writableEnded || res.headersSent) return
        }
        sendJson(res, HTTP_NOT_FOUND, { ok: false, error: 'not_found' })
        return
      }

      // 1c. 配对提交：公开 + 按客户端 IP 限流
      if (pathname === PAIR_COMPLETE_PATH) {
        if (checkPairRateLimit) {
          const limit = await checkPairRateLimit(clientIP, req)
          if (limit && limit.allowed === false) {
            const retryAfterMs = Math.max(1000, Number(limit.retryAfterMs) || 1000)
            sendJson(res, HTTP_TOO_MANY_REQUESTS, {
              ok: false,
              error: 'rate_limited',
              retryAfterMs,
            }, { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) })
            return
          }
        }
        const ctx = {
          url,
          pathname,
          auth: null,
          clientIP,
          isLoopbackPeer,
          isSecure,
          publicOrigin: publicInfo.origin,
          activeInstanceKey,
        }
        if (handleControlRequest) {
          const handled = await handleControlRequest(req, res, ctx)
          if (handled !== false || res.writableEnded || res.headersSent) return
        }
        sendJson(res, HTTP_NOT_FOUND, { ok: false, error: 'not_found' })
        return
      }

      // 1d. 其余所有 `/_dshx/*`（含 `/_dshx/open/:key` 与 `/_dshx/api/*`）均强制设备鉴权
      const auth = await authenticateRequest(req)
      if (!auth || !auth.deviceId) {
        if (isBrowserHtmlNavigation(req, pathname)) {
          sendRedirect(res, HTTP_FOUND, MOBILE_ROOT_PATH)
        } else {
          sendJson(res, HTTP_UNAUTHORIZED, { ok: false, error: 'unauthorized' })
        }
        return
      }

      const authSource = resolveAuthSource(auth, req)
      trackInFlightHttp(req.socket, res, auth.deviceId)

      if (authSource === 'cookie' && !SAFE_HTTP_METHODS.has(req.method) && csrfCheck && !csrfCheck(req)) {
        sendJson(res, HTTP_FORBIDDEN, { ok: false, error: 'csrf_failed' })
        return
      }

      if (pathname.startsWith(OPEN_INSTANCE_PREFIX)) {
        await handleOpenInstance(req, res, { pathname, auth, isSecure })
        return
      }

      const ctx = {
        url,
        pathname,
        auth: { ...auth, source: authSource },
        clientIP,
        isLoopbackPeer,
        isSecure,
        publicOrigin: publicInfo.origin,
        activeInstanceKey,
      }
      if (handleControlRequest) {
        const handled = await handleControlRequest(req, res, ctx)
        if (handled !== false || res.writableEnded || res.headersSent) return
      }
      sendJson(res, HTTP_NOT_FOUND, { ok: false, error: 'not_found' })
      return
    }

    // 2. 非 `/_dshx/` 请求：转发到当前选中的上游 dsh 实例（强制设备鉴权）
    const auth = await authenticateRequest(req)
    if (!auth || !auth.deviceId) {
      if (isBrowserHtmlNavigation(req, pathname)) {
        sendRedirect(res, HTTP_FOUND, MOBILE_ROOT_PATH)
      } else {
        sendJson(res, HTTP_UNAUTHORIZED, { ok: false, error: 'unauthorized' })
      }
      return
    }

    const authSource = resolveAuthSource(auth, req)
    trackInFlightHttp(req.socket, res, auth.deviceId)

    if (authSource === 'cookie' && !SAFE_HTTP_METHODS.has(req.method) && csrfCheck && !csrfCheck(req)) {
      sendJson(res, HTTP_FORBIDDEN, { ok: false, error: 'csrf_failed' })
      return
    }

    const resolved = await resolveActiveInstance(req)
    if (!resolved.instance) {
      const clearHeaders = resolved.staleCookie
        ? { 'set-cookie': buildInstanceCookie('', { secure: isSecure, clear: true }) }
        : {}
      if (req.method === 'GET' && !isApiPath(pathname)) {
        sendRedirect(res, HTTP_FOUND, MOBILE_ROOT_PATH, clearHeaders)
      } else {
        sendJson(res, HTTP_SERVICE_UNAVAILABLE, { ok: false, error: 'no_active_instance' }, clearHeaders)
      }
      return
    }

    await proxyHttpToInstance(req, res, {
      pathname,
      auth: { ...auth, source: authSource },
      authSource,
      isLoopbackPeer,
      publicInfo,
      instance: resolved.instance,
      instanceKey: resolved.instanceKey,
    })
  }

  /** WebSocket 升级转发入口（如 dsh 的 `/api/remote.mux`）。 */
  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {})
    registerAllSocket(socket)

    const url = parseRequestUrl(req)
    const isLoopbackPeer = isLoopbackAddress(req.socket?.remoteAddress || '')
    const publicInfo = resolvePublicOrigin(req, { isLoopbackPeer })

    if (!url || !publicInfo.authority) {
      rejectUpgrade(socket, HTTP_BAD_REQUEST, 'Bad Request')
      return
    }

    const pathname = url.pathname

    // `/_dshx/*` 的 WS 升级绝不转发到上游 dsh
    if (isControlNamespace(pathname)) {
      if (onControlUpgrade) {
        const auth = authenticateWs ? await authenticateWs(req, url) : await authenticateRequest(req)
        if (!auth || !auth.deviceId) {
          rejectUpgrade(socket, HTTP_UNAUTHORIZED, 'Unauthorized')
          return
        }
        trackDedicatedSocket(socket, auth.deviceId)
        const ctx = {
          url,
          pathname,
          auth,
          clientIP: extractClientIP(req, isLoopbackPeer),
          isLoopbackPeer,
          isSecure: publicInfo.proto === 'https',
          publicOrigin: publicInfo.origin,
          activeInstanceKey: readInstanceCookie(req),
        }
        const handled = await onControlUpgrade(req, socket, head, ctx)
        if (handled !== false) return
      }
      rejectUpgrade(socket, HTTP_NOT_FOUND, 'Not Found')
      return
    }

    // 优先使用 WS 专用鉴权（支持 `?ws_ticket=`），未带票据时回退到 Cookie / Bearer 鉴权
    let auth = null
    const hasWsTicket = url.searchParams.has('ws_ticket')
    if (authenticateWs) {
      auth = await authenticateWs(req, url)
    }
    if (!auth && !hasWsTicket) {
      auth = await authenticateRequest(req)
    }
    if (!auth || !auth.deviceId) {
      rejectUpgrade(socket, HTTP_UNAUTHORIZED, 'Unauthorized')
      return
    }

    const startDeviceGen = deviceRevokeGeneration.get(auth.deviceId) || 0
    const authSource = resolveAuthSource(auth, req)
    trackDedicatedSocket(socket, auth.deviceId)

    const resolved = await resolveActiveInstance(req)
    if (!resolved.instance) {
      rejectUpgrade(socket, HTTP_SERVICE_UNAVAILABLE, 'Service Unavailable')
      return
    }

    const { instance, instanceKey } = resolved
    const upstreamHost = instance.upstreamHost || '127.0.0.1'
    const upstreamPort = instance.port
    const upstreamAuthority = `${upstreamHost}:${upstreamPort}`
    const upstreamOrigin = `http://${upstreamAuthority}`
    const publicAuthorities = [...new Set([publicInfo.authority, publicInfo.rawAuthority].filter(Boolean))]
    const cacheKey = cacheKeyOf(auth.deviceId, instanceKey)

    if (extractLaunchToken(instance) && !(upstreamCookies.get(cacheKey)?.size > 0)) {
      try {
        await bridgeUpstreamAuth(auth.deviceId, instanceKey, instance)
      } catch (error) {
        onError(`WS 上游 dsh 认证桥接失败: ${error.message}`)
        rejectUpgrade(socket, HTTP_BAD_GATEWAY, 'Bad Gateway')
        return
      }
    }

    // 异步等待期间客户端断开或设备已被吊销，直接中止建连
    if (socket.destroyed || (deviceRevokeGeneration.get(auth.deviceId) || 0) !== startDeviceGen) {
      socket.destroy()
      return
    }

    const upstreamPath = stripWsTicketFromUrl(req.url)
    const managedCookies = upstreamCookies.get(cacheKey)
    const cookieHeader = filterUpstreamCookies(req.headers.cookie, managedCookies)
    const headers = buildUpstreamHeaders(req.headers, {
      publicAuthorities,
      upstreamAuthority,
      upstreamOrigin,
      isLoopbackPeer,
      remoteAddress: req.socket?.remoteAddress || '',
      cookieHeader,
      stripAuthorization: authSource === 'bearer',
    })

    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, WS_KEEPALIVE_INITIAL_DELAY_MS)

    let upstreamConnected = false
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      upstreamConnected = true
      upstream.setTimeout(0)
      upstream.setNoDelay(true)
      upstream.setKeepAlive(true, WS_KEEPALIVE_INITIAL_DELAY_MS)
      if (socket.destroyed || (deviceRevokeGeneration.get(auth.deviceId) || 0) !== startDeviceGen) {
        upstream.destroy()
        socket.destroy()
        return
      }
      let requestHead = `${req.method} ${upstreamPath} HTTP/1.1\r\n`
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const item of [].concat(value)) {
          // 防御性过滤 CR/LF，避免原始 socket 写头走私
          const safeVal = String(item).replace(/[\r\n]/g, '')
          requestHead += `${name}: ${safeVal}\r\n`
        }
      }
      upstream.write(`${requestHead}\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })

    upstream.setTimeout(WS_UPSTREAM_CONNECT_TIMEOUT_MS)
    upstream.on('timeout', () => {
      if (upstreamConnected) return
      onError('WS 上游连接超时')
      upstream.destroy()
      rejectUpgrade(socket, HTTP_BAD_GATEWAY, 'Bad Gateway')
    })

    trackDedicatedSocket(upstream, auth.deviceId)
    upstream.on('error', (error) => {
      onError(error.message)
      if (!upstreamConnected) rejectUpgrade(socket, HTTP_BAD_GATEWAY, 'Bad Gateway')
      else socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
  }

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
      onError(error?.message || String(error))
      if (res.headersSent) res.destroy()
      else sendJson(res, HTTP_INTERNAL_ERROR, { ok: false, error: 'internal_error' })
    })
  })

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      onError(error?.message || String(error))
      rejectUpgrade(socket, HTTP_BAD_GATEWAY, 'Bad Gateway')
    })
  })

  const close = () => new Promise((resolve) => {
    upstreamCookies.clear()
    bridgingInFlight.clear()
    server.close(() => resolve())
    server.closeAllConnections()
    for (const socket of [...allSockets]) socket.destroy()
    allSockets.clear()
    dedicatedSockets.clear()
    deviceSockets.clear()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host, exclusive }, () => {
      server.off('error', reject)
      server.on('error', (error) => onError(error.message))
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      resolve({
        host,
        port: boundPort,
        server,
        disconnectDevice,
        disconnectAll,
        clearInstanceCookies,
        getActiveSocketCount: (deviceId) => (deviceId ? (deviceSockets.get(deviceId)?.size || 0) : allSockets.size),
        close,
      })
    })
  })
}
