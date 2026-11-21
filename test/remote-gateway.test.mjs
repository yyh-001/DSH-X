import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { pickLanAddress } from '../src/lan-proxy.js'
import {
  DEVICE_COOKIE_NAME,
  INSTANCE_COOKIE_NAME,
  PILL_SCRIPT_TAG,
  buildUpstreamHeaders,
  filterUpstreamCookies,
  injectReturnPillHtml,
  isLoopbackAddress,
  processUpstreamSetCookies,
  startRemoteGateway,
} from '../src/remote-gateway.js'

/**
 * 假 dsh 实例：
 * - 强制校验回环 Host（127.0.0.1:<port>）与同源 Origin；
 * - `GET /?token=<launchToken>` 返回 303 + `Set-Cookie: dsh-auth-<port>=<secret>`；
 * - 未携带正确 `dsh-auth-<port>` 的 `/api/ping` 等接口返回 401；
 * - 支持 `/api/remote.mux` WebSocket 升级与回声，记录每次请求头供断言无密钥泄漏。
 */
async function fakeDsh(name, initialToken) {
  let launchToken = initialToken
  let authSecret = `secret-${name}-1`
  const seen = []
  const upgraded = new Set()

  const server = http.createServer((req, res) => {
    const port = server.address().port
    const expectedHost = `127.0.0.1:${port}`
    const cookieName = `dsh-auth-${port}`
    const expectedCookie = `${cookieName}=${authSecret}`
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })

    if (req.headers.host !== expectedHost) {
      res.writeHead(403).end('bad host')
      return
    }
    if (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) {
      res.writeHead(403).end('bad origin')
      return
    }

    const url = new URL(req.url, `http://${expectedHost}`)
    if (url.pathname === '/' && url.searchParams.get('token') === launchToken) {
      res.writeHead(303, {
        location: './',
        'cache-control': 'no-store',
        'set-cookie': `${expectedCookie}; HttpOnly; SameSite=Strict`,
      }).end()
      return
    }

    const cookieHeader = String(req.headers.cookie || '')
    if (!cookieHeader.split(';').map((s) => s.trim()).includes(expectedCookie)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ instance: name, port }))
      return
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ instance: name, body }))
      })
      return
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `http://${expectedHost}/after` }).end()
      return
    }

    if (url.pathname === '/gzip.html') {
      const zipped = gzipSync(Buffer.from(`<!doctype html><html><body><h1>GZIP ${name}</h1></body></html>`))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(zipped.byteLength),
      }).end(zipped)
      return
    }

    if (url.pathname === '/') {
      const html = `<!doctype html><html><head><base href="./"></head><body><h1>DSH ${name}</h1></body></html>`
      const extraHeaders = url.searchParams.get('refresh') === '1'
        ? { 'set-cookie': [`${expectedCookie}; HttpOnly; SameSite=Strict`, 'ui-pref=compact; Path=/'] }
        : {}
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(html)),
        etag: '"orig-etag"',
        ...extraHeaders,
      }).end(html)
      return
    }

    res.writeHead(404).end('not found')
  })

  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    const port = server.address().port
    const expectedHost = `127.0.0.1:${port}`
    const expectedCookie = `dsh-auth-${port}=${authSecret}`
    seen.push({ method: req.method, url: req.url, upgrade: true, headers: { ...req.headers } })

    const okHost = req.headers.host === expectedHost
    const okOrigin = !req.headers.origin || req.headers.origin === `http://${expectedHost}`
    const okCookie = String(req.headers.cookie || '').split(';').map((s) => s.trim()).includes(expectedCookie)
    if (!okHost || !okOrigin || !okCookie) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => {
      socket.write(`${name}:${chunk.toString('utf8')}`)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    name,
    port,
    seen,
    get url() { return `http://127.0.0.1:${port}/?token=${launchToken}` },
    get launchToken() { return launchToken },
    rotateAuth(newToken, newSecret) {
      launchToken = newToken
      authSecret = newSecret
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
      for (const s of upgraded) s.destroy()
    }),
  }
}

/** 通用 HTTP 请求工具，返回状态码、响应头与原始 Buffer/文本体。 */
function httpCall(port, { host = '127.0.0.1', method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      method,
      path,
      agent: false,
      headers: { host: `${host}:${port}`, ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          body: buffer.toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

/** 建立原始 WebSocket 升级连接，等待服务端响应头，返回可读写的 socket 封装。 */
function openWs(port, { host = '127.0.0.1', path = '/api/remote.mux', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      const allHeaders = {
        Host: `${host}:${port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        ...headers,
      }
      let head = `GET ${path} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(allHeaders)) {
        head += `${k}: ${v}\r\n`
      }
      socket.write(`${head}\r\n`)
    })

    let buf = ''
    let settled = false
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const sep = buf.indexOf('\r\n\r\n')
      if (sep === -1) return
      socket.off('data', onData)
      settled = true
      const statusLine = buf.slice(0, buf.indexOf('\r\n'))
      const status = Number(statusLine.split(' ')[1] || 0)
      const rest = buf.slice(sep + 4)
      resolve({ socket, status, head: buf.slice(0, sep), rest })
    }
    socket.on('data', onData)
    socket.on('error', (err) => { if (!settled) reject(err) })
    socket.once('close', () => {
      if (!settled) resolve({ socket, status: 0, head: buf, rest: '' })
    })
  })
}

/** 读取已升级 socket 的下一段回声数据。 */
function readNextChunk(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取 WS 数据超时')), timeoutMs)
    const onData = (chunk) => {
      clearTimeout(timer)
      socket.off('close', onClose)
      resolve(chunk.toString('utf8'))
    }
    const onClose = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      resolve(null)
    }
    socket.once('data', onData)
    socket.once('close', onClose)
  })
}

/** 等待 socket 关闭事件。 */
function waitSocketClose(socket, timeoutMs = 2000) {
  if (socket.destroyed || socket.closed) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

test('工具函数：回环判定、Cookie 隔离、转发头信任边界、HTTPS Origin 改写与胶囊注入', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.50'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.50'), false)
  assert.equal(isLoopbackAddress('203.0.113.5'), false)

  const managed = new Map([['dsh-auth-3001', 'v1.good']])
  const filtered = filterUpstreamCookies(
    `${DEVICE_COOKIE_NAME}=tok_secret; ${INSTANCE_COOKIE_NAME}=A; dsh-x-manager-1=mgr; dsh-auth-3001=forged; theme=dark`,
    managed,
  )
  assert.equal(filtered, 'theme=dark; dsh-auth-3001=v1.good')

  const bucket = new Map()
  const { kept, captured } = processUpstreamSetCookies([
    'dsh-auth-3001=v1.fresh; Path=/; HttpOnly; SameSite=Strict',
    'ui-pref=compact; Path=/',
  ], bucket)
  assert.equal(captured, 1)
  assert.equal(bucket.get('dsh-auth-3001'), 'v1.fresh')
  assert.deepEqual(kept, ['ui-pref=compact; Path=/'])

  // 非回环对端：伪造转发头一律丢弃并改写为真实对端 IP
  const nonLoopback = buildUpstreamHeaders({
    host: '192.168.1.10:3790',
    origin: 'http://192.168.1.10:3790',
    referer: 'http://192.168.1.10:37900/other',
    'x-forwarded-for': '127.0.0.1',
    'x-forwarded-proto': 'https',
    'cf-connecting-ip': '127.0.0.1',
    forwarded: 'for=127.0.0.1',
    authorization: 'Bearer tok_gateway_secret',
  }, {
    publicAuthorities: ['192.168.1.10:3790'],
    upstreamAuthority: '127.0.0.1:4100',
    upstreamOrigin: 'http://127.0.0.1:4100',
    isLoopbackPeer: false,
    remoteAddress: '::ffff:192.168.1.50',
    cookieHeader: 'dsh-auth-4100=ok',
    stripAuthorization: true,
  })
  assert.equal(nonLoopback.host, '127.0.0.1:4100')
  assert.equal(nonLoopback.origin, 'http://127.0.0.1:4100')
  assert.equal(nonLoopback.referer, 'http://192.168.1.10:37900/other', '端口相近的非同源 Referer 不得改写')
  assert.equal(nonLoopback['x-forwarded-for'], '192.168.1.50')
  assert.equal(nonLoopback['cf-connecting-ip'], undefined)
  assert.equal(nonLoopback['x-forwarded-proto'], undefined)
  assert.equal(nonLoopback.forwarded, undefined)
  assert.equal(nonLoopback.authorization, undefined, '用于网关鉴权的 Bearer 不得透传给上游')

  // 回环对端（本地 cloudflared）：保留转发头，并将 HTTPS 公网 Origin/Referer 改写为回环 HTTP
  const loopback = buildUpstreamHeaders({
    host: 'my.example.com',
    origin: 'https://my.example.com:443',
    referer: 'https://my.example.com/chat?id=1',
    'x-forwarded-for': '203.0.113.9',
    'cf-connecting-ip': '203.0.113.9',
    'x-forwarded-proto': 'https',
  }, {
    publicAuthorities: ['my.example.com'],
    upstreamAuthority: '127.0.0.1:4100',
    upstreamOrigin: 'http://127.0.0.1:4100',
    isLoopbackPeer: true,
    remoteAddress: '127.0.0.1',
    cookieHeader: 'dsh-auth-4100=ok',
  })
  assert.equal(loopback.origin, 'http://127.0.0.1:4100')
  assert.equal(loopback.referer, 'http://127.0.0.1:4100/chat?id=1')
  assert.equal(loopback['x-forwarded-for'], '203.0.113.9')
  assert.equal(loopback['cf-connecting-ip'], '203.0.113.9')

  const foreign = buildUpstreamHeaders({
    host: 'my.example.com',
    origin: 'https://evil.example',
  }, {
    publicAuthorities: ['my.example.com'],
    upstreamAuthority: '127.0.0.1:4100',
    upstreamOrigin: 'http://127.0.0.1:4100',
    isLoopbackPeer: true,
    remoteAddress: '127.0.0.1',
  })
  assert.equal(foreign.origin, 'https://evil.example', '外来 Origin 原样透传交由上游拒绝')

  const injected = injectReturnPillHtml('<html><body><p>hi</p></body></html>')
  assert.equal(injected, `<html><body><p>hi</p>${PILL_SCRIPT_TAG}</body></html>`)
  assert.equal(injectReturnPillHtml(injected), injected, '幂等不重复注入')
})

test('端到端：鉴权拦截、公开路由、多实例切换、dsh token 自动桥接、胶囊注入与无密钥泄漏', async () => {
  const dshA = await fakeDsh('A', 'tok-inst-A')
  const dshB = await fakeDsh('B', 'tok-inst-B')
  const instances = new Map([
    ['A', { key: 'A', port: dshA.port, url: dshA.url }],
    ['B', { key: 'B', port: dshB.port, url: dshB.url }],
  ])

  let pairCalls = 0
  let csrfAllow = true
  const validTokens = new Map([
    ['tok_dev1', { deviceId: 'dev_1', deviceName: 'iPhone' }],
    ['tok_dev2', { deviceId: 'dev_2', deviceName: 'iPad' }],
  ])
  const wsTickets = new Map([['ticket-dev1', { deviceId: 'dev_1', deviceName: 'iPhone' }]])

  const gw = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    authenticateRequest(req) {
      const authHeader = String(req.headers.authorization || '')
      if (authHeader.startsWith('Bearer ')) {
        const dev = validTokens.get(authHeader.slice(7).trim())
        return dev ? { ...dev, source: 'bearer' } : null
      }
      const cookie = String(req.headers.cookie || '')
      const m = cookie.match(/(?:^|;\s*)dsh-x-device=([^;]+)/)
      if (m) {
        const dev = validTokens.get(m[1])
        return dev ? { ...dev, source: 'cookie' } : null
      }
      return null
    },
    authenticateWs(_req, url) {
      const ticket = url.searchParams.get('ws_ticket')
      if (!ticket) return null
      const dev = wsTickets.get(ticket)
      if (!dev) return null
      wsTickets.delete(ticket)
      return { ...dev, source: 'ws_ticket' }
    },
    csrfCheck: () => csrfAllow,
    checkPairRateLimit: () => (++pairCalls <= 1 ? { allowed: true } : { allowed: false, retryAfterMs: 3000 }),
    handleControlRequest(req, res, ctx) {
      if (ctx.pathname === '/_dshx/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, custom: true }))
        return true
      }
      if (ctx.pathname === '/_dshx/m/' || ctx.pathname === '/_dshx/m/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>mobile shell</body></html>')
        return true
      }
      if (ctx.pathname === '/_dshx/api/pair/complete') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ip: ctx.clientIP }))
        return true
      }
      if (ctx.pathname === '/_dshx/api/me') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          device: ctx.auth.deviceId,
          activeInstanceKey: ctx.activeInstanceKey,
        }))
        return true
      }
      return false
    },
    resolveInstance: (key) => instances.get(key) || null,
    listRunningInstances: () => [...instances.values()],
  })

  try {
    // 1. 未鉴权拦截：HTML 导航 302 到 /_dshx/m/，API 与 WS 返回 401
    const unauthHtml = await httpCall(gw.port, { path: '/', headers: { accept: 'text/html' } })
    assert.equal(unauthHtml.status, 302)
    assert.equal(unauthHtml.headers.location, '/_dshx/m/')

    const unauthOpen = await httpCall(gw.port, { path: '/_dshx/open/A', headers: { accept: 'text/html' } })
    assert.equal(unauthOpen.status, 302)
    assert.equal(unauthOpen.headers.location, '/_dshx/m/')

    assert.equal((await httpCall(gw.port, { path: '/api/ping' })).status, 401)
    assert.equal((await httpCall(gw.port, { path: '/_dshx/api/me' })).status, 401)

    const unauthWs = await openWs(gw.port, { path: '/api/remote.mux' })
    assert.equal(unauthWs.status, 401)
    unauthWs.socket.destroy()

    // 2. 公开控制面路由：health（含 CORS + OPTIONS）、mobile PWA、pair/complete（含限流）
    const health = await httpCall(gw.port, { path: '/_dshx/api/health' })
    assert.equal(health.status, 200)
    assert.equal(health.headers['access-control-allow-origin'], '*')
    assert.deepEqual(JSON.parse(health.body), { ok: true, custom: true })

    const preflight = await httpCall(gw.port, { method: 'OPTIONS', path: '/_dshx/api/health' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], '*')

    const mobile = await httpCall(gw.port, { path: '/_dshx/m/' })
    assert.equal(mobile.status, 200)
    assert.match(mobile.body, /mobile shell/)

    const pairOk = await httpCall(gw.port, { method: 'POST', path: '/_dshx/api/pair/complete' })
    assert.equal(pairOk.status, 200)
    const pairLimited = await httpCall(gw.port, { method: 'POST', path: '/_dshx/api/pair/complete' })
    assert.equal(pairLimited.status, 429)
    assert.equal(pairLimited.headers['retry-after'], '3')

    // 控制面路由绝不泄漏到上游 dsh
    assert.equal(dshA.seen.length, 0)
    assert.equal(dshB.seen.length, 0)

    // 3. 2 个实例同时运行且未选实例 Cookie：GET / 重定向到 /_dshx/m/，API 返回 503
    const dev1Cookie = `${DEVICE_COOKIE_NAME}=tok_dev1`
    const noInstHtml = await httpCall(gw.port, { path: '/', headers: { cookie: dev1Cookie, accept: 'text/html' } })
    assert.equal(noInstHtml.status, 302)
    assert.equal(noInstHtml.headers.location, '/_dshx/m/')
    assert.equal((await httpCall(gw.port, { path: '/api/ping', headers: { cookie: dev1Cookie } })).status, 503)

    // 4. 打开实例 A：设置 dsh-x-instance Cookie + 自动桥接 token + 303 到 /
    const openA = await httpCall(gw.port, { path: '/_dshx/open/A', headers: { cookie: dev1Cookie } })
    assert.equal(openA.status, 303)
    assert.equal(openA.headers.location, '/')
    assert.match(String(openA.headers['set-cookie']), /^dsh-x-instance=A; Path=\/; HttpOnly; SameSite=Lax$/)

    const dev1OnA = `${dev1Cookie}; ${INSTANCE_COOKIE_NAME}=A`

    // /api/ping 路由到 A，且上游收不到 dsh-x-device / dsh-x-instance
    const pingA = await httpCall(gw.port, { path: '/api/ping', headers: { cookie: dev1OnA } })
    assert.equal(pingA.status, 200)
    assert.deepEqual(JSON.parse(pingA.body), { instance: 'A', port: dshA.port })
    const lastA = dshA.seen.at(-1)
    assert.equal(lastA.headers.host, `127.0.0.1:${dshA.port}`)
    assert.doesNotMatch(String(lastA.headers.cookie), /dsh-x-device|dsh-x-instance/)
    assert.match(String(lastA.headers.cookie), new RegExp(`dsh-auth-${dshA.port}=secret-A-1`))

    // HTML 页面注入返回胶囊脚本，content-length 精确匹配，且上游 dsh-auth-* Set-Cookie 被剥离（普通 Cookie 保留）
    const htmlA = await httpCall(gw.port, {
      path: '/?refresh=1',
      headers: { cookie: dev1OnA, accept: 'text/html', 'accept-encoding': 'gzip, br' },
    })
    assert.equal(htmlA.status, 200)
    assert.equal(dshA.seen.at(-1).headers['accept-encoding'], 'identity', 'HTML 请求应要求上游不压缩')
    assert.ok(htmlA.body.includes(`${PILL_SCRIPT_TAG}</body>`), 'HTML 应在 </body> 前注入悬浮胶囊脚本')
    assert.equal(Number(htmlA.headers['content-length']), Buffer.byteLength(htmlA.body, 'utf8'))
    const setCookies = [].concat(htmlA.headers['set-cookie'] || [])
    assert.ok(!setCookies.some((c) => c.includes('dsh-auth-')), 'dsh-auth-* 绝不能下发给手机浏览器')
    assert.ok(setCookies.some((c) => c.startsWith('ui-pref=compact')), '非 dsh-auth-* 普通 Cookie 应保留')

    // 若上游强制返回 gzip，网关跳过注入且不破坏压缩体
    const gzipRes = await httpCall(gw.port, {
      path: '/gzip.html',
      headers: { cookie: dev1OnA, accept: 'text/html' },
    })
    assert.equal(gzipRes.status, 200)
    assert.equal(gzipRes.headers['content-encoding'], 'gzip')
    assert.match(gunzipSync(gzipRes.buffer).toString('utf8'), /<h1>GZIP A<\/h1>/)

    // 5. 切换到实例 B：/_dshx/open/B -> /api/ping 返回 B 且不串 A 的 Cookie
    const openB = await httpCall(gw.port, { path: '/_dshx/open/B', headers: { cookie: dev1OnA } })
    assert.equal(openB.status, 303)
    assert.match(String(openB.headers['set-cookie']), /^dsh-x-instance=B;/)

    const dev1OnB = `${dev1Cookie}; ${INSTANCE_COOKIE_NAME}=B`
    const pingB = await httpCall(gw.port, { path: '/api/ping', headers: { cookie: dev1OnB } })
    assert.equal(pingB.status, 200)
    assert.deepEqual(JSON.parse(pingB.body), { instance: 'B', port: dshB.port })
    const lastB = dshB.seen.at(-1)
    assert.match(String(lastB.headers.cookie), new RegExp(`dsh-auth-${dshB.port}=secret-B-1`))
    assert.doesNotMatch(String(lastB.headers.cookie), new RegExp(`dsh-auth-${dshA.port}`), 'A 的 cookie 绝不能泄漏给 B')
    assert.doesNotMatch(String(lastB.headers.cookie), /dsh-x-device|dsh-x-instance/)

    // 6. 模拟本地 cloudflared（回环对端 + HTTPS 转发头）：保留 XFF/CF 头、HTTPS Origin 改写、Location 改回 https
    const tunnelOpen = await httpCall(gw.port, {
      path: '/_dshx/open/A',
      headers: {
        host: 'my.example.com',
        cookie: dev1Cookie,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.8',
        'cf-connecting-ip': '203.0.113.8',
      },
    })
    assert.equal(tunnelOpen.status, 303)
    assert.match(String(tunnelOpen.headers['set-cookie']), /; Secure$/, 'HTTPS 隧道入口应给实例 Cookie 加 Secure')

    const tunnelPing = await httpCall(gw.port, {
      path: '/api/ping',
      headers: {
        host: 'my.example.com',
        origin: 'https://my.example.com',
        referer: 'https://my.example.com/session/1',
        cookie: dev1OnA,
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.8',
        'cf-connecting-ip': '203.0.113.8',
      },
    })
    assert.equal(tunnelPing.status, 200)
    assert.equal(dshA.seen.at(-1).headers.origin, `http://127.0.0.1:${dshA.port}`)
    assert.equal(dshA.seen.at(-1).headers.referer, `http://127.0.0.1:${dshA.port}/session/1`)
    assert.equal(dshA.seen.at(-1).headers['x-forwarded-for'], '203.0.113.8')
    assert.equal(dshA.seen.at(-1).headers['cf-connecting-ip'], '203.0.113.8')

    const tunnelRedirect = await httpCall(gw.port, {
      path: '/redirect',
      headers: {
        host: 'my.example.com',
        cookie: dev1OnA,
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(tunnelRedirect.status, 302)
    assert.equal(tunnelRedirect.headers.location, 'https://my.example.com/after')

    // 外来 Origin 不改写，交给上游 dsh 拒绝（403）
    const foreignOrigin = await httpCall(gw.port, {
      path: '/api/ping',
      headers: {
        host: 'my.example.com',
        origin: 'https://evil.example',
        cookie: dev1OnA,
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(foreignOrigin.status, 403)

    // 7. Cookie 写请求 CSRF 拦截 & Bearer 令牌不泄漏给上游
    csrfAllow = false
    const csrfBlocked = await httpCall(gw.port, {
      method: 'POST',
      path: '/api/action',
      headers: { cookie: dev1OnA },
      body: 'payload',
    })
    assert.equal(csrfBlocked.status, 403)

    // Bearer 鉴权不受 Cookie CSRF 限制，且 Authorization 不得泄漏给上游 dsh
    const bearerPost = await httpCall(gw.port, {
      method: 'POST',
      path: '/api/action',
      headers: {
        authorization: 'Bearer tok_dev1',
        cookie: `${INSTANCE_COOKIE_NAME}=A`,
      },
      body: 'hello-bearer',
    })
    assert.equal(bearerPost.status, 200)
    assert.deepEqual(JSON.parse(bearerPost.body), { instance: 'A', body: 'hello-bearer' })
    assert.equal(dshA.seen.at(-1).headers.authorization, undefined, 'Bearer 设备令牌绝不能透传给上游')
    csrfAllow = true

    // 8. 上游重启换密钥：401 自动重新桥接 + clearInstanceCookies 生效
    dshA.rotateAuth('tok-inst-A-v2', 'secret-A-2')
    instances.set('A', { key: 'A', port: dshA.port, url: dshA.url })
    const autoRecovered = await httpCall(gw.port, { path: '/api/ping', headers: { cookie: dev1OnA } })
    assert.equal(autoRecovered.status, 200, '上游 401 后应自动用新 launchToken 重桥接并重试成功')

    gw.clearInstanceCookies('A')
    const afterClear = await httpCall(gw.port, { path: '/api/ping', headers: { cookie: dev1OnA } })
    assert.equal(afterClear.status, 200, 'clearInstanceCookies 后下次请求自动重新桥接')

    // 9. WebSocket 升级、双向收发、ws_ticket 鉴权、以及 disconnectDevice 立即断连
    const ws1 = await openWs(gw.port, {
      path: '/api/remote.mux',
      headers: {
        Host: 'my.example.com',
        Origin: 'https://my.example.com',
        'X-Forwarded-Proto': 'https',
        Cookie: dev1OnA,
      },
    })
    assert.equal(ws1.status, 101)
    ws1.socket.write('ping-dev1')
    assert.equal(await readNextChunk(ws1.socket), 'A:ping-dev1')
    const wsSeenA = dshA.seen.at(-1)
    assert.equal(wsSeenA.upgrade, true)
    assert.doesNotMatch(String(wsSeenA.headers.cookie), /dsh-x-device|dsh-x-instance/)

    // 设备 2 经 Cookie 连到实例 B
    const dev2OnB = `${DEVICE_COOKIE_NAME}=tok_dev2; ${INSTANCE_COOKIE_NAME}=B`
    const ws2 = await openWs(gw.port, {
      path: '/api/remote.mux',
      headers: { Cookie: dev2OnB },
    })
    assert.equal(ws2.status, 101)
    ws2.socket.write('ping-dev2')
    assert.equal(await readNextChunk(ws2.socket), 'B:ping-dev2')

    // 使用一次性 ws_ticket 建立 WS 连接，并确认 ws_ticket 不会透传到上游 URL
    const wsTicketConn = await openWs(gw.port, {
      path: '/api/remote.mux?ws_ticket=ticket-dev1&mode=mux',
      headers: { Cookie: `${INSTANCE_COOKIE_NAME}=A` },
    })
    assert.equal(wsTicketConn.status, 101)
    assert.equal(dshA.seen.at(-1).url, '/api/remote.mux?mode=mux', 'ws_ticket 必须从发往上游的 URL 中剥离')

    // 过期/无效的 ws_ticket 必须直接 401（不得回退到 Cookie）
    const wsBadTicket = await openWs(gw.port, {
      path: '/api/remote.mux?ws_ticket=ticket-dev1',
      headers: { Cookie: dev1OnA },
    })
    assert.equal(wsBadTicket.status, 401)
    wsBadTicket.socket.destroy()

    // 吊销 dev_1：其所有活跃 WS 立刻断开，dev_2 的 WS 不受影响
    const closed1 = waitSocketClose(ws1.socket)
    const closedTicket = waitSocketClose(wsTicketConn.socket)
    gw.disconnectDevice('dev_1')
    assert.equal(await closed1, true, 'disconnectDevice 必须立即关闭 dev_1 的活跃 WS')
    assert.equal(await closedTicket, true, 'disconnectDevice 必须立即关闭 dev_1 的票据 WS')

    ws2.socket.write('still-alive')
    assert.equal(await readNextChunk(ws2.socket), 'B:still-alive', '吊销 dev_1 不应影响 dev_2 的 WS')

    const closed2 = waitSocketClose(ws2.socket)
    gw.disconnectAll()
    assert.equal(await closed2, true, 'disconnectAll 必须立即关闭全部活跃 WS')

    // 10. 仅剩 1 个运行中实例时，无 dsh-x-instance Cookie 自动回落到唯一实例
    instances.delete('B')
    const singleFallback = await httpCall(gw.port, {
      path: '/api/ping',
      headers: { cookie: dev1Cookie },
    })
    assert.equal(singleFallback.status, 200)
    assert.deepEqual(JSON.parse(singleFallback.body), { instance: 'A', port: dshA.port })
  } finally {
    await gw.close()
    await dshA.close()
    await dshB.close()
  }
})

test('injectReturnPill=false 时不对 HTML 注入胶囊脚本', async () => {
  const dshA = await fakeDsh('A', 'tok-nopill')
  const gw = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    injectReturnPill: false,
    authenticateRequest: () => ({ deviceId: 'dev_1', source: 'cookie' }),
    resolveInstance: () => ({ key: 'A', port: dshA.port, url: dshA.url }),
    listRunningInstances: () => [{ key: 'A', port: dshA.port, url: dshA.url }],
  })
  try {
    const res = await httpCall(gw.port, {
      path: '/',
      headers: { accept: 'text/html' },
    })
    assert.equal(res.status, 200)
    assert.ok(!res.body.includes('/_dshx/m/pill.js'))
    assert.match(res.body, /<h1>DSH A<\/h1>/)
  } finally {
    await gw.close()
    await dshA.close()
  }
})

test('实例键含特殊字符（版本@profile）编码与过期实例 Cookie 清理', async () => {
  const dsh = await fakeDsh('ver-prof', 'tok-vp')
  const key = '0.2.2-rc.5@web'
  const instances = new Map([[key, { key, port: dsh.port, url: dsh.url }]])
  const gw = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    authenticateRequest: () => ({ deviceId: 'dev_1', source: 'cookie' }),
    resolveInstance: (k) => instances.get(k) || null,
    listRunningInstances: () => [...instances.values()],
  })
  try {
    const opened = await httpCall(gw.port, { path: `/_dshx/open/${encodeURIComponent(key)}` })
    assert.equal(opened.status, 303)
    const setCookie = String(opened.headers['set-cookie'])
    assert.equal(setCookie, `dsh-x-instance=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax`)

    const ping = await httpCall(gw.port, {
      path: '/api/ping',
      headers: { cookie: `dsh-x-instance=${encodeURIComponent(key)}` },
    })
    assert.equal(ping.status, 200)
    assert.deepEqual(JSON.parse(ping.body), { instance: 'ver-prof', port: dsh.port })

    // 实例停止后，旧的 dsh-x-instance Cookie 访问页面应清理 Cookie 并 302 回 /_dshx/m/
    instances.clear()
    const stale = await httpCall(gw.port, {
      path: '/',
      headers: { cookie: `dsh-x-instance=${encodeURIComponent(key)}`, accept: 'text/html' },
    })
    assert.equal(stale.status, 302)
    assert.equal(stale.headers.location, '/_dshx/m/')
    assert.match(String(stale.headers['set-cookie']), /^dsh-x-instance=; Max-Age=0;/)
  } finally {
    await gw.close()
    await dsh.close()
  }
})

const LAN = pickLanAddress()

test('非回环（局域网）真实连接：剥离客户端伪造的 X-Forwarded-For / CF-Connecting-IP', { skip: !LAN && '这台机器没有局域网 IPv4' }, async () => {
  const dshA = await fakeDsh('A', 'tok-lan')
  const gw = await startRemoteGateway({
    host: LAN,
    port: 0,
    authenticateRequest: () => ({ deviceId: 'dev_lan', source: 'cookie' }),
    resolveInstance: () => ({ key: 'A', port: dshA.port, url: dshA.url }),
    listRunningInstances: () => [{ key: 'A', port: dshA.port, url: dshA.url }],
  })
  try {
    const res = await httpCall(gw.port, {
      host: LAN,
      path: '/api/ping',
      headers: {
        'x-forwarded-for': '127.0.0.1',
        'cf-connecting-ip': '127.0.0.1',
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(res.status, 200)
    const seen = dshA.seen.at(-1).headers
    assert.equal(seen['x-forwarded-for'], LAN, '伪造的 127.0.0.1 必须被真实局域网 IP 替换')
    assert.equal(seen['cf-connecting-ip'], undefined, '非回环连接自带的 CF-Connecting-IP 必须被剥离')
    assert.equal(seen['x-forwarded-proto'], undefined, '非回环连接自带的 X-Forwarded-Proto 必须被剥离')
  } finally {
    await gw.close()
    await dshA.close()
  }
})
