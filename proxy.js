import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { loadSettingsSync, normalizeProxyUrl, safeProxyMode, safeProxyUrl } from './settings.js'

/**
 * 网络代理：怎么知道该走哪个代理、以及一个「带代理的 fetch」。
 *
 * 为什么需要它：Node 的全局 fetch（undici）**不看** HTTP_PROXY/HTTPS_PROXY，也不看系统
 * 的代理设置——「浏览器能打开 GitHub、启动器却 fetch failed」多半就是这个原因（issue #32：
 * 装完第一次启动，卡在「正在读取版本」直到超时）。Node 24 有 NODE_USE_ENV_PROXY 这个开关，
 * 但启动器自带的运行时是 22.x，没有它，所以这里用内置模块自己实现一段。
 *
 * 覆盖范围：启动器自己的外网请求都走 netFetch（版本列表、GitHub、市场索引、整合包与自更新
 * 下载、MCP 探测）；子进程（dsh、npm/pnpm）从 proxyEnv() 拿环境变量。回环地址永不代理——
 * 管理页、dsh web、本机 MCP 端点都在 127.0.0.1 上。同步引擎（S3/WebDAV）自己用
 * node:http/https 连各自的端点，不经过这里。
 */

/**
 * CONNECT 隧道 / 直连建连的等待上限；拿到响应头之后就不再计时，免得大文件下载被掐。
 *
 * 隧道这条给得比一般建连短一点：代理死了但端口还开着（防火墙把包丢掉那种）时，每个请求
 * 都要白等这么久才轮到直连。本机代理（Clash 之类）不通时是直接 ECONNREFUSED，秒回，
 * 走不到这个上限；10 秒只用来兜住「远端代理没响应」。
 */
const TUNNEL_TIMEOUT_MS = 10_000
const HEADERS_TIMEOUT_MS = 60_000
/** 跟着重定向走几跳（fetch 的默认行为；GitHub 的 release 资产会跳一次到 objects.githubusercontent.com）。 */
const MAX_REDIRECTS = 5
/** 系统代理探测有成本（要起一个 reg/scutil 进程），结果缓存一会儿。 */
const SYSTEM_TTL_MS = 30_000

const WINDOWS_INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 环境变量里的代理也是「系统代理」的一种：代理软件常靠它给命令行工具指路。 */
const ENV_PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']

/* ------------------------------------------------------------------ 探测 */

/** 「127.0.0.1:7890」「http=…;https=…」「socks=…」→ 可用的那个 http 代理地址。 */
export function pickProxyServer(server) {
  const named = {}
  const plain = []
  for (const part of String(server ?? '').split(';')) {
    const text = part.trim()
    if (!text) continue
    const eq = text.indexOf('=')
    if (eq > 0) named[text.slice(0, eq).trim().toLowerCase()] = text.slice(eq + 1).trim()
    else plain.push(text)
  }
  for (const scheme of ['https', 'http', 'socks5', 'socks', 'socks4']) {
    const value = named[scheme]
    if (!value) continue
    if (scheme === 'https' || scheme === 'http') return { url: normalizeProxyUrl(value), scheme }
    // 只有 socks 的系统代理没法直接拿来用：我们的客户端只会说 HTTP 代理协议（CONNECT），
    // 但代理软件基本都同时开着一个 http/混合端口，把原因和地址都交出去让页面说清楚
    return { url: '', scheme, note: 'socks', detail: `${scheme}://${value}` }
  }
  const first = plain[0] || ''
  return first ? { url: normalizeProxyUrl(first), scheme: 'http' } : null
}

/** Windows：ProxyOverride 是分号分隔的绕过名单（`<local>` 表示本机，我们本来就绕）。 */
export function splitBypass(text) {
  return String(text ?? '')
    // Windows 的 ProxyOverride 用分号分隔，环境变量的 NO_PROXY 用逗号：两种都认
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== '<local>')
}

/** `reg query "…\Internet Settings"` 的输出 → 系统代理；没开就是 null。 */
export function parseWindowsProxy(text) {
  const field = (name) => {
    const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi').exec(String(text ?? ''))
    return match ? match[1] : ''
  }
  const enabled = field('ProxyEnable')
  if (!(enabled === '1' || /^0x0*1$/i.test(enabled))) return null
  const picked = pickProxyServer(field('ProxyServer'))
  if (!picked) return null
  const bypass = splitBypass(field('ProxyOverride'))
  if (!picked.url) return { url: '', bypass, note: picked.note, detail: picked.detail, from: 'system' }
  return { url: picked.url, bypass, note: '', detail: '', from: 'system' }
}

/** `scutil --proxy` 的输出 → 系统代理；优先 HTTPS，其次 HTTP。 */
export function parseScutilProxy(text) {
  const fields = {}
  const exceptions = []
  let inList = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const item = /^\s+\d+\s*:\s*(.+?)\s*$/.exec(line)
    if (inList && item) {
      exceptions.push(item[1])
      continue
    }
    const pair = /^\s+([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (!pair) continue
    if (pair[1] === 'ExceptionsList' && pair[2] === '<array> {') {
      inList = true
      continue
    }
    if (inList && pair[2] === '}') inList = false
    fields[pair[1]] = pair[2]
  }
  const on = (key) => fields[key] === '1'
  for (const [scheme, prefix] of [['https', 'HTTPS'], ['http', 'HTTP']]) {
    if (!on(`${prefix}Enable`)) continue
    const host = fields[`${prefix}Proxy`]
    if (!host) continue
    const port = fields[`${prefix}Port`]
    return {
      url: normalizeProxyUrl(port ? `${host}:${port}` : host),
      bypass: splitBypass(exceptions.join(';')),
      note: '',
      detail: '',
      from: 'system',
    }
  }
  if (on('SOCKSEnable') && fields.SOCKSProxy) {
    return {
      url: '',
      bypass: [],
      note: 'socks',
      detail: `socks://${fields.SOCKSProxy}${fields.SOCKSPort ? `:${fields.SOCKSPort}` : ''}`,
      from: 'system',
    }
  }
  return null
}

function runCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * 当前的系统代理（环境变量优先：能设环境变量的场合，那是用户更明确的选择）。
 * 没配、配的用不了、探测失败，都返回 url 为空的对象，note 里放原因（页面拿它提示）。
 * 这个函数**不抛错**：它跑在每次请求和每次给子进程拼环境变量的路上，探测出问题只能当没配。
 */
export function detectSystemProxy({ env = process.env, platform = process.platform, run = runCommand } = {}) {
  const none = { url: '', bypass: [], note: '', detail: '', from: '' }
  for (const key of ENV_PROXY_KEYS) {
    const value = String(env[key] ?? '').trim()
    if (!value) continue
    const url = normalizeProxyUrl(value)
    if (url) return { url, bypass: splitBypass(env.no_proxy || env.NO_PROXY), note: '', detail: '', from: 'env' }
  }
  const query = (command, args) => {
    try {
      return run(command, args) || ''
    } catch {
      return ''
    }
  }
  if (platform === 'win32') return parseWindowsProxy(query('reg', ['query', WINDOWS_INET_KEY])) || none
  if (platform === 'darwin') return parseScutilProxy(query('scutil', ['--proxy'])) || none
  return none
}

let systemCache = { at: 0, value: null }

/** 探测结果缓存（只缓存默认参数下的调用；测试注入的探测不缓存）。 */
export function systemProxy(options) {
  if (options) return detectSystemProxy(options)
  if (!systemCache.value || Date.now() - systemCache.at > SYSTEM_TTL_MS) {
    systemCache = { at: Date.now(), value: detectSystemProxy() }
  }
  return systemCache.value
}

export function resetProxyCache() {
  systemCache = { at: 0, value: null }
}

/**
 * 这次请求该不该走代理：设置里的模式 + 系统探测（详见 settings.js 的 proxyMode）。
 * 返回的对象里 url 为空就是「没有可用的代理」，note 说明原因。
 */
export function resolveProxy(settings = loadSettingsSync()) {
  const mode = safeProxyMode(settings?.proxyMode)
  if (mode === 'off') return { url: '', bypass: [], note: '', detail: '', from: '', mode }
  if (mode === 'manual') {
    let url = ''
    let note = ''
    try {
      url = safeProxyUrl(settings?.proxyUrl)
    } catch {
      // 手改过 settings.json 才可能走到这儿（页面存的时候已经校验过）
      note = 'bad-url'
    }
    return { url, bypass: [], note, detail: String(settings?.proxyUrl ?? ''), from: 'manual', mode }
  }
  return { ...systemProxy(), mode }
}

/* -------------------------------------------------------------- 绕过 / env */

export function isLoopbackHost(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || name === '0.0.0.0'
    || /^127\./.test(name) || name.endsWith('.localhost')
}

function matchBypass(host, rule) {
  const text = String(rule ?? '').trim().toLowerCase()
  if (!text || text === '<local>') return false
  const bare = text.replace(/:\d+$/, '')   // 规则里可能带端口
  if (bare.startsWith('*.')) {
    // `*.example.com` 是后缀通配（curl 和 Windows 都是这个意思），不是前缀——
    // 前缀理解会把 api.corp.cn 漏掉、只挡 corp.cn 自己
    const suffix = bare.slice(2)
    return Boolean(suffix) && (host === suffix || host.endsWith(`.${suffix}`))
  }
  if (bare.includes('*')) {
    // 其余通配按前缀算（`192.168.*` / `10.*` 这类网段写法）
    const head = bare.split('*')[0]
    return Boolean(head) && host.startsWith(head)
  }
  return host === bare || host.endsWith(`.${bare}`)
}

/** true = 别走代理（回环永远直连；系统代理的 ProxyOverride 名单也照做）。 */
export function hostBypassed(host, proxy) {
  if (isLoopbackHost(host)) return true
  const name = String(host ?? '').trim().toLowerCase()
  return (proxy?.bypass || []).some((rule) => matchBypass(name, rule))
}

/**
 * 给子进程的代理环境变量：dsh、npm/pnpm、agent 在 shell 里跑的 curl/git 都认这几个。
 * 回环写进 NO_PROXY——本机服务（dsh web、本地 MCP）不该被绕进代理。
 */
export function proxyEnv(proxy = resolveProxy()) {
  if (!proxy?.url) return {}
  const noProxy = ['localhost', '127.0.0.1', '::1', ...(proxy.bypass || [])].join(',')
  return {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    npm_config_proxy: proxy.url,
    npm_config_https_proxy: proxy.url,
    npm_config_noproxy: noProxy,
  }
}

/* ------------------------------------------------------------------ 请求 */

const proxyUrlOf = (proxy) => {
  try {
    return new URL(proxy?.url || '')
  } catch {
    return null
  }
}

function hasHeader(headers, name) {
  const wanted = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted)
}

function headerObject(headers) {
  if (!headers) return {}
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return Object.fromEntries(headers)
  return { ...headers }
}

function responseHeaders(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw || {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/** 让 describeFetchError（server.js）还能从 cause 里读出 ERRNO/DNS 那类原因。 */
function wrapNetworkError(error) {
  if (!(error instanceof Error)) return new Error(String(error))
  if (error.cause || error.code) return error
  const wrapped = new Error(error.message)
  wrapped.cause = error
  return wrapped
}

function proxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return ''
  const user = decodeURIComponent(proxyUrl.username)
  const pass = decodeURIComponent(proxyUrl.password)
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

/** CONNECT 隧道：跟代理说「连到 target」，通了以后在隧道上自己起 TLS。 */
function openTunnel(proxyUrl, target, signal) {
  const secure = proxyUrl.protocol === 'https:'
  const authority = `${target.hostname}:${Number(target.port) || 443}`
  const headers = { host: authority }
  const authorization = proxyAuthorization(proxyUrl)
  if (authorization) headers['proxy-authorization'] = authorization
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || (secure ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      signal,
    })
    request.setTimeout(TUNNEL_TIMEOUT_MS, () => request.destroy(new Error(`代理 ${proxyUrl.host} 没响应（${TUNNEL_TIMEOUT_MS / 1000} 秒）`)))
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝 CONNECT（HTTP ${response.statusCode}）；地址或端口填错了，或者代理不允许连这个站点`))
        return
      }
      if (head?.length) socket.unshift(head)
      // SNI 不能是 IP：填 IP 的代理目标（少见）就不发 servername
      const servername = /^[\d.]+$/.test(target.hostname) || target.hostname.includes(':') ? undefined : target.hostname
      const socket2 = tlsConnect({ socket, servername })
      socket2.once('secureConnect', () => resolve(socket2))
      socket2.once('error', reject)
    })
    request.once('error', reject)
    request.end()
  })
}

/** 发一次请求（一跳），返回 fetch 风格的 Response。 */
function requestOnce(target, init, proxy) {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === 'https:'
    const port = Number(target.port) || (secure ? 443 : 80)
    const proxyUrl = proxy ? proxyUrlOf(proxy) : null
    const method = String(init.method || 'GET').toUpperCase()
    const headers = headerObject(init.headers)
    if (!hasHeader(headers, 'host')) headers.host = target.host
    const body = init.body

    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(wrapNetworkError(error))
    }
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const onResponse = (response) => {
      // 响应头到了就不再计时：大文件下载（自更新包）可能要好几分钟才传完
      response.socket?.setTimeout?.(0)
      const empty = response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304
      const wrapped = new Response(empty ? null : Readable.toWeb(response), {
        status: response.statusCode,
        statusText: response.statusMessage || '',
        headers: responseHeaders(response.headers),
      })
      Object.defineProperty(wrapped, 'url', { value: target.href, configurable: true })
      done(wrapped)
    }

    const send = (socket) => {
      const options = proxyUrl && !secure
        // 明文 http 走代理：请求行用绝对地址，连接给代理（这是 HTTP 代理的规矩）
        ? { method, headers, host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80, path: target.href }
        : {
          method,
          headers,
          host: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          // 隧道里那条 socket 已经连好、也握完手了，交给它就好。
          // 注意这里**不能**带 agent：带了 agent（哪怕 agent: false）Node 就改用 agent 自己的
          // createConnection 重新连一次目标，隧道白建（实测错误是「TLS 连接建立前 socket 就断了」）。
          ...(socket ? { createConnection: () => socket } : {}),
        }
      const request = (secure ? httpsRequest : httpRequest)({ ...options, signal: init.signal }, onResponse)
      request.setTimeout(HEADERS_TIMEOUT_MS, () => request.destroy(new Error(`等响应超时（${HEADERS_TIMEOUT_MS / 1000} 秒）`)))
      request.once('error', fail)
      if (body === undefined || body === null) {
        request.end()
        return
      }
      if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
        request.end(body)
        return
      }
      if (typeof body?.getReader === 'function' || typeof body?.pipe === 'function') {
        const source = typeof body.pipe === 'function' ? body : Readable.fromWeb(body)
        source.once('error', fail)
        source.pipe(request)
        return
      }
      fail(new Error('这个请求的 body 类型代理模式还不支持'))
    }

    if (proxyUrl && secure) {
      openTunnel(proxyUrl, target, init.signal).then((socket) => {
        socket.once('error', fail)
        send(socket)
      }, fail)
      return
    }
    send(null)
  })
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 跟着重定向走到头（fetch 的默认行为）。 */
async function followRedirects(startUrl, init, proxy) {
  let current = startUrl
  let method = String(init.method || 'GET').toUpperCase()
  let body = init.body
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current)
    const response = await requestOnce(target, { ...init, method, body }, hostBypassed(target.hostname, proxy) ? null : proxy)
    if (init.redirect === 'manual' || !REDIRECT_STATUS.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    // 丢掉这一跳的响应体（大多是空的），再往下一跳
    try {
      await response.body?.cancel()
    } catch { /* 已经关了就无所谓 */ }
    current = new URL(location, current).href
    // 303 一律转 GET；301/302 对 POST 也转 GET（和浏览器一致）
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
    }
  }
  throw new Error(`重定向跳数太多（超过 ${MAX_REDIRECTS} 次）`)
}

/**
 * 带代理的 fetch：先走代理，走不通再直连试一次（代理没配时就是全局 fetch，行为完全不变）。
 * 返回的 Response 上和 fetch 一样能用 ok/status/headers/text()/json()/body；
 * 另外多挂两个属性给「网络自检」：
 * - viaProxy：实际走通的代理地址（空串 = 直连）；
 * - proxyError：直连兜住的这次，代理那头的失败原因（空串 = 没失败过）——否则
 *   「代理填错了但直连能通」看起来一切正常，用户只会觉得代理没生效。
 */
export async function proxyFetch(url, init = {}, proxy) {
  const target = new URL(String(url))
  if (!proxy?.url || hostBypassed(target.hostname, proxy)) {
    const response = await fetch(url, init)
    Object.defineProperty(response, 'viaProxy', { value: '', configurable: true })
    Object.defineProperty(response, 'proxyError', { value: '', configurable: true })
    return response
  }
  let proxyError = null
  for (const attempt of [proxy, null]) {
    try {
      const response = await followRedirects(target.href, init, attempt)
      Object.defineProperty(response, 'viaProxy', { value: attempt ? proxy.url : '', configurable: true })
      Object.defineProperty(response, 'proxyError', { value: attempt ? '' : (proxyError?.message || ''), configurable: true })
      return response
    } catch (error) {
      if (!attempt) {
        // 代理和直连都不通：把两边的说法都带上，用户才知道该改哪一头。
        // proxyError / proxyUrl 挂成属性，好让 describeFetchError（server.js）认出这种情况，
        // 把「代理那条为什么没通」用同样的词汇表讲出来。
        if (!proxyError) throw error
        const joined = new Error(`走代理没通（${proxyError.message}），直连也没通（${error.message}）`)
        joined.cause = error.cause || error
        joined.proxyError = proxyError
        joined.proxyUrl = proxy.url
        throw joined
      }
      proxyError = error
    }
  }
  throw new Error('请求失败')
}

/** 启动器自己的外网请求都走这里：读设置 → 带上代理。 */
export function netFetch(url, init = {}) {
  let proxy = null
  try {
    proxy = resolveProxy()
  } catch {
    // 设置读不出来（第一次启动、文件正是坏的）不该让请求失败，直连就是了
    proxy = null
  }
  return proxyFetch(url, init, proxy)
}
