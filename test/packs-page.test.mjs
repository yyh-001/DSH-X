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
  assert.match(html, /post\('\/api\/packs\/toggle', \{ profile: item\.profile, \.\.\.pluginGroupScope\(group\), enabled \}\)/, '批量开关按 profile 和插件组走')
  assert.match(html, /post\('\/api\/packs\/update', \{ profile: item\.profile, \.\.\.\(group \? pluginGroupScope\(group\) : \{\}\) \}\)/, '整包更新按 profile 和插件组走')
  assert.match(html, /post\('\/api\/profiles\/delete'/, '手动拼的 profile 走「删除 profile」')
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
  assert.match(html, /appConfirm\(t\('删除「\{profile\}」？其中的 \{n\} 个插件/, '删整个 profile 目录要再确认一次')
  assert.ok(!/[^p]confirm\(/.test(html), '不再用原生 confirm 弹窗')
})

test('切换安装目标会重新检查，关闭后的旧请求不能复活预览', async () => {
  let resolvePost
  const calls = []
  const context = vm.createContext({
    AbortController, packInspectAbort: null,
    packBusy: false, packInspection: { token: 'cached', ok: true }, packTargetProfile: '', packInspectRequest: 0,
    openedPack: { profile: 'work' }, pluginProfile: 'web', packState: {}, state: {},
    packInstallDialog: {}, document: { getElementById: () => ({}) },
    openImportDialog() {}, closeMarketDetail() {}, showPackDialog() {}, hidePackDialog() {}, renderPackMarket() {}, renderPackInspect() {}, renderPackView() {}, packInstalling: false,
    packHintEl: {}, t: (text) => text, notify() {},
    post: (path, body) => { calls.push({ path, body }); return new Promise((resolve) => { resolvePost = resolve }) },
  })
  new vm.Script(slice('async function inspectPack(payload)', 'async function installPack()')).runInContext(context)
  const pending = context.inspectPack({ token: 'cached', profile: 'other' })
  assert.equal(calls[0].body.token, 'cached', '重用已下载的包')
  assert.equal(calls[0].body.profile, 'other')
  assert.equal(context.packTargetProfile, 'other')
  assert.equal(context.packInspection.ok, false, '重算完成前不能安装旧计划')
  new vm.Script(slice('function closeInstallDialog()', "document.getElementById('packDetailClose')")).runInContext(context)
  const signal = context.packInspectAbort.signal
  context.closeInstallDialog()
  assert.equal(signal.aborted, true, '关闭时中止下载，不等远端响应才恢复操作')
  assert.equal(context.packBusy, false)
  context.packBusy = true
  context.packInspectRequest += 1
  resolvePost({ ok: true, target: { profile: 'other' } })
  await pending
  assert.equal(context.packInspection, null, '关闭后到达的结果被丢弃')
  assert.equal(context.packBusy, true, '旧响应不能清掉新检查的忙碌状态')
})

test('安装前必须有对应目标的有效检查结果；安装中取消不清空状态', async () => {
  let calls = 0
  const context = vm.createContext({
    launcherRunning: () => false,
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

test('安装计划和忙碌重画只更新固定页脚按钮，正文滚动不带走操作区', () => {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', hidden: true, addEventListener() {} })
    return nodes.get(id)
  }
  const context = vm.createContext({
    document: { getElementById: node, documentElement: { classList: { contains: () => true } } },
    uiSelects: new Map(), openUiSelect: null, createUiSelect() {},
    packInspectEl: node('packInspect'), packTargetProfile: 'web', packState: { profiles: ['web'] },
    packInspection: { ok: true, token: 'checked', pack: { name: 'test-pack', version: '1.0.0', dependencies: [] }, target: { profile: 'web' }, plan: { warnings: ['一段较长的安装提示'] } },
    packBusy: false, packInstalling: false, launcherRunning: () => false,
    t: (text) => text, escapeHtml: (text) => String(text ?? ''),
    installPack() {}, closeInstallDialog() {},
  })
  new vm.Script(slice('function packRows(title, rows)', 'async function loadMarket(')).runInContext(context)
  context.renderPackInspect()
  assert.match(node('packInspect').innerHTML, /一段较长的安装提示/)
  assert.doesNotMatch(node('packInspect').innerHTML, /id="packInstall"|id="packCancel"/)
  assert.equal(node('packInstallActions').hidden, false)
  assert.match(node('packInstallActions').innerHTML, /aria-busy="false"/)
  assert.doesNotMatch(node('packInstallActions').innerHTML, /disabled/)
  context.packInstalling = context.packBusy = true
  context.renderPackInspect()
  assert.match(node('packInstallActions').innerHTML, /aria-busy="true" disabled/)
  assert.match(node('packInstallActions').innerHTML, /id="packCancel" disabled/)
  assert.equal(node('packInstallClose').disabled, true)
  context.packInspection = null
  context.renderPackInspect()
  assert.equal(node('packInstallActions').hidden, true)
  assert.equal(node('packInstallActions').innerHTML, '')
})

test('整合包安装成功只显示已安装，真实失败才弹出安装失败', async () => {
  const notices = [], closed = []
  let fail = false
  const context = vm.createContext({
    launcherRunning: () => false,
    packBusy: false, packInstalling: false, packTargetProfile: 'desktop',
    packInspection: { ok: true, token: 'checked', source: 'smooth', target: { profile: 'desktop' } },
    packHintEl: { textContent: '' }, packInstallDialog: {},
    document: { getElementById: () => ({ value: 'desktop' }) },
    t: (text) => text,
    notify: (...args) => notices.push(args),
    post: async () => {
      if (fail) throw new Error('依赖安装失败')
      return { installed: { name: 'smooth', profile: 'desktop' } }
    },
    applyPluginPayload() {}, renderPackMarket() {}, renderPackInspect() {}, renderPackGrid() {}, renderPackView() {},
    hidePackDialog: async () => closed.push('install'),
    closeMarketDetail: async () => closed.push('detail'),
    openPack: (profile) => { context.selectedProfile = profile },
  })
  new vm.Script(slice('async function installPack()', 'async function removePack(')).runInContext(context)
  await context.installPack()
  assert.deepEqual(notices, [], '成功不能复用默认标题为操作失败的提示框')
  assert.equal(context.packHintEl.textContent, '已安装')
  assert.equal(context.selectedProfile, 'desktop')
  assert.deepEqual(closed, ['install', 'detail'], '关闭确认和详情后，保留市场展示安装结果')
  assert.equal(context.packBusy, false)
  fail = true
  context.packInspection = { ok: true, token: 'checked', target: { profile: 'desktop' } }
  await context.installPack()
  assert.deepEqual(notices, [['依赖安装失败', '整合包安装失败']])
  assert.equal(context.packInstalling, false)
})

test('市场卡片与详情从安装记录显示已安装，其他环境和新版本仍可安装', () => {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false })
    return nodes.get(id)
  }
  const panel = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => ({}) })
  const entry = { id: 'author/smooth', name: 'smooth', displayName: '丝滑的DSH', version: '1.0.0' }
  const context = vm.createContext({
    openedPack: { profile: 'desktop' }, pluginProfile: 'desktop', state: {},
    packState: { packs: [{ profile: 'desktop', records: [{ name: 'smooth', source: entry.id, version: '1.0.0' }] }] },
    packMarket: { entries: [entry] }, packBusy: false, launcherRunning: () => false,
    marketDetailIndex: 0, marketSearchEl: { value: '' }, marketSortEl: { value: 'name' },
    packMarketEl: panel(), packMarketDetailEl: panel(), packMarketActionsEl: panel(), document: { getElementById: node },
    window: { launcherMarketLayout: { refresh() {} } },
    t: (text) => text, escapeHtml: (text) => String(text ?? ''), marketStar: '', marketCube: '',
  })
  new vm.Script(slice('function marketDate(value)', 'async function loadMarketStats()')).runInContext(context)
  const render = () => { context.renderPackMarket(); context.renderMarketDetail() }
  const installed = () => {
    for (const el of [context.packMarketEl, context.packMarketActionsEl]) assert.match(el.innerHTML, /class="[^"]*market-install"[^>]*disabled[^>]*>已安装<\/button>/)
  }
  const available = () => {
    for (const el of [context.packMarketEl, context.packMarketActionsEl]) assert.match(el.innerHTML, /class="[^"]*market-install"[^>]*>安装<\/button>/)
  }
  render()
  installed()
  assert.doesNotMatch(context.packMarketDetailEl.innerHTML, /market-install/, '详情正文不包含安装按钮')
  context.openedPack = { profile: 'web' }
  render()
  available()
  context.openedPack = { profile: 'desktop' }
  entry.version = '2.0.0'
  render()
  available()
  entry.version = '1.0.0'
  render()
  installed()
  context.packState.packs[0].records = []
  render()
  available()
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

// 接口更名和确认文案不能削弱保护：执行页面函数验证取消和确认两条分支。
test('删除 Profile 先确认，取消不发请求，确认后定向删除', async () => {
  const calls = []
  let approved = false
  const context = { packBusy: false, pluginUpdating: '', openedPack: null, pluginProfile: 'web', state: { profile: 'web' }, t: (s) => s,
    appConfirm: async () => approved, renderPackGrid() {}, renderPackView() {}, applyPluginPayload() {}, notify() {},
    post: async (...args) => { calls.push(args); return {} } }
  const source = html.match(/    async function removeProfileDir\(item\) \{[\s\S]*?\n    \}/)[0]
  vm.runInNewContext(source, context)
  const item = { profile: 'work', pluginCount: 2 }
  await context.removeProfileDir(item)
  assert.equal(calls.length, 0)
  approved = true
  await context.removeProfileDir(item)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/api/profiles/delete')
  assert.equal(calls[0][1].profile, 'work')
  assert.equal(context.packBusy, false)
})
