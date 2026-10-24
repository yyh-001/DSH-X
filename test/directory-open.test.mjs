import assert from 'node:assert/strict'
import test from 'node:test'

import { PosixFileManager } from '../filemanager-base.js'
import { MacFileManager } from '../filemanager-mac.js'
import { WindowsFileManager } from '../filemanager-windows.js'

/**
 * 打开目录 / 定位文件这类事交给了实现类，用例就按实现类来：execFile 和 statSync 都注进去，
 * 三个平台在哪台机器上都能验（原来这里是把 server.js 的源码抠出来丢进 vm 跑的）。
 */
function opener(Implementation, { error = null, kind = 'directory' } = {}) {
  const calls = []
  const fm = new Implementation({
    statSync() {
      if (kind === 'missing') throw new Error('ENOENT')
      return { isDirectory: () => kind === 'directory' }
    },
    execFile(command, args, options, callback) {
      calls.push({ command, args: Array.from(args) })
      const done = typeof options === 'function' ? options : callback
      done(error)
    },
  })
  return { fm, calls }
}

test('文件管理器按平台选择程序，中文和空格路径作为单独参数传递', async () => {
  for (const [Implementation, command] of [[WindowsFileManager, 'explorer.exe'], [MacFileManager, 'open'], [PosixFileManager, 'xdg-open']]) {
    const h = opener(Implementation)
    await h.fm.openDirectory('D:/中文目录 with spaces')
    assert.deepEqual(h.calls, [{ command, args: ['D:/中文目录 with spaces'] }])
  }
})

test('不存在的目录和文件不会启动文件管理器，启动失败可以反馈到界面', async () => {
  for (const [kind, message] of [['missing', /目录不存在/], ['file', /请选择文件夹/]]) {
    const h = opener(WindowsFileManager, { kind })
    await assert.rejects(h.fm.openDirectory('D:/target'), message)
    assert.deepEqual(h.calls, [])
  }
  await assert.rejects(opener(WindowsFileManager, { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }).fm.openDirectory('D:/target'), /not found/)
  // Explorer 接管已有窗口时返回 1，这不是失败
  await opener(WindowsFileManager, { error: Object.assign(new Error('Explorer'), { code: 1 }) }).fm.openDirectory('D:/target')
  await assert.rejects(opener(PosixFileManager, { error: Object.assign(new Error('xdg-open failed'), { code: 1 }) }).fm.openDirectory('/target'), /xdg-open failed/)
})

test('定位文件：Windows 用 /select 选中它，macOS 用 open -R，没这能力的平台退一步打开所在目录', async () => {
  const windows = opener(WindowsFileManager)
  await windows.fm.revealPath('D:/packs/a.dspack')
  assert.deepEqual(windows.calls, [{ command: 'explorer', args: ['/select,D:/packs/a.dspack'] }])

  const mac = opener(MacFileManager)
  await mac.fm.revealPath('/packs/a.dspack')
  assert.deepEqual(mac.calls, [{ command: 'open', args: ['-R', '/packs/a.dspack'] }])

  const posix = opener(PosixFileManager)
  await posix.fm.revealPath('/packs/a.dspack')
  assert.deepEqual(posix.calls, [{ command: 'xdg-open', args: ['/packs'] }])
})
