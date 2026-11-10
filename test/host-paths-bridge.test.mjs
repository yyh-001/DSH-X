/**
 * 输入框拖拽/粘贴文件的真实路径桥（`__DSH_HOST_PATHS__`，见 issue #91）：
 * 官方 web profile 靠它把文件变成 `@路径` 引用、把文件夹变成目录引用。
 *
 * 外壳依赖 Electron，这里按仓库惯例用 vm 把两份预加载跑起来，换成假的 electron 模块，
 * 盯住两件事：只给回环地址的 dsh 页面装、只暴露 pathFor 一个函数。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

/**
 * 执行一份预加载，返回它暴露到主世界的对象。
 * @param {string} file 预加载路径
 * @param {{ protocol?: string, hostname?: string, argv?: string[], pathForFile?: (file: unknown) => string }} [options]
 */
function runPreload(file, { protocol = 'http:', hostname = '127.0.0.1', argv = [], pathForFile } = {}) {
  const exposed = {}
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name in exposed) throw new Error(`重复暴露 ${name}`)
        exposed[name] = value
      },
    },
    ipcRenderer: { on() {}, invoke: () => Promise.resolve(), send() {} },
    webUtils: { getPathForFile: pathForFile ?? ((value) => `/real/${value?.name ?? 'unknown'}`) },
  }
  const sandbox = {
    require: (id) => {
      if (id === 'electron') return electron
      throw new Error(`预加载不该 require ${id}`)
    },
    location: { protocol, hostname },
    process: { platform: 'win32', argv: ['electron', ...argv] },
    document: { documentElement: { classList: { add() {} } }, addEventListener() {} },
    console,
  }
  new vm.Script(read(file), { filename: file }).runInNewContext(sandbox)
  return exposed
}

test('内部标签页：回环 dsh 页面拿到 __DSH_HOST_PATHS__，pathFor 交给 webUtils', () => {
  const exposed = runPreload('shell/preload-browser.cjs')
  assert.ok(exposed.__DSH_HOST_PATHS__, '127.0.0.1 的页面要装桥')
  assert.equal(typeof exposed.__DSH_HOST_PATHS__.pathFor, 'function')
  assert.equal(exposed.__DSH_HOST_PATHS__.pathFor({ name: 'a.png' }), '/real/a.png')
  assert.equal(exposed.dshDesktop.protocolVersion, 1, '侧栏浏览器桥不受影响')
})

test('内部标签页：localhost 和 [::1] 同样算本机', () => {
  for (const hostname of ['localhost', '[::1]']) {
    const exposed = runPreload('shell/preload-browser.cjs', { hostname })
    assert.ok(exposed.__DSH_HOST_PATHS__, `${hostname} 的页面要装桥`)
  }
})

test('内部标签页：外部网页、非回环地址和 data: 停止页都拿不到桥', () => {
  for (const target of [
    { protocol: 'https:', hostname: 'example.com' },
    { protocol: 'http:', hostname: '192.168.1.5' },
    { protocol: 'http:', hostname: '0.0.0.0' },
    { protocol: 'data:', hostname: '' },
    { protocol: 'file:', hostname: '' },
  ]) {
    const exposed = runPreload('shell/preload-browser.cjs', target)
    assert.equal(exposed.__DSH_HOST_PATHS__, undefined, `${target.protocol}//${target.hostname} 不该拿到真实路径`)
    assert.ok(exposed.dshDesktop, '侧栏浏览器桥照旧')
  }
})

test('pathFor 遇到构造出来的 File（拿不到磁盘路径）返回空串，不抛', () => {
  const exposed = runPreload('shell/preload-browser.cjs', {
    pathForFile: () => { throw new Error('not backed by a file') },
  })
  assert.equal(exposed.__DSH_HOST_PATHS__.pathFor({ name: 'made-up.txt' }), '')
})

test('独立桌面窗口：带标记的 dsh 页面才有桥，管理页没有', () => {
  const manager = runPreload('shell/preload.cjs')
  assert.ok(manager.ipc, '管理页照旧拿 ipc')
  assert.equal(manager.__DSH_HOST_PATHS__, undefined, '管理页不装文件路径桥')

  const dshWindow = runPreload('shell/preload.cjs', { argv: ['--dsh-host-paths'] })
  assert.ok(dshWindow.__DSH_HOST_PATHS__, '带 --dsh-host-paths 的独立窗口要装桥')
  assert.equal(dshWindow.__DSH_HOST_PATHS__.pathFor({ name: 'ws.md' }), '/real/ws.md')
})

test('独立桌面窗口：标记只对回环地址生效', () => {
  const remote = runPreload('shell/preload.cjs', {
    argv: ['--dsh-host-paths'],
    protocol: 'https:',
    hostname: 'dsh.example.com',
  })
  assert.equal(remote.__DSH_HOST_PATHS__, undefined)
})

test('外壳把两份预加载各装到该装的地方，右侧栏 webview 的 guest 拿不到', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /const BROWSER_PRELOAD = join\(HERE, 'preload-browser\.cjs'\)/)
  assert.match(main, /function remotePreferences\(\)[\s\S]*?preload: BROWSER_PRELOAD/, '内部标签页用浏览器预加载')
  assert.match(main, /webPreferences: \{ \.\.\.managerPreferences\(\), additionalArguments: \['--dsh-host-paths'\] \}/,
    '独立桌面窗口带路径桥标记，管理页不带')

  // guest 的 webPreferences 在主进程里清空，只剩 Electron 自己的 disablePopups：
  // 页面给 <webview> 塞什么 preload 都传不进去，这个桥不会漏到侧栏浏览器里。
  const guests = read('shell/browser-guests.mjs')
  assert.match(guests, /for \(const key of Object\.keys\(preferences\)\) \{\s*if \(key !== 'disablePopups'\) Reflect\.deleteProperty\(preferences, key\)/,
    'will-attach-webview 删掉渲染进程传来的全部偏好')
  assert.match(guests, /webviewTag: false, plugins: false, navigateOnDragDrop: false/)
})
