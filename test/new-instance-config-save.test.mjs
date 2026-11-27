import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { BUILTIN_ID, packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const INSTANCE = { name: 'test', dshVersion: 'auto', updateChannel: 'official' }
const VERSIONS = { latest: '1.1.0', pinned: '1.0.0' }
const ENVIRONMENTS_API = '/api/environments'
const SOURCE = readFileSync(new URL('../src/public/environments-page.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function configPage({ environment, post }) {
  const element = () => ({
    dataset: {}, value: '', options: [], textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, querySelectorAll: () => [],
  })
  const el = new Proxy({}, { get: (elements, key) => elements[key] ||= element() })
  const channel = INSTANCE.updateChannel
  const context = vm.createContext({
    el, post, environments: [environment], openedId: environment.id,
    activeTab: 'config', busy: false, checking: false, updates: {}, compat: { request: 0, busy: false },
    packMoreIcons: {}, gridCardHtml: ({ name }) => name,
    AUTO_VERSION: INSTANCE.dshVersion, UPDATE_CHANNELS: [channel], UPDATE_CHANNEL_NAMES: {},
    installedList: () => Object.values(VERSIONS), switchChannel: () => channel,
    byId: () => null, pluginRow: () => '', escapeHtml: String,
    paintChannelSwitch() {}, syncUiSelect() {},
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (token, name) => vars[name] ?? token),
  })
  // 保存成功前会重画详情（包括历史备份），不能把这段当作 DOM 桩跳过。
  for (const [from, to] of [
    ['  const opened =', '  // 上游的哪一版'],
    ['  function tagsOf(', '  /**\n   * 版本下拉'],
    ['  function paintVersionOptions(', '  async function checkCompatibility('],
    ['  function paintUpstream(', '  /**\n   * 分类芯片'],
    ['  el.version.onchange =', '  el.channel.oninput ='],
    ['  el.editForm.onsubmit =', '  const DEFAULT_DESKTOP_ENHANCE ='],
  ]) {
    const start = SOURCE.indexOf(from)
    const end = SOURCE.indexOf(to, start)
    assert.ok(start >= 0 && end > start, `找不到页面片段：${from}`)
    vm.runInContext(SOURCE.slice(start, end), context)
  }
  context.renderView()
  return {
    el,
    async save() {
      el.editForm.onsubmit({ preventDefault() {} })
      await vm.runInContext('envAutoSave.inFlight', context)
    },
  }
}

test('新建默认实例没有插件或启动项，也能保存 DSH 版本', async (t) => {
  const env = await startChannelServer({
    prefix: 'dsh-new-instance-config-',
    packument: packumentOf({ latest: VERSIONS.latest }, Object.values(VERSIONS)),
    installed: Object.values(VERSIONS),
  })
  t.after(() => env.cleanup())

  async function post(path, body) {
    const result = await env.call(path, body)
    if (!result.ok || !result.data.ok) throw new Error(`POST ${path}: HTTP ${result.status} ${JSON.stringify(result.data)}`)
    return result.data
  }

  // 新建按钮只传名称，由服务端选正式版 / 最新。
  const { environment: { id } } = await post(ENVIRONMENTS_API + '/create', { name: INSTANCE.name })
  const readInstance = async () => (await env.getJson(ENVIRONMENTS_API)).environments.find((item) => item.id === id)
  const before = await readInstance()
  assert.equal(before.name, INSTANCE.name)
  assert.equal(before.dshVersion, INSTANCE.dshVersion)
  assert.equal(before.updateChannel, INSTANCE.updateChannel)
  assert.deepEqual(before.plugins.filter((item) => !item.official), [])
  // 启动器自带一条全局启动项；新建实例不能占用它，也不能新增启动项。
  assert.deepEqual(before.usedBy, [])
  const { launchPresets } = await env.state()
  assert.deepEqual(launchPresets.map((entry) => entry.id), [BUILTIN_ID])

  let saveResponse
  const page = configPage({
    environment: before,
    async post(path, body) {
      saveResponse = await post(path, body)
      return saveResponse
    },
  })
  assert.equal(page.el.configBox.hidden, false)
  assert.equal(page.el.save.disabled, true)
  page.el.version.value = VERSIONS.pinned
  page.el.version.onchange()
  assert.equal(page.el.save.disabled, false)
  await page.save()
  assert.equal(page.el.saveStatus.textContent, '已保存')
  assert.equal(page.el.save.disabled, true)
  assert.deepEqual(saveResponse.environment, await readInstance(), '保存接口应返回和列表一致的实例视图')

  await env.restart()
  const after = await readInstance()
  assert.equal(after.dshVersion, VERSIONS.pinned)
  assert.deepEqual(after.usedBy, [])
  assert.deepEqual((await env.state()).launchPresets, launchPresets)
})
