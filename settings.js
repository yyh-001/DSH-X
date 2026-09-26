import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { APP_DIR, IS_MAC, IS_WINDOWS, MAC_BUNDLE_ID, appBundle, launcherExecutable, userAppDir } from './platform.js'
import { safeFolderConfig, safePolicy, safeS3Config, safeScopeIds, safeStoreType, safeWebdavConfig, safeZipConfig } from './sync.js'

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const SETTINGS_DIR = APP_DIR
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const RUN_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'DSH'
/** macOS 的登录自启：每用户 LaunchAgent，文件在就算开着（登录时 launchd 按它拉起启动器）。 */
const LAUNCH_AGENT = join(homedir(), 'Library', 'LaunchAgents', `${MAC_BUNDLE_ID}.plist`)

/** 管理页端口，默认这个；被别的程序占了可以在设置页改。 */
export const DEFAULT_PORT = 3780

/** 目录不可用时给一句人话，别把 EPERM 原样丢给用户。 */
function describeDirError(dir, error) {
  const code = String(error?.code || '')
  if (code === 'EPERM' || code === 'EACCES') {
    return IS_MAC
      ? `没有权限写这个目录：${dir}；请换一个当前用户能写的普通目录（例如 ~/DSH-X），不要用 /Applications、/System 这类系统目录。`
      : `没有权限写这个目录：${dir}；请换一个当前用户能写的普通目录（例如 D:\\DSH-X），不要用 Program Files、Windows 这类系统目录。`
  }
  if (code === 'ENOTDIR' || code === 'EEXIST') {
    return `这不是一个目录：${dir}`
  }
  return `版本目录不可用：${dir}（${error?.message || error}）`
}

/**
 * 版本目录得真的能写：先建目录，再写一个探针文件。
 * 单靠 mkdir 不够——目录已存在时 recursive mkdir 会静默成功，但里面未必能写文件。
 * 失败在切换目录**之前**抛出，所以 DATA / settings.json 都不会被改坏。
 */
export async function ensureWritableDir(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    throw new Error(describeDirError(dir, error))
  }
  const probe = join(dir, '.dsh-write-probe')
  try {
    await writeFile(probe, '')
    await rm(probe, { force: true })
  } catch (error) {
    throw new Error(describeDirError(dir, error))
  }
  return dir
}

/** dsh 的启动 profile（一个 profile 一套插件和数据），默认 web。 */
export const DEFAULT_PROFILE = 'web'

/** Web 绑定方式：loopback（回环，默认）/ lan（局域网，不注入 --host，交给配置层决定）。 */
export const DEFAULT_WEB_BIND = 'loopback'
/**
 * 下载源选项：镜像源同步官方有延迟，刚发布的版本会「检查到更新却装不上」，
 * 想第一时间拿到新版本就切官方源（国内直连可能慢，最好配代理）。
 */
export const DOWNLOAD_SOURCES = {
  mirror: 'https://registry.npmmirror.com',
  official: 'https://registry.npmjs.org',
}
export const DEFAULT_SOURCE = 'mirror'

/**
 * 启动器自身更新的下载源。GitHub 在国内经常连不上或慢到超时，直连失败时按这里的
 * 前缀再试一遍（顺序即优先级）；镜像只做转发，包本身没变——但仍然经过第三方。
 *
 * 默认「国内加速」，注意它不是「只走镜像」：候选列表永远是「先直连、失败才走前缀」
 * （见 updateUrlCandidates），所以能直连的网络一次都碰不到镜像，只是多一条退路；
 * 而「直连」在国内等于没有退路——自更新、整合包市场与包下载会直接失败。
 */
export const UPDATE_SOURCES = {
  direct: [],
  mirror: [
    'https://gh-proxy.com/',
    'https://ghfast.top/',
  ],
}
export const DEFAULT_UPDATE_SOURCE = 'mirror'

/** 更新下载源只认内置选项，脏值回默认（国内加速：直连优先、失败走镜像）。 */
export function safeUpdateSource(value) {
  const name = String(value ?? '').trim()
  return UPDATE_SOURCES[name] ? name : DEFAULT_UPDATE_SOURCE
}

/**
 * 老配置的一次性迁移：把仍是老默认值「直连」的设置改成「国内加速」。
 *
 * 为什么值得替用户改：新默认只是「多一条退路」，而「直连」在国内根本走不通——市场
 * 索引的域名被 DNS 污染、release 资产的 443 连不上——失败时用户只看到一句 fetch failed。
 * 迁移过就记一笔标记，用户之后自己选回「直连」不会再被动。返回要补写的字段，没什么要改就返回 null。
 */
export function migrateUpdateSource(stored) {
  if (!stored || typeof stored !== 'object') return null
  if (stored.updateSourceMigrated === true) return null
  const chosen = String(stored.updateSource || '').trim()
  // 没存过这个字段、或用户自己选过别的源：只补标记，不动他的选择
  if (chosen && chosen !== 'direct') return { updateSourceMigrated: true }
  return { updateSource: DEFAULT_UPDATE_SOURCE, updateSourceMigrated: true }
}

/**
 * 打开 dsh 页面的方式：
 *
 * - tab：系统默认浏览器的标签页（默认）；
 * - app：用 Chromium 系浏览器的应用窗口打开（Chrome/Edge 的 --app=…，没有地址栏，更像
 *   一个 App）。找不到 Chrome/Edge 就退回标签页，所以这个选项是「尽量」而不是「必须」；
 * - window：装进启动器自己的窗口（原生外壳再开一个 WebView2 窗口承载 dsh 界面），完全不
 *   经过浏览器进程——关窗口、托盘、退出都由启动器自己说了算。它只在原生外壳托管下成立
 *   （外壳设了 DSH_APP_WINDOW=1，并在 stdout 上收约定标记），源码运行（npm start）时选它
 *   会安静地退回标签页，不会开出一个没人管的窗口。
 */
export const OPEN_MODES = ['tab', 'app', 'window']
export const DEFAULT_OPEN_MODE = 'tab'

export function safeOpenMode(value) {
  const name = String(value ?? '').trim()
  return OPEN_MODES.includes(name) ? name : DEFAULT_OPEN_MODE
}

/** 按下载源把发布页地址展开成待试列表：直连永远排第一，后面才是镜像前缀。 */
export function updateUrlCandidates(url, source = DEFAULT_UPDATE_SOURCE) {
  const direct = String(url ?? '').trim()
  if (!direct) return []
  const prefixes = UPDATE_SOURCES[safeUpdateSource(source)] || []
  return [direct, ...prefixes.map((prefix) => `${prefix}${direct}`)]
}

/** dsh 用户目录（DSH_HOME）：留空用默认 ~/.dsh；填了必须是绝对路径。 */
export function safeDshHome(dir) {
  if (dir === undefined || dir === null) return ''
  if (typeof dir !== 'string') throw new Error('dsh 用户目录填一个路径，别填别的')
  const trimmed = dir.trim()
  if (!trimmed) return ''
  if (!isAbsolute(trimmed)) throw new Error('请使用绝对路径（例如 D:\\dsh-home）')
  return resolve(trimmed)
}

/** dsh 用户目录没配置时的默认位置。 */
export function defaultDshHome() {
  return join(homedir(), '.dsh')
}

export const DEFAULTS = {
  dataDir: '',
  port: DEFAULT_PORT,
  profile: DEFAULT_PROFILE,
  // 界面语言：zh / en（安装时选的语言写进安装目录的 lang.txt，启动器读一次落到这里）
  lang: '',
  theme: 'system',
  panelTransparency: 0,
  reduceMotion: false,
  hideBackground: false,
  hideBigFish: false,
  downloadSource: DEFAULT_SOURCE,
  // 启动器更新的下载源：direct（默认）/ mirror（国内加速）
  updateSource: DEFAULT_UPDATE_SOURCE,
  // 打开 dsh 页面的方式：tab（默认，系统浏览器标签页）/ app（Chromium 应用窗口）/ window（启动器内嵌窗口）
  openMode: DEFAULT_OPEN_MODE,
  // dsh 的用户目录（DSH_HOME）。留空 = 默认 ~/.dsh；用户把 .dsh 挪到别的盘时在这里指回去
  dshHome: '',
  // 额外启动参数（一行文本，空格分词，含空格的值用引号包起来）
  args: '',
  // dsh web 的绑定方式：loopback 注入 --host 127.0.0.1（默认）；lan 不注入，
  // 由配置层（远程访问插件的「局域网访问」开关写的 profile 补丁块）决定 0.0.0.0
  webBind: DEFAULT_WEB_BIND,
  autoStart: false,
  seedMarket: true,
  // 启动失败时按错误点名自动禁用问题插件（兼容模式），再重试
  autoDisablePlugins: true,
  // 把 dsh 的 shim 目录写进用户 PATH（HKCU\Environment），让系统里也能直接用 dsh
  systemPath: false,
  // 用户在更新弹窗里点过「不更新」的版本 { dsh?, self? }：同一个版本不再提示
  skippedUpdate: {},
  // S3 同步的存储桶（含密钥，本机明文存这个文件里；字段由 safeS3Config 补齐）
  s3: {},
  // WebDAV 同步（地址 + 账号密码，同样是明文存本机）
  webdav: {},
  // 本地目录（手动导出 / 导入；就一个路径）
  folder: {},
  // 单个 ZIP 文件（导出成一个包 / 从包导入）
  zip: {},
  // 同步范围与冲突策略
  sync: {},
}

/** 下载源只认内置选项，历史文件里的脏值回默认镜像。 */
export function safeDownloadSource(value) {
  const name = String(value ?? '').trim()
  return DOWNLOAD_SOURCES[name] ? name : DEFAULT_SOURCE
}

/** 端口校验：1-65535 的整数，别的都当成没填（回默认端口）。 */
export function safePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口要填 1-65535 之间的整数')
  }
  return port
}

/** profile 名会变成 ~/.dsh/profiles 下的目录名，只允许目录安全字符。 */
export function safeProfile(value) {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name) || name === '.' || name === '..') {
    throw new Error('profile 名只能用字母、数字、点、下划线、连字符（1-32 个字符）')
  }
  return name
}

/**
 * 把「额外启动参数」那行文本切成 argv：空白分词，单双引号里的内容原样保留
 * （`--msg "hello world"` → ['--msg', 'hello world']）。未闭合的引号按到行尾处理。
 */
export function parseArgs(text) {
  const out = []
  let current = ''
  let quote = ''
  let quoted = false
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = ''
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current || quoted) out.push(current)
      current = ''
      quoted = false
      continue
    }
    current += ch
  }
  if (current || quoted) out.push(current)
  return out
}

/** 额外启动参数：只留文本，长度收个口（解析在 server.js 里做）。 */
export function safeArgs(value) {
  const text = String(value ?? '').trim()
  if (text.length > 2000) throw new Error('额外启动参数太长了（上限 2000 字符）')
  return text
}

/** 启动 profile：环境变量 DSH_PROFILE 优先（开发和测试用），其次 settings.json。 */
export function resolveProfile() {
  if (process.env.DSH_PROFILE) {
    try {
      return safeProfile(process.env.DSH_PROFILE)
    } catch { /* 环境变量不合法就退回设置 */ }
  }
  try {
    return safeProfile(loadSettingsSync().profile)
  } catch {
    return DEFAULT_PROFILE
  }
}

/** 界面语言：只认 zh / en，其余当没设。 */
export function safeLang(value) {
  const lang = String(value ?? '').trim().toLowerCase()
  return lang === 'en' ? 'en' : lang === 'zh' ? 'zh' : ''
}

/** 页面外观：跟随系统、浅色或深色；历史脏值回到跟随系统。 */
export function safeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 悬浮窗背景透明度，百分比；历史脏值回到默认值。 */
export function safePanelTransparency(value) {
  if (value === null || value === undefined || value === '') return DEFAULTS.panelTransparency
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : DEFAULTS.panelTransparency
}

/**
 * Web 绑定方式：只认 loopback / lan（顺手收下 127.0.0.1 / 0.0.0.0 两种写法），
 * 别的值一律抛错——和端口、profile 一样，显式填错要让用户知道。
 */
export function safeWebBind(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === 'loopback' || mode === '127.0.0.1') return 'loopback'
  if (mode === 'lan' || mode === '0.0.0.0') return 'lan'
  throw new Error('Web 绑定只能选 回环(loopback) 或 局域网(lan)')
}

/**
 * 远程访问插件（@linxin666/dsh-remote-web-ui）的「局域网访问」开关有没有开。
 *
 * 插件把开关存在 dsh 的设置文件里（`<dsh home>/settings.yaml` 的
 * `remote-web-ui.lanBind`）。启动器读它只为了一件事：开关开着时启动 web 不再
 * 注入 `--host 127.0.0.1`——命令行显式 --host 在 dsh 里优先于配置层，注入了
 * 回环地址，插件的开关和补丁块就永远赢不了，手机/其他电脑也就连不上。
 *
 * 没有 YAML 依赖，只在这一个文件里找这一个键：定位顶层 `remote-web-ui:` 段，
 * 在它的子行里找 `lanBind:`。读不到、格式不认识、插件没装，都当没开——
 * 启动器不依赖任何第三方插件存在。
 */
export function lanBindToggleOn(home, profile = '') {
  // 0.1.7-rc.1 起 dsh 把设置搬到「当前 profile 的 Cordis 配置」里（旧 settings.yaml 只导入一次），
  // 所以要两处都看：新位置有明确取值就以它为准，没有（还没迁移、或旧版本）再回落到旧文件。
  if (profile) {
    for (const name of ['cordis.yml', 'cordis.yaml']) {
      const value = lanBindFromYaml(readTextIfExists(join(home, 'profiles', profile, name)))
      if (value !== undefined) return value
    }
  }
  return lanBindFromYaml(readTextIfExists(join(home, 'settings.yaml'))) === true
}

/** 读文件，读不到给空串（配置缺失是常态，不该抛）。 */
function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 在 YAML 文本里找「提到 remote-web-ui 的那一段」里的 lanBind。
 * 段可以在顶层（旧 settings.yaml 的形状），也可以是嵌套的插件条目（新 profile 配置的形状）；
 * 段内允许隔着别的键。找不到返回 undefined（＝这份文件没说），false 才是明确说「关」。
 */
export function lanBindFromYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (!/remote-web-ui/i.test(line)) continue
    if (!/:\s*(?:\{.*)?$/.test(line)) continue
    // 同一行写成流式映射的情况：{ lanBind: true }
    const inline = /lanBind\s*:\s*([^,}\s]+)/.exec(line)
    if (inline) return /^(?:true|yes|on|1)$/i.test(inline[1].replace(/^['"]|['"]$/g, ''))
    const indent = line.length - line.trimStart().length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (!next.trim() || /^\s*#/.test(next)) continue
      const nextIndent = next.length - next.trimStart().length
      // 缩进回落到这一段之外（或更浅）说明段结束了；数组项不算出段
      if (nextIndent <= indent && !/^\s*-\s/.test(next)) break
      const match = /^\s*lanBind\s*:\s*(.+?)\s*$/.exec(next)
      if (match) return /^(?:true|yes|on|1)$/i.test(match[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  return undefined
}

/** 管理页端口：环境变量 PORT（开发和测试用）优先，其次 settings.json。 */
export function resolvePort() {
  const fromEnv = Number(process.env.PORT || 0)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    return safePort(loadSettingsSync().port)
  } catch {
    return DEFAULT_PORT
  }
}

/** Web 绑定方式：设置文件里的脏值退回默认（回环），和端口、profile 一个口径。 */
export function resolveWebBind() {
  try {
    return safeWebBind(loadSettingsSync().webBind)
  } catch {
    return DEFAULT_WEB_BIND
  }
}

function hasInstall(dir) {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'versions'))
}

export function safeDataDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('版本目录不能为空')
  const trimmed = dir.trim()
  // 先判再 resolve：resolve 会把相对路径按当前工作目录补齐，补完就永远是绝对路径，
  // 倒过来判等于没有这条校验——用户在设置页填个 dsh-data 会安静地落到启动器所在目录
  if (!isAbsolute(trimmed)) throw new Error('请使用绝对路径')
  return resolve(trimmed)
}

export function fallbackDataDir() {
  const local = join(ROOT, 'data')
  if (hasInstall(local)) return local
  const userDir = userAppDir()
  if (userDir) {
    const roaming = join(userDir, 'data')
    if (hasInstall(roaming)) return roaming
    // 装好的启动器（有原生外壳）一律放每用户目录；macOS 的安装目录在 .app 包里，更是写不得
    if (launcherExecutable()) return roaming
  }
  return local
}

function mergeStoredSettings(stored) {
  const merged = { ...DEFAULTS, ...stored }
  if (!('hideBackground' in stored) && 'disableBackgroundAnimation' in stored) {
    merged.hideBackground = stored.disableBackgroundAnimation === true
  }
  delete merged.disableBackgroundAnimation
  return merged
}

export function loadSettingsSync() {
  try {
    return mergeStoredSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export async function loadSettings() {
  try {
    return mergeStoredSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** 跳过记录只留非空版本号，别让历史文件里的脏值影响更新提示。 */
function normalizeSkippedUpdate(value) {
  const out = {}
  for (const key of ['dsh', 'self']) {
    const version = value && typeof value === 'object' ? value[key] : ''
    if (typeof version === 'string' && version.trim()) out[key] = version.trim()
  }
  return out
}

/** S3 存储桶 + 同步范围：字段补全、脏值回默认；显式填错（桶名、端点）时抛给调用方。 */
export function safeSyncSettings(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    // 用哪种远端：s3（默认，老配置里没这个字段就是它）/ webdav
    store: safeStoreType(source.store),
    scopes: safeScopeIds(source.scopes),
    policy: safePolicy(source.policy),
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings()
  const merged = { ...current, ...patch }
  if (merged.dataDir) merged.dataDir = safeDataDir(merged.dataDir)
  // 历史文件里的脏端口值顺手修回默认；显式改端口时才把错误抛给调用方
  try {
    merged.port = safePort(merged.port)
  } catch {
    merged.port = DEFAULT_PORT
  }
  if ('port' in patch) merged.port = safePort(patch.port)
  // 同端口：脏值顺手修回默认，显式改 profile 时才把错误抛给调用方
  try {
    merged.profile = safeProfile(merged.profile)
  } catch {
    merged.profile = DEFAULT_PROFILE
  }
  if ('profile' in patch) merged.profile = safeProfile(patch.profile)
  merged.args = 'args' in patch ? safeArgs(patch.args) : safeArgs(merged.args)
  merged.lang = 'lang' in patch ? safeLang(patch.lang) : safeLang(merged.lang)
  merged.theme = safeTheme(merged.theme)
  merged.panelTransparency = safePanelTransparency(merged.panelTransparency)
  merged.reduceMotion = merged.reduceMotion === true
  merged.hideBackground = merged.hideBackground === true
  merged.hideBigFish = merged.hideBigFish === true
  // 同 webBind：脏值顺手修回默认（回环），显式改绑定方式时才把错误抛给调用方
  try {
    merged.webBind = safeWebBind(merged.webBind)
  } catch {
    merged.webBind = DEFAULT_WEB_BIND
  }
  if ('webBind' in patch) merged.webBind = safeWebBind(patch.webBind)
  merged.downloadSource = safeDownloadSource(merged.downloadSource)
  merged.openMode = safeOpenMode(merged.openMode)
  if ('openMode' in patch) merged.openMode = safeOpenMode(patch.openMode)
  merged.autoStart = Boolean(merged.autoStart)
  merged.seedMarket = merged.seedMarket !== false
  merged.autoDisablePlugins = merged.autoDisablePlugins !== false
  merged.skippedUpdate = normalizeSkippedUpdate(merged.skippedUpdate)
  // S3 同步：脏值顺手补全（密钥缺失只是「没配好」，不该让保存失败），显式填错才抛
  merged.s3 = safeS3Config('s3' in patch ? patch.s3 : merged.s3)
  merged.webdav = safeWebdavConfig('webdav' in patch ? patch.webdav : merged.webdav)
  merged.folder = safeFolderConfig('folder' in patch ? patch.folder : merged.folder)
  merged.zip = safeZipConfig('zip' in patch ? patch.zip : merged.zip)
  merged.sync = safeSyncSettings('sync' in patch ? patch.sync : merged.sync)
  // 已废弃的 AI 修复配置：清掉历史文件里的残留字段
  for (const key of ['aiRepair', 'aiModel', 'aiBaseURL', 'aiApiKey', 'aiMaxRounds', 'aiAllowDestructive']) {
    delete merged[key]
  }
  await mkdir(SETTINGS_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2))
  return merged
}

export function inferDataDir() {
  if (process.env.DSH_VERSIONS_DATA) return process.env.DSH_VERSIONS_DATA
  return fallbackDataDir()
}

export function resolveDataDir() {
  const settings = loadSettingsSync()
  if (settings.dataDir) return safeDataDir(settings.dataDir)
  return inferDataDir()
}

export async function ensureSettings() {
  const stored = await loadSettings()
  const dataDir = stored.dataDir ? safeDataDir(stored.dataDir) : inferDataDir()
  const patch = {}
  if (stored.dataDir !== dataDir) patch.dataDir = dataDir
  // 一次性迁移：老配置里的「下载源：直连」改成新默认「国内加速」（详见 migrateUpdateSource）
  const migration = migrateUpdateSource(stored)
  if (migration) Object.assign(patch, migration)
  if (!Object.keys(patch).length) return stored
  return saveSettings(patch)
}

/** 登录自启要执行的 argv：装好的走原生外壳，源码运行就直接 node start.js。 */
function launchArgs() {
  const exe = launcherExecutable()
  // macOS 走 open 而不是直接执行包里的二进制：LaunchServices 负责单实例和把应用带到前台
  if (IS_MAC && exe) return ['/usr/bin/open', '-a', appBundle()]
  if (exe) return [exe]
  return [process.execPath, join(ROOT, 'start.js')]
}

export function launchCommand() {
  return launchArgs().map((arg) => `"${arg}"`).join(' ')
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** LaunchAgent 的 plist：只在登录时跑一次（RunAtLoad），不设 KeepAlive——用户退出了就别再拉起来。 */
export function launchAgentPlist(args = launchArgs(), cwd = ROOT) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(MAC_BUNDLE_ID)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(cwd)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function runReg(args) {
  return execFileAsync('reg.exe', args, { windowsHide: true, encoding: 'utf8' })
}

export async function autoStartEnabled() {
  if (IS_MAC) return existsSync(LAUNCH_AGENT)
  if (!IS_WINDOWS) return false
  try {
    await runReg(['query', RUN_REG, '/v', RUN_NAME])
    return true
  } catch {
    return false
  }
}

export async function setAutoStart(enabled) {
  if (IS_MAC) {
    // 只写/删文件，不 launchctl load：load 会立刻再拉起一个启动器，而这里要的只是「下次登录时」
    if (enabled) {
      await mkdir(dirname(LAUNCH_AGENT), { recursive: true })
      await writeFile(LAUNCH_AGENT, launchAgentPlist())
    } else {
      await rm(LAUNCH_AGENT, { force: true })
    }
    return
  }
  if (!IS_WINDOWS) {
    if (enabled) throw new Error('开机自启目前只支持 Windows 和 macOS')
    return
  }
  const on = await autoStartEnabled()
  if (on === Boolean(enabled)) return
  if (enabled) {
    await runReg(['add', RUN_REG, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', launchCommand(), '/f'])
    return
  }
  try {
    await runReg(['delete', RUN_REG, '/v', RUN_NAME, '/f'])
  } catch {
    // already off
  }
}
