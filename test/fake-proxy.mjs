/**
 * 一只够用的假 HTTP 代理：CONNECT 隧道（https 目标）和绝对形式转发（http 目标）都支持。
 * 用来在没有真实代理的情况下把「走代理」这条路整个跑通，并留下证据（connects / requests）。
 *
 * 故意写得像真的：CONNECT 的 `host:port` 是我们自己拼的、绝对形式的请求行里必须是完整 URL、
 * 代理认证读 `proxy-authorization`——客户端少写一样，这里就看得见。
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

/** 转发时该丢掉的逐跳头（真实代理也不转发它们）。 */
const HOP_HEADERS = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']

/**
 * 默认把 `*.test` 这类假域名解析到本机：测试里的「源站」都跑在 127.0.0.1 上，而客户端
 * **故意**不代理回环地址——不用假域名的话请求根本不会经过代理，测了个寂寞。
 * 代理本来就负责解析目标域名，这里只是替掉 DNS。
 */
export function localResolver(host) {
  if (/\.test$/i.test(host) || host === 'origin.test') return '127.0.0.1'
  return host
}

export async function startFakeProxy({ username = '', password = '', refuseConnect = 0, resolve = localResolver } = {}) {
  const connects = []
  const requests = []
  // 隧道那两条 socket 服务端不记账（升级过的连接不算在 closeAllConnections 里），自己收着，
  // 关的时候一起断——否则 server.close() 会一直等它们，测试就挂在那里
  const sockets = new Set()
  let refusesLeft = refuseConnect

  const authorized = (headers) => {
    if (!username) return true
    const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    return headers['proxy-authorization'] === expected
  }

  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers })
    if (!authorized(req.headers)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake"' })
      res.end('要代理认证')
      return
    }
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400)
      res.end('绝对形式要用完整 URL')
      return
    }
    const headers = { ...req.headers }
    for (const key of HOP_HEADERS) delete headers[key]
    const upstream = httpRequest({
      host: resolve(target.hostname),
      port: Number(target.port) || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (error) => {
      res.writeHead(502)
      res.end(`上游连不上：${error.code || error.message}`)
    })
    req.pipe(upstream)
  })

  server.on('connect', (req, socket, head) => {
    connects.push({ target: req.url, headers: req.headers })
    if (!authorized(req.headers)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    if (refusesLeft > 0) {
      refusesLeft -= 1
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const index = String(req.url).lastIndexOf(':')
    const host = String(req.url).slice(0, index)
    const port = Number(String(req.url).slice(index + 1)) || 443
    const upstream = netConnect(port, resolve(host), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', (error) => {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.code || ''}`)
    })
    socket.on('error', () => upstream.destroy())
    sockets.add(socket)
    sockets.add(upstream)
    socket.on('close', () => sockets.delete(socket))
    upstream.on('close', () => sockets.delete(upstream))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://${username ? `${username}:${password}@` : ''}127.0.0.1:${port}`,
    port,
    connects,
    requests,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections?.()
      server.close(() => done())
    }),
  }
}
