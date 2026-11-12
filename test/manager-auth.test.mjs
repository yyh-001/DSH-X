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
