/**
 * 「Profile 备份与回退」的页面部分：环境页每张卡片的 ⋯ 菜单里新增入口，
 * 弹窗里列快照（时间 + 涉及文件）并支持「回退到此备份」。
 * 页面是无构建的原生 JS，这里读 HTML/CSS 源码做结构断言，纯函数抠进 vm 里跑，不起服务。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (name) => readFileSync(new URL(`../src/public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const page = read('index.html')
const css = read('launcher.css')

function section(from, to) {
  const start = page.indexOf(from)
  assert.ok(start >= 0, `页面里找不到「${from}」`)
  const end = page.indexOf(to, start + from.length)
  assert.ok(end > start, `「${from}」后面找不到「${to}」`)
  return page.slice(start, end)
}

function cssSection(from, to) {
  const start = css.indexOf(from)
  assert.ok(start >= 0, `样式里找不到「${from}」`)
  const end = css.indexOf(to, start + from.length)
  assert.ok(end > start, `「${from}」后面找不到「${to}」`)
  return css.slice(start, end)
}

function functionSource(name) {
  const start = [`    function ${name}(`, `    async function ${name}(`]
    .map((mark) => page.indexOf(mark)).find((index) => index >= 0)
  assert.ok(start >= 0, `页面里找不到函数 ${name}()`)
  let depth = 0
  for (let i = page.indexOf('{', start); i < page.length; i += 1) {
    if (page[i] === '{') depth += 1
    else if (page[i] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name}() 的花括号没有配平`)
}

test('弹窗结构：标题、提示、列表、立即备份/刷新和关闭按钮', () => {
  const dialog = section('id="backupDialog"', 'id="launchPluginsDialog"')
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby="backupDialogTitle"/)
  assert.match(dialog, /id="backupDialogTitle" data-i18n="Profile 备份与回退"/)
  assert.match(dialog, /<p class="dialog-subtitle" id="backupDialogHint">/)
  assert.match(dialog, /<div class="backup-list" id="backupList">/)
  assert.match(dialog, /id="backupRefresh"[^>]*data-i18n="刷新"/)
  assert.match(dialog, /id="backupNow"[^>]*data-i18n="立即备份"/)
  assert.match(dialog, /id="backupClose"[^>]*aria-label="关闭"/)
})

test('环境页卡片菜单多了「备份与回退」入口，图标和点击都接上', () => {
  const grid = section('function renderPackGrid()', '    function openPack(')
  assert.match(grid, /data-profile-backups="\$\{escapeHtml\(item\.profile\)\}"/)
  assert.match(grid, /packMoreIcons\.backup/)
  const menu = section("querySelectorAll('[data-profile-backups]')", "querySelectorAll('[data-profile-copy]')")
  assert.match(menu, /openProfileBackups\(button\.dataset\.profileBackups\)/)
  assert.match(page, /backup: '<svg viewBox="0 0 24 24"/)
  assert.match(page, /'备份与回退'/)
})

test('页面逻辑：列备份、回退先确认、成功后刷新插件与恢复档', () => {
  const restore = functionSource('restoreProfileBackup')
  assert.match(restore, /appConfirm\(/)
  assert.match(restore, /post\('\/api\/profile-backups\/restore'/)
  assert.match(restore, /loadPlugins\(\{ checkUpdates: false \}\)/)
  assert.match(restore, /loadRecovery\(backupProfile\)/)
  const load = functionSource('loadProfileBackups')
  assert.match(load, /\/api\/profile-backups\?profile=/)
  assert.match(page, /\/api\/profile-backups\/snapshot/)
  assert.match(page, /data-backup-restore=/)
  assert.match(page, /querySelectorAll\('\[data-backup-restore\]'\)/)
})

test('备份时间按本地时区格式化成 YYYY-MM-DD HH:mm:ss', () => {
  const sandbox = { Date, Number, String }
  vm.createContext(sandbox)
  vm.runInContext(functionSource('backupTimeText'), sandbox)
  const at = new Date(2023, 4, 6, 7, 8, 9).getTime()
  assert.equal(vm.runInContext(`backupTimeText(${at})`, sandbox), '2023-05-06 07:08:09')
  const zero = new Date(0)
  const pad = (value) => String(value).padStart(2, '0')
  const expected = `${zero.getFullYear()}-${pad(zero.getMonth() + 1)}-${pad(zero.getDate())} ${pad(zero.getHours())}:${pad(zero.getMinutes())}:${pad(zero.getSeconds())}`
  assert.equal(vm.runInContext('backupTimeText(null)', sandbox), expected)
})

test('打开弹窗：提示里带上 Profile 名，先清空列表再拉取', () => {
  const sandbox = {
    t: (zh, vars) => String(zh).replace(/\{(\w+)\}/g, (all, key) => (vars && key in vars ? vars[key] : all)),
    escapeHtml: (value) => String(value ?? ''),
    packBusy: false,
    pluginUpdating: false,
    pluginRemoving: '',
    pluginAdding: false,
    backupProfile: '',
    backupDialogEl: { hidden: true },
    painted: [],
    shown: [],
    backupHintEl: { textContent: '' },
    backupListEl: { innerHTML: '', querySelectorAll: () => [] },
    paintProfileBackups: (rows) => sandbox.painted.push(rows),
    showPackDialog: (dialog) => sandbox.shown.push(dialog),
    loadProfileBackups: () => { sandbox.loadRequested = true },
    document: { getElementById: (id) => (sandbox.elements[id] ||= { hidden: true, textContent: '', innerHTML: '' }) },
  }
  sandbox.elements = { backupDialog: { hidden: true } }
  vm.createContext(sandbox)
  vm.runInContext(functionSource('openProfileBackups'), sandbox)
  vm.runInContext("openProfileBackups('work')", sandbox)
  assert.match(sandbox.backupHintEl.textContent, /Profile「work」的配置层快照/)
  assert.equal(sandbox.painted.length, 1)
  assert.equal(sandbox.painted[0].length, 0)
  assert.equal(sandbox.shown.length, 1)
  assert.equal(sandbox.loadRequested, true)
})

test('列表渲染：空列表给提示，有备份时每行是时间 + 文件 + 回退按钮', () => {
  const sandbox = {
    t: (zh, vars) => String(zh).replace(/\{(\w+)\}/g, (all, key) => (vars && key in vars ? vars[key] : all)),
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
    handlers: [],
    backupListEl: {
      innerHTML: '',
      querySelectorAll: () => sandbox.handlers,
    },
    restoreProfileBackup: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(functionSource('backupTimeText'), sandbox)
  vm.runInContext(functionSource('paintProfileBackups'), sandbox)
  vm.runInContext('paintProfileBackups([])', sandbox)
  assert.match(sandbox.backupListEl.innerHTML, /还没有备份/)
  const at = new Date(2024, 0, 2, 3, 4, 5).getTime()
  sandbox.handlers = [{ dataset: { backupRestore: '123-000000' }, onclick: null }]
  sandbox.backupListEl.querySelectorAll = () => sandbox.handlers
  vm.runInContext(`paintProfileBackups([{ id: '123-000000', createdAt: ${at}, files: [{ name: 'package.json' }, { name: 'cordis.patch.yml' }] }])`, sandbox)
  assert.match(sandbox.backupListEl.innerHTML, /2024-01-02 03:04:05/)
  assert.match(sandbox.backupListEl.innerHTML, /package\.json、cordis\.patch\.yml/)
  assert.match(sandbox.backupListEl.innerHTML, /data-backup-restore="123-000000"/)
  assert.match(sandbox.backupListEl.innerHTML, /回退到此备份/)
  assert.equal(typeof sandbox.handlers[0].onclick, 'function')
})

test('样式与英文文案：列表限高滚动、行内按钮不换行，文案全部有译文', () => {
  const styles = cssSection('.backup-list {', '.pack-source {')
  assert.match(styles, /\.backup-list \{[^}]*max-height: min\(46vh, 360px\)[^}]*overflow-y: auto/)
  assert.match(styles, /\.backup-row \{[^}]*display: flex[^}]*align-items: center/)
  assert.match(styles, /\.backup-files \{[^}]*overflow-wrap: anywhere/)
  const en = page.slice(page.indexOf('const EN = {'), page.indexOf('\n}\n', page.indexOf('const EN = {')))
  for (const key of ['备份与回退', 'Profile 备份与回退', '回退到此备份', '立即备份', '回退完成', '已生成新备份。', '配置没有变化，不需要新备份。', '备份']) {
    assert.ok(en.includes(`"${key}":`), `英文文案缺少「${key}」`)
  }
})
