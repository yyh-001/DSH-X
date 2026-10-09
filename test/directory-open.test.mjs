import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8')
const start = source.indexOf('async function openDirectory(dir) {')
const end = source.indexOf('/** macOS 的目录选择', start)

function opener(platform, error, kind = 'directory') {
  const calls = []
  const context = vm.createContext({
    IS_WINDOWS: platform === 'win32', IS_MAC: platform === 'darwin',
    statSync() {
      if (kind === 'missing') throw new Error('ENOENT')
      return { isDirectory: () => kind === 'directory' }
    },
    execFile(command, args, callback) { calls.push({ command, args: Array.from(args) }); callback(error) },
  })
  vm.runInContext(source.slice(start, end), context)
  return { open: context.openDirectory, calls }
}

test('文件管理器按平台选择程序，中文和空格路径作为单独参数传递', async () => {
  for (const [platform, command] of [['win32', 'explorer.exe'], ['darwin', 'open'], ['linux', 'xdg-open']]) {
    const h = opener(platform)
    await h.open('D:/中文目录 with spaces')
    assert.deepEqual(h.calls, [{ command, args: ['D:/中文目录 with spaces'] }])
  }
})

test('不存在的目录和文件不会启动文件管理器，启动失败可以反馈到界面', async () => {
  for (const [kind, message] of [['missing', /目录不存在/], ['file', /请选择文件夹/]]) {
    const h = opener('win32', null, kind)
    await assert.rejects(h.open('D:/target'), message)
    assert.deepEqual(h.calls, [])
  }
  await assert.rejects(opener('win32', Object.assign(new Error('not found'), { code: 'ENOENT' })).open('D:/target'), /not found/)
  await opener('win32', Object.assign(new Error('Explorer'), { code: 1 })).open('D:/target')
  await assert.rejects(opener('linux', Object.assign(new Error('xdg-open failed'), { code: 1 })).open('/target'), /xdg-open failed/)
})
