/**
 * 启动项日志弹窗的页签：原始日志常驻，耗时/空间/诊断有数据才出现；切走的页签要收起来。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
const code = html.slice(
  html.indexOf('    function paintLaunchLogTabs('),
  html.indexOf('    function syncLaunchLogVisual('),
)

function button(key) {
  return { dataset: { logTab: key }, hidden: false, attrs: {}, tabIndex: 0, setAttribute(name, value) { this.attrs[name] = value } }
}
function tabs() {
  const buttons = ['raw', 'time', 'space'].map(button)
  const panels = { raw: { hidden: false }, time: { hidden: true }, space: { hidden: true } }
  const diagnosis = { hidden: true }
  const sandbox = {
    launchLogTab: 'raw',
    launchLogAvailable: { raw: true, time: false, space: false, diagnosis: false },
    launchLogTabButtons: buttons,
    launchLogPanels: panels,
    launchLogDiagnosisEl: diagnosis,
    launchLogTabsEl: { hidden: true },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { sandbox, buttons, panels, diagnosis }
}

test('日志弹窗结构：只有原始/耗时/空间三个页签，插件诊断跟着原始日志', () => {
  assert.match(html, /id="launchLogTabs" role="tablist"/)
  for (const key of ['raw', 'time', 'space']) {
    assert.match(html, new RegExp(`data-log-tab="${key}"`), `缺少 ${key} 页签`)
    assert.match(html, new RegExp(`data-log-panel="${key}"`), `缺少 ${key} 面板`)
  }
  assert.doesNotMatch(html, /data-log-tab="diagnosis"/, '插件诊断不再单独占页签')
  assert.doesNotMatch(html, /data-log-panel="diagnosis"/)
  assert.match(html, /id="launchLogDiagnosis"[^>]*hidden/, '诊断卡片本身还在，和原始日志同屏')
  assert.match(html, /data-log-panel="raw">/)
  assert.match(css, /\.launch-log-tabs \{[^}]*display: flex/)
  assert.match(css, /\.launch-log-tab\[aria-selected="true"\]/)
  assert.match(css, /#launchLogSpace \.launch-log-block[^{]*\{[^}]*overflow-y: auto/, '空间构成卡片内部要能滚动')
})

test('没有内容的页签收起；切走的面板隐藏；当前页签消失时回到原始日志', () => {
  const { sandbox, buttons, panels, diagnosis } = tabs()
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(buttons[0].hidden, false, '原始日志常驻')
  assert.equal(buttons[1].hidden, true, '没有耗时账本时不显示耗时页签')
  assert.equal(panels.raw.hidden, false)
  assert.equal(panels.time.hidden, true)
  assert.equal(sandbox.launchLogTabsEl.hidden, false)
  assert.equal(diagnosis.hidden, true, '没有诊断数据时不显示诊断卡片')

  sandbox.launchLogAvailable.diagnosis = true
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(diagnosis.hidden, false, '有诊断数据时和原始日志一起显示')

  sandbox.launchLogAvailable.time = true
  sandbox.launchLogTab = 'time'
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(buttons[1].hidden, false)
  assert.equal(buttons[1].attrs['aria-selected'], 'true')
  assert.equal(panels.time.hidden, false)
  assert.equal(panels.raw.hidden, true, '切走的面板要收起来')
  assert.equal(diagnosis.hidden, true, '诊断卡片只在原始日志页显示')

  sandbox.launchLogAvailable.time = false
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(sandbox.launchLogTab, 'raw', '当前页签没数据了，回到原始日志')
  assert.equal(panels.raw.hidden, false)
  assert.equal(buttons[0].attrs['aria-selected'], 'true')
  assert.equal(diagnosis.hidden, false, '回到原始日志后诊断卡片跟着回来')
})
