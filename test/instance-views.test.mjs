import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { InstanceViews, instanceWindowTitle, launchForView, legacyWindowTarget } from '../shell/instance-views.mjs'
import { InstanceWindow } from '../shell/instance-window.mjs'
import { BrowserTabs } from '../shell/tabs.mjs'
import { TabDetacher } from '../shell/tab-detach.mjs'

class Window extends EventEmitter {
  constructor() {
    super()
    this.children = new Set()
    this.visible = true
    this.contentView = { addChildView: (view) => this.children.add(view), removeChildView: (view) => this.children.delete(view) }
    this.webContents = { executeJavaScript: async () => 0, focus() {}, reload() {} }
  }
  getContentBounds() { return { width: 1000, height: 700 } }
  getBounds() { return this.bounds || { x: 50, y: 60, width: 1000, height: 700 } }
  setBounds(bounds) { this.bounds = bounds }
  getOpacity() { return this.opacity ?? 1 }
  setOpacity(opacity) { this.opacity = opacity }
  setSkipTaskbar(skip) { this.skipTaskbar = skip }
  isDestroyed() { return this.destroyed === true }
  isFocused() { return this.focused !== false }
  hide() { this.visible = false }
  isVisible() { return this.visible }
  showInactive() { this.visible = true }
  close() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) this.destroy()
  }
  destroy() { this.destroyed = true; this.emit('closed') }
}

function view() {
  const contents = { url: '', loads: [], closed: 0, focuses: 0, mainFrame: {},
    getURL() { return this.url }, isDestroyed() { return this.closed > 0 },
    async loadURL(url) { this.url = url; this.mainFrame.url = url; this.loads.push(url) },
    close() { this.closed++ }, focus() { this.focuses++ }, executeJavaScript: async () => '',
  }
  return { webContents: contents, setBackgroundColor() {}, setVisible(value) { this.visible = value }, setBounds(value) { this.bounds = value } }
}

function setup({ canTransfer } = {}) {
  let registry
  const windows = []
  let hidden = 0
  const tabs = new BrowserTabs(new Window(), {
    retire: (record) => registry.retire(record), dispose: (id) => registry.disposeView(id), reveal() {},
  })
  const createHost = (kind) => {
    if (kind === 'internal') return tabs
    const window = new Window()
    const host = new InstanceWindow(window, { quitting: () => false, hidden: () => hidden++,
      retire: (record) => registry.retire(record),
      dispose: (id) => registry.disposeView(id), reveal: (win) => { win.visible = true }, titles() {} })
    windows.push(host)
    return host
  }
  registry = new InstanceViews({ createView: view, createHost, canTransfer, bootUrl: (target) => `http://127.0.0.1:3000/booting?profile=${target.profile}` })
  return { registry, tabs, windows, createHost, hidden: () => hidden }
}
test('禁用跨窗迁移时仍可首次独立开窗，但切换已有页面不得摘出或创建空窗口', () => {
  const { registry, tabs, windows } = setup({ canTransfer: () => false })
  const record = registry.presentInstance(target(), { presentation: 'window' })
  const original = record.host, wc = record.view.webContents
  const loads = wc.loads.length
  assert.equal(windows.length, 1)
  assert.throws(() => registry.presentInstance(target(), { presentation: 'internal', explicit: true }), /跨窗/)
  assert.throws(() => registry.transferView(record.viewId, tabs), /跨窗/)
  assert.equal(registry.transferView(record.viewId, original), record, '同宿主不属于迁移')
  const internal = registry.presentInstance(target('second'))
  assert.throws(() => registry.presentInstance(target('second'), { presentation: 'window', explicit: true }), /跨窗/)
  assert.equal(windows.length, 1, '拒绝必须发生在创建空窗口之前')
  assert.equal(record.host, original)
  assert.equal(internal.host, tabs)
  assert.equal(record.view.webContents, wc)
  assert.equal(wc.loads.length, loads)
  assert.equal(wc.closed, 0)
})

const target = (profile = 'web', home = 'C:/home', version = '1.2.3') => ({
  id: JSON.stringify([home, version, profile]), home, version, profile, homeName: home,
  title: profile, status: 'running', managed: true, url: `http://127.0.0.1:${profile === 'web' ? 4000 : 4001}/?token=fake`,
})

test('正反向切换在独立窗口内循环，启动器保留管理首页这一站', () => {
  const { registry, tabs, createHost } = setup()
  const a = registry.presentInstance(target('a')), b = registry.presentInstance(target('b'))
  tabs.selected = ''
  tabs.action({ action: 'previous' })
  assert.equal(tabs.selected, b.target.id)
  tabs.action({ action: 'next' })
  assert.equal(tabs.selected, '')
  tabs.action({ action: 'next' })
  assert.equal(tabs.selected, a.target.id)
  const host = createHost('window')
  registry.transferView(a.viewId, host)
  registry.transferView(b.viewId, host)
  host.action({ action: 'next' })
  assert.equal(host.selected, a.target.id)
  host.action({ action: 'previous' })
  assert.equal(host.selected, b.target.id)
  host.action({ action: 'previous' })
  assert.equal(host.selected, a.target.id)
})

test('多个独立窗口可合并、排序、再拆开；移空销毁外壳，视图和加载次数不变', () => {
  const { registry, tabs, createHost } = setup()
  const a = registry.presentInstance(target('a')), b = registry.presentInstance(target('b')), c = registry.presentInstance(target('c'))
  const one = createHost('window'), two = createHost('window')
  registry.transferView(a.viewId, one, { preservePage: true })
  registry.transferView(b.viewId, one, { preservePage: true })
  registry.transferView(c.viewId, two, { preservePage: true })
  registry.transferView(b.viewId, two, { index: 0, preservePage: true })
  assert.deepEqual(one.tabs, [a])
  assert.deepEqual(two.tabs, [b, c])
  two.action({ action: 'reorder', ids: [c.target.id, b.target.id], request: 1 })
  two.action({ action: 'next' })
  assert.equal(two.selected, c.target.id)
  registry.transferView(a.viewId, two, { index: 1, preservePage: true })
  assert.equal(one.window.isDestroyed(), true)
  assert.deepEqual(two.tabs, [c, a, b])
  registry.transferView(a.viewId, tabs, { preservePage: true })
  assert.deepEqual(two.tabs, [c, b])
  assert.equal(two.window.isDestroyed(), false)
  for (const record of [a, b, c]) {
    assert.equal(record.view.webContents.loads.length, 1)
    assert.equal(record.view.webContents.closed, 0)
  }
})

test('合并到已有窗口失败：两侧顺序、选中项及窗口均恢复，不丢原目标页', () => {
  const { registry, createHost } = setup()
  const a = registry.presentInstance(target('a')), b = registry.presentInstance(target('b')), c = registry.presentInstance(target('c'))
  const source = createHost('window'), destination = createHost('window')
  registry.transferView(a.viewId, source)
  registry.transferView(b.viewId, destination)
  registry.transferView(c.viewId, destination)
  destination.reveal = () => { throw new Error('reveal failed') }
  const detacher = new TabDetacher(registry, source, { quitting: () => false, dragSupported: () => true })
  assert.equal(detacher.detach({ id: a.target.id, destination, index: 1, request: 1 }).status, 'error')
  assert.deepEqual(source.tabs, [a])
  assert.deepEqual(destination.tabs, [b, c])
  assert.equal(source.selected, a.target.id)
  assert.equal(destination.selected, c.target.id)
  assert.equal(a.host, source)
  assert.equal(source.window.isDestroyed(), false)
  assert.equal(destination.window.isDestroyed(), false)
  assert.equal(a.view.webContents.loads.length, 1)
})

test('关闭多标签窗口隐藏整组；关闭单个标签仅释放该页，最后一页关闭释放空窗口', () => {
  const { registry, createHost } = setup()
  const a = registry.presentInstance(target('a')), b = registry.presentInstance(target('b'))
  const host = createHost('window')
  registry.transferView(a.viewId, host)
  registry.transferView(b.viewId, host)
  host.window.close()
  assert.equal(host.window.visible, false)
  assert.equal(registry.views.size, 2)
  registry.focusInstance(a.target.id)
  assert.equal(host.selected, a.target.id)
  host.action({ action: 'close-active' })
  host.present(host.presentation)
  assert.equal(a.view.webContents.closed, 1)
  assert.equal(b.view.webContents.closed, 0)
  assert.equal(host.window.isDestroyed(), false)
  host.action({ action: 'close-active' })
  host.present(host.presentation)
  assert.equal(host.window.isDestroyed(), true)
  assert.equal(b.view.webContents.closed, 1)
})

test('home、版本、profile 分别区分窗口，重复打开及默认模式变更只聚焦', () => {
  const { registry, windows } = setup()
  const targets = [target(), target('other'), target('web', 'D:/home'), target('web', 'C:/home', '2.0.0')]
  for (const item of targets) registry.presentInstance(item, { presentation: 'window' })
  assert.equal(windows.length, 4)
  const first = registry.targets.get(targets[0].id)
  first.host.window.close()
  registry.presentInstance(targets[0], { presentation: 'internal' })
  assert.equal(windows.length, 4)
  assert.equal(first.host.kind, 'window')
  assert.ok(first.host.window.visible)
  assert.equal(first.view.webContents.loads.length, 1)
  registry.dispose()
  assert.equal(registry.views.size, 0)
  assert.equal(first.view.webContents.closed, 1)
})

test('标签往返迁移保留页面，旧 present 回执不能销毁或隐藏迁出的视图', () => {
  const { registry, tabs, windows } = setup()
  const record = registry.presentInstance(target())
  tabs.present(tabs.presentation)
  const stale = tabs.presentation
  const contents = record.view.webContents
  contents.draft = '未发送草稿'
  registry.presentInstance(target(), { presentation: 'window', explicit: true })
  tabs.present(stale)
  assert.equal(tabs.tabs.length, 0)
  assert.equal(tabs.retired.length, 0)
  assert.equal(record.view.webContents, contents)
  assert.equal(contents.loads.length, 1)
  assert.equal(contents.closed, 0)
  assert.ok(record.view.visible)
  // 普通打开按设置解析为 internal 后，与下拉开窗走同一个接口，不能粘在上一次的宿主。
  registry.presentInstance(target(), { presentation: 'internal', explicit: true })
  assert.ok(windows[0].window.destroyed)
  assert.equal(tabs.tabs[0], record)
  assert.equal(contents.draft, '未发送草稿')
  assert.equal(contents.loads.length, 1)
})

test('附加失败回挂源宿主，不重载；关闭与迁移交错不会复活已关闭页面', () => {
  const { registry, tabs, createHost } = setup()
  const record = registry.presentInstance(target())
  const destination = createHost('window')
  destination.window.contentView.addChildView = () => { throw new Error('attach failed') }
  assert.throws(() => registry.transferView(record.viewId, destination), /attach failed/)
  assert.equal(record.host, tabs)
  assert.equal(tabs.tabs[0], record)
  assert.equal(tabs.selected, record.target.id)
  assert.equal(record.view.webContents.loads.length, 1)
  assert.ok(destination.window.destroyed)
  tabs.action({ action: 'close-tab', id: record.target.id })
  assert.throws(() => registry.transferView(record.viewId, destination), /关闭/)
  const next = registry.presentInstance(target())
  tabs.present(tabs.presentation)
  assert.notEqual(next, record)
  assert.equal(record.view.webContents.closed, 1)
  assert.equal(next.view.webContents.closed, 0)
  assert.equal(registry.views.size, 1)
})

test('等待页自行跳转后认领，停止撤离旧地址，重启只更新对应页面', () => {
  const { registry } = setup()
  const original = target()
  const waiting = { ...original, url: 'http://127.0.0.1:3000/booting?profile=web', status: 'starting' }
  const record = registry.presentInstance(waiting, { presentation: 'window' })
  registry.follow([])
  assert.equal(record.view.webContents.loads.length, 1)
  record.view.webContents.url = 'http://127.0.0.1:4000/'
  registry.follow([original])
  assert.equal(record.view.webContents.loads.length, 1)
  assert.equal(record.loaded, original.url)
  const second = registry.presentInstance(target('other'), { presentation: 'window' })
  registry.follow([target('other')])
  assert.ok(record.localUrl.startsWith('data:'))
  assert.equal(second.view.webContents.loads.length, 1)
  record.host.window.close()
  registry.follow([{ ...original, status: 'starting', url: '' }, target('other')])
  assert.ok(record.booting)
  const restarted = { ...original, url: 'http://127.0.0.1:5000/?token=next' }
  registry.follow([restarted, target('other')])
  assert.equal(record.loaded, restarted.url)
  assert.equal(record.host.window.visible, false)
  assert.equal(second.view.webContents.loads.length, 1)
  registry.recover(record.viewId)
  assert.equal(record.view.webContents.loads.at(-1), restarted.url)
})

test('WSL 的页面标识与托盘操作标识独立，编辑或删除入口后不能误启动', () => {
  const { registry } = setup()
  const item = { ...target(), id: JSON.stringify(['wsl://Fedora/home', '', 'web']) }
  const record = registry.presentInstance(item, { presentation: 'window' })
  const row = { id: 'launch-a', instanceId: 'operation-with-version', target: item }
  registry.follow([item], [row])
  assert.equal(launchForView(record, [{ ...row, target: null }]).id, row.id)
  assert.equal(launchForView(record, [{ ...row, target: null, instanceId: 'changed' }]), undefined)
  assert.equal(launchForView(record, []), undefined)
  assert.equal(launchForView(record, [{ ...row, viewId: 'other', target: null }]), undefined)
})

test('停止启动中的实例撤掉等待页，失败等待则保留诊断；迁移停止页更新本地桥', () => {
  const { registry, tabs } = setup()
  const item = { ...target(), status: 'starting', url: 'http://127.0.0.1:3000/booting?profile=web' }
  const record = registry.presentInstance(item)
  registry.follow([])
  assert.ok(record.booting, '尚未出现实例或启动失败，等待页自行诊断')
  registry.follow([{ ...item, status: 'stopping', url: '' }])
  assert.equal(record.booting, false)
  assert.ok(record.localUrl)
  const previous = record.localUrl
  registry.presentInstance({ ...item, status: 'stopped', url: '' }, { presentation: 'window', explicit: true })
  assert.notEqual(record.localUrl, previous, '独立窗口停止页提供启动按钮')
  registry.transferView(record.viewId, tabs)
  assert.equal(record.localUrl, previous)
})

test('Electron 先销毁页面时，webContents getter 为空也能释放登记，不在退出时抛错', () => {
  const { registry } = setup()
  const record = registry.presentInstance(target())
  record.view.webContents = undefined
  assert.doesNotThrow(() => registry.disposeView(record.viewId))
  assert.equal(registry.views.size, 0)
  assert.equal(registry.targets.size, 0)
  assert.doesNotThrow(() => registry.disposeView(record.viewId))
})

test('主窗口销毁后统一清理不访问已销毁的管理页，也不重复释放视图', () => {
  const { registry, tabs } = setup()
  const record = registry.presentInstance(target())
  tabs.window.destroy()
  tabs.window.webContents.executeJavaScript = () => { throw new Error('destroyed manager') }
  assert.doesNotThrow(() => registry.dispose())
  registry.dispose()
  assert.equal(record.view.webContents.closed, 1)
})

test('本地页 IPC 必须来自当前登记的顶层页面，远端与子 frame 均拒绝', () => {
  const { registry } = setup()
  const record = registry.presentInstance(target(), { presentation: 'window' })
  const sender = record.view.webContents
  assert.equal(registry.localSender({ sender, senderFrame: sender.mainFrame }), undefined)
  registry.follow([])
  assert.equal(registry.localSender({ sender, senderFrame: sender.mainFrame }), record)
  assert.equal(registry.localSender({ sender, senderFrame: { url: record.localUrl } }), undefined)
  sender.mainFrame.url = 'data:text/html,forged'
  assert.equal(registry.localSender({ sender, senderFrame: sender.mainFrame }), undefined)
  registry.dispose()
  assert.equal(registry.localSender({ sender, senderFrame: sender.mainFrame }), undefined)
})

test('旧核心缺少元数据时沿用其三元组身份，重启仍进入正确 profile 的等待页', () => {
  const { registry } = setup()
  const { home, profile, version, homeName, ...legacy } = target('work')
  const record = registry.presentInstance(legacy, { presentation: 'window' })
  registry.follow([legacy])
  assert.equal(record.target.home, home)
  assert.equal(record.target.version, version)
  registry.follow([])
  registry.follow([{ ...legacy, status: 'starting', url: '' }])
  assert.equal(record.target.profile, profile)
  assert.equal(new URL(record.loaded).searchParams.get('profile'), profile)
})

test('旧 URL 入口仅认领可信等待页，窗口标题不展示认证 URL', () => {
  const manager = 'http://127.0.0.1:3000/'
  const url = manager + 'booting?home=wsl%3A%2F%2FFedora%2Fhome&version=auto&profile=web'
  assert.deepEqual(JSON.parse(legacyWindowTarget(url, manager, []).id), ['wsl://Fedora/home', '', 'web'])
  assert.equal(legacyWindowTarget(url.replace(':3000', ':3001'), manager, []).managed, false)
  const title = instanceWindowTitle({ target: target(), pageTitle: '\nhello http://127.0.0.1/?token=secret' })
  assert.match(title, /web.*1.2.3.*hello.*DSH-X/)
  assert.doesNotMatch(title, /secret|\n/)
})

test('拖出活动或后台标签：同一视图、草稿和顺序保留，不重载，不进入 retired', () => {
  for (const active of [true, false]) {
    const { registry, tabs, createHost } = setup()
    const first = registry.presentInstance(target())
    const second = registry.presentInstance(target('other'))
    tabs.selected = active ? first.target.id : second.target.id
    tabs.present(tabs.presentation)
    const contents = first.view.webContents
    contents.draft = '未发送'
    const stale = tabs.presentation
    const detacher = new TabDetacher(registry, tabs, { quitting: () => false, dragSupported: () => true,
      createHost: () => createHost('window') })
    assert.equal(detacher.detach({ id: first.target.id, source: 'drag', request: 1 }).status, 'success')
    tabs.present(stale)
    assert.equal(first.view.webContents, contents)
    assert.equal(contents.draft, '未发送')
    assert.equal(contents.loads.length, 1)
    assert.equal(contents.closed, 0)
    assert.deepEqual(tabs.tabs, [second])
    assert.equal(tabs.selected, second.target.id)
    assert.equal(tabs.retired.length, 0)
    assert.equal(first.host.kind, 'window')
    assert.ok(first.view.visible)
    assert.equal(detacher.available(first.target.id), false)
  }
})

test('拖出最后一个标签和停止页也不导航；新窗口获焦后旧回执不抢焦点', () => {
  const { registry, tabs, createHost } = setup()
  const record = registry.presentInstance({ ...target(), url: '', status: 'stopped' })
  const contents = record.view.webContents
  const originalUrl = record.localUrl
  let managerFocus = 0
  tabs.manager.focus = () => managerFocus++
  const detacher = new TabDetacher(registry, tabs, { quitting: () => false, dragSupported: () => true,
    createHost: () => {
      const host = createHost('window')
      host.hooks.reveal = () => { tabs.window.focused = false }
      return host
    } })
  detacher.detach({ id: record.target.id, request: 1 })
  tabs.present(tabs.presentation)
  assert.equal(record.localUrl, originalUrl)
  assert.equal(contents.loads.length, 1)
  assert.equal(tabs.selected, '')
  assert.equal(managerFocus, 0)
  assert.equal(contents.focuses, 1)
})

test('目标构造、附加、标题或聚焦失败均恢复原顺序、选中及页面', () => {
  for (const stage of ['create', 'attach', 'changed', 'reveal']) {
    const { registry, tabs, createHost } = setup()
    const first = registry.presentInstance(target())
    const second = registry.presentInstance(target('other'))
    const before = [...tabs.tabs]
    let destination, failure
    const detacher = new TabDetacher(registry, tabs, { quitting: () => false, dragSupported: () => true,
      failed: (error) => { failure = error },
      createHost: () => {
        const fail = () => { throw new Error(stage) }
        if (stage === 'create') fail()
        destination = createHost('window')
        destination[stage] = fail
        return destination
      } })
    assert.equal(detacher.detach({ id: first.target.id, request: 1 }).status, 'error')
    assert.equal(failure.message, stage)
    assert.deepEqual(tabs.tabs, before)
    assert.equal(tabs.selected, second.target.id)
    assert.equal(first.host, tabs)
    assert.equal(first.view.webContents.loads.length, 1)
    assert.equal(first.view.webContents.closed, 0)
    if (destination) assert.ok(destination.window.destroyed)
  }
})

test('仅禁用手势时菜单仍可用，重复或过期请求及关闭中页面不能创建窗口', () => {
  const { registry, tabs, createHost, windows } = setup()
  const record = registry.presentInstance(target())
  const detacher = new TabDetacher(registry, tabs, { quitting: () => false, dragSupported: () => false,
    createHost: () => createHost('window') })
  assert.equal(detacher.detach({ id: record.target.id, source: 'drag', request: 1 }).status, 'error')
  assert.equal(windows.length, 0)
  assert.equal(detacher.detach({ id: record.target.id, source: 'menu', request: 2 }).status, 'success')
  registry.transferView(record.viewId, tabs)
  assert.equal(detacher.detach({ id: record.target.id, request: 2 }), undefined)
  assert.equal(detacher.detach({ id: record.target.id, request: 1 }), undefined)
  assert.equal(windows.length, 1)
  tabs.action({ action: 'close-tab', id: record.target.id })
  assert.equal(detacher.detach({ id: record.target.id, request: 3 }).status, 'error')
  assert.equal(windows.length, 1)
})

test('平台禁用迁移时菜单与旧 detach IPC 均拒绝，页面保持原宿主', () => {
  const { registry, tabs, createHost, windows } = setup({ canTransfer: () => false })
  const record = registry.presentInstance(target())
  const detacher = new TabDetacher(registry, tabs, { migrationSupported: () => false, quitting: () => false,
    dragSupported: () => false, createHost: () => createHost('window') })
  assert.equal(detacher.migrationSupported(), false)
  assert.equal(detacher.canCreateWindow(record.target.id), false)
  for (const source of ['menu', 'drag']) {
    assert.equal(detacher.detach({ id: record.target.id, source }).status, 'error')
  }
  assert.equal(windows.length, 0)
  assert.equal(record.host, tabs)
})

test('标签栏布局将页面缩放的 CSS 高度转成原生 DIP，不被内容层遮挡', () => {
  const { tabs } = setup()
  tabs.headerHeight = 40
  for (const zoom of [1, 1.25, 1.5, 2]) {
    tabs.manager.getZoomFactor = () => zoom
    assert.deepEqual(tabs.tabBounds(), { x: 0, y: 40 * zoom, width: 1000, height: 700 - 40 * zoom })
  }
})
