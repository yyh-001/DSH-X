import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { shellRelaunchOptions } from '../shell/relaunch.mjs'
import { tabDragSupported } from '../shell/tab-detach.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const wayland = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' }

test('主入口不再自动切换 XWayland；单实例锁与普通重启保留用户参数', async () => {
  const source = read('shell/main.mjs')
  assert.doesNotMatch(source, /restartLinuxBackend|restartingBackend/)
  const branch = source.slice(source.indexOf('if (!app.requestSingleInstanceLock())'), source.indexOf('function managerUrl()'))
  for (const lock of [false, true]) {
    const calls = []
    const app = { requestSingleInstanceLock() { calls.push('lock'); return lock }, quit() { calls.push('quit') },
      on(type, callback) { assert.equal(type, 'second-instance'); callback() },
      whenReady() { calls.push('ready'); return Promise.resolve() } }
    vm.runInNewContext(branch, { app, showManager() { calls.push('show') }, start() { calls.push('start') }, showStartupError() { assert.fail() } })
    await Promise.resolve()
    assert.deepEqual(calls, lock ? ['lock', 'show', 'ready', 'start'] : ['lock', 'quit'])
  }
  const relaunch = source.slice(source.indexOf('function relaunchApp()'), source.indexOf('// ---- 设置文件里的系统开关'))
  for (const env of [wayland, { ...wayland, APPIMAGE: '/opt/DSH X.AppImage' }]) {
    const args = ['/app', '--ozone-platform=wayland', '--launch=one']
    vm.runInNewContext(relaunch + '\nrelaunchApp()', { shellRelaunchOptions, process: { argv: ['electron', ...args], env },
      app: { relaunch: options => assert.deepEqual(options, { args, ...(env.APPIMAGE ? { execPath: env.APPIMAGE } : {}) }), exit: code => assert.equal(code, 0) } })
  }
})

test('两类宿主能力、登记器和菜单门控均采用当前平台策略', () => {
  assert.equal(tabDragSupported('linux'), false)
  assert.equal(tabDragSupported('win32'), true)
  assert.equal(tabDragSupported('darwin'), true)
  const main = read('shell/main.mjs')
  assert.equal(main.match(/detach: \(\) => \(\{ supported: canMigrateTabs\(\), drag: canDragTabs\(\), merge: canMigrateTabs\(\), deferred: canDragTabs\(\) \}\)/g)?.length, 2)
  assert.match(main, /new InstanceViews\(\{\s+canTransfer: canMigrateTabs/)
  assert.match(main, /migrationSupported: canMigrateTabs/)
})
