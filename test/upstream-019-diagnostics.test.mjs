import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const TEST_PORT = 39127

function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`)
  assert.ok(start >= 0)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}

function bootContext(home, profile, fail = false) {
  const observations = { logs: [], contexts: [] }
  const context = vm.createContext({
    performance: { now: () => 1 },
    mkdir: async () => {},
    homeDir: () => home,
    instances: new Map(),
    instanceLinks: new Map(),
    instanceKey: (version, targetProfile) => `${home}:${version}:${targetProfile}`,
    bootEntry: () => '/fake/bin.js', RESERVED_BOOT: '/fake/reserved-profile-boot.mjs', START_TIMEOUT_MS: 1000,
    createInstanceLink: async () => ({ env: {}, bind() {}, revoke() {} }),
    shuttingDown: false,
    pinnedPort: () => 0,
    remembersAutoPort: () => true,
    rememberedPort: async () => ({ port: TEST_PORT, key: `1.0.0@${profile}` }),
    pushLog(message) {
      observations.logs.push(message)
    },
    // 启动项日志的耗时记录是副作用，这里只关心诊断身份
    launchScope: { getStore: () => undefined, run: (_scope, action) => action() },
    recordLaunchRun() {},
    readProcessRssMB: () => 300,
    lanBindActive: () => false,
    lanBindToggleOn: () => false,
    WEB_BIND: '',
    assertStartupActive() {},
    randomBytes: () => ({ toString: () => `${home}:${profile}:attempt` }),
    profileFingerprint: (targetHome, targetProfile) => `${targetHome}/${targetProfile}`,
    bootArgs: (targetProfile, alongside, port) => ({ targetProfile, alongside, port }),
    // 启动项的项目目录（#72）：这一段用例只关心诊断身份，启动目录照旧是 DSH_HOME
    launchWorkdir: () => '',
    spawnDsh(version, args, targetProfile, options) {
      observations.spawn = { version, args, targetProfile, context: options.diagnosticContext }
      return { pid: 123 }
    },
    attachProcess(version, targetProfile, child, diagnosticContext) {
      observations.contexts.push(diagnosticContext)
      return { child, diagnosticContext, diagnosis: { report: () => ({ failed: [{ id: 'example' }] }) } }
    },
    emitState: async () => {},
    waitUntilReady: async () => {
      if (fail) {
        throw new Error('test startup failed')
      }
      return { url: `http://127.0.0.1:${TEST_PORT}/` }
    },
    rememberAutoPort: async (version, targetProfile, url) => {
      observations.remember = { version, targetProfile, url }
    },
    lastHealth: null,
    lastFailure: null,
    failureIsFor: () => false,
    selfCheckPage() {},
    bindDiagnosis: diagnosticContext => ({ ...diagnosticContext }),
    claimedAutoPorts: new Set([TEST_PORT]),
  })
  vm.runInContext(`${functionSource('bootOnce')}\nthis.run = bootOnce`, context)
  return { context, observations }
}

test('跨版本自动端口复用同时保持独立 home/profile 的诊断身份和启动回调', async () => {
  for (const [home, profile] of [['/isolated/first', 'work'], ['/isolated/second', 'review']]) {
    const { context, observations } = bootContext(home, profile)
    let started
    await context.run('2.0.0', profile, proc => {
      started = proc
    })
    assert.equal(observations.spawn.args.port, TEST_PORT)
    assert.equal(observations.spawn.context.home, home)
    assert.equal(observations.spawn.context.profile, profile)
    assert.equal(started.diagnosticContext, observations.spawn.context)
    assert.equal(observations.remember.targetProfile, profile)
    assert.match(observations.logs.join('\n'), /沿用换版本前的端口/)
    assert.equal(context.claimedAutoPorts.size, 0)
  }
})

test('隔离启动失败的诊断绑定不会借用全局 home，失败也释放已认领端口', async () => {
  const { context, observations } = bootContext('/isolated/failure', 'broken', true)
  await assert.rejects(context.run('2.0.0', 'broken'), error => {
    assert.equal(error.failure.home, '/isolated/failure')
    assert.equal(error.failure.binding.home, '/isolated/failure')
    assert.equal(error.failure.binding.profile, 'broken')
    assert.equal(error.failure.binding.attemptId, observations.spawn.context.attemptId)
    return true
  })
  assert.equal(context.claimedAutoPorts.size, 0)
  assert.equal(observations.remember, undefined)
})

test('确认操作期间隔离向导不能通过设置接口切换目标目录或隔离档位', async () => {
  let written = false
  const context = vm.createContext({
    diagnosticRepairs: { busy: new Set(['attempt']) },
    saveSettings() {
      written = true
      throw new Error('must not write')
    },
  })
  vm.runInContext(`${functionSource('saveManagerSettings')}\nthis.run = saveManagerSettings`, context)
  await assert.rejects(context.run({ dshHome: '/new/home', launchIsolation: 'home' }), /正在确认修复或回退/)
  assert.equal(written, false)
})
