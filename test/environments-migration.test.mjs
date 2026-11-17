/**
 * 启动时的旧数据迁移（系统测试）：老形状的 settings.json + 几个 dsh 用户目录里的 Profile，起真服务看它迁成什么样。
 *
 * 需求（只按需求写预期，不读实现）：
 *   - 开服务前完成：每个没有 environment 的启动项，只要它的 Profile 目录有 package.json 就绑上一个环境；
 *     每个有 package.json 的 Profile 目录都有环境（没有启动项的按 Profile 名收养成 auto 环境）
 *   - Profile 目录里的文件一个字节都不改；迁移不装东西（不跑 dsh plugin）
 *   - settings.json 第一次被改写前备份成 settings.json.bak-environments（只在不存在时创建）
 *   - 重启不产生重复；旧版保存时删掉 environment 字段 → 重启后接回同一个环境；旧版还改了版本 → 环境的版本跟着改
 *   - 启动项始终带合法 version / profile；某一项迁移失败不拦启动
 *   - 同一 Profile 被不同版本的启动项使用 → 每个版本一个环境；不同目录的同名 Profile → 名字区分开
 *   - 整合包记录的 GitHub 来源 → 环境跟随该仓库；认不出的来源 → 不跟随
 *
 * 状态迁移：老数据 → 首次启动（迁移 + 备份）→ 重启（幂等）→ 旧版剥字段 → 重启（接回）
 *          → 旧版剥字段并改版本 → 重启（环境版本跟随）→ 设置被还原成备份 → 重启（同样的 id）→ 外部新建 Profile → 重启（补收养）。
 * 这些用例按顺序共享一个服务（node --test 同文件内顺序执行），每步都是上一步的后继状态。
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import {
  BASE, ENV_ID_RE, WEB, profileDir, profileManifest, readCalls, recordingBin, seedProfile, snapshotDir,
} from './environments-fixture.mjs'

const ID = {
  default: '0000000000000000', alpha: 'a'.repeat(16), beta1: 'b'.repeat(16), beta2: 'c'.repeat(16), gamma: 'd'.repeat(16),
  alphaTwo: 'e'.repeat(16), nopkg: 'f'.repeat(16), broken: '1'.repeat(16), brokenHome: '2'.repeat(16),
}
const LIST = {
  alpha: { dependencies: { 'dsh-x-memory': '1.0.0', 'dsh-x-sync': '2.0.0' }, bundles: [BASE, WEB, 'dsh-x-memory', 'dsh-x-sync'] },
  beta: { dependencies: { 'dsh-x-sync': '2.0.0' }, bundles: [BASE, WEB, 'dsh-x-sync'] },
  gamma: { dependencies: { 'dsh-x-aquarium': '0.3.0' }, bundles: [BASE, WEB, 'dsh-x-aquarium'] },
  alphaTwo: { dependencies: { 'dsh-x-desktop-notify': '0.1.1' }, bundles: [BASE, WEB, 'dsh-x-desktop-notify'] },
  orphan: { dependencies: {}, bundles: [BASE, WEB] },
  late: { dependencies: { 'dsh-x-late': '9.9.9' }, bundles: [BASE, WEB, 'dsh-x-late'] },
}
const PATCH = "- id: dsh-x-memory\n  disabled: true\n"

const dirs = {}
const snapshots = {}
const env = await startChannelServer({
  prefix: 'dsh-env-migrate-',
  packument: packumentOf({ latest: '1.2.0' }, ['1.0.0', '1.1.0', '1.2.0']),
  installed: ['1.0.0', '1.1.0', '1.2.0'],
  bin: recordingBin,
  // 在导入 server.js 之前把老数据摆好：presets 回调在写 settings.json 之前、导入服务之前调用
  presets: (root) => {
    const home = join(root, 'home')
    const two = join(root, 'home-two')
    const brokenHome = join(root, 'home-broken')
    Object.assign(dirs, { home, two, brokenHome })
    const seed = (dir, name, list) => {
      seedProfile(dir, name, profileManifest(name, list))
      writeFileSync(join(profileDir(dir, name), 'cordis.patch.yml'), PATCH)
    }
    seed(home, 'alpha', LIST.alpha)
    seed(home, 'beta', LIST.beta)
    seed(home, 'gamma', LIST.gamma)
    seed(home, 'orphan', LIST.orphan)
    seed(two, 'alpha', LIST.alphaTwo)
    // 有目录、没清单（比如只剩补丁层）
    mkdirSync(profileDir(home, 'nopkg'), { recursive: true })
    writeFileSync(join(profileDir(home, 'nopkg'), 'cordis.patch.yml'), PATCH)
    // 坏清单：迁移这一项失败也不能拦启动
    seedProfile(home, 'broken', '{ "name": "dsh-profile-broken", "dependencies": { ')
    // 坏目录：profiles 是个文件，连目录都列不出来
    mkdirSync(brokenHome, { recursive: true })
    writeFileSync(join(brokenHome, 'profiles'), 'not a directory')
    for (const [key, dir] of Object.entries({
      alpha: profileDir(home, 'alpha'), beta: profileDir(home, 'beta'), gamma: profileDir(home, 'gamma'), orphan: profileDir(home, 'orphan'),
      alphaTwo: profileDir(two, 'alpha'), nopkg: profileDir(home, 'nopkg'), broken: profileDir(home, 'broken'),
    })) snapshots[key] = { dir, files: snapshotDir(dir) }
    // 默认目录的整合包安装记录（data/packs/installed.json）
    const packs = join(root, 'data', 'packs')
    mkdirSync(packs, { recursive: true })
    writeFileSync(join(packs, 'installed.json'), JSON.stringify({ packs: [
      { id: 'env-pack@1.2.0', name: 'env-pack', version: '1.2.0', profile: 'alpha', source: 'GitHub：octo/env-pack@v1.2.0', installedAt: '2026-10-01T00:00:00.000Z', files: [], bundles: LIST.alpha.bundles, dependencies: LIST.alpha.dependencies },
      { id: 'other@1.0.0', name: 'other', version: '1.0.0', profile: 'orphan', source: '文件：/tmp/other.dspack', installedAt: '2026-10-01T00:00:00.000Z', files: [], bundles: LIST.orphan.bundles, dependencies: {} },
      // 只导配置的记录（环境导入时写进 Profile 的补丁层）：来源是 GitHub，但 gamma 的插件不是它装的，不能拿来跟随
      { id: 'cfg-pack@2.0.0', name: 'cfg-pack', version: '2.0.0', profile: 'gamma', source: 'GitHub：octo/cfg-pack@v2.0.0', installedAt: '2026-10-02T00:00:00.000Z', configOnly: true, createdProfile: false, files: [], bundles: [], dependencies: {} },
    ] }, null, 2))
    return [
      { id: ID.default, name: 'DSH', version: 'auto', profile: 'web', port: 0 },
      { id: ID.alpha, name: 'Alpha', version: '1.0.0', profile: 'alpha', port: 0 },
      { id: ID.beta1, name: 'Beta 1', version: '1.0.0', profile: 'beta', port: 0 },
      { id: ID.beta2, name: 'Beta 2', version: '1.1.0', profile: 'beta', port: 0 },
      { id: ID.gamma, name: 'Gamma', version: 'auto', profile: 'gamma', port: 0, updateChannel: 'rc' },
      { id: ID.alphaTwo, name: 'Alpha Two', version: '1.0.0', profile: 'alpha', port: 0, dshHome: two },
      { id: ID.nopkg, name: 'No pkg', version: '1.0.0', profile: 'nopkg', port: 0 },
      { id: ID.broken, name: 'Broken', version: '1.0.0', profile: 'broken', port: 0 },
      { id: ID.brokenHome, name: 'Broken home', version: '1.0.0', profile: 'any', port: 0, dshHome: brokenHome },
    ]
  },
})
test.after(() => env.cleanup())

const ORIGINAL_IDS = Object.values(ID)
const backupFile = `${env.settingsFile}.bak-environments`
const listEnvs = async () => (await env.getJson('/api/environments')).environments
const presetsStored = () => env.stored().launchPresets || []
const storedPreset = (id) => presetsStored().find((item) => item.id === id)
const envIdOf = (id) => storedPreset(id)?.environment
const depsOf = (view) => Object.fromEntries((view?.plugins || []).filter((item) => item.spec).map((item) => [item.name, item.spec]))
const listOf = (view) => ({ dependencies: depsOf(view), bundles: view?.bundles })
/** 旧版保存：把某些启动项的 environment 删掉（可顺带改字段），直接写回 settings.json。 */
function writeAsOldLauncher(changes) {
  const stored = env.stored()
  stored.launchPresets = stored.launchPresets.map((item) => {
    if (!(item.id in changes)) return item
    const { environment, ...rest } = item
    return { ...rest, ...changes[item.id] }
  })
  writeFileSync(env.settingsFile, JSON.stringify(stored))
}
const boundIds = () => Object.fromEntries(ORIGINAL_IDS.map((id) => [id, envIdOf(id)]))
let firstBound
let firstEnvIds
let backupBytes

// ---------------------------------------------------------------- 首次启动

test('首次启动：settings.json 改写前留了一份 .bak-environments，内容是旧形状', () => {
  assert.ok(existsSync(backupFile), 'settings.json 被改写过，应留有 settings.json.bak-environments')
  backupBytes = readFileSync(backupFile)
  const backup = JSON.parse(backupBytes.toString('utf8'))
  const presets = backup.launchPresets || []
  assert.deepEqual(presets.map((item) => item.id).sort(), [...ORIGINAL_IDS].sort(), '备份里是原来那些启动项')
  assert.ok(presets.every((item) => !('environment' in item)), '备份的是迁移前的旧形状，不该带 environment')
  assert.equal(presets.find((item) => item.id === ID.beta2)?.version, '1.1.0')
})

test('首次启动：Profile 有清单的启动项都绑上环境；没清单的不绑', () => {
  for (const key of ['alpha', 'beta1', 'beta2', 'gamma', 'alphaTwo']) {
    assert.match(String(envIdOf(ID[key])), ENV_ID_RE, `启动项 ${key} 要绑上合法的环境 id`)
  }
  assert.equal(envIdOf(ID.nopkg), undefined, 'Profile 目录没有 package.json → 不绑')
  assert.equal(envIdOf(ID.default), undefined, '默认启动项的 web 还没初始化 → 不绑')
  firstBound = boundIds()
})

test('首次启动：每个绑上的环境都有 <APP_DIR>/envs/<id>/environment.json', () => {
  // APP_DIR 是启动器自己的设置目录（settings.json 所在处），不是数据目录
  for (const id of new Set(Object.values(firstBound).filter(Boolean))) {
    assert.ok(existsSync(join(env.app, 'envs', id, 'environment.json')), `环境 ${id} 缺清单文件`)
  }
})

test('首次启动：记账文件 <APP_DIR>/envs/state.json 里每条链接都是 { environment, home, profile }', () => {
  // 链接是旧版剥掉 environment 字段后「接回原环境」的依据：只记环境 id 不够，还要知道当时是哪个目录里的哪个 Profile
  const state = JSON.parse(readFileSync(join(env.app, 'envs', 'state.json'), 'utf8'))
  for (const [preset, id] of Object.entries(firstBound)) {
    if (!id) continue
    const link = state.links?.[preset]
    assert.ok(link && typeof link === 'object', `启动项 ${preset} 要有一条链接`)
    assert.equal(link.environment, id)
    assert.equal(link.profile, storedPreset(preset).profile)
    assert.equal(typeof link.home, 'string')
  }
  assert.ok(Array.isArray(state.dismissed), 'dismissed 是数组（用户删掉过的收养环境）')
})

test('首次启动：环境的版本取自启动项、插件列表取自它的 Profile', async () => {
  const envs = await listEnvs()
  const of = (key) => envs.find((item) => item.id === firstBound[ID[key]])
  assert.equal(of('alpha').dshVersion, '1.0.0')
  assert.deepEqual(listOf(of('alpha')), LIST.alpha)
  assert.equal(of('gamma').dshVersion, 'auto', 'auto 启动项 → auto 环境')
  assert.equal(of('gamma').updateChannel, 'rc', '沿用启动项的版本类型')
  assert.deepEqual(listOf(of('gamma')), LIST.gamma)
  assert.deepEqual(listOf(of('alphaTwo')), LIST.alphaTwo, '别的目录里的同名 Profile 用它自己的清单')
})

test('首次启动：同一 Profile 被 1.0.0 和 1.1.0 两个启动项使用 → 两个环境，插件列表相同', async () => {
  assert.notEqual(firstBound[ID.beta1], firstBound[ID.beta2])
  const envs = await listEnvs()
  const one = envs.find((item) => item.id === firstBound[ID.beta1])
  const two = envs.find((item) => item.id === firstBound[ID.beta2])
  assert.equal(one.dshVersion, '1.0.0')
  assert.equal(two.dshVersion, '1.1.0')
  assert.deepEqual(listOf(one), LIST.beta)
  assert.deepEqual(listOf(two), LIST.beta)
})

test('首次启动：没有启动项的 Profile 也收养成 auto 环境，名字是 Profile 名', async () => {
  const envs = await listEnvs()
  const orphan = envs.find((item) => item.name === 'orphan')
  assert.ok(orphan, `应有名为 orphan 的环境；实际：${envs.map((item) => item.name).join('、')}`)
  assert.equal(orphan.dshVersion, 'auto')
  assert.deepEqual(listOf(orphan), LIST.orphan)
  assert.deepEqual(orphan.usedBy, [], '没有启动项用它')
})

test('首次启动：环境名字唯一，不同目录的同名 Profile 区分开', async () => {
  const envs = await listEnvs()
  const names = envs.map((item) => item.name)
  assert.equal(new Set(names).size, names.length, `名字要唯一：${names.join('、')}`)
  const alpha = envs.find((item) => item.id === firstBound[ID.alpha])
  const alphaTwo = envs.find((item) => item.id === firstBound[ID.alphaTwo])
  assert.notEqual(alpha.id, alphaTwo.id)
  assert.notEqual(alpha.name, alphaTwo.name)
})

test('首次启动：usedBy 列出用这个环境的启动项', async () => {
  const envs = await listEnvs()
  const alpha = envs.find((item) => item.id === firstBound[ID.alpha])
  assert.deepEqual(alpha.usedBy, [{ id: ID.alpha, name: 'Alpha' }])
})

test('首次启动：整合包记录里的 GitHub 来源 → 跟随该仓库；文件来源 → 不跟随', async () => {
  const envs = await listEnvs()
  const alpha = envs.find((item) => item.id === firstBound[ID.alpha])
  assert.equal(alpha.following, true, 'GitHub：octo/env-pack@v1.2.0 → 跟随')
  assert.equal(alpha.source?.repo, 'octo/env-pack')
  const orphan = envs.find((item) => item.name === 'orphan')
  assert.equal(orphan.following, false, '认不出仓库的来源 → 不跟随')
  const beta = envs.find((item) => item.id === firstBound[ID.beta1])
  assert.equal(beta.following, false, '没有整合包记录 → 不跟随')
})

test('首次启动：只导配置的整合包记录不当来源，GitHub 来源也不跟随', async () => {
  const gamma = (await listEnvs()).find((item) => item.id === firstBound[ID.gamma])
  assert.ok(gamma, 'gamma 照样收养')
  assert.equal(gamma.following, false, '只导配置的记录不让环境跟随上游')
  assert.notEqual(gamma.source?.repo, 'octo/cfg-pack', '来源不取只导配置的记录')
  assert.deepEqual(listOf(gamma), LIST.gamma, '插件清单照旧取自 Profile')
})

test('首次启动：Profile 目录里的文件一个字节都没改，也没跑任何 dsh 命令', () => {
  for (const [key, { dir, files }] of Object.entries(snapshots)) {
    const now = snapshotDir(dir)
    for (const [file, hash] of Object.entries(files)) {
      assert.equal(now[file], hash, `${key} 的 ${file} 被改了（迁移只读清单）`)
    }
  }
  for (const home of [dirs.home, dirs.two]) {
    assert.deepEqual(readCalls(home), [], `迁移不该拉起 dsh（${home}）`)
  }
})

test('首次启动：坏清单 / 坏目录不拦启动，启动项都在且 version、profile 合法', async () => {
  const state = await env.state()
  const ids = (state.launchPresets || []).map((item) => item.id)
  for (const id of ORIGINAL_IDS) assert.ok(ids.includes(id), `启动项 ${id} 不能丢`)
  for (const entry of state.launchPresets) {
    assert.match(String(entry.version), /^[0-9A-Za-z][0-9A-Za-z._+-]*$/, `「${entry.name}」version 要合法`)
    assert.match(String(entry.profile), /^[A-Za-z0-9._-]{1,32}$/, `「${entry.name}」profile 要合法`)
  }
  assert.equal(storedPreset(ID.broken).version, '1.0.0')
  assert.equal(storedPreset(ID.brokenHome).version, '1.0.0')
})

// ---------------------------------------------------------------- 重启：幂等

test('重启：不产生重复环境，启动项绑定不变，备份不重写', async () => {
  firstEnvIds = (await listEnvs()).map((item) => item.id).sort()
  await env.restart()
  assert.deepEqual((await listEnvs()).map((item) => item.id).sort(), firstEnvIds, '环境集合不变')
  assert.deepEqual(boundIds(), firstBound, '启动项绑定不变')
  assert.ok(readFileSync(backupFile).equals(backupBytes), '备份只在不存在时创建，不能被覆盖')
})

// ---------------------------------------------------------------- 旧版剥字段

test('旧版保存时删掉了 environment → 重启后接回同一个环境，不新建', async () => {
  writeAsOldLauncher({ [ID.beta1]: {} })
  assert.equal(envIdOf(ID.beta1), undefined)
  await env.restart()
  assert.equal(envIdOf(ID.beta1), firstBound[ID.beta1], '要接回原来的环境')
  assert.deepEqual((await listEnvs()).map((item) => item.id).sort(), firstEnvIds, '不能多出环境')
})

test('旧版删掉 environment 并改了版本 → 接回原环境，环境版本跟着改，启动项版本保持旧版写的值', async () => {
  writeAsOldLauncher({ [ID.alpha]: { version: '1.2.0' } })
  await env.restart()
  assert.equal(envIdOf(ID.alpha), firstBound[ID.alpha], '仍是原来的环境')
  assert.equal(storedPreset(ID.alpha).version, '1.2.0', '旧版最后写，启动项的版本以它为准')
  const alpha = (await listEnvs()).find((item) => item.id === firstBound[ID.alpha])
  assert.equal(alpha.dshVersion, '1.2.0', '环境的 DSH 版本跟着旧版改过的版本走')
  assert.deepEqual(listOf(alpha), LIST.alpha, '插件列表不动')
  assert.deepEqual((await listEnvs()).map((item) => item.id).sort(), firstEnvIds)
})

test('settings.json 被还原成迁移前的备份 → 重启后每个启动项接回同样的环境 id', async () => {
  copyFileSync(backupFile, env.settingsFile)
  await env.restart()
  assert.deepEqual(boundIds(), firstBound, '同样的老数据要映射到同样的环境')
  assert.deepEqual((await listEnvs()).map((item) => item.id).sort(), firstEnvIds, '不能多出环境')
  assert.ok(readFileSync(backupFile).equals(backupBytes), '备份仍是第一次那份')
})

// ---------------------------------------------------------------- 外部新建的 Profile

test('启动器之外新建的 Profile（带清单）→ 下次启动补收养成环境', async () => {
  seedProfile(dirs.home, 'late', profileManifest('late', LIST.late))
  const before = snapshotDir(profileDir(dirs.home, 'late'))
  await env.restart()
  const late = (await listEnvs()).find((item) => item.name === 'late')
  assert.ok(late, '新 Profile 要被收养')
  assert.deepEqual(listOf(late), LIST.late)
  assert.deepEqual(snapshotDir(profileDir(dirs.home, 'late')), before, '收养不改 Profile 目录')
  assert.deepEqual(boundIds(), firstBound, '老启动项的绑定不受影响')
})

// ---------------------------------------------------------------- 用户删掉收养来的环境

test('删掉收养来的环境 → 记进 dismissed，重启后不再按那个 Profile 收养回来', async () => {
  const late = (await listEnvs()).find((item) => item.name === 'late')
  assert.ok(late, '上一步收养的 late 环境要在')
  const removed = await env.call('/api/environments/remove', { id: late.id })
  assert.ok(removed.ok, `删除失败：HTTP ${removed.status} ${JSON.stringify(removed.data)}`)
  const state = JSON.parse(readFileSync(join(env.app, 'envs', 'state.json'), 'utf8'))
  assert.ok(state.dismissed.includes(late.id), '删掉的收养环境要记进 dismissed')
  await env.restart()
  assert.equal((await listEnvs()).some((item) => item.id === late.id || item.name === 'late'), false, 'Profile 目录还在，但用户删过的不能再收养回来')
  assert.ok(existsSync(join(profileDir(dirs.home, 'late'), 'package.json')), '删环境不动 Profile 目录')
})
