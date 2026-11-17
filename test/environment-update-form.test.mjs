import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// 执行页面原函数，模拟请求和 DOM；不用真实配置、网络或浏览器。
const source = readFileSync(new URL('../src/public/environments-page.js', import.meta.url), 'utf8')
function slice(from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}
function harness() {
  // classList 要和真元素一样能用：renderView 按检查状态切顶栏检查更新的 is-checking
  const element = () => {
    const classes = new Set()
    const classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => { force ? classes.add(name) : classes.delete(name); return force },
    }
    return { dataset: {}, value: '', classList, setAttribute() {}, querySelectorAll: () => [] }
  }
  const el = new Proxy({}, { get: (obj, key) => obj[key] ||= element() })
  let env = { id: 'a', name: '甲', dshVersion: '1.0.0', updateChannel: 'official', plugins: [], usedBy: [], applied: [{ profile: 'web', home: '/fake' }] }
  let fail = false
  let navigate = false
  const calls = []
  const context = vm.createContext({
    el, busy: false, checking: false, compat: { request: 0, busy: false },
    updates: {}, updateCheck: null, AUTO_VERSION: 'auto', UPDATE_CHANNELS: ['official', 'rc', 'alpha'],
    opened: () => env, installedList: () => ['1.0.0', '2.0.0'],
    paintUpstream() {}, paintHistory() {}, paintChannelSwitch() {}, syncUiSelect() {}, byId: element,
    pluginRow: () => '', versionText: e => e.dshVersion, thirdParty: e => e.plugins,
    switchChannel: e => ['official', 'rc', 'alpha'][Number(e.value)], recommendedVersion: () => '2.0.0',
    t: text => text, escapeHtml: String, releaseLabel: () => 'v2', notify() {},
    hideUpdateDialog() { context.updateCheck = null },
    async post(url, payload) {
      calls.push({ url, payload })
      if (url.endsWith('/apply')) {
        if (fail) throw new Error('offline')
        env = { ...env, dshVersion: '2.0.0', updateChannel: 'rc' }
        if (navigate) {
          env = { ...env, id: 'b', name: '乙' }
          context.renderView()
          el.name.value = '乙未保存'
          el.version.value = '1.0.0'
        }
      }
      return {}
    },
    load: async () => context.renderView(),
  })
  for (const [from, to] of [
    ['  function paintVersionOptions(', '  /**\n   * 兼容性检查'],
    ['  function compatibilityTarget(', '  async function checkCompatibility('],
    ['  function renderView() {', '  function paint() {'],
    ['  async function run(', '  function open('],
    ['  async function applyUpdate()', '  trapPackDialog(el.updateDialog'],
    ['  el.editForm.onsubmit =', '  el.addForm.onsubmit ='],
  ]) vm.runInContext(slice(from, to), context)
  context.renderView()
  return { el, calls, context, setFail: value => { fail = value }, setNavigate: () => { navigate = true },
    update: async () => {
      context.updateCheck = { ok: true, token: 'fake', environment: { id: 'a', name: '甲' }, latest: {} }
      await context.applyUpdate()
    }, target: () => context.compatibilityTarget(env),
  }
}

test('上游更新后改名使用新版本和通道，兼容性旧请求作废，重复更新不回退', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) {
    const request = h.context.compat.request
    await h.update()
    assert.equal(h.el.version.value, '2.0.0')
    assert.equal(h.el.channel.value, '1')
    assert.equal(h.target().version, '2.0.0')
    assert.ok(h.context.compat.request > request)
    assert.equal(h.el.compat.hidden, true)
    h.el.name.value = '改名'
    h.el.editForm.onsubmit({ preventDefault() {} })
    await new Promise(resolve => setImmediate(resolve))
    const saved = h.calls.findLast(c => c.url === '/api/environments/update').payload
    assert.equal(saved.name, '改名')
    assert.equal(saved.dshVersion, '2.0.0')
    assert.equal(saved.updateChannel, 'rc')
  }
})

test('上游更新失败保留未保存的名字、版本和通道，错误可重试', async () => {
  const h = harness()
  h.el.name.value = '未保存'
  h.el.version.value = 'auto'
  h.el.channel.value = '2'
  h.setFail(true)
  await h.update()
  assert.equal(h.el.name.value, '未保存')
  assert.equal(h.el.version.value, 'auto')
  assert.equal(h.el.channel.value, '2')
  assert.equal(h.el.updateHint.textContent, 'offline')
  assert.equal(h.el.updateGo.disabled, false)
  h.setFail(false)
  await h.update()
  assert.equal(h.el.version.value, '2.0.0')
})

test('上游更新完成不覆盖已切换到另一实例的未保存输入', async () => {
  const h = harness()
  h.setNavigate()
  await h.update()
  assert.equal(h.el.editForm.dataset.environment, 'b')
  assert.equal(h.el.name.value, '乙未保存')
  assert.equal(h.el.version.value, '1.0.0')
})
