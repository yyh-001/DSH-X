/**
 * 启动项日志弹窗里的「空间构成」卡片：结构、i18n、以及分类条/图例/top5 的渲染。
 * 真正的目录统计在 test/storage-breakdown.test.mjs 里走接口验证。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../src/public/launcher.css', import.meta.url)), 'utf8')
const translate = (text, vars = {}) => Object.entries(vars).reduce((out, [key, value]) => out.split(`{${key}}`).join(String(value)), text)

test('启动项日志里有空间构成卡片，日志打开时按启动项拉取', () => {
  assert.match(html, /<section class="launch-log-card" id="launchLogSpace"[^>]*hidden>/)
  assert.match(html, /id="launchLogSpaceMeta"/)
  assert.match(html, /id="launchLogSpaceBody"/)
  assert.match(html, /data-i18n="空间构成">空间构成/)
  assert.match(html, /if \(version\) void loadStorageBreakdown\(entry, version\)/, '打开日志时按版本 + profile 取空间构成')
  assert.match(html, /\/api\/storage\/breakdown\?version=/, '走按启动项作用域的接口')
  assert.match(html, /'x-dsh-launch-id'|launchId: entry\.id/, '自定义目录的启动项要带上 launchId')
  assert.match(css, /\.ledger-data \{[^}]*background:/, '配置与数据有自己的颜色')
})

test('空间构成：分类条、各插件占用、top5 和总计都画出来', () => {
  const code = html.slice(
    html.indexOf('    function renderStorageBreakdown('),
    html.indexOf('    async function loadStorageBreakdown('),
  )
  const sandbox = {
    t: translate,
    escapeHtml: (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    formatBytes: (bytes) => `${(Number(bytes) / 1048576).toFixed(1)} MB`,
    launchLogSpaceEl: { hidden: true },
    launchLogSpaceMetaEl: { textContent: '' },
    launchLogSpaceBodyEl: { innerHTML: '', hidden: false },
    launchLogSpaceEmptyEl: { hidden: true, textContent: '' },
    showLaunchLogEmpty(element, text) {
      element.hidden = !text
      element.textContent = text || ''
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  const mb = 1048576
  vm.runInContext(`renderStorageBreakdown(${JSON.stringify({
    total: 200 * mb,
    segments: [
      { key: 'plugin', bytes: 20 * mb },
      { key: 'plugin-deps', bytes: 80 * mb },
      { key: 'runtime', bytes: 60 * mb },
      { key: 'runtime-deps', bytes: 30 * mb },
      { key: 'data', bytes: 10 * mb },
      { key: 'rest', bytes: 0 },
    ],
    plugins: [
      { name: 'dsh-ops', bytes: 100 * mb },
      { name: 'dsh-im', bytes: 20 * mb },
    ],
    items: [
      { name: 'bash-win32-x64', bytes: 80 * mb, plugin: false },
      { name: '@deepseek-ai/dsh', bytes: 60 * mb, plugin: false },
    ],
  })})`, sandbox)

  assert.equal(sandbox.launchLogSpaceBodyEl.hidden, false, '数据到了，内容区显示')
  assert.equal(sandbox.launchLogSpaceEmptyEl.hidden, true, '空状态收起')
  assert.equal(sandbox.launchLogSpaceMetaEl.textContent, '合计 200.0 MB')
  const body = sandbox.launchLogSpaceBodyEl.innerHTML
  assert.match(body, /ledger-plugin[^>]*>.*?10%/, '插件本体 20/200 = 10%')
  assert.match(body, /ledger-plugin-deps/)
  assert.match(body, /ledger-runtime/)
  assert.match(body, /ledger-runtime-deps/)
  assert.match(body, /ledger-data/)
  assert.doesNotMatch(body, /ledger-rest/, '0 字节的分类不画')
  assert.match(body, /插件本体/)
  assert.match(body, /插件依赖/)
  assert.match(body, /运行时依赖/)
  assert.match(body, /各插件占用（含它带进来的依赖）/)
  assert.match(body, /dsh-ops/, '各插件占用里有插件名')
  assert.match(body, /100\.0 MB/, '插件总占用含它带进来的依赖')
  assert.match(body, /最占空间的 5 项/)
  assert.match(body, /bash-win32-x64/)
  assert.match(body, /共享 store 不重复计入/)
})
