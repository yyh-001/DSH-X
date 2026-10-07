import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/market-layout.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

test('市场完整展示超过旧分页上限的整合包，排序和搜索后安装仍指向原条目', () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    id: `author/pack-${index}`, name: `pack-${index}`, displayName: `Pack ${String(index).padStart(2, '0')}`,
    author: index === 29 ? 'target-author' : 'author', version: '1.0.0', stars: index,
  }))
  const count = {}, details = [], installs = [], selected = []
  const grid = {
    innerHTML: '',
    querySelectorAll(selector) {
      const attribute = selector === '[data-market-detail]' ? 'market-detail' : 'market'
      const nodes = [...this.innerHTML.matchAll(new RegExp(`data-${attribute}="(\\d+)"`, 'g'))]
        .map((match) => ({ dataset: { [attribute === 'market' ? 'market' : 'marketDetail']: match[1] } }))
      const target = attribute === 'market' ? installs : details
      target.splice(0, target.length, ...nodes)
      return nodes
    },
  }
  const context = vm.createContext({
    packMarket: { entries }, packMarketEl: grid, packState: {}, state: {},
    openedPack: null, pluginProfile: 'web', packBusy: false, launcherRunning: () => false,
    marketSearchEl: { value: '' }, marketSortEl: { value: 'stars' },
    document: { getElementById(id) { assert.equal(id, 'marketCount'); return count } },
    window: { launcherMarketLayout: { refresh() {} } },
    t: (text, values) => text.replace('{n}', values?.n ?? ''), escapeHtml: (text) => String(text ?? ''),
    marketStar: '', marketCube: '',
    inspectPack: (payload) => selected.push(payload.market), openMarketDetail: (index) => selected.push(entries[index]),
  })
  const start = html.indexOf('    function marketDate(value)')
  vm.runInContext(html.slice(start, html.indexOf('    async function loadMarketStats()', start)), context)
  // 用测试桩承接详情动作，不依赖另一个弹窗的 DOM。
  context.openMarketDetail = (index) => selected.push(entries[index])
  context.renderPackMarket()
  assert.equal(installs.length, 30)
  assert.equal(count.textContent, '30 个整合包')
  assert.equal(installs[0].dataset.market, '29')
  installs[0].onclick(); details[0].onclick()
  assert.deepEqual(selected, [entries[29], entries[29]])
  context.marketSearchEl.value = 'target-author'
  context.renderPackMarket()
  assert.equal(installs.length, 1)
  assert.equal(count.textContent, '1 个整合包')
  installs[0].onclick()
  assert.equal(selected.at(-1), entries[29])
})

test('瀑布流按自然高度占行，重排保留节点，隐藏时不使用零高度覆盖布局', () => {
  const cards = [113, 181, 47].map((offsetHeight) => ({ offsetHeight, style: {} }))
  let visible = true, resize, queued
  const watched = new Set()
  const grid = { getClientRects: () => visible ? [{}] : [], querySelectorAll: () => cards }
  const context = vm.createContext({
    window: {},
    getComputedStyle: () => ({ gridAutoRows: '4px', getPropertyValue: () => '14px' }),
    requestAnimationFrame(callback) { queued = callback; return 1 }, cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { resize = callback }
      disconnect() { watched.clear() }
      observe(item) { watched.add(item) }
    },
  })
  vm.runInContext(source, context)
  context.window.launcherMarketLayout.refresh(grid)
  assert.deepEqual(cards.map((card) => card.style.gridRowEnd), ['span 32', 'span 49', 'span 16'])
  assert.equal(watched.size, 4)
  cards[0].offsetHeight = 209
  resize(); queued()
  assert.equal(cards[0].style.gridRowEnd, 'span 56', '窄屏换行后自动调整跨度')
  visible = false
  cards[0].offsetHeight = 0
  resize(); queued()
  assert.equal(cards[0].style.gridRowEnd, 'span 56')
  visible = true
  cards.splice(0, 1)
  context.window.launcherMarketLayout.refresh(grid)
  assert.equal(watched.size, 3, '搜索后不再观察旧卡片')
  assert.equal(cards[0].offsetHeight, 181, '排序不修改卡片内容和高度')
})

test('打开市场将焦点放在弹窗本身，首次与再次打开都刷新瀑布流', () => {
  const card = {}, grid = {}, calls = []
  const context = vm.createContext({
    document: { getElementById: () => card }, packImportDialog: {}, packMarketEl: grid,
    window: { launcherMarketLayout: { refresh: (value) => calls.push(['layout', value]) } },
    showPackDialog: (dialog, focus) => calls.push(['focus', focus]),
    packMarketLoaded: false, renderPackMarket: () => calls.push(['render']), loadMarket: () => calls.push(['load']),
  })
  vm.runInContext(html.slice(html.indexOf('    function openImportDialog()'), html.indexOf('    function closeImportDialog()')), context)
  context.openImportDialog(); context.openImportDialog()
  assert.deepEqual(calls.filter(([kind]) => kind === 'focus'), [['focus', card], ['focus', card]])
  assert.equal(calls.filter(([kind]) => kind === 'layout').length, 2)
  assert.equal(calls.filter(([kind]) => kind === 'load').length, 1)
  assert.match(html, /id="packMarketCard"[^>]*tabindex="-1"/)
})

test('市场从非输入焦点开始，Tab 和 Shift+Tab 留在弹窗内', () => {
  const card = {}, search = {}, first = {}, last = {}, listeners = {}, focused = []
  first.focus = () => focused.push('first')
  last.focus = () => focused.push('last')
  first.getClientRects = last.getClientRects = () => [{}]
  const dialog = {
    addEventListener: (type, callback) => { listeners[type] = callback },
    querySelectorAll: () => [first, last], querySelector: () => card,
    contains: (item) => [card, search, first, last].includes(item),
  }
  const context = vm.createContext({ document: { activeElement: card }, openUiSelect: null })
  vm.runInContext(html.slice(html.indexOf('    function trapPackDialog('), html.indexOf('    async function closeMarketDetail()')), context)
  context.trapPackDialog(dialog, () => {})
  let prevented = 0
  listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ })
  listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ })
  assert.deepEqual(focused, ['first', 'last'])
  assert.equal(prevented, 2)
})
