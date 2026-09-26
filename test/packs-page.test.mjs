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
  for (const id of ['pluginOverview', 'packGrid', 'packCaption', 'packView', 'packHead', 'packBack', 'packPluginList']) {
    assert.match(pane, new RegExp(`id="${id}"`), `插件页里要有 ${id}`)
  }
  // 卡片是唯一入口：不再另有一份「全部插件」列表（那是当前 profile 的插件，点开它的卡就有）
  assert.ok(!/id="pluginList"/.test(html), '不该再有一份重复的插件列表')
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
  assert.match(html, /id="packImportOpen"[^>]*data-i18n="装整合包"/, '插件页顶栏有「装整合包」')
  assert.ok(!/id="packExportProfile"/.test(html), '导出入口统一放到环境详情')
  assert.ok(!/id="pluginCheckUpdates"/.test(html), '更新检查放到当前环境详情')
})

test('页面逻辑：一张卡就是一个 profile，点开进详情，开关/更新/删除各自走对接口', () => {
  assert.match(html, /const paneLoaders = \{[^}]*plugins: loadPlugins[^}]*\}/, '进插件页才加载')
  assert.ok(!/paneLoaders = \{[^}]*packs:/.test(html), '整合包不再单独按需加载')
  assert.match(html, /function pluginRowHtml\(/, '插件行抽成共用函数')
  assert.match(html, /bindPluginRowEvents\(packPluginListEl, item\.profile\)/, '详情里的插件行按该 profile 绑定')
  assert.match(html, /post\('\/api\/packs\/toggle', \{ profile: item\.profile, enabled \}\)/, '整包开关按 profile 走')
  assert.match(html, /post\('\/api\/packs\/update', \{ profile: item\.profile \}\)/, '整包更新按 profile 走')
  assert.match(html, /post\('\/api\/packs\/remove-profile'/, '手动拼的 profile 走「删除 profile」')
  assert.match(html, /post\('\/api\/packs\/install'/, '安装走 install')
  assert.match(html, /post\('\/api\/packs\/export'/, '导出走 export')
  assert.match(html, /post\('\/api\/packs\/pick-file'/, '选本地文件走 pick-file')
  assert.match(html, /post\('\/api\/packs\/reveal'/, '导出的文件能在文件夹里定位')
  assert.match(html, /getJson\(`\/api\/packs\/market/, '市场列表由服务端读')
  assert.match(html, /data\?\.kind === 'pack'/, '整合包进度走 SSE 的 pack 事件')
  assert.match(html, /function applyPluginPayload\(data\)/, '插件与整合包状态一次灌进页面')
  assert.match(html, /function openPack\(profile\)/, '点卡片进详情')
  assert.match(html, /id="packViewToggle"/, '批量插件开关放在环境详情')
  assert.ok(!/data-pack-toggle/.test(html), '列表卡片不再承担批量操作')
  assert.match(html, /<button class="pack-card\$\{/, '环境卡片是可通过键盘操作的按钮')
  assert.match(html, /<details class="pack-more">/, '次要操作收进更多操作')
  assert.match(html, /data-pack-check-updates/, '当前环境详情可检查更新')
  assert.match(html, /<details class="pack-advanced">/, '装包的技术清单可按需展开')
  assert.match(html, /packSourceTags\(item\)/, '来源是以标签形式标在卡片上的')
  // 卸载（有安装记录）与删除整个 profile（没有记录）是两种动作，各自要确认
  assert.match(html, /confirm\(t\('卸载 \{name\}/, '卸载要确认')
  assert.match(html, /confirm\(t\('确认删除「\{profile\}」整个目录/, '删整个 profile 目录要再确认一次')
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
    slice('const pluginHintEl = document.getElementById', '// ---- 整合包'),
    slice('// ---- 整合包', '// ---- MCP 服务器'),
  ]) {
    for (const match of block.matchAll(/t\('([^'\n]+)'/g)) add(match[1])
  }
  assert.deepEqual([...missing], [], '插件页 / 整合包相关没翻的中文')
})
