/**
 * 安装包必须带上内置插件（plugins/dsh-x-memory）。
 *
 * 这条守的是历史上真出过的那类事故：pack 用的是显式清单，新增目录忘了同步就静默少文件
 * （repair.js 当年就这么漏过）。这里真跑一次 copyAppFiles 到临时目录再回读，
 * 而不是只 grep 源码。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { copyAppFiles } from '../scripts/pack-common.mjs'

test('安装包会带上内置插件与内置整合包，且不带上它们的测试', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-payload-'))
  try {
    await copyAppFiles(out)
    for (const rel of [
      'plugins/dsh-x-memory/package.json',
      'plugins/dsh-x-memory/cordis.patch.yml',
      'plugins/dsh-x-memory/README.md',
      'plugins/dsh-x-memory/lib/index.js',
      'plugins/dsh-x-memory/lib/store.js',
      'plugins/dsh-x-memory/lib/tools.js',
      'plugins/dsh-x-memory/lib/client.js',
      'plugins/dsh-x-sync/package.json',
      'plugins/dsh-x-sync/cordis.patch.yml',
      'plugins/dsh-x-sync/lib/index.js',
      'plugins/dsh-x-sync/lib/client.js',
      'plugins/dsh-x-sync/lib/engine/sync.js',
    ]) {
      assert.ok(existsSync(join(out, rel)), `${rel} 应该在安装包里`)
    }
    for (const name of ['dsh-x-memory', 'dsh-x-sync']) {
      assert.ok(!existsSync(join(out, 'plugins', name, 'test')), `${name} 的用例不进用户机器`)
    }
    // 内置整合包也随包发：插件页的「内置整合包」就地安装，不用联网
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'manifest.json')), '内置整合包在安装包里')
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'README.md')))
    // 启动器源码与静态资源同样在（同一个清单，顺手一起钉住）
    assert.ok(existsSync(join(out, 'server.js')), '启动器源码在')
    assert.ok(existsSync(join(out, 'reserved-profile-boot.mjs')), '起 desktop profile 用的绕行入口在')
    assert.ok(existsSync(join(out, 'public', 'index.html')), '管理页在')
    // 光看文件存在抓不住传递依赖遗漏：在复制后的目录解析整棵服务依赖树。
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server.js')"], {
      cwd: out,
      env: { ...process.env, APPDATA: join(out, 'test-user'), DSH_VERSIONS_DATA: join(out, 'test-data') },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
