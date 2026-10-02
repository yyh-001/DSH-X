/**
 * 插件页（含整合包卡片区）的结构自检：卡片区 / 包详情 / 两个弹窗都在、按需加载接上了、文案都有英文。
 *
 * 和设置页那份测试同一种做法——直接读 index.html 断言结构，不做浏览器渲染。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

const slice = (from, to) => {
  const start = html.indexOf(from)
  assert.ok(start >= 0, `找不到起点：${from}`)
  const end = to ? html.indexOf(to, start) : html.length
  return html.slice(start, end > start ? end : html.length)
}

test('整合包已并进插件页：导航里没有独立入口，卡片区是插件页的唯一列表', () => {
  assert.ok(!/data-pane="packs"/.test(html), '导航里不该再有独立的整合包入口')
  assert.ok(!/id="pane-packs"/.test(html), '独立面板应该已经删掉')
  const pane = slice('<section class="pane" id="pane-plugins">', '<section class="pane fill" id="pane-mcp">')
  for (const id of ['pluginOverview', 'packGrid', 'packView', 'packHead', 'packBack', 'packPluginList']) {
    assert.match(pane, new RegExp(`id="${id}"`), `插件页里要有 ${id}`)
  }
  // 卡片是唯一入口：环境卡直接铺在页面里，点开卡片才看到该环境的插件行
  assert.match(pane, /<div id="pluginOverview">/, '环境卡片区直接铺在插件页里')
  assert.ok(!/id="pluginList"/.test(pane), '不再有平面插件列表（一进去就是插件详情）')
  assert.ok(!/data-i18n="全部插件"/.test(html), '「全部插件」这个误导的名字要撤掉')
  assert.match(html, /<button type="button" class="nav-item" data-pane="settings" data-category="appearance">/, '外观紧跟在插件页后面')
})

test('两个弹窗：装包（来源 + 市场）与导出，控件齐全', () => {
  const importDialog = slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="packExportDialog"')
  for (const id of ['packSource', 'packCheck', 'packPick', 'packInspect', 'packMarket', 'packProgress', 'packProgressBar', 'packHint', 'packImportClose']) {
    assert.match(importDialog, new RegExp(`id="${id}"`), `装包弹窗里要有 ${id}`)
  }
  const exportDialog = slice('<div class="ask" id="packExportDialog"', '<div class="ask" id="notice"')
  for (const id of ['packExportName', 'packExportVersion', 'packExportHome', 'packExportHint', 'packExportGo', 'packExportCancel']) {
    assert.match(exportDialog, new RegExp(`id="${id}"`), `导出弹窗里要有 ${id}`)
  }
  assert.doesNotMatch(html, /id="packImportOpen"/, '撤去重复的顶栏装包入口')
  assert.match(importDialog, /<details class="pack-import-source">/, '文件与链接导入默认折叠')
  assert.match(importDialog, /id="packMarketDetail"/, '社区卡片可以查看完整详情')
  assert.ok(!/id="packExportProfile"/.test(html), '导出入口统一放到环境详情')
  assert.ok(!/id="pluginCheckUpdates"/.test(html), '更新检查放到当前环境详情')
})

test('页面逻辑：一张卡就是一个 profile，点开进详情，开关/更新/删除各自走对接口', () => {
  assert.match(html, /const paneLoaders = \{[^}]*plugins: loadPlugins[^}]*\}/, '进插件页才加载')
  assert.ok(!/paneLoaders = \{[^}]*packs:/.test(html), '整合包不再单独按需加载')
  assert.match(html, /function pluginRowHtml\(/, '插件行抽成共用函数')
  assert.match(html, /bindPluginRowEvents\(packPluginListEl, item\.profile\)/, '详情里的插件行按该 profile 绑定')
  assert.match(html, /post\('\/api\/packs\/toggle', \{ profile: item\.profile, enabled \}\)/, '整包开关按 profile 走')
  assert.match(html, /post\('\/api\/packs\/update', \{ profile: item\.profile, \.\.\.\(group \? pluginGroupScope\(group\) : \{\}\) \}\)/, '整包更新按 profile 和插件组走')
  assert.match(html, /post\('\/api\/packs\/remove-profile'/, '手动拼的 profile 走「删除 profile」')
  assert.match(html, /post\('\/api\/packs\/install'/, '安装走 install')
  assert.match(html, /post\('\/api\/packs\/export'/, '导出走 export')
  assert.match(html, /post\('\/api\/packs\/pick-file'/, '选本地文件走 pick-file')
  assert.match(html, /post\('\/api\/packs\/reveal'/, '导出的文件能在文件夹里定位')
  assert.match(html, /getJson\(`\/api\/packs\/market/, '市场列表由服务端读')
  assert.match(html, /data\?\.kind === 'pack'/, '整合包进度走 SSE 的 pack 事件')
  assert.match(html, /function applyPluginPayload\(data\)/, '插件与整合包状态一次灌进页面')
  assert.match(html, /function openPack\(profile\)/, '点卡片进详情')
  assert.match(html, /data-group-toggle/, '整体开关放到对应分组头部')
  assert.match(html, /data-group-remove/, '卸载入口放到对应整合包分组头部')
  assert.ok(!/data-pack-toggle/.test(html), '列表卡片不再承担批量操作')
  assert.match(html, /<button class="pack-card\$\{/, '环境卡片是可通过键盘操作的按钮')
  assert.match(html, /<details class="pack-more">/, '次要操作收进更多操作')
  assert.match(html, /data-pack-check-updates/, '当前环境详情可检查更新')
  assert.match(html, /<details class="pack-advanced">/, '装包的技术清单可按需展开')
  assert.match(html, /packSourceTags\(item\)/, '来源是以标签形式标在卡片上的')
  // 卸载（有安装记录）与删除整个 profile（没有记录）是两种动作，各自要确认；确认弹窗用样式化的 appConfirm，不用原生 confirm
  assert.match(html, /appConfirm\(t\('撤销 \{name\}/, '撤销明确点名包和环境，并要求确认')
  assert.match(html, /appConfirm\(t\('确认删除「\{profile\}」整个目录/, '删整个 profile 目录要再确认一次')
  assert.ok(!/[^p]confirm\(/.test(html), '不再用原生 confirm 弹窗')
})

test('切换安装目标会重新检查，关闭后的旧请求不能复活预览', async () => {
  let resolvePost
  const calls = []
  const context = vm.createContext({
    packBusy: false, packInspection: { token: 'cached', ok: true }, packTargetProfile: '', packInspectRequest: 0,
    openedPack: { profile: 'work' }, pluginProfile: 'web', packState: {}, state: {},
    packInstallDialog: {}, document: { getElementById: () => ({}) },
    openImportDialog() {}, closeMarketDetail() {}, showPackDialog() {}, renderPackMarket() {}, renderPackBuiltin() {}, renderPackInspect() {},
    packHintEl: {}, t: (text) => text, notify() {},
    post: (path, body) => { calls.push({ path, body }); return new Promise((resolve) => { resolvePost = resolve }) },
  })
  new vm.Script(slice('async function inspectPack(payload)', 'async function installPack()')).runInContext(context)
  const pending = context.inspectPack({ token: 'cached', profile: 'other' })
  assert.equal(calls[0].body.token, 'cached', '重用已下载的包')
  assert.equal(calls[0].body.profile, 'other')
  assert.equal(context.packTargetProfile, 'other')
  assert.equal(context.packInspection.ok, false, '重算完成前不能安装旧计划')
  context.packInspectRequest += 1
  context.packInspection = null
  resolvePost({ ok: true, target: { profile: 'other' } })
  await pending
  assert.equal(context.packInspection, null, '关闭后到达的结果被丢弃')
  assert.equal(context.packBusy, false)
})

test('安装前必须有对应目标的有效检查结果；安装中取消不清空状态', async () => {
  let calls = 0
  const context = vm.createContext({
    packBusy: false, packInspection: { ok: true, target: { profile: 'old' } }, packTargetProfile: 'new',
    post() { calls += 1 }, packInstalling: true,
    hidePackDialog() { calls += 1 }, packInstallDialog: {}, renderPackInspect() {},
  })
  new vm.Script(slice('async function installPack()', 'async function removePack(')).runInContext(context)
  await context.installPack()
  assert.equal(calls, 0, '目标变化不能沿用旧检查')
  new vm.Script(slice('function closeInstallDialog()', "document.getElementById('packDetailClose')")).runInContext(context)
  context.closeInstallDialog()
  assert.equal(calls, 0)
  assert.equal(context.packInspection.ok, true, '安装期间的关闭操作不清空检查状态')
})

test('整合包相关的中文文案都有英文', () => {
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  const cjk = /[\u4e00-\u9fff]/
  const missing = new Set()
  const add = (text) => { if (cjk.test(text) && !dict[text]) missing.add(text) }
  const pane = slice('<section class="pane" id="pane-plugins">', '<section class="pane fill" id="pane-mcp">')
  for (const match of pane.matchAll(/data-i18n="([^"]+)"/g)) add(match[1])
  const dialogs = slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="notice"')
  for (const match of dialogs.matchAll(/data-i18n="([^"]+)"/g)) add(match[1])
  for (const block of [
    slice('const pluginPanelEl = document.getElementById', '// ---- 整合包'),
    slice('// ---- 整合包', '// ---- MCP 服务器'),
  ]) {
    for (const match of block.matchAll(/t\('([^'\n]+)'/g)) add(match[1])
  }
  assert.deepEqual([...missing], [], '插件页 / 整合包相关没翻的中文')
})

test('按整合包清单分组：共同插件只出现一次，别名可归类，其余插件保持独立', () => {
  const context = vm.createContext({ t: (text) => text })
  new vm.Script(slice('function groupPackPlugins(item)', '/** 卡详情')).runInContext(context)
  const groups = context.groupPackPlugins({
    records: [
      { name: 'first', displayName: '第一包', version: '1.0', dependencies: { a: '1', shared: '1', 'github:someone/source': 'main' }, specs: { alias: 'github:someone/source' } },
      { name: 'second', displayName: '第二包', version: '2.0', bundles: ['b', 'shared', 'removed'] },
    ],
    plugins: ['a', 'b', 'shared', 'alias', 'manual'].map((name) => ({ name })),
  })
  assert.deepEqual(Array.from(groups, (group) => [group.name, group.version, Array.from(group.plugins, (entry) => entry.plugin.name)]), [
    ['第一包', '1.0', ['a', 'alias']],
    ['第二包', '2.0', ['b', 'shared']],
    ['其他插件', '', ['manual']],
  ])
  assert.deepEqual(Array.from(groups[1].plugins[1].sharedPacks), ['第一包'])
  const empty = context.groupPackPlugins({ records: [{ name: 'old', bundles: ['gone'] }], plugins: [{ name: 'manual' }] })
  assert.equal(empty.length, 1, '已移除的插件不生成空分组')
  assert.equal(empty[0].key, 'other')
  assert.doesNotMatch(html, /class="pack-history"/, '菜单撤去安装记录展示')
})
