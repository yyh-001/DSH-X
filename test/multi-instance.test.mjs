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
import { isolateUserHome } from './isolated-home.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

const FAKE_DSH = `import { createServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.env.DSH_TEST_START_GATE) {
  const profile = process.argv.includes('--profile') ? process.argv[process.argv.indexOf('--profile') + 1] : process.argv[2]
  const marker = join(process.env.DSH_TEST_START_GATE, process.env.DSH_VERSION + '-' + profile)
  writeFileSync(marker + '.started', '')
  while (!existsSync(marker + '.release')) await new Promise(resolve => setTimeout(resolve, 20))
}
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(req.url === '/home' ? process.env.DSH_HOME : '<!doctype html><html><body>fake dsh</body></html>')
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
const APP = isolateUserHome(appDir)
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
  // 预装市场要跑 pnpm 和联网，测试里关掉（与设置页里那个开关同一套语义）
  seedMarket: false,
}), 'utf8')

const { startServer, stopAll } = await import('../server.js')
const base = await startServer()

async function api(path, body, launchId = '') {
  const response = await fetch(`${base}${path}`, body === undefined
    ? { headers: launchId ? { 'x-dsh-launch-id': launchId } : {} }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...(launchId ? { 'x-dsh-launch-id': launchId } : {}) }, body: JSON.stringify(body) })
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

async function waitForMarker(file) {
  const deadline = Date.now() + 15000
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, `等待启动标记超时：${file}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('不同 Profile 同时启动，不必等前一个就绪；同一组合并发点击仍只有一个进程', async () => {
  const gate = join(appDir, 'parallel-gate')
  mkdirSync(gate)
  for (const profile of ['parallel-a', 'parallel-b']) {
    const dir = join(HOME, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
  }
  process.env.DSH_TEST_START_GATE = gate
  const pending = [api('/api/start', { version: A, profile: 'parallel-a' }), api('/api/start', { version: A, profile: 'parallel-b' }), api('/api/start', { version: A, profile: 'parallel-a' })]
  for (const promise of pending) promise.catch(() => {})
  try {
    await Promise.all(['parallel-a', 'parallel-b'].map((profile) => waitForMarker(join(gate, `${A}-${profile}.started`))))
    const snap = await state()
    assert.equal(snap.instances.filter((item) => item.profile.startsWith('parallel-')).length, 2)
    assert.ok(snap.instances.every((item) => item.status === 'starting'), '两个都能进入加载阶段，不等第一个就绪')
  } finally {
    delete process.env.DSH_TEST_START_GATE
    for (const profile of ['parallel-a', 'parallel-b']) writeFileSync(join(gate, `${A}-${profile}.release`), '')
    const result = await Promise.allSettled(pending)
    await api('/api/stop', {})
    assert.ok(result.every((item) => item.status === 'fulfilled'))
    assert.equal(result[0].value.url, result[2].value.url, '重复点击复用原实例')
  }
})

test('同一 Profile 的两个版本仍串行准备，避免同时初始化或修复配置', async () => {
  const gate = join(appDir, 'serial-gate')
  mkdirSync(gate)
  process.env.DSH_TEST_START_GATE = gate
  const first = api('/api/start', { version: A, profile: 'web' })
  first.catch(() => {})
  await waitForMarker(join(gate, `${A}-web.started`))
  const second = api('/api/start', { version: B, profile: 'web' })
  second.catch(() => {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(join(gate, `${B}-web.started`)), false)
    writeFileSync(join(gate, `${A}-web.release`), '')
    await first
    await waitForMarker(join(gate, `${B}-web.started`))
  } finally {
    delete process.env.DSH_TEST_START_GATE
    for (const version of [A, B]) writeFileSync(join(gate, `${version}-web.release`), '')
    await Promise.allSettled([first, second])
    await api('/api/stop', {})
  }
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

test('并发启动、添加和编辑入口保留各自的配置与启动历史，删除入口不停止实例', async () => {
  const first = await api('/api/launch-presets', { name: '并发一', version: A, profile: 'work', port: 0 })
  const second = await api('/api/launch-presets', { name: '并发二', version: B, profile: 'work', port: 0 })
  const [, , added] = await Promise.all([
    api('/api/start', { version: A, profile: 'work' }, first.entry.id),
    api('/api/start', { version: B, profile: 'work' }, second.entry.id),
    api('/api/launch-presets', { name: '并发新增', version: A, profile: 'web', port: 0 }),
  ])
  const snap = await state()
  assert.equal(snap.launchPresets.find((item) => item.id === first.entry.id).usedVersion, A)
  assert.equal(snap.launchPresets.find((item) => item.id === second.entry.id).usedVersion, B)
  assert.ok(snap.launchPresets.some((item) => item.id === added.entry.id))
  assert.equal(snap.instances.length, 2)
  await api('/api/launch-presets', { ...first.entry, name: '运行中改名' })
  await api('/api/launch-presets/remove', { id: first.entry.id })
  assert.equal((await state()).instances.length, 2, '改名和删除快捷入口不影响运行实例')
  await api('/api/launch-presets/remove', { id: second.entry.id })
  await api('/api/launch-presets/remove', { id: added.entry.id })
  await api('/api/stop', {})
})

test('同版本同 Profile 可在不同 DSH_HOME 并存，管理和停止按启动项隔离', async () => {
  const otherHome = join(appDir, 'other-home')
  const saved = await api('/api/launch-presets', { name: 'Other home', version: A, profile: 'web', port: 0, dshHome: otherHome })
  const launchId = saved.entry.id
  assert.equal(saved.entry.dshHome, otherHome)
  const headless = join(otherHome, 'profiles', 'work')
  mkdirSync(headless, { recursive: true })
  writeFileSync(join(headless, 'package.json'), JSON.stringify({ name: 'other-work', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  await assert.rejects(api('/api/launch-presets', { name: 'Headless other', version: A, profile: 'work', port: 4567, dshHome: otherHome }), /不起 web/)
  const plugin = join(headless, 'node_modules', 'alt-only')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(headless, 'package.json'), JSON.stringify({ name: 'other-work', dependencies: { 'alt-only': '1.0.0' }, dsh: { profile: { bundles: ['alt-only'] } } }))
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'alt-only', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: alt-row\n      name: alt-only\n')
  assert.ok((await api('/api/plugins?profile=work', undefined, launchId)).plugins.some((item) => item.name === 'alt-only'))
  assert.ok(!(await api('/api/plugins?profile=work')).plugins.some((item) => item.name === 'alt-only'))
  const first = await api('/api/start', { version: A, profile: 'web' })
  const second = await api('/api/start', { version: A, profile: 'web' }, launchId)
  assert.notEqual(first.url, second.url)
  await assert.rejects(api('/api/stop', { version: A, profile: '../bad', home: otherHome }), /profile 名/)
  assert.equal((await state()).instances.filter((item) => item.version === A && item.profile === 'web').length, 2)
  assert.equal(await (await fetch(new URL('/home', first.url))).text(), HOME)
  assert.equal(await (await fetch(new URL('/home', second.url))).text(), otherHome)
  const snap = await state()
  assert.deepEqual(snap.instances.filter((item) => item.version === A && item.profile === 'web').map((item) => item.home).sort(), [HOME, otherHome].sort())
  assert.equal((await api('/api/packs', undefined, launchId)).home, otherHome)
  assert.equal((await api('/api/plugins?profile=web', undefined, launchId)).home, otherHome)
  const port = await freePort()
  await api('/api/instance-port', { version: A, profile: 'web', port }, launchId)
  const stored = JSON.parse(readFileSync(join(APP, 'settings.json'), 'utf8'))
  assert.equal(stored.environmentPorts[otherHome][`${A}@web`], port)
  assert.equal(stored.instancePorts?.[`${A}@web`], undefined)
  const { writePackState } = await import('../packs.js')
  writePackState(DATA, { packs: [{ name: 'only-default', profile: 'web' }] })
  assert.ok((await api('/api/packs')).packs.some((item) => item.records.some((record) => record.name === 'only-default')))
  assert.ok(!(await api('/api/packs', undefined, launchId)).packs.some((item) => item.records.some((record) => record.name === 'only-default')))
  assert.equal((await api('/api/start', { version: A, profile: 'web' }, launchId)).url, second.url)
  await api('/api/stop', { version: A, profile: 'web' }, launchId)
  assert.equal((await state()).instances.find((item) => item.home === HOME)?.url, first.url)
  await api('/api/start', { version: A, profile: 'web' }, launchId)
  await api('/api/restart', {})
  assert.deepEqual((await state()).instances.filter((item) => item.version === A && item.profile === 'web').map((item) => item.home).sort(), [HOME, otherHome].sort())
  await api('/api/stop', { version: A, profile: 'web', home: otherHome })
  assert.equal((await state()).instances.filter((item) => item.version === A && item.profile === 'web').length, 1)
  await api('/api/stop', { version: A, profile: 'web' })
  await assert.rejects(api('/api/start', { version: A, profile: 'web' }, 'missing'), /启动项已不存在/)
})

test('控制页有「在跑的实例」一栏，每行单独打开/停止', () => {
  assert.match(page, /<details class="instances" id="instances" hidden>[\s\S]{0,220}?<summary class="instances-title" data-i18n="其他运行项">/, '实例一栏在控制页')
  assert.match(page, /const show = list\.length > 0/, '有实例就列出来：选中别的版本时，这栏是唯一能看到「还有东西在跑」的地方')
  assert.match(page, /post\('\/api\/stop', \{ version: el\.dataset\.stopVersion, profile: el\.dataset\.profile, home: el\.dataset\.home \}\)/, '每行的停止打在它自己那个 版本×profile×home 上')
  assert.match(page, /void openInstance\(item\?\.url\)/, '打开走服务端的打开方式（内嵌窗口 / 应用窗口 / 标签页）')
  assert.match(page, /const live = runningInfo\(version, entry\.profile, entry\.dshHome \|\| state\.dshHome\)/, '每个启动项只打开自己的版本、profile 与 home')
  assert.match(page, /function runningInfo\(version = '', profile = '', home = ''\)/, 'runningInfo 收版本、profile 与 home')
  assert.match(page, /id="launchProfile"/, '控制页有启动 profile 下拉')
  assert.match(page, /async function startVersion\(version, profile = launchProfile, presetPort = null, launchId = ''\)/, '手动启动仍用选中的 profile，启动项可指定自己的 profile 和 home')
  assert.match(page, /post\('\/api\/start', \{ version, profile \}, \{ launchId \}\)/, '启动带上目标 profile 与启动项')
  // 跑着的时候下拉还能切：切过去点启动就是在旁边再起一个，这正是多开要的那条路
  assert.match(page, /versionDisabled = loading\r?\n/, '版本下拉不再因为「有实例在跑」而禁用')
})

test('多开相关的中文文案都有英文', () => {
  const dict = new vm.Script(`(${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const text of ['打开', '在跑的实例']) {
    assert.ok(dict[text], `「${text}」缺英文`)
  }
})
