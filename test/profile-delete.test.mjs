import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('最后一个 Profile 可删除，保留用户数据并按目录清理启动项', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-delete-'))
  const app = isolateUserHome(root, join(root, 'appdata'))
  const home = join(root, 'home')
  const otherHome = join(root, 'other-home')
  const data = join(root, 'data')
  const settingsPath = join(app, 'settings.json')
  mkdirSync(app, { recursive: true })
  const makeProfile = (base, name) => {
    const dir = join(base, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `profile-${name}`, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
    }))
    return dir
  }
  const web = makeProfile(home, 'web')
  const otherWeb = makeProfile(otherHome, 'web')
  const userFiles = ['sessions/session.json', 'memory/note.json', 'attachments/file.txt'].map((path) => {
    const file = join(home, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'keep-user-data')
    return file
  })
  const lib = join(data, 'versions', '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), `import { createServer } from 'node:http'
const server = createServer((req, res) => res.end('<!doctype html><html><body>ok</body></html>'))
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: ['1.0.0'] }))
  writeFileSync(settingsPath, JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  process.env.APPDATA = join(root, 'appdata')
  process.env.DSH_VERSIONS_DATA = data
  process.env.PORT = String(port)
  const server = await import('../server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const api = async (path, body, launchId = '') => {
    const res = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(launchId ? { 'x-dsh-launch-id': launchId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error)
    return result
  }

  await t.test('唯一 web 卡片可删，但运行期间仍然拒绝', async () => {
    const packs = await api('/api/packs')
    assert.equal(packs.packs.length, 1)
    assert.equal(packs.packs[0].removable, true)
    await api('/api/start', { version: '1.0.0', profile: 'web' })
    await assert.rejects(api('/api/profiles/delete', { profile: 'web' }), /请先停止/)
    assert.ok(existsSync(web))
    await api('/api/stop', {})
  })

  const globalEntry = await api('/api/launch-presets', { name: 'Global web', version: '2.0.0', profile: 'web' })
  const otherEntry = await api('/api/launch-presets', { name: 'Other web', version: 'auto', profile: 'web', dshHome: otherHome })
  await t.test('删除最后一个默认环境后无空壳卡片，数据和其它目录保留', async () => {
    const result = await api('/api/profiles/delete', { profile: 'web' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.packs, [])
    assert.equal(existsSync(web), false)
    assert.ok(existsSync(otherWeb))
    for (const file of userFiles) assert.equal(readFileSync(file, 'utf8'), 'keep-user-data')
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(stored.profile, 'web', '全空时保留 web 作为首次启动可初始化的模板')
    assert.ok(!stored.launchPresets.some((entry) => entry.id === globalEntry.entry.id))
    assert.ok(stored.launchPresets.some((entry) => entry.id === otherEntry.entry.id))
    assert.deepEqual((await api('/api/plugins')).packs, [])
    assert.equal(existsSync(web), false, '读页面不能偷偷重新创建已删除的目录')
  })

  await t.test('删除独立目录的唯一 web，不改变默认目录和默认选择', async () => {
    makeProfile(home, 'web')
    const result = await api('/api/profiles/delete', { profile: 'web' }, otherEntry.entry.id)
    assert.deepEqual(result.packs, [])
    assert.equal(existsSync(otherWeb), false)
    assert.ok(existsSync(web))
    assert.equal((await api('/api/settings')).profile, 'web')
    assert.ok(!(await api('/api/state')).launchPresets.some((entry) => entry.id === otherEntry.entry.id))
  })

  await t.test('普通模板可删除，官方 desktop 和内部目录仍受保护', async () => {
    const sdk = makeProfile(home, 'sdk')
    assert.equal((await api('/api/packs')).packs.find((entry) => entry.profile === 'sdk').removable, true)
    await api('/api/profiles/delete', { profile: 'sdk' })
    assert.equal(existsSync(sdk), false)
    const desktop = makeProfile(home, 'desktop')
    await assert.rejects(api('/api/profiles/delete', { profile: 'desktop' }), /官方桌面端专用/)
    assert.ok(existsSync(desktop))
    assert.equal((await api('/api/packs')).packs.find((entry) => entry.profile === 'desktop').removable, false)
    for (const profile of ['.dsh-alias-desktop', 'node_modules', '../home']) {
      await assert.rejects(api('/api/profiles/delete', { profile }), /内部目录|profile 名/)
    }
  })

  await t.test('默认选中的自定义 Profile 可删，删除后选择真实存在的环境', async () => {
    const custom = makeProfile(home, 'work')
    await api('/api/settings', { profile: 'work' })
    assert.equal((await api('/api/packs')).packs.find((entry) => entry.profile === 'work').removable, true)
    const result = await api('/api/profiles/delete', { profile: 'work' })
    assert.equal(existsSync(custom), false)
    assert.notEqual(result.profile, 'work')
    assert.ok(existsSync(join(home, 'profiles', result.profile, 'package.json')))
    assert.ok(!(await api('/api/state')).profiles.includes('work'))
    assert.notEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).profile, 'work')
  })
})
