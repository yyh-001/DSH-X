import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import {
  LOGIN_BOUNCE_HTML,
  isTokenExchange,
  isTrustedHost,
  lanUrlOf,
  pickLanAddress,
  proxyAddresses,
  startLanProxy,
  upstreamHeaders,
} from '../src/lan-proxy.js'

const TOKEN = 'secret-token'
const iface = (address, extra = {}) => ({ family: 'IPv4', internal: false, address, ...extra })

test('局域网地址：跳过回环、VPN / 隧道、虚拟网卡和路由不到的段，取第一个', () => {
  assert.equal(pickLanAddress({
    lo0: [iface('127.0.0.1', { internal: true })],
    utun4: [iface('10.8.0.2')],
    tailscale0: [iface('100.100.1.1')],
    docker0: [iface('172.17.0.1')],
    en5: [iface('198.18.0.1'), iface('169.254.3.3'), { family: 'IPv6', internal: false, address: 'fe80::1' }],
    en0: [iface('192.168.31.76')],
    en1: [iface('10.0.0.9')],
  }), '192.168.31.76')
  assert.equal(pickLanAddress({ lo0: [iface('127.0.0.1', { internal: true })], utun0: [iface('10.8.0.2')] }), '', '没有可用地址时返回空串')
  assert.equal(pickLanAddress({ bridge0: [iface('192.168.2.1')] }), '192.168.2.1', 'bridge0 是真桥接，不排除')
})

test('局域网链接：只换主机，端口、路径和 token 原样保留', () => {
  assert.equal(lanUrlOf('http://127.0.0.1:3080/?token=abc', '192.168.31.76'), 'http://192.168.31.76:3080/?token=abc')
  assert.equal(lanUrlOf('http://127.0.0.1:41234/sub/?token=a%2Bb&x=1', '10.0.0.9'), 'http://10.0.0.9:41234/sub/?token=a%2Bb&x=1')
  assert.equal(lanUrlOf('http://127.0.0.1:3080/?token=abc', ''), '', '没有局域网地址')
  assert.equal(lanUrlOf('not a url', '10.0.0.9'), '')
  assert.equal(lanUrlOf('', '10.0.0.9'), '')
})

test('Host 判定：只认代理自己的局域网 authority', () => {
  const addresses = proxyAddresses('192.168.31.76', 3080)
  assert.equal(isTrustedHost('192.168.31.76:3080', addresses), true)
  for (const host of ['evil.example:3080', '127.0.0.1:3080', '192.168.31.76', '192.168.31.76:3081', undefined]) {
    assert.equal(isTrustedHost(host, addresses), false, String(host))
  }
})

test('请求头改写：同源 Origin / Referer 换回环，外来 Origin 原样转发，转发头不能伪造', () => {
  const addresses = proxyAddresses('192.168.31.76', 3080)
  const same = upstreamHeaders({
    host: '192.168.31.76:3080',
    origin: 'http://192.168.31.76:3080',
    referer: 'http://192.168.31.76:3080/s/1',
    'x-forwarded-for': '127.0.0.1',
    'cf-connecting-ip': '127.0.0.1',
  }, addresses, '192.168.31.20')
  assert.equal(same.host, '127.0.0.1:3080')
  assert.equal(same.origin, 'http://127.0.0.1:3080')
  assert.equal(same.referer, 'http://127.0.0.1:3080/s/1')
  assert.equal(same['x-forwarded-for'], '192.168.31.20', '客户端自带的值被真实地址替换')
  assert.equal(same['cf-connecting-ip'], undefined)
  const foreign = upstreamHeaders({ host: '192.168.31.76:3080', origin: 'http://evil.example', referer: 'http://192.168.31.76:30800/x' }, addresses, '')
  assert.equal(foreign.origin, 'http://evil.example')
  assert.equal(foreign.referer, 'http://192.168.31.76:30800/x', '只认完整 origin 前缀，端口相近的不换')
})

test('token 交换：带 ?token= + 303 + dsh-auth-* cookie 才算', () => {
  const cookie = ['dsh-auth-x=1; HttpOnly; SameSite=Strict']
  assert.equal(isTokenExchange('/?token=a', 303, cookie), true)
  assert.equal(isTokenExchange('/?token=a', 303, undefined), false, '已登录的 303 不带 cookie')
  assert.equal(isTokenExchange('/', 303, cookie), false)
  assert.equal(isTokenExchange('/?token=a', 401, cookie), false)
  assert.equal(isTokenExchange('/?token=a', 303, ['other=1']), false)
})

/** 假 dsh：只认回环 Host / 同源 Origin，token 换 cookie（303），带 cookie 才 200；支持 WebSocket 升级。 */
async function fakeDsh() {
  const seen = []
  const trusted = (req) => /^127\.0\.0\.1:\d+$/.test(req.headers.host || '')
    && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers })
    if (!trusted(req)) return res.writeHead(403).end()
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('token') === TOKEN) {
      return res.writeHead(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': 'dsh-auth-test=ok; HttpOnly; SameSite=Strict' }).end()
    }
    if (url.pathname === '/redirect') return res.writeHead(302, { location: `http://${req.headers.host}/next` }).end()
    if ((req.headers.cookie || '').includes('dsh-auth-test=ok')) return res.writeHead(200).end('app')
    res.writeHead(401).end()
  })
  // 升级后的 socket 不在 closeAllConnections 的表里，收尾要自己断
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    seen.push({ ...req.headers })
    if (!trusted(req) || !(req.headers.cookie || '').includes('dsh-auth-test=ok')) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = () => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
    for (const socket of upgraded) socket.destroy()
  })
  return { server, port: server.address().port, seen, close }
}

/**
 * 经代理发一个请求。代理和假 dsh 用同一个端口号，分别监听本机局域网 IP 和 127.0.0.1——
 * 和真实部署同一个形状；没有局域网 IPv4 的机器（部分 CI）跳过端到端用例。
 */
function request(port, host, { path = '/', headers = {}, lanHost }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: lanHost, port, path, headers: { host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const LAN = pickLanAddress()

test('端到端：401 / 换 token 落中转页 / cookie 登录 / 跨站与伪造 Host 403 / WebSocket 101', { skip: !LAN && '这台机器没有局域网 IPv4' }, async () => {
  const dsh = await fakeDsh()
  const proxy = await startLanProxy({ lanHost: LAN, port: dsh.port })
  const authority = `${LAN}:${dsh.port}`
  const call = (options = {}) => request(dsh.port, options.host ?? authority, { lanHost: LAN, ...options })
  try {
    assert.equal((await call()).status, 401, '不带凭据')
    const exchange = await call({ path: `/?token=${TOKEN}` })
    assert.equal(exchange.status, 200, '303 换成中转页')
    assert.equal(exchange.headers.location, undefined)
    assert.match(String(exchange.headers['set-cookie']), /^dsh-auth-test=ok; HttpOnly; SameSite=Strict/)
    assert.equal(exchange.headers['cache-control'], 'no-store')
    assert.equal(exchange.headers['referrer-policy'], 'no-referrer')
    assert.equal(exchange.body, LOGIN_BOUNCE_HTML)
    const cookie = 'dsh-auth-test=ok'
    assert.equal((await call({ headers: { cookie } })).status, 200, '带 cookie')
    assert.equal(dsh.seen.at(-1).host, `127.0.0.1:${dsh.port}`, '上游看到的是回环 Host')
    assert.equal(dsh.seen.at(-1)['x-forwarded-for'], LAN, '带上真实客户端地址')
    assert.equal((await call({ headers: { cookie, origin: `http://${authority}` } })).status, 200, '同源 Origin 被改写后放行')
    assert.equal((await call({ headers: { cookie, origin: 'http://evil.example' } })).status, 403, '跨站 Origin 交给 dsh 拒绝')
    const before = dsh.seen.length
    assert.equal((await call({ host: `evil.example:${dsh.port}`, headers: { cookie } })).status, 403, '伪造 Host')
    assert.equal(dsh.seen.length, before, '伪造 Host 根本到不了上游')
    assert.equal((await call({ path: '/redirect', headers: { cookie } })).headers.location, `http://${authority}/next`, 'Location 改回局域网地址')

    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(dsh.port, LAN, () => {
        socket.write(`GET /api/remote.mux HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://${authority}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk
        if (data.includes('\r\n\r\n') && !data.includes('ping')) socket.write('ping')
        if (data.includes('ping')) { socket.destroy(); resolve(data) }
      })
      socket.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 101/)
    assert.match(reply, /ping$/, '升级后双向转发')
  } finally {
    await proxy.close()
    await dsh.close()
  }
})

test('端口被占：startLanProxy 以 EADDRINUSE 失败，不吞错误', { skip: !LAN && '这台机器没有局域网 IPv4' }, async () => {
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, LAN, resolve))
  const { port } = blocker.address()
  try {
    await assert.rejects(startLanProxy({ lanHost: LAN, port }), { code: 'EADDRINUSE' })
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('只收 IPv4 字面量（authority 写成 host:port，IPv6 会有歧义）', async () => {
  await assert.rejects(startLanProxy({ lanHost: '::1', port: 1 }), /IPv4/)
  await assert.rejects(startLanProxy({ lanHost: 'localhost', port: 1 }), /IPv4/)
})
