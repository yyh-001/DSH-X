import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { BUILTIN_ID, packumentOf, startChannelServer } from './update-channel-fixture.mjs'

test('混合通道分别检测，最新 Alpha 不掩盖正式版更新', async (t) => {
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init) => {
    if (new URL(String(input)).hostname === '127.0.0.1') {
      return originalFetch(input, init)
    }
    return Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.0.0' })))
  })
  const env = await startChannelServer({
    prefix: 'd28-mixed-',
    installed: ['1.0.0', '2.0.0-alpha.2'],
    packument: packumentOf({ latest: '1.1.0', alpha: '2.0.0-alpha.2' }, ['1.0.0', '1.1.0', '2.0.0-alpha.2']),
    presets: (root) => [
      { id: BUILTIN_ID, name: '正式版', version: 'auto', profile: 'web', port: 0 },
      { id: '1111111111111111', name: 'Alpha', version: 'auto', profile: 'web', port: 0, updateChannel: 'alpha', dshHome: `${root}/alpha` },
    ],
  })
  t.after(async () => {
    await env.cleanup()
    t.mock.restoreAll()
  })
  const result = await env.getJson('/api/versions/check')
  assert.equal(result.update, true)
  assert.equal(result.current, '1.0.0')
  assert.equal(result.updateLatest, '1.1.0')
  assert.equal(result.channel, 'official')
  assert.equal((await env.pendingDsh()).latest, '1.1.0')
  env.installVersions(['1.1.0', '2.0.0-alpha.1'])
  const reverse = await env.getJson('/api/versions/check')
  assert.equal(reverse.updateLatest, '2.0.0-alpha.2')
  assert.equal(reverse.channel, 'alpha')
  env.installVersions(['1.1.0', '2.0.0-alpha.2'])
  assert.equal((await env.getJson('/api/versions/check')).update, false)
  assert.equal(await env.pendingDsh(), null)
})

const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')

function functionSource(name, next) {
  const start = source.indexOf(`async function ${name}(`)
  const end = source.indexOf('\n}', start) + 2
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end).replace(/export $/, '')
}

test('退出等待覆盖两次 taskkill 挂起及退出等待，完成前不发退出通知', async () => {
  const constants = [...source.matchAll(/^const STOP_\w+ = .+$/gm)].map((match) => match[0]).join('\n')
  const timers = []
  let now = 0
  let notified = false
  const context = vm.createContext({
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      if (timer) {
        timer.cancelled = true
      }
    },
    async stopAll() {
      await new Promise((resolve) => context.setTimeout(resolve, 24000))
    },
    async notifyShutdown() {
      notified = true
    },
  })
  vm.runInContext(`${constants}\n${functionSource('shutdown', '\nasync function notifyShutdown')}\nthis.run = shutdown`, context)
  const done = context.run()
  for (const time of [9000, 23999, 24000]) {
    now = time
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true
        timer.callback()
      }
    }
    for (let tick = 0; tick < 8; tick++) {
      await Promise.resolve()
    }
    assert.equal(notified, time === 24000, `time=${time}`)
  }
  await done
})

test('终止流程先确认退出，再决定是否强杀；最终失败不能冒充成功', async () => {
  for (const [answers, expected, attempts] of [
    [[true], true, 1],
    [[false, true], true, 2],
    [[false, false], false, 2],
  ]) {
    const calls = []
    const remaining = [...answers]
    const context = vm.createContext({
      process: { platform: 'win32' },
      STOP_EXIT_TIMEOUT_MS: 5000,
      STOP_KILL_GRACE_MS: 3000,
      pushLog() {},
      async killTree(pid, child, force) {
        calls.push({ pid, force })
        return false
      },
      async waitExit() {
        return remaining.shift()
      },
    })
    vm.runInContext(`${functionSource('terminateProcess')}\nthis.run = terminateProcess`, context)
    assert.equal(await context.run({ version: '1', profile: 'web', child: { pid: 42 } }), expected)
    assert.equal(calls.length, attempts)
    assert.ok(calls.every((call) => call.pid === 42 && call.force))
  }
})

test('taskkill 挂起时按预算回退 Node kill，不能把命令等待当作进程已退出', async () => {
  let timeout
  let killed = false
  const context = vm.createContext({
    process: { platform: 'win32' },
    STOP_COMMAND_TIMEOUT_MS: 8000,
    spawn() {
      return { on() {} }
    },
    setTimeout(callback, delay) {
      timeout = { callback, delay }
      return timeout
    },
    clearTimeout() {},
  })
  vm.runInContext(`${functionSource('killTree')}\nthis.run = killTree`, context)
  const result = context.run(42, {
    kill(signal) {
      assert.equal(signal, 'SIGKILL')
      killed = true
      return false
    },
  })
  assert.equal(killed, false)
  assert.equal(timeout.delay, 8000)
  timeout.callback()
  assert.equal(await result, false)
  assert.equal(killed, true)
})

test('整合保留诊断启动身份、停止二次确认及两个加载钩子', () => {
  assert.match(source, /function attachProcess\(version, profile, child, diagnosticContext, instanceLink\)/)
  assert.match(source, /function bootOnce\(ver, prof, onStarted\)/)
  assert.match(source, /function startNow\(version, profile = PROFILE_NAME, onStarted\)/)
  assert.match(source, /return bootOnce\(ver, prof, onStarted\)/)
  assert.match(source, /onStarted\?\.\(proc\)/)
  assert.match(source, /const context = started\?\.diagnosticContext/)
  const adapter = source.slice(source.indexOf('  async stop(target) {'), source.indexOf('  async verify(target) {'))
  assert.match(adapter, /await stop\(target.version, target.profile, target.home\)/)
  assert.match(adapter, /process.kill\(proc.child.pid, 0\)/)
  assert.match(adapter, /目标进程尚未确认退出，未修改文件/)
  const hooks = readFileSync(new URL('../src/compat/register.mjs', import.meta.url), 'utf8')
  assert.match(hooks, /registerHooks\(\{ load: diagnosticLoad \}\)/)
  assert.match(hooks, /registerHooks\(\{ load: loadPluginMarket \}\)/)
})
