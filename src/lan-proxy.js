/**
 * 局域网反向代理：dsh 只绑 127.0.0.1，启动器在「局域网 IP + 同一端口」上起一个代理转发到回环。
 *
 * 为什么不让 dsh 直接绑局域网：dsh 0.2.1-rc.2 起拒绝通配地址（0.0.0.0），只能绑一个具体 IP；
 * 绑了局域网 IP，本机回环、内置窗口和启动器所有 127.0.0.1 探活就全断了，IP 一变还起不来。
 *
 * 为什么不是裸 TCP 转发：dsh 的 /api 防 DNS rebinding，只认回环（或它绑定的那个 IP）的
 * Host / Origin，局域网 Host 原样过去会被 403。所以这里按同样的口径先挡一次（只认自己的
 * 局域网 authority），再把 Host 和同源的 Origin / Referer 改写成回环，响应的 Location 改回来。
 * 外来的 Origin 原样转发，跨站请求仍由 dsh 自己拒绝；认证（launch token + cookie）完全不碰。
 *
 * 每个请求都带上 X-Forwarded-For，并丢掉客户端自带的转发头：上游连接来自回环，不加的话
 * 插件里「仅本机」的接口（配对管理等）会把局域网设备当成本机；dsh 核心认证不看这些头。
 *
 * 不记录请求 URL：第一次访问的 query 里带着 launch token。
 */
import http from 'node:http'
import net from 'node:net'
import { networkInterfaces } from 'node:os'

const HTTP_OK = 200
const HTTP_SEE_OTHER = 303
const HTTP_FORBIDDEN = 403
const HTTP_BAD_GATEWAY = 502
/** dsh 的 launch token 参数名与认证 cookie 前缀（dsh-client-connection 的 TOKEN_QUERY / COOKIE_PREFIX）。 */
const TOKEN_PARAM = 'token'
const AUTH_COOKIE_PREFIX = 'dsh-auth-'
/** 解析相对 URL 用的占位基址：只取路径和 query，主机名无意义。 */
const URL_BASE = 'http://lan-proxy.invalid'
/** 客户端自带的转发头一律丢掉，免得局域网设备伪造「我来自本机」。 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip']

/**
 * 隧道 / VPN 网卡名前缀：地址是本机的点对点端点，局域网里的设备连不过来。
 * 和远程访问插件（@linxin666/dsh-remote-web-ui 的 lan.js）同一份清单，两边选出的地址才一致。
 */
const TUNNEL_INTERFACE_PREFIXES = ['utun', 'tun', 'tap', 'ppp', 'ipsec', 'wg', 'wireguard', 'tailscale', 'nordlynx', 'proton', 'openvpn', 'zt']
/** 虚拟机 / 容器网桥：NAT 后面的地址，物理局域网连不到。bridge0 / br0 故意不在里面（真桥接）。 */
const VIRTUAL_INTERFACE_PREFIXES = ['docker', 'veth', 'virbr', 'vmnet', 'vboxnet', 'vethernet', 'br-']

/** 局域网设备路由不到的 IPv4 段：0/8、回环、CGNAT（Tailscale）、链路本地、基准测试段（假 IP 代理的 TUN）、组播及保留。 */
function isUnreachableIPv4(address) {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function isTunnelOrVirtual(name) {
  const lower = String(name).toLowerCase()
  return [...TUNNEL_INTERFACE_PREFIXES, ...VIRTUAL_INTERFACE_PREFIXES].some((prefix) => lower.startsWith(prefix))
}

/**
 * 本机可以给局域网用的 IPv4：非 internal、不在隧道 / 虚拟网卡上、不在路由不到的段里，取第一个。
 * 不按默认路由选：开着全局 VPN 时默认路由就是 utun，选出来的地址局域网设备连不上。
 * @param {ReturnType<typeof networkInterfaces>} [interfaces] 测试时注入
 * @returns {string} 找不到返回空串
 */
export function pickLanAddress(interfaces = networkInterfaces()) {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (isTunnelOrVirtual(name)) continue
    for (const item of addresses ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (!net.isIPv4(item.address) || isUnreachableIPv4(item.address)) continue
      return item.address
    }
  }
  return ''
}

/**
 * 把 dsh 打印的访问链接换成局域网地址：只换主机，端口、路径和 token 保持不变
 * （代理和 dsh 用同一个端口）。
 * @returns {string} 解析不了或没有局域网地址时返回空串
 */
export function lanUrlOf(url, lanHost) {
  if (!url || !net.isIPv4(lanHost || '')) return ''
  try {
    const parsed = new URL(url)
    parsed.hostname = lanHost
    return parsed.href
  } catch {
    return ''
  }
}

/** 地址前缀替换：值等于 from，或以 `from/` 开头才换；外来的值原样返回。 */
export function swapOrigin(value, from, to) {
  if (value === from) return to
  if (typeof value === 'string' && value.startsWith(`${from}/`)) return to + value.slice(from.length)
  return value
}

/** 一次代理的地址组合（authority 都是 host:port，只对 IPv4 字面量无歧义，所以入口只收 IPv4）。 */
export function proxyAddresses(lanHost, port, upstreamHost = '127.0.0.1') {
  const publicAuthority = `${lanHost}:${port}`
  const upstreamAuthority = `${upstreamHost}:${port}`
  return {
    publicAuthority,
    upstreamAuthority,
    publicOrigin: `http://${publicAuthority}`,
    upstreamOrigin: `http://${upstreamAuthority}`,
  }
}

/** 和 dsh 自带的 DNS rebinding 防护同一口径：只放行发给本代理自己 authority 的请求。 */
export function isTrustedHost(hostHeader, addresses) {
  return hostHeader === addresses.publicAuthority
}

/**
 * 转给上游的请求头：Host 换回环，同源的 Origin / Referer 跟着换，外来的原样留给 dsh 拒绝；
 * 客户端带来的转发头丢掉，换成真实的 X-Forwarded-For。
 */
export function upstreamHeaders(headers, addresses, clientAddress) {
  const rewritten = { ...headers, host: addresses.upstreamAuthority }
  for (const name of FORWARDING_HEADERS) delete rewritten[name]
  if (rewritten.origin !== undefined) rewritten.origin = swapOrigin(rewritten.origin, addresses.publicOrigin, addresses.upstreamOrigin)
  if (rewritten.referer !== undefined) rewritten.referer = swapOrigin(rewritten.referer, addresses.publicOrigin, addresses.upstreamOrigin)
  if (clientAddress) rewritten['x-forwarded-for'] = clientAddress
  return rewritten
}

/**
 * dsh 成功的 token 交换：带 ?token= 的请求得到 303 + Set-Cookie dsh-auth-*。
 *
 * 为什么要认出它：dsh 的认证 cookie 是 SameSite=Strict，交换完用 303 跳回 ./。从别的 App
 * 或网站打开局域网链接时，浏览器把整条跳转链算作跨站，跳转后的 GET 不带新 cookie，dsh 回 401。
 * 改成 200 的中转页后，下一跳是同源导航，Strict cookie 照常带上，不必放宽 SameSite。
 */
export function isTokenExchange(requestUrl, statusCode, setCookie) {
  if (statusCode !== HTTP_SEE_OTHER) return false
  if (!new URL(requestUrl ?? '/', URL_BASE).searchParams.has(TOKEN_PARAM)) return false
  return [].concat(setCookie ?? []).some((cookie) => String(cookie).startsWith(AUTH_COOKIE_PREFIX))
}

/** 中转页：location.replace 同时把带 token 的地址从历史记录里换掉。 */
export const LOGIN_BOUNCE_HTML = '<!doctype html><meta charset="utf-8"><title>DSH</title>'
  + '<script>location.replace("./")</script>'
  + '<noscript><meta http-equiv="refresh" content="0;url=./"></noscript>'
  + '<a href="./">Continue</a>'

/** 中转页的响应头：保留 dsh 自己的 Set-Cookie / Cache-Control / Referrer-Policy，去掉跳转和原 body 的长度。 */
export function bounceHeaders(headers) {
  const { location: _location, 'content-length': _length, 'transfer-encoding': _encoding, ...kept } = headers
  return { ...kept, 'content-type': 'text/html; charset=utf-8' }
}

/**
 * 在 lanHost:port 上起代理，转发到 upstreamHost:port。
 * @param {{ lanHost: string, port: number, upstreamHost?: string, onError?: (message: string) => void }} options
 * @returns {Promise<{ lanHost: string, port: number, close: () => Promise<void> }>} 监听失败时 reject（带 code，如 EADDRINUSE）
 */
export function startLanProxy({ lanHost, port, upstreamHost = '127.0.0.1', onError = () => {} }) {
  if (!net.isIPv4(lanHost) || !net.isIPv4(upstreamHost)) return Promise.reject(new Error('局域网代理只支持 IPv4 地址'))
  const addresses = proxyAddresses(lanHost, port, upstreamHost)
  // 升级后的 WebSocket 不在 http.Server 的连接表里，关代理时要自己断开
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  const server = http.createServer((req, res) => {
    if (!isTrustedHost(req.headers.host, addresses)) {
      res.writeHead(HTTP_FORBIDDEN).end()
      return
    }
    const upstream = http.request({
      host: upstreamHost,
      port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers, addresses, req.socket.remoteAddress),
    }, (upstreamRes) => {
      if (isTokenExchange(req.url, upstreamRes.statusCode, upstreamRes.headers['set-cookie'])) {
        upstreamRes.resume()
        res.writeHead(HTTP_OK, bounceHeaders(upstreamRes.headers)).end(LOGIN_BOUNCE_HTML)
        return
      }
      const headers = { ...upstreamRes.headers }
      if (headers.location !== undefined) headers.location = swapOrigin(headers.location, addresses.upstreamOrigin, addresses.publicOrigin)
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      onError(error.message)
      if (res.headersSent) res.destroy()
      else res.writeHead(HTTP_BAD_GATEWAY).end()
    })
    req.pipe(upstream)
  })

  // WebSocket（/api/remote.mux）等升级请求：按同样的规则改写请求头后重放，再把两条 socket 接起来
  server.on('upgrade', (req, socket, head) => {
    track(socket)
    if (!isTrustedHost(req.headers.host, addresses)) {
      socket.end(`HTTP/1.1 ${HTTP_FORBIDDEN} Forbidden\r\n\r\n`)
      return
    }
    const upstream = net.connect(port, upstreamHost, () => {
      let requestHead = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [name, value] of Object.entries(upstreamHeaders(req.headers, addresses, req.socket.remoteAddress))) {
        for (const item of [].concat(value)) requestHead += `${name}: ${item}\r\n`
      }
      upstream.write(`${requestHead}\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    track(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  const close = () => new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
    for (const socket of sockets) socket.destroy()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host: lanHost, exclusive: true }, () => {
      server.off('error', reject)
      // 监听之后的错误（极少见）只报告，不能让管理器进程崩掉
      server.on('error', (error) => onError(error.message))
      resolve({ lanHost, port, close })
    })
  })
}
