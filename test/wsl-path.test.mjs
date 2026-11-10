// WSL ↔ Windows 路径转换：目录选择器靠它把原生对话框选的路径写回 Linux 路径。

import assert from 'node:assert/strict'
import test from 'node:test'

import { wslPath } from '../src/wsl.js'

test('toWindows：把 Linux 路径（含 ~）转成原生对话框能用的 Windows 路径', async () => {
  const calls = []
  const run = (distro, script) => {
    calls.push([distro, script])
    return { ok: true, stdout: '\\\\wsl.localhost\\Debian\\root\r\n', stderr: '' }
  }
  assert.equal(await wslPath('Debian', '~/.dsh', 'windows', run), '\\\\wsl.localhost\\Debian\\root')
  assert.equal(calls[0][0], 'Debian')
  assert.match(calls[0][1], /p='~\/\.dsh'/, '先把值安全地放进脚本')
  assert.ok(calls[0][1].includes('$HOME'), '~ 交给远端 shell 用 $HOME 展开')
  assert.ok(calls[0][1].includes('${p#\\~}'), '展开只替换开头的 ~')
  assert.ok(calls[0][1].includes('wslpath -w "$p"'))
})

test('toLinux：Windows / UNC 路径转回 Linux 路径', async () => {
  const calls = []
  const run = (distro, script) => {
    calls.push([distro, script])
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
  const run = (distro, script) => {
    assert.match(script, /profiles\/\$p\/package\.json/)
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
