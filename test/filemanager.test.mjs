import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileManager, PosixFileManager } from '../src/filemanager-base.js'
import { MacFileManager } from '../src/filemanager-mac.js'
import { WindowsFileManager } from '../src/filemanager-windows.js'
import { LinuxFileManager } from '../src/filemanager-linux.js'
import { APP_DIR_ENV } from '../src/platform.js'
import { copyAppFiles } from '../scripts/pack-common.mjs'
import { appDirSandbox, importInSandbox, platformAppDir } from './app-dir-fixture.mjs'

/**
 * 文件管理接口的契约用例：三套实现跑同一组断言。
 */
const IMPLEMENTATIONS = [['windows', WindowsFileManager], ['mac', MacFileManager], ['linux', LinuxFileManager]]

/** 这些成员没有通用答案，每个平台都得自己给，不能从基类继承一个「不支持」糊过去。 */
const MUST_IMPLEMENT = [
  'platform', 'userAppDir', 'launcherExecutable', 'directoryOpener',
  'pickDirectory', 'pickFile', 'revealPath', 'openUrl',
  'autoStartEnabled', 'setAutoStart',
]

function spy(Implementation, { stdout = '', error = null, deps = {} } = {}) {
  const calls = []
  const fm = new Implementation({
    existsSync: () => true,
    execFile(command, args, options, callback) {
      calls.push({ command, args: Array.from(args), options })
      const done = typeof options === 'function' ? options : callback
      done(error, stdout, error?.stderr || '')
    },
    ...deps,
  })
  return { fm, calls }
}

test('每套实现都继承契约，并且自己实现了没有通用答案的那些成员', () => {
  for (const [name, Implementation] of IMPLEMENTATIONS) {
    const fm = new Implementation()
    assert.ok(fm instanceof FileManager, `${name} 要从 FileManager 继承`)
    assert.equal(fm.platform, name)
    for (const member of MUST_IMPLEMENT) {
      assert.ok(Object.hasOwn(Implementation.prototype, member), `${name} 没自己实现 ${member}`)
    }
  }
})

test('路径语义：Windows 不分大小写、用 junction、按 PATHEXT 找命令；macOS 都反过来', () => {
  const windows = new WindowsFileManager({ env: { PATHEXT: '.EXE;.CMD' }, existsSync: (path) => path.endsWith('pnpm.CMD') })
  assert.ok(windows.samePath('C:\\Users\\A\\DSH', 'c:\\users\\a\\dsh'))
  assert.equal(windows.pathKey('C:\\A'), 'c:\\a')
  assert.equal(windows.directoryLinkType, 'junction')
  assert.ok(windows.hasCommand('C:\\bin', 'pnpm'), '按 PATHEXT 补出 pnpm.CMD')

  // join 在 Windows 上给反斜杠，假 existsSync 不能按 '/' 结尾匹配
  const mac = new MacFileManager({ existsSync: (path) => /[\\/]pnpm$/.test(path) })
  assert.ok(!mac.samePath('/Users/A/dsh', '/users/a/dsh'), 'mac 上不同大小写就是两个路径')
  assert.equal(mac.directoryLinkType, 'dir')
  assert.deepEqual(mac.commandExtensions, [''])
  assert.ok(mac.hasCommand('/usr/local/bin', 'pnpm'))
  assert.ok(!mac.samePath('', ''), '空路径不算同一个')
})

test('目录选择：Windows 走 PowerShell 的 FolderBrowserDialog，macOS 走 AppleScript 的 choose folder', async () => {
  const windows = spy(WindowsFileManager, { stdout: 'D:\\目标目录\r\n' })
  assert.equal(await windows.fm.pickDirectory('D:\\起点'), 'D:\\目标目录')
  const [call] = windows.calls
  assert.equal(call.command, 'powershell')
  assert.ok(call.args.includes('-EncodedCommand'), '命令行里不留原文，省得再去转义')
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /FolderBrowserDialog/)
  assert.match(script, /FromBase64String/, '起始路径按 base64 传，中文和引号不会被拼坏')

  const mac = spy(MacFileManager, { stdout: '/Users/a/目标目录/\n' })
  assert.equal(await mac.fm.pickDirectory('/Users/a'), '/Users/a/目标目录', 'POSIX path 的尾斜杠要去掉')
  assert.equal(mac.calls[0].command, 'osascript')
  assert.match(mac.calls[0].args.join(' '), /choose folder/)
})

test('用户点取消返回空串，不是报错', async () => {
  const canceled = Object.assign(new Error('User canceled'), { stderr: 'execution error: 用户取消了。 (-128)' })
  const mac = spy(MacFileManager, { error: canceled })
  assert.equal(await mac.fm.pickDirectory(), '')
  assert.equal(await spy(MacFileManager, { error: canceled }).fm.pickFile({ save: true, defaultName: 'a.zip' }), '')
  // 别的错误照抛，别让用户以为自己点了取消
  await assert.rejects(spy(MacFileManager, { error: Object.assign(new Error('osascript 挂了'), { stderr: '' }) }).fm.pickDirectory(), /osascript/)
})

test('打开地址：Windows 过滤 cmd 的元字符，macOS 原样交给 open', async () => {
  const windows = spy(WindowsFileManager)
  await windows.fm.openUrl('http://127.0.0.1:9716/?token=abc')
  assert.deepEqual(windows.calls[0].args, ['/c', 'start', '', 'http://127.0.0.1:9716/?token=abc'])
  // cmd 会把这行再解析一遍：带 & 的地址能拼出任意命令，直接拒掉
  await assert.rejects(spy(WindowsFileManager).fm.openUrl('http://127.0.0.1:1/?&calc'), /不能安全打开/)

  const mac = spy(MacFileManager)
  await mac.fm.openUrl('http://127.0.0.1:1/?&x=1')
  assert.deepEqual(mac.calls[0], { command: 'open', args: ['http://127.0.0.1:1/?&x=1'], options: {} })
})

test('Linux：XDG 目录、AppImage 自启、zenity/kdialog 对话框', async () => {
  const linux = new LinuxFileManager({ home: '/home/a', env: { XDG_CONFIG_HOME: '/home/a/.config' }, existsSync: () => true })
  assert.equal(linux.platform, 'linux')
  assert.equal(linux.userAppDir(), join('/home/a/.config', 'DSH'))
  assert.equal(linux.autoStartPath, join('/home/a/.config', 'autostart', 'dsh-x.desktop'))

  const appImage = new LinuxFileManager({ home: '/home/a', env: { APPIMAGE: '/home/a/DSH-X.AppImage' }, existsSync: () => true })
  assert.equal(appImage.launcherExecutable(), '/home/a/DSH-X.AppImage')
  assert.deepEqual(appImage.launchArgs(), ['/home/a/DSH-X.AppImage'])

  const writes = []
  const autostart = new LinuxFileManager({
    home: '/home/a', env: {}, existsSync: () => true,
    mkdir: async () => {}, rm: async () => {}, writeFile: async (path, body) => { writes.push([path, body]) },
  })
  await autostart.setAutoStart(true)
  assert.match(writes[0][1], /\[Desktop Entry\]/)
  assert.match(writes[0][1], /X-GNOME-Autostart-enabled=true/)

  const dialog = spy(LinuxFileManager, { stdout: '/home/a/项目\n' })
  assert.equal(await dialog.fm.pickDirectory('/home/a'), '/home/a/项目')
  assert.equal(dialog.calls[0].command, 'zenity')
  assert.ok(dialog.calls[0].args.includes('--directory'))
  assert.equal(await spy(LinuxFileManager, { stdout: '/home/a/a.zip\n' }).fm.pickFile({ save: true, defaultName: 'a.zip' }), '/home/a/a.zip')

  // zenity 没装（ENOENT）时换 kdialog；用户取消（退出码 1）返回空串
  const calls = []
  const kdialog = new LinuxFileManager({
    home: '/home/a', env: {}, existsSync: () => true,
    execFile(command, args, options, callback) {
      calls.push(command)
      const done = typeof options === 'function' ? options : callback
      if (command === 'zenity') done(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '')
      else done(null, '/home/a/项目\n', '')
    },
  })
  assert.equal(await kdialog.pickDirectory('/home/a'), '/home/a/项目')
  assert.deepEqual(calls, ['zenity', 'kdialog'])
  const canceled = spy(LinuxFileManager, { error: Object.assign(new Error('canceled'), { code: 1 }) })
  assert.equal(await canceled.fm.pickDirectory(), '')
})

test('没有专门实现的平台：xdg-open 那条路能走，对话框和自启如实报不支持', async () => {
  const posix = new PosixFileManager()
  await assert.rejects(posix.pickDirectory(), /目录选择目前只支持 Windows 和 macOS/)
  await assert.rejects(posix.pickFile(), /文件选择目前只支持 Windows 和 macOS/)
  await assert.rejects(posix.setAutoStart(true), /开机自启目前只支持 Windows 和 macOS/)
  // 关掉自启不该报错：本来就没开过
  await posix.setAutoStart(false)
  assert.equal(await posix.autoStartEnabled(), false)
})

/**
 * DSH_APP_DIR 把整个每用户目录搬走，好让测试副本和正式版在同一台机器上并行。
 * 覆盖值挑 '/srv/…'：它在 posix 和 win32 两套语义下都是绝对路径，三套实现放到哪台 CI 上跑结论都一样。
 */
const APP_DIR_OVERRIDE = '/srv/dsh-x-test'
const APP_DIR_ROOT = '/opt/dsh-x'
// 只去掉首尾空白，别的都原样返回
const VALID_APP_DIR_OVERRIDES = [APP_DIR_OVERRIDE, `  ${APP_DIR_OVERRIDE}  `]
// 未设、空串、全空白（trim 后才空的边界）、相对路径：都得当没设。相对路径一旦按 cwd 解析，
// 数据就落到启动时碰巧所在的目录里
const INVALID_APP_DIR_OVERRIDES = [undefined, '', '   ', 'relative/DSH']

/**
 * 不覆盖时的平台位置，按原来的规则逐条写出来，并且每行都摆着覆盖要压过的那个变量
 * （APPDATA / XDG_CONFIG_HOME / home）。userDir 是 userAppDir() 的答案：Windows 缺 APPDATA、
 * 没有专门实现的平台都给 ''，这时 appDir 退到 <root>/data。
 */
const APP_DIR_CASES = [
  { name: 'windows', Implementation: WindowsFileManager, home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, userDir: 'C:/Users/a/AppData/Roaming/DSH' },
  { name: 'windows 缺 APPDATA', Implementation: WindowsFileManager, home: 'C:\\Users\\a', env: {}, userDir: '' },
  { name: 'mac', Implementation: MacFileManager, home: '/Users/a', env: {}, userDir: '/Users/a/Library/Application Support/DSH' },
  { name: 'linux', Implementation: LinuxFileManager, home: '/home/a', env: { XDG_CONFIG_HOME: '/home/a/.cfg' }, userDir: '/home/a/.cfg/DSH' },
  { name: 'linux 缺 XDG_CONFIG_HOME', Implementation: LinuxFileManager, home: '/home/a', env: {}, userDir: '/home/a/.config/DSH' },
  { name: 'posix', Implementation: PosixFileManager, home: '/home/a', env: {}, userDir: '' },
]

/** 比的是落在哪，不是分隔符：Windows 实现在 POSIX 机器上跑时 join 出来是混着的。 */
const slash = (path) => String(path).replace(/\\/g, '/')

function appDirManager({ Implementation, home, env }, override) {
  return new Implementation({ env: override === undefined ? env : { ...env, DSH_APP_DIR: override }, home, root: APP_DIR_ROOT })
}

test('DSH_APP_DIR 是绝对路径时，每套实现的 appDir / effectiveUserAppDir 都用它（去掉首尾空白），userAppDir 不跟着变', () => {
  // 外壳和核心各自读这个变量，常量要和文档里的名字对得上
  assert.equal(APP_DIR_ENV, 'DSH_APP_DIR')
  for (const platform of APP_DIR_CASES) {
    for (const override of VALID_APP_DIR_OVERRIDES) {
      const label = `${platform.name}，DSH_APP_DIR=${JSON.stringify(override)}`
      const fm = appDirManager(platform, override)
      assert.equal(fm.appDir, APP_DIR_OVERRIDE, label)
      // 缺 APPDATA / 没专门实现时也一样：覆盖要压过 <root>/data 这条退路
      assert.equal(fm.effectiveUserAppDir(), APP_DIR_OVERRIDE, label)
      assert.equal(slash(fm.userAppDir()), platform.userDir, `${label}：userAppDir 只给平台位置`)
    }
  }
})

test('DSH_APP_DIR 未设 / 空串 / 全空白 / 相对路径时，effectiveUserAppDir 就是 userAppDir，appDir 和原来一样', () => {
  for (const platform of APP_DIR_CASES) {
    for (const override of INVALID_APP_DIR_OVERRIDES) {
      const label = `${platform.name}，DSH_APP_DIR=${JSON.stringify(override)}`
      const fm = appDirManager(platform, override)
      assert.equal(fm.effectiveUserAppDir(), fm.userAppDir(), label)
      assert.equal(slash(fm.effectiveUserAppDir()), platform.userDir, label)
      assert.equal(slash(fm.appDir), platform.userDir || `${APP_DIR_ROOT}/data`, label)
    }
  }
})

/** 往数据目录里种一份「装过」的痕迹：config.json 或 versions/，有一个就算。 */
function seedInstall(dataDir, { config = false, versions = false }) {
  mkdirSync(dataDir, { recursive: true })
  if (config) writeFileSync(join(dataDir, 'config.json'), '{}')
  if (versions) mkdirSync(join(dataDir, 'versions', '0.1.0'), { recursive: true })
}

test('默认版本目录跟着 DSH_APP_DIR 走：覆盖目录的 data 装过就用它，正式版那份装过也不碰', () => {
  const box = appDirSandbox()
  // settings.js 在 import 时按 process.env 建 fileManager 单例，同进程里换不了环境
  const fallbackDataDir = (override) => importInSandbox(box, new URL('../src/settings.js', import.meta.url).href, 'm.fallbackDataDir()', override)
  try {
    const platformData = join(platformAppDir(box.home), 'data')
    seedInstall(platformData, { config: true, versions: true })
    // 对照：不覆盖时种下的这份确实会被选中，下面的「不碰」才不是空转
    assert.equal(fallbackDataDir(undefined), platformData)
    for (const marker of ['config', 'versions']) {
      const override = join(box.root, `copy-${marker}`)
      seedInstall(join(override, 'data'), { [marker]: true })
      assert.equal(fallbackDataDir(override), join(override, 'data'), `覆盖目录的 data 只有 ${marker} 也算装过`)
    }
    // 测试副本第一次启动，覆盖目录还是空的：选哪没规定，但绝不能落回正式版的数据目录
    const fresh = join(box.root, 'copy-fresh')
    mkdirSync(fresh)
    assert.notEqual(fallbackDataDir(fresh), platformData)
  } finally {
    box.cleanup()
  }
})

test('核心包同时带三套文件管理实现，运行时按平台选', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dsh-filemanager-pack-'))
  try {
    await copyAppFiles(out)
    assert.ok(existsSync(join(out, 'filemanager.js')), '选实现的入口')
    assert.ok(existsSync(join(out, 'filemanager-base.js')), '契约基类')
    assert.ok(existsSync(join(out, 'filemanager-mac.js')), 'mac 实现随核心包发')
    assert.ok(existsSync(join(out, 'filemanager-windows.js')), 'Windows 实现随核心包发')
    assert.ok(existsSync(join(out, 'filemanager-linux.js')), 'Linux 实现随核心包发')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
