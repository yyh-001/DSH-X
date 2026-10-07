import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const source = html.slice(html.indexOf('    async function showPane('), html.indexOf('    navItems.forEach((item) => { item.onclick'))

function harness({ reduced = false, from = 'settings' } = {}) {
  const calls = []
  const element = (id) => {
    const classes = new Set()
    return {
      id, dataset: {}, style: {},
      classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name) } },
      setAttribute() {}, removeAttribute() {},
      animate(frames) { calls.push({ id, frames }); return { finished: Promise.resolve(), cancel() {} } },
    }
  }
  const rows = element('rows'), glass = element('glass')
  const control = element('pane-control'), settings = element('pane-settings'), plugins = element('pane-plugins')
  control.querySelector = (selector) => selector === '.launch-presets' ? rows : glass
  const panes = [control, settings, plugins]
  const current = panes.find((pane) => pane.id === `pane-${from}`)
  current.classList.add('active')
  const context = vm.createContext({
    document: {
      getElementById: (id) => panes.find((pane) => pane.id === id),
      querySelector: () => panes.find((pane) => pane.classList.contains('active')),
      documentElement: { classList: { contains: () => reduced } }, body: element('body'),
    },
    mainViewEl: element('main'), gearEl: element('gear'), panes,
    currentPane: from, currentSettingsCategory: 'general', paneMotionToken: 0, activePaneAnimation: null,
    navItems: [], navKey: () => '', settingsCategories: { general: ['常规', '说明'] },
    settingsSections: [], settingsTitleEl: element('title'), settingsSubtitleEl: element('subtitle'),
    paneLoaders: {}, placeNavPill() {}, t: (text) => text, matchMedia: () => ({ matches: false }),
  })
  vm.runInContext(source, context)
  return { context, calls, rows, glass, control, settings }
}

test('从设置返回主页只淡入启动项内容，毛玻璃与祖先不参与动画', async () => {
  const h = harness()
  await h.context.showPane('control')
  assert.deepEqual(h.calls.map((call) => call.id), ['pane-settings', 'rows'])
  assert.equal(h.context.currentPane, 'control')
  assert.equal(h.control.classList.contains('active'), true)
  assert.equal(h.context.mainViewEl.classList.contains('home'), true)
  assert.equal(h.calls[1].frames[0].opacity, 0, '保留启动项的淡入滑动')
  await h.context.showPane('settings')
  assert.deepEqual(h.calls.map((call) => call.id), ['pane-settings', 'rows', 'rows', 'pane-settings'], '离开主页也不能对毛玻璃祖先做淡出')
})

test('从其他设置面板返回也保持玻璃稳定，减少动画时直接切换', async () => {
  const h = harness({ from: 'plugins' })
  await h.context.showPane('control')
  assert.deepEqual(h.calls.map((call) => call.id), ['pane-plugins', 'rows'])
  const quiet = harness({ reduced: true })
  await quiet.context.showPane('control')
  assert.deepEqual(quiet.calls, [])
  assert.equal(quiet.context.currentPane, 'control')
})
