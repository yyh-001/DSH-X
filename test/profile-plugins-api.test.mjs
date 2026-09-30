import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'

test('查看与开关指定 profile 的插件，不改变启动默认值或其它 profile', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-plugins-'))
  const home = join(root, 'home')
  const app = join(root, 'DSH')
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  process.env.APPDATA = root
  process.env.PORT = String(port)
  const settings = { dataDir: join(root, 'data'), dshHome: home, profile: 'web', seedMarket: false, seedBundled: false }
  writeFileSync(join(app, 'settings.json'), JSON.stringify(settings))
  for (const profile of ['web', 'work']) {
    const dir = join(home, 'profiles', profile)
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
  const call = async (path, body) => {
    const response = await fetch(origin + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    } : { headers: { origin } })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return data
  }
  const view = await call('/api/plugins?profile=work')
  assert.equal(view.profile, 'work')
  assert.equal(view.plugins.find((plugin) => plugin.name === 'demo-plugin').enabled, true)
  const changed = await call('/api/plugins/toggle', { name: 'demo-plugin', enabled: false, profile: 'work' })
  assert.equal(changed.profile, 'work')
  assert.equal(changed.plugins.find((plugin) => plugin.name === 'demo-plugin').enabled, false)
  assert.match(readFileSync(join(home, 'profiles', 'work', 'cordis.patch.yml'), 'utf8'), /disabled: true/)
  assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n')
  assert.equal((await call('/api/plugins?profile=web')).plugins.find((plugin) => plugin.name === 'demo-plugin').enabled, true)
  assert.equal((await call('/api/settings')).profile, 'web')
  assert.equal(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8')).profile, 'web')
  const recovered = await call('/api/recover', { profile: 'work' })
  assert.equal(recovered.profile, 'work')
  assert.equal(recovered.recovery.profile, 'work')
  assert.equal((await call('/api/settings')).profile, 'web')
  const restored = await call('/api/recover/restore', { profile: 'work', backup: recovered.backup })
  assert.equal(restored.profile, 'work')
  assert.equal(restored.plugins.find((plugin) => plugin.name === 'demo-plugin').enabled, false)
  const invalid = await fetch(origin + '/api/plugins?profile=../outside', { headers: { origin } })
  assert(invalid.status >= 400)
})
