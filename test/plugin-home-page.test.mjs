import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const section = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)))

function panel() {
  const nodes = { pluginHome: {}, pluginHomeHint: {}, pluginHomesDialog: { hidden: true }, pluginHomesList: { querySelectorAll: () => [] }, pluginHomesAdd: {}, pluginHomesError: {}, pluginHomesClose: {} }
  const pending = []
  const context = vm.createContext({
    state: { dshHome: 'C:/global', profiles: ['web', 'global-only'], launchPresets: [
      { id: 'work', name: '工作', dshHome: 'D:/工作', profile: 'web' },
      { id: 'work2', name: '工作副本', dshHome: 'D:/工作', profile: 'bot' },
    ], instances: [] },
    pluginHome: '', pluginViewRevision: 0, pluginLoadRequest: 0, launchPluginScope: '', pluginLaunchEntry: null,
    pluginProfile: 'web', pluginUpdates: {}, pluginsLoaded: false, packBusy: false, pluginUpdating: '', pluginTogglePending: new Map(),
    openedPack: null, packState: { packs: [] }, packPluginListEl: { dataset: {} },
    packImportDialog: { hidden: true }, launchProfile: 'web',
    launchDialogEl: { hidden: true }, launchHomePicked: '',
    document: { getElementById: (id) => nodes[id] },
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''),
    escapeHtml: (text) => String(text ?? ''), syncUiSelect() {}, renderRecovery() {}, notify() {},
    renderPackGrid() {}, renderPackView() {}, refreshPluginUpdates: async () => {},
    getJson: (path) => new Promise((resolve, reject) => pending.push({ path, home: context.pluginTargetHome(), resolve, reject })),
  })
  vm.runInContext(section('    const pluginHomeEl =', "    const portEl ="), context)
  vm.runInContext(section('    function applyPluginPayload(data)', '    const recoveryHintEl ='), context)
  vm.runInContext(section('    function loadPlugins(', '    function pluginButtons()'), context)
  vm.runInContext(section('    const scopedLaunchId =', '    const post ='), context)
  return { context, nodes, pending }
}

test('目录选择去重；仅插件类请求跟随目录，显式全局与启动项作用域优先', () => {
  const { context: c, nodes } = panel()
  c.paintPluginHomes()
  // 两个启动项用同一个目录，只该出现一项；标签带路径后每个选项里有两处路径，所以按选项数数。
  assert.equal((nodes.pluginHome.innerHTML.match(/<option value="D:\/工作"/g) || []).length, 1)
  assert.match(nodes.pluginHome.innerHTML, /工作（D:\/工作）/, '选项带名字和路径')
  c.pluginHome = 'D:/工作'
  c.paintPluginHomes()
  assert.equal(nodes.pluginHomeHint.textContent, '使用目录：D:/工作')
  assert.equal(c.apiScopeHeaders('/api/plugins')['x-dsh-home'], encodeURIComponent('D:/工作'))
  assert.equal(Object.keys(c.apiScopeHeaders('/api/settings')).length, 0)
  assert.equal(Object.keys(c.apiScopeHeaders('/api/mcp')).length, 0)
  assert.equal(Object.keys(c.apiScopeHeaders('/api/plugins', { launchId: '' })).length, 0)
  c.launchPluginScope = 'work'
  assert.equal(c.apiScopeHeaders('/api/plugins')['x-dsh-launch-id'], 'work')
})

test('下拉中的管理目录入口打开弹窗，保持当前目录与插件列表且不发起切换请求', () => {
  const { context: c, nodes, pending } = panel()
  const opened = []
  c.showPackDialog = (dialog, focus) => { opened.push({ dialog, focus }) }
  for (const home of ['', 'D:/工作']) {
    c.pluginHome = home
    c.pluginProfile = 'web'
    c.packState = { packs: [{ profile: 'web' }], home: c.pluginTargetHome() }
    const packState = c.packState
    c.paintPluginHomes()
    assert.match(nodes.pluginHome.innerHTML, /管理目录…<\/option>$/)
    nodes.pluginHome.value = '__manage__'
    nodes.pluginHome.onchange()
    assert.equal(c.pluginHome, home)
    assert.equal(nodes.pluginHome.value, home)
    assert.equal(c.pluginProfile, 'web')
    assert.equal(c.packState, packState)
    assert.equal(nodes.pluginHomesError.hidden, true)
    assert.equal(opened.at(-1).dialog, nodes.pluginHomesDialog)
    assert.equal(opened.at(-1).focus, nodes.pluginHomesAdd)
    assert.equal(pending.length, 0)
  }
  c.packBusy = true
  nodes.pluginHome.value = '__manage__'
  nodes.pluginHome.onchange()
  assert.equal(opened.length, 2, '插件操作进行中不能从管理入口改目录')
  assert.equal(nodes.pluginHome.value, 'D:/工作')
})

test('切换同名 Profile 所属目录时清空旧列表；迟到的列表、错误和更新检查不能覆盖当前目录', async () => {
  const { context: c, nodes, pending } = panel()
  const global = c.loadPlugins({ checkUpdates: false })
  nodes.pluginHome.value = 'D:/工作'
  nodes.pluginHome.onchange()
  assert.equal(c.packState.packs.length, 0)
  assert.equal(c.pluginProfile, 'web')
  pending[1].resolve({ home: 'D:/工作', profiles: ['web', 'work-only'], packs: [{ profile: 'web', pluginCount: 2 }] })
  await new Promise(setImmediate)
  pending[0].resolve({ home: 'C:/global', profiles: ['web', 'global-only'], packs: [{ profile: 'global-only' }] })
  await global
  assert.equal(c.packState.home, 'D:/工作')
  assert.equal(c.packState.packs[0].profile, 'web')
  const notices = []
  c.notify = (message) => notices.push(message)
  vm.runInContext(section('    async function refreshPluginUpdates(', '    async function updatePlugin('), c)
  const updates = c.refreshPluginUpdates()
  const old = c.loadPlugins({ checkUpdates: false })
  nodes.pluginHome.value = ''
  nodes.pluginHome.onchange()
  pending[3].reject(new Error('old home error'))
  await old
  pending[2].resolve({ plugins: { otherHome: { hasUpdate: true } } })
  await updates
  assert.equal(Object.keys(c.pluginUpdates).length, 0)
  assert.deepEqual(notices, [])
  pending[4].resolve({ home: 'C:/global', profiles: ['web'], packs: [{ profile: 'web', pluginCount: 1 }] })
  await new Promise(setImmediate)
  assert.equal(c.packState.home, 'C:/global')
  assert.equal(c.packState.packs[0].pluginCount, 1)
})

test('删除最后一个 Profile 后保留目录选择；打开、关闭启动项弹窗会刷新对应目录', async () => {
  const { context: c, nodes } = panel()
  c.pluginHome = 'D:/工作'
  c.state.launchPresets = []
  c.applyPluginPayload({ home: 'D:/工作', profiles: [], packs: [] })
  c.paintPluginHomes()
  assert.match(nodes.pluginHome.innerHTML, /D:\/工作/)
  c.pluginLaunchEntry = { profile: 'web', dshHome: 'E:/other' }
  c.launchPluginScope = 'other-entry'
  c.packState = { home: 'D:/工作', packs: [{ profile: 'work-only' }] }
  c.resetPluginView()
  assert.equal(c.packState.packs.length, 0, '打开另一目录的弹窗时不展示同名旧数据')
  const calls = []
  Object.assign(c, {
    launchPluginsDialogEl: { hidden: false, dataset: {} }, launchPluginsCardEl: { classList: { remove() {} } },
    pluginPanelEl: {}, pluginDialogRequest: 1, pluginDialogLoading: false, pluginDialogOrigin: null,
    closeUiSelect() {}, hideDialog: async () => true, closePack() {}, launchAddEl: { focus() {} },
    loadPlugins: async () => { calls.push(c.pluginTargetHome()) },
  })
  nodes['pane-plugins'] = { append() {} }
  vm.runInContext(section('    async function closeLaunchPlugins(', "    document.getElementById('launchPluginsClose')"), c)
  await c.closeLaunchPlugins()
  assert.deepEqual(calls, ['D:/工作'], '关闭弹窗回到设置页先前选择的目录')
  assert.equal(c.launchPluginScope, '')
  assert.equal(c.packState.packs.length, 0)
})

test('登记目录进入下拉列表；添加取消、失败和移除当前目录不会留下错误状态', async () => {
  const { context: c, nodes } = panel()
  c.state.dshHomes = ['E:/saved']
  nodes.pluginHomesDialog.hidden = false
  c.paintPluginHomes()
  assert.match(nodes.pluginHome.innerHTML, /E:\/saved/)
  const calls = []
  c.post = async (path) => { calls.push(path); return { path: '' } }
  await c.changePluginHomeList('add')
  assert.deepEqual(calls, ['/api/pick-dir'])
  assert.equal(nodes.pluginHomesAdd.disabled, false)
  c.post = async () => { throw new Error('picker failure') }
  await c.changePluginHomeList('add')
  assert.equal(nodes.pluginHomesError.textContent, 'picker failure')
  assert.equal(nodes.pluginHomesError.hidden, false)
  c.post = async (path, body) => path === '/api/pick-dir' ? { path: 'E:/新目录' } : { dshHomes: ['E:/saved', body.home] }
  await c.changePluginHomeList('add')
  assert.match(nodes.pluginHome.innerHTML, /E:\/新目录/)
  assert.equal(nodes.pluginHomesError.hidden, true)
  c.pluginHome = 'E:/saved'
  c.post = async () => ({ dshHomes: [] })
  c.loadPlugins = async () => {}
  await c.changePluginHomeList('remove', 'E:/saved')
  assert.equal(c.pluginHome, '')
  assert.equal(nodes.pluginHome.disabled, false)
  assert.doesNotMatch(nodes.pluginHome.innerHTML, /E:\/saved/)
})

test('点击目录打开对应路径，不切换环境；重复点击与失败会正确恢复状态', async () => {
  const { context: c, nodes } = panel()
  c.pluginHome = 'D:/工作'
  const button = { disabled: false, dataset: { homeOpen: 'E:/中文目录 with spaces' } }
  const calls = []
  let finish
  c.post = (path, body) => { calls.push({ path, home: body.home }); return new Promise((resolve) => { finish = resolve }) }
  const opening = c.openPluginHome(button)
  await c.openPluginHome(button)
  assert.equal(button.disabled, true)
  assert.deepEqual(calls, [{ path: '/api/dsh-homes/open', home: 'E:/中文目录 with spaces' }])
  finish({ ok: true })
  await opening
  assert.equal(button.disabled, false)
  assert.equal(c.pluginHome, 'D:/工作')
  c.post = async () => { throw new Error('目录不存在或已被移动') }
  await c.openPluginHome(button)
  assert.equal(nodes.pluginHomesError.hidden, false)
  assert.equal(nodes.pluginHomesError.textContent, '目录不存在或已被移动')
  assert.equal(button.disabled, false)
})
