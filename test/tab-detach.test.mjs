import assert from 'node:assert/strict'
import test from 'node:test'
import { detachedBounds, draggedBounds, tabGrabOffset, managerTabSender, tabDragSupported, tabDropTarget, TabDragFeedback } from '../shell/tab-detach.mjs'
import { parseTabAction } from '../shell/model.mjs'

test('跨窗口提示只通知受影响窗口，静止不重复发送，结束释放全部提示引用', () => {
  const sent = [], source = {}, first = {}, second = {}
  const feedback = new TabDragFeedback((host, value) => sent.push({ host, value }))
  for (let i = 0; i < 100; i++) feedback.update(source, null)
  assert.equal(sent.length, 0)
  for (let i = 0; i < 100; i++) feedback.update(source, { host: first, marker: 120 })
  assert.equal(sent.length, 2)
  feedback.update(source, { host: first, marker: 240 })
  assert.equal(sent.length, 3)
  assert.equal(sent.at(-1).host, first)
  feedback.update(source, { host: second, marker: 240 })
  assert.deepEqual(sent.slice(-2), [{ host: first, value: null }, { host: second, value: { marker: 240 } }])
  feedback.clear()
  assert.equal(feedback.values.size, 0)
  const end = sent.length
  feedback.clear()
  assert.equal(sent.length, end)
})

test('拖出消息只接受非空身份、请求编号和支持的入口，不透传 URL 或原生对象', () => {
  const input = { action: 'detach-tab', id: 'page-a', request: 5, source: 'drag' }
  const parse = (value) => parseTabAction(JSON.stringify(value))
  assert.deepEqual(parse({ ...input, url: 'http://untrusted/', webContentsId: 1 }), input)
  for (const patch of [{ id: '' }, { id: 1 }, { request: -1 }, { request: 1.5 }, { request: null }, { source: 'unknown' }]) {
    assert.equal(parse({ ...input, ...patch }), null)
  }
  assert.deepEqual(parse({ ...input, action: 'tab-menu' }), { action: 'tab-menu', id: 'page-a', request: 5 })
})

test('跨窗口命中使用 DIP 与 CSS 缩放，保留插入索引，不穿透遮挡窗口', () => {
  const host = (x, focusOrder = 1, zoom = 1) => ({ focusOrder, manager: { getZoomFactor: () => zoom },
    window: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
      getBounds: () => ({ x, y: -100, width: 600, height: 400 }), getContentBounds: () => ({ x, y: -100 }) },
    stripLayout: { rect: { left: 20, right: 300, top: 0, bottom: 44 },
      tabs: [{ id: 'a', left: 20, right: 100 }, { id: 'b', left: 100, right: 200 }] } })
  const source = host(0, 4), target = host(-800, 2, 1.5)
  const hit = tabDropTarget({ x: -650, y: -70 }, source, [source, target])
  assert.equal(hit.host, target)
  assert.equal(hit.index, 1)
  assert.equal(hit.marker, 100)
  assert.equal(tabDropTarget({ x: -650, y: 0 }, source, [source, target]), null)
  const covered = host(-800, 5)
  covered.overlay = true
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target, covered]), null)
  covered.dragHidden = true
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target, covered]).host, target, '透明捕获空壳不遮挡目标')
  target.window.isVisible = () => false
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target]), null)
})

test('拖动保持标签抓取比例和 DIP 偏移，跨屏不夹边或改变窗口尺寸', () => {
  const grab = { x: 40, y: 12, width: 200, height: 40 }
  for (const zoom of [1, 1.25, 1.5, 2]) {
    const offset = tabGrabOffset(grab, { left: 60, right: 360, top: 4, bottom: 44 }, zoom, { x: 2, y: 1 })
    assert.deepEqual(offset, { x: 2 + 120 * zoom, y: 1 + 16 * zoom })
    for (const point of [{ x: -1900, y: -400 }, { x: 1, y: 1 }, { x: 1919, y: 1079 }]) {
      const bounds = draggedBounds(point, { width: 900, height: 600 }, offset)
      assert.ok(Math.abs(bounds.x + offset.x - point.x) <= 0.5)
      assert.ok(Math.abs(bounds.y + offset.y - point.y) <= 0.5)
      assert.equal(bounds.width, 900)
      assert.equal(bounds.height, 600)
    }
  }
})

test('抓取点协议兼容旧消息，只接收有限且位于标签内的 CSS 坐标', () => {
  const parse = (value) => parseTabAction(JSON.stringify(value))
  const value = { action: 'tab-drag', id: 'a', active: true, live: true,
    grab: { x: 30, y: 12, width: 200, height: 40, clientX: 491, clientY: 16 } }
  assert.deepEqual(parse(value), value)
  for (const patch of [{ x: -1 }, { x: 201 }, { y: 41 }, { height: 0 }, { width: Infinity }, { clientX: '2' }, { clientY: 1000001 }]) {
    assert.equal(parse({ ...value, grab: { ...value.grab, ...patch } }), null)
  }
  assert.deepEqual(parse({ action: 'tab-drag', id: 'a', active: true, live: true }), { action: 'tab-drag', id: 'a', active: true, live: true })
})

test('标签区域协议拒绝无穷坐标、倒置区域和原生窗口身份', () => {
  const value = { action: 'tab-strip', rect: { left: 0, right: 500, top: 0, bottom: 44 }, tabs: [{ id: 'a', left: 0, right: 100 }] }
  const parse = (value) => parseTabAction(JSON.stringify(value))
  assert.deepEqual(parse({ ...value, windowId: 100 }), value)
  assert.equal(parse({ ...value, rect: { ...value.rect, left: 800 } }), null)
  assert.equal(parse({ ...value, tabs: [{ id: 'a', left: 1e9, right: 1e9 }] }), null)
  assert.equal(parse({ ...value, tabs: [null] }), null)
  assert.equal(parse({ action: 'tab-drag', id: 'a', active: 'yes' }), null)
  assert.equal(parse({ action: 'tab-drag', id: 'a', active: false, cancel: 'yes' }), null)
  assert.equal(parse({ action: 'tab-drag', id: 'a', active: true, live: 1 }), null)
})

test('管理 IPC 同时验证 WebContents、顶层 frame 和管理页来源', () => {
  const manager = { mainFrame: { url: 'http://127.0.0.1:1234/?window=1' } }
  const event = { sender: manager, senderFrame: manager.mainFrame }
  const allowed = (value) => managerTabSender(value, manager, 'http://127.0.0.1:1234/')
  assert.equal(allowed(event), true)
  assert.equal(allowed({ ...event, sender: {} }), false)
  assert.equal(allowed({ ...event, senderFrame: null }), false)
  assert.equal(allowed({ ...event, senderFrame: { ...manager.mainFrame } }), false)
  for (const url of ['http://127.0.0.1:4321/', 'http://127.0.0.1:1234/booting', 'data:text/html,anything', 'invalid']) {
    manager.mainFrame.url = url
    assert.equal(allowed(event), false)
  }
  manager.isDestroyed = () => true
  Object.defineProperty(manager, 'mainFrame', { get() { throw new Error('Object has been destroyed') } })
  assert.equal(allowed(event), false)
})

test('Wayland 和 auto 下保留菜单能力但禁用坐标拖出，显式 X11 可用', () => {
  assert.equal(tabDragSupported('win32'), true)
  assert.equal(tabDragSupported('darwin'), true)
  assert.equal(tabDragSupported('linux', '', {}), true)
  assert.equal(tabDragSupported('linux', 'wayland'), false)
  assert.equal(tabDragSupported('linux', 'auto', { XDG_SESSION_TYPE: 'wayland' }), false)
  assert.equal(tabDragSupported('linux', '', { WAYLAND_DISPLAY: 'wayland-0' }), false)
  assert.equal(tabDragSupported('linux', 'x11', { WAYLAND_DISPLAY: 'wayland-0' }), true)
})

test('落点使用 DIP：负坐标副屏、小屏和工作区边缘均可见，不重复乘 DPI', () => {
  const size = { width: 1180, height: 820 }
  const left = { x: -1920, y: -500, width: 1920, height: 1040 }
  assert.deepEqual(detachedBounds({ x: -1800, y: -490 }, left, size), { x: -1920, y: -500, ...size })
  assert.deepEqual(detachedBounds({ x: -10, y: 520 }, left, size), { x: -1180, y: -280, ...size })
  const small = { x: 100, y: 50, width: 640, height: 480 }
  assert.deepEqual(detachedBounds({ x: 600, y: 400 }, small, size), small)
  const area = { x: 0, y: 40, width: 1920, height: 1000 }
  for (const scaleFactor of [1, 1.5, 2]) {
    assert.deepEqual(detachedBounds({ x: 960, y: 300 }, { ...area, scaleFactor }, size), { x: 370, y: 220, ...size })
  }
})
