import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { accessSync, appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cmpVer, currentRegistry, installSpec, listPackage, parsePnpmProgress, parseVer } from './registry.js'
import pkg from './package.json' with { type: 'json' }
import {
  disableRowId,
  listPlugins,
  ownerOfRow,
  parseFailedRows,
  parseUnresolvedBundles,
  pluginsNamedInFailure,
  setPluginEnabled,
} from './plugins.js'
import { listMcpServers, probeMcpServer, removeMcpServer, saveMcpServer, setMcpEnabled } from './mcp.js'
import {
  listSkills,
  localSkillsEnabled,
  rootDirOf,
  setLocalSkillsEnabled,
  setSkillEnabled,
  skillRoots,
} from './skills.js'
import {
  STORE_TYPES,
  SYNC_SCOPES,
  runSync,
  safeFolderConfig,
  safeS3Config,
  safeZipConfig,
  safeWebdavConfig,
  storeClient,
  storeConfigured,
  storeDisplayUrl,
  storeMissing,
} from './sync.js'
import {
  MARKET_INDEX_URL,
  applyInstall,
  defaultProfileFor,
  describeSource,
  exportPack,
  forgetPack,
  localized,
  packSummary,
  parsePackArchive,
  parsePackDir,
  parsePackSource,
  planInstall,
  readPackState,
  rememberPack,
  uninstallPack,
} from './packs.js'
import {
  autoStartEnabled,
  DEFAULT_PORT,
  DEFAULT_UPDATE_SOURCE,
  defaultDshHome,
  ensureSettings,
  ensureWritableDir,
  lanBindToggleOn,
  loadSettings,
  loadSettingsSync,
  parseArgs,
  resolveDataDir,
  resolvePort,
  resolveProfile,
  resolveWebBind,
  safeDataDir,
  safeDshHome,
  safeLang,
  safeOpenMode,
  safeSyncSettings,
  safeTheme,
  safeUpdateSource,
  updateUrlCandidates,
  safePanelTransparency,
  safeDownloadSource,
  safePort,
  safeProfile,
  safeArgs,
  safeWebBind,
  saveSettings,
  setAutoStart,
} from './settings.js'
import { APP_DIR, IS_MAC, IS_WINDOWS, LAUNCHER_NAME, MAC_APP_NAME, NODE_BINARY, appBundle } from './platform.js'

const execFileAsync = promisify(execFile)

const ROOT = dirname(fileURLToPath(import.meta.url))
let DATA = resolveDataDir()
const PUBLIC = join(ROOT, 'public')
let CONFIG = join(DATA, 'config.json')
const PKG = '@deepseek-ai/dsh'
const MARKET_PKG = 'dshmarket'
const APP_VERSION = String(pkg.version || '0.0.0')
const APP_REPO = 'yyh-001/DSH-X'
// 发布页上的安装包名：scripts/pack.mjs 按平台产出同名文件
const APP_SETUP = IS_MAC ? `DSH-X-mac-${process.arch}.dmg` : 'DSH-Setup.exe'
// 管理页端口：环境变量 PORT（开发和测试用）优先，其余看设置；启动时 startServer() 再定最终值
let PORT = resolvePort() || DEFAULT_PORT
/** 配置的端口被别的程序占用时，往后最多试这么多个端口。 */
const PORT_SCAN = 20

/** 探端口上是不是我们自己的管理页——用 /api/ping 的身份标记区分「自己的实例」和「别人的程序」。 */
async function probeManager(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(800),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data?.app === 'dsh-x'
  } catch {
    return false
  }
}
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const SPEC_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i
const GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const START_TIMEOUT_MS = 120_000
// 启动 profile：设置页可改，startServer() 里按设置定值
let PROFILE_NAME = resolveProfile()
// DSH.exe 命令行上传进来的参数：Rust 启动器原样转发给 start.js，这里拼进 dsh
// 命令行末尾——不再静默忽略。只在经由 start.js 启动时认，免得把测试/开发时
// node 自己的 argv 误当成用户参数。
const CLI_ARGS = /start\.js$/i.test(process.argv[1] || '') ? process.argv.slice(2) : []
// 额外启动参数：用户自己加的 argv，拼在命令行末尾（设置页可改）
let EXTRA_ARGS = composeExtraArgs(loadSettingsSync().args)
// Web 绑定方式：loopback（默认）/ lan。lan 时启动 web 不注入 --host/--port，
// 绑定交给配置层（远程访问插件的「局域网访问」开关写的 profile 补丁块）决定
let WEB_BIND = resolveWebBind()
// 远程访问插件的「局域网访问」开关（读 dsh 的 settings.yaml）：开着时同样不注入
// --host，否则命令行显式 --host 永远压着插件的开关和补丁块（详见 lanBindToggleOn）
let LAN_TOGGLE = false
// 界面语言（zh / en）：settings.json 为准；安装时选的语言写在安装目录 lang.txt，启动时对齐一次
const INSTALL_LANG = join(ROOT, 'lang.txt')
let LANG = safeLang(loadSettingsSync().lang) || installLang() || 'zh'
let THEME = safeTheme(loadSettingsSync().theme)
let PANEL_TRANSPARENCY = safePanelTransparency(loadSettingsSync().panelTransparency)
let REDUCE_MOTION = loadSettingsSync().reduceMotion === true
let HIDE_BACKGROUND = loadSettingsSync().hideBackground === true
let HIDE_BIG_FISH = loadSettingsSync().hideBigFish === true
// dsh 的用户目录（DSH_HOME）：留空用默认 ~/.dsh。用户把 .dsh 挪到别的盘之后，
// 在这里指回去，否则启动器会按默认位置重建一个、dsh 也就跑到那份空数据上去了。
let DSH_HOME_DIR = safeDshHome(loadSettingsSync().dshHome)
// 启动器更新的下载源：direct（默认直连 GitHub）/ mirror（国内加速，直连失败时走前缀镜像）
let UPDATE_SOURCE = safeUpdateSource(loadSettingsSync().updateSource)
// 打开 dsh 页面的方式：tab（默认，系统浏览器标签页）/ app（Chromium 应用窗口）/
// window（启动器内嵌窗口；只在被原生外壳拉起时成立，判断见 openRoute）
let OPEN_MODE = safeOpenMode(loadSettingsSync().openMode)
// 是否把 dsh 的 shim 目录写进用户 PATH（默认关，改了要新开终端才生效）
let SYSTEM_PATH = loadSettingsSync().systemPath === true

/** 安装目录里的 lang.txt（安装程序写的），只认 zh / en。 */
function installLang() {
  try {
    return safeLang(readFileSync(INSTALL_LANG, 'utf8'))
  } catch {
    return ''
  }
}
const LOG_DIR = APP_DIR
const LOG_FILE = join(LOG_DIR, 'manager.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
const NOISY_LOG_RE = /^(?:已安装 \d+\/\d+|已解析 \d+)/

const clients = new Set()
const stateListeners = new Set()
let host = {
  onWake: async () => {},
}
const logs = []
let current = null
let installing = null
let installProgress = null
// 插件安装/升级的进度（走 dsh 内部的 pnpm，解析方式和 npm 不同，页面按 kind 分给不同的进度条）
let pluginProgress = null
let pluginProgressName = ''
let pluginBusy = false
let remoteCache = { at: 0, data: null }
let selfCache = { at: 0, data: null }
let server = null
/** 最近一次启动失败的上下文（错误 + 子进程输出尾巴）。 */
let lastFailure = null
/** 最近一次启动后的页面自检结果（客户端插件包是否都拉得动）。 */
let lastHealth = null
/** 需要在日志里打码的敏感串（如 API key）。 */
let secretValues = []
// 同步：远端配置（S3 桶 / WebDAV 目录，都含密钥）与范围存 settings.json，启动时读一次
let S3_CONFIG = safeS3Config(loadSettingsSync().s3)
let WEBDAV_CONFIG = safeWebdavConfig(loadSettingsSync().webdav)
let FOLDER_CONFIG = safeFolderConfig(loadSettingsSync().folder)
let ZIP_CONFIG = safeZipConfig(loadSettingsSync().zip)
let SYNC_OPTIONS = safeSyncSettings(loadSettingsSync().sync)
/** 正在跑的同步任务：进度、每步在哪个文件，页面靠它画进度条（也进 SSE 重放）。 */
let syncState = null
let syncRunning = false
/** 用户点了「停止」：引擎在每个文件之间看它一眼。 */
let syncStopRequested = false
/** 当前这份远端配置（引擎只认这个形状；切换存储类型不用重填另一侧的字段）。 */
const storeConfig = () => ({
  store: SYNC_OPTIONS.store,
  s3: S3_CONFIG,
  webdav: WEBDAV_CONFIG,
  folder: FOLDER_CONFIG,
  zip: ZIP_CONFIG,
})
secretValues = [S3_CONFIG.secretAccessKey, S3_CONFIG.sessionToken, WEBDAV_CONFIG.password].filter(Boolean)

/** 把 key 之类的敏感串从任意文本里抹掉（dsh 的凭据常出现在子进程输出里）。 */
function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('sk-***')
  }
  return out.replace(/\b(sk|ak)-[A-Za-z0-9_-]{8,}/g, '$1-***')
}

function versionDir(version) {
  return join(DATA, 'versions', version)
}

function homeDir() {
  return DSH_HOME_DIR || defaultDshHome()
}

function managedBin(version) {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function systemNpmRoots() {
  const roots = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    roots.push(dir)
  }
  if (process.env.APPDATA) add(join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  if (process.env.npm_config_prefix) add(join(process.env.npm_config_prefix, 'node_modules'))
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (base) add(join(base, 'nodejs', 'node_modules'))
  }
  add('/usr/local/lib/node_modules')
  // Apple Silicon 上 Homebrew 的前缀
  if (IS_MAC) add('/opt/homebrew/lib/node_modules')
  add(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  return roots
}

function detectSystemDsh() {
  for (const root of systemNpmRoots()) {
    const pkgRoot = join(root, '@deepseek-ai', 'dsh')
    const bin = join(pkgRoot, 'lib', 'bin.js')
    const pkgFile = join(pkgRoot, 'package.json')
    if (!existsSync(bin) || !existsSync(pkgFile)) continue
    try {
      const version = String(JSON.parse(readFileSync(pkgFile, 'utf8')).version || '')
      if (!VERSION_RE.test(version)) continue
      return { version, bin, root: pkgRoot }
    } catch {
      continue
    }
  }
  return null
}

function isManaged(version) {
  return existsSync(managedBin(version))
}

function binPath(version) {
  if (isManaged(version)) return managedBin(version)
  const system = detectSystemDsh()
  if (system?.version === version) return system.bin
  return managedBin(version)
}

function profileManifest() {
  return join(profileDir(), 'package.json')
}

function scanInstalled() {
  const found = []
  const root = join(DATA, 'versions')
  if (existsSync(root)) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(managedBin(entry.name))) found.push(entry.name)
      }
    } catch {
      // ignore unreadable versions dir
    }
  }
  const system = detectSystemDsh()
  if (system && !found.includes(system.version)) found.push(system.version)
  return found
}

function listedVersions(config) {
  const onDisk = new Set(scanInstalled())
  const fromConfig = (config.versions || [])
    .map((item) => (typeof item === 'string' ? item : item.version))
    .filter((version) => version && onDisk.has(version))
  const extra = [...onDisk].filter((version) => !fromConfig.includes(version))
  return [...fromConfig, ...extra]
}

function safeVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error('非法版本号')
  }
  return version
}

/** 保留的版本数：最新的一个 + 最近装的一个（回退用）。 */
const KEEP_VERSIONS = 2

/**
 * 装完新版后该留哪几个：刚装的那个 + 版本号最高的，正在跑的一定留。
 * `versions[0]` 是 install() 刚插到最前面的那个，**不是**「版本号最高的那个」——
 * 用户可以挑一个旧版本装。只按位置取前两个的话，装旧版就会把最新版删掉。
 */
export function versionsToKeep(versions, currentVersion, limit = KEEP_VERSIONS) {
  if (!versions.length) return new Set()
  const [installed, ...rest] = versions
  const ranked = [...rest].sort((a, b) =>
    cmpVer(parseVer(b) ?? parseVer('0'), parseVer(a) ?? parseVer('0')))
  const keep = new Set([installed, ...ranked.slice(0, Math.max(0, limit - 1))])
  if (currentVersion) keep.add(currentVersion)
  return keep
}

/**
 * 装完新版后清理旧版本：只留最新的和上一个，正在运行的除外。
 * @returns 被清理掉的版本号
 */
async function pruneVersions(config) {
  const versions = listedVersions(config)
  if (versions.length <= KEEP_VERSIONS) return []
  const keep = versionsToKeep(versions, current?.version)
  const removed = []
  for (const version of versions) {
    if (keep.has(version)) continue
    if (!isManaged(version)) continue // 系统装的 dsh 不归启动器管
    try {
      await rm(versionDir(version), { recursive: true, force: true })
      removed.push(version)
      pushLog(`清理旧版本 ${version}（保留 ${[...keep].join('、')}）`)
    } catch (error) {
      pushLog(`清理 ${version} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (removed.length) {
    config.versions = listedVersions(config)
    await saveConfig(config)
  }
  return removed
}

function safeSpec(spec) {
  if (typeof spec !== 'string' || !(SPEC_RE.test(spec) || GITHUB_SPEC_RE.test(spec))) {
    throw new Error('非法插件源')
  }
  return spec
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8'))
  } catch {
    return { versions: [] }
  }
}

async function saveConfig(config) {
  await mkdir(DATA, { recursive: true })
  await writeFile(CONFIG, JSON.stringify(config, null, 2))
}

/** 把重要日志追加到 manager.log（进度类噪音行丢弃，超过 5MB 轮转一次）。 */
function persistLog(text) {
  if (NOISY_LOG_RE.test(text)) return
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // 目录/轮转问题不阻塞启动流程
  }
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    // 落盘失败不阻塞
  }
}

function pushLog(line) {
  const text = redact(String(line).replace(/\s+$/, ''), secretValues)
  if (!text) return
  logs.push(text)
  if (logs.length > 400) logs.splice(0, logs.length - 400)
  persistLog(text)
  emit('log', { line: text })
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

/**
 * 启动器自更新：先把新安装包下载到临时目录（带进度），用户确认后再把它用普通界面打开。
 *
 * 分工是刻意的：下载这段我们能显示进度（安装包自己的下载页在启动器里看不到），
 * 交互这段交给安装程序——它能显示自己在装什么、能在需要替换正在运行的文件时提示关闭，
 * 这些都是我们替它做只会做砸的部分。
 */
// 下载好的安装包，等用户点「打开安装程序」再动手
let stagedUpdate = null

/**
 * 收拾上一轮更新在临时目录里留下的安装包。
 *
 * 装完之后我们已经被安装程序关掉了，没机会删；用户在完成页也可能干脆不勾「删除安装包」。
 * 所以留给下一次启动：只认自己下载时用的 `DSH-X-update-` 前缀，别处的安装包一律不碰。
 */
function cleanStaleUpdates() {
  let entries = []
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return
  }
  for (const name of entries) {
    if (!/^DSH-X-update-.+\.(?:exe|dmg)$/i.test(name)) continue
    try {
      unlinkSync(join(tmpdir(), name))
      pushLog(`已清理上次的安装包 ${name}`)
    } catch {
      // 还被安装程序占着就随它去，下次启动再说
    }
  }
}

/** 安装包小于这个就肯定不对（错误页、被掐断的半截文件）。 */
const SELF_UPDATE_MIN_BYTES = 5 * 1024 * 1024
/** UDIF（.dmg）的尾部是一块 512 字节的 koly 块，开头四个字节就是魔数。 */
const DMG_TRAILER_BYTES = 512
const DMG_MAGIC = 'koly'

/** 各平台的安装包：Windows 是 Inno 的 PE 安装程序，macOS 是装着 DSH-X.app 的 dmg。 */
const SELF_UPDATE_PACKAGE = IS_MAC
  ? {
    ext: 'dmg',
    valid: (buffer) => buffer.subarray(buffer.length - DMG_TRAILER_BYTES, buffer.length - DMG_TRAILER_BYTES + DMG_MAGIC.length).toString('latin1') === DMG_MAGIC,
  }
  : { ext: 'exe', valid: (buffer) => buffer[0] === 0x4d && buffer[1] === 0x5a }

/**
 * macOS 上自更新是「把正在跑的 .app 整个换掉」，所以必须真是从一个能写的 .app 里跑起来的。
 * 放在下载之前检查：别让用户等完上百 MB 才知道装不了。
 */
function assertMacUpdatable() {
  const bundle = appBundle()
  if (!bundle) throw new Error('从源码运行时不能自更新：请用 git pull 更新，或到发布页下载 dmg')
  // 没挪进「应用程序」就直接打开的未签名应用会被 Gatekeeper 放到只读的随机路径里（App Translocation）
  let writable = !bundle.includes('/AppTranslocation/')
  try {
    accessSync(dirname(bundle), fsConstants.W_OK)
  } catch {
    writable = false
  }
  if (!writable) throw new Error(`没有权限替换 ${bundle}：请先把 DSH-X 拖进「应用程序」文件夹，从那里打开后再更新`)
  return bundle
}

/** URL 的主机名，只用于日志（解析不了就原样返回）。 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

/** 第一步：下载 + 校验。进度通过 selfUpdate 事件推给页面。 */
async function downloadSelfUpdate() {
  if (IS_MAC) assertMacUpdatable()
  const info = await checkSelfUpdate()
  const target = join(tmpdir(), `DSH-X-update-${info.latest || 'latest'}.${SELF_UPDATE_PACKAGE.ext}`)
  pushLog(`下载更新${info.latest ? ` ${info.latest}` : ''}…`)

  // 按下载源展开成待试列表：直连排第一，选了「国内加速」的话后面跟镜像前缀。
  // GitHub 在国内经常直接连不上，直连失败就换镜像重来（同一个文件，只是换个入口）。
  const candidates = updateUrlCandidates(info.url, UPDATE_SOURCE)
  let res = null
  let lastError = null
  for (const [index, url] of candidates.entries()) {
    try {
      if (index > 0) pushLog(`直连没成功，改用加速镜像重试：${safeHost(url)}`)
      const attempt = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!attempt.ok) throw new Error(`HTTP ${attempt.status}`)
      res = attempt
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!res) {
    const hint = UPDATE_SOURCE === 'mirror' ? '' : '；可以在设置页把「更新下载源」改成「国内加速」再试'
    throw new Error(`下载失败：${lastError?.message || '连不上'}${hint}`)
  }
  const total = Number(res.headers.get('content-length') || 0)
  const chunks = []
  let got = 0
  let shown = -1
  for await (const chunk of res.body) {
    chunks.push(chunk)
    got += chunk.length
    emit('selfUpdate', { phase: 'download', done: got, total })
    if (total) {
      const pct = Math.floor((got / total) * 100)
      if (pct >= shown + 10) {
        shown = pct
        pushLog(`已下载 ${pct}%`)
      }
    }
  }
  const buffer = Buffer.concat(chunks)
  // 只认本平台的安装包格式：拿到的更可能是错误页、或者被掐断的半截文件
  if (buffer.length < SELF_UPDATE_MIN_BYTES || !SELF_UPDATE_PACKAGE.valid(buffer)) {
    throw new Error(`下载到的不是安装包（${buffer.length} 字节）`)
  }
  await writeFile(target, buffer)
  stagedUpdate = { latest: info.latest, file: target }
  pushLog(`更新已就绪：${target}（${(buffer.length / 1048576).toFixed(1)} MB），等用户确认后安装`)
  emit('selfUpdate', { phase: 'ready', latest: info.latest })
  return { latest: info.latest, file: target }
}

/** 等某个进程出现在任务列表里（用于确认安装程序真的起来了）。 */
function waitForProcess(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      // tasklist 的提示语是本地化的，所以只认输出里有没有这个进程名
      const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8' })
      if ((out.stdout || '').toLowerCase().includes(name.toLowerCase())) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 300)
    }
    tick()
  })
}

/**
 * 打开安装程序（静默）然后把自己关掉——等价于 VS Code 的「重启并更新」。
 *
 * 为什么要 `/silent`：不静默时，只要还有程序占着要替换的文件，安装程序的 Restart Manager
 * 那一步就会停在「以下应用程序正在使用将由安装程序更新的文件」这一页，让用户在「自动关闭
 * 应用程序」和「不要关闭应用程序」之间选一下。`CloseApplications=force` 去不掉这一页——
 * 官方文档写得很清楚，force 只决定关的时候用不用强制，问还是要问。而静默模式下文档明确写着
 * Setup「always close and restart such applications」，也就是直接关、不问。
 *
 * 退场之前会确认安装程序真的起来了：Start-Process 这种走 ShellExecute 的启动方式拿不到子
 * 进程句柄，起没起来只能靠任务列表确认；确认不到就留在原地报错，总比关掉自己又没打开安装程
 * 序、把用户晾在那儿强。
 *
 * 我们自己也退，是为了让 dsh 走正常收尾（而不是被 Restart Manager 直接结束），顺带把浏览器
 * 里开着的页面收掉。
 */
async function installSelfUpdate() {
  const staged = stagedUpdate
  if (!staged || !existsSync(staged.file)) throw new Error('更新包还没下载好')
  if (IS_MAC) return installMacUpdate(staged)
  const name = basename(staged.file)
  const logFile = join(tmpdir(), 'DSH-X-install.log')
  // 上次的日志留着没用，先清掉，免得 Inno 另起一个带编号的文件名
  try {
    unlinkSync(logFile)
  } catch {
    // 没有就算了
  }
  const quote = (path) => `'${path.replace(/'/g, "''")}'`

  // 这里**不能**加 `detached: true`。Node 在 Windows 上会给 detached 的子进程设
  // DETACHED_PROCESS，而 powershell.exe 是控制台程序：带着这个标记它起不来，而且不报错、
  // 不留日志，进程直接从世界上消失——当初那个「等启动器退出再静默安装」的助手就是这么没的
  // （日志空的、安装目录没动），当时误判成「子进程活不过父进程」，其实是这一步。
  // 也不需要它：Start-Process 走的是 ShellExecute，安装程序由 PowerShell 创建，而 PowerShell
  // 随即退出，所以安装程序本来就不隶属于我们，我们退出影响不到它。
  //
  // -WindowStyle Hidden 藏的只是 PowerShell 自己的控制台，安装程序自己的进度窗口照常显示。
  spawn(
    'powershell',
    [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Start-Process -FilePath ${quote(staged.file)} -ArgumentList '/silent /log="${logFile}"'`,
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
      // 跟 VS Code 学的一招：压掉继承来的兼容性设置，免得启动器被提权运行时
      // 安装程序跟着提权——我们装的是用户目录，提权反而会装到别处去
      env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' },
    },
  ).unref()

  if (!(await waitForProcess(name, 8000))) throw new Error('安装程序没能启动')
  pushLog(`安装程序已启动：${name}`)
  return finishSelfUpdate(staged)
}

/** 安装已经交出去了：通知页面，先让响应发出去，再停 dsh、退出。 */
function finishSelfUpdate(staged) {
  emit('selfUpdate', { phase: 'install', latest: staged.latest })
  // 此时安装目录里已经没有属于我们的进程占着文件了
  setTimeout(() => {
    shutdown().finally(() => process.exit(0))
  }, 900)
  return { latest: staged.latest, file: staged.file }
}

/** 等外壳退出的上限：它卡住也照样换（macOS 允许替换正在运行的包），总比永远不装强。 */
const MAC_SWAP_WAIT_TICKS = 150
const MAC_SWAP_TICK_SECONDS = 0.2

/**
 * 换包助手：等外壳和我们都退出，把旧包挪开、新包挪到原位，再打开新版。
 * 新包就在旧包旁边（同一个卷），两次 mv 都只是改名；第二步失败就把旧包挪回去。
 * 参数：$1 外壳 pid，$2 我们的 pid，$3 旧包路径，$4 新包路径。
 */
const MAC_SWAP_SCRIPT = `
for pid in "$1" "$2"; do
  n=0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -lt ${MAC_SWAP_WAIT_TICKS} ]; do sleep ${MAC_SWAP_TICK_SECONDS}; n=$((n + 1)); done
done
rm -rf "$3.old"
mv "$3" "$3.old" || { echo "move old app failed"; open "$3"; exit 1; }
if mv "$4" "$3"; then rm -rf "$3.old"; else echo "move new app failed"; mv "$3.old" "$3"; fi
open "$3"
`

/**
 * macOS：挂上 dmg，把新的 DSH-X.app 拷到旧包旁边，再交给换包助手，然后自己退出。
 *
 * 拷贝在退出之前做完：挂载、拷贝任何一步出错都还能留在原地报错；真正换包必须等我们退出，
 * 所以交给一个 detached 的 sh（setsid 之后不随我们一起被收掉）。
 */
async function installMacUpdate(staged) {
  const bundle = assertMacUpdatable()
  const next = join(dirname(bundle), `.${basename(bundle)}.update`)
  const mount = mkdtempSync(join(tmpdir(), 'DSH-X-mount-'))
  pushLog(`挂载更新包 ${basename(staged.file)}`)
  await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, staged.file])
  try {
    const source = join(mount, MAC_APP_NAME)
    if (!existsSync(join(source, 'Contents', 'MacOS', LAUNCHER_NAME))) throw new Error(`更新包里没有 ${MAC_APP_NAME}`)
    await rm(next, { recursive: true, force: true })
    // ditto 保留权限、符号链接和扩展属性，是拷 .app 的标准做法（cp -R 会弄丢签名需要的东西）
    await execFileAsync('ditto', [source, next])
  } finally {
    await execFileAsync('hdiutil', ['detach', '-quiet', mount])
      .catch(() => execFileAsync('hdiutil', ['detach', '-force', '-quiet', mount]))
      .catch((error) => pushLog(`卸载更新包失败：${error?.message || error}`))
    await rm(mount, { recursive: true, force: true }).catch(() => {})
  }

  const logFd = openSync(join(tmpdir(), 'DSH-X-install.log'), 'w')
  // 外壳（Contents/MacOS/DSH）是我们的父进程，它在我们退出后才退
  spawn('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'dsh-x-update', String(process.ppid), String(process.pid), bundle, next], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  }).unref()
  closeSync(logFd)
  pushLog(`新版本已就位，退出后替换 ${bundle}`)
  return finishSelfUpdate(staged)
}

/**
 * 退出前的收尾：停掉跑着的 dsh，再通知开着的页面（浏览器里那些）自己关掉。
 * 托盘退出和 /api/quit 都走这里。
 */
export async function shutdown() {
  await Promise.race([
    stopAll(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  await notifyShutdown()
}

/**
 * 退出前通知所有开着的管理页，让它们自己关掉——否则托盘退了，浏览器里还留着
 * 一个连不上后端的死页面。等最后这段推出去再让调用方结束进程。
 */
export function notifyShutdown() {
  return new Promise((resolve) => {
    for (const res of clients) {
      try {
        res.write('event: bye\ndata: {}\n\n')
      } catch { /* 这个页面已经断了 */ }
    }
    setTimeout(() => {
      for (const res of clients) {
        try { res.end() } catch { /* already gone */ }
      }
      clients.clear()
      resolve()
    }, 150)
  })
}

async function snapshot() {
  const config = await loadConfig()
  const installed = listedVersions(config)
  return {
    installing,
    installed,
    versions: installed.map((version) => ({
      version,
      managed: isManaged(version),
      status: current?.version === version ? current.status : 'stopped',
      url: current?.version === version ? current.url : null,
    })),
    running: current
      ? { version: current.version, status: current.status, url: current.url }
      : null,
    autoFix: lastAutoFix,
    health: lastHealth,
    dataDir: DATA,
    progress: installProgress,
    pluginProgress,
    sync: syncState,
    syncRunning,
  }
}

async function applyDataDir(dir) {
  // 先确认真的能写（含已存在但只读的目录），失败就带着人话抛出，DATA 保持不变
  await ensureWritableDir(dir)
  DATA = dir
  CONFIG = join(DATA, 'config.json')
  pushLog(`版本目录 ${DATA}`)
}

async function publicSettings() {
  const stored = await loadSettings()
  return {
    dataDir: DATA,
    dshHome: homeDir(),
    // 设置里填的原文（空 = 用默认位置）+ 默认位置，页面据此回显与提示
    dshHomeValue: safeDshHome(stored.dshHome),
    dshHomeDefault: defaultDshHome(),
    // port 是配置值（重启后生效），listenPort 是当前真正在监听的端口
    port: stored.port ?? DEFAULT_PORT,
    listenPort: PORT,
    portDefault: DEFAULT_PORT,
    autoStart: await autoStartEnabled(),
    seedMarket: stored.seedMarket !== false,
    autoDisablePlugins: stored.autoDisablePlugins !== false,
    downloadSource: safeDownloadSource(stored.downloadSource),
    downloadSources: [
      { id: 'mirror', label: '镜像源' },
      { id: 'official', label: '官方源' },
    ],
    openMode: safeOpenMode(stored.openMode),
    // 选了内嵌窗口但当前没有原生外壳（源码运行）时，页面要如实说明会落到标签页
    openModeWindow: openRoute(OPEN_MODE, shellWindowHost()) === 'window',
    openModes: [
      { id: 'tab', label: '浏览器标签页' },
      { id: 'app', label: '应用窗口' },
      { id: 'window', label: '桌面窗口（内嵌）' },
    ],
    systemPath: SYSTEM_PATH,
    systemBinDir: systemBinDir(),
    updateSource: safeUpdateSource(stored.updateSource),
    updateSources: [
      { id: 'mirror', label: '国内加速（先直连，连不上走镜像）' },
      { id: 'direct', label: '只直连（不用镜像）' },
    ],
    profile: PROFILE_NAME,
    profiles: listProfiles(),
    // 回显用户填的原文（带引号），不能回显 parse 后的数组，否则含空格的值再存一次就被拆开了
    args: stored.args ?? '',
    lang: LANG,
    theme: THEME,
    panelTransparency: PANEL_TRANSPARENCY,
    reduceMotion: REDUCE_MOTION,
    hideBackground: HIDE_BACKGROUND,
    hideBigFish: HIDE_BIG_FISH,
    // Web 绑定：设置值 + 插件开关是否压着它（页面要如实说明当前生效的是哪一个）
    webBind: WEB_BIND,
    webBindLan: LAN_TOGGLE,
  }
}

async function saveManagerSettings(body) {
  if (body.dataDir) {
    const dir = safeDataDir(body.dataDir)
    if (dir !== DATA && current) throw new Error('请先停止再改版本目录')
    if (installing) throw new Error('正在安装，稍后再改版本目录')
    await applyDataDir(dir)
  }
  const stored = await saveSettings({
    dataDir: DATA,
    ...('port' in body ? { port: safePort(body.port) } : {}),
    ...('profile' in body ? { profile: safeProfile(body.profile) } : {}),
    ...('args' in body ? { args: safeArgs(body.args) } : {}),
    ...('downloadSource' in body ? { downloadSource: safeDownloadSource(body.downloadSource) } : {}),
    ...('updateSource' in body ? { updateSource: safeUpdateSource(body.updateSource) } : {}),
    ...('openMode' in body ? { openMode: safeOpenMode(body.openMode) } : {}),
    ...('systemPath' in body ? { systemPath: body.systemPath === true } : {}),
    ...('dshHome' in body ? { dshHome: safeDshHome(body.dshHome) } : {}),
    ...('webBind' in body ? { webBind: safeWebBind(body.webBind) } : {}),
    ...('lang' in body ? { lang: safeLang(body.lang) } : {}),
    ...('theme' in body ? { theme: safeTheme(body.theme) } : {}),
    ...('panelTransparency' in body ? { panelTransparency: safePanelTransparency(body.panelTransparency) } : {}),
    ...('reduceMotion' in body ? { reduceMotion: body.reduceMotion === true } : {}),
    ...('hideBackground' in body ? { hideBackground: body.hideBackground === true } : {}),
    ...('hideBigFish' in body ? { hideBigFish: body.hideBigFish === true } : {}),
    ...('autoStart' in body ? { autoStart: Boolean(body.autoStart) } : {}),
    ...('seedMarket' in body ? { seedMarket: body.seedMarket !== false } : {}),
    ...('autoDisablePlugins' in body ? { autoDisablePlugins: body.autoDisablePlugins !== false } : {}),
  })
  if ('autoStart' in body) {
    try {
      await setAutoStart(stored.autoStart)
    } catch (error) {
      pushLog(`开机自启未写入: ${error instanceof Error ? error.message : error}`)
    }
  }
  // 切换下载源后清掉更新检查的缓存，让新源立即生效（下载那侧每次现读，不用清）
  if ('downloadSource' in body) {
    remoteCache = { at: 0, data: null }
  }
  if ('updateSource' in body) {
    UPDATE_SOURCE = safeUpdateSource(stored.updateSource)
    selfCache = { at: 0, data: null }
    pushLog(`更新下载源改为 ${UPDATE_SOURCE === 'mirror' ? '国内加速' : '直连 GitHub'}`)
  }
  if ('openMode' in body) {
    OPEN_MODE = safeOpenMode(stored.openMode)
    pushLog(OPEN_MODE === 'app'
      ? '打开方式：应用窗口（找不到 Chrome/Edge 会退回标签页）'
      : OPEN_MODE === 'window'
        ? `打开方式：桌面窗口（${shellWindowHost() ? '启动器内嵌，不经过浏览器' : '当前没有原生外壳，会退回浏览器标签页'}）`
        : '打开方式：系统浏览器标签页')
  }
  if ('systemPath' in body) {
    SYSTEM_PATH = stored.systemPath === true
    const result = applySystemPath(SYSTEM_PATH)
    if (!result.ok) pushLog(`系统 PATH 未改：${result.message}`)
    else if (SYSTEM_PATH) writeDshShims(activeVersion() || '', { dir: result.dir })
  }
  if ('dshHome' in body) {
    const next = safeDshHome(stored.dshHome)
    const home = next || defaultDshHome()
    // 目录不存在就建出来，写不了直接报错——别等到下次启动 dsh 才发现
    if (next) await ensureWritableDir(home)
    if (next !== DSH_HOME_DIR) {
      DSH_HOME_DIR = next
      pushLog(`dsh 用户目录改为 ${home}${next ? '' : '（默认位置）'}；重启 dsh 后生效`)
    }
  }
  // profile 立即生效：插件页、启动参数、npmrc 都读这个变量（已经在跑的 dsh 不受影响）
  EXTRA_ARGS = composeExtraArgs(stored.args)
  WEB_BIND = safeWebBind(stored.webBind)
  LAN_TOGGLE = lanBindToggleOn(homeDir(), PROFILE_NAME)
  if (safeLang(stored.lang)) LANG = safeLang(stored.lang)
  THEME = safeTheme(stored.theme)
  PANEL_TRANSPARENCY = safePanelTransparency(stored.panelTransparency)
  REDUCE_MOTION = stored.reduceMotion === true
  HIDE_BACKGROUND = stored.hideBackground === true
  HIDE_BIG_FISH = stored.hideBigFish === true
  if (stored.profile && stored.profile !== PROFILE_NAME) {
    pushLog(`启动 profile 改为 ${stored.profile}`)
    PROFILE_NAME = stored.profile
  }
  if ('seedMarket' in body && stored.seedMarket) {
    const versions = listedVersions(await loadConfig())
    if (versions[0] && !pluginBusy) await seedMarket(versions[0])
  }
  await emitState()
  return publicSettings()
}

async function emitState() {
  const snap = await snapshot()
  emit('state', snap)
  for (const listener of stateListeners) {
    try { listener(snap) } catch { /* ignore tray listener errors */ }
  }
}

/** dsh 子进程与 AI 修复命令共用的环境变量（AI 靠这些变量拼出正确的 dsh 命令）。 */
export function dshEnv(version) {
  const home = homeDir()
  const workerCompat = existsSync(WORKER_COMPAT)
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_NODE: process.execPath,
    DSH_BIN: binPath(version),
    DSH_VERSION: version,
    DSH_PROFILE: PROFILE_NAME,
    // 只有「必须被 dsh 起的 worker 线程继承」的东西留在这里：worker 的 execArgv 是空的，
    // 命令行参数传不进去，只能靠 NODE_OPTIONS（这里只放文件名，目录靠下面的 NODE_PATH 传）。
    // dsh 自己要的那几个开关（--use-system-ca、--max-http-header-size、--import 钩子）走命令行，
    // 见 spawnDsh：NODE_OPTIONS 会被**所有**子进程继承，agent 在 shell 里跑的 node 万一是老版本，
    // 撞上 --use-system-ca 这种新开关会直接 bad option 退出。
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      workerCompat ? `--require ${basename(WORKER_COMPAT)}` : '',
    ].filter(Boolean).join(' '),
    npm_config_ignore_workspace_root_check: 'true',
    // 下载源也传给 dsh 子进程：插件安装/升级是 dsh 自己跑 pnpm，不传的话它会按 pnpm 自己的
    // 配置解析（多数机器上就是 npm 官方默认源），于是「检查更新」看的是设置里的源、真正装包
    // 却走另一个源。传下去之后全链路一致：选了哪个源，查版本、下 dsh、装插件都走它。
    npm_config_registry: currentRegistry(),
    // 末尾追加两个目录：先是启动器写的 dsh shim（node 写死成启动器自己的），再是版本自己的
    // .bin（里面有 cordis 之类的入口）。追加不插队 —— 用户自己的 dsh 仍然优先。
    PATH: withVersionBin(withBundledRuntime(process.env.PATH || ''), join(DATA, '.bin'), versionBinDir(version)),
  }
  if (workerCompat) {
    // NODE_PATH 是分号分隔的，条目本身带空格没关系，正好兜住带空格的安装路径
    env.NODE_PATH = [WORKER_COMPAT_DIR, process.env.NODE_PATH].filter(Boolean).join(delimiter)
  }
  return env
}

/** 某个 PATH 条目里是否已经能直接调到这个命令（Windows 上按 PATHEXT 补后缀猜）。 */
function hasCommand(dir, name) {
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : ['']
  return exts.some((ext) => existsSync(join(dir, name + ext)))
}

/**
 * 自带运行时的 PATH 排序（纯函数；目录是否真的存在由调用方判断）。
 *
 * 自带目录默认排最前，但系统 PATH 里**已经有 pnpm** 时例外：自带的 pnpm 8 默认
 * store 是 v3，而 pnpm 10/11 用 v11。比启动器装得还早的 profile，`.modules.yaml`
 * 里记的是当年那个全局 pnpm 的 v11 store；把自带 pnpm 顶到前面，pnpm 发现 store
 * 对不上就以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切 add/remove，插件页的卸载、更新
 * 全红（#12）。所以 pnpm 让系统的优先，node/npm 仍用自带的（插件里的原生模块
 * 指望它构建）——自带目录整体紧随其后，系统没有 pnpm 时行为照旧。
 */
export function orderRuntimePaths(parts, dir) {
  const rest = parts.filter((item) => item !== dir)
  // 用户自己的工具链优先：有 pnpm 的目录排最前（#12 的 store 错配），其次是带 node 的目录。
  // 自带运行时只是兜底 —— agent 在 shell 里跑的 node 应该是用户自己那个，而不是我们的 22.19。
  const pnpmDir = rest.find((item) => hasCommand(item, 'pnpm'))
  const nodeDir = rest.find((item) => hasCommand(item, 'node'))
  const head = [pnpmDir, nodeDir].filter((item, index, list) => item && list.indexOf(item) === index)
  return [...head, dir, ...rest.filter((item) => !head.includes(item))]
}

/**
 * 把便携运行时的目录放到 PATH 最前面。
 *
 * `dsh plugin` 是 pnpm 的透传器，装插件（含首次预装 dshmarket）必须有 pnpm；机器上
 * 有没有全局 pnpm 全看运气，所以安装包自带一份。另外插件里常带原生模块和 postinstall
 * 构建脚本，也指望能就地找到 node/npm。系统里已经有 pnpm 时的排序见 orderRuntimePaths。
 */
/**
 * 当前版本自己的命令行入口目录（node_modules/.bin，里面有 dsh / cordis 这些 shim）。
 * 从 bin 路径往上找 node_modules，兼容「启动器装的版本」和「系统装的 dsh」两种布局。
 */
function versionBinDir(version) {
  let dir = dirname(binPath(version))
  for (let i = 0; i < 5; i += 1) {
    if (basename(dir) === 'node_modules') return join(dir, '.bin')
    if (dir === dirname(dir)) break
    dir = dirname(dir)
  }
  return ''
}

/**
 * 写一份「跟着启动器当前版本走」的 dsh 命令行入口。
 *
 * 为什么不用版本目录里那个 .bin/dsh.cmd：它的 node 取自 PATH，而我们把用户自己的 node
 * 排在了前面（见 orderRuntimePaths），用户那套 node 要是太老就带不动 dsh。这里把启动器
 * 自己的 node 写死，`dsh` 在 shell 里就总是能跑起来，版本也跟着启动器选的那个走。
 */
export function writeDshShims(version, options = {}) {
  const target = options.dir ?? join(DATA, '.bin')
  const bin = options.bin ?? binPath(version)
  if (!existsSync(bin)) return ''
  try {
    mkdirSync(target, { recursive: true })
    const node = process.execPath
    writeFileSync(join(target, 'dsh.cmd'), `@ECHO off\r\n"${node}" "${bin}" %*\r\n`)
    const sh = join(target, 'dsh')
    writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${bin}" "$@"\n`)
    try {
      chmodSync(sh, 0o755)
    } catch { /* Windows 上无所谓 */ }
  } catch {
    return ''
  }
  return target
}

/**
 * 把当前版本的命令行入口追加到 PATH **末尾**：agent 在 shell 里就能直接 `dsh xxx`，
 * 版本跟着启动器选的那个走（pyenv 的 shim 就是这个意思）。
 *
 * 追加而不是插队：用户自己 PATH 上本来就有 dsh 时优先用他的，我们只在后面的位置兜底。
 */
export function withVersionBin(pathValue, ...binDirs) {
  const parts = String(pathValue).split(delimiter).filter(Boolean)
  const add = binDirs.filter((dir) => dir && existsSync(dir) && !parts.includes(dir))
  if (!add.length) return pathValue
  return [...parts, ...add].join(delimiter)
}

/** 系统 PATH 里那份 dsh shim 放哪儿：固定目录，和「版本目录」可配置这件事解耦。 */
export function systemBinDir() {
  return join(APP_DIR, 'bin')
}

/**
 * 在 PATH 字符串里加上/去掉一个目录（纯函数，方便单测）。
 * 加的时候追加在末尾，用户自己已有的命令仍然优先；去掉时清理空项与重复项。
 */
export function pathWithEntry(pathValue, dir, enabled) {
  const parts = String(pathValue || '').split(delimiter).map((item) => item.trim()).filter(Boolean)
  const without = parts.filter((item) => item.toLowerCase() !== String(dir).toLowerCase())
  const next = enabled ? [...without, dir] : without
  return next.join(delimiter)
}

/** 读/写用户级 PATH（Windows：HKCU\Environment，按 REG_EXPAND_SZ 原样写，不展开变量）。 */
function readUserPath() {
  const out = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true })
  if (out.status !== 0) return ''
  const line = (out.stdout || '').split(/\r?\n/).find((item) => /\bPath\b\s+REG_/i.test(item))
  if (!line) return ''
  return line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim()
}

function writeUserPath(value) {
  const out = spawnSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { encoding: 'utf8', windowsHide: true })
  return out.status === 0
}

/**
 * 把 dsh 的 shim 目录加进/移出用户 PATH。Windows 走 HKCU\Environment 的 Path；
 * 其他平台不改用户的环境（mac 的 PATH 在 shell 配置里，交给用户自己加）。
 */
export function applySystemPath(enabled) {
  const dir = systemBinDir()
  if (!IS_WINDOWS) {
    return { ok: false, dir, message: `${IS_MAC ? 'macOS' : '当前平台'}需要在 shell 配置里自己加：export PATH="${dir}:$PATH"` }
  }
  const next = pathWithEntry(readUserPath(), dir, enabled)
  if (!writeUserPath(next)) return { ok: false, dir, message: '写用户 PATH 失败（注册表 HKCU\Environment 不可写？）' }
  pushLog(enabled ? `已把 ${dir} 加到用户 PATH（新开的终端生效）` : `已把 ${dir} 从用户 PATH 移除`)
  return { ok: true, dir }
}

export function withBundledRuntime(pathValue) {
  const dir = join(ROOT, 'node')
  if (!existsSync(join(dir, NODE_BINARY))) return pathValue
  return orderRuntimePaths(String(pathValue).split(delimiter).filter(Boolean), dir).join(delimiter)
}

/** 当前 profile 目录。 */
/**
 * 插件安装/升级的进度事件：多带 kind 与插件名，页面据此画插件页自己的进度条。
 * 传 null 表示结束（页面上就是把进度条收起来）。
 */
function emitPluginProgress(state) {
  pluginProgress = state
  emit('progress', state ? { ...state, kind: 'plugin', name: pluginProgressName } : { phase: 'idle', kind: 'plugin' })
}

function profileDir() {
  return join(homeDir(), 'profiles', PROFILE_NAME)
}

/**
 * 当前是否按局域网绑定：设置里选了局域网，或远程访问插件的「局域网访问」开关
 * 开着。两者都是用户明确的局域网意图，任一条成立启动器就不再注入 --host。
 * 纯函数（参数缺省取模块状态），方便单测。
 */
export function lanBindActive(webBind = WEB_BIND, toggle = LAN_TOGGLE) {
  return webBind === 'lan' || toggle === true
}

/** 设置页的额外启动参数 + DSH.exe 命令行传来的参数，后者拼在后面（更具体，覆盖前者）。 */
function composeExtraArgs(settingsText) {
  return [...parseArgs(settingsText), ...CLI_ARGS]
}

/** 当前 profile 的用户补丁层：插件开关、MCP 条目、本地技能覆盖都写这里。 */
function patchFile() {
  return join(profileDir(), 'cordis.patch.yml')
}

/** 技能接口的统一载荷：列表 + 两个受管根 + 本地技能总开关状态。 */
function skillsPayload() {
  const roots = skillRoots(homeDir())
  return {
    skills: listSkills(roots),
    roots,
    localSkills: localSkillsEnabled(profileDir()),
  }
}

// ---- 同步：会话记录、附件与插件配置传到远端（S3 兼容对象存储 / WebDAV） ----

/** 同步接口的统一载荷：配置（含密钥，页面要回显）+ 可选项 + 正在跑的进度。 */
function syncPayload() {
  const store = storeConfig()
  return {
    store: store.store,
    storeTypes: STORE_TYPES,
    s3: S3_CONFIG,
    webdav: WEBDAV_CONFIG,
    folder: FOLDER_CONFIG,
    zip: ZIP_CONFIG,
    sync: SYNC_OPTIONS,
    scopes: SYNC_SCOPES,
    policies: [
      { id: 'skip', label: '保留本机', hint: '本机不动；远端那份也留着，下次换个策略再拉' },
      { id: 'overwrite', label: '用远端的覆盖本机', hint: '以远端为准（适合「刚换的新机器」）' },
      { id: 'duplicate', label: '两份都留', hint: '本机不动，远端那份另存成 …remote-日期 的文件' },
    ],
    styles: [
      { id: 'auto', label: '自动（IP 用路径风格，域名用虚拟主机）' },
      { id: 'path', label: '路径风格（MinIO / Ceph 等自建存储）' },
      { id: 'virtual', label: '虚拟主机（bucket.域名/…）' },
    ],
    homes: [
      { id: 'sessions', dir: join(homeDir(), 'sessions') },
      { id: 'attachments', dir: join(homeDir(), 'attachments') },
      { id: 'plugins', dir: profileDir() },
      { id: 'skills', dir: skillRoots(homeDir()).map((root) => root.dir).join('\n') },
      { id: 'memory', dir: join(homeDir(), 'memory') },
    ],
    home: homeDir(),
    profile: PROFILE_NAME,
    remoteUrl: storeDisplayUrl(store),
    configured: storeConfigured(store),
    missing: storeMissing(store),
    state: syncState,
    running: syncRunning,
  }
}

/** 同步进度的唯一出口：存一份给页面刷新时回放，再推给所有打开的页面。 */
function emitSync(state) {
  syncState = state
  emit('sync', state)
}

/**
 * 跑一次同步。POST 一直等到跑完才回（页面按钮期间禁用，和插件安装同一条路），
 * 过程靠 SSE 的 sync 事件画进度条；用户点「停止」时引擎会在下一个文件前收手。
 */
async function runSyncJob(mode, options = {}) {
  if (syncRunning) throw new Error('上一次同步还没结束')
  if (pluginBusy || installing) throw new Error('正在装插件或版本，等它结束再同步')
  const store = storeConfig()
  if (!storeConfigured(store)) throw new Error(`远端还没填完：${storeMissing(store).join('、')}`)
  const scopes = safeSyncSettings({
    store: options.store ?? SYNC_OPTIONS.store,
    scopes: options.scopes ?? SYNC_OPTIONS.scopes,
    policy: options.policy ?? SYNC_OPTIONS.policy,
  })
  const policy = scopes.policy
  const force = options.force === true
  const label = mode === 'up' ? '上传' : '下载'
  syncRunning = true
  syncStopRequested = false
  const startedAt = Date.now()
  emitSync({ phase: 'start', mode, done: 0, total: 0, at: startedAt })
  pushLog(`[同步] 开始${label}：${scopes.scopes.map(scopeLabel).join('、')} → ${storeDisplayUrl(store)}`)
  try {
    const summary = await runSync({
      mode,
      scopes: scopes.scopes,
      config: { ...store, store: scopes.store },
      policy,
      force,
      context: {
        home: homeDir(),
        profile: PROFILE_NAME,
        profileDir: profileDir(),
        roots: skillRoots(homeDir()),
      },
      log: (line) => pushLog(line),
      shouldStop: () => syncStopRequested,
      onProgress: (state) => emitSync({ ...state, mode, at: Date.now() }),
    })
    summary.seconds = Math.round((Date.now() - startedAt) / 1000)
    summary.mode = mode
    // 插件清单变了（合并出了新的插件）就把依赖装上，否则清单和 node_modules 对不上，
    // dsh 起来会说 cannot resolve profile bundle
    if (summary.manifestChanged && !summary.stopped) {
      try {
        const version = await pluginCommandVersion()
        emitSync({ phase: 'install', mode, label: '重装插件依赖', at: Date.now() })
        pushLog('[同步] 插件清单有变化，重装 profile 依赖…')
        pluginBusy = true
        await runProfileInstall(version)
        summary.installed = true
        summary.notes.push('插件依赖已重装')
      } catch (error) {
        summary.installError = error instanceof Error ? error.message : String(error)
        summary.notes.push(`插件依赖重装失败：${summary.installError}`)
        pushLog(`[同步] 插件依赖重装失败：${summary.installError}`)
      } finally {
        pluginBusy = false
        emitPluginProgress(null)
      }
    }
    if (mode === 'down' && current) {
      summary.notes.push('dsh 正在运行：新拉来的会话和插件要重启 dsh 才生效')
    }
    pushLog(`[同步] ${label}完成：上传 ${summary.uploaded} 个、下载 ${summary.downloaded} 个、清单合并 ${summary.merged} 处、跳过 ${summary.skipped} 个${summary.stopped ? '（已停止）' : ''}，用时 ${summary.seconds}s`)
    emitSync({ phase: 'done', mode, at: Date.now(), summary })
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    pushLog(`[同步] ${label}失败：${message}`)
    emitSync({ phase: 'error', mode, at: Date.now(), error: message })
    throw new Error(message)
  } finally {
    syncRunning = false
  }
}

/** 日志与摘要里的范围名。 */
function scopeLabel(id) {
  return SYNC_SCOPES.find((scope) => scope.id === id)?.label || id
}

/**
 * 连接自检：能走到远端、认证过不过、我们的目录里有没有东西。
 * 填错地址/密钥是最常见的失败，先有一次「点一下就知道」的检查，不用真的跑同步。
 */
async function testSyncConnection() {
  const store = storeConfig()
  const client = storeClient(store)
  const info = await client.test()
  pushLog(`[同步] 连接正常：${info.host}（${info.detail}），${info.namespace}/ ${info.empty ? '还没有内容' : '已有内容'}`)
  return info
}

/** dsh 启动参数。 */
function bootArgs() {
  if (lanBindActive()) {
    // 局域网：--host/--port 一个都不传。CLI 硬禁 --host 0.0.0.0，绑定只能走配置层
    // （远程插件的 lan-bind 开关写进 profile 补丁的 webserver 块）；--port 0 也一样
    // 会压过配置层，把插件钉好的端口抹成随机值，所以一并交给配置层决定。
    return [PROFILE_NAME, '--no-open', ...EXTRA_ARGS]
  }
  // 默认姿势：钉死回环 + 让 OS 挑端口（端口冲突顺延是 dsh 输出的事，启动器读真实地址）。
  // 额外参数放最后：用户可以用它覆盖 --port 之类（启动器是从 dsh 的输出里读真实地址的，
  // 所以换个端口也不影响管理页拿到的链接）
  return [PROFILE_NAME, '--host', '127.0.0.1', '--port', '0', '--no-open', ...EXTRA_ARGS]
}

/** dsh 子进程的加载钩子：启动加速 + 会话事件词汇兼容（含 worker 线程那份）。 */
const HOOKS = [
  join(ROOT, 'perf', 'register.mjs'),
  join(ROOT, 'compat', 'register.mjs'),
].filter((file) => existsSync(file))

/**
 * worker 线程用 --require 注入（execArgv 被清空，只有 NODE_OPTIONS 能传进去）。
 *
 * 注意 NODE_OPTIONS 是按空格分词的，写绝对路径时只要安装目录带空格（装到
 * `D:\Program Files\DSH` 这种），就会被切成半截路径，node 拿它去 require 直接
 * 起不来——报 `Cannot find module 'D:/Program'`。引号、反斜杠转义都救不了，所以
 * 这里改成把目录放进 NODE_PATH、NODE_OPTIONS 里只写不带空格的裸文件名；
 * NODE_PATH 是分号分隔的，条目带空格没问题。
 */
const WORKER_COMPAT = join(ROOT, 'compat', 'worker-events.cjs')
const WORKER_COMPAT_DIR = dirname(WORKER_COMPAT)

/**
 * 拉起 dsh 时的命令行参数。
 *
 * dsh 自己的开关（系统证书库、请求头上限、两个 ESM 补丁钩子）放这里而不是 NODE_OPTIONS：
 * NODE_OPTIONS 会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 万一是老版本，
 * 撞上 --use-system-ca 这类新开关就直接 bad option 退出。worker 线程那份 CJS 补丁仍在
 * NODE_OPTIONS 里（worker 的 execArgv 是空的，命令行传不进去），见 dshEnv。
 */
export function dshArgs(version, extra = []) {
  return [
    '--use-system-ca',
    '--max-http-header-size=131072',
    ...HOOKS.flatMap((file) => ['--import', pathToFileURL(file).href]),
    binPath(version),
    ...extra,
  ]
}

function spawnDsh(version, extra) {
  const home = homeDir()
  // 先把 dsh 的命令行入口写出来（PATH 里要用到），再拼参数
  writeDshShims(version)
  // 用户开了「加到系统 PATH」的话，稳定目录里那份也跟着当前版本走
  if (SYSTEM_PATH) writeDshShims(version, { dir: systemBinDir() })
  return spawn(process.execPath, dshArgs(version, extra), {
    cwd: home,
    env: dshEnv(version),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function ensureProfileNpmrc(profile = PROFILE_NAME) {
  const dir = join(homeDir(), 'profiles', profile)
  await mkdir(dir, { recursive: true })
  const file = join(dir, '.npmrc')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const missing = []
  if (!/(^|\n)ignore-workspace-root-check\s*=/.test(text)) missing.push('ignore-workspace-root-check=true')
  // dsh 自己的 profile 模板把 autoInstallPeers: false 写在 pnpm-workspace.yaml 里，
  // 但启动器内置的 pnpm 8 只认 .npmrc（那套设置要 pnpm 10.6 起才读 yaml）。一旦 pnpm
  // 自动装 peer，它会把所有插件对同一 @deepseek-ai/* 的 peer 区间求交，而求交库里
  // 的 stripSemVerPrerelease 会把预发布号删掉——^0.1.0-rc.8 ∩ ^0.1.2-rc.1 变成
  // `>=0.1.2 <0.2.0-0`，可这些包在 registry 上只有预发布版，于是整个安装在
  // ERR_PNPM_NO_MATCHING_VERSION 上硬失败。补这一行就等于替 pnpm 8 认下 dsh 的本意。
  if (!/(^|\n)auto-install-peers\s*=/.test(text)) missing.push('auto-install-peers=false')
  if (!missing.length) return
  const head = text && !text.endsWith('\n') ? `${text}\n` : text
  await writeFile(file, `${head}${missing.join('\n')}\n`)
}

async function fetchRemote() {
  if (remoteCache.data && Date.now() - remoteCache.at < 60_000) return remoteCache.data
  const info = await listPackage(PKG)
  const data = {
    package: PKG,
    source: 'https://github.com/deepseek-ai/deepseek-harness',
    tags: info.tags,
    versions: info.versions,
    // 「最新版」只在这里算一次，管理页和更新提示都读它，免得两处口径各算各的
    latest: latestRemoteFor({ tags: info.tags, versions: info.versions }),
  }
  remoteCache = { at: Date.now(), data }
  return data
}

function stripTag(tag) {
  return String(tag || '').trim().replace(/^v/i, '')
}

async function checkSelfUpdate() {
  const current = APP_VERSION
  const url = `https://github.com/${APP_REPO}/releases/latest/download/${APP_SETUP}`
  const fallback = { current, latest: null, update: false, url }
  if (selfCache.data && Date.now() - selfCache.at < 30 * 60 * 1000) return selfCache.data
  try {
    const latest = await fetchLatestTag()
    if (!latest) {
      // 连不上 GitHub 时别一声不吭：用户会以为「一直没有新版本」
      if (UPDATE_SOURCE !== 'mirror') {
        pushLog('[更新] 检查更新失败（连不上 GitHub）；设置页可把「更新下载源」改成「国内加速」再试')
      } else {
        pushLog('[更新] 检查更新失败：直连和加速镜像都没取到版本号')
      }
      return fallback
    }
    const cur = parseVer(current)
    const next = parseVer(latest)
    const update = Boolean(cur && next && cmpVer(next, cur) > 0)
    const data = { current, latest, update, url }
    selfCache = { at: Date.now(), data }
    return data
  } catch {
    return fallback
  }
}

async function fetchLatestTag() {
  const apiUrl = `https://api.github.com/repos/${APP_REPO}/releases/latest`
  const pageUrl = `https://github.com/${APP_REPO}/releases/latest`
  // 版本检查也走下载源：国内直连 api.github.com 常常超时或撞限流，选了「国内加速」就带镜像前缀
  for (const url of updateUrlCandidates(apiUrl, UPDATE_SOURCE)) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-launcher',
        },
      })
      if (!res.ok) continue
      const rel = await res.json()
      const tag = stripTag(rel.tag_name)
      if (tag) return tag
    } catch { /* 换下一个候选，最后再退回 HTML */ }
  }
  for (const url of updateUrlCandidates(pageUrl, UPDATE_SOURCE)) {
    try {
      const page = await fetch(url, {
        headers: { 'user-agent': 'dsh-launcher' },
        redirect: 'follow',
      })
      if (!page.ok) continue
      const match = /\/releases\/tag\/([^/?#]+)/.exec(page.url || '')
      if (match) return stripTag(decodeURIComponent(match[1]))
    } catch { /* 继续试下一个 */ }
  }
  return null
}

/**
 * 远端能给到的最新版。这里按用户的取舍把预发布也算数：装了 rc 的人应该被告知
 * 更新的 alpha，而不是被“稳定版”的字面口径挡住。只看 latest 标签不够——dsh
 * 常把新版本挂在 next / alpha 上。
 */
function latestRemoteFor(remote) {
  const candidates = []
  for (const name of ['latest', 'next', 'alpha']) {
    const tag = typeof remote.tags?.[name] === 'string' ? remote.tags[name].trim() : ''
    if (tag) candidates.push(tag)
  }
  for (const item of remote.versions || []) {
    if (item) candidates.push(item)
  }
  let best = ''
  let bestParsed = null
  for (const item of candidates) {
    const parsed = parseVer(item)
    if (!parsed) continue
    if (!bestParsed || cmpVer(parsed, bestParsed) > 0) {
      best = item
      bestParsed = parsed
    }
  }
  return best
}

/** 更高才算更新；相等或更低都不打扰。 */
function isNewer(latest, current) {
  const next = parseVer(latest)
  const cur = parseVer(current)
  return Boolean(next && cur && cmpVer(next, cur) > 0)
}

/**
 * 启动时要先问用户的那件事：dsh 本体或启动器自身有新版本。
 * 有就返回详情（调用方据此跳过自动启动），都最新返回 null。
 * 用户点过「不更新」的版本记在 settings 里，同一个版本不再问第二次。
 * 网络失败一律当作「没有更新」，不能因为拉不到远端就把启动卡住。
 */
export async function pendingUpdate() {
  const found = { dsh: null, self: null }
  let skipped = {}
  try {
    skipped = (await loadSettings()).skippedUpdate || {}
  } catch { /* 读不到设置就当没跳过 */ }
  try {
    const remote = await fetchRemote()
    const installed = listedVersions(await loadConfig())
    const current = installed[0] || ''
    const latest = remote.latest || ''
    if (isNewer(latest, current) && skipped.dsh !== latest) found.dsh = { current, latest }
  } catch { /* 拉不到远端就当没更新 */ }
  try {
    const self = await checkSelfUpdate()
    if (self.update && skipped.self !== self.latest) {
      found.self = { current: self.current, latest: self.latest, url: self.url }
    }
  } catch { /* 同上 */ }
  return found.dsh || found.self ? found : null
}

/**
 * 记住用户点过「不更新」的版本，下次启动不再拿同一个版本打扰。
 * 只收合法版本号，其余一律丢掉，免得把设置文件写脏。
 */
async function skipPendingUpdate(patch) {
  const saved = (await loadSettings()).skippedUpdate || {}
  const next = { ...saved }
  for (const key of ['dsh', 'self']) {
    const version = typeof patch?.[key] === 'string' ? patch[key].trim() : ''
    if (version && VERSION_RE.test(version)) next[key] = version
  }
  await saveSettings({ skippedUpdate: next })
  return { skippedUpdate: next }
}

const RELEASE_FEEDS = {
  dsh: 'https://github.com/deepseek-ai/deepseek-harness/releases.atom',
  self: `https://github.com/${APP_REPO}/releases.atom`,
}
const FEED_TTL_MS = 30 * 60 * 1000
const RELEASE_VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
const feedCache = new Map()

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * 把 release 正文的 HTML 折成 {type, text} 块。只认标题/段落/列表项，
 * 其余标签一律剥掉——远端 HTML 绝不能直接进页面。
 */
function parseNotes(html) {
  const text = decodeEntities(html)
    .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
  const blocks = []
  const re = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match
  while ((match = re.exec(text))) {
    const body = decodeEntities(match[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) continue
    const tag = match[1].toLowerCase()
    blocks.push({ type: tag === 'li' ? 'li' : tag[0] === 'h' ? 'h' : 'p', text: body })
  }
  return blocks
}

/** 拉某个仓库的 release 列表（缓存半小时）。atom 不走 API，不会撞未认证限流。 */
async function releaseFeed(kind) {
  const url = RELEASE_FEEDS[kind]
  if (!url) return []
  const hit = feedCache.get(kind)
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.entries
  const res = await fetch(url, { headers: { 'user-agent': 'dsh-launcher' } })
  if (!res.ok) throw new Error(`release feed ${res.status}`)
  const xml = await res.text()
  const entries = []
  for (const item of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = item[1]
    const title = decodeEntities((/<title>([\s\S]*?)<\/title>/.exec(body) || [])[1] || '').trim()
    const href = (/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(body) || [])[1] || ''
    const updated = (/<updated>([\s\S]*?)<\/updated>/.exec(body) || [])[1] || ''
    const content = (/<content[^>]*>([\s\S]*?)<\/content>/.exec(body) || [])[1] || ''
    // 版本号从标题和 tag 各取一次：dsh 是 v0.1.6-alpha.2 / dsh-v0.1.6-alpha.2，启动器是「DSH启动器 v0.1.5」
    const version = (RELEASE_VERSION_RE.exec(title) || RELEASE_VERSION_RE.exec(href) || [])[0] || ''
    if (!version) continue
    entries.push({ version, title, url: href, updated, content })
  }
  feedCache.set(kind, { at: Date.now(), entries })
  return entries
}

/**
 * 某个版本的更新内容。dsh 的正文是中英双语，只留中文那段；
 * 拿不到（版本比 feed 还老）就回 url 让调用方引导去看 release 页。
 */
async function releaseNotes(kind, version) {
  const wanted = String(version || '').trim()
  const fallbackUrl = RELEASE_FEEDS[kind] ? RELEASE_FEEDS[kind].replace(/\.atom$/, '') : ''
  if (!RELEASE_FEEDS[kind] || !wanted) return { found: false, url: fallbackUrl }
  let entries = []
  try {
    entries = await releaseFeed(kind)
  } catch {
    return { found: false, url: fallbackUrl }
  }
  const entry = entries.find((item) => item.version === wanted)
  if (!entry) return { found: false, url: fallbackUrl }
  const raw = decodeEntities(entry.content)
  const englishAt = raw.search(/id="[^"]*en-v[^"]*"/i)
  // 正文开头那行「中文 | English」是语言导航，不是变更内容
  const blocks = parseNotes(englishAt > 0 ? raw.slice(0, englishAt) : raw)
    .filter((block) => !/^(?:中文|English)(?:\s*\|\s*(?:中文|English))+$/i.test(block.text))
  return {
    found: true,
    version: entry.version,
    title: entry.title,
    url: entry.url,
    updated: entry.updated,
    blocks,
  }
}

async function installedPlugins() {
  const file = profileManifest()
  if (!existsSync(file)) return []
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    return Object.keys(manifest.dependencies ?? {}).sort()
  } catch {
    return []
  }
}

/**
 * 跑一条 `dsh plugin …`（透传给 pnpm），输出进日志。
 *
 * profile 与进度出口都能换：整合包要把同一套安装跑在别的 profile 上，进度也要画在
 * 整合包页自己的进度条里（默认是插件页那条）。
 */
function runPluginCommand(ver, args, label, options = {}) {
  const profile = options.profile || PROFILE_NAME
  const onProgress = options.onProgress || emitPluginProgress
  return new Promise((resolve, reject) => {
    const child = spawnDsh(ver, ['plugin', '--profile', profile, ...args])
    // 留一份输出尾巴挂在错误上：只报退出码的话调用方没法判断是哪种失败，只能瞎猜着重试
    const tail = []
    // pnpm 的进度：装插件可能几十秒，页面要有条能动的进度条，别只留一句「正在更新…」
    const progressState = { resolved: 0, reused: 0, downloaded: 0, added: 0, total: 0 }
    const keep = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const text = redact(line, secretValues)
        tail.push(text)
        if (tail.length > 40) tail.shift()
        pushLog(`[plugin] ${text}`)
        const progress = parsePnpmProgress(text, progressState)
        if (progress) onProgress(progress)
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else {
        const error = new Error(`${label} 退出码 ${code}`)
        error.tail = tail.slice(-40)
        reject(error)
      }
    })
  })
}

/**
 * 这个失败像是 pnpm 装 peer 撞出来的吗——只有这类才值得换掉 auto-install-peers 重试。
 * 插件声明的 @deepseek-ai/* peer 在 registry 上只有预发布版，pnpm 自动装 peer 会求交
 * 失败或 404。
 */
function looksLikePeerFailure(text) {
  return /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_PEER_DEP|auto-install-peers|peer dep|no matching version|404 Not Found/i.test(String(text || ''))
}

/**
 * 清掉 node_modules 里悬空的链接（断链），返回清掉的数量。
 *
 * Windows 上 pnpm 用 junction 把 node_modules 里的包指到 .pnpm，dsh 的模块回退也建成
 * junction。目标被删过之后（pnpm 存库清理、外部工具、同步软件）这些链接就悬空了：打开
 * 它会返回一个 libuv 认不出的 Win32 错误码——用户看到的就是 pnpm 报告安装成功、紧接着
 * "UNKNOWN: unknown error, open .../dshmarket/package.json"，退出码 -4094（UV_UNKNOWN）。
 *
 * 悬空的链接没有任何用处，摘掉它下次安装会重新建。注意只摘链接本身，不动目标。
 */
/**
 * 失败像是「这台机器读不了 junction」吗。
 *
 * 有用户的机器上 pnpm 报告装完了、却在回读自己刚建的 junction 时崩掉，报
 * `UNKNOWN: unknown error, open ...node_modules\<pkg>\package.json`，退出码 -4094
 * （libuv 的 UV_UNKNOWN，意思是碰到了一个它没有映射的 Win32 错误码）。那台机器上连
 * 用两个普通真实目录新建的 junction 都读不了——不是链接悬空，是链接根本没法被跟随。
 */
function looksLikeLinkFailure(text) {
  return /unknown error/i.test(String(text || '')) && /node_modules/i.test(String(text || ''))
}

/**
 * 让 pnpm 彻底不用链接：包平铺成真实目录、从存库复制而不是硬链。
 *
 * 这是上面那种机器唯一走得通的路（符号链接要管理员权限或开发者模式，junction 又读不了，
 * 没有第三种链接类型可用）。只在真撞上这个问题时才写，别去动本来正常的机器。
 * .npmrc 不在插件管理器的跟踪范围内，不会被它覆盖。
 */
async function useHoistedLinker(profile = PROFILE_NAME) {
  const file = join(homeDir(), 'profiles', profile, '.npmrc')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  if (/(^|\n)node-linker\s*=/.test(text)) return false
  const head = text && !text.endsWith('\n') ? `${text}\n` : text
  await writeFile(file, `${head}node-linker=hoisted\npackage-import-method=copy\n`)
  return true
}

function pruneDanglingLinks(dir, depth = 1) {
  let removed = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    let isLink = false
    try {
      isLink = lstatSync(path).isSymbolicLink()
    } catch {
      continue
    }
    if (!isLink) {
      // 带 scope 的包（@local/dsh-preset-advisor 这种）在 scope 目录里，只扫一层会漏掉，
      // 而悬空的恰恰常出现在那儿：dsh 报 cannot resolve 的正是它们。
      if (depth > 0 && entry.name.startsWith('@') && entry.isDirectory()) {
        removed += pruneDanglingLinks(path, depth - 1)
      }
      continue
    }
    try {
      statSync(path)          // 能 stat 到说明链接是通的
      continue
    } catch {
      try {
        unlinkSync(path)
        removed += 1
      } catch { /* 摘不掉就算了，别把安装本身搞挂 */ }
    }
  }
  return removed
}

async function addPlugin(version, spec) {
  const ver = safeVersion(version)
  const pkg = safeSpec(spec)
  if (pluginBusy) throw new Error('正在安装插件')
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  pluginBusy = true
  pluginProgressName = pkg
  emitPluginProgress({ phase: 'resolve' })
  await mkdir(homeDir(), { recursive: true })
  await ensureProfileNpmrc()
  const broken = pruneDanglingLinks(join(profileDir(), 'node_modules'))
  if (broken) pushLog(`先清理了 ${broken} 个悬空的链接（断链会让安装报 unknown error）`)
  pushLog(`安装插件 ${pkg} 到 web profile`)
  try {
    try {
      await runPluginCommand(ver, ['add', '-w', pkg], `dsh plugin add ${pkg}`)
    } catch (error) {
      const text = `${error instanceof Error ? error.message : error}\n${(error?.tail || []).join('\n')}`
      if (looksLikePeerFailure(text)) {
        // 插件声明的 @deepseek-ai/* peer 多为运行时注入、registry 上只有 prerelease，
        // pnpm 自动装 peer 会 404；关掉它重试一次（与插件市场同款做法）
        pushLog(`${error instanceof Error ? error.message : error}；改用不自动装 peer 重试`)
        await runPluginCommand(ver, ['add', '-w', pkg, '--config.auto-install-peers=false'], `dsh plugin add ${pkg}`)
      } else if (looksLikeLinkFailure(text) && await useHoistedLinker()) {
        // 这台机器读不了 junction（见 looksLikeLinkFailure 的说明）。让 pnpm 不用任何
        // 链接重来一次——有用户的机器上正是这两行解决了问题。
        pushLog('这台机器读不了目录链接，改用真实目录（node-linker=hoisted）重试')
        const broken = pruneDanglingLinks(join(profileDir(), 'node_modules'))
        if (broken) pushLog(`先清理了 ${broken} 个悬空的链接`)
        await runPluginCommand(ver, ['add', '-w', pkg], `dsh plugin add ${pkg}`)
      } else {
        // 认不出原因就不硬试：装不上就装不上，报出来让人看。
        // 原样重试没有意义——第一次失败的原因第二次还在，只会把终端刷满。
        throw error
      }
    }
    pushLog(`${pkg} 已在 web profile`)
  } finally {
    pluginBusy = false
    pluginProgressName = ''
    emitPluginProgress(null)
  }
}

// ---- 插件更新：查 registry 上的最新版本，按需升级 profile 里的包 ----
// 升级复用 addPlugin（peer 404、目录链接读不了这两套回退都在里面），装和升走同一条路。
const pluginUpdateCache = { at: 0, data: null }
const PLUGIN_UPDATE_TTL = 60 * 1000
const PLUGIN_UPDATE_CONCURRENCY = 4

/** 跑 dsh plugin 命令用哪个版本：正在跑的优先，其次配置里最新那个装好的。 */
async function pluginCommandVersion() {
  if (current?.version) return current.version
  const versions = listedVersions(await loadConfig()).filter((ver) => existsSync(binPath(ver)))
  if (!versions.length) throw new Error('没有可用的 dsh 版本，插件页暂时用不了')
  return versions[0]
}

/**
 * 每个第三方插件在 registry 上的最新版本。官方组件（@deepseek-ai/*）跳过——那些版本由 dsh 决定。
 * 插件多是预发布版，dist-tags.latest 不一定指向最新的那个，所以按版本号比出最大的一个。
 */
async function checkPluginUpdates({ force = false } = {}) {
  const now = Date.now()
  if (!force && pluginUpdateCache.data && now - pluginUpdateCache.at < PLUGIN_UPDATE_TTL) return pluginUpdateCache.data
  const queue = listPlugins(profileDir()).plugins.filter((plugin) => !plugin.official)
  const result = {}
  await Promise.all(Array.from({ length: Math.min(PLUGIN_UPDATE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const plugin = queue.shift()
      try {
        const { versions, tags } = await listPackage(plugin.name)
        const latest = versions[0] || ''
        const parsed = latest && plugin.version ? cmpVer(parseVer(latest), parseVer(plugin.version)) : 0
        result[plugin.name] = { current: plugin.version, latest, latestTag: tags.latest || '', hasUpdate: parsed > 0 }
      } catch (error) {
        // 某个包查不到就如实说查不到，别把整次检查拖挂（离线、私有包、镜像缺条目都会有）
        result[plugin.name] = {
          current: plugin.version,
          latest: '',
          hasUpdate: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  }))
  const data = { checkedAt: new Date().toISOString(), plugins: result }
  pluginUpdateCache.at = now
  pluginUpdateCache.data = data
  return data
}

/** 升一个插件到指定版本（缺省用最新版），升完回读磁盘确认版本真的换了。 */
async function updatePlugin(name, { latest = '' } = {}) {
  const plugin = listPlugins(profileDir()).plugins.find((item) => item.name === name)
  if (!plugin) throw new Error(`这个 profile 里没有 ${name}`)
  if (plugin.official) throw new Error(`${name} 是官方组件，版本跟着 dsh 走，不单独更新`)
  const target = latest || (await checkPluginUpdates({ force: true })).plugins[name]?.latest
  if (!target) throw new Error(`查不到 ${name} 的最新版本`)
  if (plugin.version && cmpVer(parseVer(target), parseVer(plugin.version)) <= 0) {
    return { name, from: plugin.version, to: plugin.version, changed: false }
  }
  pushLog(`更新插件 ${name}: ${plugin.version || '未知'} → ${target}`)
  await addPlugin(await pluginCommandVersion(), `${name}@${target}`)
  const after = listPlugins(profileDir()).plugins.find((item) => item.name === name)
  // addPlugin 只保证命令成功：装完再回读一次，别把「命令没报错」当成「版本真的换了」
  if (after?.version !== target) {
    throw new Error(`${name} 装完是 ${after?.version || '未知'}，不是 ${target}（看终端日志；杀软拦截、store 异常都会这样）`)
  }
  pluginUpdateCache.at = 0
  return { name, from: plugin.version, to: after.version, changed: true }
}

/** 依次更新所有可更新的插件：单个失败不影响其它，最后如实汇总。 */
async function updateAllPlugins() {
  const check = await checkPluginUpdates({ force: true })
  const names = Object.entries(check.plugins).filter(([, info]) => info.hasUpdate).map(([name]) => name)
  const done = []
  const failed = []
  for (const name of names) {
    try {
      done.push(await updatePlugin(name, { latest: check.plugins[name].latest }))
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { checked: names.length, done, failed }
}


/**
 * 跑一次 `dsh plugin install`（把 profile 清单里的依赖装齐）。
 *
 * 写在这儿的理由：每次都得带上「这台机器读不了目录链接」那条退路（改用真实目录重试），
 * 启动自愈和同步拉回插件清单两条路都要它。调用方负责 pluginBusy 与进度条的收发。
 */
async function runProfileInstall(version, options = {}) {
  const profile = options.profile || PROFILE_NAME
  const onProgress = options.onProgress
  const log = options.log || pushLog
  const target = () => join(homeDir(), 'profiles', profile)
  const run = () => runPluginCommand(version, ['install', '--config.auto-install-peers=false'], 'dsh plugin install', { profile, onProgress })
  await mkdir(homeDir(), { recursive: true })
  await ensureProfileNpmrc(profile)
  try {
    await run()
  } catch (error1) {
    const text = `${error1 instanceof Error ? error1.message : error1}\n${(error1?.tail || []).join('\n')}`
    // 和装插件那条路同样的退路：这台机器读不了目录链接时，让 pnpm 改用真实目录再装一遍。
    // 报错长这样：UNKNOWN: unknown error, open ...node_modules\<pkg>\package.json（-4094）
    if (!looksLikeLinkFailure(text) || !(await useHoistedLinker(profile))) throw error1
    log('这台机器读不了目录链接，改用真实目录（node-linker=hoisted）重试')
    const again = pruneDanglingLinks(join(target(), 'node_modules'))
    if (again) log(`先清理了 ${again} 个悬空的链接`)
    await run()
  }
}

/**
 * profile 依赖自愈：dsh 报 `cannot resolve profile bundle "x"` 说明 profile 的
 * node_modules 里那个包不在（没装成，或 pnpm 中途被打断只留了断链），按 dsh 的
 * 提示重装 profile 依赖即可。
 * @returns 是否值得重试启动
 */
async function repairProfileDeps(version, error) {
  const failure = error?.failure || lastFailure
  const bundles = parseUnresolvedBundles(`${failure?.message || ''}\n${(failure?.tail || []).join('\n')}`)
  if (!bundles.length) return false
  if (pluginBusy) {
    pushLog(`[兼容] profile 里解析不到 ${bundles.join('、')}，但正在装插件，跳过依赖重建`)
    return false
  }
  const broken = pruneDanglingLinks(join(profileDir(), 'node_modules'))
  if (broken) pushLog(`[兼容] 先清理了 ${broken} 个悬空的链接`)
  pushLog(`[兼容] profile 里解析不到 ${bundles.join('、')}，重建 profile 依赖（dsh plugin install）…`)
  pluginBusy = true
  try {
    await runProfileInstall(version)
    pushLog('[兼容] profile 依赖已重建，重试启动…')
    return true
  } catch (error2) {
    pushLog(`[兼容] 重建 profile 依赖失败：${error2 instanceof Error ? error2.message : error2}`)
    return false
  } finally {
    pluginBusy = false
  }
}

// 这次运行里预装已经失败过。启动失败时的自动修复会重跑启动流程，每次都重试预装的话
// 会把失败信息刷满终端，而失败原因并不会自己消失——留到下次启动再试。
let marketSeedFailed = false

/**
 * dsh 实际加载哪些插件，看的是 profile 清单里的 dsh.profile.bundles。
 * 「依赖里有 + 目录里有」不等于它会跑起来——装上了却没启用时，插件市场就是不会出现。
 */
async function registeredBundles() {
  try {
    const manifest = JSON.parse(await readFile(profileManifest(), 'utf8'))
    const list = manifest?.dsh?.profile?.bundles
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 把包装进 dsh.profile.bundles——dsh 插件管理器点「启用」写的就是这里。 */
async function registerBundle(name) {
  const file = profileManifest()
  let manifest
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 清单还没有或读不动：这一步只是补启用，不在这里造文件
    return false
  }
  if (!manifest || typeof manifest !== 'object') return false
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh ? manifest.dsh : (manifest.dsh = {})
  const profile = typeof dsh.profile === 'object' && dsh.profile ? dsh.profile : (dsh.profile = {})
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : (profile.bundles = [])
  if (bundles.includes(name)) return false
  bundles.push(name)
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

async function seedMarket(version) {
  const settings = await loadSettings()
  if (settings.seedMarket === false) return
  if (marketSeedFailed) return
  const plugins = await installedPlugins()
  // 三条都成立才算装好了，少一条都要修：
  // 1) 清单里有——pnpm 中途失败或被杀毒软件拦下时，清单里留了名字却只有一个空壳目录
  //    （正是 "unknown error, open ...dshmarket\package.json" 那种）；
  // 2) 文件真的在——只看清单会把空壳当成装好了，那个坏目录就永远修不回来；
  // 3) 在 dsh.profile.bundles 里——少了这条，包是装上了但 dsh 不会加载它，市场不出现，
  //    而前两条都成立，于是预装再也不会重试（这个缺口让市场一直缺席）。
  const listed = plugins.includes(MARKET_PKG)
  const onDisk = existsSync(join(profileDir(), 'node_modules', MARKET_PKG, 'package.json'))
  const bundled = (await registeredBundles()).includes(MARKET_PKG)
  if (listed && onDisk && bundled) return
  try {
    // 只有「包不在」才真的需要跑 pnpm；包在、只是没启用的话补一句启用就够了，
    // 不必每次都去跑一遍注定失败的安装
    if (!listed || !onDisk) await addPlugin(version, MARKET_PKG)
    if (await registerBundle(MARKET_PKG)) {
      pushLog(`已把 ${MARKET_PKG} 加入 profile 的 bundle 列表，重启后市场就会出现`)
    }
  } catch (error) {
    marketSeedFailed = true
    pushLog(`预装 dshmarket 失败: ${error instanceof Error ? error.message : error}（本次运行不再重试，可在插件页手动安装）`)
  }
}

// ---- 整合包：把一批插件 + 一套配置一次装进一个 profile ----
//
// 与插件页的分工：插件页管「一个包」，整合包页管「一套环境」——一次写进 package.json 的
// 依赖与层栈、补丁层、用户级文件，再走同一条 `dsh plugin install` 把依赖装齐。格式用的是
// 生态里的 .dspack（DSH-PackForge），详情见 packs.js。
//
// 装进新 profile 是默认姿势：dsh 一次只跑一个 profile，新环境与现有插件互不污染，
// 装完在插件页切过去就行。每一步都可能失败（下载、解包、写文件、pnpm），所以每次安装
// 之前先备份被覆盖的文件，失败自动回滚。

/** 整合包的进度：走 SSE 的 progress 事件，靠 kind 与插件页那条区分开。 */
let packProgress = null
let packProgressName = ''
/** 检查过的包先放这儿，安装时不用再下载一遍（页面刷新也还在）。 */
const packInspectCache = new Map()
/** 市场索引缓存：一次列表拉几百 KB，别每开一次页面就重下一遍。 */
let packsMarketCache = { at: 0, data: null }
const PACK_MARKET_TTL = 10 * 60 * 1000
/** 检查过的包最多留多久（inbox 里的临时文件）。 */
const PACK_INBOX_TTL = 6 * 60 * 60 * 1000
/** 最近一次导出的文件：只允许「在文件夹里显示」我们自己的产物。 */
let lastExportPath = ''

function packsDir() {
  return join(DATA, 'packs')
}

function packInboxDir() {
  return join(packsDir(), 'inbox')
}

function newPackToken() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function emitPackProgress(state) {
  packProgress = state
  emit('progress', state ? { ...state, kind: 'pack', name: packProgressName } : { phase: 'idle', kind: 'pack' })
}

/** 整合包页的载荷：已装的包、可切换的 profile、市场地址。 */
function packsPayload() {
  const state = readPackState(DATA)
  const profilesRoot = join(homeDir(), 'profiles')
  const cards = []
  for (const profile of listProfiles()) {
    let plugins = []
    try {
      plugins = listPlugins(join(profilesRoot, safeProfile(profile))).plugins
    } catch {
      continue
    }
    // 空 profile（dsh 自带模板、刚建还没装东西的）不发卡：列出来全是空盒子
    if (!plugins.length) continue
    const thirdParty = plugins.filter((plugin) => !plugin.official)
    const records = state.packs.filter((record) => record.profile === profile)
    const latest = records.length ? records[records.length - 1] : null
    cards.push({
      profile,
      // 卡片标题就是 profile 名（dsh 和插件页的 profile 切换器都这么叫它）
      name: profile,
      pluginCount: plugins.length,
      officialCount: plugins.length - thirdParty.length,
      // 整包开关说的是「这个环境里的插件」，官方组件不参与
      enabled: thirdParty.some((plugin) => plugin.enabled),
      toggleable: thirdParty.some((plugin) => plugin.toggleable),
      plugins,
      // 来源：装过整合包就带上包的信息与安装记录；手动拼的 profile 记录为空
      records,
      source: latest?.source || '',
      installedAt: latest?.installedAt || '',
      packName: latest ? (latest.displayName || latest.name) : '',
      packVersion: latest?.version || '',
      createdProfile: records.some((record) => record.createdProfile === true),
      template: TEMPLATE_PROFILES.includes(profile),
    })
  }
  // 当前 profile 排最前，其余按插件数量从多到少
  cards.sort((a, b) => {
    if (a.profile === PROFILE_NAME) return -1
    if (b.profile === PROFILE_NAME) return 1
    return b.pluginCount - a.pluginCount
  })
  return {
    packs: cards,
    profile: PROFILE_NAME,
    home: homeDir(),
    profiles: listProfiles(),
    marketUrl: process.env.DSH_PACK_MARKET || MARKET_INDEX_URL,
    busy: pluginBusy,
    progress: packProgress,
  }
}

/**
 * 网络失败的说明：undici 只会给一句 `fetch failed`，真正的原因藏在 error.cause 里。
 *
 * 国内最常见的两种断法「看起来一模一样、其实完全不同」，光看 fetch failed 猜不到该做什么：
 * - raw.githubusercontent.com（市场索引在那儿）的 **DNS 被污染**：解析成 0.0.0.0 / 空地址，
 *   请求还没出门就失败（实测 cause 是 ENOENT，秒回）；
 * - github.com（release 资产那儿）**443 连不上**：解析正常，但一路等到超时（约 21 秒）。
 * 所以这里把域名、原因和出路都写进错误里，页面直接显示给用户看。
 */
function describeFetchError(error, url = '') {
  const cause = error?.cause
  const code = String(cause?.code || cause?.errno || '').toUpperCase()
  const causeMessage = String(cause?.message || '')
  const host = (() => {
    try {
      return new URL(String(url)).host
    } catch {
      return ''
    }
  })()
  if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${host || '域名'} 解析不出来（DNS 返回了空地址，通常是 DNS 被污染）`
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
    return `连不上 ${host || '目标'}（${code}）`
  }
  if (/certificate|self.signed|CERT_|TLS|SSL/i.test(causeMessage)) {
    return `${host || '目标'} 的证书校验不过（${causeMessage}）`
  }
  const detail = error?.message || '请求失败'
  return `${host ? `${host}：` : ''}${detail}${code ? `（${code}）` : ''}`
}

/** 下载上限：整合包只装清单与配置，超过这个量级的多半不是包（也免得把内存吃光）。 */
const PACK_DOWNLOAD_LIMIT = 64 * 1024 * 1024

async function downloadToFile(url, dest, { sha256 = '', log = pushLog, onProgress } = {}) {
  const candidates = updateUrlCandidates(url, UPDATE_SOURCE)
  let last = null
  for (const candidate of candidates) {
    try {
      log(`下载 ${candidate}`)
      const res = await fetch(candidate, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      if (total > PACK_DOWNLOAD_LIMIT) throw new Error(`文件太大（${Math.round(total / 1048576)} MB，上限 ${PACK_DOWNLOAD_LIMIT / 1048576} MB）`)
      const chunks = []
      let done = 0
      for await (const chunk of res.body) {
        chunks.push(chunk)
        done += chunk.length
        if (done > PACK_DOWNLOAD_LIMIT) throw new Error(`下载超过上限（${PACK_DOWNLOAD_LIMIT / 1048576} MB），已停下`)
        onProgress?.({ phase: 'download', done, total })
      }
      const buffer = Buffer.concat(chunks)
      if (total && buffer.length !== total) throw new Error(`下载不完整（${buffer.length}/${total} 字节）`)
      if (sha256) {
        const got = createHash('sha256').update(buffer).digest('hex')
        if (got !== String(sha256).toLowerCase()) {
          throw new Error(`校验对不上（期望 ${String(sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
        }
      }
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, buffer)
      return { url: candidate, bytes: buffer.length }
    } catch (error) {
      last = error
      log(`下载失败：${error.message}`)
    }
  }
  // 直连 GitHub 在国内基本拿不到 release 资产，而「更新下载源」默认是直连——
  // 失败时把出路写进错误里（和启动器自更新那句同样的写法），否则用户只看到「下载失败」
  const hint = UPDATE_SOURCE === 'mirror' ? '' : '；如果直连 GitHub 不通，可以在设置页把「更新下载源」改成「国内加速」再试'
  throw new Error(`下载失败：${describeFetchError(last, url)}${hint}`)
}

/** GitHub 接口的确定性回答：这类错误换镜像也没用，直接报出来。 */
const GITHUB_FINAL_RE = /找不到|还没有发布|限流/

/**
 * 从 GitHub 仓库取整合包：release 资产里的 .dspack（其次 .zip）。
 * 这是生态里的发布约定（仓库打 dsh-pack topic + Release 挂 .dspack）。
 */
async function resolveGithubPack(repo, ref, log = pushLog) {
  const clean = String(repo).replace(/\.git$/i, '')
  const api = ref
    ? `https://api.github.com/repos/${clean}/releases/tags/${encodeURIComponent(ref)}`
    : `https://api.github.com/repos/${clean}/releases/latest`
  let payload = null
  let last = null
  for (const candidate of updateUrlCandidates(api, UPDATE_SOURCE)) {
    try {
      const res = await fetch(candidate, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-x' } })
      if (res.status === 404) throw new Error(ref ? `找不到 ${clean} 的 ${ref} 这个发布` : `${clean} 还没有发布过 release`)
      if (res.status === 403 || res.status === 429) {
        throw new Error('GitHub 接口限流了（匿名每小时 60 次）：过一会儿再试，或者直接把 release 里的 .dspack 链接贴进来')
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      payload = await res.json()
      break
    } catch (error) {
      last = error
      log(`取 release 信息失败：${error.message}`)
      if (GITHUB_FINAL_RE.test(error.message)) throw error
    }
  }
  if (!payload) throw last || new Error('取 release 信息失败')
  const assets = Array.isArray(payload.assets) ? payload.assets : []
  const asset = assets.find((item) => /\.dspack$/i.test(item.name)) || assets.find((item) => /\.zip$/i.test(item.name))
  if (!asset) {
    throw new Error(`${clean} 的${ref ? ` ${ref}` : '最新'} release 里没有 .dspack/.zip 资产${assets.length ? `（只有 ${assets.map((item) => item.name).join('、')}）` : ''}`)
  }
  return { url: asset.browser_download_url, name: asset.name, size: asset.size, sha256: '', version: payload.tag_name || '', repo: clean }
}

function normalizeMarketEntry(item) {
  const downloadUrl = String(item?.downloadUrl || item?.url || '')
  return {
    id: String(item?.id || `${item?.owner || ''}.${item?.repo || item?.name || ''}`),
    name: String(item?.name || ''),
    version: String(item?.version || ''),
    type: String(item?.type || 'profile'),
    displayName: localized(item?.displayName, LANG) || String(item?.name || ''),
    description: localized(item?.description, LANG),
    author: String(item?.author || item?.owner || ''),
    category: String(item?.category || ''),
    dshVersion: String(item?.dshVersion || ''),
    bundleCount: Number(item?.bundleCount) || 0,
    depCount: Number(item?.depCount) || 0,
    size: Number(item?.size) || 0,
    sha256: String(item?.sha256 || ''),
    updatedAt: String(item?.updatedAt || ''),
    downloadUrl,
    manifestVersion: Number(item?.manifestVersion) || 0,
  }
}

/** 读整合包市场索引（PackForge 的公开索引：仓库打 dsh-pack topic 就会被采集进去）。 */
async function marketEntries({ force = false } = {}) {
  const now = Date.now()
  if (!force && packsMarketCache.data && now - packsMarketCache.at < PACK_MARKET_TTL) return packsMarketCache.data
  const url = process.env.DSH_PACK_MARKET || MARKET_INDEX_URL
  let last = null
  for (const candidate of updateUrlCandidates(url, UPDATE_SOURCE)) {
    try {
      const res = await fetch(candidate, { headers: { 'user-agent': 'dsh-x' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const index = await res.json()
      const list = Array.isArray(index?.modpacks) ? index.modpacks
        : Array.isArray(index?.packs) ? index.packs
          : Array.isArray(index) ? index : []
      const data = {
        url,
        entries: list.map(normalizeMarketEntry).filter((entry) => entry.downloadUrl && entry.name),
        generatedAt: String(index?.generatedAt || ''),
        fetchedAt: new Date().toISOString(),
      }
      packsMarketCache = { at: now, data }
      return data
    } catch (error) {
      last = error
    }
  }
  throw new Error(`读整合包市场失败：${describeFetchError(last, url)}`)
}

/**
 * 打开一个来源（本地文件/目录直接用，网络来源下到 inbox），返回解析好的包。
 * token 由调用方给：同一个 token 的临时文件留给安装那一步用。
 */
async function openPackSource(source, { token = newPackToken(), log = pushLog, onProgress } = {}) {
  const parsed = typeof source === 'string' ? parsePackSource(source) : source
  if (parsed.kind === 'dir') {
    return { pack: parsePackDir(parsed.path), file: parsed.path, source: describeSource(parsed), token }
  }
  if (parsed.kind === 'file') {
    if (!/\.(?:dspack|zip)$/i.test(parsed.path)) log(`按压缩包读取（扩展名不是 .dspack）：${basename(parsed.path)}`)
    const buffer = await readFile(parsed.path)
    return { pack: parsePackArchive(buffer), file: parsed.path, source: describeSource(parsed), token }
  }
  const dir = join(packInboxDir(), token)
  const dest = join(dir, 'pack.dspack')
  let url = parsed.url || ''
  let sha256 = parsed.sha256 || ''
  let resolved = ''
  if (parsed.kind === 'github') {
    const info = await resolveGithubPack(parsed.repo, parsed.ref, log)
    url = info.url
    resolved = `${info.repo}${info.version ? ` ${info.version}` : ''}`
  }
  if (parsed.kind === 'market') resolved = parsed.id || ''
  if (!url) throw new Error('这个来源没有可下载的地址')
  onProgress?.({ phase: 'fetch', done: 0, total: Number(parsed.size) || 0 })
  const info = await downloadToFile(url, dest, {
    sha256,
    log,
    // 阶段名统一由这边定：下载整合包是 fetch，装依赖才是 install（pnpm 自己的相位放在 step 里）
    onProgress: onProgress ? (state) => onProgress({ phase: 'fetch', done: state.done, total: state.total }) : undefined,
  })
  onProgress?.({ phase: 'unpack', done: 0, total: 0 })
  return {
    pack: parsePackArchive(await readFile(dest)),
    file: dest,
    source: resolved || describeSource(parsed),
    token,
    bytes: info.bytes,
  }
}

/** 检查结果 + 安装计划：页面上的「装什么、装到哪、会覆盖什么」都是它。 */
function packPlanPayload(pack, profile = '') {
  const target = safeProfile(profile || defaultProfileFor(pack))
  const base = { pack: packSummary(pack), target: { profile: target } }
  try {
    const plan = planInstall(pack, { home: homeDir(), profile: target, hostProfile: PROFILE_NAME })
    return {
      ...base,
      ok: pack.ok && plan.ok,
      target: { profile: target, createsProfile: plan.createsProfile, profileDir: plan.profileDir },
      plan: {
        notes: plan.notes,
        warnings: plan.warnings,
        errors: plan.errors,
        writes: plan.writes.map((write) => ({ rel: write.rel, kind: write.kind || '', note: write.note || '' })),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, ok: false, plan: { notes: [], warnings: pack.warnings, errors: [...pack.errors, message], writes: [] } }
  }
}

/** 清掉过期的 inbox（检查过但一直没装的包）。 */
async function prunePackInbox() {
  const root = packInboxDir()
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const deadline = Date.now() - PACK_INBOX_TTL
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    try {
      if (statSync(full).mtimeMs < deadline) await rm(full, { recursive: true, force: true })
    } catch {
      // 删不掉就算了，下次再试
    }
  }
}

async function install(version) {
  const ver = safeVersion(version)
  if (installing) throw new Error(`正在安装 ${installing}`)
  const config = await loadConfig()
  if (listedVersions(config).includes(ver) || existsSync(binPath(ver))) {
    if (!listedVersions(config).includes(ver)) {
      config.versions = [ver, ...listedVersions(config)]
      await saveConfig(config)
      await emitState()
    }
    return
  }

  installing = ver
  installProgress = { phase: 'resolve' }
  await emitState()
  emit('progress', installProgress)
  const dir = versionDir(ver)
  await mkdir(dir, { recursive: true })
  pushLog(`安装 ${PKG}@${ver}`)
  try {
    await installSpec(dir, PKG, ver, (line, progress) => {
      // 「已安装 N/N」「已解析 N」只是进度，进度条那边（progress 事件）已经在显示了；
      // 再打进终端就是刷屏——装 700 多个包能刷出上百行。
      if (line && !NOISY_LOG_RE.test(line)) pushLog(line)
      if (progress) {
        installProgress = progress
        emit('progress', progress)
      }
    })
    if (!existsSync(binPath(ver))) throw new Error('安装完成但找不到 lib/bin.js')
    await mkdir(homeDir(), { recursive: true })
    config.versions = [ver, ...listedVersions(config).filter((item) => item !== ver)]
    await saveConfig(config)
    pushLog(`${ver} 安装完成`)
    await seedMarket(ver)
    // 装完新版顺手清掉更旧的（保留最新 + 最近装的一个，正在跑的除外）
    await pruneVersions(config)
  } catch (error) {
    if (!listedVersions(config).includes(ver)) {
      await rm(dir, { recursive: true, force: true })
    }
    throw error
  } finally {
    installing = null
    installProgress = null
    emit('progress', { phase: 'idle' })
    await emitState()
  }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

function attachProcess(version, child) {
  current = { version, child, status: 'starting', url: null, tail: [], exit: null }
  const proc = current
  const onChunk = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        proc.tail.push(line)
        if (proc.tail.length > 200) proc.tail.shift()
      }
      pushLog(line)
      const match = line.match(READY_RE)
      if (match && proc.status === 'starting') {
        proc.url = match[1]
        proc.status = 'running'
        emitState()
      }
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('exit', (code, signal) => {
    proc.exit = { code, signal }
    pushLog(`已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    if (current?.child === child) {
      current = null
      lastHealth = null
    }
    emitState()
  })
  return proc
}

async function waitUntilReady(proc, version) {
  const started = Date.now()
  const label = version
  while (proc.status === 'starting') {
    if (current !== proc) throw new Error(`${label} 启动失败`)
    if (Date.now() - started > START_TIMEOUT_MS) {
      killTree(proc.child.pid)
      throw new Error(`${label} 启动超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!proc.url) throw new Error(`${version} 启动失败`)
  return { url: proc.url }
}

/**
 * 页面自检：按浏览器的方式抓一次 app 页面（token 换 cookie），把页面引用的所有
 * 客户端插件包请求一遍。dsh 进程活着不等于页面打得开——实例切换后浏览器里的旧
 * 页面会一直报「bundle script failed to load」，这一步用来区分"实例有问题"和
 * "你看的是旧页面"。
 * @returns {{origin: string, total: number, ok: number, failed: Array<{url: string, status: number, error?: string}>}}
 */
export async function checkWebPage(origin, token) {
  const base = String(origin).replace(/\/+$/, '')
  const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const cookie = (first.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ')
  const headers = cookie ? { cookie } : {}
  const page = await fetch(`${base}/`, { headers, signal: AbortSignal.timeout(15000) })
  const html = await page.text()
  const urls = pageBundleUrls(html)
  const failed = []
  let ok = 0
  for (const url of urls) {
    try {
      const res = await fetch(`${base}${url}`, { headers, signal: AbortSignal.timeout(30000) })
      await res.arrayBuffer()
      if (res.status === 200) ok += 1
      else failed.push({ url, status: res.status })
    } catch (error) {
      failed.push({ url, status: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { origin: base, total: urls.length, ok, failed }
}

/**
 * 从 app 页面 HTML 里挑出客户端插件包的地址。
 *
 * dsh 0.1.7 起页面里写的是**相对地址**（`plugins/…`，没有前导斜杠），0.1.6 及以前是
 * `/plugins/…`。只认绝对地址的话，0.1.7 上会一条都抓不到，然后自检报「0 个全部正常」——
 * 既没检到东西、又盖住了真正的加载失败（issue #24 的附带发现）。两种都认，统一成绝对路径。
 * @returns {string[]} 去重后的绝对路径
 */
export function pageBundleUrls(html) {
  const urls = new Set()
  for (const match of String(html).matchAll(/(?:^|["'\s(=,])(\.?\/?plugins\/[^"'\s<>)]+)/gm)) {
    const raw = match[1].replaceAll('&amp;', '&')
    urls.add(raw.startsWith('/') ? raw : `/${raw.replace(/^\.\//, '')}`)
  }
  return [...urls]
}

/** 启动成功后异步自检并把结论写进状态（失败不影响运行中的实例）。 */
async function selfCheckPage(url, version) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/.exec(String(url || ''))
  if (!match) return
  try {
    const result = await checkWebPage(`http://127.0.0.1:${match[1]}`, match[2])
    lastHealth = {
      at: Date.now(),
      version,
      url,
      total: result.total,
      ok: result.ok,
      failed: result.failed.slice(0, 8),
    }
    if (result.total === 0) {
      // 一条都没抓到＝这次自检没得出结论，别写成「0 个全部正常」骗自己（dsh 换过引用方式）
      pushLog('页面自检：没在页面里找到客户端插件包引用（dsh 可能换了引用方式），这次没得出结论')
    } else if (result.failed.length) {
      pushLog(`页面自检：${result.ok}/${result.total} 个客户端插件包正常，${result.failed.length} 个失败`)
      for (const item of result.failed.slice(0, 5)) pushLog(`[自检] HTTP ${item.status || '-'} ${item.url.slice(0, 160)}`)
    } else {
      pushLog(`页面自检：${result.total} 个客户端插件包全部正常`)
    }
    await emitState()
  } catch (error) {
    pushLog(`页面自检没跑成：${error instanceof Error ? error.message : error}`)
  }
}

/** 起一个 web 子进程并等到它打印就绪 URL；失败时把子进程输出尾巴留给 AI 当证据。 */
async function bootOnce(ver) {
  await mkdir(homeDir(), { recursive: true })
  await seedMarket(ver)
  pushLog(`启动 ${ver} · profile ${PROFILE_NAME}${lanBindActive() ? ' · Web 绑定 局域网(0.0.0.0，由配置层决定)' : ''}`)
  const child = spawnDsh(ver, bootArgs())
  const proc = attachProcess(ver, child)
  await emitState()
  try {
    const result = await waitUntilReady(proc, ver)
    lastHealth = null
    await emitState()
    void selfCheckPage(result.url, ver)
    return result
  } catch (error) {
    const failure = {
      at: Date.now(),
      version: ver,
      message: error instanceof Error ? error.message : String(error),
      exit: proc.exit,
      tail: (proc.tail || []).slice(-120),
    }
    lastFailure = failure
    try {
      error.failure = failure
    } catch {
      // 非 Error 对象就算了
    }
    throw error
  }
}

async function startNow(version) {
  const ver = safeVersion(version)
  if (current?.version === ver && current.status === 'running' && current.url) {
    return { url: current.url }
  }
  if (current?.version === ver && current.status === 'starting') {
    return waitUntilReady(current, ver)
  }
  if (current) await stop()
  const config = await loadConfig()
  if (!listedVersions(config).includes(ver)) throw new Error(`${ver} 未安装`)
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')
  return bootOnce(ver)
}

/** 一次启动尝试里最多按错误自动禁用几个插件（避免连环禁用不可收拾）。 */
const MAX_AUTO_DISABLE = 3
/** 最近一次按错误自动禁用的插件（管理页显示 + 一键恢复）。 */
let lastAutoFix = null

/**
 * 这个 dsh 版本会不会自己隔离「可选插件启动失败」——0.1.7-rc.1 起会
 * （release notes：可选插件启动失败时其余插件仍可运行，只有必需插件失败才退出；
 * 并把分类诊断写进日志文件、在插件页给出启停入口）。
 * 那种版本上启动器不该再按 stdout 正则去改用户的补丁层：既多余，也可能误伤。
 */
export function dshToleratesOptionalFailures(version) {
  const parsed = parseVer(version)
  const since = parseVer('0.1.7-rc.1')
  return Boolean(parsed) && Boolean(since) && cmpVer(parsed, since) >= 0
}

/**
 * 兼容模式：启动输出点名了某个插件行加载失败时，把该行写进补丁层禁用。
 * 只信任错误的原始输出（failed to import loader entry <行> (<包>)），官方组件不动。
 * @returns 是否改动了配置（改动后上层立刻重试启动）。
 */
async function autoDisableFailedPlugins(error, already) {
  const settings = await loadSettings()
  if (settings.autoDisablePlugins === false) return false
  const failure = error?.failure || lastFailure
  // 新版本 dsh 自己扛得住可选插件失败，启动器就别替它做决定（原因见 dshToleratesOptionalFailures）
  const version = failure?.version || current?.version || ''
  if (dshToleratesOptionalFailures(version)) {
    pushLog(`[兼容] ${version} 的 dsh 会自己隔离出问题的可选插件，本次不自动禁用；失败原因看它自己的插件页/日志`)
    return false
  }
  const text = `${failure?.message || ''}\n${(failure?.tail || []).join('\n')}`

  // 禁掉一个加载行并记账；返回是否真的动手了（没改动就别重试，免得打转）
  const tryDisable = async (id, name, note) => {
    try {
      const result = disableRowId(profileDir(), id)
      if (!result.changed) return false
      pushLog(`[兼容] ${note}，已写入 cordis.patch.yml 禁用「${id}」，重试启动…`)
      already.add(id)
      // name 会原样显示在「启动时自动禁用了：…」里，note 只进日志
      lastAutoFix = {
        at: Date.now(),
        version: failure?.version || null,
        plugins: [...(lastAutoFix?.plugins || []), { name, id }],
      }
      await emitState()
      return true
    } catch (error2) {
      pushLog(`[兼容] 自动禁用「${id}」失败：${error2 instanceof Error ? error2.message : error2}`)
      return false
    }
  }

  // 一、报错直接点名了某个加载行
  for (const row of parseFailedRows(text)) {
    if (already.has(row.id)) continue
    if (/^@deepseek-ai\//.test(row.pkg)) continue
    const owner = ownerOfRow(profileDir(), row.id)
    if (owner && /^@deepseek-ai\//.test(owner)) continue
    if (await tryDisable(row.id, row.pkg, `${row.pkg} 的加载行「${row.id}」加载失败`)) return true
  }

  // 二、形状解析没命中时换个方向：顶层命中的可能是个核心 loader，出问题的插件藏在
  //     cause 里（见 pluginsNamedInFailure 的说明）。拿已装插件的名字去报错里找，
  //     按出现顺序一个个试，每次只禁一个再重试。
  for (const plugin of pluginsNamedInFailure(profileDir(), text)) {
    const id = plugin.ids.find((rowId) => !already.has(rowId))
    if (!id) continue
    if (await tryDisable(id, plugin.name, `报错点名了 ${plugin.name}`)) return true
  }
  return false
}

/**
 * 启动失败 → 自动修复 → 重试（兼容模式），直到成功或无法再修。
 * 先试禁用出问题的插件行，再试重建 profile 依赖（两者各只做一次，避免打转）。
 */
async function startWithRepair(version) {
  lastAutoFix = null
  const autoDisabled = new Set()
  let depsRepaired = false
  let lastError
  // 每次启动都补齐 profile 的 .npmrc：插件市场的安装也会走这个文件，
  // 早于任何一次 add 就有这行，市场里点安装才不会撞上 peer 求交那个坑
  await ensureProfileNpmrc().catch(() => {})
  for (;;) {
    try {
      return await startNow(version)
    } catch (error) {
      lastError = error
      pushLog(`启动失败：${error instanceof Error ? error.message : error}`)
      if (autoDisabled.size < MAX_AUTO_DISABLE && await autoDisableFailedPlugins(error, autoDisabled)) {
        continue
      }
      if (!depsRepaired && await repairProfileDeps(version, error)) {
        depsRepaired = true
        continue
      }
      break
    }
  }
  throw lastError
}

let startChain = Promise.resolve()

async function start(version) {
  const run = startChain.then(() => startWithRepair(version))
  startChain = run.then(() => {}, () => {})
  return run
}

export async function launchInstalled() {
  if (current?.status === 'running' && current.url) {
    return { version: current.version, url: current.url }
  }
  if (current?.status === 'starting' && current.version) {
    const result = await start(current.version)
    return { version: current.version, url: result.url }
  }
  const installed = listedVersions(await loadConfig())
  if (!installed.length) return { version: null, url: null }
  const version = installed[0]
  const result = await start(version)
  return { version, url: result.url }
}

export async function restartInstalled() {
  const version = current?.version
  if (current) await stop()
  if (version) {
    const result = await start(version)
    return { version, url: result.url }
  }
  return launchInstalled()
}

export function onState(listener) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function setHost(next) {
  host = { ...host, ...next }
}

/**
 * dsh 自带的 profile 模板名（见 @deepseek-ai/dsh-app-boot 的 PROFILE_TEMPLATES）：
 * 这些名字首次使用时 dsh 会自动初始化。其余名字必须先在磁盘上存在（目录里有
 * package.json），否则 dsh 会直接拒绝启动——所以设置页只让人从可用列表里挑。
 */
const TEMPLATE_PROFILES = ['web', 'headless', 'acp', 'sdk', 'sdk-minimal']

/** 可切换的 profile：磁盘上已初始化的 + dsh 自带模板名 + 当前值。 */
function listProfiles() {
  const names = new Set(TEMPLATE_PROFILES)
  const root = join(homeDir(), 'profiles')
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      if (existsSync(join(root, entry.name, 'package.json'))) names.add(entry.name)
    }
  } catch { /* 还没有 profiles 目录 */ }
  if (PROFILE_NAME) names.add(PROFILE_NAME)
  return [...names].sort()
}

/**
 * 弹系统「选择文件夹」对话框，返回选中的绝对路径（取消/失败就返回空串）。
 *
 * 页面里的 `<input type="file" webkitdirectory>` 只能拿到相对路径，浏览器也不给绝对路径，
 * 所以目录选择必须由管理页所在的本机进程来做。
 */
function pickDirectory() {
  if (IS_MAC) return pickDirectoryMac()
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持目录选择')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择 dsh 版本目录'",
    '$d.ShowNewFolderButton = $true',
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-STA', '-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

/** AppleScript 里用户点「取消」的错误号：不算失败，当作没选。 */
const APPLESCRIPT_USER_CANCELED = '-128'

/**
 * 弹系统的文件对话框（选一个整合包 / 选导出到哪），返回绝对路径，取消返回空串。
 *
 * 和目录选择同一套做法：页面拿不到本机绝对路径，只能由管理页所在进程来弹。
 * 注入到 PowerShell / AppleScript 里的字符串先把单引号去掉——它们都是单引号包裹的。
 */
function pickFileWin({ save, defaultName, filter }) {
  const cleanName = String(defaultName || '').replace(/'/g, '')
  const cleanFilter = String(filter || '').replace(/'/g, '')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    save
      ? `$d = New-Object System.Windows.Forms.SaveFileDialog; $d.FileName = '${cleanName}'; $d.OverwritePrompt = $true`
      : '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Filter = '${cleanFilter}'`,
    save ? "$d.Title = '导出整合包'" : "$d.Title = '选择整合包'",
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
  ].join('; ')
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-STA', '-NoProfile', '-Command', script], { windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

function pickFileMac({ save, defaultName }) {
  const cleanName = String(defaultName || '').replace(/["\\]/g, '')
  const script = save
    ? `activate\nPOSIX path of (choose file name with prompt "导出整合包" default name "${cleanName}")`
    : 'activate\nPOSIX path of (choose file with prompt "选择整合包")'
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 10 * 60 * 1000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
        else reject(error)
        return
      }
      resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
    })
  })
}

const PACK_FILE_FILTER_DSPACK = '整合包 (*.dspack)|*.dspack|ZIP 压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'

function pickPackFile({ save = false, defaultName = '' } = {}) {
  if (IS_MAC) return pickFileMac({ save, defaultName })
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持文件选择')
  return pickFileWin({ save, defaultName, filter: PACK_FILE_FILTER_DSPACK })
}

/**
 * 在文件管理器里定位一个文件。
 *
 * 只放行启动器自己的产物（刚导出的包、inbox 里的临时文件）——这个接口没有鉴权，
 * 做成「能打开任意路径」等于给本机开了个文件管理器后门。
 */
function revealPath(target) {
  const value = String(target || '')
  if (!value) throw new Error('先给一个路径')
  if (!existsSync(value)) throw new Error('这个路径不存在')
  const allowed = value === lastExportPath || value === packsDir() || value.startsWith(`${packsDir()}${sep}`)
  if (!allowed) throw new Error('只支持显示整合包自己的文件')
  if (IS_MAC) execFile('open', ['-R', value], { windowsHide: true })
  else if (IS_WINDOWS) execFile('explorer', [`/select,${value}`], { windowsHide: true })
  else execFile('xdg-open', [dirname(value)], { windowsHide: true })
}

/** macOS 的目录选择走 AppleScript 的 choose folder（系统自带，不需要额外权限）。 */
function pickDirectoryMac() {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      // activate 把对话框带到最前，否则它可能躲在管理页窗口后面
      ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "选择 dsh 版本目录")'],
      { timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
          else reject(error)
          return
        }
        // POSIX path 带尾斜杠，去掉和其它地方的目录写法保持一致
        resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
      },
    )
  })
}

/**
 * 选一个文件（导出 zip 时用来定路径，导入时用来挑包）。
 * save = true 走「保存」对话框（可以是个还不存在的文件名），否则走「打开」对话框。
 */
function pickFile({ save = false, name = '' } = {}) {
  if (IS_MAC) {
    const what = save ? 'choose file name with prompt "选择保存位置"' : 'choose file with prompt "选择 ZIP 文件"'
    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', 'activate', '-e', 'POSIX path of (' + what + (save && name ? ` default name "${name}"` : '') + ')'],
        { timeout: 5 * 60 * 1000, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            if (String(stderr || '').includes(`(${APPLESCRIPT_USER_CANCELED})`)) resolve('')
            else reject(error)
            return
          }
          resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
        },
      )
    })
  }
  if (!IS_WINDOWS) throw new Error('只有 Windows 和 macOS 支持文件选择，这里请手填路径')
  const dialog = save ? 'SaveFileDialog' : 'OpenFileDialog'
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    `$f = New-Object System.Windows.Forms.${dialog}`,
    "$f.Filter = 'ZIP 文件 (*.zip)|*.zip|所有文件 (*.*)|*.*'",
    save ? "$f.FileName = '" + String(name || 'dsh-backup.zip').replace(/'/g, "''") + "'" : '',
    "$f.Title = '" + (save ? '导出到哪个 ZIP 文件' : '选择要导入的 ZIP 文件') + "'",
    "$f.OverwritePrompt = $true",
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.FileName) }",
  ].filter(Boolean).join('; ')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-STA', '-NoProfile', '-Command', script],
      { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout || '').trim())
      },
    )
  })
}

/** 允许当作"本机"的主机名——打开本机页面、判断请求来源都用它。 */const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 严格解析成本机 http(s) 地址；不是就抛错（前缀正则挡不住 `/?&calc` 这种尾巴）。 */
function assertLocalUrl(target) {
  let parsed
  try {
    parsed = new URL(String(target))
  } catch {
    throw new Error('只能打开本机地址')
  }
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('只能打开本机地址')
  }
  return parsed.href
}

/**
 * 交给系统默认程序打开。
 *
 * Windows 走 `cmd /c start`，而 cmd 会把这行**再解析一遍**：URL 里的 `&` 是语句
 * 分隔符、`|<>^()%"` 各有含义，于是 `http://127.0.0.1:1/?&calc` 能直接跑起任意命令
 * （Node 只给含空格的参数加引号，而 URL 里通常没有空格）。所以这里只放行 cmd 会
 * 原样看待的字符——够用（本机地址就是 `http://127.0.0.1:端口/路径?k=v`），
 * 其余一律拒绝，比在字符串上做转义可靠。
 */
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#\[\]@$'*,;=+]+$/

/**
 * Chromium 系浏览器（支持 --app= 应用窗口）的常见安装位置。
 * 顺序即优先级：先用户的 Chrome，再 Edge（Windows 自带，兜底最稳）。
 * DSH_CHROMIUM 可以指定一个，方便用便携版或专门指定某个浏览器。
 */
export function chromiumCandidates(env = process.env, platform = process.platform) {
  if (env.DSH_CHROMIUM) return [env.DSH_CHROMIUM]
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  if (platform !== 'win32') return ['google-chrome', 'chromium', 'microsoft-edge']
  return [
    join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
}

/** 找到可用的 Chromium 就返回它的路径，否则空串（调用方退回默认浏览器）。 */
export function findChromiumBrowser(env = process.env, platform = process.platform) {
  return chromiumCandidates(env, platform).find((file) => Boolean(file) && existsSync(file)) || ''
}

/** 应用窗口的参数：--app=<url> 打开的是没有地址栏、没有标签栏的独立窗口。 */
export function appWindowArgs(url) {
  return [`--app=${String(url)}`]
}

/** 用 Chromium 的应用窗口打开网址；找不到浏览器返回 false，交给调用方兜底。 */
function openInAppWindow(url) {
  const browser = findChromiumBrowser()
  if (!browser) return false
  try {
    execFile(browser, appWindowArgs(url), { windowsHide: true })
    pushLog(`用应用窗口打开：${basename(browser)}`)
    return true
  } catch (error) {
    pushLog(`应用窗口没打开（${error instanceof Error ? error.message : error}），改用默认浏览器`)
    return false
  }
}

/**
 * 内嵌窗口模式：本进程是被 DSH.exe / DSH-X.app 的原生外壳拉起来的（它设了
 * DSH_APP_WINDOW=1），它在 stdout 上收这一行约定标记（和 __DSH_SHOW__ 一个路子），
 * 收到就把地址装进它自己创建的窗口里。不经过浏览器进程——这正是这个模式存在的理由：
 * app 模式借的还是浏览器（只是没有地址栏），window 模式的窗口完全归启动器所有，
 * 关窗口 / 托盘 / 退出都由它说了算。
 */
const OPEN_SIGNAL = '__DSH_OPEN__'

/** 本进程是不是由原生外壳（DSH.exe / DSH-X.app）托管：只有它能开内嵌窗口。 */
function shellWindowHost() {
  return process.env.DSH_APP_WINDOW === '1'
}

/**
 * 这个地址该由谁打开：'window'（启动器内嵌窗口）还是 'browser'（系统浏览器）。
 * 纯函数，便于测试；两个条件缺一不可——设置里选了 window，且真的有个外壳在收标记
 * （源码运行 npm start 时没有外壳，选 window 也只会安静地退回浏览器）。
 */
export function openRoute(mode, shellWindow) {
  return mode === 'window' && shellWindow ? 'window' : 'browser'
}

/**
 * 交给系统默认程序打开。openMode 为 app 时优先用 Chromium 的应用窗口（更像个 App、
 * 没有地址栏），找不到 Chrome/Edge 就安静退回默认浏览器；为 window 时交给原生外壳
 * 自己的窗口（不经过浏览器进程）。
 *
 * Windows 走 `cmd /c start`，而 cmd 会把这行**再解析一遍**：URL 里的 `&` 是语句
 * 分隔符、`|<>^()%"` 各有含义，于是 `http://127.0.0.1:1/?&calc` 能直接跑起任意命令
 * （Node 只给含空格的参数加引号，而 URL 里通常没有空格）。所以这里只放行 cmd 会
 * 原样看待的字符——够用（本机地址就是 `http://127.0.0.1:端口/路径?k=v`），
 * 其余一律拒绝，比在字符串上做转义可靠。
 */
function openExternal(target, mode = OPEN_MODE) {
  const url = String(target)
  // 内嵌窗口：地址交给原生外壳自己的窗口，连浏览器进程都不起（见 OPEN_SIGNAL）
  if (openRoute(mode, shellWindowHost()) === 'window') {
    process.stdout.write(`${OPEN_SIGNAL} ${url}\n`)
    return
  }
  if (mode === 'app' && /^https?:/i.test(url)) {
    if (openInAppWindow(url)) return
    pushLog('没找到 Chrome/Edge，改用系统默认浏览器打开')
  }
  if (process.platform === 'win32') {
    if (!CMD_SAFE_URL.test(url)) throw new Error('地址里含不能安全打开的字符')
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

function openLocalUrl(target) {
  openExternal(assertLocalUrl(target))
}

/**
 * 请求是不是来自本机。带 Origin 的只有浏览器：别的网页往 127.0.0.1 发跨站 POST 时
 * 会带上自己的 Origin（file:// 页面则是 `null`），而这个管理页没有任何鉴权，不挡的话
 * 任意网页都能让启动器装插件、起进程、开链接。托盘 / curl / 本机脚本不带 Origin。
 */
function sameSiteRequest(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) && (!parsed.port || Number(parsed.port) === PORT)
  } catch {
    return false
  }
}

/** Host 头是不是我们自己（DNS rebinding 的请求里写的是攻击者的域名）。 */
function isLocalHostHeader(host) {
  if (!host) return true
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(host).trim().toLowerCase())
  if (!match) return false
  if (!LOCAL_HOSTS.has(match[1])) return false
  return !match[2] || Number(match[2]) === PORT
}

export { pruneDanglingLinks, snapshot, stop }

async function stop(version) {
  const proc = current
  if (!proc) return
  if (typeof version === 'string' && version && VERSION_RE.test(version) && proc.version !== version) {
    throw new Error(`正在运行的是 ${proc.version}`)
  }
  proc.status = 'stopping'
  await emitState()
  const closed = new Promise((resolve) => proc.child.once('close', resolve))
  killTree(proc.child.pid)
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
  if (current?.child === proc.child) current = null
  await emitState()
}

async function uninstallSystem(ver) {
  const system = detectSystemDsh()
  if (!system || system.version !== ver) throw new Error(`${ver} 未安装`)
  pushLog(`卸载系统 ${ver}`)
  await rm(system.root, { recursive: true, force: true })
  const prefix = dirname(dirname(dirname(system.root)))
  if (!IS_WINDOWS) {
    // POSIX 的全局包在 <prefix>/lib/node_modules，命令是 <prefix>/bin/dsh 这个符号链接。
    // 包删掉之后它就悬空了，existsSync 会跟着链接判成不存在，所以用 lstat；也只删链接，
    // 同名的普通文件不是 npm 装的，不碰。
    const link = join(dirname(prefix), 'bin', 'dsh')
    try {
      if (lstatSync(link).isSymbolicLink()) await rm(link, { force: true })
    } catch {
      // 没有就算了
    }
    return
  }
  for (const name of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
    const file = join(prefix, name)
    if (existsSync(file)) await rm(file, { force: true })
  }
}

async function uninstall(version) {
  const ver = safeVersion(version)
  if (current?.version === ver) throw new Error('请先停止再移除')
  const config = await loadConfig()
  const versions = listedVersions(config)
  if (!versions.includes(ver)) throw new Error(`${ver} 未安装`)
  if (isManaged(ver)) {
    pushLog(`移除 ${ver}`)
    await rm(versionDir(ver), { recursive: true, force: true })
  }
  const system = detectSystemDsh()
  if (system?.version === ver) await uninstallSystem(ver)
  config.versions = versions.filter((item) => item !== ver)
  await saveConfig(config)
  await emitState()
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** MCP 检测同时跑几台；stdio 探测要起真进程，别一次全放出去。 */
const PROBE_CONCURRENCY = 3
/** 检测超时：默认 20s，允许页面调，夹在 2s - 120s 之间。 */
function probeTimeout(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 20000
  return Math.min(120000, Math.max(2000, Math.round(ms)))
}

/**
 * 探测用的环境：把启动器自带的 node/npx 放到 PATH 最前，但**不**继承 NODE_OPTIONS——
 * 那是启动器给 dsh 自己挂的加载钩子，塞给被测的 MCP 程序只会添乱。
 */
function probeEnv() {
  const env = { ...process.env, PATH: withBundledRuntime(process.env.PATH || '') }
  delete env.NODE_OPTIONS
  return env
}

/**
 * MCP 状态检测：对每台服务器真起一次进程 / 真连一次端点，走 MCP initialize 握手。
 * 结果只回给页面，不落盘——它是"现在这一下通不通"，不是配置的一部分。
 */
async function probeMcpServers(targets, timeoutMs, onResult) {
  const results = new Array(targets.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return
      const server = targets[index]
      const result = server.broken
        ? {
          serverName: server.serverName,
          transport: server.transport,
          ok: false,
          stage: 'broken',
          detail: server.error || '条目损坏，无法检测',
          ms: 0,
        }
        : await probeMcpServer(server, { timeoutMs, env: probeEnv(), cwd: profileDir(), clientName: `dsh-x ${APP_VERSION}` })
      results[index] = result
      onResult?.(result)
    }
  })
  await Promise.all(workers)
  return results
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(payload)
}

async function exportLogs() {
  const chunks = []
  for (const path of [`${LOG_FILE}.1`, LOG_FILE]) {
    try {
      chunks.push(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return redact(chunks.length ? chunks.join('') : logs.join('\n'), secretValues)
}

async function handleApi(req, res, url) {
  // 身份标记：端口被占用时我们要能分辨那是自己的另一个实例还是别人的程序
  if (url.pathname === '/api/ping') {
    send(res, 200, { app: 'dsh-x', version: APP_VERSION, port: PORT })
    return
  }
  // 改状态的请求只认本机来源（浏览器会带 Origin，本机程序不会）
  if (req.method !== 'GET' && !sameSiteRequest(req)) {
    send(res, 403, { error: '跨站请求被拒绝' })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    send(res, 200, await fetchRemote())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/self') {
    send(res, 200, await checkSelfUpdate())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/pending') {
    send(res, 200, { update: await pendingUpdate() })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/tray') {
    // 给 DSH.exe 的原生托盘读状态。纯文本 key=value，省得那边为了三行状态写 JSON 解析。
    const snap = await snapshot()
    const running = snap.running
    send(res, 200, [
      `status=${running?.status || 'stopped'}`,
      `url=${running?.url || ''}`,
      `installed=${snap.installed.length ? 1 : 0}`,
      `lang=${LANG}`,
      // 托盘照着它决定「打开 DSH」是叫内嵌窗口还是丢给系统浏览器
      `openmode=${OPEN_MODE}`,
      // 本次是不是由原生外壳托管：外壳缺失时窗口模式不成立，托盘据此退回浏览器
      `shell=${shellWindowHost() ? 1 : 0}`,
    ].join('\n'), 'text/plain; charset=utf-8')
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/changelog') {
    const kind = url.searchParams.get('kind') === 'self' ? 'self' : 'dsh'
    send(res, 200, await releaseNotes(kind, url.searchParams.get('version')))
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    send(res, 200, await publicSettings())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/logs/export') {
    res.setHeader('content-disposition', 'attachment; filename="dsh-x-logs.txt"')
    send(res, 200, await exportLogs(), 'text/plain; charset=utf-8')
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, await snapshot())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    // 插件页现在同时画整合包卡片，一次请求把两边都带上，省得页面开两次口
    send(res, 200, { ...listPlugins(profileDir()), autoFix: lastAutoFix, ...packsPayload() })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins/updates') {
    try {
      send(res, 200, { ...(await checkPluginUpdates({ force: url.searchParams.get('refresh') === '1' })), profile: PROFILE_NAME })
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/packs') {
    send(res, 200, packsPayload())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/packs/market') {
    try {
      send(res, 200, { ok: true, ...(await marketEntries({ force: url.searchParams.get('refresh') === '1' })) })
    } catch (error) {
      // 市场读不到不算页面出错：这条索引在 GitHub 上，直连/镜像都可能拿不到，
      // 手动贴链接或 owner/repo 照样能装。
      send(res, 200, { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write(`event: log\ndata: ${JSON.stringify({ lines: logs.slice(-120) })}\n\n`)
    res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`)
    if (installProgress) res.write(`event: progress\ndata: ${JSON.stringify(installProgress)}\n\n`)
    if (pluginProgress) res.write(`event: progress\ndata: ${JSON.stringify({ ...pluginProgress, kind: 'plugin', name: pluginProgressName })}\n\n`)
    // 整合包：检查和安装都可能几十秒（下载 + 解包 + pnpm），刷新页面要能接着显示
    if (packProgress) res.write(`event: progress\ndata: ${JSON.stringify({ ...packProgress, kind: 'pack', name: packProgressName })}\n\n`)
    // 同步跑得久，页面中途刷新也要能接着显示进度
    if (syncState) res.write(`event: sync\ndata: ${JSON.stringify(syncState)}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  const body = req.method === 'POST' ? await readJson(req) : {}
  if (req.method === 'POST' && url.pathname === '/api/pending/skip') {
    send(res, 200, await skipPendingUpdate(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/self/download') {
    // 第一步：下载。进度走 selfUpdate 事件，页面显示进度条
    try {
      send(res, 200, await downloadSelfUpdate())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`更新下载失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/self/install') {
    // 第二步：用户点确认之后才走这里。先回页面，再收尾退出，把位子让给助手
    try {
      // 不在这里退出：安装程序会提示关闭正在运行的启动器，它自己会处理
      send(res, 200, await installSelfUpdate())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`更新安装失败：${message}`)
      send(res, 500, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    send(res, 200, await restartInstalled())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/quit') {
    // 托盘的「退出」走这里：先把响应发出去，再收尾退出，否则调用方只会看到连接被掐断
    send(res, 200, { ok: true })
    shutdown().finally(() => process.exit(0))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/install') {
    await install(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    send(res, 200, await start(body.version))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/launch') {
    send(res, 200, await launchInstalled())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    await stop(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/uninstall') {
    await uninstall(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    send(res, 200, await saveManagerSettings(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
    const name = String(body.name || '')
    const enabled = body.enabled !== false
    // 整合包卡片可能装在别的 profile 上，切换插件时得能指定目标（不传就是当前 profile）
    const target = body.profile ? join(homeDir(), 'profiles', safeProfile(String(body.profile))) : profileDir()
    const result = setPluginEnabled(target, name, enabled)
    const where = body.profile && String(body.profile) !== PROFILE_NAME ? `（profile ${body.profile}）` : ''
    pushLog(`插件 ${name} → ${enabled ? '启用' : '禁用'}${where}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...listPlugins(profileDir()), ...packsPayload(), autoFix: lastAutoFix })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/update') {
    try {
      const result = body.all ? await updateAllPlugins() : await updatePlugin(String(body.name || ''))
      pushLog(body.all
        ? `插件更新完成：成功 ${result.done.length} 个${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}（重启 dsh 后生效）`
        : `${result.name} ${result.changed ? `已更新到 ${result.to}` : '已是最新'}（重启 dsh 后生效）`)
      send(res, 200, { ok: true, ...result, ...listPlugins(profileDir()), profile: PROFILE_NAME, autoFix: lastAutoFix })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`插件更新失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  // ---- 整合包：检查 / 安装 / 卸载 / 导出 ----

  if (req.method === 'POST' && url.pathname === '/api/packs/inspect') {
    const token = String(body.token || '') || newPackToken()
    const source = body.market
      ? { kind: 'market', id: String(body.market.id || ''), url: String(body.market.downloadUrl || ''), sha256: String(body.market.sha256 || ''), size: Number(body.market.size) || 0, name: String(body.market.name || '') }
      : String(body.source || '')
    packProgressName = body.market ? String(body.market.displayName || body.market.name || '') : String(body.source || '')
    emitPackProgress({ phase: 'fetch', done: 0, total: 0 })
    try {
      const opened = await openPackSource(source, { token, onProgress: (state) => emitPackProgress(state) })
      // 检查会往 inbox 落一份包，顺手清掉过期的：一次会话里检查很多个也不会把磁盘堆满
      void prunePackInbox()
      if (opened.token) {
        packInspectCache.set(opened.token, { file: opened.file, source: opened.source, at: Date.now() })
      }
      const payload = { ok: true, token: opened.token, source: opened.source, bytes: opened.bytes || 0, ...packPlanPayload(opened.pack, String(body.profile || '')) }
      pushLog(`整合包检查：${payload.pack.displayName || payload.pack.name} ${payload.pack.version}（${payload.pack.bundles.length} 层、${payload.pack.dependencies.length} 个依赖）${payload.ok ? '' : '，有问题'}`)
      send(res, 200, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包检查失败：${message}`)
      send(res, 400, { ok: false, error: message })
    } finally {
      packProgressName = ''
      emitPackProgress(null)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/install') {
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    const token = String(body.token || '')
    const cached = token ? packInspectCache.get(token) : null
    const source = cached ? cached.source : (body.market
      ? { kind: 'market', id: String(body.market.id || ''), url: String(body.market.downloadUrl || ''), sha256: String(body.market.sha256 || ''), size: Number(body.market.size) || 0, name: String(body.market.name || '') }
      : String(body.source || ''))
    if (!cached && !body.source && !body.market) {
      send(res, 400, { error: token ? '这次检查的临时文件已经过期了，回到上一步重新检查一次再装' : '先检查一次整合包，再点安装' })
      return
    }
    pluginBusy = true
    let opened = null
    try {
      opened = cached
        ? { pack: parsePackArchive(await readFile(cached.file)), file: cached.file, source: cached.source, token }
        : await openPackSource(source, { token: token || newPackToken(), onProgress: (state) => emitPackProgress(state) })
      const pack = opened.pack
      packProgressName = pack.displayName || pack.fields.name
      if (!pack.ok) throw new Error(pack.errors.join('；'))
      const profile = safeProfile(String(body.profile || '') || defaultProfileFor(pack))
      const plan = planInstall(pack, { home: homeDir(), profile, hostProfile: PROFILE_NAME })
      if (!plan.ok) throw new Error(plan.errors.join('；'))
      const version = await pluginCommandVersion()
      pushLog(`安装整合包 ${pack.fields.name} ${pack.fields.version} → profile ${profile}（${plan.writes.length} 个文件）`)
      emitPackProgress({ phase: 'write', done: 0, total: plan.writes.length })
      const result = await applyInstall(plan, {
        home: homeDir(),
        dataDir: DATA,
        pack,
        source: opened.source,
        runInstall: async (target) => {
          emitPackProgress({ phase: 'install', step: 'resolve', done: 0, total: 0 })
          await runProfileInstall(version, {
            profile: target,
            // pnpm 自己的相位放进 step：页面上「下载依赖」和「下载整合包」是两件事
            onProgress: (state) => emitPackProgress({ phase: 'install', step: state.phase, done: state.done, total: state.total }),
            log: pushLog,
          })
        },
        log: pushLog,
      })
      emitPackProgress({ phase: 'done', done: plan.writes.length, total: plan.writes.length })
      rememberPack(DATA, result.record)
      if (token) packInspectCache.delete(token)
      pushLog(`整合包 ${result.record.name} 已装进 profile「${profile}」（重启 dsh 后生效）`)
      send(res, 200, {
        ok: true,
        installed: result.record,
        plan: { notes: plan.notes, warnings: plan.warnings, writes: plan.writes.map((write) => write.rel) },
        ...packsPayload(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包安装失败：${message}`)
      send(res, 400, { ok: false, error: message })
    } finally {
      pluginBusy = false
      packProgressName = ''
      emitPackProgress(null)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/toggle') {
    const profile = String(body.profile || '')
    const enabled = body.enabled !== false
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    const target = join(homeDir(), 'profiles', safeProfile(profile))
    const plugins = listPlugins(target).plugins
    if (!plugins.length) {
      send(res, 404, { error: `profile「${profile}」里没有已安装的插件` })
      return
    }
    // 卡片代表一整个 profile：开关管的是这个环境里所有第三方插件（官方组件不提供开关）
    const packages = plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name)
    let changed = 0
    const failed = []
    for (const item of packages) {
      try {
        if (setPluginEnabled(target, item, enabled).changed) changed += 1
      } catch (error) {
        failed.push(`${item}：${error instanceof Error ? error.message : error}`)
      }
    }
    pushLog(`profile ${profile} 的插件 → ${enabled ? '启用' : '禁用'}（${changed} 个有变化${failed.length ? `，${failed.length} 个不支持：${failed.join('；')}` : ''}）`)
    send(res, 200, { ok: true, changed, failed, ...listPlugins(profileDir()), ...packsPayload(), autoFix: lastAutoFix })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/update') {
    const profile = String(body.profile || '')
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    // 更新走的是插件页那条单插件升级（含 peer 与目录链接的退路），它只认当前 profile
    if (profile !== PROFILE_NAME) {
      send(res, 400, { error: `profile「${profile}」不是当前在用的那个，先在插件页把 profile 切过去再更新` })
      return
    }
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    try {
      const packages = listPlugins(profileDir()).plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name)
      if (!packages.length) throw new Error(`profile「${profile}」里没有可更新的插件`)
      const done = []
      const failed = []
      const unchanged = []
      for (const item of packages) {
        try {
          const result = await updatePlugin(item)
          if (result.changed) done.push(`${item} → ${result.to}`)
          else unchanged.push(item)
        } catch (error) {
          failed.push(`${item}：${error instanceof Error ? error.message : error}`)
        }
      }
      pushLog(`profile ${profile} 的插件更新完成：${done.length} 个升级${failed.length ? `，${failed.length} 个失败` : ''}（重启 dsh 后生效）`)
      send(res, 200, {
        ok: true,
        updated: done.length,
        failed,
        unchanged,
        ...listPlugins(profileDir()),
        ...packsPayload(),
        autoFix: lastAutoFix,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`profile ${profile} 的插件更新失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/remove-profile') {
    // 手动拼出来的 profile 没有安装记录，撤不掉「安装时改过的文件」，只能整个删掉
    const profile = String(body.profile || '')
    if (!profile) {
      send(res, 400, { error: '要说清是哪个 profile' })
      return
    }
    if (profile === PROFILE_NAME) {
      send(res, 400, { error: `profile「${profile}」是启动器正在用的那个，先在插件页换一个 profile 再删` })
      return
    }
    if (TEMPLATE_PROFILES.includes(profile)) {
      send(res, 400, { error: `「${profile}」是 dsh 自带的 profile 模板，不能删` })
      return
    }
    const target = join(homeDir(), 'profiles', safeProfile(profile))
    if (!existsSync(target)) {
      send(res, 404, { error: `profile「${profile}」的目录不在` })
      return
    }
    try {
      await rm(target, { recursive: true, force: true })
      pushLog(`已删掉整个 profile「${profile}」`)
      send(res, 200, { ok: true, ...listPlugins(profileDir()), ...packsPayload(), autoFix: lastAutoFix })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`删 profile「${profile}」失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/uninstall') {
    const name = String(body.name || '')
    const profile = String(body.profile || '')
    const record = readPackState(DATA).packs.find((item) => item.name === name && item.profile === profile)
    if (!record) {
      send(res, 404, { error: `没有「${name} 装在 ${profile}」这条安装记录` })
      return
    }
    if (pluginBusy) {
      send(res, 400, { error: '正在装插件或整合包，等它结束再试' })
      return
    }
    // 删目录这件事先判掉：允许的话才动手卸载，否则会留下「文件还原了、目录没删」的半截状态
    if (body.removeProfile === true) {
      if (!record.createdProfile) {
        send(res, 400, { error: '这个 profile 在装整合包之前就在，不敢整个删掉；可以手动清理这个目录' })
        return
      }
      if (record.profile === PROFILE_NAME) {
        send(res, 400, { error: `profile「${record.profile}」是启动器正在用的那个，先在插件页换一个 profile 再删` })
        return
      }
    }
    try {
      const lines = []
      const profilePath = join(homeDir(), 'profiles', profile)
      // profile 目录已经被手动删掉时不硬还原——那等于把空目录重新变出一堆配置文件，更吓人
      const gone = !existsSync(profilePath)
      const result = gone
        ? { ok: true, restored: 0 }
        : uninstallPack(record, { home: homeDir(), log: (line) => { lines.push(line); pushLog(`[整合包] ${line}`) } })
      if (gone) lines.push(`profile 目录「${profilePath}」已经不在了，只清掉安装记录，不再还原文件`)
      forgetPack(DATA, name, profile)
      let removedProfile = false
      if (body.removeProfile === true) {
        await rm(join(homeDir(), 'profiles', record.profile), { recursive: true, force: true })
        removedProfile = true
        pushLog(`[整合包] 已删掉整个 profile「${record.profile}」`)
      }
      pushLog(`整合包 ${name} 已从 profile「${profile}」卸下（还原 ${result.restored} 个文件${removedProfile ? '，并删除 profile 目录' : ''}）`)
      if (record.createdProfile && !removedProfile) {
        lines.push(`这个 profile 是整合包建的，包新建的文件已删掉；node_modules 里装过的插件还在，想清干净可以在整合包页勾「同时删掉整个 profile 目录」`)
      }
      send(res, 200, { ok: true, restored: result.restored, lines, removedProfile, ...packsPayload() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`整合包卸载失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/export') {
    try {
      const profile = safeProfile(String(body.profile || '') || PROFILE_NAME)
      const profilePath = join(homeDir(), 'profiles', profile)
      if (!existsSync(join(profilePath, 'package.json'))) throw new Error(`profile「${profile}」里没有 package.json，没有可导出的东西`)
      const name = String(body.name || '').trim() || profile
      const version = String(body.version || '').trim() || '1.0.0'
      if (!/^[0-9A-Za-z._+-]{1,24}$/.test(version)) throw new Error('版本号只能用字母、数字和 . _ + - （不超过 24 个字符）')
      const target = String(body.path || '') || await pickPackFile({ save: true, defaultName: `${name}-${version}.dspack` })
      if (!target) {
        send(res, 200, { ok: false, canceled: true })
        return
      }
      const out = exportPack({
        profileDir: profilePath,
        home: homeDir(),
        name,
        version,
        displayName: String(body.displayName || '').trim(),
        includeHome: body.includeHome === true,
      })
      await writeFile(target, out.buffer)
      lastExportPath = target
      pushLog(`已导出整合包：${target}（${out.bundles.length} 层、${Object.keys(out.dependencies).length} 个依赖${out.homeFiles.length ? `、${out.homeFiles.length} 个用户级文件` : ''}）`)
      send(res, 200, {
        ok: true,
        path: target,
        bytes: out.buffer.length,
        bundles: out.bundles,
        dependencies: out.dependencies,
        homeFiles: out.homeFiles,
        skipped: out.skipped,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`导出整合包失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/pick-file') {
    try {
      const path = await pickPackFile({ save: false })
      send(res, 200, { path })
    } catch (error) {
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/reveal') {
    try {
      revealPath(String(body.path || ''))
      send(res, 200, { ok: true })
    } catch (error) {
      send(res, 400, { error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp') {
    send(res, 200, { ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/save') {
    const result = saveMcpServer(patchFile(), body)
    const extras = [
      result.repaired ? '覆盖了损坏区块' : '',
      ...(result.warnings || []),
    ].filter(Boolean)
    pushLog(`MCP 服务器 ${body.serverName} 已保存（${body.transport === 'streamable-http' ? 'http' : 'stdio'}）${extras.length ? ` · ${extras.join('；')}` : ''}`)
    send(res, 200, {
      ok: true,
      warnings: result.warnings || [],
      repaired: result.repaired === true,
      ...listMcpServers(patchFile()),
      profile: PROFILE_NAME,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/probe') {
    // 真起进程 / 真连端点：一次一台或指定的几台，结果按入参顺序返回
    const { servers } = listMcpServers(patchFile())
    const wanted = Array.isArray(body.serverNames) && body.serverNames.length
      ? new Set(body.serverNames.map((name) => String(name)))
      : null
    const targets = servers.filter((server) => !wanted || wanted.has(server.serverName))
    if (!targets.length) {
      send(res, 200, { ok: true, results: [] })
      return
    }
    pushLog(`开始检测 ${targets.length} 个 MCP 服务器（会真起进程/连端点）…`)
    const results = await probeMcpServers(targets, probeTimeout(body.timeoutMs))
    const passed = results.filter((item) => item.ok).length
    const failed = results.filter((item) => !item.ok)
    pushLog(`MCP 检测完成：${passed} 台在线${failed.length ? `，${failed.length} 台有问题（${failed.map((item) => `${item.serverName}:${item.stage}`).join('、')}）` : ''}`)
    send(res, 200, { ok: true, results })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/toggle') {
    const name = String(body.serverName || '')
    const result = setMcpEnabled(patchFile(), name, body.enabled !== false)
    pushLog(`MCP 服务器 ${name} → ${body.enabled !== false ? '启用' : '停用'}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/mcp/remove') {
    const name = String(body.serverName || '')
    removeMcpServer(patchFile(), name)
    pushLog(`MCP 服务器 ${name} 已删除`)
    send(res, 200, { ok: true, ...listMcpServers(patchFile()), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    send(res, 200, { ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/sync') {
    send(res, 200, syncPayload())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
    const root = rootDirOf(skillRoots(homeDir()), body.root)
    setSkillEnabled(root, String(body.path || ''), body.enabled !== false)
    pushLog(`技能 ${body.path} → ${body.enabled !== false ? '启用' : '停用'}`)
    send(res, 200, { ok: true, ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/open-folder') {
    // 在资源管理器里打开技能根目录（默认 ~/.dsh/skills）；目录不存在就顺手建好
    const dir = rootDirOf(skillRoots(homeDir()), body.root || 'dsh')
    await mkdir(dir, { recursive: true })
    const opener = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open'
    // 不能加 windowsHide：它会把「隐藏启动」的状态传给 explorer，文件夹窗口就弹不出来了
    execFile(opener, [dir], (error) => {
      // explorer.exe 成功时也会返回退出码 1，只把真正的启动失败（ENOENT 之类）写进日志
      if (error && typeof error.code === 'string') pushLog(`打开技能目录失败：${error.message}`)
    })
    pushLog(`已打开技能目录 ${dir}`)
    send(res, 200, { ok: true, dir })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/local') {
    const enabled = body.enabled !== false
    setLocalSkillsEnabled(profileDir(), enabled)
    pushLog(`本地技能加载 → ${enabled ? '启用' : '恢复默认'}${enabled ? '' : '（清除覆盖）'}`)
    send(res, 200, { ok: true, ...skillsPayload(), profile: PROFILE_NAME })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/save') {
    let stored
    try {
      stored = await saveSettings({
        s3: 's3' in body ? body.s3 : S3_CONFIG,
        webdav: 'webdav' in body ? body.webdav : WEBDAV_CONFIG,
        folder: 'folder' in body ? body.folder : FOLDER_CONFIG,
        zip: 'zip' in body ? body.zip : ZIP_CONFIG,
        sync: 'sync' in body ? body.sync : SYNC_OPTIONS,
      })
    } catch (error) {
      // 填错了（桶名不合法、端点不像地址）：说人话回报，别把 500 丢给页面
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    S3_CONFIG = safeS3Config(stored.s3)
    WEBDAV_CONFIG = safeWebdavConfig(stored.webdav)
    FOLDER_CONFIG = safeFolderConfig(stored.folder)
    ZIP_CONFIG = safeZipConfig(stored.zip)
    SYNC_OPTIONS = safeSyncSettings(stored.sync)
    // 密钥只留在本机设置文件里，但子进程输出/请求日志里万一带上它就得打码
    secretValues = [S3_CONFIG.secretAccessKey, S3_CONFIG.sessionToken, WEBDAV_CONFIG.password].filter(Boolean)
    send(res, 200, syncPayload())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/test') {
    try {
      const info = await testSyncConnection()
      send(res, 200, { ok: true, ...info, ...syncPayload() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`[同步] 连接失败：${message}`)
      send(res, 400, { error: message })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/run') {
    const mode = body.mode === 'down' ? 'down' : 'up'
    try {
      const summary = await runSyncJob(mode, {
        scopes: Array.isArray(body.scopes) ? body.scopes : undefined,
        policy: body.policy,
        force: body.force === true,
      })
      send(res, 200, { ok: true, summary, ...syncPayload() })
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/stop') {
    if (!syncRunning) {
      send(res, 200, { ok: true, stopped: false })
      return
    }
    syncStopRequested = true
    pushLog('[同步] 收到停止请求，做完手上这个就收手')
    send(res, 200, { ok: true, stopped: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/wake') {
    await host.onWake?.()
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-dir') {
    try {
      send(res, 200, { path: await pickDirectory() })
    } catch (error) {
      pushLog(`目录选择失败: ${error?.message || error}`)
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/pick-file') {
    try {
      send(res, 200, { path: await pickFile({ save: body.save === true, name: String(body.name || '') }) })
    } catch (error) {
      pushLog(`文件选择失败: ${error?.message || error}`)
      send(res, 200, { path: '', error: error?.message || String(error) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    openLocalUrl(body.url)
    send(res, 200, { ok: true })
    return
  }
  send(res, 404, { error: 'not found' })
}

function mime(path) {
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'text/html'
}

function isTextFile(file) {
  return /\.(html|css|js|svg|json|txt|map)$/i.test(file)
}

export async function startServer() {
  if (server) return Promise.resolve(`http://127.0.0.1:${PORT}`)
  await ensureSettings()
  // 设置页改过端口 / profile 的话，这里拿到的就是新值（PORT 环境变量仍然优先，测试用）
  if (!process.env.PORT) PORT = resolvePort()
  PROFILE_NAME = resolveProfile()
  EXTRA_ARGS = composeExtraArgs((await loadSettings()).args)
  WEB_BIND = resolveWebBind()
  // 远程插件的「局域网访问」开关：开着时启动 web 不注入 --host（每次起管理器读一次）
  LAN_TOGGLE = lanBindToggleOn(homeDir(), PROFILE_NAME)
  if (CLI_ARGS.length) pushLog(`DSH.exe 传入启动参数：${CLI_ARGS.join(' ')}`)
  const stored = await loadSettings()
  // 安装/升级时选过语言就以它为准，否则用设置里存的
  const fromInstall = installLang()
  const storedLang = safeLang(stored.lang)
  if (fromInstall && fromInstall !== storedLang) await saveSettings({ lang: fromInstall })
  LANG = fromInstall || storedLang || 'zh'
  LANG = LANG === 'en' ? 'en' : 'zh'
  THEME = safeTheme(stored.theme)
  PANEL_TRANSPARENCY = safePanelTransparency(stored.panelTransparency)
  REDUCE_MOTION = stored.reduceMotion === true
  HIDE_BACKGROUND = stored.hideBackground === true
  HIDE_BIG_FISH = stored.hideBigFish === true
  S3_CONFIG = safeS3Config(stored.s3)
  WEBDAV_CONFIG = safeWebdavConfig(stored.webdav)
  FOLDER_CONFIG = safeFolderConfig(stored.folder)
  ZIP_CONFIG = safeZipConfig(stored.zip)
  SYNC_OPTIONS = safeSyncSettings(stored.sync)
  secretValues = [S3_CONFIG.secretAccessKey, S3_CONFIG.sessionToken, WEBDAV_CONFIG.password].filter(Boolean)
  DATA = resolveDataDir()
  CONFIG = join(DATA, 'config.json')
  await mkdir(DATA, { recursive: true })
  cleanStaleUpdates()
  // 检查过但一直没装的整合包会留在 inbox 里，启动时清一次过期的（DATA 可能刚改过）
  void prunePackInbox()
  // 默认 16KB 的请求头上限会被浏览器里堆积的 cookie 顶爆（HTTP 431），放宽到 128KB
  const handler = async (req, res) => {
    try {
      // Host 必须是本机：恶意域名解析到 127.0.0.1（DNS rebinding）时浏览器带的是那个
      // 域名，浏览器会把它当同源，GET 接口（含 dsh 的 token、日志）就能被读走
      if (!isLocalHostHeader(req.headers.host)) {
        send(res, 403, 'forbidden', 'text/plain; charset=utf-8')
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
        return
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const path = join(PUBLIC, file)
      if (!path.startsWith(PUBLIC) || !existsSync(path)) {
        send(res, 404, 'not found', 'text/plain; charset=utf-8')
        return
      }
      const type = mime(path)
      if (isTextFile(file)) {
        let body = await readFile(path, 'utf8')
        if (file === 'index.html') {
          body = body.replaceAll('__APP_VERSION__', APP_VERSION).replaceAll('__APP_LANG__', LANG).replaceAll('__APP_THEME__', THEME).replaceAll('__APP_PANEL_TRANSPARENCY__', String(PANEL_TRANSPARENCY)).replaceAll('__APP_REDUCE_MOTION__', String(REDUCE_MOTION)).replaceAll('__APP_HIDE_BACKGROUND__', String(HIDE_BACKGROUND)).replaceAll('__APP_HIDE_BIG_FISH__', String(HIDE_BIG_FISH))
        }
        send(res, 200, body, `${type}; charset=utf-8`)
        return
      }
      send(res, 200, await readFile(path), type)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`错误: ${message}`)
      send(res, 500, { error: message })
    }
  }

  // 端口顺延：配置的端口被**别的程序**占了就往后试（最多 PORT_SCAN 个），被自己的
  // 另一个实例占着则抛 EALREADY，让 start.js 去把它唤醒——双击图标不该起出第二个管理器。
  const preferred = PORT
  let lastError = null
  for (let offset = 0; offset < PORT_SCAN; offset += 1) {
    const candidate = preferred + offset
    if (candidate > 65535) break
    const attempt = createServer({ maxHeaderSize: 128 * 1024 }, handler)
    try {
      await new Promise((resolve, reject) => {
        attempt.once('error', reject)
        attempt.listen(candidate, '127.0.0.1', () => {
          attempt.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      attempt.close()
      if (error?.code !== 'EADDRINUSE') throw error
      lastError = error
      if (await probeManager(candidate)) {
        const busy = new Error(`管理页已经在 ${candidate} 端口上跑着`)
        busy.code = 'EALREADY'
        busy.port = candidate
        throw busy
      }
      pushLog(`端口 ${candidate} 被别的程序占用，试下一个`)
      continue
    }
    attempt.on('error', (error) => pushLog(`管理服务出错: ${error?.message || error}`))
    server = attempt
    PORT = candidate
    if (offset > 0) pushLog(`管理页改用端口 ${PORT}（${preferred} 起被占用）`)
    pushLog(`DSH 管理器 http://127.0.0.1:${PORT}`)
    pushLog(`版本目录 ${DATA}`)
    pushLog(`DSH_HOME ${homeDir()}`)
    const system = detectSystemDsh()
    if (system) pushLog(`发现系统已安装 ${system.version}`)
    console.log(`dsh-versions: http://127.0.0.1:${PORT}`)
    console.log(`dsh-versions data: ${DATA}`)
    console.log(`dsh-versions home: ${homeDir()}`)
    return `http://127.0.0.1:${PORT}`
  }
  throw lastError ?? new Error('没有可用端口')
}

export async function stopAll() {
  if (current) killTree(current.child.pid)
  current = null
  for (const res of clients) {
    try { res.end() } catch { /* already gone */ }
  }
  clients.clear()
  const httpServer = server
  server = null
  if (!httpServer) return
  if (typeof httpServer.closeAllConnections === 'function') {
    httpServer.closeAllConnections()
  }
  await Promise.race([
    new Promise((resolve) => httpServer.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
}

if (/server\.js$/i.test(process.argv[1] || '')) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopAll().finally(() => process.exit(0))
    })
  }
}
