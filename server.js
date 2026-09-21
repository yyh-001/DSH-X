import { execFile, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cmpVer, installSpec, listPackage, parseVer } from './registry.js'
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
  autoStartEnabled,
  DEFAULT_PORT,
  ensureSettings,
  loadSettings,
  resolveDataDir,
  resolvePort,
  resolveProfile,
  safeDataDir,
  safePort,
  safeProfile,
  saveSettings,
  setAutoStart,
} from './settings.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
let DATA = resolveDataDir()
const PUBLIC = join(ROOT, 'public')
let CONFIG = join(DATA, 'config.json')
const PKG = '@deepseek-ai/dsh'
const MARKET_PKG = 'dshmarket'
const APP_VERSION = String(pkg.version || '0.0.0')
const APP_REPO = 'yyh-001/DSH-X'
const APP_SETUP = 'DSH-Setup.exe'
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
const LOG_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'DSH') : join(ROOT, 'data')
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
  return join(homedir(), '.dsh')
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
 * 装完新版后清理旧版本：只留最新的和上一个，正在运行的除外。
 * @returns 被清理掉的版本号
 */
async function pruneVersions(config) {
  const versions = listedVersions(config)
  if (versions.length <= KEEP_VERSIONS) return []
  const keep = new Set(versions.slice(0, KEEP_VERSIONS))
  if (current?.version) keep.add(current.version)
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
    if (!/^DSH-X-update-.+\.exe$/i.test(name)) continue
    try {
      unlinkSync(join(tmpdir(), name))
      pushLog(`已清理上次的安装包 ${name}`)
    } catch {
      // 还被安装程序占着就随它去，下次启动再说
    }
  }
}

/** 第一步：下载 + 校验。进度通过 selfUpdate 事件推给页面。 */
async function downloadSelfUpdate() {
  const info = await checkSelfUpdate()
  const target = join(tmpdir(), `DSH-X-update-${info.latest || 'latest'}.exe`)
  pushLog(`下载更新${info.latest ? ` ${info.latest}` : ''}…`)

  const res = await fetch(info.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
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
  // 只认 PE 可执行文件：拿到的更可能是错误页、或者被掐断的半截文件
  if (buffer.length < 5 * 1024 * 1024 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
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
  emit('selfUpdate', { phase: 'install', latest: staged.latest })
  // 先让响应发出去，再停 dsh、退出——此时安装目录里已经没有属于我们的进程占着文件了
  setTimeout(() => {
    shutdown().finally(() => process.exit(0))
  }, 900)
  return { latest: staged.latest, file: staged.file }
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
  }
}

async function applyDataDir(dir) {
  await mkdir(dir, { recursive: true })
  DATA = dir
  CONFIG = join(DATA, 'config.json')
  pushLog(`版本目录 ${DATA}`)
}

async function publicSettings() {
  const stored = await loadSettings()
  return {
    dataDir: DATA,
    dshHome: homeDir(),
    // port 是配置值（重启后生效），listenPort 是当前真正在监听的端口
    port: stored.port ?? DEFAULT_PORT,
    listenPort: PORT,
    portDefault: DEFAULT_PORT,
    autoStart: await autoStartEnabled(),
    seedMarket: stored.seedMarket !== false,
    autoDisablePlugins: stored.autoDisablePlugins !== false,
    profile: PROFILE_NAME,
    profiles: listProfiles(),
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
    autoStart: Boolean(body.autoStart),
    seedMarket: body.seedMarket !== false,
    autoDisablePlugins: body.autoDisablePlugins !== false,
  })
  try {
    await setAutoStart(stored.autoStart)
  } catch (error) {
    pushLog(`开机自启未写入: ${error instanceof Error ? error.message : error}`)
  }
  // profile 立即生效：插件页、启动参数、npmrc 都读这个变量（已经在跑的 dsh 不受影响）
  if (stored.profile && stored.profile !== PROFILE_NAME) {
    pushLog(`启动 profile 改为 ${stored.profile}`)
    PROFILE_NAME = stored.profile
  }
  if (stored.seedMarket) {
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
function dshEnv(version) {
  const home = homeDir()
  const workerCompat = existsSync(WORKER_COMPAT)
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_NODE: process.execPath,
    DSH_BIN: binPath(version),
    DSH_VERSION: version,
    DSH_PROFILE: PROFILE_NAME,
    // 浏览器里堆积的 cookie 会顶爆默认 16KB 的请求头上限（HTTP 431），一并放宽；
    // app 用系统证书库（Windows 证书存储），否则挂了代理 / TUN（mihomo 之类）做
    // TLS 中间人时，DeepSeek 的请求会以 transport failed 收场；
    // --require 用于把会话事件兼容补丁带进 dsh 起的 worker 线程。这里只放文件名，
    // 目录靠下面的 NODE_PATH 传（原因见 WORKER_COMPAT）。
    NODE_OPTIONS: [
      '--use-system-ca',
      process.env.NODE_OPTIONS,
      '--max-http-header-size=131072',
      workerCompat ? `--require ${basename(WORKER_COMPAT)}` : '',
    ].filter(Boolean).join(' '),
    npm_config_ignore_workspace_root_check: 'true',
    PATH: withBundledRuntime(process.env.PATH || ''),
  }
  if (workerCompat) {
    // NODE_PATH 是分号分隔的，条目本身带空格没关系，正好兜住带空格的安装路径
    env.NODE_PATH = [WORKER_COMPAT_DIR, process.env.NODE_PATH].filter(Boolean).join(delimiter)
  }
  return env
}

/**
 * 把便携运行时的目录放到 PATH 最前面。
 *
 * `dsh plugin` 是 pnpm 的透传器，装插件（含首次预装 dshmarket）必须有 pnpm；机器上
 * 有没有全局 pnpm 全看运气，所以安装包自带一份。另外插件里常带原生模块和 postinstall
 * 构建脚本，也指望能就地找到 node/npm。
 */
function withBundledRuntime(pathValue) {
  const dir = join(ROOT, 'node')
  if (!existsSync(join(dir, 'node.exe'))) return pathValue
  const parts = String(pathValue).split(delimiter).filter(Boolean)
  return [dir, ...parts.filter((item) => item !== dir)].join(delimiter)
}

function profileDir() {
  return join(homeDir(), 'profiles', PROFILE_NAME)
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

/** dsh 启动参数。 */
function bootArgs() {
  return [PROFILE_NAME, '--host', '127.0.0.1', '--port', '0', '--no-open']
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

function spawnDsh(version, extra) {
  const home = homeDir()
  const bin = binPath(version)
  const args = [...HOOKS.flatMap((file) => ['--import', pathToFileURL(file).href]), bin, ...extra]
  return spawn(process.execPath, args, {
    cwd: home,
    env: dshEnv(version),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function ensureProfileNpmrc() {
  const dir = join(homeDir(), 'profiles', PROFILE_NAME)
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
    if (!latest) return fallback
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
  try {
    const res = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-launcher',
      },
    })
    if (res.ok) {
      const rel = await res.json()
      return stripTag(rel.tag_name)
    }
  } catch { /* HTML fallback */ }
  const page = await fetch(`https://github.com/${APP_REPO}/releases/latest`, {
    headers: { 'user-agent': 'dsh-launcher' },
    redirect: 'follow',
  })
  if (!page.ok) return null
  const match = /\/releases\/tag\/([^/?#]+)/.exec(page.url || '')
  return match ? stripTag(decodeURIComponent(match[1])) : null
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

/** 跑一条 `dsh plugin …`（透传给 pnpm），输出进日志。 */
function runPluginCommand(ver, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawnDsh(ver, ['plugin', '--profile', PROFILE_NAME, ...args])
    // 留一份输出尾巴挂在错误上：只报退出码的话调用方没法判断是哪种失败，只能瞎猜着重试
    const tail = []
    const keep = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const text = redact(line, secretValues)
        tail.push(text)
        if (tail.length > 40) tail.shift()
        pushLog(`[plugin] ${text}`)
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
async function useHoistedLinker() {
  const file = join(homeDir(), 'profiles', PROFILE_NAME, '.npmrc')
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

function pruneDanglingLinks(dir) {
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
    if (!isLink) continue
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
    await mkdir(homeDir(), { recursive: true })
    await ensureProfileNpmrc()
    await runPluginCommand(version, ['install', '--config.auto-install-peers=false'], 'dsh plugin install')
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
  const urls = [...new Set([...html.matchAll(/\/plugins\/[^"'\s<>)]+/g)].map((match) => match[0].replaceAll('&amp;', '&')))]
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
    if (result.failed.length) {
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
  pushLog(`启动 ${ver} · profile ${PROFILE_NAME}`)
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
 * 兼容模式：启动输出点名了某个插件行加载失败时，把该行写进补丁层禁用。
 * 只信任错误的原始输出（failed to import loader entry <行> (<包>)），官方组件不动。
 * @returns 是否改动了配置（改动后上层立刻重试启动）。
 */
async function autoDisableFailedPlugins(error, already) {
  const settings = await loadSettings()
  if (settings.autoDisablePlugins === false) return false
  const failure = error?.failure || lastFailure
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

/** 允许当作"本机"的主机名——打开本机页面、判断请求来源都用它。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

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

function openExternal(target) {
  const url = String(target)
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

export { snapshot, stop }

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
  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, await snapshot())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    send(res, 200, { ...listPlugins(profileDir()), profile: PROFILE_NAME, autoFix: lastAutoFix })
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
    const result = setPluginEnabled(profileDir(), name, enabled)
    pushLog(`插件 ${name} → ${enabled ? '启用' : '禁用'}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...listPlugins(profileDir()), profile: PROFILE_NAME, autoFix: lastAutoFix })
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
  if (req.method === 'POST' && url.pathname === '/api/wake') {
    await host.onWake?.()
    send(res, 200, { ok: true })
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
  DATA = resolveDataDir()
  CONFIG = join(DATA, 'config.json')
  await mkdir(DATA, { recursive: true })
  cleanStaleUpdates()
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
        if (file === 'index.html') body = body.replaceAll('__APP_VERSION__', APP_VERSION)
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
