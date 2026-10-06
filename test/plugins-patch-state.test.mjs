import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { enableRowId, ensureBundleMounted, readPatchState } from '../plugins.js'

function patchFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-'))
  const profile = join(dir, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const file = join(profile, 'cordis.patch.yml')
  writeFileSync(file, content)
  return { profile, file }
}

const read = (content) => readPatchState(patchFile(content).file)

test('disabled 紧跟在 - id 后面（本启动器自己写的形状）', () => {
  const state = read("- id: ui-git-graph\n  disabled: true\n")
  assert.deepEqual(state.disables, ['ui-git-graph'])
  assert.deepEqual(state.forced, [])
})

test('disabled 在其它键后面也认（dsh 自己写的形状）', () => {
  // dsh 的插件页用 setIn 往已有行上加 disabled，name/config 留在前面
  const preset = "- id: tool-plugin-manager\n  name: '@deepseek-ai/dsh-plugin-manager/tools'\n  disabled: true\n"
  assert.deepEqual(read(preset).disables, ['tool-plugin-manager'])
  const withConfig = '- id: my-plugin\n  config:\n    someOption: 1\n  disabled: true\n'
  assert.deepEqual(read(withConfig).disables, ['my-plugin'])
})

test('disabled: false 记成强制启用', () => {
  assert.deepEqual(read("- id: x\n  name: 'y'\n  disabled: false\n").forced, ['x'])
})

test('config 里的同名字段不算这一行的开关', () => {
  const state = read('- id: my-plugin\n  config:\n    disabled: true\n')
  assert.deepEqual(state.disables, [])
})

test('多行：只认自己那一行的 disabled', () => {
  const state = read('- id: a\n  name: x\n- id: b\n  disabled: true\n- id: c\n  disabled: false\n')
  assert.deepEqual(state.disables, ['b'])
  assert.deepEqual(state.forced, ['c'])
})

test('重新启用：删掉 disabled，同行其它键留着', () => {
  const { profile, file } = patchFile("- id: my-plugin\n  name: 'pkg-name'\n  disabled: true\n")
  const result = enableRowId(profile, 'my-plugin')
  assert.equal(result.changed, true)
  const after = readFileSync(file, 'utf8')
  assert.ok(!after.includes('disabled'), `disabled 应该被删掉：${JSON.stringify(after)}`)
  assert.ok(after.includes("name: 'pkg-name'"), `同行的其它键要留着：${JSON.stringify(after)}`)
  assert.deepEqual(readPatchState(file).disables, [])
})

test('重新启用：规范两行形状整行删掉，补回 [] 占位', () => {
  const { profile, file } = patchFile('- id: ui-git-graph\n  disabled: true\n')
  assert.equal(enableRowId(profile, 'ui-git-graph').changed, true)
  assert.equal(readFileSync(file, 'utf8'), '[]\n')
})

test('本来就没禁用的行：幂等，不动文件', () => {
  const content = "- id: my-plugin\n  name: 'x'\n"
  const { profile, file } = patchFile(content)
  assert.equal(enableRowId(profile, 'my-plugin').changed, false)
  assert.equal(readFileSync(file, 'utf8'), content)
})

test('ensureBundleMounted：补写挂载清单，剥掉版本号，重复挂是空操作', () => {
  const { profile } = patchFile('[]')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-filesnap': '0.2.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }), 'utf8')
  assert.deepEqual(ensureBundleMounted(profile, 'dsh-filesnap@0.2.2'), { ok: true, changed: true, name: 'dsh-filesnap' })
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-filesnap'])
  assert.deepEqual(ensureBundleMounted(profile, 'dsh-filesnap'), { ok: true, changed: false, name: 'dsh-filesnap' })
})

test('ensureBundleMounted：file:/git: 源和没有 bundles 字段的清单不碰', () => {
  const { profile } = patchFile('[]')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
  assert.equal(ensureBundleMounted(profile, 'file:C:/x/plugin').ok, false)
  assert.equal(ensureBundleMounted(profile, 'pkg@1.0').ok, false, '没有 bundles 字段的老清单不动')
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')), { dependencies: {} })
})
