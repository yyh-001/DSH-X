/**
 * Profile 页（原插件页，含 Profile 卡片区）、环境页的导入 / 导出入口与两个弹窗的结构自检：
 * 卡片区 / 详情 / 两个弹窗都在、按需加载接上了、导入导出走环境接口、文案都有英文。
 *
 * 整合包改名叫环境：导入 = 把包变成一个环境（只取 DSH 版本和插件清单，包里的配置可选导进某个 Profile），
 * 导出 = 把一个环境写成 .dspack 或仓库目录。入口都在环境页，Profile 页只剩老安装记录的撤销。
 *
 * 和设置页那份测试同一种做法——直接读 index.html / environments-page.js 断言结构，交互函数抠出来放进 vm 里跑，不做浏览器渲染。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
// 环境页单独一个脚本，跑在主脚本之后，用主脚本的全局（openImportDialog、inspectPack、openExportDialog、environmentState）
const envPage = readFileSync(fileURLToPath(new URL('../src/public/environments-page.js', import.meta.url)), 'utf8')

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

test('两个弹窗：导入（来源 + 市场）与导出（目标、离线文件、工作流、名称版本说明仓库），控件齐全', () => {
  const importDialog = slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="packExportDialog"')
  for (const id of ['packSource', 'packCheck', 'packPick', 'packInspect', 'packMarket', 'packProgress', 'packProgressBar', 'packHint', 'packImportClose']) {
    assert.match(importDialog, new RegExp(`id="${id}"`), `导入弹窗里要有 ${id}`)
  }
  const exportDialog = slice('<div class="ask" id="packExportDialog"', '<div class="ask" id="launchDialog"')
  for (const id of ['packExportName', 'packExportVersion', 'packExportDescription', 'packExportRepo', 'packExportOffline', 'packExportWorkflow', 'packExportHint', 'packExportGo', 'packExportCancel']) {
    assert.match(exportDialog, new RegExp(`id="${id}"`), `导出弹窗里要有 ${id}`)
  }
  // 导出目标二选一：单个 .dspack 文件（默认）或一个能直接提交的仓库目录
  assert.match(exportDialog, /<input type="radio" name="packExportTarget" value="file" checked \/>/, '默认导出成单个文件')
  assert.match(exportDialog, /<input type="radio" name="packExportTarget" value="dir" \/>/, '可以选仓库目录')
  // 发布工作流只对仓库目录有意义：默认藏着，选了仓库目录才露出来
  assert.match(exportDialog, /id="packExportWorkflowRow" hidden/, '工作流那一行默认藏起来')
  assert.match(exportDialog, /<input type="checkbox" id="packExportWorkflow" \/>/, '工作流默认不勾')
  assert.match(html, /getElementById\('packExportWorkflowRow'\)\.hidden = input\.value !== 'dir'/, '切到仓库目录才显示工作流')
  assert.ok(!/id="packExportHome"/.test(html), '环境不带用户目录里的东西，「连同用户目录一起导出」撤掉')
  assert.doesNotMatch(html, /id="packImportOpen"/, '撤去重复的顶栏装包入口')
  assert.match(importDialog, /<details class="pack-import-source">/, '文件与链接导入默认折叠')
  assert.match(importDialog, /id="packMarketDetail"/, '社区卡片可以查看完整详情')
  assert.ok(!/id="packExportProfile"/.test(html), '没有「导出某个 Profile」的入口了')
  assert.ok(!/id="pluginCheckUpdates"/.test(html), '更新检查放到当前 Profile 详情')
})

test('导出弹窗：本地插件逐个列成「带上离线文件」的勾选项，默认都勾；不勾的跟着请求一起交给服务端', async () => {
  const offline = { hidden: true, innerHTML: '' }
  const node = (value = '') => ({ value, placeholder: '' })
  const context = vm.createContext({
    exportingEnvironment: null, exportRevision: 0, AUTO_VERSION: 'auto',
    // 默认版本号来自 GET /api/environments 的 defaults.packVersion（环境页拉列表时存进 environmentState）
    environmentState: { list: [], pendingOpen: '', defaults: { packVersion: '1.0.0' }, reload: null },
    packExportNameEl: node(), packExportVersionEl: node(), packExportDescriptionEl: node(), packExportRepoEl: node(),
    packExportOfflineEl: offline, packExportHintEl: { textContent: '' }, packExportDialog: {},
    showPackDialog() {}, t: (text) => text, escapeHtml: (text) => String(text ?? ''),
  })
  new vm.Script(slice('    function openExportDialog(env)', '    function closeExportDialog()')).runInContext(context)
  context.openExportDialog({
    id: 'env-a', name: '甲', packVersion: '', description: '', dshVersion: '1.0.0', source: null,
    plugins: [
      { name: 'dsh-x-local', spec: 'link:/somewhere', local: true, offline: false },
      { name: 'dsh-x-npm', spec: '1.0.0', local: false, offline: false },
      { name: 'dsh-x-carried', spec: 'file:/env/files/x.tgz', local: true, offline: true },
    ],
  })
  assert.equal(offline.hidden, false, '有本地插件就列出来')
  const boxes = [...offline.innerHTML.matchAll(/<input type="checkbox" data-offline="([^"]+)"( checked)?/g)].map((match) => [match[1], Boolean(match[2])])
  assert.deepEqual(boxes, [['dsh-x-local', true], ['dsh-x-carried', true]], '只列本地插件（npm 插件按版本钉，不用离线文件），默认都带上')
  // 没导出过的环境：版本号留空（服务端用默认值），占位提示就是那个默认值
  assert.equal(context.packExportVersionEl.value, '')
  assert.equal(context.packExportVersionEl.placeholder, '1.0.0')
  assert.equal(context.packExportHintEl.textContent, '', '钉了版本的环境不用提示')
  assert.equal(context.exportRevision, 1, '每打开一次换一个编号，晚到的旧结果据此认出来')

  context.openExportDialog({ id: 'env-b', name: '乙', packVersion: '2.1.0', description: '上次的说明', dshVersion: 'auto', source: null, plugins: [{ name: 'dsh-x-npm', spec: '1.0.0', local: false, offline: false }] })
  assert.equal(offline.hidden, true, '没有本地插件时这块藏起来')
  assert.equal(context.packExportVersionEl.value, '2.1.0', '导出过的环境接着用上次的版本号')
  assert.equal(context.packExportVersionEl.placeholder, '1.0.0')
  assert.equal(context.packExportDescriptionEl.value, '上次的说明', '说明也接着填')
  assert.notEqual(context.packExportHintEl.textContent, '', '跟着最新版本走的环境要说明导出时会钉成精确版本')
  assert.equal(context.exportRevision, 2)

  // 提交：不勾的本地插件进 exclude；工作流只在仓库目录模式下发
  const posts = []
  const notices = []
  let reloads = 0
  // 默认用户在选位置时取消；成功 / 失败的回答在后面换
  let reply = async () => ({ canceled: true })
  const unchecked = { checked: false, dataset: { offline: 'dsh-x-local' } }
  const checked = { checked: true, dataset: { offline: 'dsh-x-carried' } }
  const submit = vm.createContext({
    exportingEnvironment: { id: 'env-a', name: '甲' }, packBusy: false, exportRevision: 1,
    packExportDialog: { querySelector: () => ({ value: 'dir' }) },
    packExportOfflineEl: { querySelectorAll: () => [unchecked, checked] },
    packExportGoEl: {}, packExportHintEl: { textContent: '', innerHTML: '' },
    packExportNameEl: node('甲'), packExportVersionEl: node(' 1.2.0 '), packExportDescriptionEl: node('说明'), packExportRepoEl: node('owner/repo'),
    packExportWorkflowEl: { checked: true },
    document: { getElementById: () => null },
    // 导出成功后让环境页重读列表：服务端刚把版本号和说明记回环境，再打开导出框才看得到
    environmentState: { list: [], pendingOpen: '', defaults: {}, reload: async () => { reloads += 1 } },
    t: (text) => text, escapeHtml: (text) => String(text ?? ''), notify: (...args) => notices.push(args), packNotes: () => '',
    post: async (path, body) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return reply() },
  })
  new vm.Script(slice('    async function exportEnvironment()', '    /** 进度条')).runInContext(submit)
  await submit.exportEnvironment()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/api/environments/export')
  assert.deepEqual(posts[0].body, {
    id: 'env-a', target: 'dir', name: '甲', version: '1.2.0', description: '说明', repo: 'owner/repo',
    exclude: ['dsh-x-local'], workflow: true,
  })
  submit.packExportDialog = { querySelector: () => ({ value: 'file' }) }
  await submit.exportEnvironment()
  assert.equal(posts[1].body.target, 'file')
  assert.equal(posts[1].body.workflow, false, '单个文件没有工作流可带')
  // 版本号按填的原样发（去掉首尾空白）；空着就发空串，由服务端用环境记着的或默认的
  submit.packExportVersionEl.value = ''
  await submit.exportEnvironment()
  assert.equal(posts[2].body.version, '')
  assert.equal(reloads, 0, '取消了就没有东西要重读')

  // 导出成功：画出结果，并让环境页重读一次
  reply = async () => ({ ok: true, path: '/tmp/out.dspack', dshVersion: '1.0.0', plugins: 1, offline: [], warnings: [] })
  await submit.exportEnvironment()
  assert.equal(reloads, 1, '成功后重读环境列表')
  assert.match(submit.packExportHintEl.innerHTML, /\/tmp\/out\.dspack/, '结果画进弹窗')
  assert.deepEqual(notices, [], '成功不弹提示')
  // 导出失败：报一次，不重读
  reply = async () => { throw new Error('写不进去') }
  await submit.exportEnvironment()
  assert.equal(reloads, 1, '失败不重读')
  assert.deepEqual(notices, [['写不进去', '导出失败']], '失败只报一次')
  assert.equal(submit.packExportHintEl.textContent, '写不进去')
  // 环境页还没挂上重读函数（reload 是 null）：成功照样收尾，不能被当成一次失败
  submit.environmentState.reload = null
  reply = async () => ({ ok: true, path: '/tmp/again.dspack', dshVersion: '1.0.0', plugins: 1, offline: [], warnings: [] })
  await submit.exportEnvironment()
  assert.equal(notices.length, 1, '没有重读函数也不多报一次失败')
  assert.match(submit.packExportHintEl.innerHTML, /\/tmp\/again\.dspack/)
  assert.equal(submit.packBusy, false)
})

test('导出：结果晚到、弹窗已经重新打开过时，不往新弹窗里画旧结果', async () => {
  const settle = []
  const notices = []
  let reloads = 0
  const hint = { textContent: '', innerHTML: '' }
  const context = vm.createContext({
    exportingEnvironment: { id: 'env-a', name: '甲' }, packBusy: false, exportRevision: 3,
    packExportDialog: { querySelector: () => ({ value: 'file' }) },
    packExportOfflineEl: { querySelectorAll: () => [] },
    packExportGoEl: {}, packExportHintEl: hint,
    packExportNameEl: { value: '甲' }, packExportVersionEl: { value: '' }, packExportDescriptionEl: { value: '' }, packExportRepoEl: { value: '' },
    packExportWorkflowEl: { checked: false },
    document: { getElementById: () => null },
    environmentState: { list: [], pendingOpen: '', defaults: {}, reload: async () => { reloads += 1 } },
    t: (text) => text, escapeHtml: (text) => String(text ?? ''), notify: (...args) => notices.push(args), packNotes: () => '',
    post: () => new Promise((resolve, reject) => settle.push({ resolve, reject })),
  })
  new vm.Script(slice('    async function exportEnvironment()', '    /** 进度条')).runInContext(context)

  const late = context.exportEnvironment()
  // 用户关掉又打开了导出框（openExportDialog 换了编号、清了提示）
  context.exportRevision += 1
  hint.textContent = '新弹窗'
  settle[0].resolve({ ok: true, path: '/tmp/out.dspack', dshVersion: '1.0.0', plugins: 1, offline: [], warnings: [] })
  await late
  assert.equal(hint.innerHTML, '', '旧结果不画进新弹窗')
  assert.equal(hint.textContent, '新弹窗')
  assert.equal(context.packBusy, false, '忙碌状态照样收尾')
  // 结果晚到也是一次成功的导出：服务端已经把版本号和说明记回环境，列表照样要重读（重读不碰弹窗）
  assert.equal(reloads, 1)

  const failed = context.exportEnvironment()
  context.exportRevision += 1
  hint.textContent = '又一个新弹窗'
  settle[1].reject(new Error('写不进去'))
  await failed
  assert.equal(hint.textContent, '又一个新弹窗', '旧的报错也不写进新弹窗的提示行')
  assert.deepEqual(notices, [['写不进去', '导出失败']], '失败本身还是要告诉用户，而且只报一次')
  assert.equal(reloads, 1, '失败不重读')
  assert.equal(context.packBusy, false)
})

test('导入 / 导出入口在环境页：Profile 页撤掉了这两个按钮', () => {
  const envPane = slice('<section class="pane" id="pane-environments">', '<section class="pane fill" id="pane-mcp">')
  assert.match(envPane, /<button class="ghost" id="environmentImport" type="button"/, '环境页有「导入…」')
  assert.match(envPane, /<button class="ghost" id="environmentExport" type="button"/, '环境详情有「导出…」')
  const profilePane = slice('<section class="pane" id="pane-plugins">', '<section class="pane" id="pane-environments">')
  assert.doesNotMatch(profilePane, /id="(?:environmentImport|environmentExport|packImport\w*|packExport\w*)"/, 'Profile 页里没有导入 / 导出按钮')
  assert.doesNotMatch(html, /data-pack-import|data-pack-export/, 'Profile 详情的工具栏里也不再画这两个按钮')
  assert.match(envPage, /importButton\.onclick = \(\) => openImportDialog\(\)/, '环境页的导入打开导入弹窗')
  assert.match(envPage, /if \(env\) openExportDialog\(env\)/, '导出的是当前打开的那个环境')
})

/** 环境页脚本里的一段（它整个包在一个 IIFE 里，按函数边界抠出来放进 vm 跑）。 */
const envSlice = (from, to) => {
  const start = envPage.indexOf(from)
  assert.ok(start >= 0, `environments-page.js 里找不到起点：${from}`)
  const end = envPage.indexOf(to, start)
  assert.ok(end > start, `environments-page.js 里找不到终点：${to}`)
  return envPage.slice(start, end)
}

/** 假容器：innerHTML 照写，querySelectorAll('[data-x]') 从写进去的 HTML 里把带这个属性的按钮捞出来。 */
function fakeContainer() {
  const box = { innerHTML: '', dataset: {}, buttons: new Map() }
  box.querySelectorAll = (selector) => {
    const attr = /^\[data-([a-z-]+)\]$/.exec(selector)?.[1]
    if (!attr) return []
    const key = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    return [...box.innerHTML.matchAll(new RegExp(`<button[^>]*data-${attr}="([^"]*)"[^>]*>`, 'g'))].map((match) => {
      const id = `${attr}:${match[1]}`
      if (!box.buttons.has(id)) box.buttons.set(id, { dataset: { [key]: match[1] }, disabled: /\sdisabled(?=[\s>])/.test(match[0]) })
      return box.buttons.get(id)
    })
  }
  return box
}

test('内置环境配方是环境页网格里的卡片：没导入过的才画，点一张进导入预览；导入弹窗里没有这一块', () => {
  const grid = fakeContainer()
  const inspected = []
  const context = vm.createContext({
    el: { grid, hint: { textContent: '' } },
    environments: [{ id: 'env-a', name: '甲', dshVersion: '1.0.0', plugins: [], usedBy: [] }],
    builtin: [
      { name: 'dsh-x-recommended', displayName: '推荐环境', description: '开箱即用', imported: false },
      { name: 'dsh-x-workbench', displayName: '工作台', description: '', imported: true },
    ],
    versionText: (env) => env.dshVersion, thirdParty: (env) => env.plugins, tagsOf: () => [],
    open() {}, inspectPack: (payload) => { inspected.push(JSON.parse(JSON.stringify(payload))) },
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? '')), escapeHtml: (text) => String(text ?? ''),
  })
  new vm.Script(envSlice('  function card(', '  function versionOptions(')).runInContext(context)
  context.renderGrid()
  assert.match(grid.innerHTML, /data-environment="env-a"/, '环境卡片照画')
  const recipes = grid.querySelectorAll('[data-builtin]')
  assert.deepEqual(recipes.map((button) => button.dataset.builtin), ['dsh-x-recommended'], '导入过的配方不再给卡片')
  assert.match(grid.innerHTML, /推荐环境/)
  recipes[0].onclick()
  assert.deepEqual(inspected, [{ builtin: 'dsh-x-recommended' }], '点配方卡片走导入预览（只读检查）')

  assert.match(html, /<div class="pack-grid" id="environmentGrid"><\/div>/, '网格在环境页里')
  const importDialog = slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="packDetailDialog"')
  assert.doesNotMatch(importDialog, /data-builtin|id="[^"]*[Bb]uiltin[^"]*"/, '导入弹窗里不再有内置配方那一块')
  assert.doesNotMatch(html, /data-builtin/, '主脚本不再画内置配方卡片（只有环境页画）')
})

test('页面逻辑：一张卡就是一个 profile，点开进详情，开关/更新/删除各自走对接口；导入导出走环境接口', () => {
  assert.match(html, /const paneLoaders = \{[^}]*plugins: loadPlugins[^}]*\}/, '进插件页才加载')
  assert.ok(!/paneLoaders = \{[^}]*packs:/.test(html), '整合包不再单独按需加载')
  assert.match(html, /function pluginRowHtml\(/, '插件行抽成共用函数')
  assert.match(html, /bindPluginRowEvents\(packPluginListEl, item\.profile\)/, '详情里的插件行按该 profile 绑定')
  assert.match(html, /post\('\/api\/packs\/toggle', \{ profile: item\.profile, \.\.\.pluginGroupScope\(group\), enabled \}\)/, '批量开关按 profile 和插件组走')
  assert.match(html, /post\('\/api\/profiles\/delete'/, '手动拼的 profile 走「删除 profile」')
  assert.match(html, /post\('\/api\/environments\/import\/inspect', payload/, '检查走环境导入的只读检查')
  assert.match(html, /post\('\/api\/environments\/import', \{ token: packInspection\.token/, '确认导入带上检查时拿到的 token')
  assert.match(html, /post\('\/api\/environments\/export', \{/, '导出走环境导出')
  assert.doesNotMatch(html + envPage, /\/api\/packs\/(?:inspect|install|export)'/, '页面不再调已经下线的整合包接口')
  // 导入 / 导出搬到环境页：Profile 详情里「装整合包」「导入当前环境」「导出当前环境」这几个入口都撤了
  assert.doesNotMatch(html, /data-pack-import-here|function importIntoProfile\(|data-pack-import\b|data-pack-export\b/, 'Profile 详情里不再有导入 / 导出入口')
  assert.match(html, /post\('\/api\/packs\/pick-file'/, '选本地文件走 pick-file')
  assert.match(html, /post\('\/api\/packs\/reveal'/, '导出的文件能在文件夹里定位')
  assert.match(html, /getJson\(`\/api\/packs\/market/, '市场列表由服务端读')
  assert.match(html, /data\?\.kind === 'pack'/, '整合包进度走 SSE 的 pack 事件')
  assert.match(html, /function applyPluginPayload\(data\)/, '插件与整合包状态一次灌进页面')
  assert.match(html, /function openPack\(profile\)/, '点卡片进详情')
  assert.match(html, /data-group-toggle/, '整体开关放到对应分组头部')
  assert.match(html, /data-group-remove/, '卸载入口放到对应整合包分组头部')
  assert.ok(!/data-pack-toggle/.test(html), '列表卡片不再承担批量操作')
  assert.match(html, /<button class="pack-card\$\{/, 'Profile 卡片是可通过键盘操作的按钮')
  assert.match(html, /<details class="pack-more">/, '次要操作收进更多操作')
  // 弹窗高度固定，插件数量变化不改变卡片高度；右上「更多操作」菜单才有空间完整展开
  assert.match(css, /#launchPluginsCard \{[^}]*height: min\(680px, calc\(100dvh - var\(--dialog-safe-area\)\)\)/)
  assert.match(css, /\.pack-more-actions \{[^}]*max-height: min\(50vh, 380px\)/)
  assert.match(html, /data-pack-check-updates/, '当前 Profile 详情可检查更新')
  assert.match(html, /<details class="pack-advanced">/, '导入预览的技术清单可按需展开')
  assert.match(html, /packSourceTags\(item\)/, '来源是以标签形式标在卡片上的')
  // 撤销（有安装记录）与删除整个 profile（没有记录）是两种动作，各自要确认；确认弹窗用样式化的 appConfirm，不用原生 confirm
  // 撤销文案按记录分两套（只导配置 / 旧整包安装），放在 UNDO_TEXT 里；点名包和 Profile、要确认，见下面「撤销」那条 vm 用例
  assert.match(html, /const UNDO_TEXT = Object\.freeze\(\{/, '撤销文案集中在一张冻结的表里')
  assert.match(html, /appConfirm\(t\(text\.confirm, \{ name: label, profile \}\), \{ title: t\(text\.title\) \}\)/, '撤销明确点名包和 Profile，并要求确认')
  assert.match(html, /appConfirm\(t\('删除「\{profile\}」？其中的 \{n\} 个插件/, '删整个 profile 目录要再确认一次')
  assert.ok(!/[^p]confirm\(/.test(html + envPage), '不再用原生 confirm 弹窗')
})

// 设计稿第三期：「更新整合包 = 把里面的插件都升到最新」撤了，环境的更新只跟上游 release 走（环境页）。
// Profile 页里只剩单个插件的「更新到 x」，整包 / 整组 / 「更新 N 个」这些批量入口都不该再有
test('Profile 页没有整包更新：没有「更新 N 个」和分组更新按钮，不调 /api/packs/update；单个插件更新照旧', () => {
  assert.doesNotMatch(html + envPage, /\/api\/packs\/update/, '页面不再调整合包更新接口')
  assert.doesNotMatch(html, /data-pack-update|data-group-update/, '详情顶部的「更新 N 个」和分组头部的更新按钮都撤了')
  assert.doesNotMatch(html, /function updatePack\(/, '整包更新的处理函数也撤了')
  assert.doesNotMatch(html, /t\('更新 \{n\} 个'|t\('更新 \{name\} 的 \{n\} 个插件'/, '批量更新的文案不再画')
  assert.match(html, /post\('\/api\/plugins\/update', \{ name, profile \}\)/, '单个插件更新按目标 Profile 走')
})

test('检查走环境导入接口，包里的配置默认不导；关闭后晚到的旧结果不能复活预览', async () => {
  let resolvePost
  const calls = []
  const context = vm.createContext({
    AbortController, packInspectAbort: null,
    // 上一次勾过「导进 Profile」：换一个包检查时要重新回到默认不导
    packBusy: false, packInspection: null, packTargetProfile: '', packInspectRequest: 0, packConfigWanted: true,
    openedPack: null, pluginProfile: 'web', packState: {}, state: { profile: 'work' },
    packInstallDialog: {}, document: { getElementById: () => ({}) },
    openImportDialog() {}, closeMarketDetail() {}, showPackDialog() {}, hidePackDialog() {}, renderPackMarket() {}, renderPackInspect() {}, renderPackView() {}, packInstalling: false,
    packHintEl: {}, t: (text) => text, notify() {},
    post: (path, body) => { calls.push({ path, body }); return new Promise((resolve) => { resolvePost = resolve }) },
  })
  new vm.Script(slice('async function inspectPack(payload)', 'async function installPack()')).runInContext(context)
  const payload = { source: '/tmp/demo.dspack' }
  const pending = context.inspectPack(payload)
  assert.equal(calls[0].path, '/api/environments/import/inspect')
  assert.equal(calls[0].body, payload, '来源原样交给服务端（文件、链接、owner/repo、市场条目、内置配方都是这一个口子）')
  assert.equal(context.packConfigWanted, false, '包里的配置默认不导进 Profile')
  assert.equal(context.packInspection, null, '检查完成前没有可导入的结果')
  assert.equal(context.packBusy, true)
  new vm.Script(slice('function closeInstallDialog()', "document.getElementById('packDetailClose')")).runInContext(context)
  const signal = context.packInspectAbort.signal
  context.closeInstallDialog()
  assert.equal(signal.aborted, true, '关闭时中止下载，不等远端响应才恢复操作')
  assert.equal(context.packBusy, false)
  context.packBusy = true
  context.packInspectRequest += 1
  resolvePost({ ok: true, token: 'late', environment: {} })
  await pending
  assert.equal(context.packInspection, null, '关闭后到达的结果被丢弃')
  assert.equal(context.packBusy, true, '旧响应不能清掉新检查的忙碌状态')
})

test('确认导入前必须有通过的检查结果；导入中关闭不清空状态', async () => {
  let calls = 0
  const context = vm.createContext({
    packBusy: false, packInspection: { ok: false, token: 'bad', environment: {}, errors: ['坏了'] }, packTargetProfile: 'web', packConfigWanted: false,
    post() { calls += 1 }, packInstalling: true,
    hidePackDialog() { calls += 1 }, packInstallDialog: {}, renderPackInspect() {}, renderPackMarket() {}, renderPackView() {},
    document: { getElementById: () => null }, packHintEl: {}, t: (text) => text,
  })
  new vm.Script(slice('async function installPack()', 'async function removePack(')).runInContext(context)
  await context.installPack()
  assert.equal(calls, 0, '检查没通过不能导入')
  context.packInspection = { ok: true, token: 'checked', environment: {} }
  context.packBusy = true
  await context.installPack()
  assert.equal(calls, 0, '上一个操作没结束不能再点导入')
  new vm.Script(slice('function closeInstallDialog()', "document.getElementById('packDetailClose')")).runInContext(context)
  context.closeInstallDialog()
  assert.equal(calls, 0)
  assert.equal(context.packInspection.ok, true, '导入期间的关闭操作不清空检查状态')
})

test('导入预览和忙碌重画只更新固定页脚按钮，正文滚动不带走操作区', () => {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', hidden: true, addEventListener() {} })
    return nodes.get(id)
  }
  const context = vm.createContext({
    document: { getElementById: node, documentElement: { classList: { contains: () => true } } },
    uiSelects: new Map(), openUiSelect: null, createUiSelect() {},
    packInspectEl: node('packInspect'), packTargetProfile: 'web', packConfigWanted: false, packState: { profiles: ['web'] },
    packInspection: {
      ok: true, token: 'checked', bytes: 2048,
      environment: { name: 'test-pack', packVersion: '1.0.0', dshVersion: '1.0.0', dshInstalled: true, plugins: [], bundles: [], offline: [], source: null },
      profileData: { patch: false, overrides: [], home: [], available: false }, profiles: ['web'],
      errors: [], warnings: ['一段较长的安装提示'],
    },
    packBusy: false, packInstalling: false, launcherRunning: () => false, AUTO_VERSION: 'auto',
    // 带占位符的文案要真填进去，才看得出版本那一栏显示的是什么
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? '')), escapeHtml: (text) => String(text ?? ''),
    installPack() {}, closeInstallDialog() {},
  })
  new vm.Script(slice('function packRows(title, rows)', 'async function loadMarket(')).runInContext(context)
  context.renderPackInspect()
  assert.match(node('packInspect').innerHTML, /一段较长的安装提示/)
  assert.doesNotMatch(node('packInspect').innerHTML, /自动最新版本/, '钉了版本就显示版本号')
  assert.doesNotMatch(node('packInspect').innerHTML, /id="packInstall"|id="packCancel"/)
  assert.equal(node('packInstallActions').hidden, false)
  assert.match(node('packInstallActions').innerHTML, /aria-busy="false"/)
  assert.doesNotMatch(node('packInstallActions').innerHTML, /disabled/)
  context.packInspection.environment.dshVersion = 'auto'
  context.renderPackInspect()
  assert.match(node('packInspect').innerHTML, /自动最新版本/, '包里没写 DSH 版本：显示「自动最新版本」，不显示 auto')
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

test('导入成功跳到环境页打开新环境，真失败才弹「导入失败」；勾了配置才带上 Profile', async () => {
  const notices = [], closed = [], panes = [], posts = []
  let reloads = 0
  let fail = false
  let configError = ''
  const installDialog = { name: 'install' }, importDialog = { name: 'import' }
  const context = vm.createContext({
    packBusy: false, packInstalling: false, packTargetProfile: 'desktop', packConfigWanted: false,
    packInspection: { ok: true, token: 'checked', environment: { dshInstalled: true } },
    packHintEl: { textContent: '' }, packInstallDialog: installDialog, packImportDialog: importDialog,
    currentPane: 'control',
    environmentState: { list: [], pendingOpen: '', defaults: {}, reload: async () => { reloads += 1 } },
    // 配置导进哪个 Profile 只认 packTargetProfile；页面上的下拉框写着别的值也不能被拿去用
    document: { getElementById: (id) => (id === 'packProfile' ? { value: 'from-dom' } : null) },
    t: (text) => text,
    notify: (...args) => notices.push(args),
    post: async (path, body) => {
      posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
      if (fail) throw new Error('依赖安装失败')
      return { ok: true, environment: { id: `env-${posts.length}` }, config: configError ? { profile: 'desktop', error: configError } : null }
    },
    renderPackMarket() {}, renderPackInspect() {},
    hidePackDialog: async (dialog) => closed.push(dialog?.name),
    closeMarketDetail: async () => closed.push('detail'),
    showPane: async (pane) => panes.push(pane),
  })
  new vm.Script(slice('async function installPack()', 'async function removePack(')).runInContext(context)
  await context.installPack()
  assert.deepEqual(notices, [], '成功不能复用默认标题为操作失败的提示框')
  assert.equal(posts[0].path, '/api/environments/import')
  assert.deepEqual(posts[0].body, { token: 'checked' }, '没勾「导进 Profile」就不带 profile：包里的配置不导')
  assert.equal(context.environmentState.pendingOpen, 'env-1', '环境页打开的是刚导入的那个')
  assert.deepEqual(panes, ['environments'], '不在环境页时导入完跳过去')
  assert.equal(reloads, 0, '跳过去时由环境页自己加载，不必再重读一次')
  assert.ok(closed.includes('install') && closed.includes('detail') && closed.includes('import'), '确认、详情、导入弹窗都关掉')
  assert.equal(context.packInspection, null)
  assert.equal(context.packBusy, false)
  assert.equal(context.packInstalling, false)

  // 勾了配置：带上选的 Profile；环境导进来了、配置没写进去时要说清楚，不能报成整个导入失败
  context.packInspection = { ok: true, token: 'with-config', environment: { dshInstalled: true } }
  context.packConfigWanted = true
  configError = 'Profile 正在用'
  // 已经在环境页：showPane 不会再拉列表，要让环境页自己重读
  context.currentPane = 'environments'
  await context.installPack()
  assert.deepEqual(posts[1].body, { token: 'with-config', profile: 'desktop' }, 'Profile 取自 packTargetProfile')
  assert.equal(notices.length, 1)
  assert.equal(notices[0][0], 'Profile 正在用')
  assert.notEqual(notices[0][1], '导入失败', '环境已经导入了，标题不能说导入失败')
  assert.equal(context.environmentState.pendingOpen, 'env-2')
  assert.equal(reloads, 1, '在环境页时直接重读环境列表')
  assert.deepEqual(panes, ['environments'], '已经在环境页就不再切一次')

  fail = true
  notices.length = 0
  context.packConfigWanted = false
  context.packInspection = { ok: true, token: 'checked', environment: { dshInstalled: true } }
  await context.installPack()
  assert.deepEqual(notices, [['依赖安装失败', '导入失败']])
  assert.equal(context.packInstalling, false)
  assert.equal(context.packBusy, false)
})

test('市场卡片与详情按已导入的环境显示「已导入」：同一条目的同一版本才算，和当前看的 Profile 无关', () => {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false })
    return nodes.get(id)
  }
  const panel = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => ({}) })
  const entry = { id: 'author/smooth', name: 'smooth', displayName: '丝滑的DSH', version: '1.0.0' }
  // 环境自己的 packVersion 导出时会改成作者填的版本，「导入的是哪一版」要看来源里记的 source.packVersion
  const imported = { id: 'env-smooth', name: '丝滑的DSH', source: { kind: 'market', marketId: entry.id, packVersion: '1.0.0' }, packVersion: '3.0.0' }
  const context = vm.createContext({
    openedPack: { profile: 'desktop' }, pluginProfile: 'desktop', state: {},
    // 「已导入」看的是主脚本共享的环境列表（environmentState）
    environmentState: { list: [imported], pendingOpen: '' },
    packState: { packs: [] },
    packMarket: { entries: [entry] }, packBusy: false, launcherRunning: () => false,
    marketDetailIndex: 0, marketSearchEl: { value: '' }, marketSortEl: { value: 'name' },
    packMarketEl: panel(), packMarketDetailEl: panel(), packMarketActionsEl: panel(), document: { getElementById: node },
    window: { launcherMarketLayout: { refresh() {} } },
    t: (text) => text, escapeHtml: (text) => String(text ?? ''), marketStar: '', marketCube: '',
  })
  new vm.Script(slice('function marketDate(value)', 'async function loadMarketStats()')).runInContext(context)
  const render = () => { context.renderPackMarket(); context.renderMarketDetail() }
  const installed = (why) => {
    for (const el of [context.packMarketEl, context.packMarketActionsEl]) assert.match(el.innerHTML, /class="[^"]*market-install"[^>]*disabled[^>]*>已导入<\/button>/, why)
  }
  const available = (why) => {
    for (const el of [context.packMarketEl, context.packMarketActionsEl]) assert.match(el.innerHTML, /class="[^"]*market-install"(?![^>]*disabled)[^>]*>导入<\/button>/, why)
  }
  render()
  installed('同一条目的同一版本已经导入成环境')
  assert.doesNotMatch(context.packMarketDetailEl.innerHTML, /market-install/, '详情正文不包含导入按钮')
  context.openedPack = { profile: 'web' }
  render()
  installed('环境不属于某个 Profile：换一个 Profile 看也是已导入')
  entry.version = '2.0.0'
  render()
  available('市场上出了新版本，可以再导')
  entry.version = '1.0.0'
  render()
  installed('回到同一版本')
  context.environmentState.list = [{ ...imported, source: { kind: 'market', marketId: 'someone/else', packVersion: '1.0.0' } }]
  render()
  available('别的条目导入的环境不算')
  context.environmentState.list = [{ ...imported, packVersion: '1.0.0', source: { kind: 'market', marketId: entry.id, packVersion: '0.9.0' } }]
  render()
  available('环境自己的 packVersion 碰巧对上不算：导入的是 0.9.0')
  context.environmentState.list = [imported]
  delete entry.version
  render()
  installed('条目没写版本：导入过同一条目就算')
  entry.version = '1.0.0'
  // 旧版的整合包安装记录（装进某个 Profile）不等于导入过环境
  context.environmentState.list = []
  context.packState.packs = [{ profile: 'web', records: [{ name: 'smooth', source: entry.id, version: '1.0.0' }] }]
  render()
  available('只有老安装记录、没有环境时仍可导入')
})

test('环境与 Profile 相关的中文文案都有英文', () => {
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  const cjk = /[一-鿿]/
  const missing = new Set()
  const add = (text) => { if (cjk.test(text) && !dict[text]) missing.add(text) }
  const pane = slice('<section class="pane" id="pane-plugins">', '<section class="pane fill" id="pane-mcp">')
  for (const match of pane.matchAll(/data-i18n="([^"]+)"/g)) add(match[1])
  const dialogs = slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="notice"')
  for (const match of dialogs.matchAll(/data-i18n="([^"]+)"/g)) add(match[1])
  // 环境页和导入 / 导出弹窗是这次新写的：占位符、无障碍名称、按钮提示也要逐条有英文
  const fresh = slice('<section class="pane" id="pane-environments">', '<section class="pane fill" id="pane-mcp">')
    + slice('<div class="ask" id="packImportDialog"', '<div class="ask" id="launchDialog"')
  for (const match of fresh.matchAll(/data-(?:i18n|placeholder-i18n|i18n-aria-label|i18n-title)="([^"]+)"/g)) add(match[1])
  // 撤销文案放在 UNDO_TEXT 表里、用 t(text.confirm) 翻译，下面按 t('…') 字面量扫不到，单独逐条查
  const undo = slice('    const UNDO_TEXT = Object.freeze(', '    async function removePack(')
  const undoTexts = [...undo.matchAll(/: '([^'\n]+)'/g)].map((match) => match[1])
  assert.equal(undoTexts.length, 6, '两套撤销文案各三条（确认、标题、完成）')
  for (const text of undoTexts) add(text)
  for (const block of [
    // 段落标记跟着页面走：Profile 视图那段原来叫「// ---- 整合包：…」，改名后按新标记切，覆盖的还是同一片脚本
    slice('const pluginPanelEl = document.getElementById', '// ---- Profile 视图 + 环境的导入 / 导出弹窗'),
    slice('// ---- Profile 视图 + 环境的导入 / 导出弹窗', '// ---- MCP 服务器'),
    envPage,
  ]) {
    for (const match of block.matchAll(/t\('([^'\n]+)'/g)) add(match[1])
  }
  assert.deepEqual([...missing], [], '环境页 / Profile 页 / 导入导出相关没翻的中文')
})

// 「环境」在界面上只指新的环境对象（DSH 版本 + 插件清单）；上游早先拿「环境」说 Profile 的地方都改叫 Profile。
// 两边合并时最容易被旧文案冲回来，这里逐条钉住
test('「环境」只指 DSH 版本 + 插件清单：说 Profile 的旧叫法都换掉了，新叫法都有英文', () => {
  const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
  for (const old of ['启动环境', '修复环境', '系统环境不能删除', '系统环境不能重命名', '装进环境「{profile}」', '创建独立环境']) {
    assert.ok(!html.includes(old) && !envPage.includes(old) && !server.includes(old), `旧叫法「${old}」不该再出现`)
  }
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const text of ['目录与 Profile', '选择目录与 Profile', '修复 Profile', '装进 Profile「{profile}」']) {
    assert.ok(html.includes(text), `页面里要用「${text}」`)
    assert.ok(dict[text], `「${text}」要有英文`)
  }
  assert.ok(Object.keys(dict).some((key) => key.startsWith('新建一个 Profile：它放配置和数据，插件跟着启动项选的环境走。')), '新建 Profile 的说明讲清 Profile 和环境各管什么')
  assert.ok(Object.keys(dict).some((key) => key.startsWith('系统 Profile 不能删除')) && Object.keys(dict).some((key) => key.startsWith('系统 Profile 不能重命名')), '系统 Profile 的保护提示改叫 Profile')
})

test('这次新加的文案有英文，返回按钮的提示可翻译，「修复 Profile」不再重复', () => {
  const source = html.match(/const EN = (\{[\s\S]*?\n\})/)[1]
  const dict = new vm.Script(`(${source})`).runInNewContext()
  // 「复制来源目录 / 复制来源 Profile」那两个下拉已经换成两栏选择窗（见 launch-isolation-page），文案跟着撤了
  for (const key of ['已导入', '撤销', '导入过的配置']) {
    assert.equal(typeof dict[key], 'string', `「${key}」要有英文`)
    assert.ok(dict[key].trim() && !/[一-鿿]/.test(dict[key]), `「${key}」的英文不能空着或还是中文`)
  }
  const back = html.match(/<button[^>]*id="packBack"[^>]*>/)?.[0] || ''
  const title = /data-i18n-title="([^"]+)"/.exec(back)?.[1]
  const label = /data-i18n-aria-label="([^"]+)"/.exec(back)?.[1]
  assert.ok(title && label, '返回 Profile 列表的按钮：提示和无障碍名称都要能切英文')
  assert.ok(dict[title] && dict[label], '两条都在英文词典里')
  // 对象字面量里重复的键后一个静默覆盖前一个，改了前面那条也不会生效
  const keys = [...source.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((match) => match[1])
  assert.equal(keys.filter((key) => key === '修复 Profile').length, 1, '「修复 Profile」只留一条')
})

test('Profile 详情：导入过的配置单列一行，只有最近一条真实记录、没在忙时才能撤销；点了按那条记录撤', () => {
  const list = fakeContainer()
  list.classList = { toggle() {}, remove() {} }
  list.setAttribute = () => {}
  const removed = []
  const hidden = () => ({ hidden: false, classList: { toggle() {} }, querySelector: () => ({ append() {} }) })
  const context = vm.createContext({
    paintPluginHomes() {}, renderRecovery() {}, packMetaLine: () => '', setPluginProgress() {}, bindPluginRowEvents() {},
    openedPack: { profile: 'work' }, packState: { profile: 'web', packs: [] },
    packViewEl: hidden(), pluginOverviewEl: hidden(), paneTopEl: hidden(), launchPluginsDialogEl: { hidden: true }, pluginLaunchEntry: null,
    packDetailNameEl: { textContent: '' }, packDetailSubEl: { textContent: '' }, launchPluginsCardEl: hidden(),
    packHeadEl: { innerHTML: '', querySelector: () => null }, packPluginListEl: list,
    pluginDialogLoading: false, pluginChecking: false, pluginUpdating: '', pluginRemoving: '', pluginAdding: '', packBusy: false, pluginProgress: null,
    pluginUpdates: {}, pluginGroupPending: new Map(), pluginTogglePending: new Set(), packMoreIcons: {},
    // 插件分组不是这里要看的：给一个空分组，正文只剩「没有插件」那句和配置记录
    groupPackPlugins: () => [], pluginRowHtml: () => '',
    removePack: (record) => { removed.push(JSON.parse(JSON.stringify(record))) },
    t: (text) => text, escapeHtml: (text) => String(text ?? ''),
  })
  new vm.Script(slice('    function renderPackView()', '    /** 删除的是整个 Profile')).runInContext(context)
  const show = (records) => {
    context.packState.packs = [{ profile: 'work', plugins: [], records }]
    list.buttons.clear()
    context.renderPackView()
    return list.querySelectorAll('[data-config-undo]')
  }
  const legacy = { name: 'old', displayName: '老整合包', version: '1.0.0', profile: 'work' }
  const config = { name: 'cfg', displayName: '配置包', version: '2.0.0', profile: 'work', configOnly: true }
  const desktop = { name: 'desktop-enhance', displayName: '桌面增强', synthetic: true }

  // 合成的桌面增强记录不算「最近一次」：配置记录仍是最后一条真实记录
  let buttons = show([legacy, config, desktop])
  assert.match(list.innerHTML, /导入过的配置/)
  assert.match(list.innerHTML, /配置包/)
  assert.deepEqual(buttons.map((button) => [button.dataset.configUndo, button.disabled]), [['cfg', false]], '只列配置记录，最近一条可撤')
  buttons[0].onclick()
  assert.deepEqual(removed, [config], '撤的就是这条记录（removePack 据它带上 configOnly）')

  buttons = show([config, legacy])
  assert.deepEqual(buttons.map((button) => [button.dataset.configUndo, button.disabled]), [['cfg', true]], '后面还装过别的：先撤后面那条')

  context.packBusy = true
  buttons = show([legacy, config])
  assert.equal(buttons[0].disabled, true, '正在忙时不能撤')
  context.packBusy = false
  context.pluginUpdating = 'dsh-x-sync'
  buttons = show([legacy, config])
  assert.equal(buttons[0].disabled, true, '正在更新插件时不能撤')
  context.pluginUpdating = ''

  show([legacy])
  assert.doesNotMatch(list.innerHTML, /导入过的配置|data-config-undo/, '没有配置记录就不画这一块')
})

test('撤销：先确认（点名包和 Profile，文案按记录种类分），取消不发请求；只导配置的记录带 configOnly: true，旧整包记录带 false', async () => {
  const posts = []
  const asked = []
  const notices = []
  let approved = false
  const context = vm.createContext({
    packBusy: false, renderPackGrid() {}, renderPackView() {}, applyPluginPayload() {},
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? '')),
    notify: (...args) => notices.push(args),
    appConfirm: async (message, options) => { asked.push([message, options?.title]); return approved },
    post: async (path, body) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return {} },
  })
  // 文案表声明在 removePack 正上方，一起抠出来
  new vm.Script(slice('    const UNDO_TEXT = Object.freeze(', '    async function exportEnvironment()')).runInContext(context)
  assert.equal(vm.runInContext('Object.isFrozen(UNDO_TEXT)', context), true, '文案表不许被改')
  const config = { name: 'cfg', displayName: '配置包', profile: 'work', configOnly: true }
  const legacy = { name: 'old', displayName: '老整合包', profile: 'work' }

  await context.removePack(config)
  await context.removePack(legacy)
  assert.deepEqual(posts, [], '取消就不撤（两种记录都一样）')
  assert.equal(asked.length, 2, '两种记录都要先确认')
  // 只导配置：说的是「写进 Profile 的配置」
  assert.ok(asked[0][0].startsWith('撤销 配置包 写进 Profile「work」的配置？'), asked[0][0])
  assert.equal(asked[0][1], '撤销配置导入')
  // 旧整包安装：说的是「整包安装」，package.json 也会还原
  assert.ok(asked[1][0].startsWith('撤销 老整合包 在 Profile「work」的整包安装？package.json 和配置文件将还原到安装前'), asked[1][0])
  assert.equal(asked[1][1], '撤销整包安装')

  approved = true
  await context.removePack(config)
  await context.removePack(legacy)
  assert.deepEqual(posts, [
    { path: '/api/packs/uninstall', body: { name: 'cfg', profile: 'work', configOnly: true, removeProfile: false } },
    { path: '/api/packs/uninstall', body: { name: 'old', profile: 'work', configOnly: false, removeProfile: false } },
  ], '服务端按名字 + Profile + configOnly 认记录')
  assert.deepEqual(notices.map(([message]) => message), [
    '已撤销 配置包 的配置导入，重启这个 Profile 的实例后生效。',
    '已撤销 老整合包 的整包安装，重启这个 Profile 的实例后生效。',
  ], '撤完的提示也按记录种类说')
  assert.equal(context.packBusy, false)
})

test('请求作用域：环境导入的检查和确认带上 Profile 页选的用户目录，其它环境接口不带', () => {
  const context = vm.createContext({ launchPluginScope: '', pluginHome: 'D:/工作', encodeURIComponent })
  new vm.Script(slice('    const scopedLaunchId =', '    const post =')).runInContext(context)
  const home = { 'x-dsh-home': encodeURIComponent('D:/工作') }
  const headers = (path) => JSON.parse(JSON.stringify(context.apiScopeHeaders(path)))
  // 可选的目标 Profile 列表（检查回的 profiles）和配置写入（确认导入）都跟着这个目录走
  assert.deepEqual(headers('/api/environments/import'), home)
  assert.deepEqual(headers('/api/environments/import/inspect'), home)
  // 环境本身不分目录
  for (const path of ['/api/environments', '/api/environments/export', '/api/environments/create', '/api/environments/importer']) {
    assert.deepEqual(headers(path), {}, `${path} 不带目录`)
  }
  assert.deepEqual(headers('/api/packs'), home, 'Profile 页自己的接口照旧')
  context.pluginHome = ''
  assert.deepEqual(headers('/api/environments/import'), {}, '没选目录就用默认目录')
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
  const context = { packBusy: false, pluginUpdating: '', pluginRemoving: '', pluginAdding: false, launchPluginScope: '', openedPack: null, pluginProfile: 'web', state: { profile: 'web' }, t: (s) => s,
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

test('从启动项弹窗删除最后一个 Profile 后关闭失效作用域', async () => {
  const calls = []
  const context = { packBusy: false, pluginUpdating: '', pluginRemoving: '', pluginAdding: false, launchPluginScope: 'isolated-entry',
    openedPack: { profile: 'web' }, pluginProfile: 'web', state: { profile: 'web' }, t: (s) => s,
    appConfirm: async () => true, renderPackGrid() {}, renderPackView() {}, notify() {},
    applyPluginPayload: (data) => { calls.push(['payload', data.packs.length]) },
    post: async () => ({ packs: [], profile: 'web' }),
    closeLaunchPlugins: async (options) => { calls.push(['close', options.afterDelete]); context.launchPluginScope = '' },
  }
  vm.runInNewContext(html.match(/    async function removeProfileDir\(item\) \{[\s\S]*?\n    \}/)[0], context)
  await context.removeProfileDir({ profile: 'web', pluginCount: 0 })
  assert.deepEqual(calls, [['payload', 0], ['close', true]])
  assert.equal(context.openedPack, null)
  assert.equal(context.packBusy, false)
})
