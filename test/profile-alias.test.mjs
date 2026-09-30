/**
 * 保留名 profile（desktop）的插件操作绕行：dsh 的 CLI 只按名字找 profile，所以在同一个
 * profiles/ 下给原件建一个「别名」目录链接 —— 两个名字一份目录，不复制、不漂移。
 * 这里真在临时目录里建链接再回读（Windows 是 junction，别的平台是目录软链）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { aliasProfileName, ensureProfileAlias, listProfiles } from '../server.js'

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profiles-'))
  mkdirSync(join(root, 'desktop'))
  writeFileSync(join(root, 'desktop', 'package.json'), '{"name":"dsh-profile-desktop"}')
  return root
}

test('别名就是同一份目录：原件改了，别名立刻看得见（没有第二份要同步）', () => {
  const root = tempRoot()
  const name = ensureProfileAlias('desktop', root)
  assert.equal(name, '.dsh-alias-desktop')
  assert.equal(readFileSync(join(root, name, 'package.json'), 'utf8'), '{"name":"dsh-profile-desktop"}', '走别名读到的是原件')
  writeFileSync(join(root, 'desktop', 'marker.txt'), 'x')
  assert.equal(readFileSync(join(root, name, 'marker.txt'), 'utf8'), 'x', '别名看到的就是原件的内容')
})

test('别名幂等，且不覆盖别人的东西', () => {
  const root = tempRoot()
  assert.equal(ensureProfileAlias('desktop', root), '.dsh-alias-desktop')
  assert.equal(ensureProfileAlias('desktop', root), '.dsh-alias-desktop', '已经有且指向对，直接复用')

  const occupied = tempRoot()
  mkdirSync(join(occupied, aliasProfileName('desktop')))
  assert.equal(ensureProfileAlias('desktop', occupied), '', '那里放着真目录就不碰，交回调用方回退')

  assert.equal(ensureProfileAlias('nope', occupied), '', 'profile 本身不存在就不建')
})

test('别名不出现在 profile 列表里', () => {
  const root = tempRoot()
  ensureProfileAlias('desktop', root)
  mkdirSync(join(root, '.hidden-thing'))
  writeFileSync(join(root, '.hidden-thing', 'package.json'), '{}')

  const names = listProfiles(root)
  assert.ok(names.includes('desktop'), '真的 profile 照旧在列表里')
  assert.ok(!names.some((name) => name.startsWith('.')), `内部目录不该露面：${names.join(', ')}`)
})
