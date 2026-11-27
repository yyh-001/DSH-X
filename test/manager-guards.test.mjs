/**
 * 管理服务入口的几道防线（口令本身见 manager-auth.test.mjs）：
 * 改状态请求的 Origin、别的网页用 <img src> 之类触发的 GET、请求体上限，
 * 以及几处按名字查表 / 拼命令行的校验。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('管理服务：来源检查、请求体上限与输入校验', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manager-guards-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })

  const status = async (path, init) => (await fetch(base + path, init)).status
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  await t.test('改状态的请求：Origin 必须是管理页这个端口', async () => {
    assert.equal((await post('/api/wake', {}, { origin: base })).status, 200, '管理页自己的 Origin 放行')
    assert.equal((await post('/api/wake', {})).status, 200, '本机程序不带 Origin，照常放行')
    for (const origin of ['http://localhost', 'https://127.0.0.1', 'http://127.0.0.1:1', 'https://evil.example', 'null']) {
      assert.equal((await post('/api/wake', {}, { origin })).status, 403, `${origin} 不是管理页`)
    }
  })

  await t.test('别的网页触发的 GET 也挡：靠 Sec-Fetch-Site 认', async () => {
    assert.equal(await status('/api/settings'), 200)
    assert.equal(await status('/api/settings', { headers: { 'sec-fetch-site': 'same-origin' } }), 200, '页面自己的 fetch')
    assert.equal(await status('/api/settings', { headers: { 'sec-fetch-site': 'none' } }), 200, '地址栏直接打开')
    assert.equal(await status('/api/settings', { headers: { 'sec-fetch-site': 'cross-site' } }), 403, '<img src> 这类不带 Origin 的跨站请求')
    assert.equal(await status('/api/settings', { headers: { 'sec-fetch-site': 'same-site' } }), 403, '本机别的端口上的页面')
    assert.notEqual(await status('/api/settings', { headers: { origin: 'https://evil.example' } }), 200, '跨站来源没有会话 cookie')
    assert.equal(await status('/api/ping', { headers: { 'sec-fetch-site': 'cross-site' } }), 200, '身份探测不受影响')
  })

  await t.test('请求体有上限：超了回 413，服务照常', async () => {
    const res = await post('/api/wake', `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`).catch((error) => error)
    // 服务端回完 413 就断开；客户端要么读到 413，要么在发送途中看到连接被掐断
    if (res instanceof Error) assert.match(String(res.cause?.code || res.message), /ECONNRESET|EPIPE|fetch failed|other side closed/i)
    else assert.equal(res.status, 413)
    assert.equal((await post('/api/wake', {})).status, 200, '服务还活着')
  })

  await t.test('按名字查表的校验不认原型上的名字', async () => {
    const saved = await (await post('/api/settings', { downloadSource: 'constructor' })).json()
    assert.equal(saved.downloadSource, 'mirror', 'constructor 不是下载源，回默认')
    assert.equal(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8')).downloadSource, 'mirror')
    const { safeUpdateSource } = await import('../src/settings.js')
    assert.equal(safeUpdateSource('__proto__'), 'mirror')
    const { parseDesktopRequest } = await import('../src/desktop.js')
    for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(parseDesktopRequest(action, { action: 'open', url: 'file:///etc/passwd' }), null, `${action} 不是桌面动作`)
    }
  })

  await t.test('插件源不能长得像命令行开关', async () => {
    const flag = await post('/api/plugins/add', { spec: '--global' })
    assert.equal(flag.status, 400)
    assert.match((await flag.json()).error, /非法插件源/)
  })
})
