/**
 * 版本类型 × 在跑实例 × 托盘 × 打开启动器时启动（系统测试）：进程内真服务 + 会真跑起来的假 dsh + 本地假 npm registry。
 *
 * 需求（R1，服务端口径）：自动项只用它的生效类型接受的版本——同 profile + 同 dsh 用户目录里在跑、且被接受的版本优先
 * （多个取最高），否则已装里被接受的最高版本；一个都没有就没有版本（托盘「请先安装」、打开启动器时跳过）。
 * 不被接受的在跑 / 已装版本一律不用，哪怕它最高。期望照需求算（update-channel-fixture.mjs 的 expectedAuto）。
 *
 * 已装：0.1.0-rc.1、0.2.0-rc.1、0.3.0-alpha.5（Alpha 是已装里最高的）；远端起初没有正式版。
 * 启动项（每项一个独立的 dsh 用户目录，假 dsh 把自己的版本号记进该目录的 spawned 文件）：
 *   开机 RC / 开机正式版 / 开机 Alpha：勾了「打开启动器时启动」
 *   同目录 RC / 同目录正式版 / 同目录 Alpha：共用一个目录、不自动启动，用来看在跑实例怎么影响解析
 *   别的目录 RC：看别的目录里在跑的不算
 *
 * 用例清单
 *   L1 打开启动器时启动：RC、正式版（没有正式版 → 按 RC）都起 0.2.0-rc.1，不起更高的已装 Alpha；Alpha 起 0.3.0-alpha.5
 *   L2 在跑实例（状态迁移：都没跑 → 跑一个 Alpha → 再跑一个旧 RC → 停掉旧 RC → 托盘启动 RC 项）
 *      - 在跑的 Alpha 不被正式版 / RC 项采用；Alpha 项采用它
 *      - 被接受的在跑版本胜过更高的已装版本；多个都被接受时取最高
 *      - 别的目录里在跑的不算
 *      - 托盘点启动：起的是该项解析出的版本
 *   L3 正式版发布后（远端已拉到）重开管理器：开机正式版项没有装正式版 → 跳过、不起任何版本、日志说明；其余照常
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { expectedAuto, packumentOf, runningBin, startChannelServer } from './update-channel-fixture.mjs'

const INSTALLED = ['0.1.0-rc.1', '0.2.0-rc.1', '0.3.0-alpha.5']
const NO_OFFICIAL_VERSIONS = ['0.1.0-rc.1', '0.2.0-rc.1', '0.2.1-rc.2', '0.3.0-alpha.5']
const NO_OFFICIAL = packumentOf({ latest: '0.2.1-rc.2', alpha: '0.3.0-alpha.5' }, NO_OFFICIAL_VERSIONS)
const WITH_OFFICIAL_VERSIONS = [...NO_OFFICIAL_VERSIONS, '0.4.0']
const WITH_OFFICIAL = packumentOf({ latest: '0.4.0', alpha: '0.3.0-alpha.5' }, WITH_OFFICIAL_VERSIONS)

const ID = { bootRc: 'a', bootOfficial: 'b', bootAlpha: 'c', rc: 'd', official: 'e', alpha: 'f', elsewhere: '1' }
const id = (key) => ID[key].repeat(16)
const homes = {}
const env = await startChannelServer({
  prefix: 'dsh-channel-launch-', packument: NO_OFFICIAL, installed: INSTALLED, bin: runningBin,
  presets: (root) => {
    const dir = (name) => (homes[name] = join(root, `home-${name}`))
    const entry = (key, name, updateChannel, dshHome, autoLaunch = false) => ({
      id: id(key), name, version: 'auto', profile: 'web', port: 0, dshHome,
      ...(updateChannel === 'official' ? {} : { updateChannel }), ...(autoLaunch ? { autoLaunch: true } : {}),
    })
    const shared = dir('shared')
    return [
      { id: '0000000000000000', name: 'DSH', version: 'auto', profile: 'web', port: 0 },
      entry('bootRc', '开机RC', 'rc', dir('bootRc'), true),
      entry('bootOfficial', '开机正式版', 'official', dir('bootOfficial'), true),
      entry('bootAlpha', '开机Alpha', 'alpha', dir('bootAlpha'), true),
      entry('rc', '同目录RC', 'rc', shared),
      entry('official', '同目录正式版', 'official', shared),
      entry('alpha', '同目录Alpha', 'alpha', shared),
      entry('elsewhere', '别的目录RC', 'rc', dir('elsewhere')),
    ]
  },
})
test.after(() => env.cleanup())

const spawned = (home) => existsSync(join(home, 'spawned')) ? readFileSync(join(home, 'spawned'), 'utf8').trim().split('\n') : []
async function waitFor(predicate, why, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `等待超时：${why}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const live = (state, home) => state.instances.filter((item) => item.home === home && item.profile === 'web' && ['running', 'starting'].includes(item.status)).map((item) => item.version)

/** 托盘里这几个启动项挑的版本都要等于需求（在跑的按各自目录算）；published = null 表示远端还没拉到。 */
async function expectTray(keys, published, why) {
  const state = await env.state()
  const rows = await env.trayLaunches()
  for (const key of keys) {
    const entry = state.launchPresets.find((item) => item.id === id(key))
    const row = rows.find((item) => item.id === id(key))
    assert.ok(entry && row, `${why}：托盘里要有 ${key}`)
    const expected = expectedAuto(entry.updateChannel ?? 'official', { installed: Array.from(state.installed), published, running: live(state, entry.dshHome) })
    assert.equal(row.version, expected, `${why}：「${entry.name}」挑的版本`)
  }
  return rows
}

test('L1 打开启动器时启动：自动项只起自己类型接受的版本，不起更高的已装 Alpha', async () => {
  await waitFor(() => ['bootRc', 'bootOfficial', 'bootAlpha'].every((key) => spawned(homes[key]).length), '三个开机启动项都起来')
  // 启动时远端可能还没拉到（只按已装算），也可能已经拉到；两种情况下需求给的结果相同（远端也没有正式版）
  assert.deepEqual(spawned(homes.bootRc), ['0.2.0-rc.1'], 'RC 项起已装最高的 RC')
  assert.deepEqual(spawned(homes.bootOfficial), ['0.2.0-rc.1'], '正式版项：没有正式版，按 RC 起 0.2.0-rc.1')
  assert.deepEqual(spawned(homes.bootAlpha), ['0.3.0-alpha.5'], 'Alpha 项起已装最高的版本')
  for (const home of ['shared', 'elsewhere']) assert.equal(spawned(homes[home]).length, 0, `${home} 目录里的启动项没勾自动启动，不起`)
  await env.remote()
  await expectTray(['bootRc', 'bootOfficial', 'bootAlpha'], NO_OFFICIAL_VERSIONS, '开机启动后')
})

test('L2 在跑实例：只采用被接受的在跑版本，多个取最高，别的目录不算；托盘启动起解析出的版本', async () => {
  await env.remote()
  const keys = ['rc', 'official', 'alpha', 'elsewhere']
  await expectTray(keys, NO_OFFICIAL_VERSIONS, '都没跑')

  await env.startIn(homes.shared, '0.3.0-alpha.5')
  let rows = await expectTray(keys, NO_OFFICIAL_VERSIONS, '同目录跑着 Alpha')
  const of = (key) => rows.find((row) => row.id === id(key))
  assert.equal(of('rc').version, '0.2.0-rc.1', 'RC 项不采用在跑的 Alpha')
  assert.equal(of('official').version, '0.2.0-rc.1', '正式版项（按 RC）也不采用')
  assert.equal(of('alpha').version, '0.3.0-alpha.5', 'Alpha 项采用在跑的 Alpha')

  await env.startIn(homes.shared, '0.1.0-rc.1')
  rows = await expectTray(keys, NO_OFFICIAL_VERSIONS, '同目录再跑一个旧 RC')
  assert.equal(of('rc').version, '0.1.0-rc.1', '被接受的在跑版本胜过更高的已装 0.2.0-rc.1')
  assert.equal(of('official').version, '0.1.0-rc.1')
  assert.equal(of('alpha').version, '0.3.0-alpha.5', '两个在跑的都被 Alpha 接受：取最高')
  assert.equal(of('elsewhere').version, '0.2.0-rc.1', '别的目录里在跑的不算')

  await env.stopIn(homes.shared, '0.1.0-rc.1')
  await waitFor(async () => !live(await env.state(), homes.shared).includes('0.1.0-rc.1'), '旧 RC 停下')
  rows = await expectTray(keys, NO_OFFICIAL_VERSIONS, '停掉旧 RC')
  assert.equal(of('rc').version, '0.2.0-rc.1', '停掉后回到已装最高的 RC')

  const before = spawned(homes.shared).length
  const started = await env.trayAct(id('rc'), 'start')
  assert.ok(started.ok, `托盘启动 RC 项失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)
  await waitFor(() => spawned(homes.shared).length > before, '托盘启动的实例起来')
  assert.equal(spawned(homes.shared).at(-1), '0.2.0-rc.1', '托盘启动起的是 RC 项解析出的版本，不是同目录在跑的 Alpha')
  rows = await expectTray(keys, NO_OFFICIAL_VERSIONS, '托盘启动 RC 项之后')
  assert.equal(of('alpha').version, '0.3.0-alpha.5', 'Alpha 项仍取在跑里最高的')
})

test('L3 正式版发布后重开管理器：开机正式版项没装正式版就跳过，不起别的类型；其余照常', async () => {
  await env.republish(WITH_OFFICIAL)
  // 同一进程里重开管理器：远端列表已经拉到过（R2 里「已拉到」的状态），正式版是已知的
  const counts = Object.fromEntries(['bootRc', 'bootOfficial', 'bootAlpha'].map((key) => [key, spawned(homes[key]).length]))
  await env.restart()
  await waitFor(() => spawned(homes.bootRc).length > counts.bootRc && spawned(homes.bootAlpha).length > counts.bootAlpha, '其余开机启动项重新起来')
  assert.equal(spawned(homes.bootRc).at(-1), '0.2.0-rc.1', 'RC 项：没装正式版，照旧用已装最高的 RC')
  assert.equal(spawned(homes.bootAlpha).at(-1), '0.3.0-alpha.5')
  await waitFor(async () => /自动启动「开机正式版」[^\n]*跳过/.test((await env.call('/api/logs/export')).data), '日志写明开机正式版项被跳过', 5000)
  assert.equal(spawned(homes.bootOfficial).length, counts.bootOfficial, '正式版项没有起任何版本（不能拿已装的 RC 顶替）')
  const state = await env.state()
  assert.equal(state.channelPlans.official.channel, 'official', '正式版已知：正式版项只用正式版')
  assert.ok(!live(state, homes.bootOfficial).length, '正式版项的目录里没有实例')
  const row = (await env.trayLaunches()).find((item) => item.id === id('bootOfficial'))
  assert.equal(row?.version, '', '托盘里正式版项也没有版本')
})
