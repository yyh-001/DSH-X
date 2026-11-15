import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('旧 WSL 启动项读取时自动补出稳定连接，并回填 connectionId/remoteHome', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-connection-migration-'))
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
    launchPresets: [
      {
        id: 'aaaaaaaaaaaaaaaa', name: '旧 WSL', version: 'auto', profile: 'web',
        backend: 'wsl', wslDistro: 'Debian', wslHome: '~/.dsh-work', wslUser: 'root',
      },
      { id: 'bbbbbbbbbbbbbbbb', name: '本机', version: 'auto', profile: 'web' },
    ],
  }))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const state = await (await fetch(origin + '/api/state', { headers: { origin } })).json()
  assert.equal(state.connections.length, 1, '只给旧 WSL 启动项补连接')
  const connection = state.connections[0]
  assert.equal(connection.kind, 'wsl')
  assert.equal(connection.wslDistro, 'Debian')
  assert.equal(connection.wslUser, 'root')
  const preset = state.launchPresets.find((item) => item.name === '旧 WSL')
  assert.equal(preset.connectionId, connection.id)
  assert.equal(preset.remoteHome, '~/.dsh-work')
  assert.equal(preset.wslHome, '~/.dsh-work', '旧字段仍可读')
  assert.ok(!state.launchPresets.find((item) => item.name === '本机').connectionId, '本机启动项不受影响')
})
