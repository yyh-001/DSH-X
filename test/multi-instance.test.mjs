/**
 * 多开：同时跑几个 dsh 实例。
 *
 * 这条以前是硬约束——README 里写着「同时只跑一个版本，避免不同版本争用端口和数据」，
 * 起第二个版本会把第一个顶掉。现在放开：每个版本一个实例，端口由 dsh 自己挑
 * （启动器传 --port 0），数据（DSH_HOME）本来就是共享的。
 *
 * 所以这里钉住四件事：起第二个不会顶掉第一个、同一个版本重复点启动不会叠加、
 * 停是按版本停的、重启会把在跑的都拉回来；顺带钉住托盘读的那份 running 仍然是
 * 「最近起来的那个」。走的是管理页自己那套 HTTP 接口，页面上按的就是这几个。
 *
 * 用假 dsh 跑：它打印真实的那行就绪输出、真的监听一个端口（页面自检要连得上），
 * 除此之外什么都不做——这条链路上只有启动器与 dsh 之间的协议是真的。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

const FAKE_DSH = `import { createServer } from 'node:http'
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><html><body>fake dsh</body></html>')
})
srv.listen(0, '127.0.0.1', () => {
  const { port } = srv.address()
  console.log(\`dsh web: http://127.0.0.1:\${port}/?token=fake\`)
})
`

const A = '0.1.6'
const B = '0.1.7'

/** 挑一个当前没人用的端口给管理器。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// 环境要在 import server.js 之前摆好：APP_DIR / 版本目录 / dsh 用户目录都是模块加载时定的
const appDir = mkdtempSync(join(tmpdir(), 'dsh-multi-'))
const APP = join(appDir, 'DSH')
const DATA = join(appDir, 'data')
const HOME = join(appDir, 'home')
process.env.APPDATA = appDir
process.env.PORT = String(await freePort())
mkdirSync(APP, { recursive: true })
mkdirSync(HOME, { recursive: true })
for (const version of [A, B]) {
  const lib = join(DATA, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH, 'utf8')
}
writeFileSync(join(APP, 'settings.json'), JSON.stringify({
  dataDir: DATA,
  dshHome: HOME,
  profile: 'web',
  // 预装市场/内置插件要跑 pnpm 和联网，测试里关掉（与设置页里那两项开关同一套语义）
  seedMarket: false,
  seedBundled: false,
}), 'utf8')

const { startServer, stopAll } = await import('../server.js')
const base = await startServer()

async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

const state = () => api('/api/state')

test.after(async () => {
  await stopAll()
  // 刚刚被 taskkill 的 dsh 还占着 home 目录（它的 cwd 就是那儿），Windows 上要等它真的放手；
  // 清不掉也只是留个临时目录，不该让整个文件报失败
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(appDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
})

test('起第二个版本不会把第一个顶掉', async () => {
  const first = await api('/api/start', { version: A })
  const second = await api('/api/start', { version: B })
  assert.ok(first.url && second.url, '两个都该拿到地址')
  assert.notEqual(first.url, second.url, '端口不抢：各是各的')

  const snap = await state()
  assert.equal(snap.instances.length, 2, '两个实例都在')
  assert.deepEqual(snap.instances.map((item) => item.version).sort(), [A, B])
  assert.ok(snap.instances.every((item) => item.status === 'running'), '两个都跑起来了')
  // 托盘/外壳只认一个地址：给最近起来的那个
  assert.equal(snap.running.version, B)
  // 版本列表按版本聚合：两个都显示成运行中
  const rows = Object.fromEntries(snap.versions.map((row) => [row.version, row]))
  assert.equal(rows[A].status, 'running')
  assert.equal(rows[B].status, 'running')
})

test('同一个版本重复点启动：拿回已经在跑的那个，不叠加', async () => {
  const again = await api('/api/start', { version: A })
  const snap = await state()
  assert.equal(snap.instances.length, 2, '还是一个版本一个实例')
  assert.equal(again.url, snap.instances.find((item) => item.version === A).url)
})

test('停是按版本停的：另一个照跑', async () => {
  await api('/api/stop', { version: A })
  const snap = await state()
  assert.deepEqual(snap.instances.map((item) => item.version), [B], '只剩 B')
  assert.equal(snap.running.version, B)
})

test('不给版本号就是全停（托盘的「停止」走这条）', async () => {
  await api('/api/stop', {})
  const snap = await state()
  assert.deepEqual(snap.instances, [], '一个都不剩')
  assert.equal(snap.running, null)
})

test('重启会把在跑的实例都拉回来', async () => {
  const before = [(await api('/api/start', { version: A })).url, (await api('/api/start', { version: B })).url]
  const back = await api('/api/restart', {})
  const snap = await state()
  assert.equal(snap.instances.length, 2, '重启不该把多开变成单开')
  assert.ok(back.url, '返回一个可以打开的地址')
  const urls = snap.instances.map((item) => item.url)
  assert.ok(urls.every(Boolean))
  // 端口是每次启动重新挑的，重启后不该还是原来那两个（假 dsh 每次都是新端口）
  assert.ok(urls.every((url) => !before.includes(url)))
})

test('版本目录里跑着的实例不许改、不许卸', async () => {
  await api('/api/start', { version: A })
  await assert.rejects(api('/api/settings', { dataDir: join(appDir, 'elsewhere') }), /请先停止/, '多开中也得先停再改版本目录')
  await assert.rejects(api('/api/uninstall', { version: A }), /请先停止/, '跑着的版本不能卸')
  await api('/api/stop', { version: A })
})

// ---- 多 profile 多开：实例的键是「版本 × profile」，不再只是版本 ----

test('同一个版本可以用两个 profile 各起一个', async () => {
  // 自定义 profile 得先在盘上有清单，不然 dsh 自己都会拒
  const work = join(HOME, 'profiles', 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: 'dsh-profile-work',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), 'utf8')
  const web = await api('/api/start', { version: A, profile: 'web' })
  const wk = await api('/api/start', { version: A, profile: 'work' })
  assert.ok(web.url && wk.url, '两个都拿到地址')
  assert.notEqual(web.url, wk.url, '端口不抢：各是各的')
  const snap = await state()
  const mine = snap.instances.filter((item) => item.version === A)
  assert.equal(mine.length, 2, '同一版本两个 profile 各一个实例')
  assert.deepEqual(mine.map((item) => item.profile).sort(), ['web', 'work'])
  // 同一组合再点一次：拿回已经在跑的那个，不叠加
  const again = await api('/api/start', { version: A, profile: 'work' })
  assert.equal(again.url, wk.url)
  await api('/api/stop', {})
})

test('按 profile 停：只停那一个组合，别的照跑', async () => {
  await api('/api/start', { version: A, profile: 'web' })
  await api('/api/start', { version: A, profile: 'work' })
  await api('/api/stop', { version: A, profile: 'web' })
  const snap = await state()
  assert.deepEqual(snap.instances.map((item) => item.profile), ['work'], '只剩 work 那份')
  await api('/api/stop', {})
})

test('按版本停：该版本的全部 profile 一起停', async () => {
  await api('/api/start', { version: A, profile: 'web' })
  await api('/api/start', { version: A, profile: 'work' })
  await api('/api/stop', { version: A })
  const snap = await state()
  assert.deepEqual(snap.instances, [], '同版本不管几个 profile 都停了')
  await api('/api/stop', {})
})

test('重启把每个实例按原来的 profile 拉回来', async () => {
  await api('/api/start', { version: A, profile: 'web' })
  await api('/api/start', { version: A, profile: 'work' })
  await api('/api/restart', {})
  const snap = await state()
  assert.equal(snap.instances.length, 2, '重启不该把多 profile 变成单份')
  assert.deepEqual(snap.instances.map((item) => item.profile).sort(), ['web', 'work'])
  assert.ok(snap.instances.every((item) => item.version === A))
  await api('/api/stop', {})
})

test('不存在的 profile 与保留名都会被拒', async () => {
  await assert.rejects(api('/api/start', { version: A, profile: 'ghost' }), /不存在/, '盘上没有的自定义名直接拒')
  await assert.rejects(api('/api/start', { version: A, profile: 'desktop' }), /desktop/, 'desktop 是官方 Electron 端的保留名')
})

test('控制页有「在跑的实例」一栏，每行单独打开/停止', () => {
  assert.match(page, /<details class="instances" id="instances" hidden>[\s\S]{0,220}?<summary class="instances-title" data-i18n="其他运行项">/, '实例一栏在控制页')
  assert.match(page, /const show = list\.length > 0/, '有实例就列出来：选中别的版本时，这栏是唯一能看到「还有东西在跑」的地方')
  assert.match(page, /post\('\/api\/stop', \{ version: el\.dataset\.stopVersion, profile: el\.dataset\.profile \}\)/, '每行的停止打在它自己那个 版本×profile 上')
  assert.match(page, /void openInstance\(item\?\.url\)/, '打开走服务端的打开方式（内嵌窗口 / 应用窗口 / 标签页）')
  assert.match(page, /const live = runningInfo\(version, entry\.profile\)/, '每个启动项只打开自己的版本与 profile')
  assert.match(page, /function runningInfo\(version = '', profile = ''\)/, 'runningInfo 收版本和 profile')
  assert.match(page, /id="launchProfile"/, '控制页有启动 profile 下拉')
  assert.match(page, /async function startVersion\(version, profile = launchProfile, presetPort = null\)/, '手动启动仍用选中的 profile，启动项可指定自己的 profile')
  assert.match(page, /post\('\/api\/start', \{ version, profile \}\)/, '启动带上目标 profile')
  // 跑着的时候下拉还能切：切过去点启动就是在旁边再起一个，这正是多开要的那条路
  assert.match(page, /versionDisabled = loading\r?\n/, '版本下拉不再因为「有实例在跑」而禁用')
})

test('多开相关的中文文案都有英文', () => {
  const dict = new vm.Script(`(${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const text of ['打开', '在跑的实例']) {
    assert.ok(dict[text], `「${text}」缺英文`)
  }
})
