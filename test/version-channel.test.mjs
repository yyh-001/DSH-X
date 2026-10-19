/**
 * 版本类别（更新通道）单元测试：version.js 的分类与通道包含关系、settings.js 的通道校验与启动项存储。
 *
 * 用例清单（期望全部来自需求，不看实现）：
 * 等价类（versionChannel）
 *   E1 正式版：无预发布段（1.0.0、0.2.0、两段/一段版本号）；构建元数据不算预发布（1.2.3+build.5）
 *   E2 RC：预发布首段是 rc（0.2.1-rc.2、1.0.0-rc.1、rc.114514、裸 rc、rc 带构建元数据、rc 后多段）
 *   E3 Alpha：预发布首段是 alpha（alpha.5、alpha.114514、裸 alpha）
 *   E4 其余预发布都归 alpha：beta / next / canary / 纯数字预发布
 *   E5 边界：首段只是「像」rc 的（rcx.1、rc-1、x.rc.1）不是 rc，按 alpha
 *   E6 无法解析：中文、空串、标签名、尾巴悬空的 1.0.0- → 空串
 * 判定表（channelIncludes：选择 × 候选类别）3×3 全组合 + 未知选择一律不包含
 * 判定表（选择 × 候选类别 × 更新/相等/更旧）27 组合：仅「包含且严格更新」才提示
 * 边界（严格更新）：rc.9→rc.10 提示、rc.10→同号正式版提示、同号 alpha 不比正式版新
 * safeUpdateChannel：三个合法值原样；undefined/null/'' → official；其余（大小写、空白、数字、布尔、对象）抛错
 * safeLaunchPresets 状态：rc/alpha 保留；official 与缺省省略字段；坏值退回 official 且不丢启动项；内置项同样保留；结果幂等
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as version from '../version.js'
import * as settings from '../settings.js'
import { cmpVer, parseVer } from '../version.js'

const { versionChannel, channelIncludes } = version

test('VERSION_CHANNELS 按从稳定到不稳定排列：official、rc、alpha', () => {
  assert.deepEqual(Array.from(version.VERSION_CHANNELS ?? []), ['official', 'rc', 'alpha'])
})

test('无预发布段的是正式版，构建元数据不算预发布', () => {
  assert.equal(typeof versionChannel, 'function', 'version.js 要导出 versionChannel')
  for (const item of ['1.0.0', '0.2.0', '0.0.1', '10.20.30', '1.2', '1', '1.2.3+build.5', '1.0.0+rc.1']) {
    assert.equal(versionChannel(item), 'official', `${item} 应该是正式版`)
  }
})

test('预发布首段是 rc 的是 RC（含裸 rc、构建元数据、多段）', () => {
  for (const item of ['0.2.1-rc.2', '1.0.0-rc.1', '1.0.0-rc.114514', '1.0.0-rc', '1.2.3-rc.1+build.5', '1.0.0-rc.1.2', '0.1.0-rc.0']) {
    assert.equal(versionChannel(item), 'rc', `${item} 应该是 RC`)
  }
})

test('预发布首段是 alpha 的是 Alpha', () => {
  for (const item of ['0.2.1-alpha.5', '1.0.0-alpha.114514', '1.0.0-alpha', '1.0.0-alpha.1+build.9']) {
    assert.equal(versionChannel(item), 'alpha', `${item} 应该是 Alpha`)
  }
})

test('其余预发布（beta、next、canary、纯数字）都归最不稳定的 Alpha', () => {
  for (const item of ['1.0.0-beta.1', '1.0.0-next.3', '1.0.0-canary', '1.0.0-1', '1.0.0-0.3.7', '2.0.0-preview.2']) {
    assert.equal(versionChannel(item), 'alpha', `${item} 不是 rc，应归 Alpha`)
  }
})

test('首段只是看起来像 rc 的不算 RC', () => {
  // 需求按「点分隔的第一段」判断：rcx、rc-1 都不是 rc 这个标识，rc 出现在后面的段也不算。
  for (const item of ['1.0.0-rcx.1', '1.0.0-rc-1', '1.0.0-x.rc.1', '1.0.0-pre.rc']) {
    assert.equal(versionChannel(item), 'alpha', `${item} 的首段不是 rc`)
  }
})

test('无法解析的字符串没有类别', () => {
  for (const item of ['不是版本号', '', 'latest', '1.0.0-', 'abc-rc.1', 'rc']) {
    assert.equal(versionChannel(item), '', `${JSON.stringify(item)} 不该有类别`)
  }
})

// 需求第 3 条：越不稳定的选择，越多类别会被提示。
const INCLUDES = {
  official: { official: true, rc: false, alpha: false },
  rc: { official: true, rc: true, alpha: false },
  alpha: { official: true, rc: true, alpha: true },
}

test('通道包含关系判定表：alpha 收全部、rc 收 rc 与正式版、official 只收正式版', () => {
  assert.equal(typeof channelIncludes, 'function', 'version.js 要导出 channelIncludes')
  for (const [selected, row] of Object.entries(INCLUDES)) {
    for (const [channel, expected] of Object.entries(row)) {
      assert.equal(channelIncludes(selected, channel), expected, `选 ${selected} 时 ${channel} 版本${expected ? '要' : '不该'}提示`)
    }
  }
})

test('未知的选择值什么都不包含', () => {
  for (const selected of ['', 'beta', 'stable', 'RC', undefined, null, 0, 2]) {
    for (const channel of ['official', 'rc', 'alpha']) {
      assert.equal(channelIncludes(selected, channel), false, `选择 ${JSON.stringify(selected)} 不该包含 ${channel}`)
    }
  }
})

/** 需求里的完整提示规则：候选属于所选通道包含的类别，且严格新于正在用的版本。 */
function notified(selected, current, candidate) {
  return channelIncludes(selected, versionChannel(candidate)) && cmpVer(parseVer(candidate), parseVer(current)) > 0
}

test('提示判定表：选择 × 候选类别 × 更新/相等/更旧，只有「包含且严格更新」才提示', () => {
  const candidates = { official: '2.0.0', rc: '2.0.0-rc.3', alpha: '2.0.0-alpha.3' }
  const currents = { newer: '1.9.0', equal: null, older: '3.0.0' }
  for (const selected of Object.keys(INCLUDES)) {
    for (const [channel, candidate] of Object.entries(candidates)) {
      for (const [relation, current] of Object.entries(currents)) {
        const expected = INCLUDES[selected][channel] && relation === 'newer'
        assert.equal(notified(selected, current ?? candidate, candidate), expected,
          `选 ${selected}、候选 ${candidate}（${relation}）应${expected ? '' : '不'}提示`)
      }
    }
  }
})

test('严格更新的边界：数字段按数值比，正式版高于同号预发布版', () => {
  assert.equal(notified('rc', '1.0.0-rc.9', '1.0.0-rc.10'), true, 'rc.10 比 rc.9 新')
  assert.equal(notified('rc', '1.0.0-rc.10', '1.0.0-rc.9'), false)
  assert.equal(notified('rc', '1.0.0-rc.10', '1.0.0'), true, '用 rc 的人要被告知同号正式版')
  assert.equal(notified('alpha', '1.0.0-alpha.114514', '1.0.0-rc.1'), true, '同号 rc 比 alpha 新，alpha 通道要提示')
  assert.equal(notified('alpha', '1.0.0', '1.0.0-alpha.9'), false, '同号 alpha 不比正式版新')
  assert.equal(notified('official', '1.0.0-rc.1', '1.0.0'), true, '用着 rc 但选正式版：正式版发布要提示')
  assert.equal(notified('official', '0.9.0', '1.0.0-rc.1'), false, '选正式版从不提示 rc')
})

test('DEFAULT_UPDATE_CHANNEL 是 official', () => {
  assert.equal(settings.DEFAULT_UPDATE_CHANNEL, 'official')
})

test('safeUpdateChannel：合法值原样返回，空值回默认 official', () => {
  const { safeUpdateChannel } = settings
  assert.equal(typeof safeUpdateChannel, 'function', 'settings.js 要导出 safeUpdateChannel')
  for (const channel of ['official', 'rc', 'alpha']) assert.equal(safeUpdateChannel(channel), channel)
  for (const empty of [undefined, null, '']) assert.equal(safeUpdateChannel(empty), 'official', `${JSON.stringify(empty)} 回默认`)
})

test('safeUpdateChannel：其余任何值都抛错（大小写、空白、近义词、数字、布尔、对象）', () => {
  const { safeUpdateChannel } = settings
  assert.equal(typeof safeUpdateChannel, 'function', 'settings.js 要导出 safeUpdateChannel')
  for (const bad of ['beta', 'stable', 'latest', 'next', 'RC', 'Official', 'ALPHA', ' rc', 'rc ', 0, 1, 2, true, false, {}, [], ['rc']]) {
    assert.throws(() => safeUpdateChannel(bad), Error, `${JSON.stringify(bad)} 不是通道，应拒绝`)
  }
})

const preset = (id, extra = {}) => ({ id: id.repeat(16), name: `项${id}`, version: 'auto', profile: 'web', port: 0, ...extra })
const BUILTIN_ID = '0000000000000000'

test('safeLaunchPresets：rc / alpha 跟着启动项保存，official 和缺省都省略字段', () => {
  const list = settings.safeLaunchPresets([
    preset('a', { updateChannel: 'rc' }),
    preset('b', { updateChannel: 'alpha' }),
    preset('c', { updateChannel: 'official' }),
    preset('d'),
  ])
  const byId = (id) => list.find((item) => item.id === id.repeat(16))
  assert.equal(byId('a')?.updateChannel, 'rc')
  assert.equal(byId('b')?.updateChannel, 'alpha')
  assert.ok(byId('c'), 'official 的启动项要保留')
  assert.equal('updateChannel' in byId('c'), false, 'official 是默认值，不写字段')
  assert.ok(byId('d'))
  assert.equal('updateChannel' in byId('d'), false, '从没选过的保持没有字段（即 official）')
  assert.equal(byId('a').name, '项a', '其他字段不受影响')
  assert.equal(byId('a').version, 'auto')
})

test('safeLaunchPresets：坏的通道值退回 official，启动项本身不丢', () => {
  for (const bad of ['nightly', 'RC', 2, true, null, {}, '']) {
    const list = settings.safeLaunchPresets([preset('e', { updateChannel: bad, version: '1.0.0' })])
    const entry = list.find((item) => item.id === 'e'.repeat(16))
    assert.ok(entry, `通道值 ${JSON.stringify(bad)} 不能让启动项被丢弃`)
    assert.equal('updateChannel' in entry, false, `通道值 ${JSON.stringify(bad)} 退回 official（省略字段）`)
    assert.equal(entry.version, '1.0.0')
  }
})

test('safeLaunchPresets：内置项也保存自己的通道，结果再过一遍不变', () => {
  const input = [{ id: BUILTIN_ID, name: 'DSH', version: 'auto', profile: 'web', port: 0, updateChannel: 'alpha' }, preset('f', { updateChannel: 'rc' })]
  const once = settings.safeLaunchPresets(input)
  assert.equal(once.find((item) => item.id === BUILTIN_ID)?.updateChannel, 'alpha')
  assert.deepEqual(settings.safeLaunchPresets(once), once, '校验结果应当幂等')
  // 没有任何启动项时补出的内置项默认跟随正式版。
  const builtin = settings.safeLaunchPresets([]).find((item) => item.id === BUILTIN_ID)
  assert.ok(builtin)
  assert.equal(builtin.updateChannel ?? 'official', 'official')
})
