/**
 * 版本类型的退档与状态迁移（系统测试）：进程内真服务 + 本地假 npm registry（可上下线、可换版本表）+ 隔离用户目录。
 * 这份夹具从「远端还连不上」起步，模拟 dsh 今天的处境：一个正式版都没发过。
 *
 * 需求（R2）：选的类型在「已知版本」里一个都不被接受时，退到下一个更不稳定的类型（official → rc → alpha）；
 * 已知 = 已发布 ∪ 已装，远端还没拉到时只有已装；一个已知版本都没有时类型原样。正式版一旦已知，正式版项只用正式版。
 * 期望照需求算（见 update-channel-fixture.mjs 的预言）；本机另有全局 dsh 时，服务端会如实把它算进已装，预言也一起算。
 *
 * 远端两张版本表：
 *   NO_OFFICIAL：0.1.0-rc.1、0.2.0-rc.1、0.2.1-rc.2、0.2.1-alpha.3、0.3.0-alpha.5（latest 标签指着一个 RC）
 *   WITH_OFFICIAL：上面 + 0.3.0（正式版）+ 0.3.1-rc.1
 *
 * 用例清单（状态迁移：远端没拉到 → 拉到、无正式版 → 正式版出现 → 正式版又没了）
 *   T1 远端没拉到、只装了 Alpha：latest 全空，只按已装退档（干净机器上正式版、RC 都退到 Alpha）；更新提示不出现
 *   T2 什么都不认得（没装、远端没拉到）：类型原样（本机另有全局 dsh 时如实跳过）
 *   T3 远端没拉到、但装了一个正式版：正式版已知，正式版项只用它，哪怕装着更高的 RC / Alpha
 *   T4 远端拉到、无正式版：正式版按 RC（latest 是 RC 的最新版）；托盘里的自动项挑 RC，不挑更高的已装 Alpha；状态推送同样
 *   T5 /api/pending 判定表（无正式版）：全 official 按 RC 提示、相等不提示、rc.1 → rc.2 数值边界、有 alpha 项取 Alpha、
 *      装了比远端都新的正式版（正式版变成已知、而远端没有）→ 不提示
 *      （需求没说「已装的全在生效类型以外」时 current 是谁，这种组合不判定，见报告）
 *   T6 保存时查重（R4）：只改类型、使解析结果撞上同目录同 profile 的另一项 → 拒绝且原样；解析不同 → 允许；
 *      新建项按解析结果查重（自动 / 钉死都算）；装上新 RC 后同一个改动变成允许
 *   T7 正式版出现：正式版项只用正式版——托盘里没装正式版就没有版本、点启动被拒（请先安装）；提示只看正式版；
 *      RC / Alpha 项收到的最新是 RC
 *   T8 正式版又没了（远端换回无正式版的表）：正式版项再次按 RC
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_ID, TYPES, expectedAuto, expectedPlan, packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const NO_OFFICIAL_VERSIONS = ['0.1.0-rc.1', '0.2.0-rc.1', '0.2.1-rc.2', '0.2.1-alpha.3', '0.3.0-alpha.5']
const NO_OFFICIAL = packumentOf({ latest: '0.2.1-rc.2', next: '0.2.1-rc.2', alpha: '0.3.0-alpha.5' }, NO_OFFICIAL_VERSIONS)
const WITH_OFFICIAL_VERSIONS = [...NO_OFFICIAL_VERSIONS, '0.3.0', '0.3.1-rc.1']
const WITH_OFFICIAL = packumentOf({ latest: '0.3.0', next: '0.3.1-rc.1', alpha: '0.3.0-alpha.5' }, WITH_OFFICIAL_VERSIONS)

const env = await startChannelServer({ prefix: 'dsh-channel-plans-', packument: NO_OFFICIAL, installed: ['0.3.0-alpha.5'], online: false })
test.after(() => env.cleanup())

const channelOf = (entry) => entry?.updateChannel ?? 'official'
const planFields = (plan) => plan && { channel: plan.channel, installed: Array.from(plan.installed ?? []), latest: plan.latest }
/** 本机除了夹具装的，没有别的 dsh（比如全局 npm 装的）：只有这时才能断言「干净机器」上的具体退档结果。 */
const clean = (state, ours) => Array.from(state.installed).every((version) => ours.includes(version))

/** 读状态，三份计划都要等于需求算出来的；published = null 表示远端还没拉到。返回状态供后续断言。 */
async function expectPlans(published, why) {
  const state = await env.state()
  assert.ok(state.channelPlans, `${why}：/api/state 要带 channelPlans`)
  for (const type of TYPES) {
    assert.deepEqual(planFields(state.channelPlans[type]), expectedPlan(type, Array.from(state.installed), published), `${why}：${type} 的计划`)
  }
  return state
}

/** 托盘里每个自动启动项挑的版本都要等于需求（这份夹具里没有在跑的实例）。 */
async function expectTray(state, published, why) {
  const rows = await env.trayLaunches()
  for (const entry of state.launchPresets.filter((item) => item.version === 'auto')) {
    const row = rows.find((item) => item.id === entry.id)
    assert.ok(row, `${why}：托盘里要有「${entry.name}」`)
    assert.equal(row.version, expectedAuto(channelOf(entry), { installed: Array.from(state.installed), published }), `${why}：托盘里「${entry.name}」（${channelOf(entry)}）挑的版本`)
  }
  return rows
}

/** 换一个已装版本，并读一次状态让服务端的已装列表重新扫描。 */
async function installOnly(...versions) {
  env.installVersions(versions)
  const installed = (await env.state()).installed
  for (const version of versions) assert.ok(installed.includes(version), `准备：已装版本里要有 ${version}，实际 ${JSON.stringify(installed)}`)
}

async function save(body) {
  const result = await env.call('/api/launch-presets', body)
  assert.ok(result.ok, `保存启动项失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data.entry
}

/** 把每个启动项设成给定类型；没列出的设回 official。 */
async function setChannels(channels) {
  for (const entry of (await env.state()).launchPresets) {
    const updateChannel = channels[entry.id] ?? 'official'
    if (channelOf(entry) !== updateChannel) await save({ ...entry, updateChannel })
  }
}

test('T1 远端没拉到、只装了 Alpha：latest 全空，只按已装版本退档，也不提示更新', async () => {
  const state = await expectPlans(null, '远端没拉到')
  for (const type of TYPES) assert.equal(state.channelPlans[type].latest, '', `${type}：远端没拉到，latest 是空串`)
  if (clean(state, ['0.3.0-alpha.5'])) {
    assert.equal(state.channelPlans.official.channel, 'alpha', '只认得一个 Alpha：正式版退两档到 Alpha')
    assert.equal(state.channelPlans.rc.channel, 'alpha', 'RC 退到 Alpha')
    assert.deepEqual(Array.from(state.channelPlans.official.installed), ['0.3.0-alpha.5'])
  }
  await expectTray(state, null, '远端没拉到')
  assert.equal(await env.pendingDsh(), null, '远端连不上就当没有更新')
})

test('T2 什么版本都不认得：类型保持选的那个', async (t) => {
  env.installVersions([])
  const state = await env.state()
  // 服务端也认全局 npm 装的 dsh；本机有的话造不出「一个都不认得」，如实跳过而不是假装通过。
  if (state.installed.length) { t.skip(`本机另有全局安装的 dsh（${state.installed.join('、')}）`); return }
  for (const type of TYPES) {
    assert.deepEqual(planFields(state.channelPlans[type]), { channel: type, installed: [], latest: '' }, `${type}：没有可比的，原样`)
  }
})

test('T3 远端没拉到、但装了一个正式版：正式版已知，正式版项只用它，不用更高的已装 RC / Alpha', async () => {
  await installOnly('0.5.0', '0.6.0-rc.1', '0.7.0-alpha.1')
  const state = await expectPlans(null, '装了正式版')
  assert.equal(state.channelPlans.official.channel, 'official', '已装的正式版也算已知，正式版不退档')
  assert.equal(state.channelPlans.official.installed[0], '0.5.0')
  assert.ok(!Array.from(state.channelPlans.official.installed).includes('0.6.0-rc.1'), '正式版只收正式版')
  assert.equal(state.channelPlans.rc.installed[0], '0.6.0-rc.1', 'RC 取已装最高的 RC / 正式版')
  assert.equal(state.channelPlans.alpha.installed[0], '0.7.0-alpha.1')
  const rows = await expectTray(state, null, '装了正式版')
  assert.equal(rows.find((row) => row.id === BUILTIN_ID)?.version, '0.5.0', '内置项（正式版）挑已装的正式版，不挑更高的 RC / Alpha')
})

test('T4 远端拉到、没有正式版：正式版按 RC 挑和提醒，托盘的自动项不挑更高的已装 Alpha，状态推送一致', async () => {
  await installOnly('0.3.0-alpha.5', '0.2.0-rc.1')
  const remote = await env.republish(NO_OFFICIAL)
  assert.equal('latestByChannel' in remote, false, '/api/remote 不再带 latestByChannel')
  assert.equal(remote.latest, '0.3.0-alpha.5', 'latest 仍是全部里最高的（只给「最新」角标）')
  const state = await expectPlans(NO_OFFICIAL_VERSIONS, '无正式版')
  assert.equal(state.channelPlans.official.channel, 'rc', '一个正式版都不认得：正式版退到 RC')
  assert.equal(state.channelPlans.official.latest, '0.2.1-rc.2', '正式版这档的最新版是 RC 的最新版')
  assert.equal(state.channelPlans.official.installed[0], '0.2.0-rc.1', '已装里 RC 最高的是 0.2.0-rc.1，更高的 Alpha 不收')
  assert.equal(state.channelPlans.rc.channel, 'rc')
  assert.equal(state.channelPlans.alpha.latest, '0.3.0-alpha.5')
  await setChannels({})
  const rows = await expectTray(state, NO_OFFICIAL_VERSIONS, '无正式版')
  assert.equal(rows.find((row) => row.id === BUILTIN_ID)?.version, '0.2.0-rc.1', '内置项（正式版）眼下按 RC，不挑更高的 0.3.0-alpha.5')
  const pushed = await env.firstPush()
  for (const type of TYPES) {
    assert.deepEqual(planFields(pushed.channelPlans?.[type]), planFields(state.channelPlans[type]), `${type}：状态推送里的计划与 /api/state 一致`)
  }
})

test('T5 /api/pending（无正式版）：按所有启动项生效类型的并集、严格更新才提示', async (t) => {
  const other = await save({ name: '尝鲜', version: 'auto', profile: 'web', port: 0, dshHome: `${env.root}/pending-home` })
  const cases = [
    // [说明, 已装版本, { 启动项: 类型 }, 期望提示的版本（null = 不提示）]
    ['全部 official：没有正式版，按 RC 提示', '0.2.0-rc.1', {}, '0.2.1-rc.2'],
    ['全部 official，已是 RC 最新：更新的 Alpha 不打扰', '0.2.1-rc.2', {}, null],
    ['全部 official，装的是旧 RC：数值边界 rc.1 → rc.2', '0.2.1-rc.1', {}, '0.2.1-rc.2'],
    ['有一项 alpha：提示 Alpha 最新', '0.2.1-rc.2', { [other.id]: 'alpha' }, '0.3.0-alpha.5'],
    ['装了比远端都新的正式版：正式版已知但远端没有，Alpha 也不更新', '0.4.0', { [other.id]: 'alpha' }, null],
  ]
  for (const [name, installed, channels, expected] of cases) {
    await t.test(name, async () => {
      await setChannels(channels)
      await installOnly(installed)
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
  await env.call('/api/launch-presets/remove', { id: other.id })
  await installOnly('0.3.0-alpha.5', '0.2.0-rc.1')
})

const DUPLICATE = /已有启动项/

test('T6 保存时按解析后的版本查重：只改类型撞上同目录同 profile 的另一项就拒绝，解析不同就允许', async () => {
  // 独立目录里做，内置项（默认目录）不掺和；已装 0.2.0-rc.1 与 0.3.0-alpha.5，远端无正式版
  const home = `${env.root}/dup-home`
  const before = (await env.state()).launchPresets.length
  const pinned = await save({ name: '钉住 RC', version: '0.2.0-rc.1', profile: 'web', port: 0, dshHome: home })
  const tryer = await save({ name: '尝鲜', version: 'auto', profile: 'web', port: 0, dshHome: home, updateChannel: 'alpha' })
  const storedTryer = () => (env.stored().launchPresets || []).find((item) => item.id === tryer.id)
  /** 期望被查重拒绝：非 2xx、说法是「已有启动项」、设置文件不变。 */
  async function rejected(body, why) {
    const snapshot = JSON.stringify(env.stored().launchPresets)
    const result = await env.call('/api/launch-presets', body)
    assert.ok(!result.ok, `${why}：应该被拒，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
    assert.match(String(result.data?.error ?? result.data), DUPLICATE, `${why}：拒绝理由是已有启动项`)
    assert.equal(JSON.stringify(env.stored().launchPresets), snapshot, `${why}：被拒后设置文件不变`)
  }
  await rejected({ ...tryer, updateChannel: 'rc' }, '自动项 alpha → rc（会解析成 0.2.0-rc.1，撞上钉住的那项）')
  await rejected({ ...tryer, updateChannel: 'official' }, '自动项 alpha → official（没有正式版，按 RC 也是 0.2.0-rc.1）')
  assert.equal(storedTryer()?.updateChannel, 'alpha', '被拒后还是 alpha')
  await rejected({ name: '再来一个', version: 'auto', profile: 'web', port: 0, dshHome: home, updateChannel: 'rc' }, '新建自动 rc 项（解析成 0.2.0-rc.1）')
  await rejected({ name: '再来一个', version: '0.3.0-alpha.5', profile: 'web', port: 0, dshHome: home }, '新建钉死 0.3.0-alpha.5（尝鲜项自动解析就是它）')

  // 装上更新的 RC 后，同一个只改类型的改动解析成 0.2.1-rc.2，跟钉住的那项不同了：允许
  env.addVersions(['0.2.1-rc.2'])
  await env.state()
  const moved = await save({ ...tryer, updateChannel: 'rc' })
  assert.equal(moved.updateChannel, 'rc', '解析不同，允许改成 rc')
  const official = await save({ ...moved, updateChannel: 'official' })
  assert.equal(official.updateChannel ?? 'official', 'official', '改成 official 也解析成 0.2.1-rc.2（自己不跟自己撞），允许')
  const third = await save({ name: '第三项', version: 'auto', profile: 'web', port: 0, dshHome: home, updateChannel: 'alpha' })
  assert.ok(third.id, '新建自动 alpha 项解析成 0.3.0-alpha.5，跟另两项都不同，允许')
  const thirdStored = () => (env.stored().launchPresets || []).find((item) => item.id === third.id)
  await rejected({ ...third, updateChannel: 'rc' }, '第三项 alpha → rc（解析成 0.2.1-rc.2，撞上已改成 official 的尝鲜项）')
  assert.equal(thirdStored()?.updateChannel, 'alpha')
  // 换个目录就不算重复
  const elsewhere = await save({ name: '别的目录', version: '0.2.0-rc.1', profile: 'web', port: 0, dshHome: `${env.root}/dup-other` })
  assert.ok(elsewhere.id, '同版本同 profile、不同目录不算重复')

  for (const entry of [pinned, tryer, third, elsewhere]) await env.call('/api/launch-presets/remove', { id: entry.id })
  assert.equal((await env.state()).launchPresets.length, before, '收尾：删掉本用例建的启动项')
  await installOnly('0.3.0-alpha.5', '0.2.0-rc.1')
})

test('T7 正式版出现：正式版项只用正式版；托盘里没装正式版就没有版本、点启动被拒；提示只看正式版', async (t) => {
  const rcEntry = await save({ name: '候选', version: 'auto', profile: 'web', port: 0, dshHome: `${env.root}/rc-home`, updateChannel: 'rc' })
  await setChannels({ [rcEntry.id]: 'rc' })
  await env.republish(WITH_OFFICIAL)
  const state = await expectPlans(WITH_OFFICIAL_VERSIONS, '正式版出现')
  assert.equal(state.channelPlans.official.channel, 'official', '正式版已知：不再退档')
  assert.equal(state.channelPlans.official.latest, '0.3.0')
  assert.ok(!Array.from(state.channelPlans.official.installed).some((version) => version.includes('-')), '正式版这档的已装里不能有预发布版')
  assert.equal(state.channelPlans.rc.latest, '0.3.1-rc.1', 'RC 收到的最新是 RC')
  assert.equal(state.channelPlans.alpha.latest, '0.3.1-rc.1', 'Alpha 也收 RC：它的最新可以是 RC')
  const rows = await expectTray(state, WITH_OFFICIAL_VERSIONS, '正式版出现')
  const builtin = rows.find((row) => row.id === BUILTIN_ID)
  assert.equal(builtin?.version, '', '内置项（正式版）没装正式版：托盘里没有可用版本，不能拿已装的 RC 顶替')
  assert.notEqual(builtin?.installed, true)
  assert.equal(rows.find((row) => row.id === rcEntry.id)?.version, '0.2.0-rc.1', 'RC 项照旧用已装的 RC')
  const instances = (await env.state()).instances.length
  const start = await env.trayAct(BUILTIN_ID, 'start')
  assert.ok(!start.ok, `没有可用版本时托盘启动应被拒，实际 HTTP ${start.status}`)
  assert.match(String(start.data?.error ?? start.data), /请先/, '拒绝理由是要先安装')
  assert.equal((await env.state()).instances.length, instances, '被拒后没有起任何实例')

  await t.test('提示：正式版项只看正式版，RC 项看 RC', async () => {
    // 只用「已装的就是生效类型接受的版本」的场景：需求没说已装版本全在生效类型以外时拿谁当 current，这里不替它定
    await setChannels({})
    await installOnly('0.2.5')
    assert.equal((await env.pendingDsh())?.latest, '0.3.0', '全部 official：旧正式版 0.2.5 → 0.3.0')
    await installOnly('0.3.0')
    assert.equal(await env.pendingDsh(), null, '全部 official、已是最新正式版：更新的 0.3.1-rc.1 不打扰')
    await setChannels({ [rcEntry.id]: 'rc' })
    assert.equal((await env.pendingDsh())?.latest, '0.3.1-rc.1', '有一项 rc：提示 0.3.1-rc.1')
  })
  await setChannels({})
  await env.call('/api/launch-presets/remove', { id: rcEntry.id })
  await installOnly('0.3.0-alpha.5', '0.2.0-rc.1')
})

test('T8 正式版又没了（远端换回无正式版的表）：正式版项再次按 RC', async () => {
  await env.republish(NO_OFFICIAL)
  const state = await expectPlans(NO_OFFICIAL_VERSIONS, '正式版又没了')
  assert.equal(state.channelPlans.official.channel, 'rc')
  assert.equal((await env.trayLaunches()).find((row) => row.id === BUILTIN_ID)?.version, '0.2.0-rc.1')
})
