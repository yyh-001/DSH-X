/**
 * 固定端口：在控制页给一个「版本 × profile」钉死端口，之后每次启动都落在它上面。
 *
 * 默认每个实例都由系统现挑端口（`--port 0`），代价是链接每次启动都变——书签、手机上
 * 存的地址留不住。钉住之后：启动参数里带的是那个端口、链接不变、重启还在原地；钉重了 /
 * 钉到管理页的端口上 / 钉给不起 web 的 profile 都要当场拒绝；端口被别的程序占着时，
 * 启动失败的原因要说得清是哪个端口（这正是这个功能最可能出的岔子）。
 *
 * 用假 dsh 跑：它把自己收到的 argv 记一行（证明启动器真的传了 --port）、按 --port 监听、
 * 打印真实的那行就绪输出，绑定失败就让 Node 的 EADDRINUSE 原样打出来。这条链路上只有
 * 启动器与 dsh 之间的协议是真的。
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

const FAKE_DSH = `import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const argv = process.argv.slice(2)
try { appendFileSync(process.env.DSH_TEST_ARGV_LOG, JSON.stringify(argv) + '\\n') } catch {}
const at = argv.indexOf('--port')
const want = at >= 0 ? Number(argv[at + 1]) : 0
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><html><body>fake dsh</body></html>')
})
srv.listen(want, '127.0.0.1', () => {
  const { port } = srv.address()
  console.log(\`dsh web: http://127.0.0.1:\${port}/?token=fake\`)
})
`

const A = '0.1.6'
const B = '0.1.7'

/** 挑一个当前没人用的端口。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 占住一个端口当「别的程序」，返回它的端口和放手的方法。 */
function holdPort() {
  return new Promise((resolve) => {
    const held = createServer()
    held.listen(0, '127.0.0.1', () => {
      resolve({ port: held.address().port, release: () => new Promise((done) => held.close(done)) })
    })
  })
}

/** 造一份会起 web 的自定义 profile（清单里有 dsh-web-app）。 */
function makeWebProfile(name) {
  const dir = join(HOME, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), 'utf8')
  return name
}

// 环境要在 import server.js 之前摆好：APP_DIR / 版本目录 / dsh 用户目录都是模块加载时定的
const appDir = mkdtempSync(join(tmpdir(), 'dsh-fixed-port-'))
const APP = join(appDir, 'DSH')
const DATA = join(appDir, 'data')
const HOME = join(appDir, 'home')
const ARGV_LOG = join(appDir, 'argv.log')
process.env.APPDATA = appDir
// 假 dsh 靠它把收到的 argv 记下来（子进程环境是 dshEnv 拼的，进程环境变量会继承过去）
process.env.DSH_TEST_ARGV_LOG = ARGV_LOG
const MANAGER_PORT = await freePort()
process.env.PORT = String(MANAGER_PORT)
mkdirSync(APP, { recursive: true })
mkdirSync(HOME, { recursive: true })
for (const version of [A, B]) {
  const lib = join(DATA, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH, 'utf8')
}
makeWebProfile('work')
// 一个不起 web 的 profile（headless 那种：清单里没有 dsh-web-app）
const headless = join(HOME, 'profiles', 'headless')
mkdirSync(headless, { recursive: true })
writeFileSync(join(headless, 'package.json'), JSON.stringify({
  name: 'dsh-profile-headless',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}), 'utf8')
writeFileSync(join(APP, 'settings.json'), JSON.stringify({
  dataDir: DATA,
  dshHome: HOME,
  profile: 'web',
  seedMarket: false,
  seedBundled: false,
}), 'utf8')

const { startServer, stopAll } = await import('../server.js')
const { safeInstancePorts } = await import('../settings.js')
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
const pin = (version, port, profile = 'web') => api('/api/instance-port', { version, profile, port })
const portOf = (url) => Number(new URL(url).port)

/** 假 dsh 收到的 argv（每次启动一行）。 */
function launches() {
  try {
    return readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** 启动时是不是传了这个端口（argv 里 `--port` 后面的那个值）。 */
function launchedWithPort(port) {
  return launches().some((argv) => {
    const at = argv.indexOf('--port')
    return at >= 0 && argv[at + 1] === String(port)
  })
}

test.after(async () => {
  await stopAll()
  // 刚被 taskkill 的 dsh 还占着 home 目录（它的 cwd 就是那儿），Windows 上要等它真的放手
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(appDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
})

test('固定端口表只留形状对的键与端口，脏值丢掉', () => {
  assert.deepEqual(safeInstancePorts(undefined), {})
  assert.deepEqual(safeInstancePorts([]), {}, '数组不算一张表')
  assert.deepEqual(safeInstancePorts('0.1.7@web'), {})
  assert.deepEqual(
    safeInstancePorts({
      '0.1.7@web': 3790,
      '0.1.7@work': '3800',
      // 历史文件里可能出现的脏值：键的形状、端口范围、非整数都不放行
      '0.1.7': 3791,
      '0.1.7@': 3792,
      '0.1.7@a@b': 3793,
      '@web': 3794,
      '0.1.7@../etc': 3795,
      '0.1.7@web ': 3796,
      '0.1.7@sdk': 0,
      '0.1.7@acp': 70000,
      '0.1.7@cli': 'abc',
      '0.1.7@x': 3797.5,
    }),
    { '0.1.7@web': 3790, '0.1.7@work': 3800 },
  )
})

test('钉了端口：启动参数里带它，链接也落在它上面', async () => {
  const port = await freePort()
  await pin(A, port)
  const { url } = await api('/api/start', { version: A, profile: 'web' })
  assert.equal(portOf(url), port, '实例就该落在这个端口上')
  assert.ok(launchedWithPort(port), '命令行里要真的带上 --port <钉的端口>')
  assert.ok(!launchedWithPort(0), '钉住时不该再让系统挑')
  const snap = await state()
  assert.equal(snap.instancePorts[`${A}@web`], port, '状态里带着这张表，页面靠它回显')
  await api('/api/stop', {})
  await pin(A, '')
})

test('没钉的组合还是每次由系统挑（--port 0）', async () => {
  const { url } = await api('/api/start', { version: A, profile: 'web' })
  assert.ok(launchedWithPort(0), '没钉就是 --port 0')
  assert.ok(!(await state()).instancePorts[`${A}@web`], '表里不该凭空多一条')
  assert.ok(portOf(url) > 0)
  await api('/api/stop', {})
})

test('同一版本的两个 profile 各钉各的，同时跑互不干扰', async () => {
  const webPort = await freePort()
  const workPort = await freePort()
  await pin(A, webPort, 'web')
  await pin(A, workPort, 'work')
  const web = await api('/api/start', { version: A, profile: 'web' })
  const work = await api('/api/start', { version: A, profile: 'work' })
  assert.equal(portOf(web.url), webPort)
  assert.equal(portOf(work.url), workPort)
  const snap = await state()
  assert.equal(snap.instancePorts[`${A}@web`], webPort)
  assert.equal(snap.instancePorts[`${A}@work`], workPort)
  await api('/api/stop', {})
})

test('钉重了 / 钉到管理页 / 钉给不起 web 的 profile：都当场拒', async () => {
  const first = await freePort()
  await pin(A, first)
  await assert.rejects(pin(B, first), /已经钉给/, '同一个端口不能钉给两个组合')
  await assert.rejects(pin(B, MANAGER_PORT), /管理页/, '管理页自己在用的端口要让开')
  await assert.rejects(pin(A, await freePort(), 'headless'), /不起 web/, '不起 web 的 profile 没有端口可钉')
  await assert.rejects(pin(A, 70000), /1-65535/, '端口范围照旧收口')
  await assert.rejects(pin(A, 1, 'ghost/../profile'), /profile/, 'profile 名照旧只认目录安全字符')
  // 留空 = 取消钉：不留残余，也不因为 profile 不起 web 而拒绝（清掉总是对的）
  assert.deepEqual(await pin(A, ''), { key: `${A}@web`, port: 0, busy: false })
  assert.ok(!(await state()).instancePorts[`${A}@web`])
  await pin(A, '', 'headless')
})

test('端口被别的程序占着：保存时回 busy，启动失败点名这个端口', async () => {
  const held = await holdPort()
  const result = await pin(A, held.port)
  assert.equal(result.busy, true, '现在就被占着要如实告诉页面（不是保存失败）')
  await assert.rejects(api('/api/start', { version: A, profile: 'web' }), /被占用/, '起不来时要说清是端口的事')
  const snap = await state()
  assert.deepEqual(snap.instances, [], '失败的实例不该留在列表里')
  await api('/api/stop', {})
  await pin(A, '')
  await held.release()
})

test('占着端口的是自己人：报错里点名是哪个实例', async () => {
  // A 不钉端口，先起来（系统挑一个 P）；再把 P 钉给 B，B 一启动就撞上 A
  const mine = await api('/api/start', { version: A, profile: 'web' })
  const held = portOf(mine.url)
  const result = await pin(B, held)
  assert.equal(result.busy, false, '自己实例占着的端口不算「别人的程序占着」')
  await assert.rejects(
    api('/api/start', { version: B, profile: 'web' }),
    new RegExp(`${A}/web 正在用它`),
    '要说清是哪个实例占着',
  )
  await api('/api/stop', {})
  await pin(B, '')
})

test('重启后还在原来那个端口上', async () => {
  const port = await freePort()
  await pin(B, port)
  const first = await api('/api/start', { version: B, profile: 'web' })
  assert.equal(portOf(first.url), port)
  await api('/api/restart', {})
  const snap = await state()
  assert.equal(snap.instances.length, 1, '重启把它拉回来了')
  assert.equal(portOf(snap.instances[0].url), port, '钉住的端口重启后不该变（这正是钉它的意义）')
  await api('/api/stop', {})
  await pin(B, '')
})

test('版本卸掉之后，它的固定端口跟着清掉', async () => {
  const webPort = await freePort()
  const workPort = await freePort()
  await pin(A, webPort, 'web')
  await pin(A, workPort, 'work')
  await api('/api/uninstall', { version: A })
  const snap = await state()
  const left = Object.keys(snap.instancePorts).filter((key) => key.startsWith(`${A}@`))
  assert.deepEqual(left, [], '卸掉的版本不该继续占着端口号（留着会挡住以后钉同一个端口）')
})

test('控制页有端口输入框，文案有英文', () => {
  assert.match(page, /<div class="home-field port">[\s\S]{0,200}?<input id="launchPort" type="number" min="1" max="65535"/, '端口输入框在控制页的版本/Profile 旁边')
  assert.match(page, /launchPortEl\.onchange = \(\) => \{ void saveLaunchPort\(\) \}/, '改完自动提交')
  assert.match(page, /post\('\/api\/instance-port', \{ version, profile: launchProfile, port: text \}\)/, '提交打在 版本×profile 上')
  assert.match(page, /if \(data\.busy\)/, '被占用时只说问题，不当成保存失败')
  assert.match(page, /document\.activeElement !== launchPortEl/, 'render 频繁重跑，正在输入时不能覆盖用户手里的字')
  // applyState 是按字段重建 state 的：漏掉这张表的话，每次状态刷新都会把端口回显清掉
  // （服务端明明存着，页面上却是空的——改动时踩过一次）
  assert.match(page, /instancePorts: data\.instancePorts && typeof data\.instancePorts === 'object'/, '状态重建时要带上固定端口表')
  // 填完端口马上点启动的竞态：blur 先 change、click 后到，启动要等这次保存落地
  assert.match(page, /await portSave/, '启动前等端口保存落地')
  assert.match(page, /launchPortEl\.onkeydown = \(event\) => \{/, '回车＝提交（number 输入框自己不会因为回车触发 change）')
  const dict = new vm.Script(`(${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const text of [
    '端口',
    '端口被占用',
    '端口 {port} 现在被别的程序占着：这次启动会失败，先让出它或换一个。',
    '给这个「版本 × profile」钉一个固定端口：链接每次启动都一样，书签和手机上的地址就留得住。留空＝每次由系统挑一个。下次启动生效。',
  ]) {
    assert.ok(dict[text], `「${text}」缺英文`)
  }
})
