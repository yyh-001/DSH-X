import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/launch-list.js', import.meta.url), 'utf8')

function sortable(reduced = true) {
  const listeners = {}, saved = [], ghosts = [], animations = []
  const motion = { matches: reduced, addEventListener(name, listener) { this.change = listener } }
  function animate(frames, options) {
    let resolve
    const animation = { node: this, frames, options, finished: new Promise((done) => { resolve = done }), cancel() {}, finish: () => resolve() }
    animations.push(animation)
    return animation
  }
  const container = {
    children: [], dataset: {}, parentElement: null, scrollTop: 0,
    captured: false, setPointerCapture() { this.captured = true }, hasPointerCapture() { return this.captured }, releasePointerCapture() { this.captured = false },
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (name, listener) => { listeners[name] = listener },
    contains: (handle) => container.children.includes(handle.row),
    insertBefore(row, before) {
      this.children.splice(this.children.indexOf(row), 1)
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, row)
      // 移动正在捕获指针的元素会失去捕获，复现跨过第一项就自动取消的浏览器行为。
      if (row.handle.captured) {
        row.handle.captured = false
        listeners.lostpointercapture({ pointerId: 1 })
      }
    },
    append(row) { this.insertBefore(row, null) },
  }
  for (const id of ['a', 'b', 'c']) {
    const row = {
      dataset: { launchKey: id }, classList: { add() {}, remove() {} },
      get nextElementSibling() { return container.children[container.children.indexOf(row) + 1] || null },
      visualOffset: 0,
      get offsetTop() { return container.children.indexOf(row) * 70 },
      offsetHeight: 70,
      getBoundingClientRect: () => ({ top: container.children.indexOf(row) * 70 + row.visualOffset, height: 70, left: 0, width: 300 }),
      animate,
      cloneNode: () => ({ style: {}, classList: { add() {} }, animate, removeAttribute() {}, setAttribute() {}, remove() { ghosts.splice(ghosts.indexOf(this), 1) } }),
    }
    row.handle = {
      row, dataset: {}, closest: (selector) => selector === '[data-launch-key]' ? row : row.handle,
      captured: false, setPointerCapture() { this.captured = true }, hasPointerCapture() { return this.captured }, releasePointerCapture() { this.captured = false }, focus() { this.focused = true }, blur() { this.focused = false },
    }
    container.children.push(row)
  }
  const context = vm.createContext({
    document: { documentElement: { dataset: {} }, body: { append: (ghost) => ghosts.push(ghost) }, scrollingElement: { scrollTop: 0 } },
    matchMedia: () => motion, MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ paddingLeft: '14px', paddingRight: '14px' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  })
  vm.runInContext(source, context)
  context.launcherLaunchList.sortable(container, {
    canStart: () => !container.dataset.sorting,
    onReorder: (ids) => saved.push(Array.from(ids)), onFinish() {},
  })
  const event = (id, extra = {}) => ({ target: container.children.find((row) => row.dataset.launchKey === id).handle, button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 35, preventDefault() {}, ...extra })
  return { container, saved, ghosts, animations, motion, event, listeners, ids: () => container.children.map((row) => row.dataset.launchKey) }
}

test('从图标拖动移动整项，松手只保存一次顺序并释放捕获与预览', () => {
  const h = sortable()
  h.listeners.pointerdown(h.event('a'))
  h.listeners.pointermove(h.event('a', { clientY: 208 }))
  assert.deepEqual(h.ids(), ['b', 'c', 'a'])
  assert.equal(h.ghosts.length, 1)
  assert.equal(h.container.dataset.sorting, 'dragging')
  h.listeners.pointerup(h.event('a', { clientY: 208 }))
  assert.deepEqual(h.saved, [['b', 'c', 'a']])
  assert.equal(h.ghosts.length, 0)
  assert.equal(h.container.dataset.sorting, undefined)
  assert.equal(h.container.captured, false)
  assert.equal(h.event('a').target.focused, false, '鼠标操作结束后不保留选中框')
  assert.equal(h.event('a').target.dataset.pointerFocus, undefined)
})

test('跨过多项仍保持指针捕获；补位动画不把已越过的项再次当成目标', () => {
  const h = sortable()
  h.listeners.pointerdown(h.event('a'))
  h.listeners.pointermove(h.event('a', { clientY: 110 }))
  assert.deepEqual(h.ids(), ['b', 'a', 'c'])
  assert.equal(h.container.captured, true)
  h.container.children[0].visualOffset = 100
  h.listeners.pointermove(h.event('a', { clientY: 114 }))
  assert.deepEqual(h.ids(), ['b', 'a', 'c'], '使用布局位置判断，而非补位动画中的视觉位置')
  h.listeners.pointermove(h.event('a', { clientY: 208 }))
  assert.deepEqual(h.ids(), ['b', 'c', 'a'])
  assert.equal(h.container.captured, true)
  assert.deepEqual(h.saved, [], '鼠标未松开不保存或取消')
  h.listeners.pointerup(h.event('a', { clientY: 208 }))
  assert.deepEqual(h.saved, [['b', 'c', 'a']])
})

test('取消和丢失捕获恢复原顺序；短按或小幅移动不保存', () => {
  for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture']) {
    const h = sortable()
    h.listeners.pointerdown(h.event('a'))
    h.listeners.pointermove(h.event('a', { clientY: 208 }))
    if (cancel === 'Escape') h.listeners.keydown(h.event('a', { key: cancel }))
    else h.listeners[cancel](h.event('a'))
    assert.deepEqual(h.ids(), ['a', 'b', 'c'])
    assert.deepEqual(h.saved, [])
    assert.equal(h.ghosts.length, 0)
  }
  const h = sortable()
  h.listeners.pointerdown(h.event('a'))
  h.listeners.pointermove(h.event('a', { clientY: 38 }))
  h.listeners.pointerup(h.event('a'))
  assert.deepEqual(h.ids(), ['a', 'b', 'c'])
  assert.deepEqual(h.saved, [])
})

test('图标方向键上下移动；边界和保存中的列表不提交排序', () => {
  const h = sortable()
  h.listeners.keydown(h.event('a', { key: 'ArrowUp' }))
  assert.deepEqual(h.saved, [])
  h.listeners.keydown(h.event('a', { key: 'ArrowDown' }))
  assert.deepEqual(h.ids(), ['b', 'a', 'c'])
  assert.deepEqual(h.saved, [['b', 'a', 'c']])
  assert.equal(h.event('a').target.focused, true, '键盘排序后仍可继续操作图标')
  h.container.dataset.sorting = 'saving'
  h.listeners.keydown(h.event('a', { key: 'ArrowDown' }))
  h.listeners.pointerdown(h.event('a'))
  h.listeners.pointermove(h.event('a', { clientY: 208 }))
  assert.equal(h.saved.length, 1)
  assert.equal(h.ghosts.length, 0)
})

test('松手先落位再保存，期间后台刷新和再次拖动不能打断预览', async () => {
  const h = sortable(false)
  h.listeners.pointerdown(h.event('a'))
  assert.equal(h.event('a').target.dataset.pointerFocus, 'true')
  h.listeners.pointermove(h.event('a', { clientY: 208 }))
  const ghost = h.ghosts[0]
  h.listeners.pointerup(h.event('a'))
  assert.equal(h.container.captured, false)
  assert.equal(h.container.dataset.sorting, 'settling')
  assert.deepEqual(h.saved, [])
  const landing = h.animations.findLast((animation) => animation.node === ghost)
  assert.equal(landing.frames.at(-1).transform, 'translateY(140px)')
  h.listeners.pointerdown(h.event('b'))
  assert.equal(h.container.captured, false)
  landing.finish()
  await Promise.resolve()
  assert.equal(h.ghosts.length, 0)
  assert.equal(h.container.dataset.sorting, undefined)
  assert.deepEqual(h.saved, [['b', 'c', 'a']])
})

test('取消拖动动画回到原位置；落位中开启减少动态效果也能释放占位', async () => {
  const h = sortable(false)
  h.listeners.pointerdown(h.event('a'))
  h.listeners.pointermove(h.event('a', { clientY: 208 }))
  const ghost = h.ghosts[0]
  h.listeners.keydown(h.event('a', { key: 'Escape' }))
  assert.deepEqual(h.ids(), ['a', 'b', 'c'])
  assert.equal(h.animations.findLast((animation) => animation.node === ghost).frames.at(-1).transform, 'translateY(0px)')
  h.motion.matches = true
  h.motion.change()
  assert.equal(h.ghosts.length, 0)
  assert.equal(h.container.dataset.sorting, undefined)
  assert.deepEqual(h.saved, [])
})
