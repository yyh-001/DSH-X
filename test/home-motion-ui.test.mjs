import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const motionCode = readFileSync(new URL('../src/public/motion.js', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const launcherCss = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')
const bootCss = readFileSync(new URL('../src/public/launcher-boot.css', import.meta.url), 'utf8')
const mascotCss = readFileSync(new URL('../src/public/mascot.css', import.meta.url), 'utf8')
const themeCss = readFileSync(new URL('../src/public/theme.css', import.meta.url), 'utf8')

const section = (from, to) => {
  const start = page.indexOf(from)
  assert.ok(start >= 0, `找不到片段起点: ${from}`)
  const end = page.indexOf(to, start)
  assert.ok(end > start, `找不到片段终点: ${to}`)
  return page.slice(start, end)
}

test('motion.js：暴露统一时长、缓动曲线与减少动态监听，并按需退订观察器', () => {
  const classes = new Set()
  const listeners = new Set()
  let observed = 0
  let disconnected = 0
  let observerCallback = null
  const media = {
    matches: false,
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn) },
  }
  const root = {
    dataset: {},
    classList: {
      contains: (name) => classes.has(name),
    },
  }
  class FakeObserver {
    constructor(cb) { observerCallback = cb }
    observe() { observed += 1 }
    disconnect() { disconnected += 1 }
  }
  const context = vm.createContext({
    document: { documentElement: root },
    matchMedia: () => media,
    MutationObserver: FakeObserver,
    Object,
    Set,
    Boolean,
  })
  context.globalThis = context
  vm.runInContext(motionCode, context)

  const motion = context.launcherMotion
  assert.ok(motion)
  assert.equal(Object.isFrozen(motion), true)
  assert.equal(Object.isFrozen(motion.duration), true)
  assert.equal(Object.isFrozen(motion.ease), true)
  assert.equal(motion.duration.fast, 150)
  assert.equal(motion.duration.base, 220)
  assert.equal(motion.reduced(), false)

  classes.add('reduce-motion')
  assert.equal(motion.reduced(), true)
  classes.delete('reduce-motion')
  root.dataset.reduceMotion = 'true'
  assert.equal(motion.reduced(), true)
  delete root.dataset.reduceMotion
  media.matches = true
  assert.equal(motion.reduced(), true)
  media.matches = false

  const seen = []
  const offA = motion.onReduceChange((value) => seen.push(['a', value]))
  const offB = motion.onReduceChange((value) => seen.push(['b', value]))
  assert.equal(observed, 1, '共用单个 MutationObserver')

  media.matches = true
  for (const fn of listeners) fn()
  assert.deepEqual(seen, [['a', true], ['b', true]])

  media.matches = false
  classes.add('reduce-motion')
  observerCallback()
  assert.deepEqual(seen.slice(2), [['a', true], ['b', true]])

  offA()
  assert.equal(disconnected, 0, '还有订阅者时不提前断开')
  offB()
  assert.equal(disconnected, 1, '最后一个订阅退订后断开观察器并释放媒体监听')
  assert.equal(listeners.size, 0)

  const animCalls = []
  const node = {
    animate(frames, options) {
      animCalls.push({ frames, options })
      return { cancel() {} }
    },
  }
  assert.equal(motion.animate(node, [{ opacity: 0 }, { opacity: 1 }]), null, '减少动态开启时不创建 WAAPI 动画')
  assert.equal(animCalls.length, 0)

  classes.delete('reduce-motion')
  const anim = motion.animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: motion.duration.fast })
  assert.ok(anim)
  assert.equal(animCalls.length, 1)
  assert.equal(animCalls[0].options.duration, motion.duration.fast)
  assert.equal(animCalls[0].options.easing, motion.ease.standard)
})

test('CSS 动效令牌、全局减少动态、暗色危险色与停止按钮色彩均已收口', () => {
  for (const token of [
    '--motion-instant: 120ms',
    '--motion-fast: 150ms',
    '--motion-base: 220ms',
    '--motion-slow: 280ms',
    '--motion-enter: 460ms',
    '--ease-standard:',
    '--ease-decelerate:',
    '--ease-accelerate:',
    '--ease-spring:',
    '--danger-soft:',
    '--danger-border:',
    '--status-running:',
    '--status-starting:',
  ]) {
    assert.ok(launcherCss.includes(token), `launcher.css 应定义 ${token}`)
  }

  assert.match(launcherCss, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{[\s\S]*animation-duration:\s*0\.01ms !important[\s\S]*transition-duration:\s*0\.01ms !important/, 'launcher.css 应有全局 prefers-reduced-motion 兜底')
  assert.match(launcherCss, /html\.reduce-motion \*,\s*html\.reduce-motion \*::before,\s*html\.reduce-motion \*::after/, 'launcher.css 应有全局 html.reduce-motion 兜底')
  assert.match(bootCss, /html\.reduce-motion \.launcher-boot/, 'launcher-boot.css 应同步尊重 html.reduce-motion')
  assert.match(mascotCss, /html\.reduce-motion \.mascot\s*\{\s*animation:\s*none;/, 'mascot.css 应尊重 html.reduce-motion')

  assert.match(themeCss, /--danger:\s*#f2797f;/, '暗色主题 --danger 应使用红色')
  assert.doesNotMatch(themeCss, /--danger:\s*#f0f0f2/, '暗色主题 --danger 不能再用灰白色')
  assert.match(themeCss, /--danger-soft:/, '暗色主题应定义 --danger-soft')
  assert.match(themeCss, /--danger-border:/, '暗色主题应定义 --danger-border')

  const stopRule = launcherCss.match(/\.launch-actions \[data-stop-id\][^{]*\{[^}]+\}/)?.[0] || ''
  assert.match(stopRule, /background:\s*var\(--card\)/, '停止按钮应使用卡片底色变量')
  assert.match(stopRule, /color:\s*var\(--danger\)/, '停止按钮应使用 --danger 变量')
  assert.doesNotMatch(stopRule, /#fff|#e5484d/, '停止按钮不能硬编码浅色白底或亮红')

  assert.ok(page.indexOf('/motion.js') > 0 && page.indexOf('/motion.js') < page.indexOf('/launcher-boot.js'), 'index.html 应先于 launcher-boot.js 引入 /motion.js')
  assert.doesNotMatch(page, /id="launchMoreMenu"/, '不再保留首页 ⋯ 下拉菜单，动作直接展开在行尾')
})

function homeHarness({
  entries,
  instances = [],
  failure = null,
  dshHome = 'C:\\Users\\demo\\.dsh',
  dshHomeNames = {},
  viewed = [],
  action = '',
  installing = null,
  installingTask = '',
  latestVersion = '0.2.0',
} = {}) {
  const keys = section('    const launchActions =', '    let launchHomeMarkup =')
  const paint = section('    function paintLaunchHome(', '    async function manageLaunchEntry(')
  const list = { innerHTML: '', querySelectorAll: () => [], insertAdjacentElement() {}, querySelector: () => null }
  const seen = new Set(viewed)
  const context = vm.createContext({
    state: { dshHome, dshHomeNames, instances, installed: ['0.2.0'], launchPresets: entries, installing, failure },
    action,
    launchEntries: () => entries,
    installedList: () => ['0.2.0'],
    resolveLaunchVersion: (entry) => (entry.version === 'auto' ? '0.2.0' : entry.version),
    launchLatestVersion: () => latestVersion,
    compareVersion: (a, b) => (a === b ? 0 : a > b ? 1 : -1),
    runningInfo: (version, profile, home) => instances.find((item) => item.version === version && item.profile === profile && (item.home || dshHome) === (home || dshHome)) || null,
    launchHomeOf: (entry) => entry.dshHome || dshHome,
    launchTargetLabel: (entry) => entry.wslDistro || 'remote-host',
    pluginHomeName: (home, fallback) => Object.entries(dshHomeNames).find(([k]) => k.toLowerCase() === home.toLowerCase())?.[1] || fallback,
    diagnosisIssueRows: (diag) => diag?.rows || [],
    diagnosisSeenKey: (entry, warning, rows) => `${entry.id}:${warning?.binding?.attemptId || ''}:${rows.map((r) => r.name).join(',')}`,
    viewedDiagnosis: seen,
    startupElapsed: () => 3,
    startupPhaseText: (phase) => phase || '',
    launchIconMarkup: () => '<svg></svg>',
    lanErrorText: (err) => err,
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    t: (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
    render() {},
    openInstance: async () => {},
    notify() {},
    notifyError() {},
    post: async () => ({}),
    openBootPage: async () => true,
    launchPresetsEl: list,
    launchDialogEl: { hidden: true },
    launchSaveEl: { disabled: false },
    launchDeleteEl: { disabled: false },
    launchDialogClosing: false,
    launchHomeMarkup: '',
    launchAddEl: { hidden: true, disabled: false, focus() {}, title: '', ariaLabel: '' },
    DEFAULT_LAUNCH_ID: 'default',
    document: { activeElement: null },
  })
  vm.runInContext(keys + paint, context)
  if (installingTask) {
    context.launchActions.set('task', { launchId: installingTask, phase: 'start' })
  }
  return { context, list, seen }
}

test('主页卡片：5 种图标状态点、短目录名+完整路径 tooltip、直接展开的操作按钮与红点诊断状态', () => {
  const entries = [
    { id: 'idle', name: '空闲项', version: '0.2.0', profile: 'web', dshHome: 'D:\\workspaces\\proj-alpha' },
    { id: 'run', name: '运行项', version: '0.2.0', profile: 'run', dshHome: 'D:\\workspaces\\proj-beta\\' },
    { id: 'boot', name: '启动中项', version: '0.2.0', profile: 'boot' },
    { id: 'stop', name: '停止中项', version: '0.2.0', profile: 'stop' },
    { id: 'err', name: '失败项', version: 'auto', profile: 'broken', dshHome: 'E:\\custom-dsh' },
    { id: 'wsl', name: 'WSL 项', backend: 'wsl', wslDistro: 'Ubuntu', version: 'auto', profile: 'web' },
  ]
  const h = homeHarness({
    entries,
    dshHomeNames: { 'D:\\workspaces\\proj-beta\\': 'Beta 工作区' },
    instances: [
      {
        version: '0.2.0', profile: 'run', home: 'D:\\workspaces\\proj-beta\\', status: 'running', url: 'http://127.0.0.1:1234',
        diagnosticWarning: { binding: { attemptId: 'att-1' }, diagnosis: { rows: [{ name: 'bad-plugin' }] } },
      },
      { version: '0.2.0', profile: 'boot', home: 'C:\\Users\\demo\\.dsh', status: 'starting', startupPhase: '加载插件' },
      { version: '0.2.0', profile: 'stop', home: 'C:\\Users\\demo\\.dsh', status: 'stopping' },
    ],
    failure: { version: '0.2.0', profile: 'broken', home: 'E:\\custom-dsh', message: 'boom' },
    latestVersion: '0.3.0',
  })

  h.context.paintLaunchHome()
  const chunks = Object.fromEntries(
    h.list.innerHTML.split('<div class="launch-preset"').slice(1).map((raw) => {
      const key = raw.match(/data-launch-key="([^"]+)"/)?.[1]
      return [key, `<div class="launch-preset"${raw}`]
    }),
  )

  // 1. 图标状态点（含失败匹配）
  assert.doesNotMatch(chunks.idle, /class="launch-status-dot"/, '空闲项不画状态点')
  assert.doesNotMatch(chunks.idle, /data-status=/, '空闲项不设 data-status')
  assert.match(chunks.run, /class="launch-preset" data-status="running"/)
  assert.match(chunks.run, /<span class="launch-status-dot" aria-hidden="true"><\/span>/)
  assert.match(chunks.boot, /class="launch-preset" data-status="starting"/)
  assert.match(chunks.stop, /class="launch-preset" data-status="stopping"/)
  assert.match(chunks.err, /class="launch-preset" data-status="error"/)
  assert.match(chunks.err, /title="上次启动失败 · 拖动或用方向键排序"/)

  // 2. 元信息行仅展示文件夹短名或别名，完整路径在 title 里
  assert.match(chunks.idle, /<span class="launch-meta-home" title="D:\\workspaces\\proj-alpha">proj-alpha<\/span>/)
  assert.doesNotMatch(chunks.idle, />D:\\workspaces\\proj-alpha</)
  assert.match(chunks.run, /<span class="launch-meta-home" title="D:\\workspaces\\proj-beta\\">Beta 工作区<\/span>/)

  // 3. 动作区：所有卡片保留铅笔编辑按钮，本机卡片展开 管理实例 / 日志 / 编辑 / 重启(仅运行) / 停止(仅运行) 与主启动按钮
  assert.doesNotMatch(chunks.run, /data-more-id=/, '移除 ⋯ 折叠按钮')
  assert.match(chunks.idle, /data-plugins-id="idle"/)
  assert.doesNotMatch(chunks.idle, /data-plugins-id="idle"[^>]*\shidden/)
  assert.match(chunks.idle, /data-log-id="idle"/)
  assert.match(chunks.idle, /data-edit-id="idle"/)
  assert.doesNotMatch(chunks.idle, /data-restart-id=|data-stop-id=/, '未运行时不展示重启与停止按钮')
  assert.match(chunks.wsl, /class="launch-edit launch-plugins" hidden[^>]*data-plugins-id="wsl"/, 'WSL 隐藏管理实例')
  assert.match(chunks.wsl, /data-edit-id="wsl"/, '远程(WSL/SSH)卡片仍保留编辑按钮')

  assert.match(chunks.run, /class="launch-edit launch-log has-issue"[^>]*data-log-id="run"/)
  assert.match(chunks.run, /data-edit-id="run"/)
  assert.match(chunks.run, /data-restart-id="run"/)
  assert.match(chunks.run, /data-stop-id="run"/)
  assert.match(chunks.boot, /data-plugins-id="boot"[^>]*disabled/)
  assert.match(chunks.boot, /data-edit-id="boot"[^>]*disabled/)
  assert.match(chunks.boot, /data-restart-id="boot"[^>]*disabled/)
  assert.match(chunks.err, /class="launch-edit launch-new-version has-update"[\s\S]*data-version-id="err"/, 'auto 项发现新版本时保留升级徽章')

  // 4. 已读诊断后红点消失
  h.seen.add('run:att-1:bad-plugin')
  h.context.paintLaunchHome()
  assert.doesNotMatch(h.list.innerHTML, /data-log-id="run"[^>]*has-issue|has-issue"[^>]*data-log-id="run"/)

  const enDict = new vm.Script(`(${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['管理实例', '查看 {name} 的日志', '编辑 {name}', '重启', '有插件警告', '上次启动失败']) {
    assert.ok(enDict[key], `英文词典缺少「${key}」`)
  }
})
