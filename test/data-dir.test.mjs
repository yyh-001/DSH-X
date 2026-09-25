import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { defaultDshHome, safeDataDir, safeDshHome } from '../settings.js'

test('绝对路径放行，末尾斜杠和空白顺手规范掉', () => {
  const base = join(tmpdir(), 'dsh-data')
  assert.equal(safeDataDir(base), base)
  // 用本平台的分隔符：POSIX 上 '\' 是合法的文件名字符，不算末尾斜杠
  assert.equal(safeDataDir(`${base}${sep}`), base)
  assert.equal(safeDataDir(`  ${base}  `), base)
})

test('相对路径一律拒绝：设置页能手填了，不能再按工作目录安静落地', () => {
  // 从前 resolve 在 isAbsolute 之前跑，补完永远是绝对路径，这条校验等于不存在
  for (const value of ['relative-path', 'dsh-data', './x', '..\\x', '.']) {
    assert.throws(() => safeDataDir(value), /请使用绝对路径/, value)
  }
})

test('空值和非字符串拒绝', () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => safeDataDir(value), /版本目录不能为空|请使用绝对路径/, JSON.stringify(value))
  }
})

test('dsh 用户目录：留空表示用默认位置，填了必须是绝对路径', () => {
  assert.equal(safeDshHome(''), '')
  assert.equal(safeDshHome(undefined), '')
  assert.equal(safeDshHome('   '), '')
  const base = join(tmpdir(), 'dsh-home')
  assert.equal(safeDshHome(`  ${base}${sep}  `), base)
  // 相对路径会被按当前工作目录补齐，等于没有校验——用户在设置页填个 .dsh 会静默落到启动器目录
  assert.throws(() => safeDshHome('dsh-home'), /绝对路径/)
  assert.throws(() => safeDshHome({ path: base }), /路径/)
  assert.equal(defaultDshHome(), join(homedir(), '.dsh'))
})
