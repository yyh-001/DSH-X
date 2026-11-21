/**
 * 启动项换版本 / 跨目录同名配置：两处「实例明明停了（或该停了）却被当成还在」的回归。
 *
 * - 改启动项的版本时，旧版本那份进程以前不会停：卡片指向新版本，首页、停止按钮都够不着它，
 *   它还占着固定端口，下一次启动直接撞「端口被占用（旧版本/web 正在用它）」。
 * - 回退配置的护栏只比 profile 名：另一个 DSH_HOME 里的 web 在跑，这个目录里已经停掉的
 *   web 也回退不了（「remote」停着、主实例跑着时就是这样）。
 *
 * 用假 dsh 跑（和 multi-instance 同一只），走管理页自己的 HTTP 接口。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const FAKE_DSH = `import { createServer } from 'node:http'
if (process.argv.includes('plugin')) process.exit(0)
const srv = createServer((req, res) => { res.end('fake dsh') })
const portAt = process.argv.indexOf('--port')
srv.listen(portAt >= 0 ? Number(process.argv[portAt + 1]) : 0, '127.0.0.1', () => {
  console.log(\`dsh web: http://127.0.0.1:\${srv.address().port}/?token=fake\`)
})
`

const A = '0.1.6'
const B = '0.1.7'

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const appDir = mkdtempSync(join(tmpdir(), 'dsh-version-switch-'))
const APP = isolateUserHome(appDir)
const DATA = join(appDir, 'data')
const HOME = join(appDir, 'home')
const OTHER = join(appDir, 'other-home')
process.env.APPDATA = appDir
process.env.PORT = String(await freePort())
mkdirSync(APP, { recursive: true })
// solo / work 两个自定义配置：内置那条 auto 启动项跟着 web 走，会认领 web 上在跑的任何版本
for (const [home, name] of [[HOME, 'web'], [OTHER, 'web'], [HOME, 'solo'], [HOME, 'work']]) {
  const profile = join(home, 'profiles', name)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
}
for (const version of [A, B]) {
  const lib = join(DATA, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH, 'utf8')
}
writeFileSync(join(APP, 'settings.json'), JSON.stringify({ dataDir: DATA, dshHome: HOME, profile: 'web', seedMarket: false }), 'utf8')

const { startServer, stopAll } = await import('../src/server.js')
const base = await startServer()

async function api(path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, body === undefined
    ? { headers }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}
const state = () => api('/api/state')
const live = async () => (await state()).instances.filter((item) => item.status !== 'stopped')

test.after(async () => {
  await stopAll()
  for (let i = 0; i < 10; i += 1) {
    try { rmSync(appDir, { recursive: true, force: true }); return } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
  }
})

test('另一个目录里的同名配置在跑，不挡这个目录里已停实例的回退', async () => {
  const other = { 'x-dsh-home': encodeURIComponent(OTHER) }
  const snap = await api('/api/profile-backups/snapshot', { profile: 'web', force: true }, other)
  assert.ok(snap.backup, '另一个目录的 web 先存一份备份')
  // 默认目录的 web 跑起来；OTHER 里的 web 没有实例
  await api('/api/start', { version: A, profile: 'web' })
  assert.equal((await live()).length, 1)
  const restored = await api('/api/profile-backups/restore', { profile: 'web', id: snap.backup.id }, other)
  assert.equal(restored.restored, snap.backup.id)
  // 同一个目录里在跑的那份照样要拦
  const own = await api('/api/profile-backups/snapshot', { profile: 'web', force: true })
  await assert.rejects(api('/api/profile-backups/restore', { profile: 'web', id: own.backup.id }), /停止/)
  await api('/api/stop', { version: A, profile: 'web' })
})

test('改启动项的版本会停掉旧版本那份，不留占着端口的孤儿', async () => {
  const { entry } = await api('/api/launch-presets', { name: '换版本', version: A, profile: 'solo', port: 0 })
  await api('/api/start', { version: A, profile: 'solo' }, { 'x-dsh-launch-id': entry.id })
  assert.deepEqual((await live()).map((item) => item.version), [A])
  const saved = await api('/api/launch-presets', { ...entry, version: B })
  assert.equal(saved.entry.version, B)
  assert.deepEqual(await live(), [], '旧版本的实例已经没有启动项指向它，保存后应被停掉')
})

test('没改版本的编辑不碰在跑的实例；本来就没入口的实例也不顺手停', async () => {
  const { entry } = await api('/api/launch-presets', { name: '只改名', version: A, profile: 'work', port: 0 })
  await api('/api/start', { version: A, profile: 'work' }, { 'x-dsh-launch-id': entry.id })
  // 一个没有任何入口的实例（比如入口被删掉留下的）：solo 那条入口现在指向 B，A 上的 solo 没人认领
  await api('/api/start', { version: A, profile: 'solo' })
  await api('/api/launch-presets', { ...entry, version: A, name: '改了名字' })
  const versions = (await live()).map((item) => `${item.version}/${item.profile}`).sort()
  assert.deepEqual(versions, [`${A}/solo`, `${A}/work`])
})

test('远端 core 的 /api/start 认一次性固定端口：真按这个端口起、不写进设置', async () => {
  const port = await freePort()
  // web 才起 HTTP 服务、才带 --port（自定义的 solo 在假清单里不挂 web 应用）
  const started = await api('/api/start', { version: B, profile: 'web', port })
  assert.equal(new URL(started.url).port, String(port), 'dsh 应该按带过来的端口监听（--port）')
  const settings = JSON.parse(readFileSync(join(APP, 'settings.json'), 'utf8'))
  assert.equal(JSON.stringify(settings).includes(`"${B}@web":${port}`), false, '一次性端口不能存成远端自己的钉子')
  await api('/api/stop', { version: B, profile: 'web' })
  // 管理页自己的端口不能给 dsh
  await assert.rejects(api('/api/start', { version: B, profile: 'web', port: Number(process.env.PORT) }), /管理页/)
})

test('WSL 启动项的固定端口随远端 /api/start 一起带过去（SSH 不带）', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function startRemoteViaCore('), source.indexOf('async function stopRemoteCoreInstance('))
  assert.match(body, /if \(kind === 'wsl'\) \{[\s\S]*?pinned = pinnedPort\(effective, profile\) \|\| \(preset\?\.port > 0 \? preset\.port : 0\)/)
  assert.match(body, /JSON\.stringify\(\{ version: effective, profile, \.\.\.\(pinned \? \{ port: pinned \} : \{\}\) \}\)/)
})
