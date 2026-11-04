/**
 * 只从管理器 HTTP / shutdown 生命周期边界观察，不依赖重连的内部实现。
 * EP：普通启动、同进程换 token、脱离 stdio 的替代进程、显式终止。
 * BVA：0/1/3 次重启；替代进程在旧进程退出之前 / 之后就绪。
 * 决策表：仍需运行 + 有替代进程 => 自动附着；已停止/退出 => 不得复活。
 * 状态迁移：运行→替代→运行→再次替代；运行/等待替代→停止/退出。
 * 假 dsh 复现市场插件的 detached helper、相同 argv/env/cwd、独立日志和 SIGTERM，
 * 不给管理器发测试专用事件；认证必须真的通过 HTTP，不能只检查 URL 上有 token。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const C = Object.freeze({ versions: ['0.1.6', '0.1.7'], pollMs: 25, deadlineMs: 10000, quietMs: 700, leaseMs: 120, cycles: 3 })
const root = mkdtempSync(join(tmpdir(), 'dsh-self-restart-'))
const app = isolateUserHome(root)
const data = join(root, 'data')
const home = join(root, 'session home')
const ledger = join(root, 'processes')
for (const dir of [app, home, ledger]) mkdirSync(dir, { recursive: true })
process.env.DSH_TEST_RESTART_ROOT = root

const FAKE = String.raw`
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
if (process.argv.includes('plugin')) process.exit(0)
const root = process.env.DSH_TEST_RESTART_ROOT
const recordPath = join(root, 'processes', process.pid + '.json')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const generation = Number(process.env.DSH_TEST_GENERATION || 0)
const record = value => {
  writeFileSync(recordPath + '.next', JSON.stringify({ pid: process.pid, ...value }))
  renameSync(recordPath + '.next', recordPath)
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
if (process.env.DSH_TEST_ROLE === 'helper') {
  const handoff = JSON.parse(process.env.DSH_TEST_HANDOFF)
  record({ role: 'helper', handoff })
  writeFileSync(join(root, handoff.id + '.armed'), '')
  if (handoff.mode !== 'early') while (alive(handoff.oldPid)) await delay(10)
  if (handoff.mode === 'held') while (!existsSync(join(root, handoff.id + '.release'))) await delay(10)
  const out = openSync(join(root, handoff.id + '.out.log'), 'a')
  const err = openSync(join(root, handoff.id + '.err.log'), 'a')
  const child = spawn(process.execPath, JSON.parse(process.env.DSH_TEST_BOOT_ARGS), {
    cwd: process.cwd(), detached: true, stdio: ['ignore', out, err], windowsHide: true,
    env: { ...process.env, DSH_TEST_ROLE: 'server', DSH_TEST_GENERATION: String(generation + 1),
      DSH_TEST_PORT: handoff.mode === 'early' ? '0' : String(handoff.port), DSH_TEST_READY: handoff.id },
  })
  child.unref()
  closeSync(out); closeSync(err)
  if (handoff.mode === 'early') {
    while (!existsSync(join(root, handoff.id + '.ready'))) await delay(10)
    try { process.kill(handoff.oldPid, 'SIGTERM') } catch {}
  }
  process.exit(0)
}
const profileAt = process.argv.indexOf('--profile')
const reserved = process.argv[1]?.endsWith('reserved-profile-boot.mjs')
const profile = profileAt >= 0 ? process.argv[profileAt + 1] : process.argv[reserved ? 3 : 2]
const version = process.env.DSH_VERSION
const sessionDir = join(process.env.DSH_HOME, 'sessions')
mkdirSync(sessionDir, { recursive: true })
const sessionPath = join(sessionDir, version + '-' + profile + '.json')
if (!existsSync(sessionPath)) writeFileSync(sessionPath, JSON.stringify({ id: randomUUID(), messages: ['before restart'] }))
let token = randomUUID()
let url
function announce() {
  url = 'http://127.0.0.1:' + srv.address().port + '/?token=' + token
  record({ role: 'server', version, profile, home: process.env.DSH_HOME, generation, url })
  console.log('dsh web: ' + url)
}
const srv = createServer((req, res) => {
  const target = new URL(req.url, 'http://127.0.0.1')
  const authorized = target.searchParams.get('token') === token || req.headers.cookie === 'dsh-test=' + token
  if (!authorized) { res.writeHead(401); res.end('invalid token'); return }
  res.setHeader('set-cookie', 'dsh-test=' + token + '; Path=/; HttpOnly')
  if (target.pathname === '/test/session') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version, profile, home: process.env.DSH_HOME, pid: process.pid, generation,
      session: JSON.parse(readFileSync(sessionPath, 'utf8')) }))
  } else if (target.pathname === '/test/rotate') {
    token = randomUUID(); announce(); res.end('rotated')
  } else if (target.pathname === '/test/restart') {
    const id = randomUUID()
    const mode = target.searchParams.get('mode') || 'late'
    const handoff = { id, mode, oldPid: process.pid, port: srv.address().port }
    const helper = spawn(process.execPath, ['-e', 'import(' + JSON.stringify(pathToFileURL(reserved ? process.argv[2] : process.argv[1]).href) + ')'], {
      cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, DSH_TEST_ROLE: 'helper', DSH_TEST_HANDOFF: JSON.stringify(handoff),
        DSH_TEST_BOOT_ARGS: JSON.stringify([...process.execArgv, ...process.argv.slice(1)]) },
    })
    helper.unref()
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(handoff))
    if (mode !== 'early') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 40)
  } else {
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body>authenticated DSH</body></html>')
  }
})
process.on('SIGTERM', () => { srv.close(() => process.exit(0)); srv.closeAllConnections() })
const portAt = process.argv.indexOf('--port')
record({ role: 'server', version, profile, home: process.env.DSH_HOME, generation })
srv.listen(Number(process.env.DSH_TEST_PORT ?? (portAt < 0 ? 0 : process.argv[portAt + 1])), '127.0.0.1', () => {
  announce()
  if (process.env.DSH_TEST_READY) writeFileSync(join(root, process.env.DSH_TEST_READY + '.ready'), '')
})
`

for (const version of C.versions) {
  const lib = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'bin.js'), FAKE)
}
writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
process.env.PORT = String(probe.address().port)
await new Promise(resolve => probe.close(resolve))
const { createInstanceLink } = await import('../src/instance-link.js')
const { startServer, stopAll, shutdown } = await import('../src/server.js')
const base = await startServer()
let managerClosed = false
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const records = () => readdirSync(ledger).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(ledger, name), 'utf8')))
async function api(path, body, launchId = '') {
  const response = await fetch(base + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(launchId ? { 'x-dsh-launch-id': launchId } : {}) },
    signal: AbortSignal.timeout(C.deadlineMs),
  })
  const value = await response.json()
  assert.ok(response.ok, value.error || 'manager request failed')
  return value
}
async function until(check, message) {
  const end = Date.now() + C.deadlineMs
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await pause(C.pollMs)
  }
  assert.fail(message)
}
async function fake(url, path, params = {}) {
  const target = new URL(url)
  target.pathname = path
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return fetch(target, { signal: AbortSignal.timeout(C.deadlineMs) })
}
async function session(url) {
  const response = await fake(url, '/test/session')
  assert.equal(response.status, 200, 'manager-issued URL must authenticate against the actual current fake token')
  return response.json()
}
async function start(version = C.versions[0], profile = 'web', launchId = '') {
  const started = await api('/api/start', { version, profile }, launchId)
  return { url: started.url, identity: await session(started.url) }
}
async function restart(item, mode = 'late') {
  const response = await fake(item.url, '/test/restart', { mode })
  assert.equal(response.status, 200)
  const handoff = await response.json()
  await until(() => existsSync(join(root, handoff.id + '.armed')), 'detached helper must start')
  return handoff
}
async function attached(previous) {
  return until(async () => {
    const snap = await api('/api/state')
    const matches = snap.instances.filter(item => item.version === previous.identity.version && item.profile === previous.identity.profile && item.home === previous.identity.home)
    assert.ok(matches.length <= 1, 'one manager instance per version/profile/home')
    const current = matches[0]
    if (current?.status !== 'running' || !current.url || current.url === previous.url) return false
    const response = await fake(current.url, '/test/session').catch(() => null)
    if (!response || response.status !== 200) return false
    return { url: current.url, identity: await response.json() }
  }, 'self-restart must automatically publish a fresh authenticated URL for the same managed identity (no user start action)')
}
async function noOrphans() {
  const snap = await api('/api/state')
  for (const process of records().filter(item => item.role === 'server' && alive(item.pid))) {
    const managed = snap.instances.find(item => item.url === process.url && item.status === 'running')
    assert.ok(managed, 'every live fake server must remain accessible through a managed instance')
    assert.equal((await session(managed.url)).pid, process.pid)
  }
}
function sameSession(before, after) {
  for (const key of ['version', 'profile', 'home']) assert.equal(after.identity[key], before.identity[key], key + ' must survive restart')
  assert.deepEqual(after.identity.session, before.identity.session, 'the same persisted session must remain accessible')
  assert.notEqual(new URL(after.url).searchParams.get('token'), new URL(before.url).searchParams.get('token'), 'restart must not reuse the expired token')
}
async function stopped() {
  if (!managerClosed) await until(async () => (await api('/api/state')).instances.length === 0, 'explicit stop must remove managed instances')
  await until(() => records().filter(item => item.role === 'server').every(item => !alive(item.pid)), 'no live inaccessible fake server may remain after stop/shutdown')
  await pause(C.quietMs)
  if (!managerClosed) assert.equal((await api('/api/state')).instances.length, 0, 'explicit stop must not resurrect instances')
  assert.ok(records().filter(item => item.role === 'server').every(item => !alive(item.pid)), 'no successor may resurrect after explicit stop')
}
async function cleanup() {
  if (!managerClosed) await api('/api/stop', {})
  // 只杀本测试私有目录里由假进程登记的 PID，绝不扫描/重启真实用户实例。
  for (const item of records()) if (alive(item.pid)) { try { process.kill(item.pid, 'SIGKILL') } catch {} }
  await until(() => records().every(item => !alive(item.pid)), 'fixture processes must terminate')
}
test.beforeEach(async () => {
  if (managerClosed) { await startServer(); managerClosed = false }
})
test.afterEach(cleanup)
test.after(async () => {
  await cleanup()
  await stopAll()
  delete process.env.DSH_TEST_RESTART_ROOT
  rmSync(root, { recursive: true, force: true })
})

// 协议边界单测使用短租约，不让集成测试为正式启动预算等待两分钟。
async function protocolLink(options = {}) {
  const entry = join(data, 'versions', C.versions[0], 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let adoptions = 0
  let disposals = 0
  const link = await createInstanceLink({ entry, profile: 'web', timeoutMs: C.leaseMs,
    onSuccessor: () => { adoptions += 1 }, onDispose: () => { disposals += 1 }, ...options })
  return { link, entry, config: JSON.parse(Object.values(link.env)[0]), adoptions: () => adoptions, disposals: () => disposals }
}
async function rejectedFrame(port, frame) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('invalid frame was not rejected')) }, C.deadlineMs)
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(timer); resolve() })
    socket.on('connect', () => socket.write(frame + '\n'))
  })
}
async function linkedFake(fixture) {
  const child = spawn(process.execPath, ['--require', fileURLToPath(new URL('../src/compat/instance-link.cjs', import.meta.url)), fixture.entry, 'web', '--port', '0'], {
    cwd: home, env: { ...process.env, ...fixture.link.env, DSH_HOME: home, DSH_VERSION: C.versions[0] }, stdio: 'ignore',
  })
  await until(() => records().some(item => item.pid === child.pid && item.url), 'linked fake must start')
  return child
}

test('EP/security: unauthenticated null, primitive, array and malformed frames do not crash or hijack manager', async () => {
  const original = await start()
  const fixture = await protocolLink()
  fixture.link.bind({ pid: process.pid })
  try {
    for (const frame of ['null', 'true', '1', '"text"', '[]', '{}', '{invalid', JSON.stringify({ secret: 'wrong', pid: process.pid })]) {
      await rejectedFrame(fixture.config.port, frame)
      assert.equal(fixture.adoptions(), 0)
      assert.deepEqual(await session(original.url), original.identity)
      assert.equal((await api('/api/state')).instances.length, 1)
    }
  } finally { fixture.link.revoke() }
})

test('BVA/state: expired successor lease disposes its listener and rejects a late fake process', async () => {
  const fixture = await protocolLink()
  const old = { pid: process.pid }
  fixture.link.bind(old)
  fixture.link.exited(old)
  try {
    await until(() => fixture.disposals() === 1, 'expired lease must dispose its listener')
    const child = await linkedFake(fixture)
    await until(() => !alive(child.pid), 'late successor must shut down after expired capability')
    assert.equal(fixture.adoptions(), 0)
  } finally { fixture.link.revoke() }
})

test('State/decision table: early ready successor times out without stealing a still-live original or leaving an orphan', async () => {
  const fixture = await protocolLink({ timeoutMs: C.quietMs })
  fixture.link.bind({ pid: process.pid })
  try {
    const child = await linkedFake(fixture)
    await until(() => !alive(child.pid), 'early candidate must terminate when original never exits')
    assert.equal(fixture.adoptions(), 0)
    assert.ok(alive(process.pid), 'original owner must remain alive')
  } finally { fixture.link.revoke() }
})

test('EP/reserved profile: real desktop wrapper retains anchor and profile across detached self-restart', async () => {
  const version = C.versions[0]
  const packageDir = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh')
  const bootDir = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  mkdirSync(bootDir, { recursive: true })
  writeFileSync(join(bootDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', main: 'index.js' }))
  writeFileSync(join(bootDir, 'index.js'), 'export const loadLayeredEnv = () => ({})')
  writeFileSync(join(packageDir, 'lib', 'profile-boot.js'), "export async function runProfile() { await import('./bin.js') }")
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
  const first = await start(version, 'desktop')
  await restart(first)
  const next = await attached(first)
  sameSession(first, next)
  assert.equal(next.identity.profile, 'desktop')
  assert.notEqual(next.identity.pid, first.identity.pid)
  await api('/api/stop', { version, profile: 'desktop', home })
  await stopped()
})

test('EP/BVA zero restarts: ordinary attach preserves working authentication and session', async () => {
  const first = await start()
  const again = await start()
  assert.equal(again.url, first.url)
  assert.deepEqual(again.identity, first.identity)
  const missing = new URL(first.url); missing.search = ''
  assert.equal((await fetch(missing)).status, 401, 'fake authentication must reject missing credentials')
  missing.searchParams.set('token', 'stale-invalid-token')
  assert.equal((await fetch(missing)).status, 401, 'fake authentication must reject wrong credentials')
  assert.equal((await api('/api/state')).instances.length, 1)
})

test('EP: same live process can announce rotated token without breaking attachment', async () => {
  const first = await start()
  assert.equal((await fake(first.url, '/test/rotate')).status, 200)
  const next = await attached(first)
  sameSession(first, next)
  assert.equal(next.identity.pid, first.identity.pid)
  assert.equal((await fake(first.url, '/test/session')).status, 401, 'expired token must actually be rejected')
})

for (const mode of ['late', 'early']) {
  test('BVA/state: detached successor ready ' + mode + ' relative to old exit attaches without user action', async () => {
    const first = await start()
    await restart(first, mode)
    const next = await attached(first)
    sameSession(first, next)
    assert.notEqual(next.identity.pid, first.identity.pid)
    await until(() => !alive(first.identity.pid), 'superseded process must exit')
    await noOrphans()
    assert.equal((await fake(next.url, '/test/session', { token: new URL(first.url).searchParams.get('token') })).status, 401)
    assert.equal((await api('/api/start', { version: first.identity.version, profile: first.identity.profile })).url, next.url, 'normal attach after automatic reattach must reuse the valid successor')
  })
}

test('BVA/state: three consecutive detached self-restarts retain one session and remain stoppable', async () => {
  let current = await start()
  for (let cycle = 0; cycle < C.cycles; cycle += 1) {
    const previous = current
    await restart(previous)
    current = await attached(previous)
    sameSession(previous, current)
    assert.equal(current.identity.generation, previous.identity.generation + 1)
    await until(() => !alive(previous.identity.pid), 'each superseded generation must exit')
    await noOrphans()
  }
  await api('/api/stop', { version: current.identity.version, profile: current.identity.profile, home: current.identity.home })
  await stopped()
})

test('Decision table/state: explicit stop of an ordinary session must not trigger resurrection', async () => {
  await start()
  await api('/api/stop', {})
  await stopped()
})

test('Decision table/state: explicit stop while detached replacement is pending forbids a live orphan', async () => {
  const first = await start()
  const handoff = await restart(first, 'held')
  await until(() => !alive(first.identity.pid), 'old process exits before successor is released')
  await api('/api/stop', { version: first.identity.version, profile: first.identity.profile, home: first.identity.home })
  writeFileSync(join(root, handoff.id + '.release'), '')
  await pause(C.quietMs)
  await stopped()
})

test('EP/isolation: restarting one instance does not rotate or stop other versions, profiles, or homes', async () => {
  const alternateHome = join(root, 'other home')
  const preset = await api('/api/launch-presets', { name: 'isolated', version: C.versions[0], profile: 'web', port: 0, dshHome: alternateHome })
  const profileDir = join(home, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
  const target = await start()
  const others = [await start(C.versions[1]), await start(C.versions[0], 'work'), await start(C.versions[0], 'web', preset.entry.id)]
  await restart(target)
  const next = await attached(target)
  sameSession(target, next)
  const snap = await api('/api/state')
  assert.equal(snap.instances.length, others.length + 1)
  await noOrphans()
  for (const other of others) {
    assert.deepEqual(await session(other.url), other.identity, 'unaffected instance keeps its token, process, home and session')
    assert.ok(snap.instances.some(item => item.url === other.url && item.status === 'running'))
    assert.equal((await fake(other.url, '/test/session', { token: new URL(next.url).searchParams.get('token') })).status, 401, 'tokens must not cross instance boundaries')
  }
  await api('/api/stop', { version: next.identity.version, profile: next.identity.profile, home: next.identity.home })
  await until(() => !alive(next.identity.pid), 'adopted successor must be controllable by explicit stop')
  for (const other of others) assert.deepEqual(await session(other.url), other.identity)
})

test('Decision table/state: manager shutdown terminates an already adopted detached successor', async () => {
  const first = await start()
  await restart(first)
  const next = await attached(first)
  sameSession(first, next)
  await shutdown()
  managerClosed = true
  await stopped()
})

test('Decision table/state: manager shutdown while replacement is pending cannot leave a resurrected server', async () => {
  const first = await start()
  const handoff = await restart(first, 'held')
  await until(() => !alive(first.identity.pid), 'old process exits before shutdown')
  await shutdown()
  managerClosed = true
  writeFileSync(join(root, handoff.id + '.release'), '')
  await pause(C.quietMs)
  await stopped()
})
