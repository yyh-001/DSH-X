/**
 * 外壳的 DSH_APP_DIR（shell/env.mjs）：和核心 FileManager.appDir 同一条规则——去掉首尾空白后是
 * 非空绝对路径才算数，否则回到平台默认位置；settings.json 也跟着这个目录读。
 * env.mjs 一 import 就改 process.env（PATH、DSH_RUNTIME_NODE……），所以每次都在沙盒子进程里 import。
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { appDirSandbox, importInSandbox, platformAppDir } from './app-dir-fixture.mjs'

const ENV_MODULE = new URL('../shell/env.mjs', import.meta.url).href

/** import 一次 env.mjs，读回 APP_DIR 和它给 dsh 定的 Node。 */
const loadShellEnv = (box, override) =>
  importInSandbox(box, ENV_MODULE, '{ appDir: m.APP_DIR, runtime: process.env.DSH_RUNTIME_NODE ?? null }', override)

/** 每份设置指向一个独有的假 Node，读到的是哪一份一看路径就知道。 */
function writeSettings(dir, nodePath) {
  writeFileSync(nodePath, '#!/bin/sh\n')
  chmodSync(nodePath, 0o755)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ nodeRuntime: 'system', systemNodePath: nodePath }))
}

test('APP_DIR：绝对路径（含首尾空白）的 DSH_APP_DIR 生效；未设 / 空串 / 全空白 / 相对路径回到平台默认位置', () => {
  const box = appDirSandbox()
  try {
    const override = join(box.root, 'test-copy')
    const fallback = platformAppDir(box.home)
    const cases = [
      [undefined, fallback],
      ['', fallback],
      ['   ', fallback],
      ['relative/DSH', fallback],
      [override, override],
      [`  ${override}  `, override],
    ]
    for (const [value, expected] of cases) {
      assert.equal(loadShellEnv(box, value).appDir, expected, `DSH_APP_DIR=${JSON.stringify(value)}`)
    }
  } finally {
    box.cleanup()
  }
})

test('settings.json 跟着 APP_DIR 读：覆盖目录里的系统 Node 生效，覆盖到别处时默认位置那份不读', () => {
  const box = appDirSandbox()
  try {
    const override = join(box.root, 'test-copy')
    const overrideNode = join(box.root, 'node-from-override')
    writeSettings(override, overrideNode)
    assert.equal(loadShellEnv(box, override).runtime, overrideNode, '测试副本用自己目录里的 settings.json')

    const defaultNode = join(box.root, 'node-from-default')
    writeSettings(platformAppDir(box.home), defaultNode)
    // 对照：不覆盖时默认那份确实读得到，下面的「不读」才不是空转
    assert.equal(loadShellEnv(box, undefined).runtime, defaultNode)
    const elsewhere = join(box.root, 'empty-copy')
    mkdirSync(elsewhere)
    const isolated = loadShellEnv(box, elsewhere)
    assert.equal(isolated.appDir, elsewhere)
    assert.notEqual(isolated.runtime, defaultNode, '测试副本不能拿正式版的设置')
  } finally {
    box.cleanup()
  }
})
