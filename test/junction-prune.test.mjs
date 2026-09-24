import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pruneDanglingLinks } from '../server.js'

/** 链接本身在不在（existsSync 会跟随链接，悬空时返回 false，看不出链接是否还在）。 */
function linkExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

test('清理悬空链接：带 scope 的包（@local/xxx）也要扫到，通的链接和真实文件不能动', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prune-'))
  try {
    const nm = join(root, 'node_modules')
    const scope = join(nm, '@local')
    mkdirSync(join(nm, 'real-pkg'), { recursive: true })
    mkdirSync(scope, { recursive: true })
    writeFileSync(join(nm, 'real-pkg', 'package.json'), '{}\n')
    // 悬空的链接：目标是删过的目录，用户机器上常见（pnpm 存库清理、同步软件搬走过）
    symlinkSync(join(root, 'gone-top'), join(nm, 'dangling-top'), 'junction')
    symlinkSync(join(root, 'gone-scoped'), join(scope, 'dsh-preset-advisor'), 'junction')
    // 通的链接指向真实目录，得留着
    symlinkSync(join(nm, 'real-pkg'), join(scope, 'linked-ok'), 'junction')

    const removed = pruneDanglingLinks(nm)
    assert.equal(removed, 2, `应该摘掉 2 个悬空链接，实际 ${removed}`)
    assert.equal(linkExists(join(nm, 'dangling-top')), false, 'node_modules 下的悬空链接要摘掉')
    assert.equal(linkExists(join(scope, 'dsh-preset-advisor')), false, 'scope 目录里的悬空链接也要摘掉')
    assert.equal(pathExists(join(scope, 'linked-ok')), true, '通的链接不能删')
    assert.equal(pathExists(join(nm, 'real-pkg', 'package.json')), true, '真实文件不能动')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('清理悬空链接：目录不存在时安静返回 0，不抛错', () => {
  assert.equal(pruneDanglingLinks(join(tmpdir(), 'dsh-does-not-exist-' + Date.now())), 0)
})
