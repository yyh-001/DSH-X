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
    launchLogRssEl: { hidden: false, textContent: '', title: '' },
    launchLogTimeEmptyEl: { hidden: true, textContent: '' },
    showLaunchLogEmpty(element, text) {
      element.hidden = !text
      element.textContent = text || ''
    },
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
  assert.match(dom, /各插件耗时（含依赖加载与运行）/)
  assert.match(dom, /原生与 GC 明细/)
  assert.match(dom, /dsh-ops/)
  assert.match(dom, /32\.50s/, '插件行显示总耗时')
  assert.ok(dom.indexOf('dsh-ops') < dom.indexOf('codex'), '原生时间高的插件排前面')
  assert.ok(dom.indexOf('open') < dom.indexOf('readFileUtf8'))
  assert.match(dom, /JS 500ms · 原生 32\.00s/, '悬停能看到 JS 与原生拆分')
  assert.match(dom, /<i class="ledger-native"><\/i>未归属原生\/GC <b>300ms<\/b>/, '未归属部分单列')
  assert.equal(sandbox.launchLogWindowEl.textContent, '窗口 43.40s · CPU 43.40s')
})

test('新报告按插件合并依赖加载与运行耗时，Node 内部不占最耗时列表', () => {
  const sandbox = render({
    windowMs: 9200,
    cpuMs: 9000,
    nativeUnattributedMs: 50,
    plugins: [
      { name: 'dsh-ops', loadMs: 4000, runMs: 800, totalMs: 4800 },
      { name: 'dsh-im', loadMs: 1200, runMs: 300, totalMs: 1500 },
      { name: 'dsh-market', loadMs: 0, runMs: 0, totalMs: 0 },
    ],
    packages: [
      { name: '(Node 内部)', cpuMs: 1200, nativeMs: 5000, loadMs: 0, resolveMs: 0, totalMs: 6200, plugin: false },
      { name: 'dsh-ops', cpuMs: 500, nativeMs: 100, loadMs: 250, resolveMs: 3000, totalMs: 3750, plugin: true },
      { name: 'bash', cpuMs: 100, nativeMs: 0, loadMs: 80, resolveMs: 20, totalMs: 200, plugin: false },
    ],
    native: [{ name: 'lstat', cpuMs: 1600 }],
  })
  const dom = sandbox.launchLogPluginsEl.innerHTML
  assert.match(dom, /<i class="ledger-plugin"><\/i>插件（加载\+运行） <b>6\.30s<\/b>/)
  assert.match(dom, /<i class="ledger-node"><\/i>运行时与其它 <b>2\.65s<\/b>/)
  assert.match(dom, /各插件耗时（含依赖加载与运行）/)
  assert.match(dom, /加载 4\.00s · 运行 800ms/)
  assert.ok(dom.indexOf('dsh-ops') < dom.indexOf('dsh-im'), '加载+运行高的插件排前面')
  assert.doesNotMatch(dom, /最耗时的 5 项（不含 Node 内部）[\s\S]*?<span class="name"[^>]*>\(Node 内部\)/, 'Node 内部不重复占榜')
  assert.match(dom, /加载 250ms · 解析 3\.00s · JS 500ms · 原生 100ms/)
  assert.match(dom, /插件合计 70%（含它带进来的依赖）/)
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
  assert.match(dom, /插件合计 18%（含它带进来的依赖）/)
})

test('没有账本数据时收起卡片', () => {
  const sandbox = render({ windowMs: 10, cpuMs: 10, packages: [], native: [] })
  assert.equal(sandbox.launchLogPluginsEl.hidden, true)
  assert.equal(sandbox.launchLogPluginsEl.innerHTML, '')
})

test('耗时构成也改成卡片内部滚动', () => {
  assert.match(css, /#launchLogVisual \.launch-log-block \{[^}]*overflow-y: auto/, '耗时构成卡片内部要能滚动')
})
