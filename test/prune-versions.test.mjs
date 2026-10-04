import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { autoCleanEnabled, versionsToKeep } from '../server.js'
import { DEFAULTS } from '../settings.js'

const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')

const sorted = (set) => [...set].sort()

// 自动清理旧版本：装完新版本删掉更旧的是默认行为（保持原样），设置里能关掉。
// 关掉之后一个都不删——用户宁可占地方也要留住每个版本，别让脏值把它当成开着。

test('默认开着，老配置文件里没这个键就照旧清理', () => {
  assert.equal(DEFAULTS.autoCleanVersions, true)
  assert.equal(autoCleanEnabled({}), true)
  assert.equal(autoCleanEnabled(undefined), true)
  assert.equal(autoCleanEnabled({ autoCleanVersions: true }), true)
  for (const bad of ['', 0, null, 'false', {}]) {
    assert.equal(autoCleanEnabled({ autoCleanVersions: bad }), true, `脏值 ${JSON.stringify(bad)} 不算关掉`)
  }
})

test('只有显式 false 才算关掉', () => {
  assert.equal(autoCleanEnabled({ autoCleanVersions: false }), false)
})

test('闸门在删文件之前：关掉后一个版本都不删', () => {
  assert.match(
    server,
    /if \(!autoCleanEnabled\(settings\)\) \{[\s\S]{0,240}?return \[\]/,
    '关掉设置就直接返回，走不到下面的 rm',
  )
  assert.match(server, /自动清理旧版本已关闭/, '日志里说清为什么没清理')
})

test('装旧版不会把最新版清掉', () => {
  // 已经装了 0.1.13 和 0.1.12，用户在下拉里挑了 0.1.11，
  // install() 会把刚装的那个插到 config.versions 最前面
  assert.deepEqual(sorted(versionsToKeep(['0.1.11', '0.1.12', '0.1.13'])), ['0.1.11', '0.1.13'])
})

test('装新版保留刚装的 + 上一个（回退用）', () => {
  assert.deepEqual(sorted(versionsToKeep(['0.1.13', '0.1.12', '0.1.11'])), ['0.1.12', '0.1.13'])
})

test('正在跑的那个一定留下', () => {
  assert.deepEqual(
    sorted(versionsToKeep(['0.1.13', '0.1.12', '0.1.11'], '0.1.11')),
    ['0.1.11', '0.1.12', '0.1.13'],
  )
})

test('多开时每个在跑的版本都要留下', () => {
  // 同时跑着 0.1.12 和 0.1.11：装个新版清理时不能把正在跑的那两个删掉
  assert.deepEqual(
    sorted(versionsToKeep(['0.1.13', '0.1.12', '0.1.11'], ['0.1.12', '0.1.11'])),
    ['0.1.11', '0.1.12', '0.1.13'],
  )
})

test('预发布版按 semver 比，不按字符串比', () => {
  // alpha.10 比 alpha.2 新，所以它该排在 alpha.2 前面、被优先保留
  assert.deepEqual(
    sorted(versionsToKeep(['0.1.6-alpha.2', '0.1.6-alpha.10', '0.1.5'])),
    ['0.1.6-alpha.10', '0.1.6-alpha.2'],
  )
})

test('认不出版本的项不会被当成最新', () => {
  assert.deepEqual(sorted(versionsToKeep(['0.1.13', 'bogus', '0.1.12'])), ['0.1.12', '0.1.13'])
})

test('空列表不炸', () => {
  assert.equal(versionsToKeep([]).size, 0)
})

test('limit 决定保留几个', () => {
  assert.equal(versionsToKeep(['0.1.13', '0.1.12', '0.1.11'], null, 1).size, 1)
})
