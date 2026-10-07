import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const installCode = html.slice(html.indexOf('    async function manualInstallVersion('), html.indexOf('    function paintVersionManager('))
const paintCode = html.slice(html.indexOf('    function paintVersionManager('), html.indexOf('    manageVersionsEl.onclick ='))

function installer(overrides = {}) {
  const calls = [], notices = []
  const context = vm.createContext({
    action: '', state: { installing: null }, picked: '0.1.0', versionValue: '0.1.0', launchProfile: 'safe', userPicked: true,
    installedList: () => ['0.1.0'], render() {},
    post: async (path, body) => { calls.push({ path, version: body.version }) },
    getJson: async (path) => { calls.push({ path }); return { installed: ['0.1.0', '0.2.0'] } },
    applyState: (data) => { context.receivedState = data },
    notify: (message) => notices.push(message), ...overrides,
  })
  vm.runInContext(installCode, context)
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

test('运行中或停止中的任一实例都会锁住对应版本的卸载，安装列表排除已装版本', () => {
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', querySelectorAll: () => [] })
    return elements.get(id)
  }
  const context = vm.createContext({
    state: { instances: [{ version: '0.2.0', profile: 'safe', status: 'running' }, { version: '0.1.0', profile: 'web', status: 'stopping' }] },
    action: '', remote: { versions: ['0.3.0', '0.2.0', '0.1.0'] }, installProgress: null,
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
  assert.match(element('select').innerHTML, /value="0\.3\.0"/)
  assert.doesNotMatch(element('select').innerHTML, /value="0\.[12]\.0"/)
  context.state.instances = []
  context.paintVersionManager()
  assert.doesNotMatch(element('versionManageList').innerHTML, /disabled/)
})
