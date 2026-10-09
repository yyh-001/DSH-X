import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const section = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)))
const homes = section('    function paintLaunchHomePath()', '    function allVersionList()')
// 目录下拉的候选列表和「环境」页共用一份实现，一起装进沙箱。
const homeList = section('    function homeOptions(current)', '    function paintPluginHomes()')
const recovery = section('    function recoveryOptions()', '    function renderRecovery()')
const save = section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async')

function editor(getJson = async () => ({ home: 'D:/isolated', profiles: ['web'], webProfiles: ['web'] })) {
  const calls = []
  const elements = { launchRecover: {}, launchDshHomeTrigger: {} }
  const context = vm.createContext({
    launchDshHomeEl: { value: '' },
    launchProfileEl: {}, launchProfile: 'web', launchDialogEl: { hidden: false }, launchDialogRevision: 1,
    editingLaunchId: 'work', launchPluginScope: '', editorRecovery: null, recoveryHintEl: {},
    state: { dshHome: 'C:/global', profile: 'web', profiles: ['web'], webProfiles: ['web'], dshHomes: [], dshHomeNames: {},
      launchPresets: [{ id: 'work', profile: 'web', dshHome: 'D:/isolated' }] },
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''),
    escapeHtml: (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    document: { getElementById: (id) => elements[id] },
    syncUiSelect() {}, renderRecovery() {}, loadRecovery() {}, notify: (text) => calls.push(text),
    getJson, post: async (...args) => { calls.push(args); return {} },
    launchEntries: () => context.state.launchPresets,
    PLUGIN_HOME_MANAGE: '__manage__', openPluginHomesDialog() {},
  })
  vm.runInContext(homeList + recovery + homes, context)
  return { context, elements, calls }
}

test('目录下拉：第一项是沿用全局目录，已保存的独立目录仍留在选项里', () => {
  const { context: c, elements } = editor()
  c.paintLaunchHomes('D:/isolated')
  assert.equal(c.launchDshHomeEl.value, 'D:/isolated')
  assert.equal(elements.launchDshHomeTrigger.title, 'D:/isolated', '完整路径挂在触发器上')
  assert.match(c.launchDshHomeEl.innerHTML, /<option value="">沿用全局目录（C:\/global）<\/option>/, '空值项写清继承的是哪个目录')
  assert.match(c.launchDshHomeEl.innerHTML, /<option value="D:\/isolated">D:\/isolated<\/option>/, '启动项自己的目录不能从列表里消失')
  assert.equal(elements.launchRecover.disabled, false)
  assert.equal(c.recoveryOptions().launchId, 'work')
  c.state.dshHomeNames = { 'D:/isolated': '独立工作' }
  c.paintLaunchHomes('D:/isolated')
  assert.match(c.launchDshHomeEl.innerHTML, /独立工作（D:\/isolated）/, '命名过的目录带上名字')
  c.paintLaunchHomes('D:/new-draft')
  assert.equal(elements.launchRecover.disabled, true)
  assert.equal(c.recoveryOptions(), null, '未保存的独立目录不能误修全局 Profile')
  c.paintLaunchHomes('')
  assert.equal(c.launchDshHomeEl.value, '')
  assert.equal(elements.launchDshHomeTrigger.title, 'C:/global')
  assert.equal(c.recoveryOptions().launchId, '')
})

test('目录的迟到响应不能覆盖另一次选择，目录检查后按新目录刷新 Profile', async () => {
  let resolve
  const { context: c } = editor(() => new Promise((done) => { resolve = done }))
  c.launchDshHomeEl.value = 'D:/old'
  const pending = c.refreshLaunchHomeProfiles(true)
  c.paintLaunchHomes('D:/new')
  resolve({ home: 'D:/old', profiles: ['old-profile'], webProfiles: ['old-profile'] })
  assert.equal(await pending, false)
  assert.equal(c.launchDshHomeEl.value, 'D:/new')
  assert.equal(c.state.profilesByHome, undefined)
  c.getJson = async () => ({ home: 'D:/new', profiles: ['web'], webProfiles: ['web'] })
  c.launchProfile = 'old-profile'
  assert.equal(await c.refreshLaunchHomeProfiles(true), true)
  assert.equal(c.launchProfile, 'web')
  assert.deepEqual(Array.from(c.state.profilesByHome['D:/new']), ['web'])
})

test('目录字段是环境页那套下拉，浏览与恢复两个按钮都不在了', () => {
  const field = section('<label for="launchDshHome"', '<div class="home-pickers">')
  assert.match(field, /dsh 用户目录（会话、记忆和插件隔离）/)
  assert.match(field, /<select id="launchDshHome"[^>]*><\/select>/)
  assert.doesNotMatch(field, /launchPickHome|launchResetHome|readonly/)
  assert.doesNotMatch(field, /<p(?:\s|>)|<datalist|浏览…/)
  // 原生 select 得接进自绘那套，否则点开的是系统菜单。
  assert.match(page, /querySelectorAll\('#launchDshHome, #launchProfile, #pluginHome/)
})

test('下拉末项是管理目录：选中它只开弹窗，不会把占位值当成目录', () => {
  const { context: c } = editor()
  let opened = 0
  c.openPluginHomesDialog = () => { opened += 1 }
  c.paintLaunchHomes('D:/isolated')
  assert.match(c.launchDshHomeEl.innerHTML, new RegExp(`<option value="${c.PLUGIN_HOME_MANAGE}">管理目录…</option>$`))
  c.launchDshHomeEl.value = c.PLUGIN_HOME_MANAGE
  c.launchDshHomeEl.onchange()
  assert.equal(opened, 1, '管理入口打开目录管理弹窗')
  assert.equal(c.launchDshHomeEl.value, 'D:/isolated', '关掉弹窗后还是原来选的那个目录')
})

test('环境页目录有增删时，启动项下拉跟着重铺', async () => {
  const { context: c } = editor()
  Object.assign(c, { pluginHomesBusy: false, packBusy: false, pluginUpdating: '', pluginTogglePending: new Map(),
    pluginHome: '', pluginHomesErrorEl: { hidden: true }, paintPluginHomes() {}, pluginTargetHome: () => 'C:/global',
    resetPluginView() {}, renderPackGrid() {}, renderPackView() {}, loadPlugins() {} })
  vm.runInContext(section('    async function changePluginHomeList(', '    pluginHomesAddEl.onclick'), c)
  c.paintLaunchHomes('D:/isolated')
  c.post = async (url) => url === '/api/pick-dir' ? { path: 'E:/新目录' } : { dshHomes: ['D:/isolated', 'E:/新目录'] }
  await c.changePluginHomeList('add')
  assert.match(c.launchDshHomeEl.innerHTML, /E:\/新目录/, '新登记的目录立刻能选')
  assert.equal(c.launchDshHomeEl.value, 'D:/isolated', '重铺选项不能改掉当前选择')
})

test('换目录走下拉的 change，拉回新目录的 Profile', async () => {
  const { context: c } = editor()
  c.paintLaunchHomes('')
  assert.equal(c.launchDshHomeEl.value, '', '空值仍表示沿用全局目录')
  assert.equal(typeof c.launchDshHomeEl.onchange, 'function', '下拉接上了目录切换')
  c.launchDshHomeEl.value = 'D:/isolated'
  assert.equal(await c.refreshLaunchHomeProfiles(true), true)
  assert.deepEqual(Array.from(c.state.profilesByHome['D:/isolated']), ['web'])
  assert.equal(c.launchDshHomeEl.value, 'D:/isolated', '服务端规范化后的路径要写回下拉')
})

test('独立目录的恢复提示不受全局状态推送覆盖，空作用域能明确回到全局目录', () => {
  const { context: c } = editor()
  c.launchDshHomeEl.value = 'D:/isolated'
  c.editorRecovery = { home: 'D:/isolated', data: { profile: 'web', last: { dropped: ['independent-plugin'] } } }
  c.state.recovery = { profile: 'web', last: { dropped: ['global-a', 'global-b'] } }
  Object.assign(c, { packBusy: false, installedList: () => [],
    escapeHtml: (text) => String(text), launchPluginScope: 'work' })
  vm.runInContext(section('    function renderRecovery()', '    async function restoreRecovery('), c)
  c.renderRecovery()
  assert.match(c.recoveryHintEl.innerHTML, /停用第三方插件 1 个/)
  c.launchDshHomeEl.value = ''
  c.renderRecovery()
  assert.equal(c.recoveryHintEl.hidden, true, '切换目录后不沿用另一份目录的恢复档')
  vm.runInContext(section('    const scopedLaunchId =', '    const post ='), c)
  assert.equal(vm.runInContext("scopedLaunchId('/api/recover', '')", c), '')
  assert.equal(vm.runInContext("scopedLaunchId('/api/recover')", c), 'work')
})

test('直接回车保存也先检查新目录；坏路径不落盘，不改全局目录', async () => {
  for (const invalid of [false, true]) {
    const { context: c, calls } = editor(async () => {
      if (invalid) throw new Error('请使用绝对路径')
      return { home: 'D:/isolated', profiles: ['web'], webProfiles: ['web'] }
    })
    Object.assign(c, {
      launchFormEl: {}, launchSaveEl: { disabled: false }, launchNameEl: { value: '独立工作' },
      launchIcon: 'terminal', versionValue: 'auto', launchPortEl: { value: '' },
      closeLaunchEditor() {}, render() {},
    })
    c.launchDshHomeEl.value = invalid ? './bad' : 'D:/isolated'
    c.post = async (path, body) => { calls.push([path, body]); return { entry: { ...body, id: 'work' } } }
    vm.runInContext(save, c)
    await c.launchFormEl.onsubmit({ preventDefault() {} })
    const writes = calls.filter(Array.isArray)
    assert.equal(writes.length, invalid ? 0 : 1)
    if (!invalid) {
      assert.equal(writes[0][0], '/api/launch-presets')
      assert.equal(writes[0][1].dshHome, 'D:/isolated')
      assert.equal(writes[0][1].profile, 'web')
    }
    assert.equal(c.state.dshHome, 'C:/global')
    assert.equal(c.launchSaveEl.disabled, false)
  }
})

test('环境修复和重启带启动项作用域，仅重启对应目录的实例', async () => {
  const { context: c, calls } = editor()
  Object.assign(c, { packBusy: false, recoveryHintEl: {}, appConfirm: async () => true,
    renderPackView() {}, loadPlugins() {}, selected: () => 'auto', installedList: () => ['1.0.0'],
    resolveLaunchVersion: () => '1.0.0' })
  c.launchDshHomeEl.value = 'D:/isolated'
  c.state.instances = [
    { version: '1.0.0', profile: 'web', home: 'D:/isolated' },
    { version: '2.0.0', profile: 'web', home: 'C:/global' },
  ]
  c.post = async (...args) => { calls.push(args); return { recovery: {} } }
  // 请求结果验证以服务端多目录用例为准；这里只执行页面动作，确认它把正确作用域传过去。
  c.loadRecovery = async () => {}
  vm.runInContext(section('    async function repairEnvironment(profile)', '    async function togglePlugin('), c)
  await c.repairEnvironment('web')
  assert.equal(calls[0][0], '/api/recover')
  assert.equal(calls[0][2].launchId, 'work')
  calls.length = 0
  await c.restartEnvironment('web')
  assert.deepEqual(calls.map(([url, body, options]) => [url, body.version, options.launchId]), [
    ['/api/stop', '1.0.0', 'work'], ['/api/start', '1.0.0', 'work'],
  ])
})
