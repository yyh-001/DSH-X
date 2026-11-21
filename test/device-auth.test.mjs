/**
 * 设备鉴权、配对、WS 短票据、限流、CSRF/代理头与离线二维码生成单元测试。
 * 全部离线运行，时间源通过注入 `now` 确定性推进，不依赖真实 sleep。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEVICE_COOKIE_NAME,
  DeviceAuthStore,
  IpRateLimiter,
  PairingManager,
  WsTicketStore,
  buildClearDeviceCookie,
  buildDeviceCookie,
  cookieWriteCsrfOk,
  extractClientIP,
  extractDeviceToken,
  generateDeviceCredentials,
  isLoopbackAddress,
} from '../src/device-auth.js'
import { encodeQrMatrix, renderQrSvg } from '../src/qrcode.js'

function makeClock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms) { current += ms },
  }
}

function makeTempDir(prefix = 'dsh-device-auth-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ─── PairingManager ───

test('PairingManager：32 字节配对码、大小写无关、一次性消费与 5 分钟 TTL', () => {
  const clock = makeClock()
  const pm = new PairingManager({ now: clock.now })

  assert.equal(pm.latestSession(), null)
  const session = pm.generateSession()
  assert.match(session.code, /^[0-9a-f]{64}$/)
  assert.equal(session.expiresAt - session.createdAt, 300_000)
  assert.deepEqual(pm.latestSession(), session)

  // 错误码不消费原会话
  assert.equal(pm.validateAndConsume('deadbeef'), false)
  assert.equal(pm.validateAndConsume(''), false)
  assert.equal(pm.validateAndConsume(null), false)
  assert.deepEqual(pm.latestSession(), session)

  // 带空格和大写能通过，且立即消费
  assert.equal(pm.validateAndConsume(`  ${session.code.toUpperCase()}\n`), true)
  assert.equal(pm.validateAndConsume(session.code), false, '同一个配对码不能消费两次')
  assert.equal(pm.latestSession(), null)
})

test('PairingManager：TTL 过期与 cleanupExpired', () => {
  const clock = makeClock()
  const pm = new PairingManager({ now: clock.now })
  const s1 = pm.generateSession(10_000)
  clock.advance(5_000)
  const s2 = pm.generateSession(20_000)
  assert.equal(pm.latestSession().code, s2.code)

  clock.advance(5_000) // s1 刚好到期（10s），s2 还剩 15s
  assert.equal(pm.cleanupExpired(), 1)
  assert.equal(pm.validateAndConsume(s1.code), false)
  assert.equal(pm.latestSession().code, s2.code)

  clock.advance(15_000) // s2 到期
  assert.equal(pm.latestSession(), null)
  assert.equal(pm.validateAndConsume(s2.code), false)
})

// ─── DeviceAuthStore ───

test('DeviceAuthStore：持久化、加盐哈希（无明文）、重启恢复与权限', () => {
  const dir = makeTempDir()
  const clock = makeClock()
  try {
    const creds = generateDeviceCredentials()
    assert.match(creds.deviceId, /^dev_[0-9a-f]{12}$/)
    assert.match(creds.deviceToken, /^tok_[0-9a-f]{64}$/)

    const pm = new PairingManager({ now: clock.now })
    const session = pm.generateSession()
    const store = DeviceAuthStore.load(dir, { now: clock.now, pairingManager: pm })
    assert.equal(store.hasDevices(), false)

    // 无效配对码拒绝
    assert.equal(store.pairDevice({ code: 'invalid', deviceName: 'My Phone' }), null)

    const paired = store.pairDevice({
      code: session.code,
      deviceName: 'iPhone 16 Pro',
      platform: 'ios',
      deviceKey: 'key-iphone-1',
      remoteIP: '192.168.1.25',
    })
    assert.ok(paired)
    assert.match(paired.device.deviceId, /^dev_[0-9a-f]{12}$/)
    assert.match(paired.deviceToken, /^tok_[0-9a-f]{64}$/)
    assert.equal('tokenHash' in paired.device, false, '返回给业务层的设备对象不能暴露 tokenHash')
    assert.equal(store.hasDevices(), true)

    // 校验磁盘内容：盐文件独立、设备清单无明文 token、只存 s256:<hex>
    const saltRaw = readFileSync(join(dir, 'auth-salt'), 'utf8').trim()
    assert.match(saltRaw, /^[0-9a-f]{64}$/)
    const devicesRaw = readFileSync(join(dir, 'paired-devices.json'), 'utf8')
    assert.equal(devicesRaw.includes(paired.deviceToken), false, 'paired-devices.json 绝不能含明文 token')
    const parsed = JSON.parse(devicesRaw)
    assert.equal(parsed.devices.length, 1)
    assert.equal(parsed.devices[0].tokenHash, store.hashToken(paired.deviceToken))
    assert.match(parsed.devices[0].tokenHash, /^s256:[0-9a-f]{64}$/)

    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'auth-salt')).mode & 0o777, 0o600)
      assert.equal(statSync(join(dir, 'paired-devices.json')).mode & 0o777, 0o600)
    }

    // 重启后重新加载：同一份盐 + 同一份设备清单，原 token 仍然有效
    const reloaded = DeviceAuthStore.load(dir, { now: clock.now })
    const validated = reloaded.validateToken(paired.deviceToken)
    assert.ok(validated)
    assert.equal(validated.deviceId, paired.device.deviceId)
    assert.equal(validated.deviceName, 'iPhone 16 Pro')
    assert.equal('tokenHash' in validated, false)
    assert.equal(reloaded.validateToken(`${paired.deviceToken}x`), null)
    assert.equal(reloaded.validateToken(''), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeviceAuthStore：同 deviceKey 重配原地轮换凭证且触发旧设备吊销钩子', () => {
  const dir = makeTempDir()
  const clock = makeClock()
  const removed = []
  try {
    const store = new DeviceAuthStore(dir, {
      now: clock.now,
      onDeviceRemoved: (id) => removed.push(id),
    })
    const first = store.addDevice({ deviceName: 'Pixel', platform: 'android', deviceKey: 'pixel-key-1', remoteIP: '10.0.0.2' })
    clock.advance(5_000)
    // 空 deviceKey 的设备不应被误替换
    const anon1 = store.addDevice({ deviceName: 'Anon A', platform: 'web', deviceKey: '' })
    const anon2 = store.addDevice({ deviceName: 'Anon B', platform: 'web', deviceKey: '' })

    clock.advance(5_000)
    const second = store.addDevice({ deviceName: 'Pixel New', platform: 'android', deviceKey: 'pixel-key-1', remoteIP: '10.0.0.3' })

    assert.equal(second.replacedDeviceId, first.device.deviceId)
    assert.notEqual(second.device.deviceId, first.device.deviceId)
    assert.deepEqual(removed, [first.device.deviceId], '旧凭证被替换时应立即通知断开其活跃连接')
    assert.equal(store.validateToken(first.deviceToken), null, '旧 token 必须失效，不能留孤儿')
    assert.ok(store.validateToken(second.deviceToken))
    assert.equal(store.listDevices().length, 3)
    assert.equal(store.findByDeviceKey('pixel-key-1').deviceId, second.device.deviceId)
    assert.equal(store.findByDeviceKey(''), null)
    assert.ok(store.validateToken(anon1.deviceToken))
    assert.ok(store.validateToken(anon2.deviceToken))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeviceAuthStore：updateLastSeen 30s 内存防抖、60s 落盘节流与 IP 变更立即落盘', () => {
  const dir = makeTempDir()
  const clock = makeClock(1_000_000)
  try {
    const store = new DeviceAuthStore(dir, { now: clock.now })
    const { device } = store.addDevice({ deviceName: 'Phone', platform: 'ios', remoteIP: '192.168.1.10' })
    const readDisk = () => JSON.parse(readFileSync(join(dir, 'paired-devices.json'), 'utf8')).devices[0]

    assert.equal(readDisk().lastSeenAt, 1_000_000)

    // 10s 后同 IP：命中 30s 内存防抖，内存和磁盘都不更新
    clock.advance(10_000)
    assert.equal(store.updateLastSeen(device.deviceId, '192.168.1.10'), false)
    assert.equal(store.getDevice(device.deviceId).lastSeenAt, 1_000_000)
    assert.equal(readDisk().lastSeenAt, 1_000_000)

    // 35s 后同 IP：超过 30s 内存防抖，但未满 60s 落盘节流 → 内存更新、磁盘暂不写
    clock.advance(25_000) // t = 1_035_000
    assert.equal(store.updateLastSeen(device.deviceId, '192.168.1.10'), true)
    assert.equal(store.getDevice(device.deviceId).lastSeenAt, 1_035_000)
    assert.equal(readDisk().lastSeenAt, 1_000_000, '60s 节流期内不应提前落盘')

    // 65s 后同 IP：距上次内存更新 30s 且距上次落盘 65s → 内存与磁盘同时更新
    clock.advance(30_000) // t = 1_065_000
    assert.equal(store.updateLastSeen(device.deviceId, '192.168.1.10'), true)
    assert.equal(store.getDevice(device.deviceId).lastSeenAt, 1_065_000)
    assert.equal(readDisk().lastSeenAt, 1_065_000)

    // 5s 后 IP 切换（比如从 Wi-Fi 切到 5G）：绕过 30s 防抖和 60s 节流，立刻落盘
    clock.advance(5_000) // t = 1_070_000
    assert.equal(store.updateLastSeen(device.deviceId, '203.0.113.9'), true)
    assert.equal(store.getDevice(device.deviceId).lastSeenIP, '203.0.113.9')
    assert.equal(readDisk().lastSeenIP, '203.0.113.9')
    assert.equal(readDisk().lastSeenAt, 1_070_000)

    // 再次验证 flush() 能刷掉处于节流缓冲中的脏数据
    clock.advance(31_000) // t = 1_101_000
    assert.equal(store.updateLastSeen(device.deviceId, '203.0.113.9'), true)
    assert.equal(readDisk().lastSeenAt, 1_070_000)
    store.flush()
    assert.equal(readDisk().lastSeenAt, 1_101_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeviceAuthStore：重命名、单设备吊销、全部吊销、钩子异常隔离与坏文件容错', () => {
  const dir = makeTempDir()
  const removed = []
  let cleared = 0
  try {
    writeFileSync(join(dir, 'paired-devices.json'), '{broken json', 'utf8')
    const store = new DeviceAuthStore(dir, {
      onDeviceRemoved: (id) => { removed.push(id); throw new Error('hook boom') },
      onClearAll: () => { cleared++ },
    })
    assert.equal(store.hasDevices(), false)

    const a = store.addDevice({ deviceName: 'A', platform: 'ios' })
    const b = store.addDevice({ deviceName: 'B', platform: 'android' })

    assert.equal(store.renameDevice(a.device.deviceId, '   '), null)
    const renamed = store.renameDevice(a.device.deviceId, '卧室 iPad')
    assert.equal(renamed.deviceName, '卧室 iPad')
    assert.equal('tokenHash' in renamed, false)

    assert.equal(store.removeDevice('dev_not_exist'), false)
    assert.equal(store.removeDevice(a.device.deviceId), true)
    assert.deepEqual(removed, [a.device.deviceId])
    assert.equal(store.validateToken(a.deviceToken), null)
    assert.ok(store.validateToken(b.deviceToken))

    assert.equal(store.clearAll(), 1)
    assert.equal(cleared, 1)
    assert.equal(store.hasDevices(), false)
    assert.equal(store.validateToken(b.deviceToken), null)
    assert.deepEqual(store.listDevices(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── WsTicketStore ───

test('WsTicketStore：40 字符短票据、一次性消费、30s 过期、单设备 5 张与全局上限', () => {
  const clock = makeClock()
  const ws = new WsTicketStore({ now: clock.now, maxGlobal: 7, gcIntervalMs: 60_000 })
  try {
    const t1 = ws.issue('dev_a')
    assert.match(t1, /^[0-9a-f]{40}$/)
    assert.deepEqual(ws.validate(t1), { deviceId: 'dev_a' })
    assert.equal(ws.validate(t1), null, 'WS 票据必须一次消费即失效')

    // 单设备上限 5 张
    const batchA = []
    for (let i = 0; i < 5; i++) batchA.push(ws.issue('dev_a'))
    assert.equal(batchA.every((t) => typeof t === 'string'), true)
    assert.equal(ws.issue('dev_a'), null, '超过单设备 5 张上限应拒绝')

    // 全局上限 7 张（dev_a 已占 5 张，dev_b 还能签 2 张）
    const b1 = ws.issue('dev_b')
    const b2 = ws.issue('dev_b')
    assert.ok(b1 && b2)
    assert.equal(ws.issue('dev_c'), null, '超过全局上限应拒绝')

    // 消费 dev_a 一张后立即腾出配额
    assert.deepEqual(ws.validate(batchA[0]), { deviceId: 'dev_a' })
    assert.ok(ws.issue('dev_a'))

    // 吊销 dev_b 的未消费票据
    ws.revokeDevice('dev_b')
    assert.equal(ws.validate(b1), null)
    assert.equal(ws.validate(b2), null)

    // 30s 过期后失效并释放配额
    const expiring = ws.issue('dev_exp')
    clock.advance(30_000)
    assert.equal(ws.validate(expiring), null)
    assert.ok(ws.issue('dev_a'), '过期票据自动清理后可继续签发')
  } finally {
    ws.close()
  }
})

// ─── IpRateLimiter ───

test('IpRateLimiter：滑动窗口限流、IPv4 映射归一与桶上限防 OOM', () => {
  const clock = makeClock(500_000)
  const limiter = new IpRateLimiter({ windowMs: 10_000, maxRequests: 3, maxEntries: 4, now: clock.now })

  assert.deepEqual(limiter.check('192.168.1.5'), { allowed: true, retryAfterMs: 0 })
  clock.advance(2_000)
  assert.deepEqual(limiter.check('::ffff:192.168.1.5'), { allowed: true, retryAfterMs: 0 })
  clock.advance(2_000)
  assert.deepEqual(limiter.check('192.168.1.5'), { allowed: true, retryAfterMs: 0 })

  // 第 4 次命中限流，最早那条在 t=500_000，当前 t=504_000，应等待 6_000ms
  const blocked = limiter.check('192.168.1.5')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterMs, 6_000)

  // 滑出窗口后恢复放行
  clock.advance(6_000)
  assert.deepEqual(limiter.check('192.168.1.5'), { allowed: true, retryAfterMs: 0 })

  // 超过 maxEntries 时有界淘汰，不无限增长
  for (let i = 1; i <= 20; i++) {
    limiter.check(`203.0.113.${i}`)
  }
  assert.ok(limiter.size <= 4, `限流表大小 ${limiter.size} 不应超过 maxEntries=4`)
})

// ─── HTTP 辅助函数（Token / Cookie / CSRF / IP 信任边界） ───

test('HTTP Token 提取与 Cookie 构造', () => {
  assert.equal(DEVICE_COOKIE_NAME, 'dsh-x-device')

  // Bearer 优先于 Cookie
  assert.deepEqual(extractDeviceToken({
    headers: {
      authorization: 'Bearer tok_from_bearer',
      cookie: `${DEVICE_COOKIE_NAME}=tok_from_cookie`,
    },
  }), { token: 'tok_from_bearer', source: 'bearer' })

  // 仅 Cookie
  assert.deepEqual(extractDeviceToken({
    headers: {
      cookie: `other=1; ${DEVICE_COOKIE_NAME}=tok_only_cookie; theme=dark`,
    },
  }), { token: 'tok_only_cookie', source: 'cookie' })

  // 空或格式错误的 Bearer 回退到 Cookie 或 null
  assert.equal(extractDeviceToken({ headers: { authorization: 'Basic abc' } }), null)
  assert.equal(extractDeviceToken({ headers: { authorization: 'Bearer   ' } }), null)

  const httpCookie = buildDeviceCookie('tok_abc', { secure: false, maxAgeDays: 90 })
  assert.match(httpCookie, /^dsh-x-device=tok_abc;/)
  assert.match(httpCookie, /HttpOnly/)
  assert.match(httpCookie, /Path=\//)
  assert.match(httpCookie, /SameSite=Lax/)
  assert.match(httpCookie, /Max-Age=7776000/)
  assert.doesNotMatch(httpCookie, /;\s*Secure\b/)

  const httpsCookie = buildDeviceCookie('tok_abc', { secure: true })
  assert.match(httpsCookie, /;\s*Secure\b/)

  const clearCookie = buildClearDeviceCookie({ secure: true })
  assert.match(clearCookie, /^dsh-x-device=;/)
  assert.match(clearCookie, /Max-Age=0/)
  assert.match(clearCookie, /HttpOnly/)
  assert.match(clearCookie, /Secure/)
})

test('cookieWriteCsrfOk：同源校验、拒绝 null/跨站、放行 Bearer 与非浏览器请求', () => {
  const cookie = `${DEVICE_COOKIE_NAME}=tok_123`

  // 安全方法一律放行
  assert.equal(cookieWriteCsrfOk({ method: 'GET', headers: { host: 'dsh.example.com', origin: 'https://evil.com', cookie } }), true)
  assert.equal(cookieWriteCsrfOk({ method: 'HEAD', headers: { host: 'dsh.example.com', origin: 'https://evil.com', cookie } }), true)
  assert.equal(cookieWriteCsrfOk({ method: 'OPTIONS', headers: { host: 'dsh.example.com', origin: 'https://evil.com', cookie } }), true)

  // Bearer 请求免疫 CSRF
  assert.equal(cookieWriteCsrfOk({
    method: 'POST',
    headers: { host: 'dsh.example.com', origin: 'https://evil.com', authorization: 'Bearer tok_123' },
  }), true)

  // 非浏览器客户端（无 Origin / Referer / Sec-Fetch-Site）放行
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: '127.0.0.1:3790', cookie } }), true)

  // 同源 Origin（局域网 HTTP & Cloudflare Tunnel HTTPS 到本地 HTTP socket & 默认端口归一）
  assert.equal(cookieWriteCsrfOk({
    method: 'POST',
    headers: { host: '192.168.1.8:3790', origin: 'http://192.168.1.8:3790', 'sec-fetch-site': 'same-origin', cookie },
  }), true)
  assert.equal(cookieWriteCsrfOk({
    method: 'DELETE',
    headers: { host: 'my-pc.example.com', origin: 'https://my-pc.example.com', 'sec-fetch-site': 'same-origin', cookie },
  }), true)
  assert.equal(cookieWriteCsrfOk({
    method: 'POST',
    headers: { host: 'my-pc.example.com:443', origin: 'https://my-pc.example.com', cookie },
  }), true)

  // 同源 Referer 兜底
  assert.equal(cookieWriteCsrfOk({
    method: 'POST',
    headers: { host: '192.168.1.8:3790', referer: 'http://192.168.1.8:3790/_dshx/m/', cookie },
  }), true)

  // 拒绝 null origin、跨站、同站子域、伪造协议、降级攻击
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', origin: 'null', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', origin: 'https://evil.com', 'sec-fetch-site': 'cross-site', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'a.example.com', origin: 'https://b.example.com', 'sec-fetch-site': 'same-site', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', referer: 'https://evil.com/x', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', 'sec-fetch-site': 'cross-site', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', 'sec-fetch-site': 'same-site', cookie } }), false)
  assert.equal(cookieWriteCsrfOk({ method: 'POST', headers: { host: 'my-pc.example.com', origin: 'http://my-pc.example.com', cookie }, socket: { encrypted: true } }), false)

  // 白名单 allowedOrigins 放行显式信任的来源
  assert.equal(cookieWriteCsrfOk({
    method: 'POST',
    headers: { host: 'my-pc.example.com', origin: 'https://mobile.example.com', 'sec-fetch-site': 'same-site', cookie },
  }, { allowedOrigins: ['https://mobile.example.com'] }), true)
})

test('isLoopbackAddress 与 extractClientIP：仅在 trustProxy 且直连回环时信任转发头', () => {
  for (const addr of ['127.0.0.1', '127.42.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::1]']) {
    assert.equal(isLoopbackAddress(addr), true, `${addr} 应识别为回环`)
  }
  for (const addr of ['192.168.1.1', '10.0.0.1', '0.0.0.0', '::', '203.0.113.5', 'localhost', '']) {
    assert.equal(isLoopbackAddress(addr), false, `${addr} 不应识别为回环`)
  }

  // 非回环直连客户端伪造转发头 → 即使 trustProxy=true 也必须丢弃
  assert.equal(extractClientIP({
    socket: { remoteAddress: '::ffff:192.168.1.50' },
    headers: { 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-for': '1.2.3.4' },
  }, { trustProxy: true }), '192.168.1.50')

  // trustProxy=false 时即使来自回环也不信任转发头
  assert.equal(extractClientIP({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.9' },
  }, { trustProxy: false }), '127.0.0.1')

  // trustProxy=true 且来自本地回环（cloudflared）→ 优先 CF-Connecting-IP，其次 X-Forwarded-For 最左端
  assert.equal(extractClientIP({
    socket: { remoteAddress: '::1' },
    headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
  }, { trustProxy: true }), '198.51.100.7')

  assert.equal(extractClientIP({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.9, 172.16.0.1' },
  }, { trustProxy: true }), '203.0.113.9')

  // 非法转发头值回退到真实 peer IP
  assert.equal(extractClientIP({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'garbage' },
  }, { trustProxy: true }), '127.0.0.1')
})

// ─── QR Code ISO/IEC 18004 独立解码与 RS 校验子验证 ───

/** 独立实现一份精简的 ISO/IEC 18004 矩阵解码器，用来端到端证明编码结果可被真实扫码器无损解出。 */
function decodeAndVerifyQrMatrix(matrix) {
  const size = matrix.length
  assert.equal((size - 17) % 4, 0, 'QR 矩阵边长必须满足 4*V + 17')
  const version = (size - 17) / 4
  assert.ok(version >= 1 && version <= 20)
  for (const row of matrix) assert.equal(row.length, size)

  // 1. 校验三个 7x7 定位符 + 1 格分隔白边
  const checkFinder = (ox, oy) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        const expected = ring !== 2
        assert.equal(matrix[oy + dy][ox + dx], expected, `定位符 (${ox + dx},${oy + dy})`)
      }
    }
  }
  checkFinder(0, 0)
  checkFinder(size - 7, 0)
  checkFinder(0, size - 7)
  // 校验分隔白边与固定暗模块
  for (let i = 0; i < 8; i++) {
    assert.equal(matrix[7][i], false)
    assert.equal(matrix[i][7], false)
    assert.equal(matrix[7][size - 8 + i], false)
    assert.equal(matrix[i][size - 8], false)
    assert.equal(matrix[size - 8][i], false)
    assert.equal(matrix[size - 8 + i][7], false)
  }
  assert.equal(matrix[size - 8][8], true, '固定暗模块 (8, 4V+9) 必须为暗')

  // 2. 校验两条时序线
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0, `水平时序线 x=${i}`)
    assert.equal(matrix[i][6], i % 2 === 0, `垂直时序线 y=${i}`)
  }

  // 3. 校验两份 15-bit 格式信息一致且 BCH(15,5) 校验余数为 0
  let fmt1 = 0
  for (let i = 0; i <= 5; i++) fmt1 |= (matrix[i][8] ? 1 : 0) << i
  fmt1 |= (matrix[7][8] ? 1 : 0) << 6
  fmt1 |= (matrix[8][8] ? 1 : 0) << 7
  fmt1 |= (matrix[8][7] ? 1 : 0) << 8
  for (let i = 9; i < 15; i++) fmt1 |= (matrix[8][14 - i] ? 1 : 0) << i

  let fmt2 = 0
  for (let i = 0; i < 8; i++) fmt2 |= (matrix[8][size - 1 - i] ? 1 : 0) << i
  for (let i = 8; i < 15; i++) fmt2 |= (matrix[size - 15 + i][8] ? 1 : 0) << i

  assert.equal(fmt1, fmt2, '两份格式信息必须完全一致')
  const unmaskedFmt = fmt1 ^ 0x5412
  // BCH(15,5) 校验：对 0x537 取模必须为 0
  let fmtRem = unmaskedFmt
  for (let bit = 14; bit >= 10; bit--) {
    if (fmtRem & (1 << bit)) fmtRem ^= 0x537 << (bit - 10)
  }
  assert.equal(fmtRem, 0, '格式信息 BCH(15,5) 校验必须为 0')
  const eccBits = (unmaskedFmt >>> 13) & 0b11
  const mask = (unmaskedFmt >>> 10) & 0b111
  const ecc = eccBits === 0b01 ? 'L' : (eccBits === 0b00 ? 'M' : null)
  assert.ok(ecc, `未识别的纠错等级位: ${eccBits}`)

  // 4. Version >= 7 时校验两份 18-bit 版本信息一致且 BCH(18,6) 校验为 0
  if (version >= 7) {
    let verTR = 0
    let verBL = 0
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      verTR |= (matrix[b][a] ? 1 : 0) << i
      verBL |= (matrix[a][b] ? 1 : 0) << i
    }
    assert.equal(verTR, verBL, '两份版本信息必须一致')
    assert.equal(verTR >>> 12, version, '版本信息高 6 位必须等于版本号')
    let verRem = verTR
    for (let bit = 17; bit >= 12; bit--) {
      if (verRem & (1 << bit)) verRem ^= 0x1f25 << (bit - 12)
    }
    assert.equal(verRem, 0, '版本信息 BCH(18,6) 校验必须为 0')
  }

  // 5. 标记功能模块并按蛇形顺序读取全部数据+纠错码字
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size))
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) isFunc[y][x] = 1
  for (let y = 0; y < 9; y++) for (let x = size - 8; x < size; x++) isFunc[y][x] = 1
  for (let y = size - 8; y < size; y++) for (let x = 0; x < 9; x++) isFunc[y][x] = 1
  for (let i = 0; i < size; i++) { isFunc[6][i] = 1; isFunc[i][6] = 1 }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        isFunc[i][size - 11 + j] = 1
        isFunc[size - 11 + j][i] = 1
      }
    }
  }
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
    const coords = [6]
    for (let p = size - 7; coords.length < count; p -= step) coords.splice(1, 0, p)
    for (let i = 0; i < coords.length; i++) {
      for (let j = 0; j < coords.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === coords.length - 1) || (i === coords.length - 1 && j === 0)) continue
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ax = coords[i] + dx
            const ay = coords[j] + dy
            isFunc[ay][ax] = 1
            const expected = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
            assert.equal(matrix[ay][ax], expected, `V${version} 校正图形 (${ax},${ay})`)
          }
        }
      }
    }
  }

  const unmask = (x, y, bit) => {
    let flip = false
    if (mask === 0) flip = (y + x) % 2 === 0
    else if (mask === 1) flip = y % 2 === 0
    else if (mask === 2) flip = x % 3 === 0
    else if (mask === 3) flip = (y + x) % 3 === 0
    else if (mask === 4) flip = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    else if (mask === 5) flip = ((y * x) % 2) + ((y * x) % 3) === 0
    else if (mask === 6) flip = (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    else if (mask === 7) flip = (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
    return flip ? (bit ^ 1) : bit
  }

  const rawBits = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++) {
      const y = upward ? (size - 1 - v) : v
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (!isFunc[y][x]) rawBits.push(unmask(x, y, matrix[y][x] ? 1 : 0))
      }
    }
    upward = !upward
  }
  const totalCw = Math.floor(rawBits.length / 8)
  const cw = new Uint8Array(totalCw)
  for (let i = 0; i < totalCw; i++) {
    let b = 0
    for (let k = 0; k < 8; k++) b = (b << 1) | rawBits[i * 8 + k]
    cw[i] = b
  }

  // 6. 反交错并校验每个 RS 块的全部校验子（S_k = C(alpha^k) === 0）
  const ECC_SPEC = {
    L: [null, [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4], [20, 4], [24, 4], [26, 4], [30, 4], [22, 6], [24, 6], [28, 6], [30, 6], [28, 7], [28, 8]],
    M: [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5], [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10], [28, 11], [26, 13], [26, 14], [26, 16]],
  }
  const [ecPerBlock, numBlocks] = ECC_SPEC[ecc][version]
  const numLong = totalCw % numBlocks
  const numShort = numBlocks - numLong
  const shortDataLen = Math.floor(totalCw / numBlocks) - ecPerBlock
  const dataBlocks = Array.from({ length: numBlocks }, (_, b) => new Uint8Array(b < numShort ? shortDataLen : shortDataLen + 1))
  const ecBlocks = Array.from({ length: numBlocks }, () => new Uint8Array(ecPerBlock))

  let idx = 0
  const maxDataLen = shortDataLen + (numLong > 0 ? 1 : 0)
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) dataBlocks[b][i] = cw[idx++]
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) ecBlocks[b][i] = cw[idx++]
  }

  const gfMul = (a, b) => {
    let x = a; let y = b; let r = 0
    for (let i = 0; i < 8; i++) {
      if (y & 1) r ^= x
      const hi = x & 0x80
      x = (x << 1) & 0xff
      if (hi) x ^= 0x1d
      y >>>= 1
    }
    return r
  }
  for (let b = 0; b < numBlocks; b++) {
    const block = new Uint8Array(dataBlocks[b].length + ecPerBlock)
    block.set(dataBlocks[b], 0)
    block.set(ecBlocks[b], dataBlocks[b].length)
    let root = 1
    for (let k = 0; k < ecPerBlock; k++) {
      // Horner 法求 C(alpha^k)
      let evalVal = 0
      for (let i = 0; i < block.length; i++) evalVal = gfMul(evalVal, root) ^ block[i]
      assert.equal(evalVal, 0, `V${version}-${ecc} 块 ${b} 的 RS 校验子 S_${k} 必须为 0`)
      root = gfMul(root, 2)
    }
  }

  // 7. 解码 Byte 模式 UTF-8 载荷
  const dataBits = []
  for (const blk of dataBlocks) {
    for (const byte of blk) {
      for (let k = 7; k >= 0; k--) dataBits.push((byte >>> k) & 1)
    }
  }
  const readBits = (offset, len) => {
    let v = 0
    for (let i = 0; i < len; i++) v = (v << 1) | dataBits[offset + i]
    return v
  }
  assert.equal(readBits(0, 4), 0b0100, '模式位必须为 Byte 模式 (0100)')
  const countLen = version <= 9 ? 8 : 16
  const byteLen = readBits(4, countLen)
  const payload = Buffer.alloc(byteLen)
  let pos = 4 + countLen
  for (let i = 0; i < byteLen; i++) {
    payload[i] = readBits(pos, 8)
    pos += 8
  }
  return { version, ecc, mask, text: payload.toString('utf8') }
}

test('QR Code：严格 ISO/IEC 18004 矩阵、RS 校验子与不同长度（含 300 字符配对 URL）无损解码', () => {
  const pairCode = 'a1b2c3d4'.repeat(8) // 64-char hex
  const samples = [
    '',
    'hello',
    `http://192.168.1.10:3790/_dshx/m/?pair=${pairCode}`,
    `https://dsh-home.example.com/_dshx/m/?host=客厅主机&lan=http://192.168.31.88:3790&pair=${pairCode}`,
    `https://dsh-office.example.com/_dshx/m/?code=${pairCode}&lan=${encodeURIComponent('http://192.168.100.200:3790')}&tunnel=${encodeURIComponent('https://long-subdomain-for-remote-access.trycloudflare.com')}&custom=${encodeURIComponent('https://dsh.my-home-server.org:8443')}&host=${encodeURIComponent('公司开发机-Linux')}`,
    `https://example.com/p?d=${'x'.repeat(280)}`, // ~302 chars -> Version 11 (M) / Version 10 (L)
    `https://example.com/p?d=${'y'.repeat(390)}`, // ~412 chars -> Version 15 (M) / Version 13 (L)
    `https://example.com/p?d=${'z'.repeat(540)}`, // ~562 chars -> Version 18 (M) / Version 16 (L)
  ]

  for (const ecc of ['L', 'M']) {
    for (const text of samples) {
      const matrix = encodeQrMatrix(text, { ecc })
      const decoded = decodeAndVerifyQrMatrix(matrix)
      assert.equal(decoded.ecc, ecc)
      assert.equal(decoded.text, text, `ECC=${ecc}, len=${Buffer.byteLength(text)} 必须无损解码`)
    }
  }

  // 超出容量上限抛出 RangeError
  assert.throws(() => encodeQrMatrix('A'.repeat(1000), { ecc: 'M' }), RangeError)
})

test('renderQrSvg：输出包含合法 viewBox、静区边距、白底与暗模块路径', () => {
  const text = 'https://dsh.example.com/_dshx/m/?code=0123456789abcdef'
  const matrix = encodeQrMatrix(text, { ecc: 'M' })
  const svg = renderQrSvg(text, { size: 240, margin: 4 })
  const expectedView = matrix.length + 8

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.ok(svg.includes(`viewBox="0 0 ${expectedView} ${expectedView}"`))
  assert.ok(svg.includes('width="240" height="240"'))
  assert.ok(svg.includes('<rect width="100%" height="100%" fill="#ffffff"/>'))
  assert.match(svg, /<path fill="#000000" d="M\d+ \d+h\d+v1h-\d+z/)
  assert.ok(svg.endsWith('</svg>'))
})
