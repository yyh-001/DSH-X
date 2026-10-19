import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const installCode = html.slice(html.indexOf('    async function manualInstallVersion('), html.indexOf('    function paintVersionManager('))
const paintCode = html.slice(html.indexOf('    function paintVersionManager('), html.indexOf('    manageVersionsEl.onclick ='))

const resetCode = html.slice(html.indexOf('    function resetVersionCheck('), html.indexOf('    /** 检测结果说人话'))
const uninstallCode = html.slice(html.indexOf('    async function uninstallVersion('), html.indexOf('    function openLaunchEditor('))
const translate = (text, vars = {}) => Object.entries(vars).reduce((out, [key, value]) => out.split(`{${key}}`).join(String(value)), text)

function installer(overrides = {}) {
  const calls = [], notices = []
  const context = vm.createContext({
    action: '', state: { installing: null }, picked: '0.1.0', versionValue: '0.1.0', launchProfile: 'safe', userPicked: true,
    installedList: () => ['0.1.0'], render() {}, runningInfo: () => null, isManagedVersion: () => true,
    t: translate, versionCheckSeq: 0, versionCheck: {}, appConfirm: async () => true,
    post: async (path, body) => { calls.push({ path, version: body.version }) },
    getJson: async (path) => { calls.push({ path }); return { installed: ['0.1.0', '0.2.0'] } },
    applyState: (data) => { context.receivedState = data },
    notify: (message) => notices.push(message), ...overrides,
  })
  vm.runInContext(resetCode + installCode + uninstallCode, context)
  return { context, calls, notices }
}

test('手动安装只下载所选版本，不启动或停止实例，不改编辑器草稿', async () => {
  const { context, calls } = installer()
  await context.manualInstallVersion('0.2.0')
  assert.deepEqual(calls, [{ path: '/api/install', version: '0.2.0' }, { path: '/api/state' }])
  assert.deepEqual(context.receivedState.installed, ['0.1.0', '0.2.0'])
  assert.equal(context.picked, '0.1.0')
  assert.equal(context.versionValue, '0.1.0')
  assert.equal(context.launchProfile, 'safe')
  assert.equal(context.userPicked, true)
  assert.equal(context.action, '')
})

test('已装版本、空版本与其他任务进行中不会重复安装', async () => {
  const { context, calls } = installer()
  await context.manualInstallVersion('0.1.0')
  await context.manualInstallVersion('')
  context.action = 'uninstall'
  await context.manualInstallVersion('0.2.0')
  context.action = ''
  context.state.installing = '0.3.0'
  await context.manualInstallVersion('0.2.0')
  assert.deepEqual(calls, [])
})

test('安装失败保留具体错误并解除操作锁', async () => {
  const { context, calls, notices } = installer({ post: async () => { throw new Error('目录没有写入权限') } })
  await context.manualInstallVersion('0.2.0')
  assert.deepEqual(notices, ['目录没有写入权限'])
  assert.deepEqual(calls, [], '失败后不刷新成已安装状态')
  assert.equal(context.action, '')
})

test('手动优化只整理所选版本，不改变启动项选择，成功和失败均释放操作状态', async () => {
  const { context, calls, notices } = installer()
  await context.optimizeVersion('0.1.0')
  assert.deepEqual(calls, [{ path: '/api/versions/optimize', version: '0.1.0' }, { path: '/api/state' }])
  assert.equal(context.picked, '0.1.0')
  assert.equal(context.launchProfile, 'safe')
  assert.equal(context.action, '')
  assert.deepEqual(notices, ['依赖优化完成'])
  context.post = async () => { throw new Error('离线缓存缺失') }
  await context.optimizeVersion('0.1.0')
  assert.equal(context.action, '')
  assert.equal(notices.at(-1), '离线缓存缺失')
  context.runningInfo = () => ({ status: 'running' })
  const count = notices.length
  await context.optimizeVersion('0.1.0')
  assert.equal(notices.length, count)
})

test('运行中或停止中的任一实例都会锁住对应版本的卸载，安装列表排除已装版本', () => {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', innerHTML: '', disabled: false, attrs: {},
        classList: { toggle() {} },
        setAttribute(name, value) { this.attrs[name] = value },
        querySelectorAll: () => [],
      })
    }
    return elements.get(id)
  }
  const context = vm.createContext({
    state: { instances: [{ version: '0.2.0', profile: 'safe', status: 'running' }, { version: '0.1.0', profile: 'web', status: 'stopping' }] },
    action: '', remote: { versions: ['0.3.0', '0.2.0', '0.1.0'] }, installProgress: null,
    versionCheck: { busy: false, message: '', error: '' },
    versionManageMarkup: '', versionInstallOptions: '', versionInstallSelectEl: element('select'),
    installedList: () => ['0.1.0', '0.2.0'], latestRemoteVersion: () => '0.3.0', allVersionList: () => ['0.3.0', '0.2.0', '0.1.0'],
    compareVersion: (a, b) => a.localeCompare(b), runningInfo: () => null, versionNames: (values) => values,
    t: (text) => text, escapeHtml: (text) => String(text), syncUiSelect() {}, paintProgress() {},
    document: { getElementById: element },
  })
  vm.runInContext(paintCode, context)
  context.paintVersionManager()
  assert.match(element('versionManageList').innerHTML, /data-remove-version="0\.2\.0"[^>]*disabled/)
  assert.match(element('versionManageList').innerHTML, /data-remove-version="0\.1\.0"[^>]*disabled/)
  assert.match(element('versionManageList').innerHTML, /data-optimize-version="0\.2\.0"[^>]*disabled/)
  assert.match(element('versionManageList').innerHTML, /data-optimize-version="0\.1\.0"[^>]*disabled/)
  assert.match(element('select').innerHTML, /value="0\.3\.0"/)
  assert.doesNotMatch(element('select').innerHTML, /value="0\.[12]\.0"/)
  context.state.instances = []
  context.paintVersionManager()
  assert.doesNotMatch(element('versionManageList').innerHTML, /disabled/)
})

test('检测版本的入口、结果提示与缓存绕过都在版本管理里', () => {
  // 用户要的是「不用重启也能发现新版本」，所以入口得在版本管理里、结果要看得见
  assert.match(html, /id="versionManageCheck"[^>]*data-i18n-title="检测版本"/, '版本管理标题栏里有检测按钮')
  assert.match(html, /document\.getElementById\('versionManageCheck'\)\.onclick = \(\) => \{ void checkVersions\(\{ force: true \}\) \}/, '点检测强制绕缓存')
  assert.match(html, /versionCheck\.busy \? t\('正在检测版本…'\)/, '检测中提示行有反馈')
  assert.match(html, /versionCheck\.error \|\| versionCheck\.message/, '检测结果画在提示行里')
  assert.match(html, /void checkVersions\(\{ force: false, quiet: true \}\)/, '打开版本管理时静默刷新一次')
})

function checkCode() {
  // 从 describeVersionCheck 开始切，不含 `let versionCheck`：这样测试里的赋值落到沙箱属性上，
  // 能直接断言检测结果（与页面里它是个模块级变量等价）
  return html.slice(html.indexOf('    function describeVersionCheck('), html.indexOf('    async function manualInstallVersion('))
}

test('检测版本：强制绕缓存、更新本地版本列表并给出结果', async () => {
  const calls = []
  const payload = {
    tags: { latest: '0.3.0' }, versions: ['0.3.0', '0.1.0'], latest: '0.3.0',
    installed: ['0.1.0'], current: '0.1.0', update: true,
    self: { current: '0.1.17', latest: '0.1.18', update: true },
  }
  const context = vm.createContext({
    versionCheck: { busy: false, message: '', error: '' }, versionCheckSeq: 0,
    remote: { tags: {}, versions: ['0.1.0'], latest: '0.1.0' },
    t: translate,
    getJson: async (url) => { calls.push(url); return url.startsWith('/api/self') ? payload.self : payload },
    applySelfUpdate() { context.selfApplied = true },
    render() { context.rendered = true },
    paintVersionManager() {},
  })
  vm.runInContext(checkCode(), context)
  await vm.runInContext("checkVersions({ force: true })", context)
  assert.deepEqual(calls, ['/api/versions/check?refresh=1', '/api/self?refresh=1'])
  assert.equal(context.remote.latest, '0.3.0', '本地版本列表换成新拉的')
  assert.equal(context.remote.versions[0], '0.3.0')
  assert.match(context.versionCheck.message, /发现新版本 0\.3\.0/, '结果要有话说')
  assert.match(context.versionCheck.message, /启动器也有新版本 0\.1\.18/)
  assert.equal(context.versionCheck.busy, false, '检测结束要收起转圈')
  assert.ok(context.rendered && context.selfApplied)
})

test('检测已是最新时不说新版本；静默刷新只在新版本出现时才留话', async () => {
  const context = vm.createContext({
    versionCheck: { busy: false, message: '旧的', error: '旧的' }, versionCheckSeq: 0,
    remote: { tags: {}, versions: [], latest: '' },
    t: translate,
    getJson: async (url) => url.startsWith('/api/self') ? {} : ({
      tags: {}, versions: ['0.1.0'], latest: '0.1.0',
      installed: ['0.1.0'], current: '0.1.0', update: false,
      self: { current: '0.1.17', latest: '', update: false },
    }),
    applySelfUpdate() { context.selfApplied = true },
    render() {}, paintVersionManager() {},
  })
  vm.runInContext(checkCode(), context)
  await vm.runInContext("checkVersions({ force: true })", context)
  assert.match(context.versionCheck.message, /已是最新版本（0\.1\.0）/, '主动检测要说清已是最新')
  assert.equal(context.selfApplied, undefined, '启动器没新版本时不重复同步按钮')
  // 静默刷新（打开版本管理那一下）只更新列表，不写一句「已是最新」
  await vm.runInContext("checkVersions({ force: false, quiet: true })", context)
  assert.equal(context.versionCheck.message, '')
})

test('检测失败要如实报错；静默刷新失败不打扰', async () => {
  const failing = () => { throw new Error('连不上 registry') }
  const context = vm.createContext({
    versionCheck: { busy: false, message: '', error: '' }, versionCheckSeq: 0,
    remote: { tags: {}, versions: [], latest: '' },
    t: translate,
    getJson: async () => failing(),
    applySelfUpdate() {}, render() {}, paintVersionManager() {},
  })
  vm.runInContext(checkCode(), context)
  await vm.runInContext("checkVersions({ force: true })", context)
  assert.equal(context.versionCheck.message, '')
  assert.match(context.versionCheck.error, /检测版本失败：连不上 registry/)
  await vm.runInContext("checkVersions({ force: false, quiet: true })", context)
  assert.equal(context.versionCheck.error, '', '静默刷新失败不该留在界面上')
})

test('安装、优化和卸载会使在途静默检测作废，不留下过期的更新提示', async () => {
  for (const [method, version] of [['manualInstallVersion', '0.2.0'], ['optimizeVersion', '0.1.0'], ['uninstallVersion', '0.1.0']]) {
    let finish
    const { context } = installer({
      remote: { latest: '0.1.0' }, paintVersionManager() {}, applySelfUpdate() {},
      getJson: (url) => url.startsWith('/api/versions/check')
        ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ installed: ['0.2.0'] }),
    })
    vm.runInContext(checkCode(), context)
    const checking = context.checkVersions({ force: false, quiet: true })
    await context[method](version)
    finish({ latest: '0.2.0', current: '0.1.0', update: true, versions: ['0.2.0'] })
    await checking
    assert.equal(context.versionCheck.message, '', method)
    assert.equal(context.remote.latest, '0.1.0', '过期响应也不能换回旧的版本列表')
  }
})

test('GitHub 检查在途时已解除检测忙态；后到的启动器结果不能覆盖新的操作', async () => {
  let finishSelf
  const { context } = installer({
    remote: {}, paintVersionManager() {}, applySelfUpdate() { context.selfApplied = true },
    getJson: (url) => url.startsWith('/api/self') ? new Promise(resolve => { finishSelf = resolve })
      : Promise.resolve({ latest: '0.2.0', current: '0.1.0', update: true, versions: ['0.2.0'] }),
  })
  vm.runInContext(checkCode(), context)
  await context.checkVersions()
  assert.equal(context.versionCheck.busy, false, 'GitHub 尚未返回也能继续安装')
  assert.match(context.versionCheck.message, /发现新版本/)
  await context.manualInstallVersion('0.2.0')
  finishSelf({ latest: '99.0.0', update: true })
  await Promise.resolve()
  assert.equal(context.versionCheck.message, '')
  assert.equal(context.selfApplied, undefined)
})

test('检测按所跟通道提示，安装列表仍保留更高的 Alpha', async () => {
  const { context } = installer({ remote: {}, paintVersionManager() {}, applySelfUpdate() {} })
  vm.runInContext(checkCode(), context)
  const message = context.describeVersionCheck({ latest: '2.0.0-alpha.1', updateLatest: '1.2.0', current: '1.1.0', update: true })
  assert.match(message, /发现新版本 1\.2\.0/)
  assert.doesNotMatch(message, /alpha/)
})
