import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

// WSL 启动项的所有文件都在发行版里；这些 API 如果漏挡，homeDir() 会返回
// wsl:// 键，path.win32.join 会把它拼成相对路径并落到进程工作目录。
test('WSL scope 下本地文件路由统一返回 400，启动与会话状态接口仍可用', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wsl-guard-'))
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  process.env.PORT = String(port)
  const preset = {
    id: '0123456789abcdef', name: 'WSL 测试', version: 'auto', profile: 'web',
    backend: 'wsl', wslDistro: 'Fedora', wslHome: '~/.dsh',
  }
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: join(root, 'data'), dshHome: join(root, 'local-home'), profile: 'web', seedMarket: false,
    launchPresets: [preset],
  }))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { origin, 'content-type': 'application/json', 'x-dsh-launch-id': preset.id, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response, data: await response.json() }
  }
  const blocked = [
    ['/api/plugins?profile=web'],
    ['/api/plugin-profile?version=0.1.0&profile=web'],
    ['/api/launch-home/profiles'],
    // /api/profiles/* 现在转发给远端 core，不再属于“本地文件路由”。
    ['/api/recover?profile=web'],
    ['/api/recover', 'POST', { profile: 'web' }],
    ['/api/recover/restore', 'POST', { profile: 'web' }],
    ['/api/profile-backups?profile=web'],
    ['/api/profile-backups/snapshot', 'POST', { profile: 'web' }],
    ['/api/packs'],
    ['/api/packs/install', 'POST', { file: 'demo.dspack' }],
    ['/api/plugins/update', 'POST', { name: 'demo' }],
    ['/api/plugins/upgrade-incompatible', 'POST', {}],
    ['/api/desktop-enhance/install', 'POST', {}],
    ['/api/mcp'],
    ['/api/skills'],
    ['/api/sync'],
    ['/api/pick-dir', 'POST', {}],
    ['/api/dsh-homes/open', 'POST', { home: 'C:/tmp' }],
  ]
  for (const [path, method, body] of blocked) {
    const { response, data } = await call(path, method || 'GET', body)
    assert.equal(response.status, 400, path + ' 应被 WSL guard 拒绝：' + JSON.stringify(data))
    assert.match(data.error, /WSL/)
  }
  // x-dsh-home 的 wsl:// 分支也要进同一个 guard（不依赖启动项 id）。
  const wslHome = encodeURIComponent('wsl://Fedora/' + encodeURIComponent('~/.dsh'))
  const viaHome = await fetch(origin + '/api/plugins', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-dsh-home': wslHome },
    body: JSON.stringify({ profile: 'demo' }),
  })
  assert.equal(viaHome.status, 400)
  assert.match((await viaHome.json()).error, /WSL/)
  // 启动 / 设置接口不能误伤：WSL 实例还要靠它们工作。
  for (const path of ['/api/settings']) {
    const { response, data } = await call(path)
    assert.equal(response.status, 200, path + ' 应保持可用：' + JSON.stringify(data))
  }
  // 带启动项作用域的 /api/state 现在转发给远端 core；发行版不存在时报远端错误，
  // 而不是被本地文件路由 guard 挡成 400。
  const scopedState = await call('/api/state')
  assert.notEqual(scopedState.response.status, 400)
  assert.match(JSON.stringify(scopedState.data), /Fedora|WSL/)
  // 兼容性检查也走远端 core：不能被本地文件路由 guard 挡成 400。
  const compatibility = await call('/api/plugins/check-compatibility', 'POST', { version: '0.2.0', profile: 'web' })
  assert.notEqual(compatibility.response.status, 400)
  assert.match(JSON.stringify(compatibility.data), /Fedora|WSL/)
  // 本机启动项照常能读整合包。
  const local = await fetch(origin + '/api/packs', { headers: { origin } })
  assert.equal(local.status, 200)
})
