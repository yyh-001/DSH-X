/**
 * EP：原生根、已接管根、已连接但未接管的继任者；普通撤销 / 租约到期不能变成保活。
 * BVA：停止前已连接但未握手、emitState 的 await 前后、taskkill 完成前后。
 * 决策表：stop / stopAll × native / adopted / pending => 先拒绝入场，逐根树终止后才断管道；
 * revoke / expiry × 晚到继任者 => 拒绝连接且 preload 自行退出。
 * 状态迁移：运行→禁止继任→发状态→树终止中→断管道；运行→替代→再次停止。
 * macOS 无法执行 taskkill，所以只替换其 OS 边界；真实 TCP 和 preload 决定根是否仍然活着。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createInstanceLink } from '../src/instance-link.js'
import LINK from '../src/compat/instance-link.cjs'

const C = Object.freeze({ version: '0.1.6', profile: 'web', home: '/stop-order-home',
  deadlineMs: 5000, leaseMs: 2000, expiryMs: 80, pollMs: 10, quietMs: 100,
  url: 'http://127.0.0.1:43210/?token=stop-order' })
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const preload = fileURLToPath(new URL('../src/compat/instance-link.cjs', import.meta.url))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function until(check, message) {
  const end = Date.now() + C.deadlineMs
  while (!check()) {
    assert.ok(Date.now() < end, message)
    await delay(C.pollMs)
  }
}

function functionSource(name) {
  const start = source.indexOf('async function ' + name + '(')
  const end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start, name + ' must remain extractable')
  return source.slice(start, end)
}

async function fixture(t, kind = 'native', timeoutMs = C.leaseMs) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stop-order-'))
  const entry = join(dir, 'entry.cjs')
  const announce = 'console.log(' + JSON.stringify('dsh web: ' + C.url) + ')'
  writeFileSync(entry, 'setInterval(() => {}, 1000); ' +
    'if (process.env.DSH_TEST_DELAY_LINK) process.once("message", () => { require(' + JSON.stringify(preload) + '); ' + announce + ' }); else ' + announce)
  const children = []
  const sockets = []
  const adopted = []
  const disposed = deferred()
  const link = await createInstanceLink({ entry, profile: C.profile, timeoutMs,
    onSuccessor: child => adopted.push(child), onDispose: disposed.resolve })
  Object.assign(link, { version: C.version, profile: C.profile, home: C.home })
  const config = JSON.parse(link.env[LINK.env])
  const launch = (delayed = false) => {
    const child = spawn(process.execPath, [...(delayed ? [] : ['--require', preload]), entry, C.profile], {
      env: { ...process.env, [LINK.env]: link.env[LINK.env], DSH_TEST_DELAY_LINK: delayed ? '1' : '' },
      stdio: delayed ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
    })
    children.push(child)
    return child
  }
  t.after(async () => {
    link.revoke()
    for (const socket of sockets) socket.destroy()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')))
    rmSync(dir, { recursive: true, force: true })
  })
  const native = launch(kind === 'delayed-root')
  link.bind(native)
  if (kind === 'delayed-root') await once(native, 'spawn')
  else await until(() => native.readyLine, 'native lifecycle handshake accepted')
  let root = native
  if (kind === 'adopted') {
    native.kill('SIGKILL')
    await once(native, 'exit')
    link.exited(native)
    launch()
    await until(() => adopted.length === 1, 'successor adopted after old root exit')
    root = adopted[0]
  }
  let pending
  if (kind === 'pending') {
    launch()
    await until(() => link.pending().length === 1, 'connected successor is pending while native root lives')
    pending = link.pending()[0]
  }
  const record = child => ({ key: 'root', version: C.version, profile: C.profile,
    home: C.home, status: 'running', url: C.url, child, instanceLink: link })
  const queued = createConnection({ host: LINK.host, port: config.port })
  queued.on('error', () => {})
  sockets.push(queued)
  await once(queued, 'connect')
  // TCP connect 已完成不等于服务端已接收；留出一次事件循环，覆盖停止前排队的未认证连接。
  await delay(C.pollMs)
  return { link, config, root, pending, children, adopted, disposed, launch,
    proc: record(root), queued,
    async connectRoot() {
      native.send('connect')
      await until(() => native.readyLine, 'current root can establish lifecycle after admission is revoked')
    },
    isAlive(child) { return children.some(native => native.pid === child.pid && native.exitCode === null && native.signalCode === null) },
  }
}

function stopHarness(f) {
  const emitted = deferred()
  const stateGate = deferred()
  const attempts = []
  const instances = new Map([['root', f.proc]])
  const context = vm.createContext({
    process: { platform: 'win32' }, setTimeout, clearTimeout,
    STOP_COMMAND_TIMEOUT_MS: C.deadlineMs, STOP_EXIT_TIMEOUT_MS: C.deadlineMs, STOP_KILL_GRACE_MS: C.deadlineMs,
    instanceLinks: new Map([['root', f.link]]), instances, instanceList: () => [...instances.values()],
    safeVersion: value => value, safeProfile: value => value, safeDshHome: value => value, homeDir: () => C.home,
    shuttingDown: false, startupGeneration: 0, pushLog() {}, logWriter: { flush() {} }, flushLogEvents() {}, clients: new Set(), server: null,
    async emitState() { emitted.resolve(); await stateGate.promise },
    async waitExit(child) {
      await until(() => !f.isAlive(child), 'root exits after lifecycle disconnection or taskkill')
      return true
    },
    spawn(command, args) {
      assert.equal(command, 'taskkill')
      assert.ok(args.includes('/T'), 'Windows termination must target descendants')
      assert.ok(args.includes('/F'), 'Windows first attempt must force console-root termination')
      const child = [f.root, f.pending].find(child => child?.pid === Number(args[1]))
      assert.ok(child, 'tree termination targets a tracked native/adopted/pending root')
      const task = new EventEmitter()
      attempts.push({ child, task, aliveAtStart: f.isAlive(child) })
      return task
    },
  })
  vm.runInContext(['killTree', 'terminateProcess', 'stop', 'stopAll'].map(functionSource).join('\n') + '\nthis.runStop = stop; this.runStopAll = stopAll', context)
  return { context, attempts, emitted, stateGate }
}

for (const method of ['stop', 'stopAll']) {
  for (const kind of ['native', 'adopted', 'pending', 'delayed-root']) {
    test(method + ' preserves ' + kind + ' root lifecycle until awaited Windows tree attempt', async t => {
      const f = await fixture(t, kind)
      const h = stopHarness(f)
      let finished = false
      const stopping = (method === 'stop' ? h.context.runStop(C.version, C.profile) : h.context.runStopAll())
      stopping.then(() => { finished = true }, () => { finished = true })
      t.after(async () => {
        h.stateGate.resolve()
        await delay(C.pollMs)
        for (const { task } of h.attempts) task.emit('exit', 1)
        await stopping.catch(() => {})
      })
      // stop() 的第一个 await 尚未完成，stopAll() 的首个 taskkill 也还悬挂时就必须禁止新继任者。
      f.queued.write(JSON.stringify({ secret: f.config.secret, pid: process.pid }) + '\n')
      await until(() => f.queued.destroyed, 'queued successor handshake rejected during stop')
      const late = f.launch()
      await until(() => late.exitCode !== null || late.signalCode !== null, 'late preload successor must self-terminate')
      if (kind === 'delayed-root') await f.connectRoot()
      if (method === 'stop') {
        await h.emitted.promise
        assert.equal(h.attempts.length, 0, 'state emission remains awaited before tree termination')
        assert.equal(f.proc.status, 'stopping')
        assert.ok(f.isAlive(f.root), 'live root survives asynchronous stopping-state emission')
        if (f.pending) assert.ok(f.isAlive(f.pending), 'pending root survives asynchronous stopping-state emission')
        h.stateGate.resolve()
      }
      const roots = [f.root, f.pending].filter(Boolean)
      await until(() => h.attempts.length === roots.length, 'every connected root receives a tree termination attempt')
      await delay(C.quietMs)
      for (const attempt of h.attempts) {
        assert.ok(attempt.aliveAtStart, 'taskkill /T sees a living root, not a socket-induced orphan tree')
        assert.ok(f.isAlive(attempt.child), 'lifecycle socket stays open while taskkill is unresolved')
      }
      assert.equal(f.adopted.length, kind === 'adopted' ? 1 : 0, 'stop does not promote a pending or late successor')
      assert.equal(finished, false, 'stop awaits the OS tree operation')
      // 这里的 taskkill 故意只回报完成、不杀真实根；随后必须断管道，不能把保活变成永久泄漏。
      for (const { task } of h.attempts) task.emit('exit', 0)
      await stopping
      for (const child of roots) assert.equal(f.isAlive(child), false, 'lifecycle closes only after the awaited tree attempt')
    })
  }
}

for (const reason of ['revoke', 'expiry']) {
  test('ordinary ' + reason + ' still closes lifecycle and rejects late preload successors', async t => {
    const f = await fixture(t, 'native', reason === 'expiry' ? C.expiryMs : C.leaseMs)
    if (reason === 'expiry') {
      f.root.kill('SIGKILL')
      await once(f.root, 'exit')
      f.link.exited(f.root)
      await f.disposed.promise
    } else {
      f.link.revoke()
      await until(() => !f.isAlive(f.root), 'ordinary revoke terminates current preload root')
    }
    const late = f.launch()
    await until(() => late.exitCode !== null || late.signalCode !== null, 'late successor exits after full capability disposal')
    assert.equal(f.adopted.length, 0, 'disposed launch cannot be adopted')
  })
}
