import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

// 钉端口只改设置、不碰 wsl.exe，所以能在任何平台上真起一份管理页服务来测。
test('WSL 固定端口按完整目录键存：同一组合可以重复钉，同发行版的两个目录各钉各的，老的按发行版存的钉子会挪过来', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wsl-ports-'))
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  process.env.PORT = String(port)
  const wslPreset = (id, name, wslHome, extra = {}) => ({
    id: id.repeat(16), name, version: '0.2.2', profile: 'web', backend: 'wsl', wslDistro: 'Fedora', wslHome, ...extra,
  })
  const homeA = wslPreset('a', 'WSL 默认目录', '~/.dsh')
  const homeB = wslPreset('b', 'WSL 第二个目录', '/data/dsh')
  // 设置同步把 Windows 上勾了自动启动的 WSL 启动项带到 mac / Linux：这里只能跳过。
  // Windows 上真有 wsl.exe，不在这里起它。
  const syncedAuto = process.platform === 'win32' ? [] : [wslPreset('c', '同步来的 WSL', '~/.dsh', { autoLaunch: true, profile: 'tui' })]
  const settingsFile = join(app, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({
    dataDir: join(root, 'data'), dshHome: join(root, 'local-home'), profile: 'web', seedMarket: false, proxyMode: 'off',
    launchPresets: [homeA, homeB, ...syncedAuto],
    // 老写法：整个发行版一份
    wslPorts: { Fedora: { '0.2.2@web': 47101, '0.2.1@web': 47109 } },
  }))
  const server = await import('../src/server.js')
  const { wslHomeKey } = await import('../src/wsl.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const pin = async (preset, value) => {
    const response = await fetch(origin + '/api/instance-port', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-dsh-launch-id': preset.id },
      body: JSON.stringify({ version: '0.2.2', profile: 'web', port: value }),
    })
    return { status: response.status, data: await response.json() }
  }
  const stored = () => JSON.parse(readFileSync(settingsFile, 'utf8')).wslPorts || {}
  const keyA = wslHomeKey('Fedora', '~/.dsh')
  const keyB = wslHomeKey('Fedora', '/data/dsh')

  // 老表里同一个组合的钉子算自己的：钉同一个端口不报「已经钉给」，而是挪到目录键下。
  const migrated = await pin(homeA, 47101)
  assert.equal(migrated.status, 200, JSON.stringify(migrated.data))
  assert.deepEqual(stored()[keyA], { '0.2.2@web': 47101 })
  assert.deepEqual(stored().Fedora, { '0.2.1@web': 47109 }, '只挪这一个组合，老表里别的钉子留着')

  // 以前每次启动都会用同一个端口重钉一次，然后被「已经钉给 0.2.2@web（wsl://Fedora）」拦下。
  const again = await pin(homeA, 47101)
  assert.equal(again.status, 200, JSON.stringify(again.data))

  // 同一个发行版的另一个目录：端口号已经被 A 钉了，要拒绝并说清是哪个目录。
  const clash = await pin(homeB, 47101)
  assert.notEqual(clash.status, 200)
  assert.match(clash.data.error, /端口 47101 已经钉给 0\.2\.2@web（WSL Fedora · ~\/\.dsh）/)
  // 老表里别的组合钉着的端口照旧挡住。
  const legacyClash = await pin(homeB, 47109)
  assert.notEqual(legacyClash.status, 200)
  assert.match(legacyClash.data.error, /47109/)

  // 换一个端口：两个目录各钉各的，不再共用一份。
  const own = await pin(homeB, 47102)
  assert.equal(own.status, 200, JSON.stringify(own.data))
  assert.deepEqual(stored()[keyA], { '0.2.2@web': 47101 })
  assert.deepEqual(stored()[keyB], { '0.2.2@web': 47102 })

  // 取消钉：目录键和老表里这个组合都要清掉，否则老钉子会从兜底里「复活」。
  const cleared = await pin(homeA, 0)
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data))
  assert.equal(keyA in stored(), false)
  assert.deepEqual(stored()[keyB], { '0.2.2@web': 47102 })

  if (syncedAuto.length) {
    const deadline = Date.now() + 5000
    let logs = ''
    while (Date.now() < deadline) {
      logs = await (await fetch(origin + '/api/logs/export', { headers: { origin } })).text()
      if (logs.includes('同步来的 WSL')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.match(logs, /自动启动「同步来的 WSL」已跳过：这是 WSL 启动项/)
    assert.doesNotMatch(logs, /ENOENT/)
  }
})
