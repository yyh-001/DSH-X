/**
 * 管理页访问令牌：一次性 launch token 换签名 cookie，以及接进 server.js 之后的行为。
 *
 * 前半段是 ManagerAuth 的单元测试（不起服务，手搓 req/res）；后半段起一次真实的管理服务，
 * 盯三件事：没 cookie 的页面 401、带 token 的地址能换到 cookie、带 Origin 的 API 请求要 cookie。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ManagerAuth, readManagerSession } from '../src/manager-auth.js'
import { isolateUserHome } from './isolated-home.mjs'

/** 最小的 res 桩：writeHead 的头部和 end 的内容都留下来给断言用。 */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { res.status = status; res.headers = headers },
    end(body = '') { res.body = String(body ?? '') },
  }
  return res
}

function request(url, { cookie, host = '127.0.0.1:3780', method = 'GET' } = {}) {
  return { method, url, headers: { host, ...(cookie ? { cookie } : {}) } }
}

function cookieOf(res) {
  return String(res.headers['set-cookie'] || '').split(';')[0]
}

/**
 * 顶层页面导航（Chromium / Electron 打开窗口）的请求。`mode: null` 是只带 sec-fetch-dest 的
 * 那一类导航。req.url 用路径形式、url 用本机地址补全，和 server.js 交给 exchange 的形状一致。
 */
function navigation(url, { cookie, host = url.host, mode = 'navigate', dest = 'document' } = {}) {
  const headers = { host, 'sec-fetch-dest': dest }
  if (mode) headers['sec-fetch-mode'] = mode
  if (cookie) headers.cookie = cookie
  return { method: 'GET', url: url.pathname + url.search, headers }
}

/** 走一遍 token 交换拿到 `名=值`：模拟这个 authority 上已经登录过的窗口。 */
function signedCookie(auth, host = '127.0.0.1:3780') {
  const url = new URL(`/?token=${auth.launchToken}`, `http://${host}`)
  const res = fakeRes()
  auth.exchange(request(url.pathname + url.search, { host }), res, url)
  const cookie = cookieOf(res)
  assert.match(cookie, /^dsh-x-manager-[A-Za-z0-9_-]+=./, `${host} 上的 token 交换应该种下 cookie`)
  return cookie
}

/** exchange 交回 false 时不许碰 res：调用方还要接着在同一个 res 上出页面。 */
function assertUntouched(res, message) {
  assert.deepEqual({ status: res.status, headers: res.headers, body: res.body }, { status: 0, headers: {}, body: '' }, message)
}

/** 兼容跳转：303 回同一地址并补上本次的 launch token，`window` 之类的参数原样保留。 */
function assertTokenRedirect(auth, res, message) {
  assert.equal(res.status, 303, message)
  const location = new URL(res.headers.location, 'http://127.0.0.1:3780')
  assert.equal(location.pathname, '/', message)
  assert.equal(location.searchParams.get('token'), auth.launchToken, message)
  assert.equal(location.searchParams.get('window'), '1', message)
}

/** Chromium 一条导航最多跟 20 次跳转，再多就是 ERR_TOO_MANY_REDIRECTS（Electron 窗口里一片白）。 */
const BROWSER_REDIRECT_LIMIT = 20

/**
 * 像浏览器那样走完一条导航：303 就把 Set-Cookie 收进 cookie 罐、按 Location 再请求一次，
 * 直到 exchange 交回 false（调用方出页面）。跳满上限就判死循环。
 * 只模拟这里用得到的部分：cookie 只看「名=值」，Path / Max-Age 这些属性不管——
 * 整条链都在根路径上，也没有哪个 cookie 会在一条导航中途过期。
 */
function browse(auth, start, jar = new Map()) {
  let url = new URL(start)
  const hops = []
  for (let i = 0; i < BROWSER_REDIRECT_LIMIT; i++) {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const res = fakeRes()
    if (!auth.exchange(navigation(url, { cookie }), res, url)) return { url, hops, jar }
    assert.equal(res.status, 303, `第 ${i + 1} 次请求 ${url.pathname}${url.search} 应该是 303，实际 ${res.status}`)
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const pair = String(line).split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    url = new URL(res.headers.location, url)
    hops.push(url.pathname + url.search)
  }
  assert.fail(`跳了 ${BROWSER_REDIRECT_LIMIT} 次还没出页面（ERR_TOO_MANY_REDIRECTS）：${hops.slice(0, 4).join(' → ')} → …`)
}

test('ManagerAuth：launch token 换 cookie', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const url = new URL(`http://127.0.0.1:3780/?token=${auth.launchToken}&window=1`)
  const res = fakeRes()
  assert.equal(auth.exchange(request(url.href), res, url), true)
  assert.equal(res.status, 303)
  // token 不留在地里：跳回去只带原来的业务参数
  assert.equal(res.headers.location, '/?window=1')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  const cookie = cookieOf(res)
  assert.match(cookie, /^dsh-x-manager-[A-Za-z0-9_-]+=/)
  assert.match(String(res.headers['set-cookie']), /HttpOnly/)
  assert.match(String(res.headers['set-cookie']), /SameSite=Strict/)
  assert.equal(auth.isAuthenticated(request(url.href, { cookie })), true)
})

test('ManagerAuth：错误 token、缺 token 与篡改 cookie', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const bad = new URL('http://127.0.0.1:3780/?token=not-the-token')
  const badRes = fakeRes()
  assert.equal(auth.exchange(request(bad.href), badRes, bad), true)
  assert.equal(badRes.status, 401)
  assert.match(badRes.body, /需要访问令牌/)

  // 没有 token 参数时不该应答：索引页由调用方决定要不要 401
  const clean = new URL('http://127.0.0.1:3780/')
  assert.equal(auth.exchange(request(clean.href), fakeRes(), clean), false)

  const good = new URL(`http://127.0.0.1:3780/?token=${auth.launchToken}`)
  const res = fakeRes()
  auth.exchange(request(good.href), res, good)
  const [name, value] = cookieOf(res).split('=')
  const parts = value.split('.')
  // 改签名里的一位就不认
  const tampered = `${name}=${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`
  assert.equal(auth.isAuthenticated(request('http://127.0.0.1:3780/', { cookie: tampered })), false)
  // cookie 绑 authority：换个端口不认
  assert.equal(auth.isAuthenticated(request('http://127.0.0.1:3780/', { cookie: cookieOf(res), host: '127.0.0.1:3799' })), false)
})

test('ManagerAuth：过期 cookie 不认', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7), { maxAgeDays: 0 })
  const url = new URL(`http://127.0.0.1:3780/?token=${auth.launchToken}`)
  const res = fakeRes()
  auth.exchange(request(url.href), res, url)
  assert.equal(auth.isAuthenticated(request(url.href, { cookie: cookieOf(res) })), false)
})

test('ManagerAuth：重启后 cookie 仍有效，launch token 换新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manager-auth-'))
  try {
    const first = ManagerAuth.load(dir)
    const url = new URL(`http://127.0.0.1:3780/?token=${first.launchToken}`)
    const res = fakeRes()
    first.exchange(request(url.href), res, url)
    const cookie = cookieOf(res)

    // 同一个数据目录 = 同一份签名密钥；进程换了、token 换了，会话还在
    const second = ManagerAuth.load(dir)
    assert.notEqual(second.launchToken, first.launchToken)
    assert.equal(second.isAuthenticated(request('http://127.0.0.1:3780/', { cookie })), true)

    second.writeSession(dir, { port: 3780, url: second.authenticatedUrl('http://127.0.0.1:3780/') })
    const session = readManagerSession(dir)
    assert.equal(session.port, 3780)
    assert.match(session.url, /\?token=/)
    // 磁盘上的密钥不是明文猜得到的短串
    const stored = JSON.parse(readFileSync(join(dir, 'manager-auth.json'), 'utf8'))
    assert.equal(stored.version, 1)
    assert.ok(stored.secret.length >= 40)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('管理服务：页面要 cookie，本机无 Origin 的 API 调用照旧', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manager-auth-api-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  const origin = base.endsWith('/') ? base : `${base}/`
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })

  const bare = await fetch(base)
  assert.equal(bare.status, 401)
  assert.match(await bare.text(), /需要访问令牌/)

  const tokenUrl = server.managerUrlWithToken({ window: '1' })
  assert.match(tokenUrl, /\?window=1&token=/)
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  assert.equal(exchange.headers.get('location'), '/?window=1')
  const cookie = String(exchange.headers.get('set-cookie') || '').split(';')[0]
  assert.match(cookie, /^dsh-x-manager-/)

  const page = await fetch(`${origin}?window=1`, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html/i)

  // 浏览器（带 Origin）没有 cookie 不给数据；本机脚本（不带 Origin）不受影响
  const crossSite = await fetch(`${origin}api/state`, { headers: { origin: 'https://evil.example' } })
  assert.equal(crossSite.status, 401)
  const scripted = await fetch(`${origin}api/state`)
  assert.equal(scripted.status, 200)
  const signed = await fetch(`${origin}api/state`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } })
  assert.equal(signed.status, 200)

  await t.test('在浏览器中打开：把带 token 的地址交给系统浏览器', async () => {
    const { fileManager } = await import('../src/filemanager.js')
    const opened = []
    const original = fileManager.openUrl
    // 真的 openUrl 会拉起系统浏览器；这个用例只验地址，替换掉实现
    fileManager.openUrl = async (url) => { opened.push(url) }
    try {
      const res = await fetch(`${origin}api/open-manager`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(res.status, 200)
      assert.equal(opened.length, 1)
      assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{40,}$/)
    } finally {
      if (original) fileManager.openUrl = original
      else delete fileManager.openUrl
    }
  })
})

test('旧外壳打开不带 token 的根地址：本机顶层导航 303 到带 token 的地址', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const url = new URL('http://127.0.0.1:3780/?window=1')
  const res = fakeRes()
  const req = { method: 'GET', url: url.href, headers: { host: '127.0.0.1:3780', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }
  assert.equal(auth.exchange(req, res, url), true)
  assert.equal(res.status, 303)
  const location = new URL(res.headers.location, 'http://127.0.0.1:3780')
  assert.equal(location.pathname, '/')
  assert.equal(location.searchParams.get('token'), auth.launchToken)
  assert.equal(location.searchParams.get('window'), '1', '原有参数原样保留')
})

test('兼容跳转只给本机顶层导航：局域网和脚本请求仍然要 token', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const lan = new URL('http://192.168.1.20:3780/')
  assert.equal(auth.exchange({ method: 'GET', url: lan.href, headers: { host: '192.168.1.20:3780', 'sec-fetch-mode': 'navigate' } }, fakeRes(), lan), false, '局域网必须带 token')
  const local = new URL('http://127.0.0.1:3780/')
  assert.equal(auth.exchange(request(local.href), fakeRes(), local), false, '脚本请求（没有顶层导航头）不放行')
  const api = new URL(`http://127.0.0.1:3780/api/state?token=${auth.launchToken}`)
  assert.equal(auth.exchange(request(api.href), fakeRes(), api), false, '兼容跳转只处理根地址')
})

// ─── 兼容跳转 × cookie：回归「已登录窗口在 token 和干净地址之间来回跳」 ───
// 兼容跳转只看「地址里有没有 token」、不看「请求带没带有效 cookie」时，换到 cookie 之后的
// 干净地址又被补回 token，浏览器在 /?window=1 → /?window=1&token=… → 种 cookie → /?window=1 → …
// 之间打转，Electron 窗口报 ERR_TOO_MANY_REDIRECTS 白屏。

test('已经带着有效 cookie 的本机顶层导航：不再跳 token，交给调用方出页面', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const cookie = signedCookie(auth)
  const url = new URL('/?window=1', 'http://127.0.0.1:3780')
  // 两种顶层导航头都要认：带 sec-fetch-mode 的，和只带 sec-fetch-dest: document 的
  for (const [label, mode] of [['sec-fetch-mode: navigate', 'navigate'], ['只有 sec-fetch-dest: document', null]]) {
    const res = fakeRes()
    assert.equal(auth.exchange(navigation(url, { cookie, mode }), res, url), false, label)
    assertUntouched(res, label)
  }
  // 127.0.0.1 上的 cookie 不分端口：浏览器会把别的端口上管理页的 cookie、别的站点 cookie
  // 一起带来，混在里面也得认出本端口那一个
  const crowded = `${signedCookie(auth, '127.0.0.1:3799')}; theme=dark; ${cookie}`
  const res = fakeRes()
  assert.equal(auth.exchange(navigation(url, { cookie: crowded }), res, url), false, '多个 cookie 混在一起')
  assertUntouched(res, '多个 cookie 混在一起')
  // 根地址不带任何参数也一样
  const root = new URL('/', 'http://127.0.0.1:3780')
  const rootRes = fakeRes()
  assert.equal(auth.exchange(navigation(root, { cookie }), rootRes, root), false, '不带参数的根地址')
  assertUntouched(rootRes, '不带参数的根地址')
})

test('没有有效 cookie 的本机顶层导航：照旧 303 到带 token 的地址', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const good = signedCookie(auth)
  const eq = good.indexOf('=')
  const name = good.slice(0, eq)
  const value = good.slice(eq + 1)
  // 改签名段的第一个字符：最后一个 base64url 字符的低位可能只是填充位，改了不一定真变
  const sig = value.lastIndexOf('.') + 1
  const tampered = `${name}=${value.slice(0, sig)}${value[sig] === 'A' ? 'B' : 'A'}${value.slice(sig + 1)}`
  const expiring = new ManagerAuth(Buffer.alloc(32, 7), { maxAgeDays: 0 })
  const cases = [
    ['没有 cookie（只带 sec-fetch-dest: document）', auth, undefined, null],
    ['签名被改过', auth, tampered, 'navigate'],
    ['别的端口（127.0.0.1:3799）的 cookie', auth, signedCookie(auth, '127.0.0.1:3799'), 'navigate'],
    ['别的签名密钥签的 cookie（换了数据目录）', auth, signedCookie(new ManagerAuth(Buffer.alloc(32, 9))), 'navigate'],
    ['cookie 值为空', auth, `${name}=`, 'navigate'],
    ['cookie 值不成形', auth, `${name}=not.a.cookie`, 'navigate'],
    ['过期的 cookie', expiring, signedCookie(expiring), 'navigate'],
  ]
  const url = new URL('/?window=1', 'http://127.0.0.1:3780')
  for (const [label, owner, cookie, mode] of cases) {
    const res = fakeRes()
    assert.equal(owner.exchange(navigation(url, { cookie, mode }), res, url), true, label)
    assertTokenRedirect(owner, res, label)
  }
})

test('局域网、脚本与页面内 fetch：带不带有效 cookie 都不跳', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  const local = signedCookie(auth)
  const lan = new URL('http://192.168.1.20:3780/?window=1')
  const lanCookie = signedCookie(auth, '192.168.1.20:3780')
  const url = new URL('/?window=1', 'http://127.0.0.1:3780')
  const cases = [
    ['局域网顶层导航 + 有效 cookie', lan, navigation(lan, { cookie: lanCookie })],
    ['局域网顶层导航 + 别处的 cookie', lan, navigation(lan, { cookie: local })],
    ['本机脚本请求（没有 sec-fetch 头）+ 有效 cookie', url, request(url.pathname + url.search, { cookie: local })],
    ['本机脚本请求（没有 sec-fetch 头）+ 无效 cookie', url, request(url.pathname + url.search, { cookie: lanCookie })],
    ['页面内 fetch（cors / empty）+ 没有 cookie', url, navigation(url, { mode: 'cors', dest: 'empty' })],
  ]
  for (const [label, target, req] of cases) {
    const res = fakeRes()
    assert.equal(auth.exchange(req, res, target), false, label)
    assertUntouched(res, label)
  }
})

test('浏览器跟着跳转走完 /?window=1：拿到 cookie 就停，最多两跳、最终地址不带 token', () => {
  const auth = new ManagerAuth(Buffer.alloc(32, 7))
  // 旧外壳：没有 cookie、地址里也没 token → 补 token → 换 cookie → 出页面
  const first = browse(auth, 'http://127.0.0.1:3780/?window=1')
  assert.ok(first.hops.length <= 2, `最多两跳（补 token、换 cookie），实际：${first.hops.join(' → ') || '没跳'}`)
  assert.equal(first.url.pathname, '/')
  assert.equal(first.url.searchParams.get('token'), null, '最终地址不留 token')
  assert.equal(first.url.searchParams.get('window'), '1', '业务参数一路保留')
  const cookie = [...first.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  assert.match(cookie, /dsh-x-manager-/, '走完这条链应该已经拿到 cookie')
  assert.equal(auth.isAuthenticated(navigation(first.url, { cookie })), true)

  // 停在已登录状态：刷新、再开一个窗口都直接出页面
  const reload = browse(auth, first.url.href, first.jar)
  assert.deepEqual(reload.hops, [], `已登录后刷新不该再跳：${reload.hops.join(' → ')}`)
  assert.equal(reload.url.href, first.url.href)
  const another = browse(auth, 'http://127.0.0.1:3780/', first.jar)
  assert.deepEqual(another.hops, [], `已登录后打开根地址不该再跳：${another.hops.join(' → ')}`)

  // 新外壳直接带 token 打开：一跳换 cookie，之后同样停住
  const fresh = browse(auth, auth.authenticatedUrl('http://127.0.0.1:3780/', { window: '1' }), first.jar)
  assert.equal(fresh.hops.length, 1, `带 token 的地址只该跳一次：${fresh.hops.join(' → ')}`)
  assert.equal(fresh.url.searchParams.get('token'), null)
  assert.equal(fresh.url.searchParams.get('window'), '1')
})

test('启动器重启后带着旧 cookie 打开窗口：直接出页面，不再绕 token', () => {
  // 签名密钥跨重启保留、launch token 换新：旧 cookie 仍然有效，就不该被兼容跳转拽回 token 地址
  const secret = Buffer.alloc(32, 7)
  const cookie = signedCookie(new ManagerAuth(secret))
  const eq = cookie.indexOf('=')
  const jar = new Map([[cookie.slice(0, eq), cookie.slice(eq + 1)]])
  const restarted = new ManagerAuth(secret)
  const result = browse(restarted, 'http://127.0.0.1:3780/?window=1', jar)
  assert.deepEqual(result.hops, [], `重启后不该再跳：${result.hops.join(' → ')}`)
  assert.equal(result.url.searchParams.get('window'), '1')
})
