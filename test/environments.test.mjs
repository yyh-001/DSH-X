/**
 * 环境模块（src/environments.js）的纯函数黑盒用例：只按需求写预期，不读实现。
 *
 * 需求要点（Phase 1：Environment / Profile 拆分）：
 *   - 环境 = DSH 版本（精确版本，或 auto + 版本类型）+ 插件列表（dependencies 表 + 有序的 bundles）
 *   - 插件列表的比较：依赖顺序无关，bundle 顺序有关
 *   - 跟随上游的环境（source.repo 是 GitHub owner/repo）本地改动进「本地差量」，上游层 base 不动
 *   - 收养（planAdoption）：确定性、无清单的 Profile 不收养、按版本拆环境、名字唯一、按 links 接回原环境
 *
 * 用到的测试设计：等价类（清单好/坏/缺字段）、边界（空列表、只换顺序）、决策表（跟随 × 有无改动）、
 * 状态迁移（收养 → 剥字段 → 再收养）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as E from '../src/environments.js'

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const list = (dependencies, bundles) => ({ dependencies, bundles })
/** 只取 effectivePlugins 里插件列表那两项。 */
const pluginsOf = (env) => {
  const effective = E.effectivePlugins(env)
  return { dependencies: effective.dependencies, bundles: effective.bundles }
}
/** 本地差量是否为空：不假设它的具体形状，只要所有分量都是空的（空对象 / 空数组 / 空值）。 */
function emptyDelta(delta) {
  if (delta === undefined || delta === null) return true
  if (Array.isArray(delta)) return delta.length === 0
  if (typeof delta !== 'object') return !delta
  return Object.values(delta).every(emptyDelta)
}

const LA = list({ 'dsh-x-memory': '1.0.0', 'dsh-x-sync': '2.0.0' }, [BASE, WEB, 'dsh-x-memory', 'dsh-x-sync'])
const github = (repo, tag = 'v1.0.0') => ({ kind: 'github', repo, tag })

// ---------------------------------------------------------------- profilePluginList

test('profilePluginList：从 Profile 清单取出 dependencies 与 dsh.profile.bundles', () => {
  const manifest = {
    name: 'dsh-profile-work', private: true,
    dependencies: { 'dsh-x-memory': '1.0.0', '@acme/dsh-bar': 'github:acme/dsh-bar#abc1234' },
    pnpm: { overrides: { x: '1.0.0' } },
    dsh: { profile: { bundles: [BASE, WEB, 'dsh-x-memory', '@acme/dsh-bar'], patchReload: true } },
  }
  assert.deepEqual(E.profilePluginList(manifest), list(manifest.dependencies, manifest.dsh.profile.bundles))
})

test('profilePluginList：缺字段 / 不是对象都不抛，给空列表', () => {
  for (const manifest of [undefined, null, 42, 'text', [], {}, { dsh: {} }, { dsh: { profile: {} } }, { dependencies: [], dsh: { profile: { bundles: 'x' } } }]) {
    let result
    assert.doesNotThrow(() => { result = E.profilePluginList(manifest) }, `输入 ${JSON.stringify(manifest)} 不能抛`)
    assert.deepEqual(result, list({}, []), `输入 ${JSON.stringify(manifest)} 应得到空列表`)
  }
})

test('profilePluginList：坏条目跳过，好条目保留', () => {
  const result = E.profilePluginList({
    dependencies: { good: '1.0.0', num: 2, nil: null, obj: { a: 1 }, '': '1.0.0' },
    dsh: { profile: { bundles: [BASE, 3, null, '', { a: 1 }, 'good'] } },
  })
  assert.deepEqual(result.dependencies, { good: '1.0.0' }, '版本不是字符串、名字为空的依赖都跳过')
  assert.deepEqual(result.bundles, [BASE, 'good'], 'bundles 里非字符串和空串跳过，其余保持顺序')
})

// ---------------------------------------------------------------- withPluginList

test('withPluginList：只换 dependencies 与 bundles，其余字段原样保留，输入不被改动', () => {
  const manifest = {
    name: 'dsh-profile-work', private: true, version: '0.0.0', marker: 'keep',
    dependencies: { old: '1.0.0' },
    pnpm: { overrides: { 'left-pad': '1.3.0' } },
    dsh: { profile: { bundles: [BASE, 'old'], patchReload: true, extra: 'x' }, other: 1 },
  }
  const before = structuredClone(manifest)
  const next = E.withPluginList(manifest, LA)
  assert.deepEqual(manifest, before, '输入清单不能被原地改')
  assert.notEqual(next, manifest, '要返回新对象')
  assert.deepEqual(E.profilePluginList(next), LA, '插件列表换成新的')
  assert.equal(next.name, 'dsh-profile-work')
  assert.equal(next.private, true)
  assert.equal(next.version, '0.0.0')
  assert.equal(next.marker, 'keep')
  assert.deepEqual(next.pnpm, { overrides: { 'left-pad': '1.3.0' } }, 'pnpm.overrides 原样保留')
  assert.equal(next.dsh.profile.patchReload, true, 'dsh.profile.patchReload 原样保留')
  assert.equal(next.dsh.profile.extra, 'x', 'dsh.profile 里的其他键原样保留')
  assert.equal(next.dsh.other, 1, 'dsh 下的其他键原样保留')
})

test('withPluginList：没有 dsh 段的清单也能写进 bundles；空列表写回后读出来还是空', () => {
  const next = E.withPluginList({ name: 'bare' }, LA)
  assert.deepEqual(next.dsh.profile.bundles, LA.bundles)
  assert.equal(next.name, 'bare')
  const emptied = E.withPluginList({ name: 'x', dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['a'] } } }, list({}, []))
  assert.deepEqual(E.profilePluginList(emptied), list({}, []), '空列表要真的清空，旧依赖不能留着')
})

// ---------------------------------------------------------------- pluginListKey / samePluginList

test('samePluginList / pluginListKey：依赖顺序无关，bundle 顺序有关', () => {
  const a = list({ x: '1.0.0', y: '2.0.0' }, [BASE, 'x', 'y'])
  const reorderedDeps = list({ y: '2.0.0', x: '1.0.0' }, [BASE, 'x', 'y'])
  const reorderedBundles = list({ x: '1.0.0', y: '2.0.0' }, [BASE, 'y', 'x'])
  assert.equal(E.samePluginList(a, reorderedDeps), true, '依赖表换顺序算同一份')
  assert.equal(E.pluginListKey(a), E.pluginListKey(reorderedDeps), '依赖表换顺序 key 相同')
  assert.equal(E.samePluginList(a, reorderedBundles), false, 'bundle 换顺序算不同（加载顺序是语义）')
  assert.notEqual(E.pluginListKey(a), E.pluginListKey(reorderedBundles))
})

test('samePluginList：版本不同、多一个依赖、多一个 bundle 都算不同；自己和自己相同', () => {
  const a = list({ x: '1.0.0' }, [BASE, 'x'])
  assert.equal(E.samePluginList(a, structuredClone(a)), true)
  assert.equal(E.samePluginList(a, list({ x: '1.0.1' }, [BASE, 'x'])), false, '版本不同')
  assert.equal(E.samePluginList(a, list({ x: '1.0.0', z: '1.0.0' }, [BASE, 'x'])), false, '多一个依赖')
  assert.equal(E.samePluginList(a, list({ x: '1.0.0' }, [BASE, WEB, 'x'])), false, '多一个 bundle')
  assert.equal(E.samePluginList(list({}, []), list({}, [])), true, '两个空列表相同')
})

// ---------------------------------------------------------------- diffPluginLists

test('diffPluginLists：新增 / 改版本 / 删除 / bundle 增删分别列出', () => {
  const before = list({ keep: '1.0.0', bump: '1.0.0', gone: '1.0.0' }, [BASE, 'keep', 'bump', 'gone'])
  const after = list({ keep: '1.0.0', bump: '2.0.0', fresh: '0.1.0' }, [BASE, WEB, 'keep', 'bump', 'fresh'])
  const diff = E.diffPluginLists(before, after)
  assert.deepEqual(diff.added, { fresh: '0.1.0' })
  assert.deepEqual(diff.changed, { bump: { from: '1.0.0', to: '2.0.0' } })
  assert.deepEqual(diff.removed, ['gone'])
  assert.deepEqual([...diff.bundlesAdded].sort(), [WEB, 'fresh'].sort())
  assert.deepEqual(diff.bundlesRemoved, ['gone'])
})

test('diffPluginLists：同一份列表（依赖换顺序）没有任何差异', () => {
  const diff = E.diffPluginLists(list({ a: '1.0.0', b: '1.0.0' }, [BASE, 'a', 'b']), list({ b: '1.0.0', a: '1.0.0' }, [BASE, 'a', 'b']))
  assert.deepEqual(diff, { added: {}, changed: {}, removed: [], bundlesAdded: [], bundlesRemoved: [] })
})

// ---------------------------------------------------------------- createEnvironment / effectivePlugins

test('createEnvironment + effectivePlugins：精确版本的环境给出版本与插件列表', () => {
  const env = E.createEnvironment({ id: 'work-env', name: '工作', dshVersion: '1.0.0', updateChannel: 'official', list: LA })
  assert.equal(env.id, 'work-env')
  assert.equal(env.name, '工作')
  const effective = E.effectivePlugins(env)
  assert.equal(effective.dshVersion, '1.0.0')
  assert.deepEqual({ dependencies: effective.dependencies, bundles: effective.bundles }, LA)
})

test('createEnvironment：auto + 版本类型原样保留', () => {
  for (const channel of ['official', 'rc', 'alpha']) {
    const env = E.createEnvironment({ id: `auto-${channel}`, name: channel, dshVersion: 'auto', updateChannel: channel, list: LA })
    const effective = E.effectivePlugins(env)
    assert.equal(effective.dshVersion, 'auto')
    assert.equal(effective.updateChannel, channel, `版本类型 ${channel} 要保留`)
  }
})

// ---------------------------------------------------------------- isFollowing

test('isFollowing：只有 source.repo 是 GitHub owner/repo 时才算跟随上游', () => {
  const make = (source) => E.createEnvironment({ id: 'f', name: 'f', dshVersion: '1.0.0', list: LA, ...(source === undefined ? {} : { source }) })
  assert.equal(E.isFollowing(make(github('octo/env-pack'))), true, 'owner/repo')
  assert.equal(E.isFollowing(make(github('octo.org/env_pack-2'))), true, '带点、下划线、连字符的 owner/repo')
  assert.equal(E.isFollowing(make(undefined)), false, '没有来源')
  assert.equal(E.isFollowing(make(github('octo'))), false, '只有 owner')
  assert.equal(E.isFollowing(make(github('a/b/c'))), false, '多一级路径')
  assert.equal(E.isFollowing(make(github(''))), false, '空仓库名')
  assert.equal(E.isFollowing(make({ kind: 'file', path: '/tmp/x.dspack' })), false, '文件来源')
})

test('isFollowing：following 为 false 时不跟随，哪怕仓库合法', () => {
  const env = E.createEnvironment({ id: 'f', name: 'f', dshVersion: '1.0.0', list: LA, source: github('octo/env-pack') })
  // 不假设 following 标记挂在哪一层：两层都标 false
  const off = { ...env, following: false, source: { ...env.source, following: false } }
  assert.equal(E.isFollowing(off), false)
})

// ---------------------------------------------------------------- foldPluginChanges

test('foldPluginChanges：不跟随的环境，运行中的改动直接并进环境本身', () => {
  const env = E.createEnvironment({ id: 'local', name: 'local', dshVersion: '1.0.0', list: LA })
  const after = list({ ...LA.dependencies, 'dsh-x-aquarium': '0.3.0' }, [...LA.bundles, 'dsh-x-aquarium'])
  const result = E.foldPluginChanges(env, LA, after)
  assert.equal(result.changed, true)
  assert.deepEqual(result.diff.added, { 'dsh-x-aquarium': '0.3.0' })
  assert.deepEqual(pluginsOf(result.env), after, '有效列表就是改动后的列表')
  assert.ok(emptyDelta(result.env.delta), '不跟随的环境不该攒本地差量')
})

test('foldPluginChanges：前后一样时 changed 为 false，环境不变', () => {
  const env = E.createEnvironment({ id: 'local', name: 'local', dshVersion: '1.0.0', list: LA })
  const result = E.foldPluginChanges(env, LA, structuredClone(LA))
  assert.equal(result.changed, false)
  assert.deepEqual(pluginsOf(result.env), LA)
})

test('foldPluginChanges：跟随上游的环境改动进本地差量，上游层 base 不动；反向改回后差量清空', () => {
  const env = E.createEnvironment({ id: 'upstream', name: 'up', dshVersion: '1.0.0', list: LA, source: github('octo/env-pack') })
  assert.equal(E.isFollowing(env), true)
  assert.ok(env.base, '跟随上游的环境要有上游层 base')
  const base = structuredClone(env.base)
  assert.ok(emptyDelta(env.delta), '刚建好的环境没有本地差量')

  // 运行中：加一个、改一个版本、删一个
  const after = list({ 'dsh-x-memory': '1.1.0', 'dsh-x-aquarium': '0.3.0' }, [BASE, WEB, 'dsh-x-memory', 'dsh-x-aquarium'])
  const folded = E.foldPluginChanges(env, LA, after)
  assert.equal(folded.changed, true)
  assert.deepEqual(pluginsOf(folded.env), after, '有效列表 = 上游 + 本地差量 = 运行后的列表')
  assert.deepEqual(folded.env.base, base, '上游层不能被本地改动覆盖')
  assert.ok(!emptyDelta(folded.env.delta), '改动要记进本地差量')

  const back = E.foldPluginChanges(folded.env, after, LA)
  assert.equal(back.changed, true)
  assert.deepEqual(pluginsOf(back.env), LA, '改回去之后有效列表回到上游')
  assert.deepEqual(back.env.base, base)
  assert.ok(emptyDelta(back.env.delta), '改回上游后本地差量应为空')
})

// ---------------------------------------------------------------- setEnvironmentPlugin / removeEnvironmentPlugin / setEnvironmentVersion

test('setEnvironmentPlugin：新插件进依赖并追加到 bundles 末尾；已有插件只换版本、不重复、不挪位置', () => {
  const env = E.createEnvironment({ id: 'edit', name: 'edit', dshVersion: '1.0.0', list: LA })
  const added = E.setEnvironmentPlugin(env, 'dsh-x-aquarium', '0.3.0') ?? env
  const effective = pluginsOf(added)
  assert.equal(effective.dependencies['dsh-x-aquarium'], '0.3.0')
  assert.deepEqual(effective.bundles, [...LA.bundles, 'dsh-x-aquarium'], '新插件追加在 bundles 末尾')

  const bumped = E.setEnvironmentPlugin(added, 'dsh-x-memory', '1.2.0') ?? added
  const again = pluginsOf(bumped)
  assert.equal(again.dependencies['dsh-x-memory'], '1.2.0')
  assert.deepEqual(again.bundles, [...LA.bundles, 'dsh-x-aquarium'], '换版本不改 bundles')
})

test('removeEnvironmentPlugin：从依赖与 bundles 一起删；不认识的名字、官方包都拒绝', () => {
  const env = E.createEnvironment({ id: 'edit', name: 'edit', dshVersion: '1.0.0', list: LA })
  const removed = E.removeEnvironmentPlugin(env, 'dsh-x-sync') ?? env
  const effective = pluginsOf(removed)
  assert.equal('dsh-x-sync' in effective.dependencies, false)
  assert.equal(effective.bundles.includes('dsh-x-sync'), false)
  assert.deepEqual(effective.bundles, [BASE, WEB, 'dsh-x-memory'], '其他 bundle 顺序不变')

  assert.throws(() => E.removeEnvironmentPlugin(env, 'dsh-x-not-here'), '不认识的插件名要报错')
  assert.throws(() => E.removeEnvironmentPlugin(env, WEB), '官方 @deepseek-ai/* 包不能删')
  assert.throws(() => E.removeEnvironmentPlugin(env, BASE), '官方 @deepseek-ai/* 包不能删')
})

test('setEnvironmentVersion：换精确版本 / 换成 auto + 版本类型', () => {
  const env = E.createEnvironment({ id: 'ver', name: 'ver', dshVersion: '1.0.0', list: LA })
  const exact = E.setEnvironmentVersion(env, '1.2.0') ?? env
  assert.equal(E.effectivePlugins(exact).dshVersion, '1.2.0')
  assert.deepEqual(pluginsOf(exact), LA, '换版本不动插件列表')
  const auto = E.setEnvironmentVersion(exact, 'auto', 'alpha') ?? exact
  assert.equal(E.effectivePlugins(auto).dshVersion, 'auto')
  assert.equal(E.effectivePlugins(auto).updateChannel, 'alpha')
})

// ---------------------------------------------------------------- planAdoption

const H = join(tmpdir(), 'dsh-env-unit-home')
const H2 = join(tmpdir(), 'dsh-env-unit-home-two')
const LB = list({ 'dsh-x-sync': '2.0.0' }, [BASE, WEB, 'dsh-x-sync'])
const LA2 = list({ 'dsh-x-aquarium': '0.3.0' }, [BASE, WEB, 'dsh-x-aquarium'])
const LO = list({}, [BASE, WEB])
const P = { alpha: 'a'.repeat(16), beta1: 'b'.repeat(16), beta2: 'c'.repeat(16), alphaTwo: 'd'.repeat(16), nopkg: 'e'.repeat(16) }

function adoptionInput(overrides = {}) {
  return {
    presets: [
      { id: '0000000000000000', name: 'DSH', version: 'auto', profile: 'web', port: 0 },
      { id: P.alpha, name: 'Alpha', version: '1.0.0', profile: 'alpha', port: 0 },
      { id: P.beta1, name: 'Beta 1', version: '1.0.0', profile: 'beta', port: 0 },
      { id: P.beta2, name: 'Beta 2', version: '1.1.0', profile: 'beta', port: 0 },
      { id: P.alphaTwo, name: 'Alpha Two', version: 'auto', profile: 'alpha', port: 0, dshHome: H2, updateChannel: 'rc' },
      { id: P.nopkg, name: 'No pkg', version: '1.0.0', profile: 'nopkg', port: 0 },
    ],
    profiles: [
      { home: H, profile: 'web', list: null },
      { home: H, profile: 'alpha', list: LA },
      { home: H, profile: 'beta', list: LB },
      { home: H2, profile: 'alpha', list: LA2 },
      { home: H, profile: 'nopkg', list: null },
      { home: H, profile: 'orphan', list: LO },
    ],
    environments: [],
    state: { links: {}, applied: {} },
    packs: [],
    defaultHome: H,
    defaultChannel: 'official',
    ...overrides,
  }
}
const presetOf = (result, id) => result.presets.find((item) => item.id === id)
const envOf = (envs, id) => envs.find((item) => item.id === id)
const envFor = (result, presetId) => envOf(result.environments, presetOf(result, presetId)?.environment)
/** 模拟旧版保存：删掉某个启动项的 environment 字段（可顺带改别的字段），其余启动项原样。 */
function stripEnvironment(presets, id, patch = {}) {
  return presets.map((item) => {
    if (item.id !== id) return item
    const { environment, ...rest } = item
    return { ...rest, ...patch }
  })
}

test('planAdoption：有清单的启动项都绑上环境，无清单的不绑', async () => {
  const result = await E.planAdoption(adoptionInput())
  for (const id of [P.alpha, P.beta1, P.beta2, P.alphaTwo]) {
    const preset = presetOf(result, id)
    assert.ok(preset, `启动项 ${id} 要留着`)
    assert.match(String(preset.environment), ID_RE, `启动项 ${preset.name} 要绑上合法的环境 id`)
    assert.ok(envOf(result.environments, preset.environment), `启动项 ${preset.name} 绑的环境要在产出里`)
  }
  assert.equal(presetOf(result, P.nopkg)?.environment, undefined, 'Profile 没有 package.json 的启动项不绑环境')
  assert.equal(presetOf(result, '0000000000000000')?.environment, undefined, '默认启动项的 web 没有清单，也不绑')
  for (const preset of result.presets) {
    assert.ok(preset.version && preset.profile, '收养后的启动项仍带 version 与 profile（双写，旧版能读）')
  }
})

test('planAdoption：环境的版本与插件列表取自启动项和它的 Profile', async () => {
  const result = await E.planAdoption(adoptionInput())
  const alpha = envFor(result, P.alpha)
  assert.equal(E.effectivePlugins(alpha).dshVersion, '1.0.0')
  assert.deepEqual(pluginsOf(alpha), LA)
  const alphaTwo = envFor(result, P.alphaTwo)
  assert.equal(E.effectivePlugins(alphaTwo).dshVersion, 'auto', 'auto 启动项 → auto 环境')
  assert.equal(E.effectivePlugins(alphaTwo).updateChannel, 'rc', 'auto 环境沿用启动项的版本类型')
  assert.deepEqual(pluginsOf(alphaTwo), LA2, '别的目录里的同名 Profile 用它自己的清单')
})

test('planAdoption：同一 Profile 被两个不同版本的启动项使用 → 每个版本一个环境，插件列表相同', async () => {
  const result = await E.planAdoption(adoptionInput())
  const one = envFor(result, P.beta1)
  const two = envFor(result, P.beta2)
  assert.notEqual(one.id, two.id, '不同版本要各有一个环境')
  assert.equal(E.effectivePlugins(one).dshVersion, '1.0.0')
  assert.equal(E.effectivePlugins(two).dshVersion, '1.1.0')
  assert.deepEqual(pluginsOf(one), LB)
  assert.deepEqual(pluginsOf(two), LB)
})

test('planAdoption：没有启动项的 Profile 也收养成 auto 环境，名字就是 Profile 名', async () => {
  const result = await E.planAdoption(adoptionInput())
  const orphan = result.environments.find((env) => env.name === 'orphan')
  assert.ok(orphan, `应有名为 orphan 的环境；实际：${result.environments.map((env) => env.name).join('、')}`)
  assert.equal(E.effectivePlugins(orphan).dshVersion, 'auto')
  assert.equal(E.effectivePlugins(orphan).updateChannel, 'official', '版本类型取 defaultChannel')
  assert.deepEqual(pluginsOf(orphan), LO)
})

test('planAdoption：环境名字唯一；不同目录的同名 Profile（清单不同）要区分开', async () => {
  const result = await E.planAdoption(adoptionInput())
  const names = result.environments.map((env) => env.name)
  assert.equal(new Set(names).size, names.length, `环境名字要唯一：${names.join('、')}`)
  const alpha = envFor(result, P.alpha)
  const alphaTwo = envFor(result, P.alphaTwo)
  assert.notEqual(alpha.id, alphaTwo.id)
  assert.ok(alpha.name.includes('alpha') && alphaTwo.name.includes('alpha'), '名字仍以 Profile 名为主体')
  for (const env of result.environments) assert.match(env.id, ID_RE)
})

test('planAdoption：和已有环境重名时加区分后缀', async () => {
  const existing = E.createEnvironment({ id: 'user-made', name: 'orphan', dshVersion: '1.0.0', list: LA })
  const result = await E.planAdoption(adoptionInput({ environments: [existing] }))
  const adopted = result.environments.filter((env) => env.id !== 'user-made')
  const all = [existing.name, ...adopted.map((env) => env.name)]
  assert.equal(new Set(all).size, all.length, `收养出来的名字不能和已有环境撞：${all.join('、')}`)
})

test('planAdoption：确定性——同样的输入两次得到同样的 id', async () => {
  const first = await E.planAdoption(adoptionInput())
  const second = await E.planAdoption(adoptionInput())
  assert.deepEqual(first.presets.map((item) => [item.id, item.environment]), second.presets.map((item) => [item.id, item.environment]))
  assert.deepEqual(first.environments.map((env) => env.id).sort(), second.environments.map((env) => env.id).sort())
})

test('planAdoption：对上一次的产出再跑一遍什么都不新建、不改', async () => {
  const first = await E.planAdoption(adoptionInput())
  const again = await E.planAdoption(adoptionInput({ presets: first.presets, environments: first.environments, state: first.state }))
  assert.equal(again.environments.length, 0, `幂等：不该再建或改环境，实际：${again.environments.map((env) => env.id).join('、')}`)
  assert.deepEqual(again.presets, first.presets, '启动项原样')
})

test('planAdoption：旧版把 environment 字段删掉后，按 links 接回原来的环境', async () => {
  const first = await E.planAdoption(adoptionInput())
  const original = presetOf(first, P.beta1).environment
  const stripped = stripEnvironment(first.presets, P.beta1)
  const again = await E.planAdoption(adoptionInput({ presets: stripped, environments: first.environments, state: first.state }))
  assert.equal(presetOf(again, P.beta1).environment, original, '接回同一个环境，不新建')
  const known = new Set(first.environments.map((env) => env.id))
  assert.deepEqual(again.environments.filter((env) => !known.has(env.id)).map((env) => env.id), [], '没有新环境')
})

test('planAdoption：旧版还改了版本 → 接回原环境，环境的版本跟着启动项走（旧版最后写）', async () => {
  const first = await E.planAdoption(adoptionInput())
  const original = presetOf(first, P.beta1).environment
  const stripped = stripEnvironment(first.presets, P.beta1, { version: '1.2.0' })
  const again = await E.planAdoption(adoptionInput({ presets: stripped, environments: first.environments, state: first.state }))
  const preset = presetOf(again, P.beta1)
  assert.equal(preset.environment, original, '接回同一个环境')
  assert.equal(preset.version, '1.2.0', '启动项的版本保持旧版写的值')
  const changed = envOf(again.environments, original)
  assert.ok(changed, '版本变了的环境要出现在「已改」的产出里')
  assert.equal(E.effectivePlugins(changed).dshVersion, '1.2.0')
})

test('planAdoption：整合包记录里的 GitHub 来源让环境跟随上游；认不出的来源不跟随', async () => {
  const result = await E.planAdoption(adoptionInput({
    packs: [
      { home: H, profile: 'alpha', record: { id: 'pk@1.2.0', name: 'pk', version: '1.2.0', profile: 'alpha', source: 'GitHub：octo/env-pack@v1.2.0' } },
      { home: H, profile: 'orphan', record: { id: 'other@1.0.0', name: 'other', version: '1.0.0', profile: 'orphan', source: '文件：/tmp/other.dspack' } },
    ],
  }))
  const alpha = envFor(result, P.alpha)
  assert.equal(E.isFollowing(alpha), true, 'GitHub：owner/repo@tag → 跟随')
  assert.equal(alpha.source?.repo, 'octo/env-pack')
  const orphan = result.environments.find((env) => env.name === 'orphan')
  assert.ok(orphan)
  assert.equal(E.isFollowing(orphan), false, '文件来源认不出仓库 → 不跟随')
  const beta = envFor(result, P.beta1)
  assert.equal(E.isFollowing(beta), false, '没有整合包记录的环境不跟随')
})

// WSL 启动项的 Profile 在 WSL 里：启动器写不进插件清单，也装不了依赖，所以不接环境
test('planAdoption：WSL 启动项不绑环境，也不因为它多建环境；同名的本机启动项照常收养', async () => {
  const wsl = { id: 'f'.repeat(16), name: 'WSL', version: '1.0.0', profile: 'alpha', port: 0, backend: 'wsl', wslDistro: 'Ubuntu', wslHome: '~/.dsh' }
  const base = await E.planAdoption(adoptionInput())
  const input = adoptionInput()
  const result = await E.planAdoption({ ...input, presets: [...input.presets, wsl] })
  const kept = presetOf(result, wsl.id)
  assert.ok(kept, 'WSL 启动项原样留着')
  assert.equal(kept.environment, undefined, 'WSL 启动项不记 environment')
  assert.deepEqual(kept, wsl, '收养不改 WSL 启动项的任何字段')
  assert.equal(result.environments.length, base.environments.length, '不为 WSL 启动项多建环境')
  assert.ok(!Object.hasOwn(result.state.links || {}, wsl.id), '记账文件里也没有它的链接')
  assert.match(String(presetOf(result, P.alpha).environment), ID_RE, '同 Profile 名的本机启动项照常绑上')
})

// 只导配置的记录（环境导入时写进 Profile 的那部分）没有插件：Profile 的插件清单不是它装的，
// 拿它的来源去「跟随上游」，上游一更新就会把用户自己的插件清单换掉
test('planAdoption：只导配置的整合包记录不当环境的来源，GitHub 来源也不跟随', async () => {
  const configOnly = (profile, repo) => ({
    home: H, profile,
    record: { id: `cfg@1.0.0`, name: 'cfg', version: '1.0.0', profile, source: `GitHub：${repo}@v1.0.0`, configOnly: true },
  })
  const result = await E.planAdoption(adoptionInput({
    packs: [
      configOnly('beta', 'octo/config-only'),
      // 同一个 Profile 先整包装过、后来又导过一次配置：后导的那条不能顶掉来源
      { home: H, profile: 'alpha', record: { id: 'pk@1.2.0', name: 'pk', version: '1.2.0', profile: 'alpha', source: 'GitHub：octo/env-pack@v1.2.0' } },
      configOnly('alpha', 'octo/alpha-config'),
    ],
  }))
  for (const id of [P.beta1, P.beta2]) {
    const beta = envFor(result, id)
    assert.ok(beta, '有清单的 Profile 照样收养')
    assert.equal(E.isFollowing(beta), false, '只导配置的记录不让环境跟随上游')
    assert.notEqual(beta.source?.repo, 'octo/config-only', '来源不取只导配置的记录')
  }
  assert.notEqual(envFor(result, P.alpha).source?.repo, 'octo/alpha-config', '后来的配置导入不顶掉整包安装的来源')
})

// ---------------------------------------------------------------- EnvironmentStore

function findFiles(dir, name, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) findFiles(path, name, out)
    else if (entry === name) out.push(path)
  }
  return out
}

test('EnvironmentStore：存、列、取、删，换一个实例读到的是同一份', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-env-store-'))
  try {
    const store = new E.EnvironmentStore(root)
    assert.deepEqual(await store.list(), [], '新目录里没有环境')
    const env = E.createEnvironment({ id: 'stored-one', name: '存一个', dshVersion: '1.0.0', list: LA })
    await store.save(env)
    const got = await store.get('stored-one')
    assert.ok(got, '存了就能取回')
    assert.equal(got.name, '存一个')
    assert.deepEqual(pluginsOf(got), LA)
    assert.deepEqual((await store.list()).map((item) => item.id), ['stored-one'])
    const reopened = new E.EnvironmentStore(root)
    assert.equal((await reopened.get('stored-one'))?.name, '存一个', '落了盘，换实例也读得到')

    await store.remove('stored-one')
    assert.equal(await store.get('stored-one'), null, '删了就取不到')
    assert.deepEqual(await store.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EnvironmentStore：取不存在 / 不合法的 id 返回 null；坏掉的清单不进列表也不抛', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-env-store-'))
  try {
    const store = new E.EnvironmentStore(root)
    for (const id of ['missing', '../etc', 'Bad ID', '', '-leading', 'a'.repeat(49)]) {
      assert.equal(await store.get(id), null, `get(${JSON.stringify(id)}) 应为 null`)
    }
    await store.save(E.createEnvironment({ id: 'good-one', name: 'good', dshVersion: '1.0.0', list: LA }))
    await store.save(E.createEnvironment({ id: 'corrupt-me', name: 'bad', dshVersion: '1.0.0', list: LA }))
    const file = findFiles(root, 'environment.json').find((path) => path.includes('corrupt-me'))
    assert.ok(file, '每个环境要有一份 environment.json')
    writeFileSync(file, '{ not json')
    assert.equal(await store.get('corrupt-me'), null, '坏清单取出来是 null')
    assert.deepEqual((await store.list()).map((item) => item.id), ['good-one'], '坏清单不进列表')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EnvironmentStore：记账文件写了能读回（links 是对象、applied 只记插件列表、dismissed 是 id 列表）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-env-store-'))
  try {
    const store = new E.EnvironmentStore(root)
    const fresh = await store.readState()
    assert.ok(fresh && typeof fresh === 'object', '没写过也要给一个对象')
    // links：启动项 → { 环境, 目录, Profile }；只记环境 id 的话，旧版剥掉 environment 后不知道该按哪个目录接回
    const link = { environment: 'stored-one', home: H, profile: 'alpha' }
    // applied：「目录\0Profile」→ 上次写进去的那个环境和它的插件列表（只有 dependencies 与 bundles）
    const applied = { [`${H}\0alpha`]: { environment: 'stored-one', list: LA } }
    await store.writeState({ links: { [P.alpha]: link }, applied, dismissed: ['user-removed'] })
    const back = await new E.EnvironmentStore(root).readState()
    assert.deepEqual(back.links?.[P.alpha], link)
    assert.deepEqual(back.applied?.[`${H}\0alpha`], { environment: 'stored-one', list: LA })
    assert.deepEqual(back.dismissed, ['user-removed'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
