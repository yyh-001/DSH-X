import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { createStartupDiagnosis } from '../src/startup-diagnosis.js'
import { bindDiagnosis } from '../src/repair-plan.js'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')

test('运行中兼容拒绝只显示为rejected，不把报告外文本伪造为失败', () => {
  const fixture = readFileSync(new URL('./fixtures/startup-desktop-sanitized.txt', import.meta.url), 'utf8')
  const rejection = fixture.split(/\r?\n/).filter(line => line.includes('disabling profile plugin row')).slice(0, 2)
  assert.equal(rejection.length, 2)
  const collector = createStartupDiagnosis()
  for (const line of ['dsh: warning: 1 entry did not activate', 'waiting (pkg): pending (waiting for service: subprocess)', ...rejection, 'unknown-plugin (unknown-package): Error: genuine unknown failure']) {
    collector.addLine(line)
  }
  const report = collector.report()
  assert.equal(report.rejected.length, 2)
  assert.deepEqual(report.failed, [])
})

test('ready后跨块警告按实例发布，普通日志不广播，退出和重启清空', async () => {
  const instances = new Map()
  let broadcasts = 0
  const context = {
    instances, instanceKey: (version, profile) => `${version}@${profile}`,
    homeDir: () => '/isolated', createStartupDiagnosis, bindDiagnosis, redact: value => value,
    secretValues: [], createInterface, pushLog() {}, performance,
    setTimeout, clearTimeout, DIAGNOSIS_UPDATE_DELAY: 10,
    READY_RE: /dsh web: (http:\/\/\S+)/,
    emitState: () => { broadcasts += 1 }, lastHealth: null,
    // 实例启动 / 退出的桌面通知（host.notify）另测；这里只跑诊断，不关心通知
    notifyInstance() {},
    // 局域网代理的起停另测（test/lan-proxy.test.mjs）；这里只跑诊断
    openLanProxy: async () => {}, closeLanProxy: async () => {},
  }
  const begin = server.indexOf('function attachProcess(')
  const end = server.indexOf('\n/**', begin)
  vm.runInNewContext(server.slice(begin, end) + '\nthis.attachProcess = attachProcess', context)
  const child = () => {
    const result = new EventEmitter()
    result.stdout = new PassThrough()
    result.stderr = new PassThrough()
    return result
  }
  const firstChild = child()
  const first = context.attachProcess('1', 'desktop', firstChild, {})
  const secondChild = child()
  const second = context.attachProcess('1', 'web', secondChild, {})
  firstChild.stdout.write('dsh web: http://127.0.0.1:1/\n')
  secondChild.stdout.write('dsh web: http://127.0.0.1:2/\n')
  firstChild.stderr.write('dsh: warning: 1 entry did not activate\nplugin (pkg): Validation')
  firstChild.stderr.write('Error: invalid config:\n  - $.serviceVersion missing required value\n')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(first.status, 'running')
  assert.match(first.diagnosticWarning.diagnosis.failed[0].reason, /serviceVersion/)
  assert.equal(second.diagnosticWarning, null)
  const previous = broadcasts
  firstChild.stdout.write('ordinary log\n'.repeat(500))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(broadcasts, previous)
  firstChild.stderr.write('Error: later event\n')
  firstChild.emit('exit', 0, null)
  const replacement = context.attachProcess('1', 'desktop', child(), {})
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(replacement.diagnosticWarning, null)
  assert.equal(replacement.diagnosis.report().failed.length, 0)
  replacement.child.stderr.write('dsh: warning: 1 entry did not activate\nearly (pkg): Error: before ready\n')
  replacement.child.stdout.write('dsh web: http://127.0.0.1:3/\n')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(replacement.diagnosticWarning.diagnosis.failed[0].id, 'early')
  secondChild.emit('exit', 0, null)
  replacement.child.emit('exit', 0, null)
})

test('证据达到上限只在首次截断时发布变化', () => {
  const collector = createStartupDiagnosis()
  let lastChange = true
  for (let index = 0; index < 1000; index += 1) {
    lastChange = collector.addLine(`Error: ${index} ${'x'.repeat(4000)}`)
  }
  assert.equal(collector.report().truncated, true)
  assert.equal(lastChange, false)
})

test('扁平运行中警告保留嵌套原因，不推定必需插件', () => {
  const collector = createStartupDiagnosis({ profile: 'desktop' })
  for (const line of [
    'dsh: warning: 2 entries did not activate',
    'desktop-product-telemetry (@deepseek-ai/dsh-host-product-telemetry-otel): ValidationError: invalid config:',
    '  - $.serviceVersion missing required value (at serviceVersion)',
    'product-analytics (analytics): pending (waiting for service: productTelemetry)',
  ]) {
    collector.addLine(line)
  }
  const report = collector.report()
  assert.match(report.failed[0].reason, /serviceVersion missing required value/)
  assert.equal(report.failed[0].required, undefined)
  assert.deepEqual(report.blockingChains, [])
  assert.equal(collector.addLine('ordinary running log'), false)
})

test('保留required阻塞边，只把同名拒绝行标为线索', () => {
  const collector = createStartupDiagnosis()
  for (const line of [
    'dsh: disabling profile plugin row "credentials": Plugin credentials-package@1 is incompatible with dsh 2: requirements {}. Running it may fail.',
    'dsh: startup failed: 1 required plugin did not activate',
    'Failed plugins (0):',
    'Plugins waiting for services (1):',
    '  Plugin                         Missing services',
    '  connection (required)          credentials, other',
  ]) {
    collector.addLine(line)
  }
  const report = collector.report()
  assert.equal(report.waiting[0].required, true)
  assert.deepEqual(report.blockingChains, [
    { id: 'connection', service: 'credentials', rejectedRow: { id: 'credentials', package: 'credentials-package@1' } },
    { id: 'connection', service: 'other' },
  ])
})

test('诊断弹窗打开从顶部，普通通知仍从输出底部', () => {
  const detail = { scrollTop: 10, scrollHeight: 900 }
  const context = {
    t: text => text,
    noticeTitleEl: {}, noticeTextEl: {}, noticeDetailEl: detail, noticeCopyEl: {},
    noticeDiagnosisEl: {}, noticeOutputTitleEl: {},
    noticeEl: { classList: { toggle() {} } }, showDialog() {},
    resetRepairPlan() {},
  }
  const begin = html.indexOf('    function notify(')
  const end = html.indexOf('    noticeCopyEl.onclick', begin)
  vm.runInNewContext(html.slice(begin, end) + '\nthis.notify = notify', context)
  context.notify('message', 'title', 'detail', true)
  assert.equal(detail.scrollTop, 0)
  context.notify('message', 'title', 'detail')
  assert.equal(detail.scrollTop, 900)
})
