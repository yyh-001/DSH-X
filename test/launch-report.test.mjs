/**
 * 耗时构成卡片：插件要按「JS + 它触发的原生/GC」排序，旧报告没有归属字段时仍按 CPU 显示。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
const code = html.slice(
  html.indexOf('    function renderLaunchReport('),
  html.indexOf('    async function loadLaunchReport('),
)

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function render(report) {
  const sandbox = {
    report,
    launchLogPluginsEl: { hidden: true, innerHTML: '' },
    launchLogWindowEl: { textContent: '' },
    syncLaunchLogVisual() { sandbox.visualSynced += 1 },
    visualSynced: 0,
    escapeHtml,
    formatProfileMs: (ms) => {
      const value = Number(ms) || 0
      return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
    },
    t: (key, params) => key.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? '')),
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  vm.runInContext('renderLaunchReport(report)', sandbox)
  return sandbox
}

test('插件按含原生/GC 的总耗时排序，并单列原生明细', () => {
  const sandbox = render({
    windowMs: 43400,
    cpuMs: 43400,
    nativeUnattributedMs: 300,
    packages: [
      { name: 'dsh-ops', cpuMs: 500, nativeMs: 32000, totalMs: 32500, plugin: true },
      { name: 'codex', cpuMs: 300, nativeMs: 5000, totalMs: 5300, plugin: true },
      { name: '(Node 内部)', cpuMs: 2000, nativeMs: 100, totalMs: 2100, plugin: false },
      { name: 'semver', cpuMs: 100, nativeMs: 0, totalMs: 100, plugin: false },
    ],
    native: [
      { name: 'open', cpuMs: 20900 },
      { name: 'readFileUtf8', cpuMs: 12950 },
    ],
  })
  assert.equal(sandbox.launchLogPluginsEl.hidden, false)
  assert.equal(sandbox.visualSynced, 1, '渲染后要同步页签可用性')
  const dom = sandbox.launchLogPluginsEl.innerHTML
  assert.match(dom, /各插件耗时（含它触发的原生\/GC）/)
  assert.match(dom, /原生与 GC 明细/)
  assert.match(dom, /dsh-ops/)
  assert.match(dom, /32\.50s/, '插件行显示总耗时')
  assert.ok(dom.indexOf('dsh-ops') < dom.indexOf('codex'), '原生时间高的插件排前面')
  assert.ok(dom.indexOf('open') < dom.indexOf('readFileUtf8'))
  assert.match(dom, /JS 500ms · 原生 32\.00s/, '悬停能看到 JS 与原生拆分')
  assert.match(dom, /<i class="ledger-native"><\/i>未归属原生\/GC <b>300ms<\/b>/, '未归属部分单列')
  assert.equal(sandbox.launchLogWindowEl.textContent, '窗口 43.40s · CPU 43.40s')
})

test('旧报告没有原生归属字段时，按 CPU 显示、原生仍单列', () => {
  const sandbox = render({
    windowMs: 5000,
    cpuMs: 5000,
    packages: [
      { name: 'demo-plugin', cpuMs: 900, allocKB: 10, plugin: true },
      { name: 'semver', cpuMs: 100, allocKB: 1, plugin: false },
    ],
    native: [{ name: 'open', cpuMs: 2000 }],
  })
  const dom = sandbox.launchLogPluginsEl.innerHTML
  assert.match(dom, /demo-plugin/)
  assert.match(dom, /900ms/, '没有 totalMs 时退回 cpuMs')
  assert.match(dom, /<i class="ledger-native"><\/i>未归属原生\/GC <b>2\.00s<\/b>/, '旧报告的原生全部单列')
  assert.match(dom, /插件（含它触发的原生\/GC）合计 18%/)
})

test('没有账本数据时收起卡片', () => {
  const sandbox = render({ windowMs: 10, cpuMs: 10, packages: [], native: [] })
  assert.equal(sandbox.launchLogPluginsEl.hidden, true)
  assert.equal(sandbox.launchLogPluginsEl.innerHTML, '')
})

test('耗时构成也改成卡片内部滚动', () => {
  assert.match(css, /#launchLogVisual \.launch-log-block \{[^}]*overflow-y: auto/, '耗时构成卡片内部要能滚动')
})
