// 必须是第一个 import：它在核心（server.js）求值之前补好 PATH 和外壳标记（见 env.mjs）
import './env.mjs'
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, screen, session, shell } from 'electron'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BrowserTabs } from './tabs.mjs'
import { BROWSER_IPC, DesktopBrowserGuests } from './browser-guests.mjs'
import { createUpdater } from './updater.mjs'
import { readPrefs } from './prefs.mjs'
import { dataUrl, errorPage, idlePage, resolveDark } from './pages.mjs'
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
 * 外壳和核心是两层：安装包的 resources/app 只有这个外壳，核心在 resources/core（基线）或
 * 用户目录的 core/current（npm 更新后的版本）。外壳启动时动态 import 核心的 server.js，
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
/** 安装包内置的基线核心（resources/core）；源码运行时就是仓库根目录（server.js 所在处）。 */
const BASELINE_CORE = existsSync(join(ROOT, 'server.js')) ? ROOT : join(dirname(ROOT), 'core')
/** 和 preload.cjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 外壳 → 管理页：退出前的询问（preload.cjs 的 onMessage 收这条）。 */
const SHELL_CHANNEL = 'dsh-x:shell'
/**
 * 管理页的 window 查询参数：macOS 用它切到红绿灯排版（public/index.html 的 macWindow），
 * Windows 则固定用 '1'——和 Rust/wry 外壳一致，页面据此画自绘的最小化/最大化/关闭按钮。
 */
const WINDOW_QUERY = IS_MAC ? 'mac' : '1'
/** 首次出现的窗口尺寸（逻辑像素），和 Rust 外壳一致。 */
const MAIN_WINDOW = { width: 1100, height: 760, minWidth: 720, minHeight: 520 }
const DSH_WINDOW = { width: 1180, height: 820, minWidth: 720, minHeight: 520 }
const ERROR_WINDOW = { width: 560, height: 300, logHeight: 420 }
/**
 * 红绿灯的位置（逻辑像素，左上角为原点）：Rust 外壳给 tao 的 inset 是 (18, 29)，tao 把它当成
 * 「按钮左边距、标题栏高度 = 按钮高 + 29」，按钮因此竖直居中在 (14 + 29) / 2 ≈ 21.5 上。
 * Electron 的 trafficLightPosition 是按钮左上角，换算后 y = 21.5 - 7 ≈ 15，和页面顶栏的竖直中线对齐。
 */
const TRAFFIC_LIGHTS = { x: 18, y: 15 }
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
/** 菜单栏 / 托盘图标按 18pt（macOS）或 16px（Windows 托盘）显示，给 2 倍图才不糊。 */
const TRAY_ICON_POINTS = IS_MAC ? 18 : 16
const ICON_FILE = join(ROOT, 'assets', 'icon.png')
/**
 * 托盘图标用带圆角/透明边的版本，不用 icon.png——后者是不透明的方形母版，
 * 直接塞进 Windows 托盘会是一个方块。Windows 用 tray.ico，mac/Linux 用 tray.png。
 */
const TRAY_ICON_FILE = IS_WINDOWS ? join(ROOT, 'assets', 'tray.ico') : join(ROOT, 'assets', 'tray.png')
/** 页面进程崩溃时 Chromium 报的原因：这几种是正常结束，不用重装。 */
const CLEAN_EXITS = new Set(['clean-exit', 'killed'])
/** dsh 页面能申请的权限：只放行本机地址的麦克风 / 摄像头（询问用户），其余一律拒绝。 */
const MEDIA_PERMISSION = 'media'

let server = null
/** 管理页的根地址（http://127.0.0.1:<端口>/）：端口被占时服务会顺延，以 startServer 返回的为准。 */
let managerBase = ''
let mainWindow = null
let tabs = null
let dshWindow = null
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
 * 启动哪个核心：CLI 明确指定（DSH_CORE_DIR）→ 用户目录里更新过的 current → 安装包基线。
 * current 声明的 Electron 和当前外壳不一致（外壳升级换了运行时）时，退回基线并删掉 current，
 * 避免每次启动都加载一个对不上的核心。
 */
function resolveCoreDir() {
  if (process.env.DSH_CORE_DIR) return process.env.DSH_CORE_DIR
  // 源码运行（npm run electron）用仓库自己的核心，不去碰用户目录里安装版更新的 core/current
  if (!app.isPackaged && process.env.DSH_NPM !== '1') return BASELINE_CORE
  if (!existsSync(join(ACTIVE_CORE, 'server.js'))) return BASELINE_CORE
  const pkg = corePackage(ACTIVE_CORE)
  const electron = pkg?.dshX?.electron
  if (electron && String(electron) !== String(process.versions.electron)) {
    try { rmSync(ACTIVE_CORE, { recursive: true, force: true }) } catch { /* 删不掉下次再试 */ }
    return BASELINE_CORE
  }
  return ACTIVE_CORE
}

/**
 * 用户目录里的核心起不来：删掉它，重启回安装包基线。
 * pendingOnly 用于 startServer 失败：只有「刚换上、还没成功启动过」的核心才回退，
 * 已经正常用过的 current 因为别的原因起不来（比如端口/设置）不该被删。
 */
function recoverBaseline(coreDir, { pendingOnly = false } = {}) {
  if (coreDir !== ACTIVE_CORE) return false
  const pending = join(APP_DIR, 'core', 'pending')
  if (pendingOnly && !existsSync(pending)) return false
  try { rmSync(ACTIVE_CORE, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(pending, { force: true }) } catch { /* ignore */ }
  console.log('核心启动失败，回退到安装包内置版本')
  relaunchApp()
  return true
}

/** 重启外壳：AppImage 要重启 APPIMAGE 本身，process.execPath 是挂载目录里的临时二进制。 */
function relaunchApp() {
  if (process.env.APPIMAGE) app.relaunch({ execPath: process.env.APPIMAGE })
  else app.relaunch()
  app.exit(0)
}

// ---- 设置文件里的系统开关（硬件加速在文件顶部处理，其余在这里实时跟随）----

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
  const coreDir = resolveCoreDir()
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
  nativeTheme.on('updated', () => tabs?.systemThemeChanged())

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
    // 用户目录里的核心坏到加载不了：删掉，重启回安装包基线；内置核心坏了只能报错
    if (recoverBaseline(coreDir)) return
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
    // 刚换上的核心起不来才回退（pending 标记是核心更新写入的）；老 current 起不来按普通错误报
    if (recoverBaseline(coreDir, { pendingOnly: true })) return
    showStartupError('dsh 服务启动失败', '管理页没能起来。', error?.stack || String(error))
    return
  }
  // 核心已经成功启动：新版本通过验收，清掉「待验证」标记
  try { rmSync(join(APP_DIR, 'core', 'pending'), { force: true }) } catch { /* ignore */ }
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
  mainWindow = new BrowserWindow({
    ...MAIN_WINDOW,
    title: 'DSH-X',
    show: false,
    // macOS 留着系统红绿灯（用户对它们的肌肉记忆比风格统一更重要），标题栏透明、页面铺满整个窗口；
    // Windows 没有红绿灯：无边框，最小化/最大化/关闭由页面画（.app-window 的 win-controls）
    ...(IS_MAC
      ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS }
      : { frame: false, icon: ICON_FILE, backgroundColor: '#15171c' }),
    webPreferences: managerPreferences(),
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (event) => {
    // 关窗口不退出：托盘还在、dsh 照常跑，需要时从托盘或程序坞再叫回来。
    // 设置里关掉「关闭窗口时隐藏到托盘」、或者托盘根本没建起来时，关窗口就是真退出。
    if (quitting) return
    event.preventDefault()
    if (prefs.closeToTray && tray) mainWindow.hide()
    else void quit()
  })
  mainWindow.on('resize', () => tabs?.layout())
  guardManager(mainWindow.webContents)
  tabs = new BrowserTabs(mainWindow, { createView: createTabView })
  mainWindow.loadURL(`${managerUrl()}?window=${WINDOW_QUERY}`)
}

/** 管理页和独立窗口那张本地页：只有它们装预加载、拿得到 window.ipc。 */
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
function guardManager(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(managerUrl())) return
    event.preventDefault()
    if (isWebUrl(url)) openLink(url)
  })
  contents.on('before-input-event', (event, input) => {
    // ⌘W / ⌃Tab 在显示标签条时归标签页（和 Rust 外壳注入的 keydown 脚本同一组快捷键）
    if (!tabs?.active) return
    const action = shortcutAction(input, false)
    if (action) {
      event.preventDefault()
      tabs.action({ action })
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
  if (key === 'tab') return 'next'
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
  contents.on('destroyed', () => browserGuestOwners.delete(contents))
  contents.setWindowOpenHandler(({ url }) => {
    if (!tabs.link(id, url)) openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    // 本机地址（dsh 自己、它的插件页）和页面自己的东西都放行；只有真正的外部网页交给系统浏览器
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  contents.on('page-title-updated', (_event, title) => tabs.title(id, title))
  // 页面画完再采一次底色：present 那次可能还停在加载屏上（采到的是加载页的颜色），
  // 采完选中的标签才和它下面那块页面同色。
  contents.on('did-stop-loading', () => tabs.resample(id))
  contents.on('before-input-event', (event, input) => {
    const action = shortcutAction(input, true)
    if (action) {
      event.preventDefault()
      tabs.action({ action })
    }
  })
  // 页面进程崩了只剩一块空白：由外壳重新认证装回（见 BrowserTabs.recover）
  contents.on('render-process-gone', (_event, details) => {
    if (!CLEAN_EXITS.has(details.reason)) tabs.recover(id)
  })
  return view
}

/** 管理页和本地页发来的消息（window.ipc.postMessage）。按发送方分派，别的 webContents 发的一律不认。 */
ipcMain.on(IPC_CHANNEL, (event, message) => {
  if (mainWindow && event.sender === mainWindow.webContents) return handleManagerMessage(message)
  // 独立窗口里远端 dsh 页面也带着这个预加载（同一块 webContents 换页，预加载改不了）：
  // 只认外壳自己那张 data: 本地页发的消息
  if (dshWindow && event.sender === dshWindow.webContents && event.senderFrame?.url.startsWith('data:')) return handleIdleMessage(message)
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
    // macOS 用系统红绿灯：最小化 / 最大化 / 关闭按钮页面不画（.mac-window 隐藏了），这里照样接住
    case 'minimize': mainWindow.minimize(); return
    case 'maximize': toggleMaximize(mainWindow); return
    // 走 close() 让窗口的 close 处理决定「隐藏到托盘还是退出」（Windows 的自绘关闭按钮也走这里）
    case 'close': mainWindow.close(); return
    // 拖窗口走 CSS 的 -webkit-app-region（public/launcher.css 的 .electron-window header）：Chromium 没有
    // 「从页面里发起一次系统拖动」的接口，页面在 mousedown 时发的 drag 这里无事可做
    case 'drag': return
    case 'internal-tabs-ready': tabs.render(true); return
    default: {
      const action = parseTabAction(message)
      if (action) tabs.action(action)
    }
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
function revealWindow(window, size) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  const bounds = recenterBounds(window.getBounds(), screen.getAllDisplays(), screen.getPrimaryDisplay(), size)
  if (bounds) window.setBounds(bounds)
  window.focus()
}

function showManager() {
  if (!mainWindow) return
  tabs?.action({ action: 'select', id: '' })
  revealWindow(mainWindow, MAIN_WINDOW)
}

/** 内部标签页：复用主窗口。主窗口不在（极少见）就退回系统浏览器，至少还能访问已经起来的实例。 */
function openInternalTab(target) {
  if (!mainWindow) {
    shell.openExternal(target.url)
    return
  }
  tabs.open(target)
  revealWindow(mainWindow, MAIN_WINDOW)
}

/**
 * 页面里点出来的链接：管理页自己 → 叫回管理页；属于某个 dsh 实例 → 按打开方式进标签 / 独立窗口；
 * 其余 http(s) 交给系统浏览器。data:/blob: 不是能给系统打开的地址，宁可不理。
 */
function openLink(url) {
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
}

/** 独立 DSH 窗口：按需创建，关窗口只是藏起来（和主窗口一个口径）。 */
function openDshWindow(url) {
  if (!dshWindow) createDshWindow()
  dshWindow.instanceId = null
  followDshWindow(url)
  revealWindow(dshWindow, DSH_WINDOW)
}

function createDshWindow() {
  dshWindow = new BrowserWindow({
    ...DSH_WINDOW,
    title: 'DSH',
    show: false,
    ...(IS_WINDOWS ? { icon: ICON_FILE } : {}),
    // 本地那张「没在跑」的页要 window.ipc；远端 dsh 页面的预加载只暴露 postMessage，
    // 而 handleIdleMessage 只认 launch / manager 两个词，dsh 页面发什么都没有效果
    webPreferences: managerPreferences(),
  })
  dshWindow.page = null
  dshWindow.instanceId = null
  dshWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    dshWindow.hide()
  })
  const contents = dshWindow.webContents
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isExternalWebUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  // 网页标题同步到窗口标题：否则窗口菜单里永远只有一个「DSH」
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    dshWindow.setTitle(title.trim() || 'DSH')
  })
  contents.on('render-process-gone', (_event, details) => {
    if (CLEAN_EXITS.has(details.reason) || !dshWindow.page) return
    const url = dshWindow.page
    dshWindow.page = null
    followDshWindow(url)
  })
}

/** 让独立窗口跟上 dsh 的当前地址；地址没变不刷新（别把用户正在看的页面刷掉），空地址换本地页。 */
function followDshWindow(url) {
  const page = url || ''
  if (dshWindow.page === page) return
  dshWindow.page = page
  const target = page || dataUrl(idlePage(state.lang))
  dshWindow.webContents.loadURL(target).catch(() => {})
}

function handleIdleMessage(message) {
  // 只有本地那张页会发这两个；dsh 自己的页面发什么都不管
  if (message === 'manager') {
    showManager()
    return
  }
  if (message !== 'launch') return
  const row = state.launches.find((item) => item.instanceId && item.instanceId === dshWindow.instanceId)
  if (row) trayAction({ id: row.id, instanceId: row.instanceId, action: 'start', targetId: '' })
  // 原来的入口已被删除时，返回启动器选择，不能误启动另一项
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
  if (window === mainWindow) window.close()
  else window.hide()
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON_FILE).resize({ width: TRAY_ICON_POINTS, height: TRAY_ICON_POINTS, quality: 'best' })
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
  // dsh 重启后地址（端口、token）会变：独立窗口跟着选中的实例换页，不能被后来启动的另一项抢走
  if (dshWindow) {
    if (!dshWindow.instanceId && dshWindow.page) {
      dshWindow.instanceId = state.instances.find((target) => sameOrigin(target.url, dshWindow.page))?.id || null
    }
    if (dshWindow.instanceId) {
      const target = state.instances.find((item) => item.id === dshWindow.instanceId)
      followDshWindow(target?.url || '')
    }
  }
  if (tabs) {
    tabs.preferences(internalMode(state), state.lang, state.theme)
    tabs.follow(state.instances)
  }
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
  mainWindow?.webContents.executeJavaScript(`notify(${JSON.stringify(error)})`).catch(() => {})
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
    const owner = BrowserWindow.fromWebContents(contents) || mainWindow
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
  app.exit(code)
}

// 程序坞图标：窗口藏起来之后点它，叫回管理页
app.on('activate', () => showManager())
// 系统也能直接结束我们（程序坞右键「退出」、注销关机）：先让服务停掉 dsh，否则 dsh 子进程会留下来
app.on('before-quit', (event) => {
  if (quitting || !server) return
  event.preventDefault()
  quit()
})
// 窗口全关了也不退：托盘还在（默认行为在 macOS 上本来就不退，这里写明白）
app.on('window-all-closed', () => {})

