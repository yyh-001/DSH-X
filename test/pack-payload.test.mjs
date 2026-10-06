/**
 * 安装包必须带上整合包配方（packs/dsh-x-recommended）——插件本体不随包发，从 npm 装。
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

test('安装包会带上整合包配方，且不带上插件源码', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-payload-'))
  try {
    await copyAppFiles(out)
    // 整合包随包发：插件页的「内置整合包」就地安装，依赖本身从 npm 装
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'manifest.json')), '整合包配方在安装包里')
    assert.ok(existsSync(join(out, 'packs', 'dsh-x-recommended', 'README.md')))
    // 插件源码不随包发（都发 npm 了），安装目录里不该再出现 plugins/
    assert.ok(!existsSync(join(out, 'plugins')), '插件源码不进安装包')
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
