import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

async function cli(args, platform = 'linux') {
  const calls = [], child = new EventEmitter()
  const source = read('npm-package/bin/dsh-x.mjs').replace(/^import .*\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../npm-package/bin/dsh-x.mjs', import.meta.url).href))
    .replace('main().catch(', 'globalThis.done = main().catch(')
  const context = { EventEmitter, dirname, join, fileURLToPath,
    createRequire: () => () => ({ version: '44.7.0' }), readFileSync: () => '{"version":"test"}', existsSync: () => true,
    ensureCore: async () => ({ dir: '/cache/core', version: 'test' }), installedCore: () => null,
    spawn: (exe, argv, options) => { calls.push({ exe, argv: [...argv], env: options.env }); return child },
    console: { log() {}, warn() {}, error() {} },
    process: { argv: ['node', '/bin/dsh-x.mjs', ...args], platform, env: { ...wayland, DSH_ELECTRON_BIN: '/electron' }, on() {} } }
  vm.runInNewContext(source, context)
  await context.done
  return { calls, child, process: context.process }
}

test('三端 CLI 原样传递启动参数，不注入后端参数，失败保留退出码', async () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const args of [[], ['--ozone-platform=wayland', '--launch=one'], ['--ozone-platform=x11'], ['--', '--version']]) {
      const c = await cli(args, platform), call = c.calls[0]
      assert.equal(c.calls.length, 1)
      assert.deepEqual(call.argv.slice(1), args)
      assert.equal(call.env.DSH_NPM, '1')
      assert.equal(call.env.DSH_CORE_DIR, '/cache/core')
      c.child.emit('exit', 7, null)
      assert.equal(c.process.exitCode, 7)
    }
  }
  for (const arg of ['--help', '--version', '--core', '--update']) assert.equal((await cli([arg])).calls.length, 0)
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
