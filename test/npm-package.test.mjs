import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const BIN = new URL('../npm-package/bin/dsh-x.mjs', import.meta.url)
const PKG = JSON.parse(readFileSync(new URL('../npm-package/package.json', import.meta.url), 'utf8'))

test('npm 包元数据：有 bin、平台限制和 electron 依赖', () => {
  assert.equal(PKG.name, 'dsh-x')
  assert.equal(PKG.bin['dsh-x'], 'bin/dsh-x.mjs')
  assert.deepEqual(PKG.os, ['win32', 'darwin'])
  assert.ok(PKG.dependencies.electron, 'electron 是运行时依赖')
  assert.ok(PKG.files.includes('bin') && PKG.files.includes('lib'))
})

test('npm CLI 的 --version / --core 不联网也能用', () => {
  const cache = mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-npm-cli-'))
  try {
    const env = { ...process.env, DSH_NPM_CACHE: cache }
    const version = spawnSync(process.execPath, [fileURLToPath(BIN), '--version'], { encoding: 'utf8', env })
    assert.equal(version.status, 0, version.stderr)
    assert.match(version.stdout, new RegExp(`dsh-x ${PKG.version.replace(/\./g, '\\.')}`))
    assert.match(version.stdout, /核心未安装/)
    const core = spawnSync(process.execPath, [fileURLToPath(BIN), '--core'], { encoding: 'utf8', env })
    assert.equal(core.status, 0, core.stderr)
    assert.match(core.stdout, /核心未安装/)
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})
