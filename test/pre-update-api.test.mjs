import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const LOCAL = '0.2.0'
const TARGET = '0.2.1-rc.3'
const ENDPOINT = '/api/plugins/check-compatibility'
const DSH = '@deepseek-ai/dsh'

function json(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function profile(home, name, pluginName, range) {
  const dir = join(home, 'profiles', name)
  json(join(dir, 'package.json'), { dependencies: { [pluginName]: '^1.0.0' }, dsh: { profile: { bundles: [pluginName] } } })
  json(join(dir, 'node_modules', pluginName, 'package.json'), { name: pluginName, version: '1.4.2', peerDependencies: { [DSH]: range }, dsh: { bundle: { patch: 'cordis.patch.yml' } } })
  writeFileSync(join(dir, 'node_modules', pluginName, 'cordis.patch.yml'), '- insert:\n    - id: disabled-row\n      name: disabled-row\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: disabled-row\n  disabled: true\n')
  writeFileSync(join(dir, 'cordis.patch.yml.bak-123'), 'recovery must remain unchanged\n')
  return dir
}

function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((item) => {
    const path = join(dir, item.name)
    const key = join(prefix, item.name)
    return item.isDirectory() ? files(path, key) : [[key, readFileSync(path, 'utf8')]]
  })
}

test('HTTP EP/State: draft home and selected profile are checked read-only using local semver for an uninstalled target', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pre-update-api-'))
  const app = isolateUserHome(root)
  const data = join(root, 'data')
  const globalHome = join(root, 'global')
  const draftHome = join(root, '未保存目录')
  const globalDir = profile(globalHome, 'web', 'global-only', '>=0.2.0')
  const draftDir = profile(draftHome, 'web', '@scope/disabled-draft', '<0.2.0')
  const otherDir = profile(draftHome, 'other', 'other-profile', '>=0.2.0')
  mkdirSync(app, { recursive: true })
  const settingsFile = join(app, 'settings.json')
  json(settingsFile, { dataDir: data, dshHome: globalHome, profile: 'web', seedMarket: false, systemPath: false,
    launchPresets: [{ id: '1111111111111111', name: 'saved', version: LOCAL, profile: 'web' }] })
  const lib = join(data, 'versions', LOCAL, 'node_modules', '@deepseek-ai', 'dsh')
  json(join(lib, 'package.json'), { name: DSH, version: LOCAL, type: 'module' })
  mkdirSync(join(lib, 'lib'), { recursive: true })
  writeFileSync(join(lib, 'lib', 'bin.js'), 'throw new Error("compatibility checks must never launch dsh")\n')
  // 假 semver 只规定测试数据的答案；强制 includePrerelease 验证适配层没有丢掉 Harness 选项。
  const appBoot = join(lib, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  json(join(appBoot, 'package.json'), { name: '@deepseek-ai/dsh-app-boot', version: LOCAL, main: 'index.cjs' })
  writeFileSync(join(appBoot, 'index.cjs'), 'throw new Error("must resolve app-boot without importing or booting it")\n')
  const semver = join(appBoot, 'node_modules', 'semver')
  assert.equal(existsSync(join(lib, 'node_modules', 'semver')), false, '严格 pnpm 布局只有 app-boot 的依赖树能解析 semver')
  json(join(semver, 'package.json'), { name: 'semver', version: '7.0.0', main: 'index.js' })
  writeFileSync(join(semver, 'index.js'),
    'exports.valid = (version) => /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null; exports.satisfies = (version, range, options) => { if (version !== "' + TARGET + '") throw new Error("wrong target"); if (!options?.includePrerelease) throw new Error("prereleases excluded"); if (range === ">=0.2.0") return true; if (range === "<0.2.0") return false; throw new Error("unexpected range"); };\n')
  json(join(data, 'config.json'), { versions: [LOCAL] })
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise((resolve) => probe.close(resolve))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const request = async (body, home) => {
    const response = await fetch(origin + ENDPOINT, { method: 'POST', headers: {
      origin, 'content-type': 'application/json', ...(home ? { 'x-dsh-home': encodeURIComponent(home) } : {}),
    }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const before = [files(globalDir), files(draftDir), files(otherDir), readFileSync(settingsFile, 'utf8')]
  await t.test('EP: unsaved draft directory is not replaced with persisted launch home; disabled plugin is included', async () => {
    const listing = await fetch(origin + '/api/plugins?profile=web', { headers: { origin, 'x-dsh-home': encodeURIComponent(draftHome) } })
    assert.equal(listing.status, 200)
    assert.equal((await listing.json()).plugins.find((item) => item.name === '@scope/disabled-draft').enabled, false, '先确认夹具确实禁用，而不只是有一份补丁')
    const { status, data: report } = await request({ version: TARGET, profile: 'web' }, draftHome)
    assert.equal(status, 200, JSON.stringify(report))
    assert.equal(report.version, TARGET)
    assert.deepEqual(report.plugins, [{ name: '@scope/disabled-draft', version: '1.4.2', requirements: { [DSH]: '<0.2.0' } }])
    assert.deepEqual(report.incompatible, report.plugins)
    assert.deepEqual(report.errors, [])
  })
  await t.test('State: same directory another profile then global profile do not reuse previous report', async () => {
    for (const [home, profileName, name] of [[draftHome, 'other', 'other-profile'], [undefined, 'web', 'global-only']]) {
      const { status, data: report } = await request({ version: TARGET, profile: profileName }, home)
      assert.equal(status, 200, JSON.stringify(report))
      assert.deepEqual(report.plugins.map((item) => item.name), [name])
      assert.deepEqual(report.incompatible, [])
      assert.deepEqual(report.errors, [])
    }
  })
  await t.test('EP: invalid installed manifest reports an incomplete result rather than green', async () => {
    const file = join(draftDir, 'node_modules', '@scope', 'disabled-draft', 'package.json')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, '{ invalid json')
    try {
      const { status, data: report } = await request({ version: TARGET, profile: 'web' }, draftHome)
      assert.equal(status, 200, JSON.stringify(report))
      assert.equal(report.errors.length, 1)
      assert.equal(report.errors[0].name, '@scope/disabled-draft')
      assert.ok(report.errors[0].error)
    } finally { writeFileSync(file, original) }
  })
  await t.test('EP: empty target and path-traversal profile are rejected independently', async () => {
    for (const body of [{ version: '', profile: 'web' }, { version: TARGET, profile: '../outside' }]) {
      const { status, data } = await request(body, draftHome)
      assert.ok(status >= 400, JSON.stringify(data))
      assert.ok(data.error)
    }
  })
  assert.deepEqual([files(globalDir), files(draftDir), files(otherDir), readFileSync(settingsFile, 'utf8')], before, '不能保存、启动、禁用插件或更改恢复备份')
  assert.equal(existsSync(join(data, 'versions', TARGET)), false, '检查未安装版本不能触发安装')
})
