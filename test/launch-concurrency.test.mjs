import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const keys = page.slice(page.indexOf('    const launchActions ='), page.indexOf('    let launchHomeMarkup ='))
const actions = page.slice(page.indexOf('    async function runLaunchAction('), page.indexOf('    /** 升级到最新版'))
const manage = page.slice(page.indexOf('    async function manageLaunchEntry('), page.indexOf('    let launchDialogRevision'))
const paint = page.slice(page.indexOf('    function paintLaunchHome('), page.indexOf('    async function manageLaunchEntry('))
const lookup = page.slice(page.indexOf('    function runningInfo('), page.indexOf('    /**\n     * DSH_HOME'))

function ui({ installed = ['0.1.0'], instances = [], homes = false } = {}) {
  const entries = [
    { id: 'a', name: 'Web', version: '0.1.0', profile: 'web', port: 0 },
    { id: 'b', name: 'Work', version: '0.1.0', profile: homes ? 'web' : 'work', port: 0, ...(homes ? { dshHome: 'other-home' } : {}) },
  ]
  const calls = [], notices = [], list = { innerHTML: '', querySelectorAll: () => [], insertAdjacentElement() {} }
  const context = vm.createContext({
    state: { dshHome: 'home', instances, installed, launchPresets: entries, installing: null }, action: '', launchProfile: 'web',
    launchEntries: () => entries, installedList: () => installed, resolveLaunchVersion: (entry) => entry.version,
    render() {}, openInstance: async () => {}, notify: (message) => notices.push(message),
    post(path, body, scope) {
      if (path === '/api/instance-port') return Promise.resolve({})
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      calls.push({ path, body, scope, resolve, reject })
      return promise
    },
    launchDialogEl: { hidden: true }, launchSaveEl: { disabled: false }, launchDeleteEl: { disabled: false }, launchDialogClosing: false,
    launchPresetsEl: list, launchHomeMarkup: '', launchAddEl: { hidden: true, disabled: false, focus() {} },
    DEFAULT_LAUNCH_ID: 'a', latestRemoteVersion: () => '0.1.0', compareVersion: () => 0,
    launchIconMarkup: () => '<svg></svg>', escapeHtml: (value) => String(value || ''), t: (value) => value,
    document: { activeElement: null },
  })
  vm.runInContext(keys + lookup + actions + manage + paint, context)
  return {
    context, calls, notices, entries, list,
    tasks: () => vm.runInContext('launchActions.size', context),
    phase: (id) => vm.runInContext(`launchActions.get(launchActionKey('0.1.0', '${entries.find((entry) => entry.id === id).profile}', '${id}'))?.phase`, context),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('不同环境同时发起启动，一个结束不会解锁或清空另一个的进度', async () => {
  const h = ui()
  const first = h.context.startVersion('0.1.0', 'web', 0, 'a')
  const second = h.context.startVersion('0.1.0', 'work', 0, 'b')
  await flush()
  assert.equal(h.calls.length, 2)
  assert.equal(h.tasks(), 2)
  h.calls[0].resolve({})
  await first
  assert.equal(h.tasks(), 1)
  assert.equal(h.phase('b'), 'start')
  assert.equal(h.context.action, '', '启动任务不占用全局锁')
  h.calls[1].resolve({})
  await second
  assert.equal(h.tasks(), 0)
})

test('同一实例重复点不会提交第二个请求，不同用户目录可同时启动', async () => {
  const h = ui({ homes: true })
  const first = h.context.startVersion('0.1.0', 'web', null, 'a')
  await h.context.startVersion('0.1.0', 'web', null, 'a')
  const second = h.context.startVersion('0.1.0', 'web', null, 'b')
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls.map((call) => call.scope.launchId), ['a', 'b'])
  h.calls.forEach((call) => call.resolve({}))
  await Promise.all([first, second])
})

test('自动版本解析改变时，仍保留同一个启动项的操作锁', async () => {
  const h = ui({ installed: ['0.1.0', '0.2.0'] })
  const first = h.context.startVersion('0.1.0', 'web', null, 'a')
  h.entries[0].version = '0.2.0'
  await h.context.startVersion('0.2.0', 'web', null, 'a')
  h.context.paintLaunchHome()
  assert.equal(h.calls.length, 1)
  assert.match(h.list.innerHTML, /data-launch-id="a"[^>]*disabled/)
  h.calls[0].resolve({})
  await first
})

test('一个环境启动失败只清理自己的锁，另一个继续启动', async () => {
  const h = ui()
  const first = h.context.startVersion('0.1.0', 'web', null, 'a')
  const failure = assert.rejects(first, /失败/)
  const second = h.context.startVersion('0.1.0', 'work', null, 'b')
  h.calls[0].reject(new Error('失败'))
  await failure
  assert.equal(h.phase('b'), 'start')
  h.calls[1].resolve({})
  await second
  assert.equal(h.tasks(), 0)
})

test('首次使用同一版本的多个环境共用一次安装，随后各自启动', async () => {
  const h = ui({ installed: [] })
  const first = h.context.startVersion('0.1.0', 'web', null, 'a')
  const second = h.context.startVersion('0.1.0', 'work', null, 'b')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, '/api/install')
  h.calls[0].resolve({})
  await flush()
  assert.equal(h.calls.filter((call) => call.path === '/api/start').length, 2)
  h.calls.slice(1).forEach((call) => call.resolve({}))
  await Promise.all([first, second])
})

test('界面只锁住忙碌项，运行时添加、编辑和其他环境启动可用', async () => {
  const h = ui({ instances: [{ version: '0.1.0', profile: 'web', home: 'home', status: 'running', url: 'http://local' }] })
  h.context.paintLaunchHome()
  assert.equal(h.context.launchAddEl.disabled, false)
  assert.doesNotMatch(h.list.innerHTML, /data-edit-id="a"[^>]*disabled/)
  const starting = h.context.startVersion('0.1.0', 'work', null, 'b')
  h.context.paintLaunchHome()
  assert.doesNotMatch(h.list.innerHTML, /data-launch-id="a"[^>]*disabled/)
  assert.match(h.list.innerHTML, /data-launch-id="b"[^>]*disabled/)
  assert.equal(h.context.launchAddEl.disabled, false)
  h.calls[0].resolve({})
  await starting
})

test('停止一个环境时，另一环境仍可启动，停止中实例不会被当成空闲', async () => {
  const h = ui({ instances: [{ version: '0.1.0', profile: 'web', home: 'home', status: 'running' }] })
  const stopping = h.context.manageLaunchEntry('a', false)
  const starting = h.context.startVersion('0.1.0', 'work', null, 'b')
  assert.deepEqual(h.calls.map((call) => call.path), ['/api/stop', '/api/start'])
  h.calls[0].resolve({})
  await stopping
  assert.equal(h.phase('b'), 'start')
  h.context.state.instances[0].status = 'stopping'
  assert.equal(h.context.runningInfo('0.1.0', 'web', 'home').status, 'stopping')
  h.calls[1].resolve({})
  await starting
})
