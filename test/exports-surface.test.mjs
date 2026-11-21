import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import * as filemanager from '../src/filemanager.js'
import * as fsUtils from '../src/fs-utils.js'
import * as platform from '../src/platform.js'
import * as profileBackups from '../src/profile-backups.js'
import * as remoteProfile from '../src/remote-profile.js'
import * as remote from '../src/remote.js'
import * as settings from '../src/settings.js'
import * as storageStats from '../src/storage-stats.js'
import * as version from '../src/version.js'
import * as shellCoreBootstrap from '../shell/core-bootstrap.mjs'
import * as shellCoreFetch from '../shell/core-fetch.mjs'
import * as shellModel from '../shell/model.mjs'

/**
 * 公共模块的导出被谁具名导入，逐个对照现存导出。
 *
 * 动机：#63 把 APP_DIR 从 platform.js 挪进 filemanager.js 时漏了 shell/main.mjs，
 * 测试套件不加载 shell/（Electron 主进程才加载），结果打出来的安装包一起动就崩——
 * 这种「导出挪窝漏改消费者」只能靠结构检查兜住。
 */

const MODULES = {
  'platform.js': platform,
  'filemanager.js': filemanager,
  'fs-utils.js': fsUtils,
  'storage-stats.js': storageStats,
  'profile-backups.js': profileBackups,
  'settings.js': settings,
  'version.js': version,
  'remote.js': remote,
  'remote-profile.js': remoteProfile,
  'model.mjs': shellModel,
  'core-fetch.mjs': shellCoreFetch,
  'core-bootstrap.mjs': shellCoreBootstrap,
}
const SKIP = new Set(['.git', 'node_modules', 'release', 'vendor', 'data', 'target'])

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (!SKIP.has(entry)) yield* sources(path)
    } else if (/\.(js|mjs|cjs)$/.test(entry)) {
      yield path
    }
  }
}

/** 一个模块的具名导入：兼容单行与多行；先剥注释，别把示例代码当成真的 import。 */
function namedImports(rawSource, moduleName) {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const pattern = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"][^'"]*[/\\]${moduleName}['"]`, 'g')
  const names = []
  for (const match of source.matchAll(pattern)) {
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0]
      if (name) names.push(name)
    }
  }
  return names
}

test('对 platform.js / filemanager.js 的具名导入都指向现存导出', () => {
  const checked = []
  for (const path of sources('.')) {
    const source = readFileSync(path, 'utf8')
    for (const [moduleName, namespace] of Object.entries(MODULES)) {
      for (const name of namedImports(source, moduleName)) {
        checked.push(`${path} 导入 ${moduleName} 的 ${name}`)
        assert.ok(name in namespace, `${path} 从 ${moduleName} 导入的 ${name} 已不存在（导出挪窝时漏改了消费者？）`)
      }
    }
  }
  assert.ok(checked.length >= 8, `至少该扫到已知的这些导入，实际 ${checked.length}`)
})
