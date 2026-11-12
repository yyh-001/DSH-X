import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { InstanceViews, instanceWindowTitle, launchForView, legacyWindowTarget } from '../shell/instance-views.mjs'
import { InstanceWindow } from '../shell/instance-window.mjs'
import { BrowserTabs } from '../shell/tabs.mjs'

class Window extends EventEmitter {
  constructor() {
    super()
    this.children = new Set()
    this.visible = true
    this.contentView = { addChildView: (view) => this.children.add(view), removeChildView: (view) => this.children.delete(view) }
    this.webContents = { executeJavaScript: async () => 0, focus() {}, reload() {} }
  }
  getContentBounds() { return { width: 1000, height: 700 } }
  isDestroyed() { return this.destroyed === true }
  hide() { this.visible = false }
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

function setup() {
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
      dispose: (id) => registry.disposeView(id), reveal: (win) => { win.visible = true }, titles() {} })
    windows.push(host)
    return host
  }
  registry = new InstanceViews({ createView: view, createHost, bootUrl: (target) => `http://127.0.0.1:3000/booting?profile=${target.profile}` })
  return { registry, tabs, windows, createHost, hidden: () => hidden }
}
const target = (profile = 'web', home = 'C:/home', version = '1.2.3') => ({
  id: JSON.stringify([home, version, profile]), home, version, profile, homeName: home,
  title: profile, status: 'running', managed: true, url: `http://127.0.0.1:${profile === 'web' ? 4000 : 4001}/?token=fake`,
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
