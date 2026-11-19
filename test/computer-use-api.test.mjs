/**
 * Computer Use 核心桥接与管理页接口（/api/desktop/computer、/api/computer-use/*、默认开启）。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('Computer Use 核心桥接、默认开启、急停转发与设置页元素', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-computer-use-api-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const calls = []
  let halted = false
  server.setHost({
    desktop: {
      info: () => ({
        theme: 'dark',
        versions: { shell: '0.1.27', electron: '44.7.0' },
        computer: { available: true, enabled: true, halted, running: false, shortcut: 'Control+Alt+Backspace' },
      }),
      computer: async (request) => {
        calls.push(request)
        if (request.op === 'stop') { halted = true; return { available: true, halted: true } }
        if (request.op === 'resume') { halted = false; return { available: true, halted: false } }
        if (request.op === 'clearAudit') return { ok: true, count: 0 }
        if (request.op === 'status') return { available: true, halted, running: false, audit: [] }
        return { result: { echoed: request.method } }
      },
    },
  })

  // 默认开启：capabilities 含 computer，computer.enabled 为 true 且 dshEnv 注 DSH_X_COMPUTER_USE=1
  const desktopInfo = await (await fetch(`${base}/api/desktop`)).json()
  assert.ok(desktopInfo.capabilities.includes('computer'))
  assert.equal(desktopInfo.computer.enabled, true)
  assert.equal(server.dshEnv('0.2.2-rc.4').DSH_X_COMPUTER_USE, '1')

  // 显式关闭后再开启：关闭立即触发 stop(disabled) 并撤掉 DSH_X_COMPUTER_USE，开启后恢复
  const disabledRes = await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ computerUse: false }),
  })).json()
  assert.equal(disabledRes.computerUse, false)
  assert.equal(disabledRes.computerHost, true)
  assert.equal('DSH_X_COMPUTER_USE' in server.dshEnv('0.2.2-rc.4'), false)
  assert.ok(calls.some((call) => call.op === 'stop' && call.reason === 'disabled'))

  const enabledRes = await (await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ computerUse: true }),
  })).json()
  assert.equal(enabledRes.computerUse, true)
  assert.equal(server.dshEnv('0.2.2-rc.4').DSH_X_COMPUTER_USE, '1')

  // RPC 桥接与校验
  const rpcOk = await (await fetch(`${base}/api/desktop/computer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'rpc', sessionId: 's1', id: '1', method: 'listApps', params: {} }),
  })).json()
  assert.equal(rpcOk.ok, true)
  assert.equal(rpcOk.result.echoed, 'listApps')

  const rpcBad = await fetch(`${base}/api/desktop/computer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'unknown' }),
  })
  assert.equal(rpcBad.status, 400)

  // 管理页急停 / 恢复
  const stopped = await (await fetch(`${base}/api/computer-use/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{}',
  })).json()
  assert.equal(stopped.halted, true)

  const resumed = await (await fetch(`${base}/api/computer-use/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{}',
  })).json()
  assert.equal(resumed.halted, false)

  // 关掉设置时自动下发 stop(disabled)
  await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ computerUse: false }),
  })
  assert.ok(calls.some((call) => call.op === 'stop' && call.reason === 'disabled'))

  // 电脑操作插件与桌面增强分开，从「加入插件」弹窗添加，不放在设置页或编辑启动项里
  const { COMPUTER_USE_PLUGIN, DESKTOP_PLUGINS } = await import('../src/desktop-plugins.js')
  assert.equal(DESKTOP_PLUGINS.some((plugin) => plugin.name === 'dsh-x-computer-use'), false)
  assert.equal(COMPUTER_USE_PLUGIN.name, 'dsh-x-computer-use')
  const removedInstall = await fetch(`${base}/api/computer-use/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{}',
  })
  assert.equal(removedInstall.status, 404)

  // 设置页已默认直接启用电脑操作、不再展示手动开关面板；加入插件弹窗仍提供入口
  const html = read('src/public/index.html')
  const envPage = read('src/public/environments-page.js')
  assert.doesNotMatch(html, /id="computerUse"|id="computerUseInstall"|id="computerUseStop"|id="computerUseAuditList"|id="computerUseBoundaryHint"/)
  assert.match(html, /id="environmentAddMarket"/)
  assert.match(envPage, /dsh-x-computer-use/)
})
