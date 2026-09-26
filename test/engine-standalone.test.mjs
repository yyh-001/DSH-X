/**
 * 引擎要能独立于启动器跑：sync.js + zipfile.js + version.js 只许依赖 Node 内置模块和彼此。
 *
 * 这不是洁癖——把这三只文件拷进一个 dsh 插件（或任何别的宿主）就得能直接 work；
 * 一旦有人顺手 import 了 settings.js / platform.js，插件那边立刻变成「装不上/起不来」，
 * 而且是在运行时才炸。所以在这里钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cmpVer, parseVer } from '../version.js'
import * as registry from '../registry.js'

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

function importsOf(name) {
  return [...read(name).matchAll(/^import\s+.*?from\s+'([^']+)'/gm)].map((match) => match[1])
}

test('引擎三件套只依赖内置模块与彼此', () => {
  const allowed = new Set(['./zipfile.js', './version.js'])
  for (const file of ['sync.js', 'zipfile.js', 'version.js']) {
    for (const spec of importsOf(file)) {
      if (spec.startsWith('node:')) continue
      assert.ok(allowed.has(spec), `${file} 不该 import ${spec}（引擎要能离开启动器独立跑）`)
    }
  }
  // version.js 连相对依赖都没有：单一职责，谁都能拿去用
  assert.deepEqual(importsOf('version.js'), [])
})

test('registry.js 仍然转出 cmpVer/parseVer（老的调用方不用改）', () => {
  assert.equal(typeof registry.parseVer, 'function')
  assert.equal(typeof registry.cmpVer, 'function')
  assert.equal(registry.parseVer('1.2.3-rc.1').pre, 'rc.1')
  assert.equal(cmpVer(parseVer('1.2.3'), parseVer('1.2.3-rc.1')), 1)
})
