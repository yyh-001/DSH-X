import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { linuxBackendLaunch, restartLinuxBackend, shellRelaunchOptions } from '../shell/linux-backend.mjs'
import { tabDragSupported } from '../shell/tab-detach.mjs'

const wayland = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' }
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function boot(args, backend = 'wayland', env = wayland, platform = 'linux') {
  const calls = [], warnings = []
  const app = { commandLine: { getSwitchValue: name => { assert.equal(name, 'ozone-platform'); return backend } },
    relaunch: options => calls.push(['relaunch', options]), exit: code => calls.push(['exit', code]) }
  const restarting = restartLinuxBackend(app, { args, env, platform, warn: message => warnings.push(message) })
  return { calls, warnings, restarting }
}

test('Wayland 桌面默认请求 XWayland，保留应用路径、启动请求与 -- 边界，不修改输入', () => {
  for (const args of [['shell/main.mjs', '--launch=one'], ['--remote-debugging-port=9223', '/app'], ['/app', '--', '--ozone-platform=wayland']]) {
    const original = [...args], plan = linuxBackendLaunch(args, wayland, 'linux')
    assert.equal(plan.preferX11, true)
    assert.deepEqual(args, original)
    assert.deepEqual(plan.args.filter(arg => arg !== '--ozone-platform=x11'), args)
    assert.ok(plan.args.indexOf('--') < 0 || plan.args.indexOf('--ozone-platform=x11') < plan.args.indexOf('--'))
    assert.match(plan.message, /尚未验证 DISPLAY 连接/)
  }
})

test('显式 x11/wayland/auto、未知后端与旧 hint 原样保留，不自动重启或替换', () => {
  for (const choice of ['x11', 'wayland', 'auto', 'headless', 'invalid', '']) {
    for (const args of [[`--ozone-platform=${choice}`], ['--ozone-platform', choice], [`--ozone-platform-hint=${choice}`]]) {
      const b = boot(['/app', ...args])
      assert.equal(b.restarting, false)
      assert.deepEqual(b.calls, [])
      assert.deepEqual(linuxBackendLaunch(args, wayland, 'linux').args, args)
    }
  }
})

test('缺少 DISPLAY 明确诊断且不重启；存在但失效的 DISPLAY 只请求连接，不伪造成功', () => {
  for (const DISPLAY of [undefined, '', '  ']) {
    const b = boot(['/app'], 'wayland', { ...wayland, DISPLAY })
    assert.equal(b.restarting, false)
    assert.deepEqual(b.calls, [])
    assert.match(b.warnings.join('\n'), /未提供 DISPLAY.*原生 Wayland/)
  }
  const b = boot(['/app'], 'wayland', { ...wayland, DISPLAY: ':99999' })
  assert.equal(b.restarting, true)
  assert.equal(b.calls.filter(call => call[0] === 'relaunch').length, 1)
  assert.match(b.warnings.join('\n'), /X server \/ DISPLAY.*--ozone-platform=wayland/)
  assert.doesNotMatch(b.warnings.join('\n'), /连接成功/)
})

test('已解析为 X11 的后端不因桌面是 Wayland 再重启；未知后端不开放拖动', () => {
  assert.equal(boot(['/app'], 'x11').restarting, false)
  assert.equal(tabDragSupported('linux', 'x11', '44.7.1'), true)
  for (const backend of ['', 'auto', 'wayland', 'headless']) assert.equal(tabDragSupported('linux', backend, '44.7.1'), false)
  // 44.7.0 的跨窗迁移后内容不绘制，锁回该版本时不能开放拖动。
  assert.equal(tabDragSupported('linux', 'x11', '44.7.0'), false)
})

test('Windows、macOS 与普通 X11 会话启动参数不变、零重启、无新增诊断', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = platform === 'linux' ? { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' } : wayland
    const b = boot(['/app'], 'x11', env, platform)
    assert.equal(b.restarting, false)
    assert.deepEqual(b.calls, [])
    assert.deepEqual(b.warnings, [])
    assert.deepEqual(linuxBackendLaunch(['/app'], env, platform).args, ['/app'])
  }
})

test('后端切换只重启一次，AppImage 用外层文件，普通重启保留全部启动参数', () => {
  for (const env of [wayland, { ...wayland, APPIMAGE: '/opt/DSH X.AppImage' }]) {
    const args = ['/app', '--launch=one', '--', 'position'], b = boot(args, 'wayland', env)
    assert.equal(b.restarting, true)
    assert.deepEqual(b.calls.map(call => call[0]), ['relaunch', 'exit'])
    const options = b.calls[0][1]
    assert.deepEqual(options.args, ['/app', '--launch=one', '--ozone-platform=x11', '--', 'position'])
    assert.equal(options.execPath, env.APPIMAGE)
    assert.equal(boot(options.args, 'x11', env).restarting, false)
    assert.deepEqual(shellRelaunchOptions(options.args, env), options)
  }
})

test('真实主入口先切后端，重启分支不取单实例锁或启动核心，二次启动只唤出窗口', async () => {
  const source = read('shell/main.mjs'), calls = []
  assert.ok(source.indexOf('const restartingBackend = restartLinuxBackend(app)') < source.indexOf("app.setPath('userData'"))
  const branch = source.slice(source.indexOf('if (restartingBackend ||'), source.indexOf('function managerUrl()'))
  for (const [restartingBackend, lock] of [[true, true], [false, false], [false, true]]) {
    calls.length = 0
    const app = { requestSingleInstanceLock() { calls.push('lock'); return lock }, quit() { calls.push('quit') },
      on(type, callback) { assert.equal(type, 'second-instance'); callback() },
      whenReady() { calls.push('ready'); return Promise.resolve() } }
    vm.runInNewContext(branch, { restartingBackend, app, showManager() { calls.push('show') }, start() { calls.push('start') }, showStartupError() { assert.fail() } })
    await Promise.resolve()
    assert.deepEqual(calls, restartingBackend ? ['quit'] : lock ? ['lock', 'show', 'ready', 'start'] : ['lock', 'quit'])
  }
  const relaunch = source.slice(source.indexOf('function relaunchApp()'), source.indexOf('// ---- 设置文件里的系统开关'))
  vm.runInNewContext(relaunch + '\nrelaunchApp()', { shellRelaunchOptions, process: { argv: ['electron', '/app', '--ozone-platform=x11'], env: wayland },
    app: { relaunch: options => assert.deepEqual([...options.args], ['/app', '--ozone-platform=x11']), exit: code => assert.equal(code, 0) } })
})

async function cli(args, platform = 'linux', env = wayland) {
  const calls = [], warnings = [], child = new EventEmitter()
  // 执行真实 CLI；只替换进程/下载/文件边界，既不联网也不启动桌面进程。
  const source = read('npm-package/bin/dsh-x.mjs').replace(/^import .*\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../npm-package/bin/dsh-x.mjs', import.meta.url).href))
    .replace('main().catch(', 'globalThis.done = main().catch(')
  const context = { linuxBackendLaunch: (args, env) => linuxBackendLaunch(args, env, platform), EventEmitter, dirname, join, fileURLToPath,
    createRequire: () => () => ({ version: '44.7.0' }), readFileSync: () => '{"version":"test"}', existsSync: () => true,
    ensureCore: async () => ({ dir: '/cache/core', version: 'test' }), installedCore: () => null,
    spawn: (exe, argv, options) => { calls.push({ exe, argv: [...argv], env: options.env }); return child },
    console: { log() {}, warn: message => warnings.push(message), error: message => warnings.push(message) },
    process: { argv: ['node', '/bin/dsh-x.mjs', ...args], platform, env: { ...env, DSH_ELECTRON_BIN: '/electron' }, on() {} } }
  vm.runInNewContext(source, context)
  await context.done
  return { calls, warnings, child, process: context.process }
}

test('真实 npm CLI 在 spawn 前选择 X11，用户显式参数及其他参数完整透传', async () => {
  for (const args of [[], ['--ozone-platform=wayland', '--launch=one'], ['--ozone-platform=x11'], ['--ozone-platform=auto'], ['--ozone-platform-hint=wayland'], ['--', '--version']]) {
    const c = await cli(args), call = c.calls[0]
    assert.equal(c.calls.length, 1)
    assert.equal(call.exe, '/electron')
    assert.deepEqual(call.argv.slice(1), linuxBackendLaunch(args, wayland, 'linux').args)
    assert.equal(call.env.DSH_NPM, '1')
    assert.equal(call.env.DSH_CORE_DIR, '/cache/core')
  }
  for (const platform of ['win32', 'darwin']) assert.deepEqual((await cli(['--launch=one'], platform)).calls[0].argv.slice(1), ['--launch=one'])
})

test('CLI 自消费命令不启动 Electron，自动 X11 失败保留退出码和明确诊断', async () => {
  for (const arg of ['--help', '--version', '--core', '--update']) assert.equal((await cli([arg])).calls.length, 0)
  const c = await cli([])
  c.child.emit('exit', 7, null)
  assert.equal(c.process.exitCode, 7)
  assert.match(c.warnings.at(-1), /X11\/XWayland.*DISPLAY\/认证.*--ozone-platform=wayland/)
})

test('npm 组装包含共享启动模块，包内重写入口可解析，不引入第三方依赖', () => {
  const pack = read('scripts/pack-npm.mjs')
  assert.match(pack, /writeFile\(join\(STAGE, 'lib', 'launch\.mjs'\), "export \{ linuxBackendLaunch \} from '\.\.\/shell\/linux-backend\.mjs'/)
  assert.match(pack, /cp\(join\(ROOT, 'shell'\), join\(STAGE, 'shell'\)/)
  assert.doesNotMatch(read('shell/linux-backend.mjs'), /\bimport\b/)
})
