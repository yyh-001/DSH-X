import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('连接 API：保存/脱敏/删除保护，SSH 密码只存密文', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-connections-'))
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  process.env.PORT = String(port)
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: join(root, 'data'), dshHome: join(root, 'local-home'), profile: 'web', seedMarket: false,
  }))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, {
      method,
      headers: { origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response, data: await response.json() }
  }

  const wsl = await call('/api/connections', 'POST', { kind: 'wsl', name: 'Debian 开发', wslDistro: 'Debian', wslUser: 'root' })
  assert.equal(wsl.response.status, 200)
  const wslId = wsl.data.connection.id
  const ssh = await call('/api/connections', 'POST', {
    kind: 'ssh', name: '服务器', host: '127.0.0.1', port: 1, username: 'root',
    authType: 'password', password: 'super-secret',
  })
  assert.equal(ssh.response.status, 200)
  const sshId = ssh.data.connection.id
  assert.equal(ssh.data.connection.hasPassword, true)
  assert.equal('passwordSecret' in ssh.data.connection, false, '响应不下发密文')

  const listed = await call('/api/connections')
  assert.equal(listed.data.connections.length, 2)
  assert.ok(listed.data.connections.every((item) => !('passwordSecret' in item)))
  const snapshot = await call('/api/state')
  assert.deepEqual(snapshot.data.connectionRuntime, {}, '连接运行时默认是空表')
  assert.deepEqual(snapshot.data.connectionPrepares, [], '连接准备进度默认是空列表')

  const stored = JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8'))
  const storedSsh = stored.connections.find((item) => item.id === sshId)
  assert.match(storedSsh.passwordSecret, /^v1:/, '密码加密存放')
  assert.equal(JSON.stringify(stored).includes('super-secret'), false, 'settings 里没有明文密码')

  // 只改名字时保留密码；类型不允许中途改
  const renamed = await call('/api/connections', 'POST', { id: sshId, kind: 'ssh', name: '服务器 2', host: '127.0.0.1', port: 1, username: 'root', authType: 'password' })
  assert.equal(renamed.response.status, 200)
  assert.equal(renamed.data.connection.hasPassword, true)
  assert.match(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8')).connections.find((item) => item.id === sshId).passwordSecret, /^v1:/)
  const kindChange = await call('/api/connections', 'POST', { id: sshId, kind: 'wsl', wslDistro: 'Debian' })
  assert.equal(kindChange.response.status, 400)
  assert.match(kindChange.data.error, /类型/)

  // SSH 连不上时给原因码，而不是 500
  const failed = await call('/api/connections/test', 'POST', { id: sshId })
  assert.equal(failed.response.status, 400)
  assert.equal(failed.data.code, 'ssh-unreachable')

  // 有启动项引用时不能删连接
  const preset = await call('/api/launch-presets', 'POST', {
    name: 'WSL 连接项', version: 'auto', profile: 'web', port: 0,
    backend: 'wsl', connectionId: wslId, remoteHome: '~/.dsh',
  })
  assert.equal(preset.response.status, 200)
  const blocked = await call('/api/connections/remove', 'POST', { id: wslId })
  assert.equal(blocked.response.status, 400)
  assert.match(blocked.data.error, /启动项/)
  await call('/api/launch-presets/remove', 'POST', { id: preset.data.entry.id })
  const removed = await call('/api/connections/remove', 'POST', { id: wslId })
  assert.equal(removed.response.status, 200)
})
