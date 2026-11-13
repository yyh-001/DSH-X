import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { harness } from './helpers/tab-drag-hosts.mjs'
import { LiveTabDrag, outsideTabStrip } from '../shell/tab-live-drag.mjs'
import { TabDetacher, TabDragFeedback, tabDropTarget, draggedBounds, tabGrabOffset } from '../shell/tab-detach.mjs'
import { tabWindowFallbackPage } from '../shell/pages.mjs'
import { parseTabAction } from '../shell/model.mjs'

const ids = host => host.tabs.map(tab => tab.target.id)
const main = readFileSync(new URL('../shell/main.mjs', import.meta.url), 'utf8')
const take = (name, next) => main.slice(main.indexOf(`function ${name}(`), main.indexOf(`function ${next}(`))

test('组合验收在不支持平台先拒绝，不创建目录或导入应用（只测拒绝分支）', () => {
  const script = readFileSync(new URL('../scripts/verify-tab-groups.mjs', import.meta.url), 'utf8')
  const guard = script.slice(script.indexOf("if (process.platform !== 'win32')"), script.indexOf('const realDrag'))
  assert.ok(guard.length > 0)
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => vm.runInNewContext(guard, { process: { platform } }), /isolated Windows runs only/)
  }
  assert.ok(script.indexOf(guard) < script.indexOf('mkdirSync(dir'))
})

test('动画中迁出后以稳定槽位回并，持续命中和松手均保留正确宿主顺序', async () => {
  const { ui, source, registry, createHost, flush, animations } = harness({ animation: true })
  ui.down('a'); ui.move('a', { clientX: 650 })
  const drag = new LiveTabDrag(registry, source, 'a', { createHost, position: () => true })
  flush(); ui.move('a', { clientX: 650, clientY: 100 })
  drag.update({ x: 650, y: 100 }, null, true); flush()
  assert.ok(animations.size > 0, '迁出发生在同伴动画尚未结束时')
  assert.deepEqual(source.stripLayout.tabs.map(tab => [tab.id, tab.left, tab.right]), [['b', 100, 300], ['c', 300, 500]])
  for (const entry of [...animations.values()]) entry.finish()
  await Promise.resolve(); await Promise.resolve(); ui.tick(); flush()
  const point = { x: 350, y: 25 }
  for (let tick = 0; tick <= 20; tick++) {
    const drop = tabDropTarget(point, null, [source], 'a')
    assert.equal(drop.index, 1)
    drag.update(point, drop, false); flush(); ui.tick(); flush()
    assert.deepEqual(ids(source), ['b', 'a', 'c'])
  }
  ui.up('a', { clientX: point.x, clientY: point.y })
  assert.deepEqual(ui.ids(), ['b', 'a', 'c'], '松手不把 DOM 短暂还原成原顺序')
  flush(); drag.update(point, tabDropTarget(point, null, [source], 'a'), false); drag.finish(false); flush()
  assert.deepEqual(ids(source), ['b', 'a', 'c'])
  assert.deepEqual(ui.ids(), ids(source))
  assert.equal(registry.targets.get('a').view.webContents.loads.length, 1)
})

test('移交后回源仍由主进程排序，取消恢复事务快照', () => {
  const { ui, source, registry, createHost, flush } = harness()
  ui.down('a'); ui.move('a', { clientY: 100 })
  const drag = new LiveTabDrag(registry, source, 'a', { createHost, position: () => true })
  drag.update({}, null, true); flush()
  for (const [x, expected] of [[350, ['b','a','c']], [650, ['b','c','a']], [150, ['a','b','c']], [650, ['b','c','a']]]) {
    const point = { x, y: 25 }
    drag.update(point, tabDropTarget(point, null, [source], 'a'), false); flush()
    assert.deepEqual(ids(source), expected)
    assert.deepEqual(ui.ids(), expected)
  }
  ui.document.emit('keydown', ui.event('a', { key: 'Escape' }))
  assert.deepEqual(ui.ids(), ['b','c','a'], 'renderer 等主进程回执，不自行双重撤销')
  drag.finish(true); flush()
  assert.deepEqual(ids(source), ['a','b','c'])
  assert.deepEqual(ui.ids(), ['a','b','c'])
})

test('未定位的新顶栏快速松手/取消都回挂；迟到布局不能复活事务', () => {
  for (const cancel of [false, true]) {
    const { source, registry, createHost } = harness()
    let ready = false, destination
    const record = registry.targets.get('a'), page = record.view.webContents
    const drag = new LiveTabDrag(registry, source, 'a', {
      createHost() { destination = createHost(); destination.window.hide(); return destination },
      position: () => ready,
    })
    drag.update({}, null, true)
    assert.equal(destination.window.isVisible(), false)
    drag.finish(cancel)
    ready = true
    assert.equal(drag.update({}, null, true), false)
    assert.equal(record.host, source)
    assert.deepEqual(ids(source), ['a','b','c'])
    assert.equal(destination.window.isDestroyed(), true)
    assert.equal(drag.saved.size, 0)
    assert.equal(source.dragHold, false)
    assert.equal(record.view.webContents, page)
    assert.equal(page.loads.length, 1)
  }
})

test('首个布局延迟但按住至就绪可提交；关闭等待窗口后不复活已关闭页', () => {
  for (const close of [false, true]) {
    const { source, registry, createHost } = harness()
    let ready = false, destination
    const record = registry.targets.get('a')
    const drag = new LiveTabDrag(registry, source, 'a', {
      createHost() { destination = createHost(); destination.window.hide(); return destination }, position: () => ready,
    })
    drag.update({}, null, true)
    assert.equal(destination.window.isVisible(), false)
    if (close) {
      destination.window.destroy()
      assert.equal(drag.valid(), false)
      drag.finish(true)
      assert.equal(registry.targets.has('a'), false)
    } else {
      ready = true; drag.update({}, null, true); drag.finish(false)
      assert.equal(destination.window.isVisible(), true)
      assert.equal(record.host, destination)
      assert.equal(record.view.webContents.loads.length, 1)
    }
    assert.equal(source.dragHold, false)
    assert.equal(drag.saved.size, 0)
  }
})

test('主进程持握超过五秒仍无布局时停止计时器并回挂原页面', () => {
  const { source, registry, createHost } = harness()
  let now = 100, cursor = { x: 150, y: 25 }, tick, destination, cleared = 0
  source.detacher = new TabDetacher(registry, source, { quitting: () => false })
  const context = vm.createContext({ tabDrag: null, quitting: false, state: { lang: 'zh' }, console: { warn() {} },
    LiveTabDrag, TabDragFeedback, tabDropTarget, outsideTabStrip, draggedBounds, tabGrabOffset,
    instanceViews: registry, canDragTabs: () => true, tabHosts: () => [source, ...(destination ? [destination] : [])],
    screen: { getCursorScreenPoint: () => cursor }, Date: { now: () => now },
    createDshWindow: () => { destination = createHost(); destination.window.hide(); return destination },
    setInterval: fn => { tick = fn; return 123 }, clearInterval: id => { assert.equal(id,123); cleared++ },
  })
  vm.runInContext(take('stopTabDrag','managerPreferences'), context)
  context.startTabDrag(source,'a',true,{ x:50,y:15,width:200,height:30,clientX:150,clientY:25 })
  cursor = { x:900,y:800 }; tick()
  assert.equal(destination.stripLayout,null)
  assert.equal(destination.window.isVisible(),false)
  now += 5001; tick()
  assert.equal(context.tabDrag,null)
  assert.equal(cleared,1)
  assert.equal(registry.targets.get('a').host,source)
  assert.equal(registry.targets.get('a').view.webContents.loads.length,1)
  assert.equal(destination.window.isDestroyed(),true)
})

test('旧核心 fallback 数字菜单请求遭 overlay 拒绝时弹出可见错误，页面留在原宿主', () => {
  const { registry, source, records, createHost } = harness()
  const fallback = createHost()
  fallback.chromeFallback = true
  registry.transferView(records[0].viewId, fallback)
  source.overlay = true
  const sent = []
  const page = vm.createContext({ window: {}, ipc: { postMessage: m => sent.push(m) }, document: {
    getElementById: () => ({ replaceChildren() {}, append() {} }), createElement: () => ({ setAttribute() {} }),
  } })
  vm.runInContext(tabWindowFallbackPage().match(/<script>([\s\S]*?)<\/script>/)[1], page)
  fallback.manager.executeJavaScript = async script => vm.runInContext(script, page)
  fallback.render(true)
  let popup, dialogs = 0
  const context = vm.createContext({ instanceViews: registry, TabDetacher, tabs: source, quitting: false,
    canDragTabs: () => true, tabHosts: () => [source, fallback], state: { lang: 'zh' }, console: { warn() {} },
    dialog: { showMessageBox(window, options) { assert.equal(window, fallback.window); assert.match(options.message, /无法/); dialogs++ } },
    Menu: { buildFromTemplate: template => ({ popup() { popup = template } }) },
  })
  vm.runInContext(take('createTabDetacher','canDragTabs') + take('showTabMenu','stopTabDrag'), context)
  fallback.detacher = context.createTabDetacher(fallback)
  vm.runInContext("send({action:'tab-menu',id:active,request:++serial})", page)
  const request = parseTabAction(sent.at(-1))
  assert.ok(Number.isSafeInteger(request.request))
  context.showTabMenu(request, false, fallback)
  popup.find(item => item.label === '移到启动器窗口').click()
  assert.equal(fallback.detachResult.status, 'error')
  assert.equal(dialogs, 1)
  assert.equal(records[0].host, fallback)
})

test('Window 菜单与 popup 均禁止单标签重复开窗，指定目标合并仍可用', () => {
  const { registry, source, records, createHost } = harness()
  const original = createHost()
  registry.transferView(records[0].viewId, original)
  original.window.setBounds({ x: 400, y: 300, width: 850, height: 600 })
  source.window.isFocused = () => false
  let applicationMenu, popup, created = 0
  const context = vm.createContext({ TabDetacher, tabDropTarget, instanceViews: registry, tabs: source, quitting: false,
    state: { lang: 'zh' }, canDragTabs: () => true, tabHosts: () => [source, original],
    createDshWindow: () => { created++; return createHost() }, console: { warn() {} }, dialog: { showMessageBox() {} },
    Menu: { buildFromTemplate: template => ({ popup() { popup = template },
      getMenuItemById: id => template.flatMap(row => row.submenu || []).find(row => row.id === id) }),
    getApplicationMenu: () => applicationMenu },
  })
  vm.runInContext(take('createTabDetacher','canDragTabs') + take('syncTabDetachMenu','stopTabDrag') + take('appMenu','closeWindow'), context)
  original.detacher = context.createTabDetacher(original)
  applicationMenu = context.appMenu(); context.syncTabDetachMenu()
  const item = applicationMenu.getMenuItemById('detach-tab')
  assert.equal(item.enabled, false)
  context.showTabMenu({ id: 'a' }, false, original)
  assert.equal(popup[0].enabled, false)
  const before = original.window.getBounds()
  item.click(null, original.window)
  assert.equal(created, 0)
  assert.equal(original.window.isDestroyed(), false)
  assert.deepEqual(original.window.getBounds(), before)
  popup.find(item => item.label === '移到启动器窗口').click()
  assert.equal(records[0].host, source)
  assert.equal(records[0].view.webContents.loads.length, 1)
  assert.equal(original.window.isDestroyed(), true)
})
