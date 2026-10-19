/**
 * 版本类型的系统测试（远端已有正式版的情形）：进程内真服务 + 本地假 npm registry + 隔离用户目录。
 * 「还没有正式版」时的退档、查重与状态迁移见 update-channel-plans.test.mjs；托盘、在跑实例与自动启动见 update-channel-launch.test.mjs。
 *
 * 远端版本表（服务端缓存 60 秒，整个文件只用这一份）：
 *   dist-tags：latest=1.0.0（低于已发布的 1.0.1）、next=1.1.0-rc.11、alpha=1.2.0-alpha.10（标签都指向已发布的版本，跟真 registry 一样）
 *   versions：0.9.0、1.0.0-rc.1、1.0.0、1.0.1、1.1.0-alpha.2、1.1.0-rc.9、1.1.0-rc.10、1.1.0-rc.11、
 *             1.2.0-alpha.3、1.2.0-alpha.10、1.2.0-beta.1、not-a-version（无法解析，忽略）
 *   期望：latest=1.2.0-beta.1；三类都已知，所以不退档；official=1.0.1；rc=1.1.0-rc.11（数值比较，rc.11 > rc.10 > rc.9）；
 *         alpha=1.2.0-beta.1（beta 归 alpha；rc 不能收它）
 *
 * 用例清单
 * /api/remote（等价类 + 边界）
 *   R1 latest 仍是「全部里最高」，tags / versions 照旧给；R2 不再带 latestByChannel（按类型的最新版改由 channelPlans 给）
 * /api/state 的 channelPlans（契约）
 *   C1 三个键、每份 { channel, installed, latest }：channel 不退档；installed 只含该类型接受的已装版本、从高到低；latest 是该类型接受的最新已发布版
 *   C2 页面连上事件流收到的第一份状态推送里也有同样的 channelPlans
 * /api/launch-presets + /api/state + settings.json（状态迁移：未设置 → rc → alpha → official → 省略字段）
 *   S1 内置项与新启动项未设置时都是 official（无字段）
 *   S2 新建时带 rc：响应、状态、落盘都是 rc
 *   S3 rc → alpha；S4 编辑不带字段（改名、改版本）保持 alpha
 *   S5 alpha → official：落盘省略字段；S6 再编辑不带字段仍是 official
 *   S7 非法值（beta、RC、数字、对象）编辑被拒（非 2xx），原值 rc 不变；非法值新建被拒、不新增条目
 *   S8 内置项也能改类型；S9 重启管理器后类型仍在
 *   S10 设置文件里的坏类型值：读出时退回 official，启动项不丢
 * /api/pending（判定表：启动项类型的并集 × 已装版本与该类型最新的关系）
 *   P1 全部 official，已装 1.0.0 → 提示 1.0.1
 *   P2 全部 official，已装 1.0.1（相等）→ 不提示，即使有更新的 rc/alpha
 *   P3 全部 official，已装 1.0.0 + 更高的 1.1.0-rc.10 → 提示 1.0.1，current 是 1.0.0（正式版项不认 RC，更高的 RC 不挡提示）
 *   P4 有一项 rc，已装 1.0.1 → 提示 1.1.0-rc.11；P5 已装 1.1.0-rc.9 → 提示 rc.11（数值边界）
 *   P6 有一项 rc，已装 1.1.0-rc.11（相等）→ 不提示
 *   P7 一项 rc 一项 alpha，已装 1.1.0-rc.11 → 提示 1.2.0-beta.1
 *   P8 内置项 alpha、其余 official → 取最不稳定的 alpha
 *   P9 已装 1.3.0（比所有远端都新）+ alpha → 不提示
 *   P10 跳过：跳过了 1.0.1 就不再拿它提示；跳过记录换成别的版本后又会提示
 *   P0 一个版本都没装 → 不提示（本机另有全局 dsh 时如实跳过）
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { BUILTIN_ID, TYPES, expectedPlan, packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const REMOTE = packumentOf(
  { latest: '1.0.0', next: '1.1.0-rc.11', alpha: '1.2.0-alpha.10' },
  ['0.9.0', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0-alpha.2', '1.1.0-rc.9', '1.1.0-rc.10', '1.1.0-rc.11',
    '1.2.0-alpha.3', '1.2.0-alpha.10', '1.2.0-beta.1', 'not-a-version'],
)
const LATEST = { official: '1.0.1', rc: '1.1.0-rc.11', alpha: '1.2.0-beta.1' }

const env = await startChannelServer({ prefix: 'dsh-update-channel-', packument: REMOTE, installed: ['1.0.0'] })
test.after(() => env.cleanup())

const channelOf = (entry) => entry?.updateChannel ?? 'official'
const findIn = (list, id) => (list || []).find((item) => item.id === id)
const storedEntry = (id) => findIn(env.stored().launchPresets, id)
const stateEntry = async (id) => findIn((await env.state()).launchPresets, id)
/** 契约里的三个字段；多给的字段不算错。 */
const planFields = (plan) => plan && { channel: plan.channel, installed: Array.from(plan.installed ?? []), latest: plan.latest }

/** 保存启动项；失败时带上服务端的说法，方便定位是哪条规则拒绝的。 */
async function save(body) {
  const result = await env.call('/api/launch-presets', body)
  assert.ok(result.ok, `保存启动项失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data.entry
}

/** 三处（响应 / 状态 / 落盘）对同一个启动项的类型说法要一致。 */
async function expectChannel(id, expected, response, why) {
  if (response) assert.equal(channelOf(response), expected, `${why}：响应 entry`)
  assert.equal(channelOf(await stateEntry(id)), expected, `${why}：/api/state`)
  const stored = storedEntry(id)
  assert.ok(stored, `${why}：settings.json 里要有这个启动项`)
  if (expected === 'official') assert.equal('updateChannel' in stored, false, `${why}：official 落盘时省略字段`)
  else assert.equal(stored.updateChannel, expected, `${why}：settings.json`)
}

test('/api/remote：latest 仍是全部里最高，tags / versions 照旧，不再带 latestByChannel', async () => {
  const remote = await env.remote()
  assert.equal(remote.latest, '1.2.0-beta.1', '总体最新仍是全部里最高的那个（只给「最新」角标用）')
  assert.equal(remote.tags?.latest, '1.0.0')
  assert.ok(Array.from(remote.versions ?? []).includes('1.0.1'), 'versions 照旧给出已发布版本')
  assert.equal('latestByChannel' in remote, false, '按类型的最新版改由 /api/state 的 channelPlans 给')
  assert.ok(env.fetchedPackage(), '远端列表来自假 registry')
})

test('channelPlans：三类都已知时不退档，installed 只含接受的已装版本（从高到低），latest 是接受的最新已发布版', async () => {
  // 已装版本故意乱序、各类都有，验证过滤与排序；本机若另有全局 dsh，服务端会如实把它算进已装，期望照需求一起算
  env.installVersions(['1.0.0', '1.2.0-alpha.3', '0.9.0', '1.1.0-rc.9'])
  const remote = await env.remote()
  const state = await env.state()
  assert.ok(state.channelPlans && typeof state.channelPlans === 'object', '/api/state 要带 channelPlans')
  assert.deepEqual(Object.keys(state.channelPlans).sort(), [...TYPES].sort(), '键就是三种选的类型')
  for (const type of TYPES) {
    const plan = planFields(state.channelPlans[type])
    assert.equal(plan.channel, type, `${type}：三类都有已知版本，不退档`)
    assert.equal(plan.latest, LATEST[type], `${type}：latest 是它接受的最新已发布版`)
    assert.deepEqual(plan, expectedPlan(type, Array.from(state.installed), remote.versions), `${type} 的计划`)
  }
  assert.deepEqual(planFields(state.channelPlans.official).installed.slice(0, 2), ['1.0.0', '0.9.0'], '正式版：只有正式版，从高到低')
  assert.equal(planFields(state.channelPlans.rc).installed[0], '1.1.0-rc.9', 'RC：已装里最高的 RC 排第一，不收 Alpha')
  assert.ok(!planFields(state.channelPlans.rc).installed.includes('1.2.0-alpha.3'), 'RC 不收 Alpha')
  assert.equal(planFields(state.channelPlans.alpha).installed[0], '1.2.0-alpha.3', 'Alpha 全收，最高的排第一')
  const pushed = await env.firstPush()
  assert.deepEqual(Object.fromEntries(TYPES.map((type) => [type, planFields(pushed.channelPlans?.[type])])),
    Object.fromEntries(TYPES.map((type) => [type, planFields(state.channelPlans[type])])), '状态推送里的 channelPlans 与 /api/state 一致')
  env.installVersions(['1.0.0'])
})

let work = null
test('启动项类型的状态迁移：未设置 → rc → alpha（不带字段保持）→ official（省略字段）', async () => {
  const builtin = await stateEntry(BUILTIN_ID)
  assert.ok(builtin, '内置启动项一直存在')
  assert.equal(channelOf(builtin), 'official', '从没选过的内置项跟随正式版')
  const plain = await save({ name: '未设置', version: '0.4.0', profile: 'web', port: 0 })
  await expectChannel(plain.id, 'official', plain, '新建不带类型')
  await env.call('/api/launch-presets/remove', { id: plain.id })

  work = await save({ name: '工作', version: '0.5.0', profile: 'web', port: 0, updateChannel: 'rc' })
  assert.match(work.id, /^[a-f0-9]{16}$/)
  await expectChannel(work.id, 'rc', work, '新建时选 rc')

  const alpha = await save({ ...work, updateChannel: 'alpha' })
  await expectChannel(work.id, 'alpha', alpha, 'rc 改 alpha')

  const { updateChannel, ...withoutChannel } = alpha
  const renamed = await save({ ...withoutChannel, name: '工作改名' })
  await expectChannel(work.id, 'alpha', renamed, '只改名、不带类型字段')
  assert.equal((await stateEntry(work.id)).name, '工作改名')
  const moved = await save({ ...withoutChannel, name: '工作改名', version: '0.5.1' })
  await expectChannel(work.id, 'alpha', moved, '改版本、不带类型字段')

  const official = await save({ ...withoutChannel, name: '工作改名', version: '0.5.1', updateChannel: 'official' })
  await expectChannel(work.id, 'official', official, 'alpha 改回 official')
  const again = await save({ ...withoutChannel, name: '工作再改', version: '0.5.1' })
  await expectChannel(work.id, 'official', again, 'official 后不带字段再编辑')
  work = again
})

test('非法类型值：编辑与新建都被拒，已存的类型和启动项列表不变', async () => {
  assert.ok(work, '依赖上一条用例建好的启动项')
  work = await save({ ...work, updateChannel: 'rc' })
  await expectChannel(work.id, 'rc', work, '准备：先设为 rc')
  const before = JSON.stringify(env.stored().launchPresets)
  for (const bad of ['beta', 'RC', 'stable', 2, { channel: 'rc' }]) {
    const result = await env.call('/api/launch-presets', { ...work, name: '不该保存', updateChannel: bad })
    assert.ok(!result.ok, `类型 ${JSON.stringify(bad)} 应该被拒，实际 HTTP ${result.status}`)
    assert.equal(JSON.stringify(env.stored().launchPresets), before, `类型 ${JSON.stringify(bad)} 被拒后设置文件不变`)
  }
  await expectChannel(work.id, 'rc', null, '非法写入之后')
  assert.equal((await stateEntry(work.id)).name, work.name, '其他字段也没被改')
  const count = (await env.state()).launchPresets.length
  const created = await env.call('/api/launch-presets', { name: '坏类型', version: '0.7.0', profile: 'web', port: 0, updateChannel: 'nightly' })
  assert.ok(!created.ok, `新建带非法类型应该被拒，实际 HTTP ${created.status}`)
  assert.equal((await env.state()).launchPresets.length, count, '被拒的新建不能留下条目')
})

test('内置项可以改类型，重启管理器后类型仍在', async () => {
  const builtin = await stateEntry(BUILTIN_ID)
  const saved = await save({ ...builtin, updateChannel: 'alpha' })
  await expectChannel(BUILTIN_ID, 'alpha', saved, '内置项改 alpha')
  await env.restart()
  await expectChannel(BUILTIN_ID, 'alpha', null, '重启后内置项')
  await expectChannel(work.id, 'rc', null, '重启后普通启动项')
  const restored = await save({ ...(await stateEntry(BUILTIN_ID)), updateChannel: 'official' })
  await expectChannel(BUILTIN_ID, 'official', restored, '内置项改回 official')
})

/** 把每个启动项的类型设成给定值；没列出的设回 official。返回设置后的启动项 id 列表。 */
async function setChannels(channels) {
  for (const entry of (await env.state()).launchPresets) {
    const updateChannel = channels[entry.id] ?? 'official'
    if (channelOf(entry) !== updateChannel) await save({ ...entry, updateChannel })
  }
  const after = (await env.state()).launchPresets
  for (const entry of after) assert.equal(channelOf(entry), channels[entry.id] ?? 'official', `准备：${entry.name} 的类型`)
}

/** 换成这几个已装版本，并读一次状态让服务端的已装列表重新扫描。 */
async function installOnly(...versions) {
  env.installVersions(versions)
  const installed = (await env.state()).installed
  for (const version of versions) assert.ok(installed.includes(version), `准备：已装版本里要有 ${version}，实际 ${JSON.stringify(installed)}`)
}

test('/api/pending：只看所有启动项里最不稳定的类型，且严格更新才提示', async (t) => {
  assert.ok(work, '依赖前面用例建好的启动项')
  const other = await save({ name: '尝鲜', version: '0.6.0', profile: 'web', port: 0 })
  const cases = [
    // [说明, 已装版本（数组 = 装了好几个，current 取第一个）, { 启动项: 类型 }, 期望提示的版本（null = 不提示）]
    ['P1 全部 official，正式版更新', '1.0.0', {}, LATEST.official],
    ['P2 全部 official，已是最新正式版；更新的 rc/alpha 不打扰', '1.0.1', {}, null],
    // 正式版项只认正式版（R1）：它解析到的是 1.0.0，比它高的 RC 不能把正式版的更新挡掉
    ['P3 全部 official，另装着更高的 RC', ['1.0.0', '1.1.0-rc.10'], {}, LATEST.official],
    ['P4 有一项 rc，提示 rc', '1.0.1', { [work.id]: 'rc' }, LATEST.rc],
    ['P5 rc.9 → rc.11 按数值比', '1.1.0-rc.9', { [work.id]: 'rc' }, LATEST.rc],
    ['P6 有一项 rc，已是最新 rc', '1.1.0-rc.11', { [work.id]: 'rc' }, null],
    ['P7 一项 rc 一项 alpha，取 alpha', '1.1.0-rc.11', { [work.id]: 'rc', [other.id]: 'alpha' }, LATEST.alpha],
    ['P8 只有内置项 alpha', '1.0.1', { [BUILTIN_ID]: 'alpha' }, LATEST.alpha],
    ['P9 已装版本比远端都新', '1.3.0', { [BUILTIN_ID]: 'alpha' }, null],
  ]
  for (const [name, versions, channels, expected] of cases) {
    const [installed, ...others] = [versions].flat()
    await t.test(name, async () => {
      await setChannels(channels)
      await installOnly(installed, ...others)
      const update = await env.pendingDsh()
      if (expected === null) {
        assert.equal(update, null, `不该提示 dsh 更新，实际 ${JSON.stringify(update)}`)
        return
      }
      assert.ok(update, `应提示 dsh 更新到 ${expected}`)
      assert.equal(update.latest, expected)
      assert.equal(update.current, installed)
    })
  }
  await setChannels({})
})

test('/api/pending：跳过的版本不再提示，跳过记录换成别的版本后又会提示', async () => {
  await setChannels({})
  await installOnly('1.0.0')
  assert.equal((await env.pendingDsh())?.latest, LATEST.official, '准备：先有提示')
  const skipped = await env.call('/api/pending/skip', { dsh: LATEST.official })
  assert.ok(skipped.ok, `跳过失败：HTTP ${skipped.status}`)
  assert.equal(await env.pendingDsh(), null, '跳过了 1.0.1 就不再拿它打扰')
  await env.call('/api/pending/skip', { dsh: '0.0.1' })
  assert.equal((await env.pendingDsh())?.latest, LATEST.official, '跳过的不是它了，又会提示')
})

test('/api/pending：一个版本都没装时不提示 dsh 更新', async (t) => {
  env.installVersions([])
  const installed = (await env.state()).installed
  // 服务端也认全局 npm 装的 dsh；本机有的话造不出「一个都没装」，如实跳过而不是假装通过。
  if (installed.length) { t.skip(`本机另有全局安装的 dsh（${installed.join('、')}）`); return }
  await setChannels({ [BUILTIN_ID]: 'alpha' })
  assert.equal(await env.pendingDsh(), null)
  await setChannels({})
})

test('设置文件里的坏类型值：读出时退回 official，启动项不丢', async () => {
  const stored = env.stored()
  const target = findIn(stored.launchPresets, work.id)
  target.updateChannel = 'nightly'
  writeFileSync(env.settingsFile, JSON.stringify(stored))
  const entry = await stateEntry(work.id)
  assert.ok(entry, '坏类型值不能让启动项消失')
  assert.equal(channelOf(entry), 'official')
  assert.equal(entry.name, target.name)
})
