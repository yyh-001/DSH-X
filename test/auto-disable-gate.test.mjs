import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { dshToleratesOptionalFailures } from '../server.js'

const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')

// 兼容模式（自动禁用出问题的插件）是老版本唯一的安全网，得留着；但 0.1.7-rc.1 起 dsh
// 自己就会隔离可选插件失败（其余插件照常跑，必需插件才退出），还给了分类诊断与插件页入口，
// 那种版本上启动器再按 stdout 正则替用户改补丁层就是多余且可能误伤。

test('只有 0.1.7-rc.1 及以后才算「自己扛得住」', () => {
  assert.equal(dshToleratesOptionalFailures('0.1.6-alpha.2'), false)
  assert.equal(dshToleratesOptionalFailures('0.1.7-alpha.1'), false)
  assert.equal(dshToleratesOptionalFailures('0.1.7-alpha.2'), false, 'alpha 系还是老行为，别提前关掉安全网')
  assert.equal(dshToleratesOptionalFailures('0.1.7-rc.1'), true)
  assert.equal(dshToleratesOptionalFailures('0.1.7-rc.2'), true)
  assert.equal(dshToleratesOptionalFailures('0.1.7'), true)
  assert.equal(dshToleratesOptionalFailures('0.1.8'), true)
  assert.equal(dshToleratesOptionalFailures(''), false, '认不出版本就保守，继续用老逻辑')
  assert.equal(dshToleratesOptionalFailures(undefined), false)
})

test('闸门放在禁用之前，并且会说明为什么没动手', () => {
  assert.match(
    server,
    /if \(settings\.autoDisablePlugins === false\) return false[\s\S]{0,500}?if \(dshToleratesOptionalFailures\(version\)\) \{\s*[\s\S]{0,200}?return false/,
    '用户关掉兼容模式 → 直接退出；否则先过版本闸门，再谈禁用',
  )
  assert.match(server, /会自己隔离出问题的可选插件，本次不自动禁用/, '要在日志里说清为什么没禁用')
  assert.match(server, /const version = failure\?\.version \|\| current\?\.version \|\| ''/, '版本取失败的或正在跑的那个')
})
