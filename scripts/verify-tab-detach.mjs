// 用 Electron 直接运行：electron scripts/verify-tab-detach.mjs。只启动本地测试页，数据固定隔离到 .paseo-local。
import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, relative, isAbsolute } from 'node:path'
import { once } from 'node:events'
import { InstanceViews } from '../shell/instance-views.mjs'
import { InstanceWindow } from '../shell/instance-window.mjs'
import { BrowserTabs } from '../shell/tabs.mjs'
import { DesktopBrowserGuests, BROWSER_IPC } from '../shell/browser-guests.mjs'
import { TabDetacher, managerTabSender } from '../shell/tab-detach.mjs'
import { TabDragSession } from '../shell/tab-drag-session.mjs'
import { parseTabAction } from '../shell/model.mjs'

const local = resolve(import.meta.dirname, '../.paseo-local')
const outputIndex = process.argv.indexOf('--output-dir')
const root = outputIndex < 0 ? resolve(local, 'runtime/tab-detach-native') : resolve(process.argv[outputIndex + 1] || '')
const within = relative(local, root)
assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '验收输出必须位于工作区 .paseo-local 内')
mkdirSync(root, { recursive: true })
writeFileSync(resolve(root, 'result.json'), JSON.stringify({ passed: false, phase: 'starting' }))
app.setPath('userData', root)
app.setPath('sessionData', root)
app.setPath('logs', root)
app.disableHardwareAcceleration()
const servers = [], windows = []
const listen = async (handler) => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}
const until = async (fn) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((done) => setTimeout(done, 50)) }
  throw new Error('fixture timeout')
}
let registry
const watchdog = setTimeout(() => { console.error('native fixture watchdog'); app.exit(1) }, 25000)
async function run() {
try {
  await app.whenReady()
  console.log('ready', process.versions.electron)
  const guestUrl = await listen((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><input id="guestDraft"><div style="height:3000px">guest</div>') })
  const url = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<input id="draft"><div style="height:2400px"></div><webview id="guest" allowpopups style="position:fixed;right:0;top:0;width:300px;height:400px"></webview><script>
      (async () => {
        const lease = await dshDesktop.browser.acquire('transfer-fixture'); window.lease = lease;
        dshDesktop.browser.onOpenRequested(lease.lease, url => { window.guestLink = url });
        guest.partition = lease.partition; guest.src = 'about:blank#' + lease.lease;
        guest.addEventListener('dom-ready', () => { if (guest.getURL().startsWith('about:')) guest.src = '${guestUrl}' });
      })();
    </script>`)
  })
  const guests = new DesktopBrowserGuests(() => [url])
  ipcMain.handle(BROWSER_IPC.acquire, (event, workspace) => guests.acquire(event.sender, workspace))
  ipcMain.handle(BROWSER_IPC.release, (event, lease) => guests.release(event.sender, lease))
  const managerUrl = await listen((req, res) => {
    const files = { '/internal-tabs.js': 'text/javascript', '/launcher.css': 'text/css', '/icons.svg': 'image/svg+xml' }
    if (files[req.url]) {
      res.setHeader('Content-Type', files[req.url])
      res.end(readFileSync(resolve(import.meta.dirname, '../src/public' + req.url)))
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/launcher.css"><style>
      :root{--card:#fff;--accent:#3972e6;--muted:#777;--border:#ddd;--text:#222;--accent-soft:#eef4ff}
      body{margin:0;font:14px sans-serif}header{display:flex;align-items:center;padding:10px;background:#eee}
      main{padding:40px}
    </style></head><body><header><div id="internalTabsArea" class="internal-tabs-area" hidden>
      <div id="internalTabList" class="internal-tab-list" role="tablist"></div><button id="internalTabReload">Reload</button>
    </div></header><main>Manager fixture</main><script src="/internal-tabs.js"></script></body></html>`)
  })
  const main = new BrowserWindow({ show: false, width: 1000, height: 700,
    webPreferences: { preload: resolve(import.meta.dirname, '../shell/preload.cjs'), sandbox: true, contextIsolation: true } })
  windows.push(main)
  const tabs = new BrowserTabs(main, { retire: (r) => registry.retire(r), dispose: (id) => registry.disposeView(id), reveal() { main.showInactive() },
    detach: () => ({ supported: true, drag: true }) })
  const createHost = () => {
    const window = new BrowserWindow({ show: false, width: 1000, height: 700 })
    windows.push(window)
    return new InstanceWindow(window, { quitting: () => false, hidden() {}, titles() {}, dispose: (id) => registry.disposeView(id), reveal: window => window.showInactive() })
  }
  registry = new InstanceViews({ createHost: (kind) => kind === 'internal' ? tabs : createHost(), createView() {
    const view = new WebContentsView({ webPreferences: { preload: resolve(import.meta.dirname, '../shell/preload-browser.cjs'), sandbox: true, contextIsolation: true, webviewTag: true } })
    guests.bind(view.webContents)
    view.webContents.on('console-message', (event) => console.log('fixture console', event.message))
    return view
  } })
  const detacher = new TabDetacher(registry, tabs, { createHost, quitting: () => false, dragSupported: () => true })
  ipcMain.on('dsh-x:ipc', (event, message) => {
    if (!managerTabSender(event, main.webContents, managerUrl)) return
    if (message === 'internal-tabs-ready') return tabs.render(true)
    const action = parseTabAction(message)
    if (action?.action === 'detach-tab') detacher.detach(action)
    else if (action) tabs.action(action)
  })
  await main.loadURL(managerUrl)
  console.log('manager loaded')
  const record = registry.presentInstance({ id: 'fixture', url, title: 'fixture', managed: false })
  const contents = record.view.webContents
  await once(contents, 'did-finish-load')
  console.log('owner loaded')
  tabs.present(tabs.presentation)
  await until(() => [...guests.leases.values()].some((lease) => lease.guest?.getURL().startsWith(guestUrl)))
  console.log('guest loaded')
  const lease = [...guests.leases.values()][0]
  await until(() => lease.guest.executeJavaScript('!!document.getElementById("guestDraft")'))
  await contents.executeJavaScript('draft.value="unsent draft"; scrollTo(0,450); window.fixtureState={value:42}; history.pushState({},"","/chat");')
  await lease.guest.executeJavaScript('guestDraft.value="guest draft"; scrollTo(0,150)')
  const before = { webContentsId: contents.id, guestId: lease.guest.id, lease: [...guests.leases.keys()][0], history: contents.navigationHistory.length() }
  let navigations = 0
  contents.on('did-start-navigation', () => navigations++)
  const stale = tabs.presentation
  await until(() => main.webContents.executeJavaScript('!!document.querySelector(".internal-tab-menu:not([hidden])")'))
  writeFileSync(resolve(root, 'before.png'), (await main.webContents.capturePage()).toPNG())
  // 真正的管理页脚本经预加载/IPC 进入协调器；合成指针事件不等同于系统鼠标捕获验收。
  await main.webContents.executeJavaScript(`(() => {
    const label = document.querySelector('.internal-tab-label'), box = label.getBoundingClientRect();
    const init = { bubbles:true, pointerId:1, pointerType:'mouse', button:0, isPrimary:true, clientX:box.left+20, clientY:box.top+10 };
    label.dispatchEvent(new PointerEvent('pointerdown', init));
    document.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY:box.bottom+40 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...init, clientY:box.bottom+40 }));
  })()`)
  await until(() => record.host.kind === 'window')
  tabs.present(stale)
  await new Promise((done) => setTimeout(done, 200))
  const state = await contents.executeJavaScript('({draft:draft.value,scroll:scrollY,value:fixtureState.value})')
  const guestState = await lease.guest.executeJavaScript('({draft:guestDraft.value,scroll:scrollY})')
  assert.deepEqual(state, { draft: 'unsent draft', scroll: 450, value: 42 })
  assert.deepEqual(guestState, { draft: 'guest draft', scroll: 150 })
  assert.equal(contents.id, before.webContentsId)
  assert.equal(lease.guest.id, before.guestId)
  assert.equal(guests.leases.get(before.lease), lease)
  assert.equal(navigations, 0)
  assert.equal(contents.navigationHistory.length(), before.history)
  assert.equal(tabs.retired.length, 0)
  await lease.guest.executeJavaScript(`guestDraft.focus(); guestDraft.setSelectionRange(guestDraft.value.length,guestDraft.value.length); window.open('${guestUrl}/opened')`)
  lease.guest.sendInputEvent({ type: 'char', keyCode: '!' })
  await until(async () => await lease.guest.executeJavaScript('guestDraft.value') === 'guest draft!')
  await until(async () => await contents.executeJavaScript('window.guestLink') === guestUrl + '/opened')
  // 附加已执行后再抛错，验证真正的原生子视图仍能原样回挂。
  registry.transferView(record.viewId, tabs, { preservePage: true })
  const broken = createHost(), attach = broken.attach.bind(broken)
  broken.attach = (value) => { attach(value); throw new Error('fixture attach failure') }
  assert.throws(() => registry.transferView(record.viewId, broken, { preservePage: true }), /fixture attach failure/)
  tabs.present(tabs.presentation)
  assert.equal(record.host, tabs)
  assert.equal(record.view.webContents.id, before.webContentsId)
  assert.equal(guests.leases.get(before.lease), lease)
  assert.equal(navigations, 0)
  assert.ok(broken.window.isDestroyed())
  assert.equal(await contents.executeJavaScript('draft.value'), 'unsent draft')
  assert.equal(await lease.guest.executeJavaScript('guestDraft.value'), 'guest draft!')
  const gesture = new TabDragSession(registry), destination = createHost()
  const cancelled = gesture.begin(tabs, record.target.id)
  assert.ok(cancelled)
  gesture.cancel(tabs, cancelled)
  assert.equal(record.host, tabs)
  const token = gesture.begin(tabs, record.target.id)
  assert.equal(gesture.drop(destination, token, 0, { newWindow: true }), true)
  assert.equal(gesture.drop(tabs, token, 0), false)
  gesture.clear()
  assert.equal(record.host, destination)
  assert.equal(record.view.webContents.id, before.webContentsId)
  assert.equal(lease.guest.id, before.guestId)
  const returning = gesture.begin(destination, record.target.id)
  assert.equal(gesture.drop(tabs, returning, 0), true)
  gesture.clear()
  assert.equal(record.host, tabs)
  assert.equal(guests.leases.get(before.lease), lease)
  assert.equal(await contents.executeJavaScript('draft.value'), 'unsent draft')
  assert.equal(await lease.guest.executeJavaScript('guestDraft.value'), 'guest draft!')
  assert.equal(navigations, 0)
  const result = { electron: process.versions.electron, before, state, guestState, navigations,
    rendererToIpc: true, nativeRollback: true, guestInputAndLinks: true, singleCommitRoundTrip: true, passed: true }
  writeFileSync(resolve(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error)
  writeFileSync(resolve(root, 'result.json'), JSON.stringify({ passed: false, error: error.message }))
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  registry?.dispose()
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
  for (const server of servers) { server.closeAllConnections(); server.close() }
  app.exit(process.exitCode || 0)
}
}
void run()
