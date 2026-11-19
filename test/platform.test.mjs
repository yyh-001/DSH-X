import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { MAC_BUNDLE_ID, RUNTIME_NODE } from '../src/platform.js'
import { MacFileManager } from '../src/filemanager-mac.js'
import { WindowsFileManager } from '../src/filemanager-windows.js'
import { LinuxFileManager } from '../src/filemanager-linux.js'

// 平台差异全在实现类里，所以这份用例直接把三套实现都 new 出来跑，不按当前系统 skip。
const mac = (deps = {}) => new MacFileManager({ home: '/Users/a', env: {}, existsSync: () => false, ...deps })
const windows = (deps = {}) => new WindowsFileManager({ env: {}, existsSync: () => false, ...deps })
const linux = (deps = {}) => new LinuxFileManager({ home: '/home/a', env: {}, existsSync: () => false, ...deps })

// macOS 上这就是 /Users/a/Library/Application Support/DSH；在 Windows 上跑这份测试时
// join 会给出反斜杠，所以期望值也用 join 拼，别把分隔符写死
const MAC_USER_DIR = join('/Users/a', 'Library', 'Application Support', 'DSH')

test('每用户目录：Windows 走 %APPDATA%\\DSH，macOS 走 Application Support', () => {
  assert.equal(windows({ env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } }).userAppDir(), join('C:\\Users\\a\\AppData\\Roaming', 'DSH'))
  assert.equal(mac().userAppDir(), MAC_USER_DIR)
})

test('每用户目录：Linux 走 XDG_CONFIG_HOME，默认 ~/.config/DSH', () => {
  assert.equal(linux().userAppDir(), join('/home/a', '.config', 'DSH'))
  assert.equal(linux({ env: { XDG_CONFIG_HOME: '/cfg' } }).userAppDir(), join('/cfg', 'DSH'))
})

test('每用户目录：macOS 不看 APPDATA（它在 mac 上多半是别的工具随手设的）', () => {
  assert.equal(mac({ env: { APPDATA: '/tmp/x' } }).userAppDir(), MAC_USER_DIR)
})

test('每用户目录：Windows 没有 APPDATA 时返回空串，调用方退回安装目录下的 data/', () => {
  assert.equal(windows().userAppDir(), '')
  assert.equal(windows({ root: 'C:\\DSH' }).appDir, join('C:\\DSH', 'data'))
})

test('appBundle：认得 <X>.app/Contents/Resources/app 和 core 布局', () => {
  for (const dir of ['app', 'core']) {
    assert.equal(mac({ root: `/Applications/DSH-X.app/Contents/Resources/${dir}` }).appBundle(), '/Applications/DSH-X.app')
  }
})

test('appBundle：源码目录、布局不全都不算包；Windows 没有包这回事', () => {
  for (const root of [
    '/Users/a/code/DSH-X',
    '/Applications/DSH-X.app/Contents/Resources',
    '/Applications/DSH-X/Contents/Resources/app',
    '/x/Contents/Other/app',
  ]) {
    assert.equal(mac({ root }).appBundle(), '', root)
  }
  assert.equal(windows({ root: 'C:\\Program Files\\DSH' }).appBundle(), '')
})

test('自启命令：装好的 mac 走 open -a，Windows 直接用 DSH.exe，源码运行回落 node start.js', () => {
  const installed = mac({ root: '/Applications/DSH-X.app/Contents/Resources/app', existsSync: () => true })
  assert.deepEqual(installed.launchArgs(), ['/usr/bin/open', '-a', '/Applications/DSH-X.app'])
  const exe = windows({ root: 'C:\\DSH', existsSync: () => true })
  assert.deepEqual(exe.launchArgs(), [join('C:\\DSH', 'DSH.exe')])
  // 路径里有空格时每一项都得带引号，注册表里那条命令才不会被拆开
  assert.equal(exe.launchCommand(), `"${join('C:\\DSH', 'DSH.exe')}"`)
  assert.deepEqual(mac({ root: '/Users/a/code/DSH-X' }).launchArgs(), [RUNTIME_NODE, join('/Users/a/code/DSH-X', 'start.js')])
})

test('LaunchAgent：登录时跑一次、参数逐个成项、特殊字符转义', () => {
  const plist = mac().launchAgentPlist(['/usr/bin/open', '-a', '/Applications/A&B <x>.app'], '/tmp/work')
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${MAC_BUNDLE_ID.replace(/\./g, '\\.')}</string>`))
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  // 用户主动退出后不该被 launchd 再拉起来
  assert.doesNotMatch(plist, /KeepAlive/)
  assert.match(plist, /<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>\s*<string>\/Applications\/A&amp;B &lt;x&gt;\.app<\/string>/)
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/work<\/string>/)
})

test('LaunchAgent：开自启写文件、关自启删文件，都不 launchctl load', () => {
  const calls = []
  const fm = mac({
    mkdir: async (dir) => calls.push(['mkdir', dir]),
    writeFile: async (path, body) => calls.push(['write', path, body.includes('RunAtLoad')]),
    rm: async (path, options) => calls.push(['rm', path, options?.force === true]),
  })
  const agent = join('/Users/a', 'Library', 'LaunchAgents', `${MAC_BUNDLE_ID}.plist`)
  return fm.setAutoStart(true)
    .then(() => fm.setAutoStart(false))
    .then(() => {
      assert.deepEqual(calls, [
        ['mkdir', join('/Users/a', 'Library', 'LaunchAgents')],
        ['write', agent, true],
        ['rm', agent, true],
      ])
    })
})

test('installDir 与 containsPath：识别安装目录，按路径段边界且尊重平台大小写语义', () => {
  const win = windows({ root: 'D:\\APPS\\DSH', existsSync: (p) => p === join('D:\\APPS\\DSH', 'DSH.exe') })
  assert.equal(win.installDir(), 'D:\\APPS\\DSH')
  assert.equal(windows({ root: 'D:\\APPS\\DSH', existsSync: () => false }).installDir(), '')
  assert.equal(win.containsPath('D:\\APPS\\DSH', 'd:\\apps\\dsh'), true)
  assert.equal(win.containsPath('D:\\APPS\\DSH\\', 'd:\\apps\\dsh\\.dsh'), true)
  assert.equal(win.containsPath('D:\\APPS\\DSH', 'D:\\APPS\\DSH-home'), false, '同前缀兄弟目录不能误判进安装目录')

  const macInstalled = mac({ root: '/Applications/DSH-X.app/Contents/Resources/core' })
  assert.equal(macInstalled.installDir(), '/Applications/DSH-X.app')
  assert.equal(macInstalled.containsPath('/Applications/DSH-X.app', '/Applications/DSH-X.app/Data'), true)
  assert.equal(macInstalled.containsPath('/Applications/DSH-X.app', '/applications/dsh-x.app/Data'), false)
  assert.equal(macInstalled.containsPath('/Applications/DSH-X.app', '/Applications/DSH-X.app-data'), false)

  assert.equal(linux({ env: { APPIMAGE: '/home/a/DSH-X.AppImage' } }).installDir(), '', 'AppImage 单文件不把所在目录当安装目录')
  assert.equal(linux().containsPath('/opt/DSH-X', '/opt/DSH-X/data'), true)
  assert.equal(linux().containsPath('/opt/DSH-X', '/opt/DSH-X-data'), false)
})
