import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { bundleNameOf, disableRowId, enableRowId, ensureBundleMounted, listPlugins, readPatchState } from '../src/plugins.js'

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

test('同一个 id 有两块（config 覆盖 + disabled）：启用只删后面那块', () => {
  // dsh 的配置面板给插件写 config 覆盖块，启动器的开关在后面追加 disabled 块；
  // 两块同 id 时旧实现只看第一块（没有 disabled），于是永远「启用（无变化）」。
  const content = [
    '- id: ui-skin-claude-style',
    '  name: dsh-claude-style',
    '  config:',
    '    brandInk: original',
    '- id: ui-skin-claude-style',
    '  disabled: true',
    '',
  ].join('\n')
  const { profile, file } = patchFile(content)
  assert.equal(enableRowId(profile, 'ui-skin-claude-style').changed, true)
  const after = readFileSync(file, 'utf8')
  assert.ok(!after.includes('disabled'), `disabled 块应该删掉：${JSON.stringify(after)}`)
  assert.ok(after.includes('brandInk: original'), `config 覆盖块要留着：${JSON.stringify(after)}`)
  assert.deepEqual(readPatchState(file).disables, [])
})

test('同一个 id 有两块：disabled 块排在 config 块前面也删得掉', () => {
  const content = '- id: skin\n  disabled: true\n- id: skin\n  config:\n    a: 1\n'
  const { profile, file } = patchFile(content)
  assert.equal(enableRowId(profile, 'skin').changed, true)
  const after = readFileSync(file, 'utf8')
  assert.ok(!after.includes('disabled'), `disabled 块应该删掉：${JSON.stringify(after)}`)
  assert.ok(after.includes('    a: 1'), `config 块要留着：${JSON.stringify(after)}`)
})

test('同一个 id 有两块：关 → 开 → 关 的往返都能生效', () => {
  const { profile, file } = patchFile('- id: skin\n  name: pkg-skin\n  config:\n    a: 1\n')
  assert.equal(disableRowId(profile, 'skin').changed, true)
  assert.deepEqual(readPatchState(file).disables, ['skin'])
  assert.equal(disableRowId(profile, 'skin').changed, false, '已经禁用时再关一次是空操作')
  assert.equal(enableRowId(profile, 'skin').changed, true)
  assert.deepEqual(readPatchState(file).disables, [])
  assert.equal(enableRowId(profile, 'skin').changed, false, '已经启用时再开一次是空操作')
  assert.equal(disableRowId(profile, 'skin').changed, true)
  assert.deepEqual(readPatchState(file).disables, ['skin'])
  const after = readFileSync(file, 'utf8')
  assert.equal(after.split('- id: skin').length - 1, 2, `只应有 config 与 disabled 两块：${JSON.stringify(after)}`)
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

test('ensureBundleMounted：带 scope 的包名整段保留，版本号照样剥掉', () => {
  const { profile } = patchFile('[]')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: { '@linxin666/dsh-remote-web-ui': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }), 'utf8')
  // 启用路径（setPluginEnabled）传的是依赖名，不带版本；装完路径传的是 spec，带版本。
  // 两种形状都必须归一成 npm 的包名 `@scope/name`，否则写进 bundles 的
  // `@scope/name/1.2.3` 是个不存在的包名，dsh 解析不到会让插件一直起不来。
  assert.deepEqual(
    ensureBundleMounted(profile, '@linxin666/dsh-remote-web-ui'),
    { ok: true, changed: true, name: '@linxin666/dsh-remote-web-ui' },
  )
  assert.deepEqual(
    JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@linxin666/dsh-remote-web-ui'],
  )
  assert.deepEqual(
    ensureBundleMounted(profile, '@linxin666/dsh-remote-web-ui@1.2.3'),
    { ok: true, changed: false, name: '@linxin666/dsh-remote-web-ui' },
  )
  assert.deepEqual(
    JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@linxin666/dsh-remote-web-ui'],
  )
})

test('ensureBundleMounted：file:/git: 源和没有 bundles 字段的清单不碰', () => {
  const { profile } = patchFile('[]')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
  assert.equal(ensureBundleMounted(profile, 'file:C:/x/plugin').ok, false)
  assert.equal(ensureBundleMounted(profile, 'pkg@1.0').ok, false, '没有 bundles 字段的老清单不动')
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')), { dependencies: {} })
})

test('bundleNameOf：scp 形态的 git 地址取不出包名（装完再按依赖对比），npm 名照常剥版本', () => {
  assert.equal(bundleNameOf('git@github.com:me/plugin.git'), '')
  assert.equal(bundleNameOf('ssh://git@example.com/me/plugin.git'), '')
  assert.equal(bundleNameOf('git://example.com/me/plugin.git'), '')
  assert.equal(bundleNameOf('@scope/pkg@1.2.3'), '@scope/pkg')
  assert.equal(bundleNameOf('pkg@^1'), 'pkg')
})

test('listPlugins：清单没有 bundles 字段时插件按挂着算，不全部显示成关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-nobundles-'))
  const pkgDir = join(dir, 'node_modules', 'dsh-plugin-x')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-plugin-x', version: '1.0.0' }))
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- insert:\n    - id: px01\n      name: x\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-plugin-x': '1.0.0' } }))
  const plugin = listPlugins(dir).plugins.find((item) => item.name === 'dsh-plugin-x')
  assert.ok(plugin.ids.length, '有加载行')
  assert.equal(plugin.mounted, true)
  assert.equal(plugin.enabled, true)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-plugin-x': '1.0.0' }, dsh: { profile: { bundles: [] } } }))
  assert.equal(listPlugins(dir).plugins.find((item) => item.name === 'dsh-plugin-x').enabled, false, '有 bundles 数组但没挂上：照旧显示关闭')
})
