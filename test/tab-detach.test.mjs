import assert from 'node:assert/strict'
import test from 'node:test'
import { detachedBounds, draggedBounds, managerTabSender, tabDragSupported, tabDropTarget, TabDragFeedback } from '../shell/tab-detach.mjs'
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

test('跨窗口命中使用 DIP 与 CSS 缩放；受管窗口按焦点记录优先且拒绝区域不穿透', () => {
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
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target, covered]).host,covered)
  covered.overlay = true
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target, covered]), null)
  covered.window.isVisible = () => false
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target, covered]).host, target, '隐藏窗口不遮挡目标')
  covered.window.isVisible = () => true
  covered.window.isMinimized = () => true
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [target,covered]).host,target)
  covered.window.isMinimized = () => false
  covered.window.isDestroyed = () => true
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [target,covered]).host,target)
  covered.window.isDestroyed = () => false
  covered.overlay = false
  covered.stripLayout = null
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [target,covered]),null,'未上报栏区域不穿透')
  assert.equal(tabDropTarget({ x: -650, y: -70 }, covered, [target,covered]),null,'源宿主挡住后方目标')
  target.window.isVisible = () => false
  assert.equal(tabDropTarget({ x: -650, y: -70 }, source, [source, target]), null)
})

test('复用窗口的松手位置保留 DIP 抓取偏移，跨屏不夹边或改变窗口尺寸', () => {
  for (const zoom of [1, 1.25, 1.5, 2]) {
    const offset = { x: 2 + 120 * zoom, y: 1 + 16 * zoom }
    for (const point of [{ x: -1900, y: -400 }, { x: 1, y: 1 }, { x: 1919, y: 1079 }]) {
      const bounds = draggedBounds(point, { width: 900, height: 600 }, offset)
      assert.ok(Math.abs(bounds.x + offset.x - point.x) <= 0.5)
      assert.ok(Math.abs(bounds.y + offset.y - point.y) <= 0.5)
      assert.equal(bounds.width, 900)
      assert.equal(bounds.height, 600)
    }
  }
})

test('延迟拖动协议只传局部有限坐标与唯一排序，拒绝不完整和伪造对象字段', () => {
  const parse = value => parseTabAction(JSON.stringify(value))
  const value = { action:'tab-drag',id:'a',active:false,deferred:true,point:{ x:-100,y:800 },order:['b','a'],request:7 }
  assert.deepEqual(parse({ ...value, destination:1,url:'https://untrusted/',outside:true,detached:true }),value)
  for (const patch of [{ point:null }, { point:{x:1e9,y:0} }, { point:{x:'2',y:0} }, { order:['a','a'] }, { order:[''] }, { request:-1 }, { deferred:1 }]) {
    assert.equal(parse({ ...value,...patch }),null)
  }
  assert.deepEqual(parse({ action:'tab-drag-move',id:'a',point:{x:1,y:2},windowId:3 }), { action:'tab-drag-move',id:'a',point:{x:1,y:2} })
  assert.equal(parse({action:'tab-drag-move',id:'a'}),null)
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

test('按实际 Ozone 后端启用拖出，Wayland 桌面上的 X11 可用，未知后端不猜坐标', () => {
  assert.equal(tabDragSupported('win32'), true)
  assert.equal(tabDragSupported('darwin'), true)
  assert.equal(tabDragSupported('linux', '', {}), false)
  assert.equal(tabDragSupported('linux', 'wayland'), false)
  assert.equal(tabDragSupported('linux', 'auto', { XDG_SESSION_TYPE: 'wayland' }), false)
  assert.equal(tabDragSupported('linux', '', { WAYLAND_DISPLAY: 'wayland-0' }), false)
  assert.equal(tabDragSupported('linux', 'x11', { WAYLAND_DISPLAY: 'wayland-0' }), true)
  assert.equal(tabDragSupported('linux', 'x11', { XDG_SESSION_TYPE: 'wayland' }), true)
  assert.equal(tabDragSupported('linux', 'headless'), false)
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
