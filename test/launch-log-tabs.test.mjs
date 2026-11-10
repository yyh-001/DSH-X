/**
 * 启动项日志弹窗的页签：原始日志 / 耗时构成 / 空间构成三个常驻；
 * 没有内容的页签显示空状态，不把按钮收起来。切走的页面要藏起来。
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
  const panels = {
    raw: { hidden: false, dataset: {} },
    time: { hidden: true, dataset: {} },
    space: { hidden: true, dataset: {} },
  }
  const diagnosis = { hidden: true }
  const sandbox = {
    launchLogTab: 'raw',
    launchLogShownIndex: -1,
    launchLogAvailable: { diagnosis: false },
    launchLogTabButtons: buttons,
    launchLogPanels: panels,
    launchLogDiagnosisEl: diagnosis,
    launchLogTabsEl: { hidden: true, dataset: {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { sandbox, buttons, panels, diagnosis }
}

test('日志弹窗结构：三个页签常驻，插件诊断跟着原始日志', () => {
  assert.match(html, /id="launchLogTabs" role="tablist"/)
  for (const key of ['raw', 'time', 'space']) {
    assert.match(html, new RegExp(`data-log-tab="${key}"`), `缺少 ${key} 页签`)
    assert.match(html, new RegExp(`data-log-panel="${key}"`), `缺少 ${key} 面板`)
  }
  assert.match(html, /data-log-tab="time" aria-selected="false" data-i18n="耗时构成">/, '耗时页签默认就在，不再 hidden')
  assert.match(html, /data-log-tab="space" aria-selected="false" data-i18n="空间构成">/, '空间页签默认就在，不再 hidden')
  assert.doesNotMatch(html, /data-log-tab="diagnosis"/, '插件诊断不再单独占页签')
  assert.doesNotMatch(html, /data-log-panel="diagnosis"/)
  assert.match(html, /id="launchLogDiagnosis"[^>]*hidden/, '诊断卡片本身还在，和原始日志同屏')
  assert.match(html, /data-log-panel="raw">/)
  for (const id of ['launchLogTimeEmpty', 'launchLogSpaceEmpty', 'launchLogRawEmpty']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少空状态 ${id}`)
  }
  assert.match(html, /showLaunchLogEmpty\(launchLogTimeEmptyEl, t\('还没有耗时数据'\)\)/)
  assert.match(html, /showLaunchLogEmpty\(launchLogSpaceEmptyEl, t\('还没有空间占用数据'\)\)/)
  assert.match(html, /showLaunchLogEmpty\(launchLogRawEmptyEl, logText\.trim\(\) \? '' : t\('还没有日志'\)\)/)
  assert.ok(html.indexOf('id="launchLogLoading"') > html.indexOf('id="launchLogCard"'), '加载行在原始日志卡片里，不再占页签和卡片之间的空位')
  assert.match(css, /#launchLogDialog \.launch-log-loading \{ flex: 1 1 auto; min-height: 0; \}/, '加载行撑满卡片并居中')
  assert.match(css, /\.launch-log-tabs \{[^}]*display: flex/)
  assert.match(css, /\.launch-log-tab\[aria-selected="true"\]/)
  assert.match(css, /\.launch-log-empty \{[^}]*display: grid/, '空状态占满卡片剩余空间')
  assert.match(css, /\.launch-log-empty\[hidden\] \{ display: none; \}/, 'grid 不能盖掉 [hidden] 的 display:none')
  assert.match(css, /#launchLogSpace \.launch-log-block[^{]*\{[^}]*overflow-y: auto/, '空间构成卡片内部要能滚动')
})

test('日志弹窗固定高度，切页签不再忽高忽低；内容在卡片内部滚动', () => {
  assert.match(css, /#launchLogDialog \.ask-card \{[^}]*height: min\(700px, calc\(100dvh - var\(--dialog-safe-area\)\)\)/, '窗口高度固定并受视口上限约束')
  assert.match(css, /#launchLogDialog \.launch-log-card:not\(\[hidden\]\) \{[^}]*display: flex[^}]*flex-direction: column/, '卡片纵向排布，正文才能撑满/内部滚')
  assert.match(css, /#launchLogDialog \.launch-log-card\[hidden\] \{ display: none; \}/, 'flex 不能盖掉 [hidden] 的 display:none')
  assert.match(css, /#launchLogDialog \.launch-log-card > \.launch-log-block,[\s\S]{0,120}?max-height: none/, '覆盖各面板原来的 max-height')
  assert.match(css, /#launchLogDialog \.launch-log-text \{[^}]*flex: 1 1 auto/, '原始日志占满剩余高度')
})

test('切页签有动效：选中块滑动 + 内容按方向轻推，且遵守减动效', () => {
  assert.match(css, /\.launch-log-tabs::after \{[^}]*transition: transform 280ms/, '选中块滑动')
  assert.match(css, /\.launch-log-tabs\[data-count="3"\]::after/, '三个常驻页签各占三分之一')
  assert.match(css, /\.launch-log-tabs\[data-index="1"\]::after/, '按当前页签算位移')
  assert.match(css, /#launchLogDialog \.launch-log-card\[data-log-panel\]:not\(\[hidden\]\) \{[^}]*animation: launch-log-panel-in/, '面板淡入轻推')
  assert.match(css, /\[data-dir="right"\]:not\(\[hidden\]\) \{ animation-name: launch-log-panel-in-right; \}/, '往右切从右边进场')
  assert.match(css, /\[data-dir="left"\]:not\(\[hidden\]\) \{ animation-name: launch-log-panel-in-left; \}/, '往左切从左边进场')
  assert.match(css, /@keyframes launch-log-panel-in-right \{ from \{ opacity: 0; transform: translateX\(12px\); \} \}/)
  assert.match(css, /@keyframes launch-log-panel-in-left \{ from \{ opacity: 0; transform: translateX\(-12px\); \} \}/)
  assert.match(css, /#launchLogDialog \.dialog-body,\s*\n\.profile-pick-list \{ overflow-x: hidden; \}/, '横向入场动画不能把滚动容器撑出一条闪一下的横向滚动条')
  assert.match(css, /html\.reduce-motion \.launch-log-tabs::after \{ transition: none; \}/, 'reduce-motion 类下关掉滑动')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.launch-log-tabs::after \{ transition: none; \} \}/, '系统减动效下关掉滑动')
  assert.match(css, /html\.reduce-motion #launchLogDialog \.launch-log-card\[data-log-panel\]:not\(\[hidden\]\),/, 'reduce-motion 类下关掉面板动画')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\r?\n  #launchLogDialog \.launch-log-card\[data-log-panel\]:not\(\[hidden\]\),/, '系统减动效下关掉面板动画')
})

test('三个页签始终显示；没数据也能切过去；切走的面板隐藏', () => {
  const { sandbox, buttons, panels, diagnosis } = tabs()
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.deepEqual(buttons.map((item) => item.hidden), [false, false, false], '三个页签始终可见')
  assert.equal(panels.raw.hidden, false)
  assert.equal(panels.time.hidden, true)
  assert.equal(sandbox.launchLogTabsEl.hidden, false)
  assert.equal(sandbox.launchLogTabsEl.dataset.count, '3', '选中块按三等分算')
  assert.equal(sandbox.launchLogTabsEl.dataset.index, '0')
  assert.equal(panels.raw.dataset.dir, undefined, '首次打开不按方向进场，用默认的淡入')
  assert.equal(diagnosis.hidden, true, '没有诊断数据时不显示诊断卡片')

  sandbox.launchLogAvailable.diagnosis = true
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(diagnosis.hidden, false, '有诊断数据时和原始日志一起显示')

  // 耗时构成还没有数据：页签照样能选，面板照常显示（空状态由加载方写）
  sandbox.launchLogTab = 'time'
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(buttons[1].attrs['aria-selected'], 'true')
  assert.equal(panels.time.hidden, false, '没数据也显示面板，不再回退到原始日志')
  assert.equal(panels.raw.hidden, true, '切走的面板要收起来')
  assert.equal(diagnosis.hidden, true, '诊断卡片只在原始日志页显示')
  assert.equal(sandbox.launchLogTabsEl.dataset.index, '1', '选中块滑到第二个')
  assert.equal(panels.time.dataset.dir, 'right', '往右切，面板从右边进场')
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(panels.time.dataset.dir, 'right', '同一页签的重复 paint 不能把进场方向删掉')

  sandbox.launchLogTab = 'space'
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(panels.space.hidden, false)
  assert.equal(sandbox.launchLogTabsEl.dataset.index, '2', '选中块滑到第三个')
  assert.equal(panels.space.dataset.dir, 'right', '继续往右切')

  sandbox.launchLogTab = 'raw'
  vm.runInContext('paintLaunchLogTabs()', sandbox)
  assert.equal(panels.raw.hidden, false)
  assert.equal(panels.raw.dataset.dir, 'left', '往左切，面板从左边进场')
  assert.equal(buttons[0].attrs['aria-selected'], 'true')
  assert.equal(diagnosis.hidden, false, '回到原始日志后诊断卡片跟着回来')
})

test('日志弹窗：页签和卡片之间只留一道间距；加载中有转圈', () => {
  assert.match(css, /#launchLogDialog \.launch-log-tabs \{ margin-bottom: 0; \}/, '页签自带 margin 不再叠加')
  assert.match(css, /#launchLogDialog \.launch-log-card \+ \.launch-log-card \{ margin-top: 0; \}/, '隐藏卡片不留下相邻 margin')
  assert.match(css, /#launchLogDialog \.launch-log-loading \{ flex: 1 1 auto;/, '无缓存时加载行撑满卡片')
  assert.match(html, /id="launchLogRefreshSpin"/, '有缓存时标题旁的小转圈')
  assert.match(html, /launchLogRefreshSpinEl\.hidden = !cachedText/, '有缓存才显示小转圈')
  assert.match(html, /launchLogRefreshSpinEl\.hidden = true/, '刷新完收起')
  assert.match(css, /\.launch-log-refresh-spin:not\(\[hidden\]\) \{ display: inline-block; \}/)
})
