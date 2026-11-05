import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 这些用例先于实现编写：只依赖公开返回结构，不复用启动器自己的兼容性算法。
const TARGET = '0.2.1-rc.3'
const DSH = '@deepseek-ai/dsh'
const SESSION = '@deepseek-ai/dsh-session'
const plugin = (name, requirements = {}) => ({ name, version: '3.4.5', ...requirements })
const byName = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name))

function fixture(t, packages, { missing = [], patch = '[]\n', manifest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pre-update-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const names = [...Object.keys(packages), ...missing]
  writeFileSync(join(dir, 'package.json'), manifest ?? JSON.stringify({
    dependencies: Object.fromEntries(names.map((name) => [name, '^1.0.0'])),
    dsh: { profile: { bundles: names } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  for (const [name, pkg] of Object.entries(packages)) {
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
  }
  return dir
}

function snapshot(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const relative = join(prefix, entry.name)
    return entry.isDirectory() ? snapshot(join(dir, entry.name), relative) : [[relative, readFileSync(join(dir, entry.name), 'utf8')]]
  })
}

async function check(...args) {
  const { checkPluginCompatibility } = await import('../src/pre-update.js')
  assert.equal(typeof checkPluginCompatibility, 'function', '公开兼容性检查入口必须存在')
  return checkPluginCompatibility(...args)
}

function predicate(answers, calls = []) {
  return (version, range) => {
    calls.push({ version, range })
    assert.ok(Object.hasOwn(answers, range), '只允许把真实 Harness 约束交给注入的 range 判断器: ' + range)
    return answers[range]
  }
}

test('EP/BVA: zero installed plugins yields a complete empty report, without mutation', async (t) => {
  const dir = fixture(t, {})
  const before = snapshot(dir)
  assert.deepEqual(await check(dir, TARGET, () => assert.fail('空集合不应判断范围')), { version: TARGET, plugins: [], incompatible: [], errors: [] })
  assert.deepEqual(snapshot(dir), before)
})

test('Decision R1/R2: own engines.dsh overrides both compatible and incompatible Harness peers', async (t) => {
  const dir = fixture(t, {
    'engine-wins': plugin('engine-wins', { engines: { dsh: '>=0.2.0' }, peerDependencies: { [DSH]: '<0.2.0', [SESSION]: '<0.2.0' } }),
    'engine-blocks': plugin('engine-blocks', { engines: { dsh: '<0.2.0' }, peerDependencies: { [DSH]: '>=0.2.0' } }),
  })
  const report = await check(dir, TARGET, predicate({ '>=0.2.0': true, '<0.2.0': false }))
  assert.deepEqual(byName(report.plugins), [
    { name: 'engine-blocks', version: '3.4.5', requirements: { 'engines.dsh': '<0.2.0' } },
    { name: 'engine-wins', version: '3.4.5', requirements: { 'engines.dsh': '>=0.2.0' } },
  ])
  assert.deepEqual(report.incompatible.map((item) => item.name), ['engine-blocks'])
  assert.deepEqual(report.errors, [])
})

test('Decision R3/R4: all dsh and dsh-* peers are required, unrelated peers and direct dependencies are not requirements', async (t) => {
  const requirements = { [DSH]: '>=0.2.0', [SESSION]: '<0.2.0' }
  const dir = fixture(t, {
    'multi-peer': plugin('multi-peer', { peerDependencies: { ...requirements, '@deepseek-ai/dshx': '<0.0.1', react: '^19.0.0' }, dependencies: { [DSH]: '<0.0.1' } }),
    'no-range': plugin('no-range', { engines: { node: '>=100' }, peerDependencies: { react: '^19.0.0' } }),
  })
  const calls = []
  const report = await check(dir, TARGET, predicate({ '>=0.2.0': true, '<0.2.0': false }, calls))
  assert.deepEqual(report.plugins.find((item) => item.name === 'multi-peer'), { name: 'multi-peer', version: '3.4.5', requirements })
  assert.deepEqual(report.plugins.find((item) => item.name === 'no-range').requirements, {})
  assert.deepEqual(report.incompatible, [{ name: 'multi-peer', version: '3.4.5', requirements: { [SESSION]: '<0.2.0' } }])
  assert.deepEqual(new Set(calls.map((call) => call.range)), new Set(Object.values(requirements)))
})

for (const range of ['workspace:^', 'workspace:~', 'workspace:*']) {
  test('EP: special peer ' + range + ' satisfies without being sent to semver', async (t) => {
    const dir = fixture(t, { workspace: plugin('workspace', { peerDependencies: { [DSH]: range } }) })
    const report = await check(dir, TARGET, () => assert.fail('workspace peer 已由 Harness 约定满足'))
    assert.deepEqual(report.plugins, [{ name: 'workspace', version: '3.4.5', requirements: { [DSH]: range } }])
    assert.deepEqual(report.incompatible, [])
    assert.deepEqual(report.errors, [])
  })
}

test('EP: all installed plugins including disabled bundles are checked, using installed rather than dependency spec versions', async (t) => {
  const dir = fixture(t, {
    enabled: plugin('enabled', { peerDependencies: { [DSH]: '>=0.2.0' } }),
    '@scope/disabled': plugin('@scope/disabled', { engines: { dsh: '<0.2.0' } }),
  }, { patch: '- id: disabled-row\n  disabled: true\n' })
  const before = snapshot(dir)
  const report = await check(dir, TARGET, predicate({ '>=0.2.0': true, '<0.2.0': false }))
  assert.deepEqual(new Set(report.plugins.map((item) => item.name)), new Set(['enabled', '@scope/disabled']))
  assert.deepEqual(report.incompatible, [{ name: '@scope/disabled', version: '3.4.5', requirements: { 'engines.dsh': '<0.2.0' } }])
  assert.deepEqual(snapshot(dir), before, '检查不能写补丁、清单、锁或恢复备份')
})

for (const [version, compatible] of [['0.1.9', false], ['0.2.0', true], ['0.2.1', true]]) {
  test('BVA: lower inclusive boundary >=0.2.0 at ' + version, async (t) => {
    const dir = fixture(t, { bounded: plugin('bounded', { peerDependencies: { [DSH]: '>=0.2.0' } }) })
    const calls = []
    const report = await check(dir, version, predicate({ '>=0.2.0': compatible }, calls))
    assert.equal(report.version, version)
    assert.equal(report.incompatible.length, compatible ? 0 : 1)
    assert.deepEqual(calls, [{ version, range: '>=0.2.0' }])
  })
}

test('EP: prerelease target and nontrivial ranges are passed unchanged to injected semver', async (t) => {
  const ranges = { [DSH]: '^0.2.0 || >=0.3.0-rc.1', [SESSION]: '>=0.2.1-rc.2 <0.3.0' }
  const dir = fixture(t, { prerelease: plugin('prerelease', { peerDependencies: ranges }) })
  const calls = []
  const report = await check(dir, TARGET, predicate(Object.fromEntries(Object.values(ranges).map((range) => [range, true])), calls))
  assert.deepEqual(report.incompatible, [])
  assert.deepEqual(report.errors, [])
  assert.deepEqual(new Set(calls.map((item) => item.version)), new Set([TARGET]))
  assert.deepEqual(new Set(calls.map((item) => item.range)), new Set(Object.values(ranges)))
})

test('EP: missing and invalid installed manifests are errors while valid peers are still checked', async (t) => {
  const dir = fixture(t, { good: plugin('good'), broken: '{ not json' }, { missing: ['missing'] })
  const report = await check(dir, TARGET, () => assert.fail('无真实范围'))
  assert.deepEqual(report.plugins, [{ name: 'good', version: '3.4.5', requirements: {} }])
  assert.deepEqual(new Set(report.errors.map((item) => item.name)), new Set(['broken', 'missing']))
  for (const item of report.errors) assert.ok(typeof item.error === 'string' && item.error.length > 0)
})

for (const manifest of ['{ invalid json', 'null', '[]']) {
  test('EP: invalid profile manifest is reported as incomplete, not an empty compatible profile: ' + manifest, async (t) => {
    const dir = fixture(t, {}, { manifest })
    const report = await check(dir, TARGET, () => true)
    assert.ok(report.errors.length > 0, '无效 profile 清单不允许返回完整兼容结果')
  })
}

for (const [label, manifest] of [
  ['non-object package', '[]'],
  ['missing installed version', { name: 'invalid' }],
  ['nonstring own engine', plugin('invalid', { engines: { dsh: null }, peerDependencies: { [DSH]: '>=0.2.0' } })],
  ['nonstring Harness peer', plugin('invalid', { peerDependencies: { [DSH]: 42 } })],
]) {
  test('EP: invalid installed manifest ' + label + ' is an error, not compatible', async (t) => {
    const dir = fixture(t, { invalid: manifest })
    const report = await check(dir, TARGET, () => true)
    assert.equal(report.errors.length, 1)
    assert.equal(report.errors[0].name, 'invalid')
    assert.ok(report.errors[0].error)
  })
}

test('EP: injected semver failure is an incomplete plugin check rather than green', async (t) => {
  const dir = fixture(t, { unknown: plugin('unknown', { peerDependencies: { [DSH]: '>=0.2.0' } }) })
  const report = await check(dir, TARGET, () => { throw new Error('range evaluator unavailable') })
  assert.deepEqual(report.errors, [{ name: 'unknown', error: 'range evaluator unavailable' }])
})

test('EP: missing profile manifest is reported as an error, without creating the profile', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pre-update-missing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const report = await check(join(root, 'not-initialized'), TARGET, () => true)
  assert.ok(report.errors.length > 0)
  assert.deepEqual(readdirSync(root), [])
})
