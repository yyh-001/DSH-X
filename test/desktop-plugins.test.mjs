import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { DESKTOP_PLUGINS, parseDshVersion, versionAtLeast } from '../src/desktop-plugins.js'

test('版本解析：只认 x.y.z，预发布后缀丢掉', () => {
  assert.deepEqual(parseDshVersion('0.2.2-alpha.2'), [0, 2, 2])
  assert.deepEqual(parseDshVersion('0.2.0'), [0, 2, 0])
  assert.deepEqual(parseDshVersion(' 1.0.0-rc.1 '), [1, 0, 0])
  assert.equal(parseDshVersion('latest'), null)
  assert.equal(parseDshVersion(''), null)
  assert.equal(parseDshVersion(undefined), null)
})

test('版本门槛：同版本的预发布算满足', () => {
  assert.equal(versionAtLeast('0.2.0', '0.2.0'), true)
  assert.equal(versionAtLeast('0.2.0-rc.4', '0.2.0'), true)
  assert.equal(versionAtLeast('0.2.1-rc.4', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.2.2-alpha.2', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.3.0', '0.2.1-rc.2'), true)
  assert.equal(versionAtLeast('0.1.21', '0.2.0'), false)
  assert.equal(versionAtLeast('0.2.0-rc.1', '0.2.1-rc.2'), false)
  // 认不出版本就不装：宁可不装，也别把插件塞进不认识的内核
  assert.equal(versionAtLeast('', '0.2.0'), false)
  assert.equal(versionAtLeast('0.2.2-alpha.2', ''), false)
})

test('清单和仓库里的插件对得上：包名、版本、命名都在', () => {
  for (const plugin of DESKTOP_PLUGINS) {
    const dir = join(import.meta.dirname, '..', 'plugins', plugin.name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.name, plugin.name)
    // 一键安装钉的版本必须就是仓库里的版本，否则装到的是旧包
    assert.equal(manifest.version, plugin.spec)
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    const range = String(manifest.dsh?.compatibility?.dsh ?? '')
    assert.ok(range.length > 0, `${plugin.name} 缺 dsh.compatibility.dsh`)
    assert.ok(range.includes(plugin.minDsh), `${plugin.name} 的 compatibility 下限与 ${plugin.minDsh} 不一致`)
    // 插件页的名字来自 meta.title（locale 覆盖）；每个包都填了才不会显示裸包名
    assert.ok(manifest.meta?.title, `${plugin.name} 缺 meta.title`)
    for (const lang of ['zh', 'en']) {
      const locale = JSON.parse(readFileSync(join(dir, 'locale', `${lang}.json`), 'utf8'))
      assert.ok(locale.meta?.title, `${plugin.name} 缺 locale/${lang}.json 的 meta.title`)
    }
  }
})

test('右键菜单插件不再随桌面增强装：dsh 0.2.2 起自带菜单（issue #110）', () => {
  assert.ok(!DESKTOP_PLUGINS.some((plugin) => plugin.name === 'dsh-x-context-menu'))
  assert.deepEqual(DESKTOP_PLUGINS.map((plugin) => plugin.name), ['dsh-x-desktop-notify', 'dsh-x-sidebar-browser'])
})
