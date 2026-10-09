import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'
import { readPackState, rememberPack, uninstallPack } from '../packs.js'

test('目录显示名与 Profile 改名按用户目录隔离，依赖与启动引用完整保留', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-rename-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const other = join(root, '独立目录')
  const data = join(root, 'data')
  mkdirSync(app, { recursive: true })
  const makeProfile = (base, name) => {
    const dir = join(base, 'profiles', name)
    const pkg = join(dir, 'node_modules', '.pnpm', 'demo', 'node_modules', 'demo-plugin')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin', '@deepseek-ai/dsh-web-app'] } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.cjs', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(pkg, 'index.cjs'), 'module.exports = "dependency-ok"\n')
    writeFileSync(join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-plugin\n')
    symlinkSync(pkg, join(dir, 'node_modules', 'demo-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    return dir
  }
  const web = makeProfile(home, 'web')
  const otherWeb = makeProfile(other, 'web')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'keep.json'), 'session-data')
  const lib = join(data, 'versions', '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), `import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const profile = process.argv[2]
const value = createRequire(join(process.env.DSH_HOME, 'profiles', profile, 'package.json'))('demo-plugin')
const server = createServer((req, res) => res.end('<!doctype html><html><body>' + value + '</body></html>'))
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: ['1.0.0'] }))
  const globalId = '1111111111111111'
  const otherId = '2222222222222222'
  const presets = [
    { id: globalId, name: '全局启动', version: '1.0.0', profile: 'web', port: 0 },
    { id: otherId, name: '独立启动', version: 'auto', profile: 'web', port: 23456, dshHome: other },
  ]
  const settingsFile = join(app, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ dataDir: data, dshHome: home, dshHomes: [other], profile: 'web', seedMarket: false, launchPresets: presets, instancePorts: { '1.0.0@web': 45678 }, environmentPorts: { [other]: { '1.0.0@web': 34567 } } }))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise((resolve) => probe.close(resolve))
  const server = await import('../server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const api = async (path, body, target = '') => {
    const res = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...(target ? { 'x-dsh-home': encodeURIComponent(target) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error)
    return result
  }
  const settings = () => JSON.parse(readFileSync(settingsFile, 'utf8'))

  await t.test('中文目录名称持久化，实际路径、Profile 和启动项不变；并发改名不丢失', async () => {
    await Promise.all([api('/api/dsh-homes/rename', { home, name: '全局配置' }), api('/api/dsh-homes/rename', { home: other, name: '独立工作环境' })])
    assert.equal((await api('/api/state')).dshHomeNames[other], '独立工作环境')
    assert.equal((await api('/api/settings')).dshHomeNames[home], '全局配置')
    assert.equal(settings().dshHomeNames[other], '独立工作环境')
    assert.equal(settings().launchPresets.find((item) => item.id === otherId).dshHome, other)
    assert.ok(existsSync(otherWeb))
    for (const body of [{ home: other, name: '' }, { home: other, name: 'x'.repeat(65) }, { home: other, name: 'bad\nname' }, { home: join(root, 'unknown'), name: 'unknown' }]) await assert.rejects(api('/api/dsh-homes/rename', body), /名称|已登记/)
  })

  await t.test('运行中的 Profile 拒绝改名，所有版本停下后才允许', async () => {
    // 留空端口由系统分配，避免固定端口在测试机上撞占用。
    await api('/api/instance-port', { version: '1.0.0', profile: 'web', port: 0 })
    await api('/api/start', { version: '1.0.0', profile: 'web' })
    await assert.rejects(api('/api/profiles/rename', { profile: 'web', name: 'work' }), /请先停止/)
    assert.ok(existsSync(web))
    await api('/api/stop', {})
    await api('/api/instance-port', { version: '1.0.0', profile: 'web', port: 45678 })
  })

  await t.test('Profile 改名保留实际依赖、恢复档和整合包卸载备份；同步本目录的启动项和固定端口', async () => {
    writeFileSync(join(web, 'cordis.patch.yml.bak-123'), 'backup-content')
    const backupDir = join(data, 'packs', 'backups', 'demo')
    mkdirSync(join(backupDir, 'files', 'profiles', 'web'), { recursive: true })
    writeFileSync(join(backupDir, 'files', 'profiles', 'web', 'cordis.patch.yml'), 'before-pack')
    rememberPack(data, { name: 'demo', profile: 'web', backupDir, files: [{ rel: 'profiles/web/cordis.patch.yml', existed: true }], dependencies: {}, bundles: [] })
    const result = await api('/api/profiles/rename', { profile: 'web', name: 'work' })
    const work = join(home, 'profiles', 'work')
    assert.equal(result.renamedProfile, 'work')
    assert.equal(result.state.profile, 'work')
    assert.ok(result.webProfiles.includes('work'))
    assert.equal(existsSync(web), false)
    assert.equal(existsSync(join(work, 'lock')), false)
    assert.equal(createRequire(join(work, 'package.json'))('demo-plugin'), 'dependency-ok', '绝对 junction/符号链接在改名后仍可真正加载插件')
    assert.ok(readlinkSync(join(work, 'node_modules', 'demo-plugin')).includes('work'))
    assert.equal(readFileSync(join(work, 'cordis.patch.yml.bak-123'), 'utf8'), 'backup-content')
    assert.equal(readFileSync(join(home, 'sessions', 'keep.json'), 'utf8'), 'session-data')
    assert.equal(settings().profile, 'work')
    assert.equal(settings().launchPresets.find((item) => item.id === globalId).profile, 'work')
    assert.equal(settings().launchPresets.find((item) => item.id === otherId).profile, 'web')
    assert.equal(settings().launchPresets.find((item) => item.id === otherId).port, 23456)
    assert.deepEqual(settings().instancePorts, { '1.0.0@work': 45678 })
    assert.deepEqual(settings().environmentPorts[other], { '1.0.0@web': 34567 })
    assert.ok(existsSync(otherWeb))
    const record = readPackState(data).packs[0]
    assert.equal(record.profile, 'work')
    uninstallPack(record, { home })
    assert.equal(readFileSync(join(work, 'cordis.patch.yml'), 'utf8'), 'before-pack', '卸载落在新名称的目录，读取仍有效的原备份')
    writeFileSync(join(work, 'cordis.patch.yml'), '[]\n')
    // 新名字实际能启动，固定端口配置在上一段单独验；这里交由系统分配。
    await api('/api/instance-port', { version: '1.0.0', profile: 'work', port: 0 })
    await api('/api/start', { version: '1.0.0', profile: 'work' })
    const state = await api('/api/state')
    assert.ok(state.instances.some((item) => item.profile === 'work'))
    await api('/api/stop', {})
  })

  await t.test('独立目录改名不影响全局；禁止覆盖已有环境、系统保留名和越界路径', async () => {
    const result = await api('/api/profiles/rename', { profile: 'web', name: 'private-work' }, other)
    assert.equal(result.home, other)
    assert.equal(settings().profile, 'work')
    assert.equal(settings().launchPresets.find((item) => item.id === otherId).profile, 'private-work')
    assert.deepEqual(settings().environmentPorts[other], { '1.0.0@private-work': 34567 })
    makeProfile(other, 'occupied')
    for (const name of ['occupied', 'OCCUPIED', '../escape', 'desktop', 'node_modules', '.hidden', 'web']) await assert.rejects(api('/api/profiles/rename', { profile: 'private-work', name }, other), /已存在|保留名称|profile 名/)
    await assert.rejects(api('/api/profiles/rename', { profile: 'desktop', name: 'custom' }, other), /系统环境/)
  })

  await t.test('清单损坏导致中途失败时，还原目录名与依赖链接，启动配置不改动', async () => {
    const broken = makeProfile(other, 'broken')
    writeFileSync(join(broken, 'package.json'), '{broken json')
    const before = readFileSync(settingsFile, 'utf8')
    await assert.rejects(api('/api/profiles/rename', { profile: 'broken', name: 'renamed' }, other))
    assert.ok(existsSync(broken))
    assert.equal(existsSync(join(other, 'profiles', 'renamed')), false)
    assert.equal(existsSync(join(broken, 'lock')), false)
    assert.equal(readFileSync(join(broken, 'package.json'), 'utf8'), '{broken json')
    assert.equal(readlinkSync(join(broken, 'node_modules', 'demo-plugin')).includes('broken'), true)
    assert.equal(readFileSync(settingsFile, 'utf8'), before)
  })
})
