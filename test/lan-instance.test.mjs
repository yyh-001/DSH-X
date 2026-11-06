/**
 * 局域网模式的实例生命周期：走管理页真实的 HTTP 接口，用假 dsh。
 *
 * 钉住：dsh 仍收到 --host 127.0.0.1；每个实例在「局域网 IP + 同一端口」上有自己的代理，
 * 停止 / 重启 / 多开各自起停；局域网地址被占时实例照常跑、界面拿到原因；回环模式不起代理。
 * 没有局域网 IPv4 的机器（部分 CI）整个文件跳过。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pickLanAddress } from '../src/lan-proxy.js'

const LAN = pickLanAddress()
const skip = !LAN && '这台机器没有局域网 IPv4'

// 和 multi-instance 同一只假 dsh，另外把收到的 argv 用 /argv 回给测试
const FAKE_DSH = `import { createServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// 桌面增强会调 \`dsh plugin add\`：假 dsh 只负责起服务，插件命令直接成功退出。
if (process.argv.includes('plugin')) process.exit(0)
if (process.env.DSH_TEST_START_GATE) {
  const profile = process.argv.includes('--profile') ? process.argv[process.argv.indexOf('--profile') + 1] : process.argv[2]
  const marker = join(process.env.DSH_TEST_START_GATE, process.env.DSH_VERSION + '-' + profile)
  writeFileSync(marker + '.started', '')
  while (!existsSync(marker + '.release')) await new Promise(resolve => setTimeout(resolve, 20))
}
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(req.url === '/argv' ? JSON.stringify(process.argv.slice(2)) : req.url === '/home' ? process.env.DSH_HOME : '<!doctype html><html><body>fake dsh</body></html>')
})
const portAt = process.argv.indexOf('--port')
srv.listen(portAt >= 0 ? Number(process.argv[portAt + 1]) : 0, '127.0.0.1', () => {
  const { port } = srv.address()
  console.log(\`dsh web: http://127.0.0.1:\${port}/?token=fake\`)
})
`

const A = '0.1.6'
const B = '0.1.7'

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 局域网地址上这个端口有没有人在听。 */
function lanListening(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.listen({ port, host: LAN, exclusive: true }, () => probe.close(() => resolve(false)))
  })
}

const appDir = mkdtempSync(join(tmpdir(), 'dsh-lan-'))
const APP = isolateUserHome(appDir)
const DATA = join(appDir, 'data')
const HOME = join(appDir, 'home')
process.env.APPDATA = appDir
process.env.PORT = String(await freePort())
mkdirSync(APP, { recursive: true })
mkdirSync(HOME, { recursive: true })
for (const version of [A, B]) {
  const lib = join(DATA, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE_DSH, 'utf8')
}
writeFileSync(join(APP, 'settings.json'), JSON.stringify({ dataDir: DATA, dshHome: HOME, profile: 'web', seedMarket: false, webBind: 'lan' }), 'utf8')

const { startServer, stopAll } = skip ? {} : await import('../src/server.js')
const base = skip ? '' : await startServer()

async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}
const instance = async (version) => (await api('/api/state')).instances.find((item) => item.version === version)
const portOf = (url) => Number(new URL(url).port)
/** 代理在就绪之后异步起来：等状态里出现 lanUrl 或 lanError。 */
async function settled(version) {
  for (let i = 0; i < 100; i += 1) {
    const item = await instance(version)
    if (item?.lanUrl || item?.lanError) return item
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return instance(version)
}

test.after(async () => {
  if (skip) return
  await stopAll()
  for (let i = 0; i < 10; i += 1) {
    try { rmSync(appDir, { recursive: true, force: true }); return } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
  }
})

test('局域网模式：dsh 仍绑回环，代理跟实例同端口，链接只换主机', { skip }, async () => {
  const { url } = await api('/api/start', { version: A })
  const argv = await (await fetch(new URL('/argv', url))).json()
  assert.deepEqual(argv.slice(argv.indexOf('--host'), argv.indexOf('--host') + 2), ['--host', '127.0.0.1'])
  const item = await settled(A)
  assert.equal(item.lanError, null)
  assert.equal(item.lanUrl, url.replace('127.0.0.1', LAN), '只换主机，端口和 token 不变')
  assert.equal(await lanListening(portOf(url)), true)
  const viaLan = await fetch(`http://${LAN}:${portOf(url)}/`)
  assert.equal(viaLan.status, 200, '局域网地址转发到这台实例')
})

test('多开各有一份代理；停一个只关它自己的', { skip }, async () => {
  const { url } = await api('/api/start', { version: B })
  const b = await settled(B)
  assert.ok(b.lanUrl)
  const portA = portOf((await instance(A)).url)
  await api('/api/stop', { version: A })
  assert.equal(await lanListening(portA), false, 'A 的代理随 A 关掉')
  assert.equal(await lanListening(portOf(url)), true, 'B 的代理还在')
  await api('/api/stop', { version: B })
  assert.equal(await lanListening(portOf(url)), false)
})

test('重启：旧代理关掉、新实例重新起代理', { skip }, async () => {
  await api('/api/start', { version: A })
  const before = await settled(A)
  await api('/api/restart', {})
  const after = await settled(A)
  assert.ok(after.lanUrl)
  assert.equal(await lanListening(portOf(after.url)), true)
  if (portOf(after.url) !== portOf(before.url)) assert.equal(await lanListening(portOf(before.url)), false)
  await api('/api/stop', { version: A })
})

test('局域网地址被占：实例照常运行，界面拿到 in-use 原因', { skip }, async () => {
  // 先起一次拿到这个组合会复用的端口，停掉后让别的程序占住它的局域网地址
  const { url } = await api('/api/start', { version: A })
  const port = portOf(url)
  await settled(A)
  await api('/api/stop', { version: A })
  const blocker = createServer()
  await new Promise((resolve) => blocker.listen(port, LAN, resolve))
  try {
    const again = await api('/api/start', { version: A })
    assert.equal(portOf(again.url), port, '自动端口复用到同一个')
    const item = await settled(A)
    assert.equal(item.status, 'running')
    assert.equal(item.lanUrl, '')
    assert.deepEqual(item.lanError, { code: 'in-use', address: `${LAN}:${port}` })
    assert.equal((await fetch(again.url.replace(/\?.*$/, ''))).status, 200, '本机回环照常可用')
  } finally {
    await api('/api/stop', { version: A })
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('回环模式：不起代理，也没有局域网链接', { skip }, async () => {
  await api('/api/settings', { webBind: 'loopback' })
  const { url } = await api('/api/start', { version: A })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const item = await instance(A)
  assert.equal(item.lanUrl, '')
  assert.equal(item.lanError, null)
  assert.equal(await lanListening(portOf(url)), false)
  await api('/api/stop', { version: A })
})
