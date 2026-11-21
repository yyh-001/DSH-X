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
function runPreload(file, { protocol = 'http:', hostname = '127.0.0.1', argv = [], pathForFile, sent = [] } = {}) {
  const exposed = {}
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        if (name in exposed) throw new Error(`重复暴露 ${name}`)
        exposed[name] = value
      },
    },
    ipcRenderer: { on() {}, invoke: () => Promise.resolve(), send(...args) { sent.push(args) } },
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

test('管理页保留管理 IPC，独立窗口与标签共用远端桥', () => {
  const manager = runPreload('shell/preload.cjs')
  assert.ok(manager.ipc, '管理页照旧拿 ipc')
  assert.equal(manager.__DSH_HOST_PATHS__, undefined, '管理页不装文件路径桥')

  const dshWindow = runPreload('shell/preload-browser.cjs')
  assert.equal(dshWindow.ipc, undefined, '远端页面没有管理 IPC')
  assert.equal(dshWindow.__DSH_HOST_PATHS__.pathFor({ name: 'ws.md' }), '/real/ws.md')
})

test('本地占位页桥只发送启动与返回管理页，不开放管理消息', () => {
  const sent = []
  const local = runPreload('shell/preload-browser.cjs', { protocol: 'data:', sent })
  for (const message of ['launch', 'manager', 'close', '{"action":"quit-confirm","ok":true}']) local.ipc.postMessage(message)
  assert.deepEqual(sent, [['dsh-x:ipc', 'launch'], ['dsh-x:ipc', 'manager']])
  assert.equal(local.ipc.onMessage, undefined)
})

test('外壳把两份预加载各装到该装的地方，右侧栏 webview 的 guest 拿不到', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /const BROWSER_PRELOAD = join\(HERE, 'preload-browser\.cjs'\)/)
  assert.match(main, /function remotePreferences\(target = null\)[\s\S]*?preload: BROWSER_PRELOAD/, '内部标签页用浏览器预加载')
  assert.match(main, /new WebContentsView\(\{ webPreferences: remotePreferences\(target\) \}\)/,
    '两种宿主共用带路径桥的视图预加载，迁移不更换预加载')

  // guest 的 webPreferences 在主进程里清空，只剩 Electron 自己的 disablePopups：
  // 页面给 <webview> 塞什么 preload 都传不进去，这个桥不会漏到侧栏浏览器里。
  const guests = read('shell/browser-guests.mjs')
  assert.match(guests, /for \(const key of Object\.keys\(preferences\)\) \{\s*if \(key !== 'disablePopups'\) Reflect\.deleteProperty\(preferences, key\)/,
    'will-attach-webview 删掉渲染进程传来的全部偏好')
  assert.match(guests, /webviewTag: false, plugins: false, navigateOnDragDrop: false/)
})

test('WSL 实例：拖进来的 Windows 路径换成 /mnt/<盘符>/…，UNC 的 \\\\wsl$ 换成发行版里的绝对路径', () => {
  const paths = {
    'a.png': 'C:\\Users\\me\\Desktop\\a.png',
    'D-root': 'D:\\',
    'long': '\\\\?\\E:\\Work\\x.txt',
    'wsl': '\\\\wsl$\\Ubuntu\\home\\me\\notes.md',
    'wsl-local': '\\\\wsl.localhost\\ubuntu\\etc\\hosts',
    'other-distro': '\\\\wsl.localhost\\Debian\\home\\me\\x',
    'share': '\\\\server\\share\\doc.txt',
    'linux': '/home/me/a.txt',
  }
  const pathForFile = (file) => paths[file.name]
  const exposed = runPreload('shell/preload-browser.cjs', { argv: ['--dsh-x-wsl=Ubuntu'], pathForFile })
  const pathFor = (name) => exposed.__DSH_HOST_PATHS__.pathFor({ name })
  assert.equal(pathFor('a.png'), '/mnt/c/Users/me/Desktop/a.png')
  assert.equal(pathFor('D-root'), '/mnt/d')
  assert.equal(pathFor('long'), '/mnt/e/Work/x.txt')
  assert.equal(pathFor('wsl'), '/home/me/notes.md')
  assert.equal(pathFor('wsl-local'), '/etc/hosts', '发行版名不分大小写')
  assert.equal(pathFor('other-distro'), paths['other-distro'], '别的发行版没有对应路径，原样交回')
  assert.equal(pathFor('share'), paths.share, '网络共享原样交回')
  assert.equal(pathFor('linux'), '/home/me/a.txt')

  // 默认发行版（参数里名字为空）：认不出名字时 \\wsl$ 也照换
  const anyDistro = runPreload('shell/preload-browser.cjs', { argv: ['--dsh-x-wsl='], pathForFile })
  assert.equal(anyDistro.__DSH_HOST_PATHS__.pathFor({ name: 'other-distro' }), '/home/me/x')

  // 本机实例（没有参数）不换算
  const local = runPreload('shell/preload-browser.cjs', { pathForFile })
  assert.equal(local.__DSH_HOST_PATHS__.pathFor({ name: 'a.png' }), paths['a.png'])
})

test('外壳按实例身份决定 WSL 参数：home 是 wsl:// 的视图才带 --dsh-x-wsl', () => {
  const main = read('shell/main.mjs')
  const start = main.indexOf('function wslDistroOfHome(')
  const end = main.indexOf('/**', main.indexOf('function remotePreferences('))
  const context = { BROWSER_PRELOAD: '/x/preload-browser.cjs' }
  vm.runInNewContext(main.slice(start, end) + '\nglobalThis.check = (target) => remotePreferences(target)', context)
  // vm 里造的数组是另一个 realm 的，展开成本 realm 的再比
  const args = (target) => { const value = context.check(target).additionalArguments; return value && [...value] }
  assert.deepEqual(args({ home: 'wsl://Ubuntu/~%2F.dsh' }), ['--dsh-x-wsl=Ubuntu'])
  assert.deepEqual(args({ home: 'wsl:///~%2F.dsh' }), ['--dsh-x-wsl='], '默认发行版名字为空也算 WSL')
  assert.equal(args({ home: 'C:\\Users\\me\\.dsh' }), undefined)
  assert.equal(args(null), undefined)
  const views = read('shell/instance-views.mjs')
  assert.match(views, /this\.hooks\.createView\(record\.viewId, target\)/, '建视图时把实例身份交给外壳')
})
