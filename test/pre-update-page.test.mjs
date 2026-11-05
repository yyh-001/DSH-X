import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// 页面保持原生脚本；与现有页面测试一样，只取公开交互入口，不复制被测逻辑。
const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')
const TARGET = '0.2.1-rc.3'
const DRAFT = '/draft/未保存目录'
const FUNCTIONS = ['compatibilityTarget', 'compatibilityKey', 'resetLaunchCompatibility', 'syncLaunchCompatibility', 'formatCompatibilityPlugin', 'buildCompatibilityPrompt', 'checkLaunchCompatibility', 'copyCompatibilityPrompt']
const plain = (value) => JSON.parse(JSON.stringify(value))

function functionSource(name) {
  const pattern = new RegExp('^    (?:async )?function ' + name + '\\(', 'm')
  const match = pattern.exec(page)
  assert.ok(match, '公开页面函数存在: ' + name)
  let depth = 0
  for (let index = page.indexOf('{', match.index); index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    if (page[index] === '}' && --depth === 0) return page.slice(match.index, index + 1)
  }
  assert.fail('函数未结束: ' + name)
}

function element(value = '') {
  const classes = new Set()
  const children = []
  return { children,
    replaceChildren(...items) { children.splice(0, children.length, ...items); this.innerHTML = ''; this.textContent = items.map((item) => item.textContent ?? '').join('') },
    append(...items) { children.push(...items); this.textContent = children.map((item) => item.textContent ?? '').join('') }, value, hidden: true, disabled: false, textContent: '', innerHTML: '', className: '', dataset: {}, style: {},
    classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name), toggle: (name, state) => { if (state ?? !classes.has(name)) classes.add(name); else classes.delete(name) } },
    setAttribute(name, val) { this[name] = val }, removeAttribute(name) { delete this[name] }, focus() {}, select() {},
  }
}

function editor(post = async () => ({ version: TARGET, plugins: [], incompatible: [], errors: [] })) {
  const calls = []
  const copied = []
  const nodes = Object.fromEntries(['compatibilityCheckEl', 'compatibilityEl', 'compatibilityStatusEl', 'compatibilityIssuesEl', 'compatibilityAgentEl', 'compatibilityPromptEl', 'compatibilityCopyEl'].map((name) => [name, element()]))
  const c = vm.createContext({ ...nodes,
    launchCompatibility: { request: 0, key: '', busy: false }, launchDialogRevision: 1,
    launchDialogEl: { hidden: false }, launchDialogClosing: false, versionValue: TARGET, draftLaunchChannel: () => 'rc', selected: () => c.launchVersionEl.value, editingLaunchId: 'saved-id', launchPluginScope: 'saved-id',
    launchVersionEl: element(TARGET), launchVersion: TARGET, launchProfileEl: element('draft-profile'), launchProfile: 'draft-profile',
    launchDshHomeEl: element(DRAFT),
    state: { dshHome: '/global', profile: 'web', local: ['0.2.0'], versions: ['0.2.0'], launchPresets: [{ id: 'saved-id', version: '0.2.0', profile: 'web', dshHome: '/saved' }] },
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''),
    escapeHtml: (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    post: async (...args) => { calls.push(plain(args)); return post(...args) }, notify: (text) => calls.push(['notify', text]),
    document: { createElement: () => element() },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
  })
  vm.runInContext(FUNCTIONS.map(functionSource).join('\n'), c)
  return { c, nodes, calls, copied }
}

const incompatible = [
  { name: '@scope/one', version: '1.2.3', requirements: { '@deepseek-ai/dsh': '<0.2.0', '@deepseek-ai/dsh-session': '^0.1.0' } },
  { name: 'second-plugin', version: '9.8.7', requirements: { 'engines.dsh': '~0.1.5' } },
]
const incompatibleReport = () => ({ version: TARGET, plugins: incompatible, incompatible, errors: [] })
const green = (node) => /All plugins compatible|所有插件均兼容|全部插件兼容|所有插件兼容/.test(node.textContent)

function assertNotGreen(nodes) {
  assert.equal(green(nodes.compatibilityStatusEl), false, '不完整或失败结果不能显示全部兼容')
}

test('UI: Pre-update check is a non-submit button by Version in Edit launch, and prompt is readonly', () => {
  const start = page.indexOf('id="launchDialog"')
  assert.ok(start >= 0)
  const dialog = page.slice(start, page.indexOf('</form>', start))
  assert.match(dialog, /<button\b[^>]*id="launchCheckCompatibility"[^>]*>/)
  const button = dialog.match(/<button\b[^>]*id="launchCheckCompatibility"[^>]*>/)[0]
  assert.match(button, /type="button"/, '检查不能提交保存表单')
  const versionAt = dialog.indexOf('id="versionTrigger"')
  const checkAt = dialog.indexOf('id="launchCheckCompatibility"')
  assert.ok(versionAt >= 0 && Math.abs(checkAt - versionAt) < 1500, '检查入口应与版本字段相邻')
  assert.match(dialog, /<textarea\b[^>]*id="launchCompatibilityPrompt"[^>]*readonly[^>]*>|<textarea\b[^>]*readonly[^>]*id="launchCompatibilityPrompt"[^>]*>/)
  assert.match(dialog, /<button\b[^>]*id="launchCopyCompatibilityPrompt"[^>]*>/)
})

test('UI EP: selected target/profile/draft home, not saved launch identity, determine the check', async () => {
  const { c, calls } = editor()
  const target = plain(c.compatibilityTarget())
  assert.deepEqual(target, { version: TARGET, profile: 'draft-profile', home: DRAFT })
  await c.checkLaunchCompatibility()
  const requests = calls.filter((call) => call[0] === '/api/plugins/check-compatibility')
  assert.deepEqual(requests, [['/api/plugins/check-compatibility', { version: TARGET, profile: 'draft-profile' }, { launchId: '', home: DRAFT }]])
  assert.equal(calls.some((call) => /save|start|recover|launches/.test(call[0])), false)
})

test('UI Decision complete-compatible: green status only for a complete compatible set', async () => {
  const good = { name: 'good', version: '1.0.0', requirements: {} }
  for (const plugins of [[], [good]]) {
    const { c, nodes } = editor(async () => ({ version: TARGET, plugins, incompatible: [], errors: [] }))
    await c.checkLaunchCompatibility()
    assert.equal(nodes.compatibilityEl.hidden, false)
    assert.ok(green(nodes.compatibilityStatusEl), nodes.compatibilityStatusEl.textContent)
    const styles = nodes.compatibilityStatusEl.className + ' ' + nodes.compatibilityEl.className + (nodes.compatibilityEl.classList.contains('is-compatible') ? ' compatible' : '')
    assert.ok(/success|compatible|good|ok/.test(styles) || /(?:green|#[0-9a-f]{3,8}|var\(--)/i.test(nodes.compatibilityStatusEl.style.color ?? ''), '兼容成功状态需要可见样式')
    assert.equal(nodes.compatibilityAgentEl.hidden, true)
    assert.equal(nodes.compatibilityPromptEl.value, '')
  }
  assert.match(css, /compatib[\s\S]*(?:green|success|#[0-9a-f]{3,8}|var\(--)/i)
})

test('UI Decision incompatible: list and readonly prompt contain every incompatible identity, installed version and unmet range; Copy is exact', async () => {
  const { c, nodes, copied } = editor(async () => incompatibleReport())
  await c.checkLaunchCompatibility()
  assertNotGreen(nodes)
  assert.equal(nodes.compatibilityAgentEl.hidden, false)
  const rendered = nodes.compatibilityIssuesEl.innerHTML.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') + nodes.compatibilityIssuesEl.textContent
  for (const item of incompatible) {
    for (const expected of [item.name, item.version, ...Object.keys(item.requirements), ...Object.values(item.requirements)]) {
      assert.ok(rendered.includes(expected), '列表漏掉: ' + expected)
      assert.ok(nodes.compatibilityPromptEl.value.includes(expected), 'Prompt 漏掉: ' + expected)
    }
  }
  assert.ok(nodes.compatibilityPromptEl.value.includes(TARGET))
  const prompt = nodes.compatibilityPromptEl.value
  await c.copyCompatibilityPrompt()
  assert.deepEqual(copied, [prompt])
})

for (const report of [
  { version: TARGET, plugins: [], incompatible: [], errors: [{ name: 'missing', error: 'missing manifest' }] },
  { version: TARGET, plugins: incompatible, incompatible, errors: [{ name: 'broken', error: 'invalid manifest' }] },
]) {
  test('UI Decision incomplete: manifest errors prevent green even when incompatible count is ' + report.incompatible.length, async () => {
    const { c, nodes } = editor(async () => report)
    await c.checkLaunchCompatibility()
    assertNotGreen(nodes)
    const rendered = nodes.compatibilityIssuesEl.innerHTML + nodes.compatibilityIssuesEl.textContent + nodes.compatibilityStatusEl.textContent
    assert.ok(rendered.includes(report.errors[0].name))
    assert.ok(rendered.includes(report.errors[0].error))
  })
}

test('UI State: incompatible → target edited → unchecked → compatible does not retain old prompt/list', async () => {
  let next = incompatibleReport()
  const { c, nodes } = editor(async () => next)
  await c.checkLaunchCompatibility()
  assert.ok(nodes.compatibilityPromptEl.value)
  c.launchVersionEl.value = '0.3.0'
  c.launchVersion = '0.3.0'
  c.syncLaunchCompatibility()
  assert.equal(nodes.compatibilityEl.hidden, true)
  assert.equal(nodes.compatibilityPromptEl.value, '')
  next = { version: '0.3.0', plugins: [], incompatible: [], errors: [] }
  await c.checkLaunchCompatibility()
  assert.ok(green(nodes.compatibilityStatusEl))
  assert.equal(nodes.compatibilityPromptEl.value, '')
  assert.equal(nodes.compatibilityIssuesEl.innerHTML, '')
})

for (const changed of ['version', 'profile', 'home', 'dialog']) {
  test('UI State: late compatibility result cannot overwrite changed ' + changed, async () => {
    let resolve
    const { c, nodes } = editor(() => new Promise((done) => { resolve = done }))
    const pending = c.checkLaunchCompatibility()
    if (changed === 'version') { c.launchVersionEl.value = '0.3.0'; c.launchVersion = '0.3.0' }
    if (changed === 'profile') c.launchProfile = 'other-profile'
    if (changed === 'home') c.launchDshHomeEl.value = '/other-home'
    if (changed === 'dialog') { c.launchDialogRevision += 1; c.launchDialogEl.hidden = true }
    c.syncLaunchCompatibility()
    resolve(incompatibleReport())
    await pending
    assert.equal(nodes.compatibilityPromptEl.value, '')
    assertNotGreen(nodes)
  })
}

test('UI State: repeated check while busy sends one read-only request and empty Copy does nothing', async () => {
  let resolve
  const { c, nodes, calls, copied } = editor(() => new Promise((done) => { resolve = done }))
  await c.copyCompatibilityPrompt()
  assert.deepEqual(copied, [])
  const pending = c.checkLaunchCompatibility()
  assert.equal(nodes.compatibilityCheckEl.disabled, true)
  assert.equal(nodes.compatibilityCheckEl['aria-busy'], 'true')
  await c.checkLaunchCompatibility()
  assert.equal(calls.filter((call) => call[0] === '/api/plugins/check-compatibility').length, 1)
  resolve(incompatibleReport())
  await pending
  assert.equal(nodes.compatibilityCheckEl.disabled, false)
  assert.equal(nodes.compatibilityCheckEl['aria-busy'], 'false')
})

test('UI State: clearing required target or profile prevents checks without affecting editor inputs', async () => {
  const { c, calls } = editor()
  c.launchVersionEl.value = ''
  c.launchVersion = ''
  c.syncLaunchCompatibility()
  assert.equal(c.compatibilityCheckEl.disabled, true)
  await c.checkLaunchCompatibility()
  c.launchVersionEl.value = TARGET
  c.launchProfile = ''
  c.syncLaunchCompatibility()
  assert.equal(c.compatibilityCheckEl.disabled, true)
  await c.checkLaunchCompatibility()
  assert.deepEqual(calls, [])
  assert.equal(c.launchDshHomeEl.value, DRAFT)
  assert.equal(c.editingLaunchId, 'saved-id')
})

test('UI EP: automatic target follows the draft home recommendation rather than the saved/global runtime', async () => {
  const { c, calls } = editor()
  const recommendations = []
  c.versionValue = 'auto'
  c.selected = () => '0.1.0'
  c.recommendedVersion = (...args) => { recommendations.push(plain(args)); return TARGET }
  assert.deepEqual(plain(c.compatibilityTarget()), { version: TARGET, profile: 'draft-profile', home: DRAFT })
  assert.deepEqual(recommendations.at(-1), ['draft-profile', DRAFT, 'rc'])
  await c.checkLaunchCompatibility()
  assert.deepEqual(calls.find((call) => call[0] === '/api/plugins/check-compatibility'), [
    '/api/plugins/check-compatibility', { version: TARGET, profile: 'draft-profile' }, { launchId: '', home: DRAFT },
  ])
})

test('UI EP: draft home overrides the saved launch; empty home inherits global', () => {
  const { c } = editor()
  assert.equal(c.compatibilityTarget().home, DRAFT)
  c.launchDshHomeEl.value = ''
  assert.equal(c.compatibilityTarget().home, '/global')
})

test('UI State: request failure is not green and retry can recover', async () => {
  let fail = true
  const { c, nodes } = editor(async () => { if (fail) throw new Error('offline check'); return incompatibleReport() })
  await c.checkLaunchCompatibility()
  assertNotGreen(nodes)
  assert.match(nodes.compatibilityStatusEl.textContent + nodes.compatibilityIssuesEl.textContent + nodes.compatibilityIssuesEl.innerHTML, /offline check/)
  assert.equal(nodes.compatibilityCheckEl.disabled, false)
  fail = false
  await c.checkLaunchCompatibility()
  assert.ok(nodes.compatibilityPromptEl.value.includes(TARGET))
})
