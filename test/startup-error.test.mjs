// 启动失败是不是「核心坏了」：环境/文件系统错误不能被当成坏核心删掉并拉黑。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isEnvironmentStartupError } from '../shell/startup-error.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('环境类错误码识别为环境问题，普通错误不算', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR', 'ENOENT', 'EMFILE', 'ENFILE', 'EBUSY', 'EIO']) {
    assert.equal(isEnvironmentStartupError({ code }), true, code)
  }
  for (const code of ['', undefined, 'EALREADY', 'ERR_MODULE_NOT_FOUND', 'ECONNREFUSED', 'FAKE_BROKEN']) {
    assert.equal(isEnvironmentStartupError({ code }), false, String(code))
  }
  assert.equal(isEnvironmentStartupError(null), false)
})

test('核心目录里的 ENOENT/EACCES 仍按坏核心处理，核心目录外才是环境问题', () => {
  const core = 'C:\\Users\\me\\AppData\\Roaming\\DSH\\core\\current'
  assert.equal(isEnvironmentStartupError({ code: 'ENOENT', path: `${core}\\lib\\x.js` }, core), false)
  assert.equal(isEnvironmentStartupError({ code: 'EACCES', path: `${core}/server.js` }, core), false)
  assert.equal(isEnvironmentStartupError({ code: 'ENOENT', path: 'C:\\Users\\me\\AppData\\Roaming\\DSH\\data' }, core), true)
  assert.equal(isEnvironmentStartupError({ code: 'ENOSPC' }, core), true, '没有路径的磁盘满一定是环境问题')
})

test('startServer 失败先判环境问题，再走 recoverCore', () => {
  const main = read('shell/main.mjs')
  const start = /} catch \(error\) \{[\s\S]*?isEnvironmentStartupError\(error, coreDir\)[\s\S]*?recoverCore\(coreDir, \{ pendingOnly: true \}\)/.exec(main)
  assert.ok(start, '环境错误要先于 recoverCore 拦住（否则数据目录不可写会删掉有效核心并永久拉黑）')
  assert.match(main, /import \{ isEnvironmentStartupError \} from '\.\/startup-error\.mjs'/)
})

test('recoverCore 先删核心、删不掉就不记坏版本', () => {
  const main = read('shell/main.mjs')
  const body = /function recoverCore\([\s\S]*?\n}/.exec(main)?.[0] || ''
  const removed = body.indexOf("rmSync(ACTIVE_CORE")
  const recorded = body.indexOf('writeFileSync(FAILED_CORE_MARK')
  assert.ok(removed > 0 && recorded > removed, '删除失败要能提前 return，不能先写黑名单')
  assert.match(body, /catch \{\s*console\.log\('核心删不掉（权限或文件占用），不按坏核心处理'\)\s*return false/, '删不掉时返回 false，让调用方按普通启动失败报错')
})
