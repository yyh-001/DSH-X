/**
 * 用环境启动（系统测试）：进程内真服务 + 会记账的假 dsh（见 environments-fixture.mjs 的 recordingBin）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   - 带启动项 id 启动、启动项绑了环境 E：拉起 dsh 之前把 Profile 的 package.json 里 dependencies 与 dsh.profile.bundles
 *     换成 E 的有效列表（其余字段不动）；只有列表变了才跑 `dsh plugin … install`，没变化的第二次启动不再装
 *   - 装依赖失败 → 启动失败（HTTP 报错），package.json 按字节还原
 *   - 并发：同目录同 Profile 已有实例在跑、插件列表不同 → 另一个环境的启动项被拒；列表相同只版本不同 → 允许，两个都跑
 *   - 实例停止 / 退出后：运行期间 Profile 里插件的增删并进当时应用的那个环境（GET /api/environments 可见）
 *   - 不带启动项 id（只带 x-dsh-home）的启动不改写 Profile
 *
 * 设计：决策表（列表变没变 × 装依赖成败）、状态迁移（停 → 起 → 停 → 再起；失败 → 修好 → 成功；
 * A 在跑 → B 被拒 → C 并存 → 全停 → B 能起）、等价类（同目录 / 不同目录；停止 / 意外退出）。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import {
  BASE, WEB, bootCalls, installCalls, profileManifest, profileManifestPath, readJson, recordingBin, seedProfile,
  setPluginExit, waitFor,
} from './environments-fixture.mjs'

const env = await startChannelServer({
  prefix: 'dsh-env-launch-',
  packument: packumentOf({ latest: '1.2.0' }, ['1.0.0', '1.1.0', '1.2.0']),
  installed: ['1.0.0', '1.1.0', '1.2.0'],
  bin: recordingBin,
})
test.after(() => env.cleanup())

// ---------------------------------------------------------------- 驱动件

async function okPost(path, body, headers) {
  const result = await env.call(path, body, headers)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
const createEnv = async (name, dshVersion, specs = []) => {
  const { environment } = await okPost('/api/environments/create', { name, dshVersion })
  for (const spec of specs) await okPost('/api/environments/plugins/add', { id: environment.id, spec })
  return environment
}
const envView = async (id) => (await env.getJson('/api/environments')).environments.find((item) => item.id === id)
const depsOf = (view) => Object.fromEntries((view?.plugins || []).filter((item) => item.spec).map((item) => [item.name, item.spec]))
/** 依赖表比较：顺序无关。 */
const sameDeps = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
const savePreset = (body) => okPost('/api/launch-presets', body).then((data) => data.entry)
const launchHeader = (entry) => ({ 'x-dsh-launch-id': entry.id })
const homeOf = (entry) => entry.dshHome || env.home
const startEntry = (entry) => env.call('/api/start', { version: entry.version, profile: entry.profile }, launchHeader(entry))
const stopEntry = (entry) => okPost('/api/stop', { version: entry.version, profile: entry.profile, home: homeOf(entry) }, launchHeader(entry))
async function mustStart(entry) {
  const result = await startEntry(entry)
  assert.ok(result.ok, `启动「${entry.name}」失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
const live = async (home, profile) => (await env.state()).instances
  .filter((item) => item.home === home && item.profile === profile && ['starting', 'running'].includes(item.status))
const listIn = (home, profile) => {
  const manifest = readJson(profileManifestPath(home, profile))
  return { dependencies: manifest.dependencies || {}, bundles: manifest.dsh?.profile?.bundles || [] }
}
const listOfText = (text) => {
  const manifest = JSON.parse(text)
  return { dependencies: manifest.dependencies || {}, bundles: manifest.dsh?.profile?.bundles || [] }
}
/** 模拟用户在 dsh 里装 / 卸插件：直接改 Profile 的 package.json。 */
function editInDsh(home, profile, { add = {}, drop = [] }) {
  const file = profileManifestPath(home, profile)
  const manifest = readJson(file)
  manifest.dependencies = { ...(manifest.dependencies || {}), ...add }
  for (const name of drop) delete manifest.dependencies[name]
  const bundles = (manifest.dsh.profile.bundles || []).filter((name) => !drop.includes(name))
  for (const name of Object.keys(add)) if (!bundles.includes(name)) bundles.push(name)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(file, JSON.stringify(manifest, null, 2))
}

// ---------------------------------------------------------------- 启动前写清单

test('启动前写清单：Profile 的插件列表换成环境的，其余字段不动；先写清单再装依赖再启动', async () => {
  const profile = 'wbl'
  seedProfile(env.home, profile, profileManifest(profile, { dependencies: { 'dsh-x-old': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-old'] }))
  const before = readJson(profileManifestPath(env.home, profile))
  const target = await createEnv('写清单', '1.0.0', ['dsh-x-new@2.0.0'])
  const entry = await savePreset({ name: '写清单', version: '1.0.0', profile, environment: target.id })
  await mustStart(entry)

  const expected = { dependencies: { 'dsh-x-new': '2.0.0' }, bundles: [BASE, WEB, 'dsh-x-new'] }
  assert.deepEqual(listIn(env.home, profile), expected, 'Profile 里的插件列表要换成环境的')
  const after = readJson(profileManifestPath(env.home, profile))
  for (const key of ['name', 'private', 'marker', 'pnpm']) assert.deepEqual(after[key], before[key], `${key} 要原样保留`)
  assert.equal(after.dsh.profile.patchReload, true, 'dsh.profile 里的其他键原样保留')

  const installs = installCalls(env.home, profile)
  const boots = bootCalls(env.home, profile)
  assert.equal(installs.length, 1, '列表变了，要装一次依赖')
  assert.deepEqual(listOfText(installs[0].manifest), expected, '装依赖时清单已经是新的（先写后装）')
  assert.equal(boots.length, 1)
  assert.deepEqual(listOfText(boots[0].manifest), expected, 'dsh 起来时看到的是新清单')
  assert.ok(installs[0].at <= boots[0].at, '装依赖在启动之前')
  await stopEntry(entry)
})

test('启动前写清单：列表没变的第二次启动不再装依赖', async () => {
  const entry = (await env.state()).launchPresets.find((item) => item.name === '写清单')
  assert.ok(entry, '沿用上一个用例的启动项')
  const installsBefore = installCalls(env.home, 'wbl').length
  await mustStart(entry)
  assert.equal(installCalls(env.home, 'wbl').length, installsBefore, '没有变化就不该再跑 dsh plugin install')
  assert.equal(bootCalls(env.home, 'wbl').length, 2, '照常启动')
  await stopEntry(entry)
})

// 中文日志里新对象叫「实例」、dsh profile 叫「配置」，前缀是 [实例]（不再是 [环境]）
test('启动日志：套用实例时写 [实例] 前缀，点名实例和配置', async () => {
  const logs = await (await fetch(env.origin + '/api/logs/export')).text()
  assert.match(logs, /\[实例\] 把实例「写清单」的插件清单写进配置「wbl」，安装依赖…/, '写清单那一步')
  assert.match(logs, /\[实例\] 配置「wbl」已换成实例「写清单」的插件清单/, '写完那一步')
  assert.doesNotMatch(logs, /\[环境\]/, '旧前缀不再出现')
  assert.doesNotMatch(logs, /写进 Profile|profile「wbl」/, 'dsh profile 在中文日志里叫配置')
})

test('启动前写清单：Profile 本来就和环境一致时，第一次启动也不装、不改写文件', async () => {
  const profile = 'already'
  seedProfile(env.home, profile, profileManifest(profile, { dependencies: { 'dsh-x-memory': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-memory'] }))
  const bytes = readFileSync(profileManifestPath(env.home, profile))
  // 不带 environment：按 Profile 派生，列表与 Profile 一致
  const entry = await savePreset({ name: '本来一致', version: '1.0.0', profile })
  assert.ok(entry.environment, '有清单的 Profile 要自动绑上环境')
  await mustStart(entry)
  assert.equal(installCalls(env.home, profile).length, 0, '列表一致不该装依赖')
  assert.ok(readFileSync(profileManifestPath(env.home, profile)).equals(bytes), '列表一致不该改写 package.json')
  await stopEntry(entry)
})

// ---------------------------------------------------------------- 装依赖失败

test('装依赖失败：启动报错、package.json 按字节还原、dsh 没被拉起；修好后再启动就装上并起来', async () => {
  const profile = 'fail'
  // 故意不用标准格式：还原必须是按字节的，重新序列化一遍就会对不上
  const original = '{"name":"dsh-profile-fail",  "private":true,\n  "dependencies":{"dsh-x-old":"1.0.0"},\n"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-x-old"]}}}'
  seedProfile(env.home, profile, original)
  const target = await createEnv('装不上', '1.0.0', ['dsh-x-broken@1.0.0'])
  const entry = await savePreset({ name: '装不上', version: '1.0.0', profile, environment: target.id })
  setPluginExit(env.home, 1)
  let result
  try {
    result = await startEntry(entry)
  } finally {
    setPluginExit(env.home, 0)
  }
  assert.equal(result.ok, false, `装依赖失败时启动要报错，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(typeof result.data?.error, 'string')
  assert.ok(installCalls(env.home, profile).length >= 1, '确实尝试过装依赖')
  assert.equal(readFileSync(profileManifestPath(env.home, profile), 'utf8'), original, 'package.json 要按字节还原')
  assert.equal(bootCalls(env.home, profile).length, 0, '装失败就不该拉起 dsh（否则插件静默加载不了）')
  assert.deepEqual(await live(env.home, profile), [], '不能留下在跑的实例')
  assert.deepEqual(depsOf(await envView(target.id)), { 'dsh-x-broken': '1.0.0' }, '环境本身不受失败影响')

  const installs = installCalls(env.home, profile).length
  await mustStart(entry)
  assert.equal(installCalls(env.home, profile).length, installs + 1, '列表仍不一致，修好后要重新装')
  assert.deepEqual(listIn(env.home, profile), { dependencies: { 'dsh-x-broken': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-broken'] })
  assert.equal(bootCalls(env.home, profile).length, 1)
  await stopEntry(entry)
})

// ---------------------------------------------------------------- 并发约束

test('并发：同 Profile 在跑时，插件列表不同的环境被拒；列表相同只版本不同的可以并存；别的目录不受限', async () => {
  const profile = 'shared'
  seedProfile(env.home, profile, profileManifest(profile))
  const otherHome = join(env.root, 'home-other')
  seedProfile(otherHome, profile, profileManifest(profile))
  const sameA = await createEnv('并发 A', '1.0.0')
  const differentB = await createEnv('并发 B', '1.1.0', ['dsh-x-other@1.0.0'])
  const { environment: sameC } = await okPost('/api/environments/create', { name: '并发 C', from: sameA.id })
  await okPost('/api/environments/update', { id: sameC.id, dshVersion: '1.2.0' })
  const a = await savePreset({ name: '并发甲', version: '1.0.0', profile, environment: sameA.id })
  const b = await savePreset({ name: '并发乙', version: '1.1.0', profile, environment: differentB.id })
  const c = await savePreset({ name: '并发丙', version: '1.2.0', profile, environment: sameC.id })
  const d = await savePreset({ name: '并发丁', version: '1.1.0', profile, dshHome: otherHome, environment: differentB.id })
  try {
    await mustStart(a)
    const bytes = readFileSync(profileManifestPath(env.home, profile))

    const rejected = await startEntry(b)
    assert.equal(rejected.ok, false, `插件列表不同的环境不能和在跑的实例共用 Profile：HTTP ${rejected.status} ${JSON.stringify(rejected.data)}`)
    assert.equal(typeof rejected.data?.error, 'string', '要说明原因')
    assert.match(rejected.data.error, /^配置「shared」正在被插件清单不同的实例使用（1\.0\.0）/, '报错把 dsh profile 叫配置')
    assert.ok(readFileSync(profileManifestPath(env.home, profile)).equals(bytes), '被拒时不能动正在用的 Profile 清单')
    assert.deepEqual((await live(env.home, profile)).map((item) => item.version), ['1.0.0'], '被拒的那个没有起来')

    await mustStart(c)
    const versions = (await live(env.home, profile)).map((item) => item.version).sort()
    assert.deepEqual(versions, ['1.0.0', '1.2.0'], '列表相同、版本不同的两个实例并存')

    await mustStart(d)
    assert.equal((await live(otherHome, profile)).length, 1, '别的目录里的同名 Profile 不受这条约束')
  } finally {
    for (const entry of [a, b, c, d]) await env.call('/api/stop', { version: entry.version, profile, home: homeOf(entry) }, launchHeader(entry))
  }
  // 全停之后，原先被拒的那个能起来
  await mustStart(b)
  assert.deepEqual(listIn(env.home, profile).dependencies, { 'dsh-x-other': '1.0.0' })
  await stopEntry(b)
})

// ---------------------------------------------------------------- 停止后并回环境

test('停止后：运行期间在 dsh 里装 / 卸的插件并进当时应用的环境；之后再启动不必重装', async () => {
  const profile = 'fold'
  seedProfile(env.home, profile, profileManifest(profile))
  const target = await createEnv('并回', '1.0.0', ['dsh-x-keep@1.0.0', 'dsh-x-drop@1.0.0'])
  const entry = await savePreset({ name: '并回', version: '1.0.0', profile, environment: target.id })
  await mustStart(entry)
  editInDsh(env.home, profile, { add: { 'dsh-x-added': '3.0.0' }, drop: ['dsh-x-drop'] })
  await stopEntry(entry)

  const expected = { 'dsh-x-keep': '1.0.0', 'dsh-x-added': '3.0.0' }
  const view = await waitFor(async () => {
    const current = await envView(target.id)
    return sameDeps(depsOf(current), expected) ? current : null
  }, `停止后环境应变成 ${JSON.stringify(expected)}`).catch(async (error) => {
    assert.fail(`${error.message}；实际依赖：${JSON.stringify(depsOf(await envView(target.id)))}`)
  })
  assert.deepEqual(depsOf(view), expected)
  assert.ok(view.bundles.includes('dsh-x-added'), '新装的插件也进 bundles')
  assert.ok(!view.bundles.includes('dsh-x-drop'), '卸掉的插件从 bundles 去掉')
  const logs = await (await fetch(env.origin + '/api/logs/export')).text()
  assert.match(logs, /\[实例\] 配置「fold」里的插件改动记进实例「并回」：新增 1，换版本 0，删除 1/, '并回的日志说实例和配置')

  const installs = installCalls(env.home, profile).length
  await mustStart(entry)
  assert.equal(installCalls(env.home, profile).length, installs, '环境已经和 Profile 一致，再启动不必重装')
  await stopEntry(entry)
})

test('意外退出后：同样把运行期间的插件改动并进环境', async () => {
  const profile = 'fold-exit'
  seedProfile(env.home, profile, profileManifest(profile))
  const target = await createEnv('意外退出', '1.0.0', ['dsh-x-keep@1.0.0'])
  const entry = await savePreset({ name: '意外退出', version: '1.0.0', profile, environment: target.id })
  const { url } = await mustStart(entry)
  editInDsh(env.home, profile, { add: { 'dsh-x-crash': '1.0.0' } })
  await fetch(new URL('/exit', url)).then((response) => response.text()).catch(() => '')
  await waitFor(async () => (await live(env.home, profile)).length === 0, '假 dsh 退出后实例应不再算在跑')
  const view = await waitFor(async () => {
    const current = await envView(target.id)
    return depsOf(current)['dsh-x-crash'] ? current : null
  }, '意外退出后运行期间装的插件应并进环境').catch(async (error) => {
    assert.fail(`${error.message}；实际依赖：${JSON.stringify(depsOf(await envView(target.id)))}`)
  })
  assert.deepEqual(depsOf(view), { 'dsh-x-keep': '1.0.0', 'dsh-x-crash': '1.0.0' })
})

// ---------------------------------------------------------------- 不带启动项的启动

test('不带启动项 id 的启动（只带目录）不改写 Profile，也不并回任何环境', async () => {
  const profile = 'plain'
  const original = JSON.stringify(profileManifest(profile, { dependencies: { 'dsh-x-mine': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-mine'] }), null, 4)
  seedProfile(env.home, profile, original)
  const target = await createEnv('普通启动', '1.0.0', ['dsh-x-theirs@1.0.0'])
  await savePreset({ name: '普通启动', version: '1.0.0', profile, environment: target.id })
  const before = await envView(target.id)
  const headers = { 'x-dsh-home': encodeURIComponent(env.home) }
  const started = await env.call('/api/start', { version: '1.0.0', profile }, headers)
  assert.ok(started.ok, `启动失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)
  assert.equal(readFileSync(profileManifestPath(env.home, profile), 'utf8'), original, '没带启动项就不知道用哪个环境，不能动 Profile')
  assert.equal(installCalls(env.home, profile).length, 0, '也不装依赖')
  await okPost('/api/stop', { version: '1.0.0', profile, home: env.home }, headers)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await envView(target.id)
  assert.deepEqual(depsOf(after), depsOf(before), '没应用环境的实例停止后不能把 Profile 的列表并进别的环境')
  assert.deepEqual(after.bundles, before.bundles)
})
