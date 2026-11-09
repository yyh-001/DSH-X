import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { defaultDshHome, ensureWritableDir, safeDataDir, safeDshHome } from '../src/settings.js'

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

test('建目录失败时回滚这次新建的上层目录，已存在的路径一根都不动', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mkdir-rollback-'))
  try {
    // 路径本来就存在（这里是个文件）：失败也不能删
    writeFileSync(join(root, 'blocker'), 'x')
    await assert.rejects(ensureWritableDir(join(root, 'blocker')), /这不是一个目录|目录不可用/)
    assert.ok(existsSync(join(root, 'blocker')), '已存在的路径失败后仍然保留')

    if (process.platform === 'win32') {
      // 非法字符：Windows 的 recursive mkdir 会先建出 root/a、root/a/b，再在 bad<name 上失败
      await assert.rejects(ensureWritableDir(join(root, 'a', 'b', 'bad<name')), /目录不可用|这不是一个目录/)
      assert.equal(existsSync(join(root, 'a')), false, '这次新建的半截目录要删掉')
      assert.ok(existsSync(join(root, 'blocker')), '用户原有的文件不能碰')
    } else {
      t.diagnostic('非 Windows 没有稳定的「建到一半再失败」路径，跳过回滚断言')
    }

    // 正常情况：建好、探针写过又删掉
    const fresh = join(root, 'ok', 'nested')
    assert.equal(await ensureWritableDir(fresh), fresh)
    assert.ok(existsSync(fresh))
    assert.equal(existsSync(join(fresh, '.dsh-write-probe')), false, '探针文件用完就删')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('建目录失败时不删用户的悬空符号链接', { skip: process.platform === 'win32' && '建符号链接要管理员权限' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dangling-'))
  try {
    const link = join(root, 'link')
    symlinkSync(join(root, 'missing-target'), link)
    await assert.rejects(ensureWritableDir(join(link, 'sub')))
    assert.ok(lstatSync(link).isSymbolicLink(), '悬空链接是用户的东西，失败回滚不能删它')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
