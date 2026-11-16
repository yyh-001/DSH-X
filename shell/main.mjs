// 必须是第一个 import：它在核心（server.js）求值之前补好 PATH 和外壳标记（见 env.mjs）
import './env.mjs'
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, powerMonitor, powerSaveBlocker, screen, session, shell, systemPreferences } from 'electron'
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserTabs } from './tabs.mjs'
import { InstanceViews, instanceWindowTitle, launchForView, legacyWindowTarget } from './instance-views.mjs'
import { InstanceWindow } from './instance-window.mjs'
import { TabDetacher, TabDragFeedback, detachedBounds, draggedBounds, managerTabSender, tabDragSupported, tabDropTarget, tabMigrationSupported, outsideTabStrip } from './tab-detach.mjs'
import { TabDragSession } from './tab-drag-session.mjs'
import { WindowFade } from './window-fade.mjs'
import { BROWSER_IPC, DesktopBrowserGuests } from './browser-guests.mjs'
import { createCoreRecovery, isEnvironmentStartupError } from './core-recovery.mjs'
import { corePackageName, channelOf, coreRegistries, fetchCoreMetadata, installCore, pickCoreRelease, tarballFor } from './core-fetch.mjs'
import { createUpdater } from './updater.mjs'
import { readPrefs } from './prefs.mjs'
import { shellRelaunchOptions } from './relaunch.mjs'
import { coreSetupPage, coreSetupPaintScript, dataUrl, errorPage, resolveDark, tabBaseColor, tabWindowFallbackPage, tabDragPreviewPage } from './pages.mjs'
import { clickTarget, dialogOptions, notificationDecision, notifyThrottled } from './desktop.mjs'
import {
  LAUNCH_ACTIONS,
  internalMode,
  isExternalWebUrl,
  isLoopbackUrl,
  isWebUrl,
  launchActionEnabled,
  launchActionRequest,
  launchLabel,
  liveInstances,
  parseTabAction,
  parseTrayState,
  recenterBounds,
  sameOrigin,
  windowMode,
} from './model.mjs'

/**
 * Windows / macOS 的 DSH-X 外壳（Electron）。Windows 和 macOS 安装包里都是这一套：
 * 管理页、内部标签页、独立 DSH 窗口都跑在 Chromium 里，和官方 DSH 桌面端同一个内核。
 * launcher/ 那份 Rust + WKWebView/WebView2 外壳只剩安装引擎（DSH-Setup）在用。
 *
 * 和 Rust 外壳最大的不同：管理服务（server.js）不再是子进程，而是跑在本进程里。所以
 * - 「把窗口叫出来 / 开标签 / 开窗口」不再走 stdout 标记行，而是 setHost 换成直接调用；
 * - 退出时先让服务收尾（停 dsh、通知页面），再退出 Electron（见 quit）。
 * dsh 子进程用 RUNTIME_NODE 拉起（见下）：Electron 本体加 ELECTRON_RUN_AS_NODE=1——
 * 这样不用再随包塞一份 node.exe（省 80MB+）。
 *
 * 外壳和核心是两层：安装包的 resources/app 只有这个外壳，核心在用户目录的 core/current
 * （第一次启动从 npm 取，见 core-fetch.mjs）。外壳启动时动态 import 核心的 server.js，
 * 核心更新不需要换整个安装包；外壳自己的更新才走 electron-updater（见 updater.mjs）。
 *
 * 关窗口 ≠ 退出：托盘还在、dsh 照常跑；⌘Q、托盘「退出」才真正退出。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PRELOAD = join(HERE, 'preload.cjs')
/** dsh 标签页的预加载：只暴露官方右侧栏浏览器要的 dshDesktop 桥（见 preload-browser.cjs）。 */
const BROWSER_PRELOAD = join(HERE, 'preload-browser.cjs')
const IS_MAC = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'
/** 拉 dsh 子进程用的 node：Electron 本体（源码运行可用 DSH_RUNTIME_NODE 覆盖）。 */
const RUNTIME_NODE = process.env.DSH_RUNTIME_NODE || process.execPath
/**
 * 每用户目录：和核心的 filemanager 同一套约定（%APPDATA%\DSH / ~/Library/Application Support/DSH /
 * $XDG_CONFIG_HOME/DSH）。外壳不 import 核心的 filemanager，拆包后核心目录可以整个换掉。
 */
const APP_DATA = IS_MAC
  ? join(homedir(), 'Library', 'Application Support')
  : IS_WINDOWS
    ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'))
const APP_DIR = join(APP_DATA, 'DSH')
/** 用户目录里的活动核心（npm 核心更新换的就是这个目录）。 */
const ACTIVE_CORE = join(APP_DIR, 'core', 'current')
/** 上一份核心：新核心起不来时 recoverCore 会把它换回来，成功启动后删掉。 */
const PREVIOUS_CORE = join(APP_DIR, 'core', 'previous')
const { recoverCore, failedCoreVersions } = createCoreRecovery({ appDir: APP_DIR, relaunch: relaunchApp })
/** 源码运行（npm run electron）用仓库自己的核心；安装版不带核心，靠 setupCore 从 npm 取。 */
const SOURCE_CORE = existsSync(join(ROOT, 'src', 'server.js')) ? join(ROOT, 'src') : ''
/** 和 preload.cjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 外壳 → 管理页：退出前的询问（preload.cjs 的 onMessage 收这条）。 */
const SHELL_CHANNEL = 'dsh-x:shell'
/**
 * 各平台均选择页面自绘的窗口按钮，和独立标签窗口保持一致。
 */
const WINDOW_QUERY = '1'
/** 首次出现的窗口尺寸（逻辑像素），和 Rust 外壳一致。 */
const MAIN_WINDOW = { width: 1100, height: 760, minWidth: 720, minHeight: 520 }
const DSH_WINDOW = { width: 1180, height: 820, minWidth: 720, minHeight: 520 }
const ERROR_WINDOW = { width: 560, height: 300, logHeight: 420 }
/** 托盘轮询 /api/tray 的间隔：和 Rust 外壳一致。 */
const TRAY_POLL_MS = 1500
const TRAY_REQUEST_TIMEOUT_MS = 2000
/** 托盘里的启动 / 修复可能很慢，后台等它，不卡菜单。 */
const TRAY_ACTION_TIMEOUT_MS = 120_000
/**
 * 退出前询问「还有实例在运行」等回答的上限：页面卡死时不能把退出永远吊住，
 * 超时按「取消」处理（窗口还留着，用户还能继续用）。
 */
const QUIT_CONFIRM_TIMEOUT_MS = 30_000
/** 菜单栏图标按 18pt（macOS）显示；Linux 托盘用 16px 基图，再补一档 2x。 */
const TRAY_ICON_POINTS = IS_MAC ? 18 : 16
/** 图标目录：源码运行时在仓库的 src/assets；安装包由 pack.mjs 放到 resources/app/assets。 */
const ASSET_DIR = existsSync(join(ROOT, 'src', 'assets')) ? join(ROOT, 'src', 'assets') : join(ROOT, 'assets')
const ICON_FILE = join(ASSET_DIR, 'icon.png')
/**
 * 托盘图标用带圆角/透明边的版本，不用 icon.png——后者是不透明的方形母版，
 * 直接塞进 Windows 托盘会是一个方块。Windows 用 tray.ico，mac/Linux 用 tray.png。
 */
const TRAY_ICON_FILE = IS_WINDOWS ? join(ASSET_DIR, 'tray.ico') : join(ASSET_DIR, 'tray.png')
/** 页面进程崩溃时 Chromium 报的原因：这几种是正常结束，不用重装。 */
const CLEAN_EXITS = new Set(['clean-exit', 'killed'])
/** dsh 页面能申请的权限：只放行本机地址的麦克风 / 摄像头（询问用户），其余一律拒绝。 */
const MEDIA_PERMISSION = 'media'

let server = null
/** 管理页的根地址（http://127.0.0.1:<端口>/）：端口被占时服务会顺延，以 startServer 返回的为准。 */
let managerBase = ''
let mainWindow = null
let tabs = null
let instanceViews = null
let tabDetacher = null
let tabDrag = null
let windowFocusSerial = 0
let tray = null
let trayMenuKey = ''
let state = parseTrayState('')
let quitting = false
/** 正在等管理页回答「还有实例在运行，要退出吗」：{ promise, settle }；没有就是 null。 */
let quitConfirm = null
/** 外壳创建在 start 里，设置再生效也要能改它的通道（见 applyPrefs）。 */
let updater = null
/**
 * 右侧栏浏览器的 guest：一个进程一份，partition 按 workspace 活到进程退出（官方桌面端语义）。
 * owner 是每个 dsh 标签页的 WebContents；所有实例的 origin 都算「DSH 自己」，guest 不能访问。
 */
const browserGuestOwners = new Set()
const browserGuests = new DesktopBrowserGuests(() => {
  const origins = []
  for (const owner of browserGuestOwners) {
    if (owner.isDestroyed()) continue
    try { origins.push(new URL(owner.getURL()).origin) } catch { /* 加载中的页面没有 URL */ }
  }
  return origins
}, {
  // 证书策略与开关都读 settings.json（见 refreshPrefs）：这里给的是取值函数，每次现读，
  // 设置改完 1.5 秒内作用到已有分区，新分区在创建时就用上新值
  ignoreCertificateErrors: () => prefs.browserIgnoreCertificate === true,
})

/**
 * 设置文件（核心写的）与其中的系统开关。外壳直接读它，不经过管理页接口——外壳和核心
 * 分开更新，读同一份文件才不会有协议版本问题（见 prefs.mjs）。
 */
const PREFS_FILE = join(APP_DIR, 'settings.json')
let prefs = readPrefs(PREFS_FILE)
/** settings.json 的 mtime：轮询里只在文件变了才重新读。 */
let prefsStamp = 0

// 硬件加速必须在 app ready 之前决定（Chromium 启动后再关无效）。
// 用户用「关掉硬件加速」规避显卡/驱动导致的白屏、闪退，重启启动器才生效。
if (prefs.hardwareAcceleration === false) app.disableHardwareAcceleration()

/** 外壳版本：源码运行（npm run electron）时 app.getVersion() 是 Electron 的版本，所以自己读 shell/package.json。 */
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version

/** 读一个核心目录的 package.json（拿版本和它声明的 Electron 版本）；读不到返回 null。 */
function corePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 启动哪个核心：CLI 明确指定（DSH_CORE_DIR）→ 源码运行用仓库的 src/ → 用户目录里的 core/current。
 * 安装版不再内置核心：current 不存在或声明的 Electron 和当前外壳对不上时返回空，
 * 由 setupCore 去 npm 取一份（外壳可以很久不更新，核心照发）。
 */
function resolveCoreDir() {
  if (process.env.DSH_CORE_DIR) return process.env.DSH_CORE_DIR
  // 源码运行（npm run electron）用仓库自己的核心，不去碰用户目录里安装版更新的 core/current
  if (!app.isPackaged && process.env.DSH_NPM !== '1') return SOURCE_CORE
  if (!existsSync(join(ACTIVE_CORE, 'server.js'))) return ''
  const pkg = corePackage(ACTIVE_CORE)
  const electron = pkg?.dshX?.electron
  if (electron && String(electron) !== String(process.versions.electron)) {
    console.log(`核心是为 Electron ${electron} 构建的，当前外壳是 ${process.versions.electron}，重新下载`)
    return ''
  }
  return ACTIVE_CORE
}

/** 重启外壳：AppImage 要重启 APPIMAGE 本身，process.execPath 是挂载目录里的临时二进制。 */
function relaunchApp() {
  app.relaunch(shellRelaunchOptions(process.argv.slice(1), process.env))
  app.exit(0)
}

// ---- 设置文件里的系统开关（硬件加速在文件顶部处理，其余在这里实时跟随）----

/**
 * 外壳自己的排障日志。安装版的 Windows 应用没有控制台，console.log 等于扔掉；
 * 生命周期里的异常（窗口被系统销毁、休眠唤醒）只有写进核心那份 manager.log 才查得到。
 * 只写低频事件，不参与核心的日志轮转也不影响运行。
 */
function shellLog(line) {
  try {
    appendFileSync(join(APP_DIR, 'manager.log'), `[${new Date().toISOString()}] [外壳] ${line}\n`)
  } catch { /* 日志写不进去不影响运行 */ }
}

/** 保住系统不进入空闲休眠的 blocker 句柄；null = 没开。 */
let powerBlocker = null

function syncKeepAwake() {
  if (prefs.keepAwake && powerBlocker === null) {
    try { powerBlocker = powerSaveBlocker.start('prevent-app-suspension') } catch { powerBlocker = null }
  } else if (!prefs.keepAwake && powerBlocker !== null) {
    try { powerSaveBlocker.stop(powerBlocker) } catch { /* 已经停了 */ }
    powerBlocker = null
  }
}

/** settings.json 变了才重读：轮询每 1.5s 跑一次，不能每次都解析一遍文件。 */
function refreshPrefs() {
  let stamp
  try { stamp = statSync(PREFS_FILE).mtimeMs } catch { return }
  if (stamp === prefsStamp) return
  prefsStamp = stamp
  const next = readPrefs(PREFS_FILE)
  const changed = Object.keys(next).filter((key) => next[key] !== prefs[key])
  prefs = next
  if (!changed.length) return
  syncKeepAwake()
  if (changed.includes('autoUpdate') && prefs.autoUpdate) void autoUpdateTick()
}

/**
 * 桌面通知（任务失败 / 意外退出 / 更新就绪 / 插件请求）。`taskSwitch` 只管外壳自己的
 * 任务提醒：插件通知不受「任务通知」开关控制（插件装不装、开不开归 dsh 插件页）。
 * notificationSound 关掉只是静音，不影响通知本身。
 *
 * 返回是否真的弹出来了：插件那条路由要把「系统没有通知服务」告诉调用方。
 */
function showNotification({ title, body, silent = !prefs.notificationSound, onClick = null, taskSwitch = true }) {
  if ((taskSwitch && !prefs.taskNotifications) || !Notification.isSupported()) return false
  try {
    // 不传 icon：Windows 会把 icon 画成正文里一大块方图，和系统通知的标题栏图标重复。
    // 应用图标只在通知标题栏出现（由 AUMID / 快捷方式决定），正文留给文字。
    const notification = new Notification({ title, body, silent })
    if (onClick) notification.on('click', onClick)
    notification.show()
    return true
  } catch {
    // 系统没有通知服务（Linux 缺后端等）时安静跳过
    return false
  }
}

/** 外壳自己的任务通知：点一下回到管理页。 */
function notifyUser(title, body) {
  showNotification({ title, body, onClick: () => showManager() })
}

/** 上一条插件通知的时间戳；500ms 内的重复请求直接丢掉（见 shell/desktop.mjs）。 */
let pluginNotifyAt = 0

/**
 * 插件通过 /api/desktop/notify 发来的通知。开关、声音、节流都在这里定：
 * 插件只能把通知关小（silent），不能打开用户关掉的提示音。
 * 返回结构直接拼进 HTTP 响应，不能抛——一条通知失败不该变成插件的 500。
 */
function desktopNotify(payload) {
  const decision = notificationDecision(payload, prefs)
  if (!decision.enabled) return { shown: false, reason: 'disabled' }
  if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' }
  const now = Date.now()
  if (notifyThrottled(pluginNotifyAt, now)) return { shown: false, reason: 'throttled' }
  const url = clickTarget(payload.url)
  const shown = showNotification({
    title: payload.title,
    body: payload.body,
    silent: decision.silent,
    // 插件通知不跟「任务通知」开关走：那个开关只管外壳自己的实例提醒
    taskSwitch: false,
    // 点击通知：有地址就去那个地址（本机地址仍按设置进标签 / 独立窗口），没有就回管理页
    onClick: url ? () => openLink(url) : () => showManager(),
  })
  if (shown) pluginNotifyAt = now
  return shown ? { shown: true } : { shown: false, reason: 'unsupported' }
}

/** GET /api/desktop 里外壳负责的那部分：主题和版本。 */
function desktopInfo() {
  return {
    theme: resolveDark(state.theme, nativeTheme.shouldUseDarkColors) ? 'dark' : 'light',
    versions: { shell: VERSION, electron: String(process.versions.electron || '') },
  }
}

/**
 * 插件的系统对话框。父窗口只在管理页真的可见时挂——窗口藏在托盘后面时，
 * macOS 的 sheet 会挂在一个看不见的窗口上，用户只会觉得「没反应」。
 */
async function desktopDialog(request) {
  const options = dialogOptions(request)
  if (!options) throw new Error('不认识的对话框类型')
  if (request.kind === 'message' && !options.message) throw new Error('对话框要有 message')
  const owner = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null
  if (request.kind === 'open') {
    const result = await (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options))
    return { canceled: result.canceled === true, paths: result.filePaths || [] }
  }
  if (request.kind === 'save') {
    const result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))
    return { canceled: result.canceled === true, path: result.filePath || '' }
  }
  const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
  return { response: result.response }
}

/**
 * 核心（server.js）在实例启动失败 / 意外退出时调过来；文案在这里按界面语言拼。
 *
 * 正常启动不发通知：用户点了「启动」就会看到进度页和窗口，再弹一条「已就绪」只是噪音。
 * 只有失败和意外退出——用户不在看的时候——才值得打断。
 */
function notifyInstance(event) {
  const en = state.lang === 'en'
  const label = event.name || [event.profile, event.version].filter(Boolean).join(' · ') || 'DSH'
  const code = event.code === undefined || event.code === null ? '' : ` (code ${event.code})`
  if (event.kind === 'failed') {
    notifyUser(en ? 'DSH failed to start' : 'DSH 启动失败', en ? `${label} exited during startup${code}.` : `${label} 在启动阶段退出${code}。`)
    return
  }
  if (event.kind === 'exited') {
    notifyUser(en ? 'DSH exited' : 'DSH 已退出', en ? `${label} stopped unexpectedly${code}.` : `${label} 意外退出${code}。`)
  }
}

// ---- 自动更新（只下载） ----
// 两层各自更新：核心走 npm（server.js 的 /api/self/app-download|app-apply），外壳走 electron-updater。
// 自动更新只做下载：安装要重启启动器，这一步留给用户在首页「更新」里手动确认。

const AUTO_UPDATE_INTERVAL_MS = 60 * 1000
/** 同一个版本的下载完成提醒只发一次。 */
const autoUpdateNotified = new Set()
let coreAutoBusy = false
let coreAutoLastAt = 0
let shellAutoDownloading = false

function notifyUpdateReady(version, layer) {
  const key = `${layer}:${version}`
  if (autoUpdateNotified.has(key)) return
  autoUpdateNotified.add(key)
  const en = state.lang === 'en'
  notifyUser(
    en ? 'Update downloaded' : '更新已下载',
    en ? `${version || 'The new version'} is downloaded. Install it from the Update button on the home page.`
      : `${version || '新版本'} 已下载，点首页的「更新」按钮完成安装。`,
  )
}

/** 管理服务的本机请求：自动更新用，超时按下载量给。 */
async function managerRequest(path, { method = 'GET', timeout = 30_000 } = {}) {
  const res = await fetch(`${managerUrl()}${path}`, {
    method,
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ---- 首次启动取核心 ----
// 安装包里不再带核心：第一次启动（或核心和当前 Electron 对不上）就从 npm 取一份，
// 装进用户目录的 core/current。代价是装完第一次启动需要联网——和 npm 版一致；
// 之后核心自己走 npm 更新，外壳可以很久不发版。

/** 下载窗口：这时候还没有管理页，至少把等待和进度说清楚。 */
function showCoreSetupWindow() {
  const window = new BrowserWindow({
    width: 480,
    height: 280,
    resizable: false,
    title: 'DSH-X',
    // 和错误窗口一样：macOS 用 hiddenInset，Windows 用无边框（页面里没有关闭按钮，下载完自己关）
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    backgroundColor: '#15171c',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  // 下载途中被用户关掉就没必要继续：没有窗口的外壳只会留在后台
  const close = { byUser: false }
  window.on('closed', () => { if (!close.byUser) app.exit(1) })
  window.loadURL(dataUrl(coreSetupPage(state.lang)))
  return {
    window,
    finish() {
      close.byUser = true
      if (!window.isDestroyed()) window.destroy()
    },
  }
}

let coreSetupPaintAt = 0
let coreSetupPaintTimer = null
let coreSetupPaintPending = null

/**
 * 首启窗口的进度绘制：按 ~8fps 节流。
 * 以前每个 chunk 都 executeJavaScript 一次，下载快时会堆一长串跨进程调用，窗口看起来反而卡住；
 * 总大小未知时也别把进度条钉在 0%，切成不确定态动画并显示已下载字节数。
 */
function paintCoreSetup(window, next, { immediate = false } = {}) {
  if (!window || window.isDestroyed()) return Promise.resolve()
  coreSetupPaintPending = { window, state: next }
  if (immediate) return flushCoreSetupPaint()
  const wait = Math.max(0, 120 - (Date.now() - coreSetupPaintAt))
  if (wait === 0) return flushCoreSetupPaint()
  if (!coreSetupPaintTimer) coreSetupPaintTimer = setTimeout(flushCoreSetupPaint, wait)
  return Promise.resolve()
}

function flushCoreSetupPaint() {
  coreSetupPaintTimer = null
  const job = coreSetupPaintPending
  coreSetupPaintPending = null
  if (!job || !job.window || job.window.isDestroyed()) return Promise.resolve()
  coreSetupPaintAt = Date.now()
  const en = state.lang === 'en'
  const { phase, done = 0, total = 0, version = '', source = '' } = job.state
  const extracting = phase === 'extract'
  const known = total > 0
  // 解压没有细粒度进度：保持满格，别让进度条看起来从 0 重来
  const percent = extracting ? 100 : known ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
  const mb = (value) => (value / 1048576).toFixed(1)
  const hint = extracting
    ? (en ? 'Installing the runtime core…' : '正在安装运行核心…')
    : phase === 'download'
      ? (en ? `Downloading the runtime core${version ? ` ${version}` : ''}…` : `正在下载运行核心${version ? ` ${version}` : ''}…`)
      : (en ? 'Contacting the download source…' : '正在连接下载源…')
  const detail = phase === 'download'
    ? (known
      ? `${mb(done)} MB / ${mb(total)} MB · ${percent}%`
      : (en ? `Downloaded ${mb(done)} MB` : `已下载 ${mb(done)} MB`))
    : extracting
      ? (en ? 'Download complete, unpacking (a few seconds)…' : '下载完成，正在解压（通常几秒）…')
      : ''
  const sourceText = source ? (en ? `Source: ${source}` : `下载源：${source}`) : ''
  return job.window.webContents.executeJavaScript(coreSetupPaintScript({
    percent,
    indeterminate: !extracting && !known,
    hint,
    detail,
    source: sourceText,
  })).catch(() => { /* 窗口已经关了 */ })
}

function registryHost(registry) {
  try { return new URL(registry).host } catch { return String(registry) }
}

/** 按「镜像 → 官方」逐个问；慢镜像最多等 6 秒，别让首启窗口干等。 */
async function chooseCoreRelease(fetchImpl) {
  const registries = coreRegistries()
  let last = null
  for (const [index, registry] of registries.entries()) {
    try {
      const metadata = await fetchCoreMetadata(corePackageName(), {
        fetchImpl,
        registry,
        timeoutMs: index === 0 ? 6_000 : 30_000,
      })
      const release = pickCoreRelease(metadata, {
        electron: process.versions.electron,
        channel: channelOf(VERSION),
        skip: failedCoreVersions(),
      })
      if (release) return { release, registry }
      last = new Error(`npm 上没有和当前外壳（Electron ${process.versions.electron}）兼容的核心版本`)
    } catch (error) {
      last = error
    }
  }
  throw last || new Error('没有可用的核心下载源')
}

/**
 * 从 npm 取一份和当前 Electron 兼容的核心装进 core/current；返回核心目录，失败返回空。
 * 通道跟着外壳版本走：正式版外壳取正式版核心，rc 外壳取 rc（没有 rc 时退回正式版）。
 */
async function setupCore() {
  const setup = showCoreSetupWindow()
  const shownAt = Date.now()
  // 首启时还没有核心，读不到设置里的下载源/代理；用 Electron 的 net.fetch，至少跟随系统代理
  const fetchImpl = (url, init) => net.fetch(url, init)
  paintCoreSetup(setup.window, { phase: 'connect' })
  try {
    const { release, registry } = await chooseCoreRelease(fetchImpl)
    let currentRegistry = registry
    const paint = (next, options) => paintCoreSetup(setup.window, {
      ...next,
      version: release.version,
      source: registryHost(currentRegistry),
    }, options)
    console.log(`下载核心 ${release.version}（${corePackageName()}，${registryHost(registry)}）`)
    const install = (targetRelease) => installCore({
      release: targetRelease,
      target: ACTIVE_CORE,
      previous: PREVIOUS_CORE,
      fetchImpl,
      // 解压是 spawnSync，会占住主进程；先把「正在安装」同步画上去并留一帧，别让窗口停在 100% 后消失
      onPhase: async (phase) => {
        await paint({ phase }, { immediate: true })
        if (phase === 'extract') await new Promise((resolve) => setTimeout(resolve, 80))
      },
      onProgress: ({ done, total }) => paint({ phase: 'download', done, total }),
    })
    try {
      await install(release)
    } catch (error) {
      // 镜像只同步了元数据、tarball 却拉不动（或反过来）时，换另一个源的重试一次
      const alternate = coreRegistries().find((item) => item !== currentRegistry)
      const tarball = alternate && tarballFor(alternate, corePackageName(), release.version)
      if (!tarball) throw error
      console.warn(`从 ${registryHost(currentRegistry)} 下载核心失败，换 ${registryHost(alternate)} 重试：${error?.message || error}`)
      currentRegistry = alternate
      paint({ phase: 'connect' })
      await install({ ...release, tarball })
    }
    // 和核心更新（server.js 的 app-apply）写同一个「待验证」标记：首启下载的核心起不来时，
    // recoverCore 才知道是哪个版本坏了并跳过它；不写的话会下载 → 起不来 → 删掉 → 再下载同一版地死循环。
    try { writeFileSync(join(APP_DIR, 'core', 'pending'), JSON.stringify({ version: release.version, at: Date.now() })) } catch { /* 写不进去只是少了回退保护 */ }
    console.log(`核心已就绪：${ACTIVE_CORE}（${release.version}，${registryHost(currentRegistry)}）`)
    // 网快时 12 MB 一秒就下完，窗口一闪而过；至少留 1.2 秒把进度和结果展示完
    const remain = 1_200 - (Date.now() - shownAt)
    if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain))
    return ACTIVE_CORE
  } catch (error) {
    setup.finish()
    showStartupError('核心下载失败', '第一次启动需要从 npm 下载运行核心。', `${error?.message || error}\n\n检查网络后重新打开 DSH-X。`)
    return ''
  } finally {
    setup.finish()
  }
}

/** 核心（npm）自动更新：有更新就下（下载不打扰用户）；安装交给用户，不自动替换核心。 */
async function autoUpdateTick() {
  if (!prefs.autoUpdate || !server || quitting || coreAutoBusy) return
  if (!managerBase) return
  if (Date.now() - coreAutoLastAt < AUTO_UPDATE_INTERVAL_MS - 5000) return
  coreAutoLastAt = Date.now()
  coreAutoBusy = true
  try {
    const self = await managerRequest('api/self')
    const target = self.appStaged || (self.app?.available ? self.app.latest : '')
    if (!target) return
    if (!self.appStaged) await managerRequest('api/self/app-download', { method: 'POST', timeout: 180_000 })
    notifyUpdateReady(target, 'core')
  } catch (error) {
    console.log(`自动更新下载失败：${error?.message || error}`)
  } finally {
    coreAutoBusy = false
  }
}

/** 外壳（electron-updater）自动更新：只下载，安装由用户在首页「更新」里确认。下载由 updater 的订阅触发。 */
async function downloadShellUpdate() {
  if (!prefs.autoUpdate || !updater || shellAutoDownloading) return
  shellAutoDownloading = true
  try {
    await updater.download()
  } catch (error) {
    console.log(`外壳自动更新下载失败：${error?.message || error}`)
  } finally {
    shellAutoDownloading = false
  }
}

// 浏览器数据（cookie、站点权限、缓存）放在每用户目录下，和 Rust 外壳的 DSH/webview 并排；
// 不用 Electron 默认的 ~/Library/Application Support/<应用名>——源码运行时那个名字是「Electron」。
// 必须在 ready 和单实例锁之前设：两者都按 userData 定位。
app.setPath('userData', join(APP_DIR, 'electron'))

/** 先占单实例锁：第二次打开只把已有实例的窗口叫出来（对应 Rust 外壳的 find_manager + /api/wake）。 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showManager())
  app.whenReady().then(start).catch((error) => showStartupError('DSH-X 启动失败', '外壳初始化时出错。', error?.stack || String(error)))
}

function managerUrl() {
  return managerBase
}

async function start() {
  // Windows 的任务栏分组 / 通知要用 AppUserModelID；macOS 没有这个概念（bundle id 在 Info.plist 里）
  if (IS_WINDOWS) app.setAppUserModelId('io.github.yyh-001.dsh-x')
  if (IS_MAC) app.setAboutPanelOptions({ applicationName: 'DSH-X', applicationVersion: VERSION })
  // 安装包里没有核心：第一次启动（或核心和当前 Electron 对不上）先下载，再启动管理服务
  let coreDir = resolveCoreDir()
  if (!coreDir) {
    coreDir = await setupCore()
    if (!coreDir) return
  }
  // 核心按「打包态」运行：它不在 resources/app 里，但仍要按安装包路径处理更新和快捷方式。
  // 源码 `npm run electron` 不算打包态（PACKAGED 为 false），否则开发时也会去查 npm 核心更新。
  if (app.isPackaged || process.env.DSH_NPM === '1') process.env.DSH_CORE = '1'
  process.env.DSH_SHELL_VERSION = VERSION
  // 核心的 node/ 包装脚本转调外壳的 Electron 本体
  process.env.DSH_ELECTRON_BIN = process.execPath
  console.log(`DSH-X ${VERSION} · core ${coreDir} (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`)
  // macOS 需要应用菜单提供 ⌘Q / 复制粘贴；Windows 的页面里 Ctrl+C/V 由 Chromium 自己处理，
  // 没有「窗口菜单」这回事，干脆不要菜单栏（Rust 外壳也没有）。
  if (IS_MAC) Menu.setApplicationMenu(appMenu())
  else Menu.setApplicationMenu(null)
  installPermissionHandlers()
  installDownloadHandler()
  installBrowserGuestIpc()
  // 系统深浅色在运行中变了（控制中心切换）：停止页跟着重画（#58）
  nativeTheme.on('updated', () => {
    tabs?.systemThemeChanged()
    instanceViews?.preferences(state.lang, resolveDark(state.theme, nativeTheme.shouldUseDarkColors))
  })
  // 休眠 / 唤醒只记一笔：Windows 笔记本合盖后窗口被系统销毁过一次（#117），
  // 下次再有人报「唤醒后启动器没了」，日志里能直接看出窗口是在挂起前还是唤醒后消失的。
  powerMonitor.on('suspend', () => shellLog('系统挂起'))
  powerMonitor.on('resume', () => {
    shellLog(`系统唤醒；管理页窗口：${!mainWindow ? '不存在' : mainWindow.isDestroyed() ? '已销毁' : '还在'}`)
  })

  // 默认是 Electron 本体（process.execPath）；设置里选了系统 Node 或显式 DSH_RUNTIME_NODE 时可能落空。
  if (!RUNTIME_NODE || (app.isPackaged && !existsSync(RUNTIME_NODE))) {
    showStartupError('找不到运行 dsh 的 node', `这个路径不存在：${RUNTIME_NODE || '（空）'}`, '在启动器设置里改回「启动器自带」，或重新安装一次 DSH-X。')
    return
  }

  // 管理服务直接在本进程里起。端口被占时它自己顺延；被自己的另一个实例占着会抛 EALREADY——
  // 单实例锁已经挡掉了同一个包的第二个实例，走到这里说明是别的副本（源码运行、Windows 版不会
  // 在 macOS 上），那就唤醒它然后安静退出，和 start.js 的处理一致。
  let core
  try {
    core = await import(pathToFileURL(join(coreDir, 'server.js')).href)
  } catch (error) {
    // 核心自身坏到加载不了才恢复；权限/磁盘问题留下原件，修好环境后仍可重试。
    if (recoverCore(coreDir, { error })) return
    showStartupError('启动器核心缺失', '找不到或加载不了核心文件。', `${coreDir}\n${error?.stack || String(error)}`)
    return
  }
  server = core
  try {
    managerBase = `${await server.startServer()}/`
  } catch (error) {
    if (error?.code === 'EALREADY') {
      await fetch(`http://127.0.0.1:${error.port}/api/wake`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) }).catch(() => {})
      app.exit(0)
      return
    }
    // 目录不可写、磁盘满、权限不足这类环境问题不是核心坏：走 recoverCore 会把刚装好的
    // 有效核心删掉并永久拉黑，用户把目录修好也回不来。按普通启动失败报，让用户修环境。
    if (isEnvironmentStartupError(error, coreDir)) {
      showStartupError('dsh 服务启动失败', '管理页没能起来。更像是目录、权限或磁盘的问题，修好后重新打开 DSH-X。', error?.stack || String(error))
      return
    }
    // 环境错误不代表核心坏了；保留 pending，修好目录/权限后仍可验证同一份核心。
    // 其余错误只有刚换上的核心才回退，已经验收过的 current 按普通错误报。
    if (recoverCore(coreDir, { pendingOnly: true, error })) return
    showStartupError('dsh 服务启动失败', '管理页没能起来。', error?.stack || String(error))
    return
  }
  // 核心已经成功启动：新版本通过验收，清掉「待验证」标记和回滚用的上一份
  try { rmSync(join(APP_DIR, 'core', 'pending'), { force: true }) } catch { /* ignore */ }
  try { rmSync(PREVIOUS_CORE, { recursive: true, force: true }) } catch { /* ignore */ }
  updater = createUpdater({
    version: VERSION,
    onBeforeInstall: async () => {
      quitting = true
      await server.shutdown()
    },
  })
  // 预览版通道由 updater 按当前外壳版本自己判断：预发布版继续收预发布，正式版只收正式版
  // 自动更新只下载；下好了提醒一次，安装留在用户在首页「更新」里点
  updater.subscribe((snapshot) => {
    if (!prefs.autoUpdate) return
    if (snapshot.status === 'available') void downloadShellUpdate()
    else if (snapshot.status === 'ready') notifyUpdateReady(snapshot.latest || snapshot.current, 'shell')
  })
  server.setHost({
    onWake: async () => showManager(),
    openTab: (target) => openInternalTab(target),
    openWindow: (url) => openDshWindow(url),
    presentInstance: (target, options) => instanceViews.presentInstance(target, options),
    onStateChanged: () => applyState(parseTrayState(server.trayStateText())),
    exit: (code) => exitApp(code),
    // 核心更新后重启：AppImage 重启 APPIMAGE 本身，其他平台用 app.relaunch()
    relaunch: relaunchApp,
    shellUpdate: {
      state: () => updater.state(),
      check: () => updater.check(),
      download: () => updater.download(),
      install: () => updater.install(),
    },
    onShellUpdateState: (listener) => updater.subscribe(listener),
    // 实例启动完成 / 失败 / 意外退出：核心把事实交给外壳，通知文案和提示音由这里决定
    notify: (event) => notifyInstance(event),
    // 插件桌面 API（/api/desktop/*）：插件跑在 dsh 子进程里，通过核心转到外壳来执行。
    // 这里只做 Electron 动作；请求清洗在核心的 desktop.js，开关 / 节流在 shell/desktop.mjs。
    desktop: {
      info: desktopInfo,
      notify: desktopNotify,
      // 本机地址进标签页 / 独立窗口、外部链接交给系统浏览器：和页面里点链接走同一条路
      open: ({ url }) => openLink(url),
      // 只定位不打开：插件导出文件后「在文件夹中显示」是它最需要的那一步
      reveal: ({ path }) => shell.showItemInFolder(path),
      clipboard: ({ text }) => { clipboard.writeText(text) },
      dialog: desktopDialog,
    },
    // 设置页「浏览器控制」的清理按钮：guest 分区只有外壳碰得到（核心没有 Electron）。
    browser: {
      clearCache: () => clearBrowserData('cache'),
      clearAll: () => clearBrowserData('all'),
    },
  })

  // 启动时也查一次外壳更新（不阻塞窗口）；页面从 /api/self 的 shell 状态和 SSE 拿结果
  void updater.check()
  syncKeepAwake()
  // 自动更新（核心 npm 层）：文件顶部没有实例时会立刻检查/安装；之后每分钟看一眼
  setTimeout(() => void autoUpdateTick(), 15_000)
  setInterval(() => void autoUpdateTick(), AUTO_UPDATE_INTERVAL_MS)

  createMainWindow()
  createTray()
  pollTray()
}

/** 启动失败：在自己的小窗口里把原因说清楚，关掉就退出（不留一个没人管的托盘）。 */
function showStartupError(title, message, detail) {
  const height = String(detail).split('\n').length > 2 ? ERROR_WINDOW.logHeight : ERROR_WINDOW.height
  const window = new BrowserWindow({
    width: ERROR_WINDOW.width, height, resizable: false, title: 'DSH-X',
    // 出错窗口没画窗口按钮：macOS 用 hiddenInset，Windows 保留系统边框（不然关不掉）
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { icon: ICON_FILE }),
    backgroundColor: '#15171c',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  window.on('closed', () => app.exit(1))
  window.loadURL(dataUrl(errorPage(title, message, detail)))
}

function createMainWindow() {
  const window = new BrowserWindow({
    ...MAIN_WINDOW,
    title: 'DSH-X',
    show: false,
    // 各窗口共用 DSH-X 顶栏，平台只保留自己的菜单栏和窗口行为。
    frame: false,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    backgroundColor: '#15171c',
    webPreferences: managerPreferences(),
  })
  mainWindow = window
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  window.on('close', (event) => {
    // 关窗口不退出：托盘还在、dsh 照常跑，需要时从托盘或程序坞再叫回来。
    // 设置里关掉「关闭窗口时隐藏到托盘」、或者托盘根本没建起来时，关窗口就是真退出。
    if (quitting) return
    event.preventDefault()
    if (prefs.closeToTray && tray) window.hide()
    else void quit()
  })
  window.on('resize', () => tabs?.layout())
  window.on('focus', () => { if (tabs) tabs.focusOrder = ++windowFocusSerial; syncTabDetachMenu() })
  window.on('blur', syncTabDetachMenu)
  // 窗口被系统销毁、而不是「关闭到托盘」：Windows 休眠唤醒后见过（#117）。
  // 这里只清引用，托盘 / 二次启动再叫窗口时由 showManager 重建；
  // 已销毁的原生对象连 getter 都会抛，绝不能让主进程带着它继续跑。
  window.on('closed', () => {
    if (mainWindow !== window) return
    shellLog(`管理页窗口已销毁${quitting ? '（正在退出）' : ''}，下次唤出时重建`)
    const host = tabs
    mainWindow = null
    tabs = null
    tabDetacher = null
    instanceViews?.dropHost(host)
  })
  guardManager(window.webContents)
  const host = new BrowserTabs(window, {
    retire: (record) => instanceViews.retire(record),
    dispose: (id) => instanceViews.disposeView(id),
    reveal: (options) => revealWindow(window, MAIN_WINDOW, options),
    systemDark: () => nativeTheme.shouldUseDarkColors,
    detach: () => ({ supported: canMigrateTabs(), drag: canDragTabs(), merge: canMigrateTabs(), deferred: canDragTabs() }),
    reducedMotion: () => prefs.reduceMotion,
    changed: syncTabDetachMenu,
  })
  tabs = host
  // 登记器只建一次：窗口重建时独立窗口里的视图还归它管，不能换一份新的把它们丢掉。
  instanceViews ??= new InstanceViews({
    canTransfer: canMigrateTabs,
    createView: createTabView,
    createHost: (kind) => kind === 'internal' ? tabs : createDshWindow(),
    bootUrl: (target) => {
      if (!target.home || !target.profile || !target.version) return ''
      const params = new URLSearchParams({ home: target.home, profile: target.profile, version: target.home.startsWith('wsl://') ? 'auto' : target.version, name: target.title })
      return `${managerUrl()}booting?${params}`
    },
  })
  tabDetacher = createTabDetacher(host)
  host.detacher = tabDetacher
  guardTabDrag(host)
  window.loadURL(managerPageUrl())
}

/**
 * 管理页地址：带一次性 launch token，跳转一次后 cookie 接管，地址栏回到干净的 `?window=`。
 * 老核心没有这个导出时退回不带 token 的地址（老核心也不校验），两边版本可以各自升级。
 */
function managerPageUrl() {
  const authenticated = server?.managerUrlWithToken?.({ window: WINDOW_QUERY })
  return authenticated || `${managerUrl()}?window=${WINDOW_QUERY}`
}

// 宿主来自统一页面登记器，不再维护另一份窗口/页面对应表。
function tabHosts() {
  return [...new Set([tabs, tabDrag?.host, ...[...(instanceViews?.views.values() || [])].map((record) => record.host)])]
    .filter((host) => host && !host.window.isDestroyed())
}

function createTabDetacher(host) {
  return new TabDetacher(instanceViews, host, {
    quitting: () => quitting,
    dragSupported: canDragTabs,
    migrationSupported: canMigrateTabs,
    dropTarget: () => tabDropTarget(screen.getCursorScreenPoint(), host, tabHosts()),
    createHost: (source) => {
      if (source !== 'drag') return createDshWindow()
      const point = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(point)
      return createDshWindow(detachedBounds(point, display.workArea, DSH_WINDOW))
    },
    // 错误正文可能带导航地址，日志只保留错误类型；用户侧统一显示可重试提示。
    failed: (error, request) => {
      console.warn('标签移到新窗口失败：', error?.name || 'Error')
      // 旧核心不认识结果回执；外壳原生入口的失败由原生对话框显示。
      if ((request === null || host.chromeFallback) && !host.window.isDestroyed()) void dialog.showMessageBox(host.window, {
        type: 'error', message: state.lang === 'en' ? 'Could not move the tab. Please try again.' : '无法移到新窗口，请重试。',
      })
    },
  })
}

function canDragTabs() {
  return tabDragSupported(process.platform, app.commandLine.getSwitchValue('ozone-platform'), process.versions.electron)
}

function canMigrateTabs() {
  return tabMigrationSupported(process.platform, process.versions.electron)
}

function syncTabDetachMenu() {
  const item = Menu.getApplicationMenu()?.getMenuItemById('detach-tab')
  if (!item) return
  item.label = state.lang === 'en' ? 'Move Tab to New Window' : '移到新窗口'
  const host = tabHosts().find((host) => host.window.isFocused())
  item.enabled = !!host?.detacher?.canCreateWindow(host.selected)
}

function showTabMenu({ id, request = null }, activeLabel = false, host = tabs) {
  if (!host?.detacher?.available(id)) {
    if (host && request !== null) {
      host.detachResult = { id, request, status: 'cancelled' }
      host.render(false)
    }
    return
  }
  let chosen = false
  const en = state.lang === 'en'
  const move = (destination) => {
    chosen = true
    host.detacher.detach({ id, request, source: 'menu', destination })
  }
  const destinations = tabHosts().filter((target) => target !== host)
  Menu.buildFromTemplate([{
    label: activeLabel ? (en ? 'Move Active Tab to New Window' : '将当前标签移到新窗口') : (en ? 'Move to New Window' : '移到新窗口'),
    enabled: host.detacher.canCreateWindow(id),
    click: () => move(),
  }, ...destinations.map((destination) => ({
    label: destination === tabs ? (en ? 'Move to Launcher Window' : '移到启动器窗口')
      : `${en ? 'Move to' : '移到'} ${destination.window.getTitle()}`,
    click: () => move(destination),
  }))]).popup({ window: host.window, callback: () => {
    if (chosen || request === null) return
    host.detachResult = { id, request, status: 'cancelled' }
    host.render(false)
  } })
}

/** 轻量标题卡不进入页面登记器，不抢焦点，也不挡住投放目标。 */
function createTabPreview(title) {
  const window = new BrowserWindow({ width: 240, height: 64, show: false, frame: false, resizable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.setIgnoreMouseEvents(true)
  let ready = false, visible = false
  window.once('ready-to-show', () => { ready = true; if (visible && !window.isDestroyed()) window.showInactive() })
  window.loadURL(dataUrl(tabDragPreviewPage(title, resolveDark(state.theme, nativeTheme.shouldUseDarkColors), state.lang === 'en'))).catch(() => {})
  return {
    update(point, show) {
      if (window.isDestroyed()) return
      visible = show
      if (!show) { window.hide(); return }
      window.setPosition(Math.round(point.x + 16), Math.round(point.y + 20), false)
      if (ready && !window.isVisible()) window.showInactive()
    },
    destroy() { visible = false; if (!window.isDestroyed()) window.destroy() },
  }
}

function stopTabDrag(cancel = true, action = {}) {
  if (!tabDrag) return
  const ended = tabDrag
  tabDrag = null
  clearInterval(ended.timer)
  ended.feedback.clear()
  ended.preview?.destroy()
  if (cancel && !ended.host.manager.isDestroyed()) {
    ended.host.manager.executeJavaScript('window.cancelTabDrag?.()').catch(() => {})
  }
  let destination
  let status = 'cancelled'
  try {
    if (cancel || !ended.session.valid()) return
    const { host, point, drop, outside, session, token } = ended
    if (drop) {
      if (!session.drop(drop.host, token, drop.index)) throw new Error('目标窗口不可用')
    } else if (outside) {
      const record = session.session.record
      // 单标签普通窗口不另开外壳；整段拖动保持原窗口不动，松手才应用最终位置。
      const reusable = host.kind === 'window' && host.tabs.length === 1 && !host.retired.length
        && !host.window.isMaximized() && !host.window.isFullScreen()
      if (reusable) {
        const before = host.window.getBounds()
        try {
          host.window.setBounds(draggedBounds(point, ended.size, ended.offset), false)
          host.reveal(record, { preserveBounds: true })
        } catch (error) { host.window.setBounds(before, false); throw error }
      } else {
        destination = createDshWindow(detachedBounds(point, screen.getDisplayNearestPoint(point).workArea, ended.size))
        if (!session.drop(destination, token, 0, { newWindow: true })) throw new Error('目标窗口不可用')
      }
    } else if (action.order) {
      host.action({ action: 'reorder', ids: action.order, request: action.request })
    }
    status = 'success'
  } catch {
    status = 'error'
    destination?.disposeEmpty?.()
    console.warn('标签拖动结束失败')
    if (!ended.host.window.isDestroyed()) ended.host.manager.executeJavaScript(`window.notifyError?.(new Error(${JSON.stringify(state.lang === 'en' ? 'Could not move the tab. Please try again.' : '无法移动标签，请重试。')}))`).catch(() => {})
  } finally {
    // 旧核心使用 detach-tab 的请求回执解锁菜单；兼容路径也必须结束 pendingDetach。
    if (action.action === 'detach-tab' && !ended.host.window.isDestroyed()) {
      ended.host.detachResult = { id: ended.id, request: action.request, status }
      ended.host.render(false)
    }
    ended.session.clear()
  }
}

/** 隐藏窗口不保证 DOM 发 cancel/lost；两端主动收尾，show 再释放一次隐藏期间的捕获。 */
function guardTabDrag(host) {
  const cancel = () => {
    if (tabDrag?.host === host) stopTabDrag()
    if (!host.manager.isDestroyed()) host.manager.executeJavaScript('window.cancelTabDrag?.()').catch(() => {})
  }
  for (const name of ['close', 'hide', 'minimize', 'closed', 'show']) host.window.on(name, cancel)
  for (const name of ['render-process-gone', 'destroyed', 'did-start-navigation']) host.manager.on(name, cancel)
}

function startTabDrag(host, id, deferred = false, grab, initialPoint) {
  stopTabDrag()
  if (!canDragTabs() || !host.detacher.available(id)) return
  const session = new TabDragSession(instanceViews, { quitting: () => quitting })
  const feedback = new TabDragFeedback((target, value) => {
    if (!target.window.isDestroyed() && !target.manager.isDestroyed()) {
      target.manager.executeJavaScript(`window.updateTabDrop?.(${JSON.stringify(value)})`).catch(() => {})
    }
  })
  const update = (localPoint) => {
    const current = tabDrag
    if (!current || current.host !== host) return
    if (host.window.isDestroyed() || !host.window.isVisible() || quitting) return stopTabDrag()
    try {
      if (!session.valid()) return stopTabDrag()
      const content = host.window.getContentBounds(), zoom = host.manager.getZoomFactor()
      const point = localPoint ? { x: content.x + localPoint.x * zoom, y: content.y + localPoint.y * zoom }
        : screen.getCursorScreenPoint()
      current.point = point
      current.drop = tabDropTarget(point, host, tabHosts(), id)
      current.outside = outsideTabStrip(point, host, current.outside)
      feedback.update(host, current.drop)
      const show = current.outside && !current.drop
      if (show && !current.preview) current.preview = createTabPreview(session.session.record.target.title)
      current.preview?.update(point, show)
    } catch {
      stopTabDrag()
      if (!host.window.isDestroyed()) host.manager.executeJavaScript(`window.notifyError?.(new Error(${JSON.stringify(state.lang === 'en' ? 'Could not move the tab. Please try again.' : '无法移动标签，请重试。')}))`).catch(() => {})
    }
  }
  const sourceBounds = host.window.getBounds()
  const sourceContent = host.window.getContentBounds()
  const sourceZoom = host.manager.getZoomFactor()
  const startPoint = initialPoint ? { x: sourceContent.x + initialPoint.x * sourceZoom, y: sourceContent.y + initialPoint.y * sourceZoom }
    : screen.getCursorScreenPoint()
  const sourceTab = host.stripLayout?.tabs.find((tab) => tab.id === id)
  if (!grab) {
    // 兼容已加载的旧顶栏：没有按下坐标时，从当前标签和原生鼠标位置推导，不回退到窗口中心。
    const rect = host.stripLayout?.rect || { top: 0, bottom: 44 }
    const width = Math.max(1, (sourceTab?.right ?? sourceBounds.width / sourceZoom) - (sourceTab?.left ?? 0))
    const height = Math.max(1, (sourceTab?.bottom ?? rect.bottom) - (sourceTab?.top ?? rect.top))
    const clientX = (startPoint.x - sourceContent.x) / sourceZoom, clientY = (startPoint.y - sourceContent.y) / sourceZoom
    grab = { x: Math.max(0, Math.min(width, clientX - (sourceTab?.left ?? 0))),
      y: Math.max(0, Math.min(height, clientY - (sourceTab?.top ?? rect.top))), width, height, clientX, clientY }
  }
  const sourceOffset = { x: sourceContent.x - sourceBounds.x + grab.clientX * sourceZoom,
    y: sourceContent.y - sourceBounds.y + grab.clientY * sourceZoom }
  const normal = host.window.isMaximized() || host.window.isFullScreen() ? host.window.getNormalBounds() : sourceBounds
  const size = { width: normal.width, height: normal.height }
  const token = session.begin(host, id)
  if (!token) return
  // 新顶栏按显示帧发源页面坐标，不常驻轮询；旧核心仍以低频原生坐标兼容。
  tabDrag = { host, id, deferred, feedback, session, token, update, size, offset: sourceOffset,
    timer: deferred ? null : setInterval(update, 40) }
  // deferred 的首次 move 可能在绘制前被后续点覆盖；只消费与顶栏实际判定相同的帧/松手采样。
  if (!deferred) update(initialPoint)
}

/** 管理页的预加载；实例占位页的窄化桥由 remotePreferences 那份预加载提供。 */
function managerPreferences() {
  return { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
}

/**
 * 远端 dsh 页面：只装右侧栏浏览器的预加载。webviewTag 也只在 dsh 标签页开——
 * 每次 attach 都要主进程核对一次性租约，页面自己伪造一个 webview 会被拒绝（见 browser-guests.mjs）。
 */
function remotePreferences() {
  return {
    preload: BROWSER_PRELOAD,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: true,
  }
}

/**
 * 管理页的链接与导航：只放行管理页自己。外部链接（Star、运行地址、更新日志）交给分派——
 * 选了内部标签 / 桌面窗口时，「运行地址」要进外壳而不是浏览器。就地导航会把窗口导走、
 * 连红绿灯旁边的顶栏一起弄丢，所以一律拦下。
 */
function guardManager(contents, getHost = () => tabs) {
  // 旧核心没有菜单按钮：在顶栏右键仍能移动当前标签；新核心会 preventDefault 并传准确 id。
  contents.on('context-menu', (_event, params) => {
    const host = getHost()
    if (params.y < host?.headerHeight && !params.isEditable) showTabMenu({ id: host.selected }, true, host)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const host = getHost()
    if (host?.kind === 'window' ? url === host.chromeUrl : url.startsWith(managerUrl())) return
    event.preventDefault()
    if (isWebUrl(url)) openLink(url)
  })
  contents.on('before-input-event', (event, input) => {
    // ⌘W / ⌃Tab 在显示标签条时归标签页（和 Rust 外壳注入的 keydown 脚本同一组快捷键）
    const host = getHost()
    if (tabDrag && input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); stopTabDrag(); return }
    if (!host?.active) return
    const action = shortcutAction(input, false)
    if (action) {
      event.preventDefault()
      host.action({ action })
    }
  })
  contents.on('render-process-gone', (_event, details) => {
    if (!CLEAN_EXITS.has(details.reason)) contents.reload()
  })
}

/**
 * 标签页 / 管理页的快捷键 → 标签操作。在主进程的 before-input-event 里判，不往远端页面注入脚本：
 * 远端页面不该能伪造这些操作，也不该因为我们的脚本吞掉它自己的按键。
 * ⌘R 只在标签页里接管（管理页的 ⌘R 由应用菜单的 Reload 处理）。
 */
function shortcutAction(input, inTab) {
  if (input.type !== 'keyDown' || !(input.meta || input.control)) return null
  const key = input.key.toLowerCase()
  if (key === 'tab') return input.shift ? 'previous' : 'next'
  if (key === 'w') return 'close-active'
  if (key === 'r' && inTab) return 'reload'
  return null
}

function createTabView(id) {
  const view = new WebContentsView({ webPreferences: remotePreferences() })
  const contents = view.webContents
  // 右侧栏浏览器：这块 WebContents 是 guest 的唯一 owner，页面销毁时租约自己释放。
  browserGuests.bind(contents)
  browserGuestOwners.add(contents)
  contents.on('destroyed', () => {
    browserGuestOwners.delete(contents)
    instanceViews?.disposeView(id)
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (!instanceViews.link(id, url)) openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    // 本机地址（dsh 自己、它的插件页）和页面自己的东西都放行；只有真正的外部网页交给系统浏览器
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  contents.on('page-title-updated', (_event, title) => instanceViews.title(id, title))
  // 页面画完再采一次底色：present 那次可能还停在加载屏上（采到的是加载页的颜色），
  // 采完选中的标签才和它下面那块页面同色。
  contents.on('did-stop-loading', () => {
    const record = instanceViews.views.get(id)
    record?.host?.resample(record.target.id)
  })
  contents.on('before-input-event', (event, input) => {
    if (tabDrag && input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); stopTabDrag(); return }
    const action = shortcutAction(input, true)
    if (action) {
      event.preventDefault()
      const record = instanceViews.views.get(id)
      if (!record || record.pendingClose) return
      record.host.action({ action })
    }
  })
  // 页面进程崩了只恢复这一页，登记器沿用当前实例的认证地址。
  contents.on('render-process-gone', (_event, details) => {
    // 崩溃恢复会重新导航；先结束这一页的手势，不能让旧捕获在恢复后继续提交。
    // 按 viewId 而不是宿主匹配，不直接取消其他页会话；恢复造成真实失焦仍由顶栏安全取消。
    if (tabDrag?.session.session?.record.viewId === id) stopTabDrag()
    if (!CLEAN_EXITS.has(details.reason)) instanceViews.recover(id)
  })
  return view
}

/** 管理页和本地页发来的消息（window.ipc.postMessage）。按发送方分派，别的 webContents 发的一律不认。 */
ipcMain.on(IPC_CHANNEL, (event, message) => {
  if (typeof message !== 'string' || message.length > 64 * 1024) return
  // 移空源窗口和退出时仍可能收到已排队的呈现回执；销毁后的原生对象连 getter 也会抛错。
  if (quitting || event.sender.isDestroyed() || !event.senderFrame) return
  const manager = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (managerTabSender(event, manager, managerUrl())) return handleManagerMessage(message)
  const host = tabHosts().find((host) => host !== tabs && host.manager === event.sender
    && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === host.chromeUrl)
  if (host) return handleTabMessage(host, message)
  const record = instanceViews?.localSender(event)
  if (record) return handleIdleMessage(record, message)
})

function handleManagerMessage(message) {
  // 退出前确认框的回答（JSON）：和标签页操作共用这条通道，靠 action 区分
  if (message.startsWith('{')) {
    let value = null
    try { value = JSON.parse(message) } catch { /* 不是 JSON 就按原来的短命令走 */ }
    if (value?.action === 'quit-confirm') {
      settleQuitConfirm(value.ok === true)
      return
    }
  }
  switch (message) {
    // 三个平台的自绘窗口按钮共用原生窗口操作。
    case 'minimize': mainWindow.minimize(); return
    case 'maximize': toggleMaximize(mainWindow); return
    // 走 close() 让窗口的 close 处理决定「隐藏到托盘还是退出」（Windows 的自绘关闭按钮也走这里）
    case 'close': mainWindow.close(); return
    // 拖窗口走 CSS 的 -webkit-app-region（public/launcher.css 的 .electron-window header）：Chromium 没有
    // 「从页面里发起一次系统拖动」的接口，页面在 mousedown 时发的 drag 这里无事可做
    case 'drag': return
    default: return handleTabMessage(tabs, message)
  }
}

function handleTabMessage(host, message) {
  switch (message) {
    case 'minimize': host.window.minimize(); return
    case 'maximize': toggleMaximize(host.window); return
    case 'close': host.window.close(); return
    case 'manager': showManager(); return
    case 'internal-tabs-ready':
      if (tabDrag?.host === host) stopTabDrag()
      host.detacher.lastRequest = -1
      host.detachResult = null
      host.render(true)
      return
  }
  const action = parseTabAction(message)
  if (action?.action === 'tab-drag') {
    if (action.active) startTabDrag(host, action.id, action.deferred === true, action.grab, action.point)
    else if (tabDrag?.host === host && tabDrag.id === action.id) {
      // 旧非实时顶栏只有 detach-tab 表示肯定松手；普通 end 也可能是 Escape。
      if (!tabDrag.deferred && !action.live) { stopTabDrag(); return }
      if (action.cancel !== true) tabDrag.update(action.point)
      stopTabDrag(action.cancel === true, action)
    }
  } else if (action?.action === 'tab-drag-move') {
    if (tabDrag?.host === host && tabDrag.id === action.id) tabDrag.update(action.point)
  } else if (action?.action === 'detach-tab') {
    if (action.source === 'drag' && tabDrag?.host === host && tabDrag.id === action.id) {
      tabDrag.update()
      stopTabDrag(false, action)
    } else { host.detacher.detach(action); stopTabDrag() }
  } else if (action?.action === 'tab-menu') showTabMenu(action, false, host)
  else if (action) {
    if (tabDrag?.host === host && (action.action === 'overlay' && action.open
      || action.action === 'close-tab' && action.id === tabDrag.id)) stopTabDrag()
    host.action(action)
  }
}

function toggleMaximize(window) {
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
}

/**
 * 把窗口叫到前面。两步都不能省：最小化的窗口直接 show() 会停在最小化状态；摆位跑出屏幕时
 * show() 只是把它显示在屏幕外，用户看到的就是"点了没反应"（判断见 model.mjs 的 recenterBounds）。
 */
function revealWindow(window, size, { preserveBounds = false } = {}) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  // 松手后的拖动窗口已由用户定位；不能再把屏幕边缘的落点当成丢失窗口而居中。
  const bounds = preserveBounds ? null : recenterBounds(window.getBounds(), screen.getAllDisplays(), screen.getPrimaryDisplay(), size)
  if (bounds) window.setBounds(bounds)
  window.focus()
}

function showManager() {
  // 管理页窗口被系统销毁过（休眠唤醒，#117）：重建一个再交给 ready-to-show，
  // 不能对着已销毁的对象走 select / 摆位。
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 核心还没起来时不提前建窗口：start() 走到最后会自己建。
    if (managerBase) createMainWindow()
    return
  }
  tabs?.action({ action: 'select', id: '' })
  revealWindow(mainWindow, MAIN_WINDOW)
}

/** 内部标签页：复用主窗口。主窗口不在（极少见）就退回系统浏览器，至少还能访问已经起来的实例。 */
function openInternalTab(target) {
  // 窗口被销毁后重建：标签页要挂到新的管理页窗口上，不能退回系统浏览器。
  if (!mainWindow || mainWindow.isDestroyed()) showManager()
  if (!mainWindow || mainWindow.isDestroyed() || !tabs?.alive) {
    shell.openExternal(target.url)
    return
  }
  instanceViews.presentInstance(target, { presentation: 'internal', explicit: true })
}

/**
 * 页面里点出来的链接：管理页自己 → 叫回管理页；属于某个 dsh 实例 → 按打开方式进标签 / 独立窗口；
 * 其余 http(s) 交给系统浏览器。data:/blob: 不是能给系统打开的地址，宁可不理。
 */
function openLink(url) {
  try {
    if (sameOrigin(url, managerUrl())) {
      showManager()
      return
    }
    const own = state.instances.find((target) => target.url && sameOrigin(url, target.url))
    if (internalMode(state) && own) {
      openInternalTab(own)
      return
    }
    if (windowMode(state) && own) {
      // 本机链接可能没有 token，使用这个实例自己的完整认证地址
      openDshWindow(own.url)
      return
    }
    if (isWebUrl(url)) shell.openExternal(url)
  } catch (error) {
    // 链接/弹窗入口没有 HTTP 响应接收错误；迁移被拒绝时提示原因，仍由调用方拦下导航。
    dialog.showErrorBox(state.lang === 'en' ? 'Could not open page' : '无法打开页面', error.message)
  }
}

/** 旧核心的 URL 入口：识别已有身份后与新协议共用登记器。 */
function openDshWindow(url) {
  instanceViews.presentInstance(legacyWindowTarget(url, managerUrl(), state.instances), { presentation: 'window', explicit: true })
}

function createDshWindow(bounds) {
  const window = new BrowserWindow({
    ...DSH_WINDOW,
    ...(bounds ? { ...bounds, minWidth: Math.min(DSH_WINDOW.minWidth, bounds.width), minHeight: Math.min(DSH_WINDOW.minHeight, bounds.height) } : {}),
    title: 'DSH',
    show: false,
    frame: false,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    backgroundColor: tabBaseColor(resolveDark(state.theme, nativeTheme.shouldUseDarkColors)),
    // 这张本地顶栏只得到窗口/标签命令，DSH 内容仍只在原可迁移视图里。
    webPreferences: managerPreferences(),
  })
  const host = new InstanceWindow(window, {
    quitting: () => quitting,
    dispose: (id) => instanceViews.disposeView(id),
    retire: (record) => instanceViews.retire(record),
    reveal: (target, options) => revealWindow(target, DSH_WINDOW, options),
    titles: syncInstanceTitles,
    changed: syncTabDetachMenu,
    systemDark: () => nativeTheme.shouldUseDarkColors,
    detach: () => ({ supported: canMigrateTabs(), drag: canDragTabs(), merge: canMigrateTabs(), deferred: canDragTabs() }),
    reducedMotion: () => prefs.reduceMotion,
    hidden: () => {
      if (!tray && !tabHosts().some((item) => item.window.isVisible())) showManager()
    },
  })
  host.detacher = createTabDetacher(host)
  guardTabDrag(host)
  host.fade = new WindowFade(host, { enabled: () => {
    const animation = systemPreferences.getAnimationSettings()
    return !prefs.reduceMotion && !animation.prefersReducedMotion && animation.shouldRenderRichAnimation && !quitting
  } })
  host.chromeUrl = `${managerUrl()}tab-window.html`
  host.preferences(true, state.lang, state.theme)
  window.on('focus', () => { host.focusOrder = ++windowFocusSerial; syncTabDetachMenu() })
  window.on('blur', syncTabDetachMenu)
  guardManager(window.webContents, () => host)
  const fallback = () => {
    if (window.isDestroyed() || host.chromeUrl.startsWith('data:')) return
    host.chromeUrl = dataUrl(tabWindowFallbackPage())
    host.chromeFallback = true
    window.loadURL(host.chromeUrl).catch(() => {})
  }
  window.webContents.on('did-navigate', (_event, url, status) => { if (url === host.chromeUrl && status >= 400) fallback() })
  window.loadURL(host.chromeUrl).catch(fallback)
  return host
}

function syncInstanceTitles() {
  const records = [...instanceViews.targets.values()].filter((record) => record.host?.kind === 'window')
  for (const record of records) {
    if (record.host.selected !== record.target.id) continue
    const duplicates = records.some((other) => other !== record && other.target.title === record.target.title)
    const title = instanceWindowTitle(record, duplicates)
    // 旧核心没有目录显示名时加窗口序号，避免系统窗口菜单里出现完全相同的标题。
    const suffix = duplicates && !record.target.homeName ? ` · ${record.viewId.split('-').at(-1)}` : ''
    record.host.window.setTitle(title + suffix)
  }
}

function handleIdleMessage(record, message) {
  if (message === 'manager') {
    showManager()
    return
  }
  if (message !== 'launch') return
  const row = launchForView(record, state.launches)
  const request = row && launchActionRequest(row, 'start')
  if (request) void trayAction(request)
  // 入口已被删除或改指其他实例时，不能误启动另一项。
  else showManager()
}

/**
 * 应用菜单。没有它 ⌘Q / ⌘C / ⌘V 不灵。「退出」不用系统预设项：那会绕过管理服务的收尾
 * （停 dsh、通知页面），所以换成自己的项、走和托盘同一条路。⌘W 只是把窗口藏起来。
 */
function appMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'DSH-X',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit DSH-X', accelerator: 'Command+Q', click: () => quit() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'togglefullscreen' },
        { id: 'detach-tab', label: '移到新窗口', enabled: false,
          click: (_item, window) => {
            const host = tabHosts().find((host) => host.window === window)
            if (host?.detacher.canCreateWindow(host.selected)) host.detacher.detach({ id: host.selected })
          } },
        { label: 'Close Window', accelerator: 'Command+W', click: (_item, window) => closeWindow(window) },
      ],
    },
  ])
}

/**
 * ⌘W：标签条显示时由管理页 / 标签页的 before-input-event 先接住（关标签）；
 * 走到菜单这里说明没有标签可关，就把当前窗口藏起来。
 * 主窗口走 close()，让 createMainWindow 的 close 处理统一决定「隐藏还是退出」（关掉托盘开关时是退出）。
 */
function closeWindow(window) {
  if (!window) return
  window.close()
}

/**
 * 托盘图标：Windows 直接把多尺寸 ICO 交给 Electron——它按 GetSystemMetrics(SM_CXSMICON)
 * 从 ICO 里取当前 DPI 对应的那一帧（100% → 16、125% → 20、150% → 24、200% → 32）。
 * 先 resize 成 16 会把这些帧全丢掉，系统再把 16 放大到 20/24，托盘就糊了。
 * mac/Linux 用 tray.png 生成 1x + 2x 两档：Retina 菜单栏按 2x 取图，只给 1x 会被拉大。
 */
function trayImage() {
  const source = nativeImage.createFromPath(TRAY_ICON_FILE)
  if (IS_WINDOWS) return source
  const image = source.resize({ width: TRAY_ICON_POINTS, height: TRAY_ICON_POINTS, quality: 'best' })
  image.addRepresentation({
    scaleFactor: 2,
    width: TRAY_ICON_POINTS * 2,
    height: TRAY_ICON_POINTS * 2,
    buffer: source.resize({ width: TRAY_ICON_POINTS * 2, height: TRAY_ICON_POINTS * 2, quality: 'best' }).toPNG(),
  })
  return image
}

function createTray() {
  const image = trayImage()
  // Linux 缺 appindicator / 桌面环境没有托盘时 Tray 会抛：别让整个外壳起不来，
  // 记成没有托盘（关窗口就真退出，见 createMainWindow 的 close）
  try {
    tray = new Tray(image)
  } catch (error) {
    tray = null
    console.log(`系统托盘不可用，关窗口将直接退出：${error?.message || error}`)
    return
  }
  tray.setToolTip('DSH-X')
  // Windows 托盘点左键叫回管理页（右键才是菜单）；macOS 点菜单栏图标默认弹菜单，不抢。
  if (IS_WINDOWS) tray.on('click', () => showManager())
  syncTrayMenu()
}

/** 菜单只在内容变化时重建，轮询不会把用户正展开的子菜单拆掉。 */
function syncTrayMenu() {
  if (!tray) return
  const en = state.lang === 'en'
  const key = JSON.stringify([en, state.launches.map((row) => [row.id, launchLabel(row, en), LAUNCH_ACTIONS.map(({ action }) => launchActionEnabled(row, action))])])
  if (key === trayMenuKey) return
  trayMenuKey = key
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: en ? 'Open DSH-X' : '打开启动器', click: () => showManager() },
    { type: 'separator' },
    ...state.launches.map((row) => ({
      label: launchLabel(row, en),
      submenu: LAUNCH_ACTIONS.map(({ action, zh, en: english }) => ({
        label: en ? english : zh,
        enabled: launchActionEnabled(row, action),
        click: () => {
          const body = launchActionRequest(row, action)
          if (body) trayAction(body)
        },
      })),
    })),
    { type: 'separator' },
    { label: en ? 'Quit' : '退出', click: () => quit() },
  ]))
}

/** 每隔一会儿取一次状态：托盘文案、标签页、独立窗口都跟着它走。 */
async function pollTray() {
  // 设置页改完就落盘：文件变了才重读，硬件加速之外的开关都实时生效
  refreshPrefs()
  try {
    // 核心就在本进程里：优先直接取，省掉每 1.5s 一次的本机 HTTP + JSON 解析。
    // 旧核心没有这个导出时退回原接口，核心仍然可以独立于外壳更新。
    const text = typeof server?.trayStateText === 'function'
      ? server.trayStateText()
      : await (await fetch(`${managerUrl()}api/tray`, { signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) })).text()
    applyState(parseTrayState(text))
  } catch { /* 下一轮再问 */ }
  if (!quitting) setTimeout(pollTray, TRAY_POLL_MS)
}

function applyState(next) {
  state = next
  syncTrayMenu()
  instanceViews?.preferences(state.lang, resolveDark(state.theme, nativeTheme.shouldUseDarkColors))
  instanceViews?.follow(state.instances, state.launches)
  tabs?.preferences(internalMode(state), state.lang, state.theme)
  for (const host of tabHosts()) if (host !== tabs) host.preferences(true, state.lang, state.theme)
}

/** 托盘的启动项操作：后台请求，失败就把管理页叫出来、用页面自己的提示说明原因。 */
async function trayAction(body) {
  const en = state.lang === 'en'
  let error = ''
  try {
    const res = await fetch(`${managerUrl()}api/tray/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TRAY_ACTION_TIMEOUT_MS),
    })
    if (!res.ok) error = (await res.json().catch(() => ({}))).error || (en ? 'Tray action failed. Check the logs.' : '托盘操作失败，请查看日志')
  } catch {
    error = en ? 'Unable to reach DSH-X. Check the logs.' : '无法连接启动器，请查看日志'
  }
  if (!error) return
  showManager()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.executeJavaScript(`notify(${JSON.stringify(error)})`).catch(() => {})
}

/**
 * 权限：dsh 的语音输入要麦克风。只放行本机地址的 media 请求，并用原生对话框问一次；
 * 通知按设置里的「任务通知」开关放行；其余权限（地理位置……）一律拒绝——这些页面都是本机工具，不需要。
 */
function installPermissionHandlers() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents.getURL()
    // 复制按钮（诊断信息等）走异步剪贴板 API，Chromium 会请求这个权限；
    // 一律拒绝的话 writeText 直接失败，页面只能退回「选中再复制」那条死路
    if (permission === 'clipboard-sanitized-write' && isLoopbackUrl(origin)) {
      callback(true)
      return
    }
    // 通知：dsh 页面 / 插件要发桌面通知时按「任务通知」开关放行。
    // 关掉时一律拒绝，页面会退回它自己的页面内提示——和浏览器里「不允许通知」一个效果。
    if (permission === 'notifications' && isLoopbackUrl(origin)) {
      callback(prefs.taskNotifications)
      return
    }
    if (permission !== MEDIA_PERMISSION || !isLoopbackUrl(origin)) {
      callback(false)
      return
    }
    const camera = details.mediaTypes?.includes('video')
    const en = state.lang === 'en'
    const device = en ? (camera ? 'camera' : 'microphone') : (camera ? '摄像头' : '麦克风')
    const host = new URL(origin).origin
    const owner = BrowserWindow.fromWebContents(contents) || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
    dialog.showMessageBox(owner, {
      type: 'question',
      buttons: en ? ['Allow', 'Deny'] : ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      message: en ? `${host} wants to use your ${device}.` : `${host} 请求使用${device}。`,
      detail: en ? 'Allow access?' : '是否允许？',
    }).then(({ response }) => callback(response === 0), () => callback(false))
  })
}

/**
 * 页面里的下载（导出日志等）：Electron 不会自己存文件，没人接管 will-download 时下载会被
 * 静默丢掉（浏览器版没这问题）。
 *
 * 只保留 Electron 自己那一次保存框：这里不弹 showSaveDialog，只给它设置建议路径——
 * 自己弹一个的同时，Electron 看到没设 savePath 还会再弹默认框，结果一次导出两个框。
 * 完成/失败在页面上给个提示。
 */
function installDownloadHandler() {
  session.defaultSession.on('will-download', (event, item, contents) => {
    const en = state.lang === 'en'
    const filename = item.getFilename() || 'dsh-x-download'
    try {
      item.setSaveDialogOptions({
        title: en ? 'Save file' : '另存为',
        defaultPath: join(app.getPath('downloads'), filename),
      })
    } catch { /* 设置建议路径失败不影响默认保存框 */ }
    item.once('done', (_event, status) => {
      if (contents.isDestroyed()) return
      const filePath = item.getSavePath()
      const message = status === 'completed' ? (en ? `Saved to ${filePath}` : `已保存到 ${filePath}`)
        : status === 'cancelled' ? '' : (en ? 'Download failed' : '下载失败')
      if (message) contents.executeJavaScript(`notify(${JSON.stringify(message)})`).catch(() => {})
    })
  })
}

/**
 * 右侧栏浏览器：只接受已绑定的 dsh 标签页发来的 acquire/release。
 * 页面侧拿不到原始 IPC——preload-browser.cjs 只代理这三个操作，租约和 partition 都在主进程核。
 *
 * 这里不按「启用内置浏览器控制」拦：那个开关关掉的是 agent 工具（dsh-x-sidebar-browser），
 * 侧栏 Browser 本身还在，用户手动看网页照常。证书策略和浏览数据才走设置（见下面两个函数）。
 */
function installBrowserGuestIpc() {
  ipcMain.handle(BROWSER_IPC.acquire, (event, workspace) => {
    if (!browserGuestOwners.has(event.sender)) throw new Error('desktop browser: unknown owner')
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(BROWSER_IPC.release, (event, lease) => {
    if (!browserGuestOwners.has(event.sender)) return
    return browserGuests.release(event.sender, lease)
  })
}

/**
 * 内置浏览器的分区名。分区按 workspace 哈希活到进程退出，进程里只装得下这次用过的；
 * 以前跑过、这次还没开的分区只在磁盘上（userData/Partitions），清理时两边都要算上。
 */
function browserPartitionNames() {
  const names = new Set()
  for (const partition of browserGuests.partitions.values()) {
    names.add(partition.replace(/^persist:/, ''))
  }
  try {
    for (const entry of readdirSync(join(app.getPath('userData'), 'Partitions'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('dsh-sidebar-browser-')) names.add(entry.name)
    }
  } catch { /* 还没建过任何浏览器分区 */ }
  return [...names]
}

/**
 * 清理内置浏览器的数据（设置页「浏览器数据」两个按钮）。
 * - cache：HTTP 缓存 + Cache Storage / Service Worker，Cookie 和站点数据留着（登录态不丢）
 * - all：连 Cookie、localStorage、IndexedDB 一起清（页面写着的会再写回，说明里写「不可撤销」）
 */
async function clearBrowserData(scope) {
  const names = browserPartitionNames()
  for (const name of names) {
    const browserSession = session.fromPartition(`persist:${name}`)
    if (scope === 'all') {
      await browserSession.clearStorageData()
      await browserSession.clearAuthCache()
    } else {
      await browserSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] })
    }
    await browserSession.clearCache()
  }
  return { partitions: names.length }
}

/** 托盘「退出」/ ⌘Q：还有 dsh 在跑时先问一句，确认后交给管理服务收尾，它收完调 host.exit（见 exitApp）。 */
async function quit() {
  if (quitting) return
  if (!server) {
    app.exit(0)
    return
  }
  // 已经在等回答就不再叠一个确认框；用户答完由第一次调用接着走
  if (quitConfirm) return
  if (!(await confirmQuitWithInstances())) return
  quitting = true
  await fetch(`${managerUrl()}api/quit`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(TRAY_REQUEST_TIMEOUT_MS) })
    .catch(() => server.shutdown().finally(() => exitApp(0)))
}

/**
 * 退出前的确认：还有实例在跑时让管理页弹确认框（页面里那套 appConfirm，不用系统原生框，
 * 和整套界面一致）。窗口藏着或停在标签页上时先把管理页叫回来，否则确认框看不见。
 * 没有实例、或者窗口根本不在，直接放行——问不出口不能让退出卡死。
 */
function confirmQuitWithInstances() {
  const count = liveInstanceCount()
  if (!count || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve(true)
  showManager()
  let settleQuit
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => settleQuit(false), QUIT_CONFIRM_TIMEOUT_MS)
    settleQuit = (ok) => {
      clearTimeout(timer)
      quitConfirm = null
      resolve(ok)
    }
  })
  quitConfirm = { promise, settle: settleQuit }
  const contents = mainWindow.webContents
  const send = () => {
    // 等页面画完的这段时间里可能已经超时（或者窗口关了）：别再补一个没人接的框
    if (!quitConfirm) return
    try {
      contents.send(SHELL_CHANNEL, JSON.stringify({ action: 'confirm-quit', instances: count }))
    } catch {
      // 发不出去（窗口正在销毁）：按放行处理，和「窗口不在就不问」同一个取舍
      settleQuitConfirm(true)
    }
  }
  // 页面正在加载（刚崩过重载、或启动还没画完）时监听脚本还没挂上，等它画完再问；
  // 30 秒的等待上限在那头兜着，不会一直等下去
  if (contents.isLoading()) contents.once('did-finish-load', send)
  else send()
  return promise
}

function settleQuitConfirm(ok) {
  quitConfirm?.settle(ok === true)
}

/**
 * 现在还有几个实例在跑（running / starting）。核心就在本进程里时同步取最新的，1.5 秒
 * 轮询到的状态可能慢一拍；旧核心没有 trayStateText 这个导出时退回轮询那份。
 */
function liveInstanceCount() {
  try {
    if (typeof server?.trayStateText === 'function') return liveInstances(parseTrayState(server.trayStateText()).instances).length
  } catch { /* 退回轮询状态 */ }
  return liveInstances(state.instances).length
}

/** 管理服务收尾之后（退出 / 自更新）真正退出：先放行窗口的 close，再让 Electron 退。 */
function exitApp(code = 0) {
  quitting = true
  stopTabDrag()
  instanceViews?.dispose()
  app.exit(code)
}

// 程序坞图标：只把窗口叫回来、不切标签。用户停在内部标签页上时点它是想回到刚才那一页，
// 走 showManager 会先切回管理页（托盘「打开启动器」、通知这类入口要的才是那个）。
app.on('activate', () => {
  // 窗口被系统销毁过（#117）：程序坞也得能把它叫回来，重建后再显示。
  if (!mainWindow || mainWindow.isDestroyed()) showManager()
  else revealWindow(mainWindow, MAIN_WINDOW)
})
// 系统也能直接结束我们（程序坞右键「退出」、注销关机）：先让服务停掉 dsh，否则 dsh 子进程会留下来
app.on('before-quit', (event) => {
  if (quitting || !server) return
  event.preventDefault()
  quit()
})
// 窗口全关了也不退：托盘还在（默认行为在 macOS 上本来就不退，这里写明白）
app.on('window-all-closed', () => {})
app.on('will-quit', () => { stopTabDrag(); instanceViews?.dispose() })

