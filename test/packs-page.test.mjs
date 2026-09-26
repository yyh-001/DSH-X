/**
 * 整合包页面的结构自检：导航与面板配对、按需加载接上了、文案都有英文。
 *
 * 和设置页那份测试同一种做法——直接读 index.html 断言结构，不做浏览器渲染。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

test('左侧导航有整合包入口，面板与导航成对', () => {
  assert.match(html, /class="nav-item" data-pane="packs"/, '导航里有整合包')
  assert.match(html, /<section class="pane" id="pane-packs">/, '整合包面板在设置区里')
  // 位置：紧跟插件页（整合包是「在插件的基础上」的批量版本）
  const nav = html.match(/class="nav-item[^"]*" data-pane="(\w+)"/g).map((item) => /data-pane="(\w+)"/.exec(item)[1])
  assert.deepEqual(nav.slice(0, 5), ['control', 'settings', 'plugins', 'packs', 'settings'], '导航顺序：返回 / 常规 / 插件 / 整合包 / 外观')
})

test('整合包页的关键控件都在，且进面板才加载', () => {
  for (const id of [
    'packInstalled', 'packSource', 'packCheck', 'packPick', 'packDetail',
    'packMarket', 'packProgress', 'packProgressBar', 'packHint', 'packSub',
    'packRefresh', 'packExport', 'packExportHome', 'packExportVersion',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 在页面上`)
  }
  assert.match(html, /const paneLoaders = \{[^}]*packs: loadPacks[^}]*\}/, '进面板时才读整合包状态')
  assert.match(html, /post\('\/api\/packs\/inspect'/, '检查走 inspect')
  assert.match(html, /post\('\/api\/packs\/install'/, '安装走 install')
  assert.match(html, /post\('\/api\/packs\/uninstall'/, '卸载走 uninstall')
  assert.match(html, /post\('\/api\/packs\/export'/, '导出走 export')
  assert.match(html, /post\('\/api\/packs\/pick-file'/, '选本地文件走 pick-file')
  assert.match(html, /post\('\/api\/packs\/reveal'/, '导出的文件能在文件夹里定位')
  assert.match(html, /getJson\(`\/api\/packs\/market/, '市场列表由服务端读')
  assert.match(html, /data\?\.kind === 'pack'/, '整合包进度走 SSE 的 pack 事件')
  assert.match(html, /await post\('\/api\/settings', \{ profile \}\)[\s\S]{0,200}?post\('\/api\/restart'/, '「切过去并重启」先存 profile 再重启')
  // 卸载是破坏性动作，删目录要单独再确认一次
  assert.match(html, /confirm\(t\('卸载 \{name\}/, '卸载要确认')
  assert.match(html, /confirm\(t\('这个 profile 是整合包装的/, '删整个 profile 目录要再确认一次')
})

test('整合包面板的中文文案都有英文', () => {
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  const cjk = /[\u4e00-\u9fff]/
  const missing = []
  const check = (text) => { if (cjk.test(text) && !dict[text]) missing.push(text) }
  const pane = html.match(/<section class="pane" id="pane-packs">[\s\S]*?<\/section>/)[0]
  for (const match of pane.matchAll(/data-i18n="([^"]+)"/g)) check(match[1])
  // 面板 JS 里的中文：t('…') 的字面量（含带占位符的）
  const block = html.match(/\/\/ ---- 整合包：[\s\S]*?\/\/ ---- MCP 服务器/)[0]
  for (const match of block.matchAll(/t\('([^'\n]+)'/g)) check(match[1])
  assert.deepEqual([...new Set(missing)], [], '整合包面板里没翻的中文')
})
