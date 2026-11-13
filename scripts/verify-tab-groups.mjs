// electron scripts/verify-tab-groups.mjs：真实外壳/核心入口，全部数据和测试页面留在隔离目录。
import { app, BrowserWindow, Menu, systemPreferences } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, join, relative, isAbsolute } from 'node:path'

// macOS 的 homedir 与 Linux 的 XDG 路径尚未做原生隔离验收；拒绝在正式目录冒险运行。
if (process.platform !== 'win32') throw new Error('verify-tab-groups currently supports isolated Windows runs only')
const realDrag = process.argv.includes('--drag')
const local = resolve(import.meta.dirname, '../.paseo-local')
const outputIndex = process.argv.indexOf('--output-dir')
const root = outputIndex < 0 ? join(local, 'runtime', realDrag ? 'tab-groups-drag' : 'tab-groups-native')
  : resolve(process.argv[outputIndex + 1] || '')
const within = relative(local, root)
assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '验收输出必须位于工作区 .paseo-local 内')
const appdata = join(root, 'appdata'), home = join(root, 'home'), data = join(root, 'data')
for (const dir of [join(appdata, 'DSH'), home, data]) mkdirSync(dir, { recursive: true })
writeFileSync(join(appdata, 'DSH/settings.json'), JSON.stringify({ dshHome: home, dataDir: data, openMode: 'internal', autoStart: false, autoUpdate: false, lang: 'zh' }))
Object.assign(process.env, { APPDATA: appdata, DSH_HOME: home, DSH_CORE_DIR: resolve(import.meta.dirname, '../src') })
const userData = join(appdata, 'DSH', 'electron')
mkdirSync(userData, { recursive: true })
app.setPath('appData', appdata)
app.setPath('userData', userData)
app.setPath('sessionData', userData)
// main 会再次设置 userData；在真正取得锁前检查最终值，防止未来路径规则变化漏出隔离区。
const requestLock = app.requestSingleInstanceLock.bind(app)
app.requestSingleInstanceLock = (...args) => {
  assert.equal(app.getPath('userData'), userData)
  assert.equal(app.getPath('sessionData'), userData)
  const acquired = requestLock(...args)
  writeFileSync(join(root, 'single-instance.json'), JSON.stringify({ acquired, userData: app.getPath('userData') }, null, 2))
  assert.equal(acquired, true, '隔离验收应取得自己的单实例锁')
  return acquired
}
writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: false, phase: 'starting' }))
// 测试退出阶段也属于验收结果；异常写入隔离日志，避免弹出无人处理的 Electron 错误框。
process.on('uncaughtException', (error) => {
  console.error(error)
  writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: false, error: error.stack }))
  process.exit(1)
})
const menus = [], servers = []
// 自动验收只替换全局鼠标坐标，仍执行实际顶栏脚本、IPC 和原生视图迁移；不冒充系统捕获验收。
let cursorOverride = null
const buildMenu = Menu.buildFromTemplate
Menu.buildFromTemplate = function (template) {
  const menu = buildMenu.call(this, template)
  menus.push(menu)
  return menu
}
const until = async (fn, attempts = 200) => {
  for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await new Promise((done) => setTimeout(done, 50)) }
  throw new Error('group fixture timeout')
}
let serial = Date.now() + 100000
const invokeMenu = async (window, id, label) => {
  const before = menus.length
  await window.webContents.executeJavaScript(`ipc.postMessage(${JSON.stringify(JSON.stringify({ action: 'tab-menu', id, request: ++serial }))})`)
  await until(() => menus.length > before)
  const menu = menus.at(-1), item = menu.items.find((item) => item.label === label)
  assert.ok(item?.enabled, `可用菜单项：${label}`)
  item.click()
  menu.closePopup()
}
const count = (window) => window.webContents.executeJavaScript('document.querySelectorAll(".internal-tab").length')
const stripPoint = async (window) => {
  const bounds = window.getContentBounds(), zoom = window.webContents.getZoomFactor()
  const point = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('internalTabList').getBoundingClientRect();return {x:r.left+24,y:r.top+8}})()`)
  return { x: bounds.x + point.x * zoom, y: bounds.y + point.y * zoom }
}
const startLive = async (window) => {
  cursorOverride = await stripPoint(window)
  const point = await window.webContents.executeJavaScript(`(() => {
    const r=document.querySelector('.internal-tab-label').getBoundingClientRect();
    return window.dragFixture={x:Math.round(r.left+20),y:Math.round(r.top+10)};
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 8, y: point.y, modifiers: ['leftButtonDown'] })
  await until(() => window.webContents.executeJavaScript(`document.getElementById('internalTabList').hasPointerCapture(1)`))
  return point
}
const endLive = async (window, cancel = false) => {
  const point = await window.webContents.executeJavaScript('dragFixture')
  if (cancel) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}
const watchdog = setTimeout(() => {
  const error = realDrag ? '等待人工拖动超时，未完成系统鼠标验收' : '窗口组合验收超时'
  console.error(error)
  writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: false, error }))
  // 超时直接结束测试进程，避免先销毁窗口后仍有等待中的 DOM 断言产生误导性的二次异常。
  process.exit(1)
}, realDrag ? 240000 : 45000)
async function run() {
  try {
    // screen 的 ESM 导出等待 ready；入口顶层导入会阻塞 Electron 完成入口加载。
    await app.whenReady()
    const { screen } = await import('electron')
    const cursorPoint = screen.getCursorScreenPoint
    screen.getCursorScreenPoint = () => cursorOverride || cursorPoint.call(screen)
    // 管理服务的同端口探测会唤醒另一个 DSH-X，即使数据目录不同；测试显式选择空闲端口。
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((done) => reservation.close(done))
    writeFileSync(join(appdata, 'DSH/settings.json'), JSON.stringify({ port, dshHome: home, dataDir: data, openMode: 'internal', autoStart: false, autoUpdate: false, lang: 'zh' }))
    const urls = []
    for (const name of ['one', 'two']) {
      const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>${name}</title><input id="draft"><div style="height:2000px">${name}</div>`) })
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server)
      urls.push(`http://127.0.0.1:${server.address().port}`)
    }
    await import('../shell/env.mjs')
    const { APP_DIR } = await import('../src/filemanager.js')
    assert.equal(APP_DIR, join(appdata, 'DSH'))
    assert.equal(app.getPath('userData'), userData)
    writeFileSync(join(root, 'isolation.json'), JSON.stringify({ platform: process.platform, appDir: APP_DIR,
      appData: app.getPath('appData'), userData, sessionData: app.getPath('sessionData'), home, data }, null, 2))
    await import('../shell/main.mjs')
    assert.equal(app.getPath('userData'), userData)
    const main = await until(() => BrowserWindow.getAllWindows().find((window) => /\/?\?window=1$/.test(window.webContents.getURL())))
    await until(() => main.webContents.executeJavaScript('typeof window.updateInternalTabs === "function"'))
    const manager = new URL(main.webContents.getURL()).origin
    for (const url of urls) {
      const response = await fetch(`${manager}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
      assert.equal(response.status, 200)
    }
    await until(async () => await count(main) === 2)
    const views = []
    for (const url of urls) views.push(await until(() => main.contentView.children.find((view) => view.webContents?.getURL().startsWith(url))))
    for (const view of views) await until(() => view.webContents.executeJavaScript('!!document.getElementById("draft")'))
    for (const [index, view] of views.entries()) await view.webContents.executeJavaScript(`draft.value='draft-${index}';scrollTo(0,300)`)
    const contentsIds = views.map((view) => view.webContents.id)
    await invokeMenu(main, urls[0], '移到新窗口')
    const one = await until(() => BrowserWindow.getAllWindows().find((window) => window !== main))
    await until(async () => await count(one) === 1)
    assert.ok(one.webContents.getURL().endsWith('/tab-window.html'))
    assert.equal(await one.webContents.executeJavaScript('getComputedStyle(document.querySelector(".win-controls")).display'), 'flex')
    await invokeMenu(main, urls[1], `移到 ${one.getTitle()}`)
    await until(async () => await count(one) === 2 && await count(main) === 0)
    assert.equal(one.contentView.children.filter((view) => views.includes(view)).length, 2)
    writeFileSync(join(root, 'group-header.png'), (await one.webContents.capturePage()).toPNG())
    // 真正的 before-input-event 路由必须跟随页面迁移，正反切换不能落到别的宿主。
    const cycle = (contents, modifiers) => {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers })
    }
    cycle(views[1].webContents, ['control', 'shift'])
    await until(async () => await one.webContents.executeJavaScript('document.querySelector(".internal-tab.active")?.dataset.id') === urls[0])
    cycle(views[0].webContents, ['control'])
    await until(async () => await one.webContents.executeJavaScript('document.querySelector(".internal-tab.active")?.dataset.id') === urls[1])
    const settings = async (value) => {
      const response = await fetch(`${manager}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      assert.equal(response.status, 200)
    }
    for (const theme of ['light', 'dark']) {
      await settings({ theme, reduceMotion: true })
      await until(() => one.webContents.executeJavaScript(`document.documentElement.dataset.colorScheme === '${theme}' && document.documentElement.classList.contains('reduce-motion')`))
      for (const width of [720, 1180]) {
        one.setSize(width, 820)
        const geometry = await one.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
          const controls = document.querySelector('.win-controls').getBoundingClientRect();
          resolve({ right: controls.right, width: innerWidth, list: document.getElementById('internalTabList').getBoundingClientRect().width });
        }))`)
        assert.ok(geometry.right <= geometry.width && geometry.list > 100)
        writeFileSync(join(root, `header-${theme}-${width}.png`), (await one.webContents.capturePage({ x: 0, y: 0, width, height: 60 })).toPNG())
      }
    }
    cursorOverride = await stripPoint(one)
    const gesture = await one.webContents.executeJavaScript(`(async () => {
      const label = document.querySelector('.internal-tab-label'), list = document.getElementById('internalTabList');
      const box = label.getBoundingClientRect(), before = list.getBoundingClientRect().width;
      const init = { bubbles:true, pointerId:7, pointerType:'mouse', button:0, isPrimary:true, clientX:box.left+20, clientY:box.top+10 };
      label.dispatchEvent(new PointerEvent('pointerdown', init));
      document.dispatchEvent(new PointerEvent('pointermove', {...init, clientY:100}));
      await new Promise(requestAnimationFrame);
      const hint = document.querySelector('.internal-tab-hint');
      const result = { before, after:list.getBoundingClientRect().width, visible:!hint.hidden, duration:getComputedStyle(hint).animationDuration };
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      return result;
    })()`)
    assert.equal(gesture.before, gesture.after)
    assert.ok(gesture.visible)
    assert.ok(parseFloat(gesture.duration) <= 0.001)
    await settings({ reduceMotion: false })
    await until(() => one.webContents.executeJavaScript(`!document.documentElement.classList.contains('reduce-motion')`))
    cursorOverride = null
    if (realDrag) {
      main.setBounds({ x: 30, y: 30, width: 900, height: 600 })
      main.show(); main.hide(); main.show()
      one.setBounds({ x: 50, y: 250, width: 900, height: 600 })
      one.show(); one.hide(); one.show(); one.focus()
      console.log('READY: drag the first DSH tab from the lower window into the empty tab strip of the upper launcher')
      await until(async () => await count(main) === 1 && await count(one) === 1, 4000)
      assert.ok(main.contentView.children.includes(views[0]))
      // 实时合并先于松手完成；等源捕获释放后才能验证下一次菜单迁移。
      await until(() => one.webContents.executeJavaScript(`!document.getElementById('internalTabList').hasPointerCapture(1)`), 4000)
      await invokeMenu(main, urls[0], `移到 ${one.getTitle()}`)
      await until(async () => await count(one) === 2)
    }
    await invokeMenu(one, urls[0], '移到新窗口')
    const two = await until(() => BrowserWindow.getAllWindows().find((window) => window !== main && window !== one))
    await until(async () => await count(two) === 1)
    main.setBounds({ x: 30, y: 30, width: 900, height: 600 }); main.showInactive()
    one.setBounds({ x: 50, y: 250, width: 900, height: 600 }); one.showInactive()
    two.setBounds({ x: 970, y: 250, width: 900, height: 600 }); two.show(); two.focus()
    const fadeValues = []
    const setOpacity = two.setOpacity.bind(two)
    two.setOpacity = (value) => { fadeValues.push(value); setOpacity(value) }
    await startLive(two)
    cursorOverride = await stripPoint(main)
    await until(async () => await count(main) === 1 && await count(two) === 0)
    assert.ok(!two.isDestroyed(), '按住期间源顶栏保留捕获')
    if (process.platform !== 'linux') await until(() => two.getOpacity() === 0)
    assert.ok(await two.webContents.executeJavaScript(`document.getElementById('internalTabList').hasPointerCapture(1)`))
    assert.ok(main.contentView.children.includes(views[0]), '未发 pointerup 已迁移原视图')
    await endLive(two, true)
    await until(async () => await count(main) === 0 && await count(two) === 1)
    assert.equal(two.getOpacity(), 1, '撤销恢复原窗口显示')
    const grabPoint = await startLive(two)
    const windowCount = BrowserWindow.getAllWindows().length
    for (const point of [{ x: -5, y: 950 }, { x: 1900, y: 950 }]) {
      cursorOverride = point
      await until(() => Math.abs(two.getContentBounds().x + grabPoint.x - point.x) <= 1
        && Math.abs(two.getContentBounds().y + grabPoint.y - point.y) <= 1)
      assert.equal(two.getBounds().width, 900)
      assert.equal(two.getBounds().height, 600)
    }
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, '单标签拆出不新建第二扇窗口')
    assert.ok(two.contentView.children.includes(views[0]))
    assert.ok(await two.webContents.executeJavaScript(`document.getElementById('internalTabList').hasPointerCapture(1)`), '移动原窗口后继续捕获')
    cursorOverride = await stripPoint(main)
    await until(async () => await count(main) === 1)
    cursorOverride = await stripPoint(one)
    await until(async () => await count(one) === 2 && await count(main) === 0)
    cursorOverride = { x: 1900, y: 950 }
    await until(() => two.contentView.children.includes(views[0]))
    assert.equal(BrowserWindow.getAllWindows().length, windowCount, '连续拆合仍复用原窗口')
    await until(() => two.getOpacity() === 1)
    cursorOverride = await stripPoint(main)
    await until(async () => await count(main) === 1)
    await endLive(two)
    await until(() => two.isDestroyed())
    cursorOverride = null
    await invokeMenu(one, urls[1], '移到启动器窗口')
    await until(() => one.isDestroyed())
    await until(async () => await count(main) === 2)
    const sourceTab = await main.webContents.executeJavaScript(`(() => {const r=document.querySelector('.internal-tab').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`)
    const newGrab = await startLive(main)
    cursorOverride = { x: 1900, y: 950 }
    const detached = await until(() => BrowserWindow.getAllWindows().find((window) => window !== main))
    await until(() => detached.isVisible())
    await until(() => detached.getOpacity() === 1)
    const detachedTab = await detached.webContents.executeJavaScript(`(() => {const r=document.querySelector('.internal-tab').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`)
    const content = detached.getContentBounds()
    assert.ok(Math.abs(content.x + detachedTab.left + (newGrab.x - sourceTab.left) / sourceTab.width * detachedTab.width - cursorOverride.x) <= 1)
    assert.ok(Math.abs(content.y + detachedTab.top + (newGrab.y - sourceTab.top) / sourceTab.height * detachedTab.height - cursorOverride.y) <= 1)
    const droppedBounds = detached.getBounds()
    await endLive(main)
    await until(() => detached.isFocused())
    assert.deepEqual(detached.getBounds(), droppedBounds, '松手聚焦不会重新居中用户指定的屏幕边缘落点')
    await invokeMenu(detached, urls[0], '移到启动器窗口')
    await until(() => detached.isDestroyed())
    cursorOverride = null
    for (const [index, view] of views.entries()) {
      assert.equal(view.webContents.id, contentsIds[index])
      assert.ok(main.contentView.children.includes(view))
      assert.deepEqual(await view.webContents.executeJavaScript('({draft:draft.value,scroll:scrollY})'), { draft: `draft-${index}`, scroll: 300 })
    }
    const animationSettings = systemPreferences.getAnimationSettings()
    const nativeFadeIntermediateFrames = fadeValues.filter((value) => value > 0 && value < 1).length
    if (process.platform !== 'linux' && animationSettings.shouldRenderRichAnimation && !animationSettings.prefersReducedMotion) {
      assert.ok(nativeFadeIntermediateFrames > 0, '启用动画时必须观察到原生透明度中间帧')
    }
    const result = { passed: true, electron: process.versions.electron, nativeMenuMerge: true, splitAndReturn: true, emptyWindowClosed: true, customChrome: true, keyboardCycle: true, lightDarkLayouts: true, stableDragLayout: gesture, liveMergeBeforeRelease: true, liveCancel: true, liveRedetach: true, singleWindowReused: true, grabAnchorPreserved: true, unconstrainedDrag: true, nativeFadeIntermediateFrames, animationSettings, realDrag, contentsIds }
    writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error)
    writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: false, error: error.message }))
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    for (const server of servers) { server.closeAllConnections(); server.close() }
    app.exit(process.exitCode || 0)
  }
}
void run()
