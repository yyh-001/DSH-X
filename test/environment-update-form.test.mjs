import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// 执行页面原函数，模拟请求和 DOM；不用真实配置、网络或浏览器。
// Windows checkout 会转成 CRLF；统一换行后再按多行注释起点切片。
const source = readFileSync(new URL('../src/public/environments-page.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
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
    ['  el.editForm.onsubmit =', '  const DEFAULT_DESKTOP_ENHANCE ='],
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

test('实例配置显式保存：接口仅返回存储原始对象时保留 plugins 等视图字段，切换版本不再报 filter 错误', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  assert.match(html, /id="environmentManageVersions"[\s\S]{0,300}id="environmentSave"[^>]*type="submit"/)

  const element = () => {
    const classes = new Set()
    const classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => { force ? classes.add(name) : classes.delete(name); return force },
    }
    return { dataset: {}, value: '', disabled: false, hidden: true, textContent: '', classList, setAttribute() {}, querySelectorAll: () => [] }
  }
  const el = new Proxy({}, { get: (obj, key) => obj[key] ||= element() })
  const calls = []
  const initialEnv = {
    id: 'a',
    name: 'web',
    dshVersion: '0.2.2-rc.5',
    updateChannel: 'official',
    following: false,
    plugins: [
      { name: '@deepseek-ai/dsh-base', official: true },
      { name: 'dsh-x-memory', official: false },
    ],
    usedBy: [{ name: 'web' }],
    applied: [{ profile: 'web', home: '/fake' }],
  }
  const context = vm.createContext({
    el, busy: false, checking: false, compat: { request: 0, busy: false },
    updates: {}, updateCheck: null, AUTO_VERSION: 'auto', UPDATE_CHANNELS: ['official', 'rc', 'alpha'],
    environments: [initialEnv],
    opened: () => context.environments.find((item) => item.id === 'a') || null,
    installedList: () => ['0.2.2-rc.5', '0.2.2'],
    paintUpstream() {}, paintHistory() {}, paintChannelSwitch() {}, syncUiSelect() {}, byId: element,
    renderGrid() {},
    pluginRow: () => '',
    versionText: (e) => e.dshVersion,
    thirdParty: (e) => (Array.isArray(e?.plugins) ? e.plugins : []).filter((p) => !p.official),
    switchChannel: (e) => ['official', 'rc', 'alpha'][Number(e.value)] || 'official',
    recommendedVersion: () => '0.2.2',
    t: (text, vars = {}) => {
      let s = String(text)
      for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    },
    escapeHtml: String,
    releaseLabel: () => '',
    notify() {},
    hideUpdateDialog() { context.updateCheck = null },
    async post(url, payload) {
      calls.push({ url, payload })
      // 模拟真实后端 /api/environments/update：仅返回存储字段（无 plugins / usedBy / applied）
      return {
        ok: true,
        environment: {
          schemaVersion: 1,
          id: payload.id,
          name: payload.name,
          dshVersion: payload.dshVersion,
          updateChannel: payload.updateChannel,
          base: { dshVersion: payload.dshVersion, bundles: [], dependencies: {} },
        },
      }
    },
    load: async () => { throw new Error('不该整页重载') },
  })
  for (const [from, to] of [
    ['  function paintVersionOptions(', '  /**\n   * 兼容性检查'],
    ['  function compatibilityTarget(', '  async function checkCompatibility('],
    ['  function renderView() {', '  function paint() {'],
    ['  async function run(', '  function open('],
    ['  async function applyUpdate()', '  trapPackDialog(el.updateDialog'],
    ['  el.editForm.onsubmit =', '  const DEFAULT_DESKTOP_ENHANCE ='],
  ]) vm.runInContext(slice(from, to), context)

  context.renderView()
  assert.equal(el.save.disabled, true, '未改配置时保存按钮禁用')
  assert.equal(el.save.textContent, '保存')

  el.version.value = '0.2.2'
  context.renderView()
  assert.equal(calls.length, 0, '改版本不立即发保存请求')
  assert.equal(el.save.disabled, false, '有未保存改动时启用保存按钮')

  el.editForm.onsubmit({ preventDefault() {} })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    url: '/api/environments/update',
    payload: { id: 'a', name: 'web', dshVersion: '0.2.2', updateChannel: 'official' },
  })
  assert.equal(el.saveStatus.textContent, '已保存')
  assert.equal(el.saveStatus.classList.contains('is-saved'), true)
  assert.equal(el.saveStatus.hidden, false)
  assert.equal(el.detailSub.textContent, 'DSH 0.2.2 · 1 个插件')
  assert.equal(context.environments[0].plugins.length, 2, '合并后不丢原有 plugins 视图字段')
  assert.equal(context.environments[0].usedBy.length, 1, '合并后不丢原有 usedBy 视图字段')
  assert.equal(el.save.disabled, true, '保存成功后恢复禁用')
  assert.equal(el.save.textContent, '保存')
})
