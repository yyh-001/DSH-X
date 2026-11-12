// WSL ↔ Windows 路径转换：目录选择器靠它把原生对话框选的路径写回 Linux 路径。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { wslPath } from '../src/wsl.js'

const distroOf = (args) => {
  const index = args.indexOf('-d')
  return index >= 0 ? args[index + 1] : ''
}
const scriptOf = (args) => args[args.length - 1]

test('toWindows：把 Linux 路径（含 ~）转成原生对话框能用的 Windows 路径', async () => {
  const calls = []
  const run = (args) => {
    calls.push([distroOf(args), scriptOf(args), args])
    return { ok: true, stdout: '\\\\wsl.localhost\\Debian\\root\r\n', stderr: '' }
  }
  assert.equal(await wslPath('Debian', '~/.dsh', 'windows', run), '\\\\wsl.localhost\\Debian\\root')
  assert.equal(calls[0][0], 'Debian')
  assert.match(calls[0][1], /p='~\/\.dsh'/, '先把值安全地放进脚本')
  assert.ok(calls[0][1].includes('$HOME'), '~ 交给远端 shell 用 $HOME 展开')
  assert.ok(calls[0][1].includes('${p#\\~}'), '展开只替换开头的 ~')
  assert.ok(calls[0][1].includes('wslpath -w "$p"'))
  assert.ok(calls[0][2].includes('--exec'), '脚本走 --exec，$ 变量不会被 wsl.exe 吃掉')
})

test('打开 WSL 目录的路由：先转成 Windows 路径，再交给文件管理器', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = server.indexOf("'/api/wsl/open'")
  assert.ok(start >= 0, '服务端要有 /api/wsl/open')
  const end = server.indexOf("'/api/wsl/path'", start)
  assert.ok(end > start, '/api/wsl/open 排在 /api/wsl/path 前面')
  const block = server.slice(start, end)
  assert.match(block, /wslPath\(distro, home, 'windows', \{ user \}\)/, 'wsl:// 键不能直接当 Windows 路径：先 wslpath -w')
  assert.match(block, /await openDirectory\(dir\)/, '转换后交给系统文件管理器')
})

test('toLinux：Windows / UNC 路径转回 Linux 路径', async () => {
  const calls = []
  const run = (args) => {
    calls.push([distroOf(args), scriptOf(args)])
    return { ok: true, stdout: '/root/projects/demo\n', stderr: '' }
  }
  assert.equal(await wslPath('Debian', '\\\\wsl.localhost\\Debian\\root\\projects\\demo', 'linux', run), '/root/projects/demo')
  assert.match(calls[0][1], /wslpath -a -u '\\\\wsl\.localhost\\Debian\\root\\projects\\demo'/)
})

test('空路径直接返回空串；没有发行版 / 转换失败要报错', async () => {
  assert.equal(await wslPath('Debian', '', 'linux', () => { throw new Error('不该调用') }), '')
  await assert.rejects(wslPath('', '/root', 'linux', () => ({ ok: true, stdout: '' })), /先选择一个 WSL 发行版/)
  await assert.rejects(wslPath('Debian', '/root', 'windows', () => ({ ok: false, stderr: 'boom' })), /boom/)
  await assert.rejects(wslPath('Debian', '/root', 'windows', () => ({ ok: true, stdout: '' })), /路径转换失败/)
})

test('readWslProfile：读回依赖和 bundles，没挂载的插件标出来', async () => {
  const { readWslProfile } = await import('../src/wsl.js')
  const manifest = JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'fake-plugin-a': '1.0.0', '@deepseek-ai/dsh-base': '0.2.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const run = (args) => {
    assert.match(scriptOf(args), /profiles\/\$p\/package\.json/)
    return { ok: true, stdout: manifest, stderr: '' }
  }
  const data = await readWslProfile('Debian', '~/.dsh', 'web', run)
  assert.equal(data.ok, true)
  assert.deepEqual(data.plugins.map((item) => [item.name, item.version, item.mounted]), [
    ['@deepseek-ai/dsh-base', '0.2.0', true],
    ['fake-plugin-a', '1.0.0', false],
  ])
  const missing = await readWslProfile('Debian', '~/.dsh', 'web', () => ({ ok: true, stdout: '__DSHX_MISSING__\n', stderr: '' }))
  assert.equal(missing.ok, false)
  await assert.rejects(readWslProfile('', '~/.dsh', 'web', run), /先选择一个 WSL 发行版/)
})

test('removeWslProfile：在发行版里删 Profile 目录；没初始化 / 执行失败都如实返回', async () => {
  const { removeWslProfile } = await import('../src/wsl.js')
  const calls = []
  const run = (args) => {
    calls.push([distroOf(args), scriptOf(args)])
    return { ok: true, stdout: '__DSHX_REMOVED__\n', stderr: '' }
  }
  assert.deepEqual(await removeWslProfile('Debian', '~/.dsh', 'web', run), { ok: true, profile: 'web' })
  assert.match(calls[0][1], /profiles\/\$p/, '按 profile 目录删')
  assert.match(calls[0][1], /rm -rf -- "\$d"/, '只删这个目录，名字已由 safeProfile 校验')
  const missing = await removeWslProfile('Debian', '~/.dsh', 'web', () => ({ ok: true, stdout: '__DSHX_MISSING__\n', stderr: '' }))
  assert.equal(missing.ok, false, '没有这份 Profile 时如实返回')
  await assert.rejects(removeWslProfile('', '~/.dsh', 'web', run), /先选择一个 WSL 发行版/)
  await assert.rejects(removeWslProfile('Debian', '~/.dsh', 'web', () => ({ ok: false, stderr: 'denied' })), /denied/)
})

test('删除 WSL Profile 的路由：本机路由、运行中先拦、删完让探测缓存失效', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  assert.match(server, /url\.pathname === '\/api\/wsl\/profile\/remove'/)
  assert.match(server, /proc\.backend === 'wsl' && proc\.distro === distro && proc\.profile === profile/, '正在跑的实例先拦住')
  assert.match(server, /if \(result\.ok\) invalidateWslCache\(\)/, '删完刷新 WSL 探测缓存')
  assert.match(server, /'\/api\/wsl\/profile\/remove',/, 'WSL 作用域的本地文件路由也挡住')
})
