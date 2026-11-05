import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix as path } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(new URL('../skills/dsh-x-selfcheck/scripts/selfcheck.mjs', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')

function functionText(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, name)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}

function scopeContext({ reachable = true, settings = true, state = true } = {}) {
  const forbidden = () => {
    throw new Error('attempted shell environment fallback')
  }
  const context = vm.createContext({
    Date, Number, Set, Buffer,
    process: { env: { PORT: '99', DSH_VERSIONS_DATA: '/wrong/data' } },
    DEFAULT_PORT: 5000, DEFAULT_PROFILE: 'web',
    userAppDir: forbidden, loadSettingsFile: forbidden, readLogFiles: forbidden,
    homedir: forbidden, readdirSync: forbidden, skillRoots: forbidden,
    join: path.join, absolutePath: value => value?.startsWith('/') ? value : '',
    installDirFromLogs: () => '', installDirFromAppDir: forbidden,
    inferDataDir: forbidden, isFile: forbidden, isDir: forbidden,
    discoverManager: async () => ({ found: reachable ? [{ base: 'http://127.0.0.1:1234', port: 1234 }] : [] }),
    requestJson: async url => {
      if (url.endsWith('/api/settings')) {
        return settings ? { value: { listenPort: 1234, proxyMode: 'manual', proxyUrl: 'http://target', dataDir: '/target/data', dshHome: '/target/home' } } : { error: 'settings unavailable' }
      }
      if (url.endsWith('/api/state')) {
        return state ? { value: { profile: 'desktop', profiles: ['desktop'], dataDir: '/target/data', dshHome: '/target/home' } } : { error: 'state unavailable' }
      }
      return { error: 'unavailable' }
    },
    requestText: async () => ({ error: 'logs unavailable' }),
  })
  vm.runInContext(['collectLogs', 'buildContext', 'resolveDshHome', 'resolveProfiles', 'resolveExtraHomes'].map(name => functionText(script, name)).join('\n'), context)
  return context
}

test('explicit manager uses target settings, never shell settings or failed log fallback', async () => {
  const context = scopeContext()
  const result = await context.buildContext({ port: 1234, logs: true })
  assert.equal(result.settings.proxyUrl, 'http://target')
  assert.equal(result.dataDir.dir, '/target/data')
  assert.equal(result.dshHome.dir, '/target/home')
  assert.equal(result.appDir, '')
  assert.match(result.logs.error, /logs unavailable/)
})

test('unreachable explicit target leaves paths unknown instead of inspecting another environment', async () => {
  const context = scopeContext({ reachable: false })
  const result = await context.buildContext({ port: 1234, logs: true })
  assert.equal(result.dataDir.dir, '')
  assert.equal(result.dshHome.dir, '')
  assert.equal(result.profileDir, '')
  assert.equal(result.profiles.length, 0)
  assert.match(result.logs.error, /未|无法/)
})

test('missing target settings and state do not manufacture defaults or inspect local skill roots', async () => {
  const context = scopeContext({ settings: false, state: false })
  const result = await context.buildContext({ port: 1234, logs: true })
  assert.equal(result.dataDir.dir, '')
  assert.equal(result.dshHome.dir, '')
  assert.equal(Object.keys(result.settings).length, 0)
  const checks = []
  context.report = { add: (...args) => checks.push(args) }
  context.ctx = result
  vm.runInContext(`${functionText(script, 'checkSkills')}\ncheckSkills(report, ctx)`, context)
  assert.match(JSON.stringify(checks), /未|无法/)
})

test('settings with a mismatched manager identity are not used', async () => {
  const context = scopeContext({ state: false })
  context.requestJson = async () => ({ value: { listenPort: 9999, dataDir: '/wrong/data', dshHome: '/wrong/home' } })
  const result = await context.buildContext({ port: 1234, logs: true })
  assert.equal(Object.keys(result.settings).length, 0)
  assert.match(result.settingsResult.error, /监听端口/)
})

test('non-explicit discovery retains its local settings and log fallback', async () => {
  const context = scopeContext({ reachable: false })
  context.userAppDir = () => '/local/app'
  context.loadSettingsFile = () => ({ value: { port: 4321, dataDir: '/local/data', dshHome: '/local/home' } })
  context.readLogFiles = () => ({ text: 'local logs', source: '/local/app/manager.log' })
  context.installDirFromAppDir = () => ''
  context.readdirSync = () => []
  const result = await context.buildContext({ port: 0, logs: true })
  assert.equal(result.appDir, '/local/app')
  assert.equal(result.settings.port, 4321)
  assert.equal(result.logs.text, 'local logs')
  assert.equal(result.dshHome.dir, '/local/home')
})

test('missing explicit settings, home and skill evidence are reported without fabricated defaults', async () => {
  const context = scopeContext({ reachable: false })
  const result = await context.buildContext({ port: 1234, logs: true })
  const checks = []
  context.report = { add: (...args) => checks.push(args) }
  context.ctx = result
  for (const name of ['checkNetworkConfig', 'checkHome', 'checkSkills']) {
    vm.runInContext(`${functionText(script, name)}\n${name}(report, ctx)`, context)
  }
  assert.match(JSON.stringify(checks), /目标网络配置未核实/)
  assert.match(JSON.stringify(checks), /DSH_HOME 未确定/)
  assert.doesNotMatch(JSON.stringify(checks), /proxyMode=system/)
})

test('skill instructions do not override evidence limitations or recommend changing Harness', () => {
  const skill = readFileSync(new URL('../skills/dsh-x-selfcheck/SKILL.md', import.meta.url), 'utf8')
  assert.doesNotMatch(skill, /YAML 坏了|换 dsh 版本/)
  assert.match(skill, /语法.*未验证|未验证.*语法/)
})

test('running waiting-only report stays neutral in producer, dialog and launch log', () => {
  const start = server.indexOf('  const scheduleDiagnosis = () => {')
  const schedule = server.slice(start, server.indexOf('  const onLine =', start))
  for (const failed of [[], [{ id: 'fault' }]]) {
    const report = { failed, rejected: [], waiting: [{ id: 'connection' }], skipped: { entries: [] }, advice: [] }
    const proc = { status: 'running', diagnosis: { report: () => report } }
    const context = vm.createContext({ proc, key: 'target', instances: new Map([['target', proc]]), setTimeout: fn => { fn(); return 1 }, Date, version: '1', profile: 'web', diagnosticContext: {}, bindDiagnosis: () => ({}), emitState: async () => {}, DIAGNOSIS_UPDATE_DELAY: 1 })
    vm.runInContext(`${schedule}\nscheduleDiagnosis()`, context)
    if (failed.length) {
      assert.match(proc.diagnosticWarning.message, /异常/)
    } else {
      assert.doesNotMatch(proc.diagnosticWarning.message, /异常|故障/)
      assert.match(proc.diagnosticWarning.message, /等待/)
    }
  }
  const dialog = html.slice(html.indexOf('    function showFailure('), html.indexOf('    function cardLine('))
  assert.doesNotMatch(dialog, /running \? t\('实例仍在运行，但日志报告插件异常'\)/)
  // 顶部聚合横幅已随「诊断进启动项日志」删掉，等待类问题不应在日志诊断里冒出问题行。
  const rowsStart = html.indexOf('    function diagnosisIssueRows')
  const rowsFn = html.slice(rowsStart, html.indexOf('    /** 启动项当前实例的插件诊断', rowsStart))
  const context = vm.createContext({ t: value => value })
  vm.runInContext(rowsFn, context)
  const report = { failed: [], rejected: [], waiting: [{ id: 'connection' }], skipped: { entries: [] }, advice: [] }
  assert.deepEqual(JSON.parse(JSON.stringify(context.diagnosisIssueRows(report))), [])
})
