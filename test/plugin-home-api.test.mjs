import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('按用户目录查看和修改同名 Profile；中文目录、空目录和最后一个 Profile 都不串到全局', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-home-'))
  const globalHome = join(root, 'global')
  const home = join(root, '独立目录')
  const emptyHome = join(root, 'empty')
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
  process.env.PORT = String(port)
  const settings = { dataDir: join(root, 'data'), dshHome: globalHome, profile: 'web', seedMarket: false }
  writeFileSync(join(app, 'settings.json'), JSON.stringify(settings))
  for (const target of [globalHome, home]) {
    const dir = join(target, 'profiles', 'web')
    const pkg = join(dir, 'node_modules', 'demo-plugin')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin'] } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: demo-row\n      name: demo-plugin\n')
  }
  const server = await import('../server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const call = async (path, target, body) => {
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', ...(target ? { 'x-dsh-home': encodeURIComponent(target) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return data
  }
  const [globalView, independentView, emptyView] = await Promise.all([
    call('/api/plugins?profile=web'), call('/api/plugins?profile=web', home), call('/api/plugins?profile=web', emptyHome),
  ])
  await Promise.all([call('/api/dsh-homes/add', null, { home }), call('/api/dsh-homes/add', null, { home: emptyHome })])
  await call('/api/dsh-homes/add', null, { home })
  assert.deepEqual(new Set((await call('/api/state')).dshHomes), new Set([home, emptyHome]))
  assert.deepEqual(new Set(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8')).dshHomes), new Set([home, emptyHome]), '目录列表持久保存且并发添加不丢失')
  await call('/api/dsh-homes/remove', null, { home })
  assert(existsSync(join(home, 'profiles', 'web', 'package.json')), '移除目录保留插件和 Profile 数据')
  assert.deepEqual((await call('/api/state')).dshHomes, [emptyHome])
  for (const body of [{ home: globalHome }, { home: 'relative/path' }]) {
    const rejected = await fetch(origin + '/api/dsh-homes/remove', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(rejected.status, 500)
    assert((await rejected.json()).error)
  }
  const { saveSettings } = await import('../settings.js')
  for (const home of ['relative/path', join(root, 'unregistered'), emptyHome]) {
    const rejected = await fetch(origin + '/api/dsh-homes/open', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ home }) })
    assert.equal(rejected.status, 500, '无效、未登记和不存在的目录不能交给系统打开')
    assert((await rejected.json()).error)
  }
  await saveSettings({ launchPresets: [{ id: '1234567890abcdef', name: '独立启动项', version: 'auto', profile: 'web', dshHome: home }] })
  const inUse = await fetch(origin + '/api/dsh-homes/remove', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ home }) })
  assert.equal(inUse.status, 500)
  assert.match((await inUse.json()).error, /启动项正在使用/)
  assert.equal((await call('/api/state')).launchPresets.find((entry) => entry.id === '1234567890abcdef').dshHome, home)
  await saveSettings({ launchPresets: [] })
  assert.equal(globalView.home, globalHome)
  assert.equal(independentView.home, home)
  assert.deepEqual(independentView.profiles, ['web'])
  assert.deepEqual(emptyView.profiles, [])
  assert.deepEqual(emptyView.packs, [])
  const changed = await call('/api/plugins/toggle', home, { name: 'demo-plugin', enabled: false, profile: 'web' })
  assert.equal(changed.plugins.find((plugin) => plugin.name === 'demo-plugin').enabled, false)
  assert.equal(readFileSync(join(globalHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.match(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /disabled: true/)
  const created = await call('/api/profiles/create', emptyHome, { profile: 'new-work' })
  assert.deepEqual(created.profiles, ['new-work'])
  assert(existsSync(join(emptyHome, 'profiles', 'new-work', 'package.json')))
  assert(!existsSync(join(globalHome, 'profiles', 'new-work')))
  const deleted = await call('/api/profiles/delete', home, { profile: 'web' })
  assert.deepEqual(deleted.profiles, [])
  assert.deepEqual(deleted.packs, [])
  assert(existsSync(join(globalHome, 'profiles', 'web', 'package.json')))
  await call('/api/profiles/create', home, { profile: 'replacement' })
  assert(existsSync(join(home, 'profiles', 'replacement', 'package.json')))
  const config = JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8'))
  assert.equal(config.dshHome, globalHome)
  assert.equal(config.profile, 'web')
  assert.equal((await call('/api/state', home)).dshHome, globalHome, '状态推送仍描述全局设置')
  const beforeOrder = [
    (await call('/api/state')).launchPresets[0],
    { id: '1111111111111111', name: '独立一', version: '0.1.0', profile: 'web', port: 45678, dshHome: home },
    { id: '2222222222222222', name: '独立二', version: '0.2.0', profile: 'replacement', port: 0, dshHome: home },
  ]
  await saveSettings({ launchPresets: beforeOrder })
  const ids = beforeOrder.map((entry) => entry.id).reverse()
  const ordered = await call('/api/launch-presets/reorder', null, { ids })
  assert.deepEqual(ordered.launchPresets.map((entry) => entry.id), ids, '内置项也可移动')
  assert.deepEqual((await call('/api/state')).launchPresets, ordered.launchPresets)
  assert.deepEqual(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8')).launchPresets, [...beforeOrder].reverse(), '只保存排列，版本、端口和目录完整保留')
  for (const badIds of [ids.slice(1), [ids[0], ids[0], ids[2]], [...ids, 'unknown'], null]) {
    const invalid = await fetch(origin + '/api/launch-presets/reorder', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ids: badIds }) })
    assert.equal(invalid.status, 500)
    assert.match((await invalid.json()).error, /列表已变化/)
    assert.deepEqual((await call('/api/state')).launchPresets.map((entry) => entry.id), ids)
  }
  await Promise.all([
    call('/api/launch-presets/reorder', null, { ids: beforeOrder.map((entry) => entry.id) }),
    call('/api/launch-presets', null, { ...beforeOrder[1], name: '同时改名' }),
  ])
  assert.deepEqual((await call('/api/state')).launchPresets.map((entry) => entry.id), beforeOrder.map((entry) => entry.id))
  assert.equal((await call('/api/state')).launchPresets[1].name, '同时改名')
  for (const header of ['relative/path', '%invalid']) {
    const invalid = await fetch(origin + '/api/plugins', { headers: { origin, 'x-dsh-home': header } })
    assert.equal(invalid.status, 400)
  }
})
