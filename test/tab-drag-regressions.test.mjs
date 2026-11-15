import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { harness } from './helpers/tab-drag-hosts.mjs'
import { TabDragSession } from '../shell/tab-drag-session.mjs'
import { TabDetacher, TabDragFeedback, tabDropTarget, draggedBounds, detachedBounds, outsideTabStrip } from '../shell/tab-detach.mjs'
import { tabWindowFallbackPage } from '../shell/pages.mjs'
import { parseTabAction } from '../shell/model.mjs'

const ids = host => host.tabs.map(tab => tab.target.id)
const main = readFileSync(new URL('../shell/main.mjs', import.meta.url), 'utf8')
const take = (name, next) => main.slice(main.indexOf(`function ${name}(`), main.indexOf(`function ${next}(`))

function controller() {
  const h = harness(), hosts = [h.source], previews = [], sent = []
  let cursor = { x: 150, y: 25 }, polls = 0
  const create = () => {
    const host = h.createHost(); hosts.push(host)
    host.detacher = new TabDetacher(h.registry, host, { quitting: () => false })
    return host
  }
  h.source.detacher = new TabDetacher(h.registry, h.source, { quitting: () => false })
  const execute = h.source.manager.executeJavaScript
  h.source.manager.executeJavaScript = async script => {
    sent.push(script)
    if (script === 'window.cancelTabDrag?.()') h.ui.window.cancelTabDrag()
    return execute(script)
  }
  const c = vm.createContext({ tabDrag: null, quitting: false, state: { lang: 'zh' }, console: { warn() {} },
    TabDragSession, TabDragFeedback, tabDropTarget, outsideTabStrip, draggedBounds, detachedBounds,
    parseTabAction, instanceViews: h.registry, canDragTabs: () => true, tabHosts: () => hosts,
    screen: { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: { x:0,y:0,width:2000,height:1200 } }) },
    createDshWindow: () => { const host = create(); host.window.hide(); return host },
    createTabPreview: () => { const preview = { updates: [], update(...args) { this.updates.push(args) }, destroy() { this.destroyed = true } }; previews.push(preview); return preview },
    setInterval: fn => { polls++; return fn }, clearInterval() {},
  })
  vm.runInContext(take('stopTabDrag','managerPreferences') + take('handleTabMessage','toggleMaximize'), c)
  c.guardTabDrag(h.source)
  const start = (host = h.source, deferred = true) => c.startTabDrag(host, 'a', deferred,
    { x:50,y:15,width:200,height:30,clientX:150,clientY:25 }, { x:150,y:25 })
  const pump = () => h.flush(action => c.handleTabMessage(h.source, JSON.stringify(action)))
  return { ...h, c, hosts, previews, sent, create, start, pump, cursor: point => { cursor = point }, polls: () => polls }
}

test('顶栏迟滞提示、预览与最终提交共用采样：24px进入、8px退出及四侧边界', () => {
  const paths = [
    [{ clientY:100 }, { clientY:60 }, { clientY:48 }],
    [{ clientY:-30 }, { clientY:-10 }, { clientY:2 }],
    [{ clientX:-40 }, { clientX:-10 }, { clientX:0 }],
    [{ clientX:1040 }, { clientX:1010 }, { clientX:1000 }],
  ]
  for (const zoom of [1, 1.5]) for (const path of paths) for (const reenter of [false, true]) {
    const h = controller(), original = h.records[0].view.webContents
    h.source.manager.getZoomFactor = () => zoom
    h.source.window.setBounds({ x:-1100,y:120,width:1000*zoom,height:700*zoom })
    h.ui.list.scrollLeft = 80
    const pump = h.pump
    const hint = h.ui.document.getElementById('internalTabsArea').querySelector('.internal-tab-hint')
    let transfers = 0
    const transfer = h.registry.transferView.bind(h.registry)
    h.registry.transferView = (...args) => { transfers++; return transfer(...args) }
    h.ui.down('a')
    for (const point of path.slice(0,2)) {
      h.ui.move('a',point); pump()
      assert.equal(hint.hidden,false)
      assert.equal(h.c.tabDrag.outside,true,JSON.stringify({zoom,point}))
      assert.equal(h.previews.at(-1).updates.at(-1)[1],true)
      assert.equal(transfers,0)
    }
    const end = reenter ? path[2] : path[1]
    if (reenter) {
      h.ui.move('a',end); pump()
      assert.equal(hint.hidden,true)
      assert.equal(h.c.tabDrag.outside,false)
      assert.equal(h.previews.at(-1).updates.at(-1)[1],false)
    }
    h.ui.up('a',end); pump()
    assert.equal(h.records[0].host === h.source,reenter)
    assert.equal(transfers,reenter ? 0 : 1)
    assert.equal(h.records[0].view.webContents,original)
    assert.equal(original.loads.length,1)
    assert.equal(h.c.tabDrag,null)
  }
})

test('未绘制的首次越界不留下主进程迟滞，源布局变化按同一帧的局部几何重新判定', () => {
  for (const layoutChange of [false,true]) {
    const h = controller()
    const pump = h.pump
    h.ui.down('a'); h.ui.move('a',{clientY:100},layoutChange); pump()
    if (layoutChange) h.ui.list.bounds = { ...h.ui.list.bounds, bottom:70 }
    h.ui.move('a',{clientY:60}); pump()
    const hint = h.ui.document.getElementById('internalTabsArea').querySelector('.internal-tab-hint')
    assert.equal(hint.hidden,true)
    assert.equal(h.c.tabDrag.outside,false)
    h.ui.up('a',{clientY:60}); pump()
    assert.equal(h.records[0].host,h.source)
    assert.equal(h.hosts.length,1)
  }
})

test('迟滞带内Escape或hide取消后迟到up不迁移，恢复的新手势不继承detach', () => {
  for (const cancel of ['Escape','hide']) {
    const h = controller()
    const pump = h.pump
    h.ui.down('a'); h.ui.move('a',{clientY:100}); pump()
    h.ui.move('a',{clientY:60}); pump()
    if (cancel === 'Escape') h.ui.document.emit('keydown',h.ui.event('a',{key:'Escape'}))
    else h.source.window.hide()
    pump()
    assert.equal(h.c.tabDrag,null)
    assert.equal(h.ui.list.pointer,null)
    h.ui.up('a',{clientY:60}); pump()
    assert.equal(h.hosts.length,1)
    h.source.window.showInactive()
    h.ui.down('a'); h.ui.move('a',{clientY:60}); pump()
    assert.equal(h.c.tabDrag.outside,false)
    h.ui.up('a',{clientY:60}); pump()
    assert.equal(h.records[0].host,h.source)
    assert.deepEqual(ids(h.source),['a','b','c'])
  }
})

test('内容renderer崩溃在recover之前只取消被拖页面，其他页恢复不影响当前手势', () => {
  for (const crashedIndex of [0,1]) {
    const h = controller(), record = h.records[crashedIndex]
    record.view.webContents = Object.assign(new EventEmitter(),record.view.webContents,{ setWindowOpenHandler() {} })
    Object.assign(h.c,{ WebContentsView:class { constructor() { return record.view } },remotePreferences:()=>({}),
      browserGuests:{ bind() {} },browserGuestOwners:new Set(),CLEAN_EXITS:new Set(['clean-exit']) })
    vm.runInContext(main.slice(main.indexOf('function createTabView('),main.indexOf('/** 管理页和本地页发来的消息')),h.c)
    h.c.createTabView(record.viewId)
    const pump = h.pump
    h.ui.down('a'); h.ui.move('a',{clientY:100}); pump()
    const recover = h.registry.recover.bind(h.registry)
    let recovered = 0
    h.registry.recover = id => {
      recovered++
      assert.equal(!!h.c.tabDrag,crashedIndex !== 0,'取消必须先于恢复导航')
      assert.equal(h.ui.list.pointer,crashedIndex === 0 ? null : 1)
      recover(id)
    }
    record.view.webContents.emit('render-process-gone',{}, {reason:'crashed'})
    assert.equal(recovered,1)
    assert.equal(record.view.webContents.loads.length,2)
    h.ui.up('a',{clientY:100}); pump()
    assert.equal(h.records[0].host === h.source,crashedIndex === 0)
    assert.equal(h.records[1].host,h.source)
    assert.equal(h.c.tabDrag,null)
  }
})

test('真实入口按住仅预览，反复跨窗不迁移；松手按最终槽位只迁移一次', () => {
  const h = controller(), destination = h.create(), record = h.records[0]
  destination.window.setBounds({ x:1100,y:0,width:900,height:700 })
  h.registry.transferView(h.records[1].viewId, destination, { preservePage: true })
  destination.stripLayout = { rect: { left:100,right:800,top:10,bottom:40 }, tabs: [{ id:'b',left:100,right:300,top:10,bottom:40 }] }
  const original = record.view.webContents
  let transfers = 0
  const transfer = h.registry.transferView.bind(h.registry)
  h.registry.transferView = (...args) => { transfers++; return transfer(...args) }
  h.start()
  assert.equal(h.polls(), 0)
  for (const point of [{ x:900,y:850 }, { x:1250,y:25 }, { x:900,y:850 }, { x:1250,y:25 }]) {
    h.c.handleTabMessage(h.source, JSON.stringify({ action:'tab-drag-move',id:'a',point }))
    assert.equal(record.host, h.source)
    assert.equal(transfers, 0)
  }
  assert.equal(h.hosts.length, 2, '预览不创建页面宿主')
  const end = JSON.stringify({ action:'tab-drag',id:'a',active:false,deferred:true,point:{ x:1250,y:25 } })
  h.c.handleTabMessage(h.source, end); h.c.handleTabMessage(h.source, end)
  assert.equal(transfers, 1)
  assert.deepEqual(ids(destination), ['a','b'])
  assert.equal(record.view.webContents, original)
  assert.equal(original.loads.length, 1)
  assert.ok(h.previews[0].destroyed)
  assert.equal(h.source.dragHold, false)
})

test('桌面新窗口只在松手创建；取消零迁移，附加失败回挂原页面', () => {
  for (const mode of ['cancel','commit','fail']) {
    const h = controller(), record = h.records[0]
    h.start(); h.c.tabDrag.update({ x:900,y:850 })
    assert.equal(h.hosts.length, 1)
    if (mode === 'fail') {
      const create = h.c.createDshWindow
      h.c.createDshWindow = () => { const host = create(); host.attach = () => { throw Error('fixture') }; return host }
    }
    h.c.stopTabDrag(mode === 'cancel')
    assert.equal(record.host === h.source, mode !== 'commit')
    assert.equal(record.view.webContents.loads.length, 1)
    assert.equal(h.c.tabDrag, null)
    assert.equal(h.source.dragHold, false)
    if (mode === 'fail') assert.equal(h.hosts[1].window.isDestroyed(), true)
  }
})

test('单标签窗口拖出松手才移动原窗口，取消保持原边界', () => {
  const h = controller(), host = h.create(), record = h.records[0]
  h.registry.transferView(record.viewId, host, { preservePage: true })
  host.stripLayout = h.source.stripLayout
  const bounds = host.window.getBounds()
  h.start(host); h.c.tabDrag.update({ x:900,y:850 })
  assert.deepEqual(host.window.getBounds(), bounds)
  h.c.stopTabDrag(true)
  assert.deepEqual(host.window.getBounds(), bounds)
  h.start(host); h.c.tabDrag.update({ x:900,y:850 }); h.c.stopTabDrag(false)
  assert.notDeepEqual(host.window.getBounds(), bounds)
  assert.equal(record.host, host)
  assert.equal(h.hosts.length, 2)
})

test('生命周期显式取消两端捕获，迟到松手不提交，重新显示可建立新会话（DOM夹具）', () => {
  for (const event of ['hide','minimize','close','closed','show','render-process-gone','destroyed','did-start-navigation']) {
    const h = controller()
    h.ui.down('a'); h.ui.move('a', { clientY:100 }); h.start()
    assert.equal(h.ui.list.pointer, 1)
    const target = ['render-process-gone','destroyed','did-start-navigation'].includes(event) ? h.source.manager : h.source.window
    target.emit(event, { preventDefault() {} })
    assert.equal(h.c.tabDrag, null, event)
    assert.equal(h.ui.list.pointer, null, event)
    h.ui.up('a', { clientY:100 })
    assert.equal(h.records[0].host, h.source)
    h.ui.down('a'); h.ui.move('a', { clientY:100 }); h.start()
    assert.equal(h.ui.list.pointer, 1)
    assert.ok(h.c.tabDrag)
    h.c.stopTabDrag()
  }
})

test('旧核心低频兼容拖动也在松手提交，并返回解锁请求的回执', () => {
  const h = controller()
  h.start(h.source, false)
  assert.equal(h.polls(), 1)
  h.cursor({ x:150,y:100 }); h.c.tabDrag.timer()
  h.cursor({ x:150,y:60 }); h.c.tabDrag.timer()
  assert.equal(h.c.tabDrag.outside,true,'旧核心轮询也保留迟滞带中的拆窗候选')
  assert.equal(h.records[0].host, h.source)
  h.c.handleTabMessage(h.source, JSON.stringify({ action:'detach-tab',id:'a',source:'drag',request:77 }))
  assert.notEqual(h.records[0].host, h.source)
  assert.equal(h.source.detachResult.request, 77)
  assert.equal(h.source.detachResult.status, 'success')
})

test('真实顶栏消息经 parser 和主进程完成同窗排序，Escape 不提交途中顺序', () => {
  for (const cancel of [false,true]) {
    const h = controller()
    const pump = () => { for (const command of h.flush()) h.c.handleTabMessage(h.source, JSON.stringify(command)) }
    h.ui.down('a'); h.ui.move('a',{clientX:650}); pump()
    assert.deepEqual(ids(h.source), ['a','b','c'])
    assert.deepEqual(h.ui.ids(), ['b','c','a'])
    if (cancel) h.ui.document.emit('keydown', h.ui.event('a',{key:'Escape'}))
    else h.ui.up('a',{clientX:650})
    pump(); h.flush()
    assert.deepEqual(ids(h.source),cancel ? ['a','b','c'] : ['b','c','a'])
    assert.deepEqual(h.ui.ids(),ids(h.source))
    assert.equal(h.c.tabDrag,null)
  }
})

test('目标关闭、源弹窗与旧核心无取消字段的 end 均不能误拆窗', () => {
  for (const mode of ['overlay','legacy-end']) {
    const h = controller()
    h.start(h.source, mode !== 'legacy-end')
    h.c.tabDrag.update({x:900,y:850})
    h.c.handleTabMessage(h.source, JSON.stringify(mode === 'overlay'
      ? {action:'overlay',open:true} : {action:'tab-drag',id:'a',active:false}))
    assert.equal(h.c.tabDrag,null)
    assert.equal(h.records[0].host,h.source)
    assert.equal(h.hosts.length,1)
  }
})

test('组合验收在不支持平台先拒绝，不创建目录或导入应用（只测拒绝分支）', () => {
  const script = readFileSync(new URL('../scripts/verify-tab-groups.mjs', import.meta.url), 'utf8')
  const guard = script.slice(script.indexOf("if (process.platform !== 'win32')"), script.indexOf('const realDrag'))
  assert.ok(guard.length > 0)
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => vm.runInNewContext(guard, { process: { platform } }), /isolated Windows runs only/)
  }
  assert.ok(script.indexOf(guard) < script.indexOf('mkdirSync(dir'))
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
