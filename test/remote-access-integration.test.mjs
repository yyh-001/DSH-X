import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isolateUserHome } from './isolated-home.mjs'

// 必须在导入 settings.js / server.js 前隔离用户目录，避免 APP_DIR 绑定到真实 %APPDATA%\DSH
const SUITE_ROOT = mkdtempSync(join(tmpdir(), 'dshx-remote-suite-'))
const SUITE_APP = isolateUserHome(SUITE_ROOT)
const SUITE_HOME = join(SUITE_ROOT, 'home')
const SUITE_DATA = join(SUITE_ROOT, 'data')
mkdirSync(SUITE_APP, { recursive: true })
mkdirSync(join(SUITE_HOME, 'profiles', 'web'), { recursive: true })
writeFileSync(join(SUITE_HOME, 'profiles', 'web', 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
writeFileSync(join(SUITE_APP, 'settings.json'), JSON.stringify({ dataDir: SUITE_DATA, dshHome: SUITE_HOME, profile: 'web', seedMarket: false }))
process.env.DSH_VERSIONS_DATA = SUITE_DATA
process.env.DSH_AGENTS_HOME = join(SUITE_ROOT, 'agents')

const { createRemoteAccessController } = await import('../src/remote-access.js')
const { safeRemoteAccess } = await import('../src/settings.js')

test.after(() => {
  try { rmSync(SUITE_ROOT, { recursive: true, force: true }) } catch { /* 忽略清理竞态 */ }
})

const PUBLIC_DIR = fileURLToPath(new URL('../src/public', import.meta.url))
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 启动一台模拟 dsh 实例的本地回环服务器：
 * - 校验 `GET /?token=<launchToken>` 并下发 `Set-Cookie: dsh-auth-<id>=<val>; HttpOnly`；
 * - 校验后续 HTTP / WS 请求必须携带该实例专属 `dsh-auth-<id>` Cookie 且不泄漏网关 `dsh-x-*` Cookie；
 * - 支持 `/api/ping`、HTML 首页 `/` 与 `/api/remote.mux` WebSocket 升级回显。
 */
function startFakeDshInstance({ id, launchToken }) {
  const cookieName = `dsh-auth-${id}`
  const cookieValue = `session-${id}-ok`
  const seenRequests = []
  const seenUpgrades = []
  const wsSockets = new Set()

  function hasValidCookie(cookieHeader) {
    return String(cookieHeader || '').split(';').some((part) => part.trim() === `${cookieName}=${cookieValue}`)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seenRequests.push({
      method: req.method,
      path: req.url,
      cookie: req.headers.cookie || '',
      authorization: req.headers.authorization || '',
      host: req.headers.host || '',
    })

    if (url.pathname === '/' && url.searchParams.get('token') === launchToken) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }

    if (!hasValidCookie(req.headers.cookie)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'dsh_unauthorized', instance: id }))
      return
    }

    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, instance: id, cookie: req.headers.cookie || '' }))
      return
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>DSH ${id}</title></head><body><main>Instance ${id}</main></body></html>`)
      return
    }

    res.writeHead(404).end('not found')
  })

  server.on('upgrade', (req, socket) => {
    seenUpgrades.push({
      url: req.url,
      cookie: req.headers.cookie || '',
      host: req.headers.host || '',
    })
    if (!hasValidCookie(req.headers.cookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    wsSockets.add(socket)
    socket.once('close', () => wsSockets.delete(socket))
    socket.on('data', (chunk) => {
      if (!socket.destroyed) socket.write(chunk)
    })
    socket.on('error', () => {})
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const { port } = server.address()
      resolve({
        id,
        port,
        launchToken,
        url: `http://127.0.0.1:${port}/?token=${launchToken}`,
        seenRequests,
        seenUpgrades,
        close: () => new Promise((done) => {
          for (const s of wsSockets) s.destroy()
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    })
  })
}

function rawHttpRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
          buffer: buf,
        })
      })
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

function openRawWebSocket(port, { path = '/api/remote.mux', cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = Buffer.from('dshx-test-ws-key').toString('base64')
      let reqHead = `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
      if (cookie) reqHead += `Cookie: ${cookie}\r\n`
      reqHead += '\r\n'
      socket.write(reqHead)
    })

    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      socket.off('data', onData)
      const headText = buf.subarray(0, idx).toString('utf8')
      const rest = buf.subarray(idx + 4)
      const statusMatch = /^HTTP\/1\.1 (\d+)/.exec(headText)
      resolve({
        status: statusMatch ? Number(statusMatch[1]) : 0,
        headText,
        rest,
        socket,
      })
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

function extractCookiePair(setCookieHeader, name) {
  const list = [].concat(setCookieHeader || [])
  for (const raw of list) {
    const first = String(raw).split(';', 1)[0].trim()
    if (first.startsWith(`${name}=`)) return first
  }
  return ''
}

function createFakeSpawn({ emitQuickUrl = 'https://demo-dshx.trycloudflare.com', emitLocation = 'hkg05' } = {}) {
  const spawned = []
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter()
    child.pid = 42000 + spawned.length
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.kill = () => {
      if (child.exitCode === null) {
        child.exitCode = 0
        queueMicrotask(() => {
          child.emit('exit', 0, null)
          child.emit('close', 0, null)
        })
      }
      return true
    }
    spawned.push({ bin, args, env: opts?.env || {}, child })
    setTimeout(() => {
      if (child.exitCode !== null) return
      if (emitQuickUrl) {
        child.stderr.write(`INF |  ${emitQuickUrl}  |\n`)
      }
      child.stderr.write(`INF Registered tunnel connection connIndex=0 location=${emitLocation}\n`)
    }, 20)
    return child
  }
  return { spawnFn, spawned }
}

test('safeRemoteAccess：默认关闭、严格校验非法值并始终剥离 tunnel.token 防止明文落盘', () => {
  const def = safeRemoteAccess(undefined)
  assert.equal(def.enabled, false)
  assert.equal(def.gatewayPort, 0)
  assert.equal(def.bindLan, false)
  assert.equal(def.tunnel.mode, 'quick')
  assert.equal('token' in def.tunnel, false)

  const stripped = safeRemoteAccess({
    enabled: true,
    gatewayPort: 3890,
    bindLan: true,
    customPublicUrl: 'https://dsh.example.com/',
    tunnel: {
      enabled: true,
      mode: 'token',
      token: 'SHOULD_NEVER_PERSIST',
      publicUrl: 'https://tun.example.com/',
      edgeIPVersion: '4',
      protocol: 'http2',
    },
  }, { strict: true })
  assert.equal(stripped.gatewayPort, 3890)
  assert.equal(stripped.customPublicUrl, 'https://dsh.example.com')
  assert.equal(stripped.tunnel.publicUrl, 'https://tun.example.com')
  assert.equal('token' in stripped.tunnel, false)

  assert.throws(() => safeRemoteAccess({ gatewayPort: 70000 }, { strict: true }))
  assert.throws(() => safeRemoteAccess({ customPublicUrl: 'ftp://bad.example.com' }, { strict: true }))
  assert.throws(() => safeRemoteAccess({ tunnel: { mode: 'bogus' } }, { strict: true }))
})

test('端到端离线集成：配对扫码 → 多实例切换与认证桥接 → 胶囊注入 → WS 短票据 → 吊销即断 → 静态壳与隧道托管', async () => {
  const appDir = mkdtempSync(join(tmpdir(), 'dshx-remote-int-'))
  const dshA = await startFakeDshInstance({ id: 'a', launchToken: 'tok-instance-a' })
  const dshB = await startFakeDshInstance({ id: 'b', launchToken: 'tok-instance-b' })

  let settingsState = { remoteAccess: safeRemoteAccess({ enabled: true, bindLan: false }) }
  const startCalls = []
  const stopCalls = []
  const { spawnFn, spawned } = createFakeSpawn()

  const fakeInstances = () => [
    {
      key: '0.2.2@web',
      version: '0.2.2',
      profile: 'web',
      name: 'DSH A',
      status: 'running',
      ready: true,
      port: dshA.port,
      url: dshA.url,
      startedAt: Date.now() - 5000,
      target: 'local',
    },
    {
      key: '0.2.2@work',
      version: '0.2.2',
      profile: 'work',
      name: 'DSH B',
      status: 'running',
      ready: true,
      port: dshB.port,
      url: dshB.url,
      startedAt: Date.now() - 2000,
      target: { type: 'wsl', label: 'Ubuntu' },
    },
  ]

  const fakeLaunches = () => [
    { id: '0000000000000000', name: 'DSH A', version: '0.2.2', profile: 'web', target: 'local', runningKey: '0.2.2@web' },
    { id: '1111111111111111', name: 'DSH Idle', version: '0.2.2', profile: 'idle', target: 'local', runningKey: '' },
  ]

  const ctrl = createRemoteAccessController({
    appDir,
    publicDir: PUBLIC_DIR,
    getSettings: () => settingsState,
    updateSettings: async (next) => { settingsState = { ...settingsState, remoteAccess: next } },
    getHostInfo: () => ({ hostName: 'Dev-Box', version: '0.9.9-test' }),
    getInstances: fakeInstances,
    getLaunches: fakeLaunches,
    startLaunch: async (params) => { startCalls.push(params); return { started: true } },
    stopInstance: async (params) => { stopCalls.push(params) },
    getLogs: ({ key, limit }) => [`[${key}] boot ok`, `[${key}] ready`].slice(-limit),
    pickLanAddressFn: () => '',
    probeEdgeFn: async () => ({ v4RttMs: 42, v6RttMs: 118, polluted: [], chosen: '4', fakeIPDetected: false }),
    tunnelOptions: {
      spawnFn,
      ensureBinaryFn: async () => '/fake/cloudflared',
      probeFn: async () => ({ v4RttMs: 42, v6RttMs: 118, polluted: [], chosen: '4', fakeIPDetected: false }),
    },
  })

  try {
    // 1. 启动控制器，确认网关监听就绪
    const started = await ctrl.start()
    assert.equal(started.gateway.running, true)
    assert.ok(started.gateway.port > 0)
    const gwPort = started.gateway.port

    // 2. 公开健康检查（带 CORS 测速头）与手机 PWA 静态壳（含 icon.png 与 sw.js 作用域头）
    const healthRes = await rawHttpRequest(gwPort, { path: '/_dshx/api/health' })
    assert.equal(healthRes.status, 200)
    assert.equal(healthRes.headers['access-control-allow-origin'], '*')
    const healthJson = JSON.parse(healthRes.body)
    assert.equal(healthJson.ok, true)
    assert.equal(healthJson.hostName, 'Dev-Box')
    assert.equal(healthJson.version, '0.9.9-test')

    const mRedirect = await rawHttpRequest(gwPort, { path: '/_dshx/m?pair=abc' })
    assert.equal(mRedirect.status, 302)
    assert.equal(mRedirect.headers.location, '/_dshx/m/?pair=abc')

    const mIndex = await rawHttpRequest(gwPort, { path: '/_dshx/m/' })
    assert.equal(mIndex.status, 200)
    assert.match(mIndex.headers['content-type'], /text\/html/i)

    const mIcon = await rawHttpRequest(gwPort, { path: '/_dshx/m/icon.png' })
    assert.equal(mIcon.status, 200)
    assert.equal(mIcon.headers['content-type'], 'image/png')
    assert.ok(mIcon.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'icon.png 应为有效 PNG')

    const mSw = await rawHttpRequest(gwPort, { path: '/_dshx/m/sw.js' })
    assert.equal(mSw.status, 200)
    assert.equal(mSw.headers['service-worker-allowed'], '/')

    // 路径穿越必须被拦截
    const traversal = await rawHttpRequest(gwPort, { path: '/_dshx/m/..%2F..%2Fserver.js' })
    assert.ok(traversal.status === 403 || traversal.status === 404)

    // 未配对请求控制面 API 返回 401
    const unauthInst = await rawHttpRequest(gwPort, { path: '/_dshx/api/instances' })
    assert.equal(unauthInst.status, 401)

    // 3. 生成配对会话并校验 QR SVG 与 `?pair=` 载荷与 mobile/app.js 完全兼容
    const pairing = ctrl.createPairing()
    assert.ok(pairing.code.length >= 32)
    assert.ok(pairing.expiresAt > Date.now())
    assert.match(pairing.svg, /^<svg\b[\s\S]*<\/svg>$/)
    const parsedUrl = new URL(pairing.url)
    assert.equal(parsedUrl.pathname, '/_dshx/m/')
    const pairParam = parsedUrl.searchParams.get('pair')
    assert.ok(pairParam)
    const decodedPair = JSON.parse(Buffer.from(pairParam, 'base64url').toString('utf8'))
    assert.equal(decodedPair.code, pairing.code)
    assert.equal(decodedPair.hostName, 'Dev-Box')
    assert.ok(decodedPair.hostId)

    // 4. 完成配对，获取 HttpOnly 设备 Cookie，并验证一次性码防重放
    const pairRes = await rawHttpRequest(gwPort, {
      method: 'POST',
      path: '/_dshx/api/pair/complete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairing.code,
        deviceName: 'iPhone 16 Pro',
        platform: 'ios',
        deviceKey: 'devkey_0123456789abcdef01234567',
      }),
    })
    assert.equal(pairRes.status, 200)
    const pairData = JSON.parse(pairRes.body)
    assert.equal(pairData.ok, true)
    assert.equal(pairData.device.deviceName, 'iPhone 16 Pro')
    assert.ok(pairData.token)
    assert.equal(pairData.host.hostName, 'Dev-Box')

    const deviceCookie = extractCookiePair(pairRes.headers['set-cookie'], 'dsh-x-device')
    assert.ok(deviceCookie.startsWith('dsh-x-device=tok_'))
    assert.match(String(pairRes.headers['set-cookie']), /HttpOnly/i)

    // 重放同一个配对码必须被拒绝
    const replayRes = await rawHttpRequest(gwPort, {
      method: 'POST',
      path: '/_dshx/api/pair/complete',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, deviceName: 'Evil' }),
    })
    assert.equal(replayRes.status, 401)

    // 5. 校验已鉴权控制面接口（me / instances / logs / start / stop / devices）
    const meRes = await rawHttpRequest(gwPort, { path: '/_dshx/api/me', headers: { cookie: deviceCookie } })
    assert.equal(meRes.status, 200)
    assert.equal(JSON.parse(meRes.body).device.deviceId, pairData.device.deviceId)

    const instRes = await rawHttpRequest(gwPort, { path: '/_dshx/api/instances', headers: { cookie: deviceCookie } })
    assert.equal(instRes.status, 200)
    const instData = JSON.parse(instRes.body)
    assert.equal(instData.instances.length, 2)
    assert.equal(instData.launches.length, 2)
    // 绝不把 dsh launchToken 或带 token 的原地址泄漏给手机前端
    assert.equal(instRes.body.includes('tok-instance-a'), false)
    assert.equal(instRes.body.includes('tok-instance-b'), false)

    const logsRes = await rawHttpRequest(gwPort, {
      path: `/_dshx/api/logs?key=${encodeURIComponent('0.2.2@web')}&limit=10`,
      headers: { cookie: deviceCookie },
    })
    assert.equal(logsRes.status, 200)
    assert.deepEqual(JSON.parse(logsRes.body).lines, ['[0.2.2@web] boot ok', '[0.2.2@web] ready'])

    const startRes = await rawHttpRequest(gwPort, {
      method: 'POST',
      path: '/_dshx/api/instances/start',
      headers: {
        cookie: deviceCookie,
        origin: `http://127.0.0.1:${gwPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ launchId: '1111111111111111' }),
    })
    assert.equal(startRes.status, 200)
    assert.equal(startCalls[0].launchId, '1111111111111111')

    const stopRes = await rawHttpRequest(gwPort, {
      method: 'POST',
      path: '/_dshx/api/instances/stop',
      headers: {
        cookie: deviceCookie,
        origin: `http://127.0.0.1:${gwPort}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: '0.2.2@work' }),
    })
    assert.equal(stopRes.status, 200)
    assert.equal(stopCalls[0].key, '0.2.2@work')

    // 6. 打开实例 A -> 代理 /api/ping 命中 A 且首页 HTML 自动注入 pill.js
    const openA = await rawHttpRequest(gwPort, {
      path: `/_dshx/open/${encodeURIComponent('0.2.2@web')}`,
      headers: { cookie: deviceCookie },
    })
    assert.equal(openA.status, 303)
    assert.equal(openA.headers.location, '/')
    const instACookie = extractCookiePair(openA.headers['set-cookie'], 'dsh-x-instance')
    assert.ok(instACookie.startsWith('dsh-x-instance='))

    const pingA = await rawHttpRequest(gwPort, {
      path: '/api/ping',
      headers: { cookie: `${deviceCookie}; ${instACookie}` },
    })
    assert.equal(pingA.status, 200)
    const pingAData = JSON.parse(pingA.body)
    assert.equal(pingAData.instance, 'a')
    // 网关必须剥离 dsh-x-* Cookie，只向上游发实例 A 自己的 dsh-auth-a
    assert.equal(pingAData.cookie.includes('dsh-x-device'), false)
    assert.equal(pingAData.cookie.includes('dsh-auth-a=session-a-ok'), true)

    const htmlA = await rawHttpRequest(gwPort, {
      path: '/',
      headers: {
        cookie: `${deviceCookie}; ${instACookie}`,
        accept: 'text/html',
      },
    })
    assert.equal(htmlA.status, 200)
    assert.ok(htmlA.body.includes('Instance a'))
    assert.ok(htmlA.body.includes('<script src="/_dshx/m/pill.js" defer></script></body>'))

    // 7. 切换到实例 B -> 代理 /api/ping 命中 B 且 Cookie 严格隔离
    const openB = await rawHttpRequest(gwPort, {
      path: `/_dshx/open/${encodeURIComponent('0.2.2@work')}`,
      headers: { cookie: deviceCookie },
    })
    assert.equal(openB.status, 303)
    const instBCookie = extractCookiePair(openB.headers['set-cookie'], 'dsh-x-instance')

    const pingB = await rawHttpRequest(gwPort, {
      path: '/api/ping',
      headers: { cookie: `${deviceCookie}; ${instBCookie}` },
    })
    assert.equal(pingB.status, 200)
    const pingBData = JSON.parse(pingB.body)
    assert.equal(pingBData.instance, 'b')
    assert.equal(pingBData.cookie.includes('dsh-auth-a'), false)
    assert.equal(pingBData.cookie.includes('dsh-auth-b=session-b-ok'), true)

    // 8. 签发一次性 WS 短票据并建立 /api/remote.mux 连接 -> 吊销设备后 WS 立刻断开且后续请求 401
    const ticketRes = await rawHttpRequest(gwPort, {
      method: 'POST',
      path: '/_dshx/api/ws-ticket',
      headers: {
        cookie: deviceCookie,
        origin: `http://127.0.0.1:${gwPort}`,
      },
    })
    assert.equal(ticketRes.status, 200)
    const { ticket } = JSON.parse(ticketRes.body)
    assert.ok(ticket && ticket.length === 40)

    const ws = await openRawWebSocket(gwPort, {
      path: `/api/remote.mux?ws_ticket=${ticket}`,
      cookie: instBCookie,
    })
    assert.equal(ws.status, 101)
    // 上游 dsh 不应收到 ws_ticket 参数
    assert.equal(dshB.seenUpgrades[0].url, '/api/remote.mux')

    // 验证双向数据通道正常
    const echoPromise = new Promise((resolve) => {
      if (ws.rest.length) { resolve(ws.rest.toString('utf8')); return }
      ws.socket.once('data', (chunk) => resolve(chunk.toString('utf8')))
    })
    ws.socket.write('hello-mux')
    assert.equal(await echoPromise, 'hello-mux')

    // 重命名设备 -> 再吊销设备，确认 WS 在极短时间内被网关主动断开
    const renamed = ctrl.renameDevice(pairData.device.deviceId, '我的主力手机')
    assert.equal(renamed.deviceName, '我的主力手机')

    const wsClosed = new Promise((resolve) => ws.socket.once('close', () => resolve(true)))
    ctrl.revokeDevice(pairData.device.deviceId)
    const closedResult = await Promise.race([
      wsClosed,
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
    assert.equal(closedResult, true, '吊销设备后活跃 WebSocket 应立即断开')

    const afterRevokeMe = await rawHttpRequest(gwPort, { path: '/_dshx/api/me', headers: { cookie: deviceCookie } })
    assert.equal(afterRevokeMe.status, 401)
    const afterRevokeProxy = await rawHttpRequest(gwPort, {
      path: '/api/ping',
      headers: { cookie: `${deviceCookie}; ${instBCookie}` },
    })
    assert.equal(afterRevokeProxy.status, 401)

    // 9. 验证隧道敏感 Token 加密隔离（不进 settings、不进状态响应）+ 边缘测速 + 启停隧道
    const tokenStatus = await ctrl.applyConfig({
      tunnel: {
        mode: 'token',
        token: 'eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0=',
        publicUrl: 'https://my-dsh.example.com',
      },
    })
    assert.equal(tokenStatus.config.tunnel.hasToken, true)
    assert.equal(JSON.stringify(tokenStatus).includes('eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0='), false)
    assert.equal(JSON.stringify(settingsState).includes('eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0='), false)
    const tokenFilePath = join(appDir, 'cf-tunnel-token.json')
    assert.equal(existsSync(tokenFilePath), true)
    assert.equal(readFileSync(tokenFilePath, 'utf8').includes('eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0='), false, '落盘文件须加密而非明文')

    const probeRes = await ctrl.probeEdge()
    assert.equal(probeRes.ok, true)
    assert.equal(probeRes.edgeProbe.chosen, '4')

    const startTun = await ctrl.startTunnel()
    assert.equal(startTun.ok, true)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].env.TUNNEL_TOKEN, 'eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0=')
    assert.equal(spawned[0].args.includes('eyJhIjoiU0VDUkVUX1RPS0VOXzEyMzQ1In0='), false)

    // 等假 cloudflared 输出注册日志
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(ctrl.getStatus().tunnel.state, 'running')
    assert.deepEqual(ctrl.getStatus().tunnel.locations, ['hkg05'])

    await ctrl.stopTunnel()
    assert.equal(ctrl.getStatus().tunnel.state, 'stopped')

    const cleared = await ctrl.applyConfig({ tunnel: { clearToken: true } })
    assert.equal(cleared.config.tunnel.hasToken, false)
  } finally {
    await ctrl.stop()
    await dshA.close()
    await dshB.close()
    rmSync(appDir, { recursive: true, force: true })
  }
})

test('桌面管理页 /api/remote-access/* 路由端到端：默认关闭、CSRF 防护、配置与设备全生命周期、停服清理', async (t) => {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  process.env.PORT = String(port)

  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
  })

  // 1. 默认状态：远程访问关闭，不监听网关端口
  const initialRes = await fetch(`${base}/api/remote-access/status`)
  assert.equal(initialRes.status, 200)
  const initial = await initialRes.json()
  assert.equal(initial.config.enabled, false)
  assert.equal(initial.gateway.running, false)
  assert.equal(initial.config.tunnel.hasToken, false)

  // 2. 跨站写请求必须被 sameSiteRequest 拦截返回 403
  const csrfRes = await fetch(`${base}/api/remote-access/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(csrfRes.status, 403)

  // 3. 启用远程网关并保存敏感 Tunnel Token（验证不进 settings.json 明文）
  const secretToken = 'eyJ0ZXN0Ijoic2VydmVyX3NlY3JldF90b2tlbiJ9'
  const cfgRes = await fetch(`${base}/api/remote-access/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({
      enabled: true,
      bindLan: false,
      customPublicUrl: 'https://dsh.example.com/',
      tunnel: { mode: 'token', token: secretToken, publicUrl: 'https://cf.example.com/' },
    }),
  })
  assert.equal(cfgRes.status, 200)
  const cfgData = await cfgRes.json()
  assert.equal(cfgData.config.enabled, true)
  assert.equal(cfgData.gateway.running, true)
  assert.ok(cfgData.gateway.port > 0)
  assert.equal(cfgData.config.tunnel.hasToken, true)
  assert.equal(JSON.stringify(cfgData).includes(secretToken), false)
  assert.equal(readFileSync(join(SUITE_APP, 'settings.json'), 'utf8').includes(secretToken), false)

  // 4. 生成配对二维码 -> 向真实启动的远程网关完成配对
  const pairCreateRes = await fetch(`${base}/api/remote-access/pair`, {
    method: 'POST',
    headers: { origin: base },
  })
  assert.equal(pairCreateRes.status, 200)
  const { pairing } = await pairCreateRes.json()
  assert.ok(pairing.code && pairing.svg.startsWith('<svg'))

  const mobilePairRes = await fetch(`${cfgData.gateway.localUrl}/_dshx/api/pair/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, deviceName: 'Pixel 9', platform: 'android' }),
  })
  assert.equal(mobilePairRes.status, 200)
  const mobilePaired = await mobilePairRes.json()
  const devId = mobilePaired.device.deviceId

  // 5. 桌面端查询、重命名、单设备吊销与全量吊销
  const listRes = await (await fetch(`${base}/api/remote-access/devices`)).json()
  assert.equal(listRes.devices.length, 1)
  assert.equal(listRes.devices[0].deviceId, devId)

  const patchRes = await fetch(`${base}/api/remote-access/devices/${encodeURIComponent(devId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ deviceName: '工作手机' }),
  })
  assert.equal(patchRes.status, 200)
  assert.equal((await patchRes.json()).device.deviceName, '工作手机')

  const delOneRes = await fetch(`${base}/api/remote-access/devices/${encodeURIComponent(devId)}`, {
    method: 'DELETE',
    headers: { origin: base },
  })
  assert.equal(delOneRes.status, 200)

  const delAllRes = await fetch(`${base}/api/remote-access/devices`, {
    method: 'DELETE',
    headers: { origin: base },
  })
  assert.equal(delAllRes.status, 200)
  assert.equal((await delAllRes.json()).removed, 0)
})
