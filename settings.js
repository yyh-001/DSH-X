import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const SETTINGS_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'DSH') : join(ROOT, 'data')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const RUN_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'DSH'

/** 管理页端口，默认这个；被别的程序占了可以在设置页改。 */
export const DEFAULT_PORT = 3780

/** 目录不可用时给一句人话，别把 EPERM 原样丢给用户。 */
function describeDirError(dir, error) {
  const code = String(error?.code || '')
  if (code === 'EPERM' || code === 'EACCES') {
    return `没有权限写这个目录：${dir}；请换一个当前用户能写的普通目录（例如 D:\\DSH-X），不要用 Program Files、Windows 这类系统目录。`
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
  // 额外启动参数（一行文本，空格分词，含空格的值用引号包起来）
  args: '',
  // dsh web 的绑定方式：loopback 注入 --host 127.0.0.1（默认）；lan 不注入，
  // 由配置层（远程访问插件的「局域网访问」开关写的 profile 补丁块）决定 0.0.0.0
  webBind: DEFAULT_WEB_BIND,
  autoStart: false,
  seedMarket: true,
  // 启动失败时按错误点名自动禁用问题插件（兼容模式），再重试
  autoDisablePlugins: true,
  // 用户在更新弹窗里点过「不更新」的版本 { dsh?, self? }：同一个版本不再提示
  skippedUpdate: {},
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
export function lanBindToggleOn(home) {
  let text = ''
  try {
    text = readFileSync(join(home, 'settings.yaml'), 'utf8')
  } catch {
    return false
  }
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (!inSection) {
      if (indent === 0 && /^remote-web-ui\s*:/.test(line)) inSection = true
      continue
    }
    // 缩进回落到顶层（或更浅）说明这个段结束了
    if (indent <= 0) break
    const match = /^\s*lanBind\s*:\s*(.+?)\s*$/.exec(line)
    if (match) {
      const value = match[1].replace(/^['"]|['"]$/g, '')
      return /^(?:true|yes|on|1)$/i.test(value)
    }
  }
  return false
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
  if (process.env.APPDATA) {
    const roaming = join(process.env.APPDATA, 'DSH', 'data')
    if (hasInstall(roaming)) return roaming
  }
  if (existsSync(join(ROOT, 'DSH.exe')) && process.env.APPDATA) {
    return join(process.env.APPDATA, 'DSH', 'data')
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
  merged.autoStart = Boolean(merged.autoStart)
  merged.seedMarket = merged.seedMarket !== false
  merged.autoDisablePlugins = merged.autoDisablePlugins !== false
  merged.skippedUpdate = normalizeSkippedUpdate(merged.skippedUpdate)
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
  if (stored.dataDir === dataDir) return stored
  return saveSettings({ ...stored, dataDir })
}

export function launchCommand() {
  const exe = join(ROOT, 'DSH.exe')
  if (existsSync(exe)) return `"${exe}"`
  return `"${process.execPath}" "${join(ROOT, 'start.js')}"`
}

function runReg(args) {
  return execFileAsync('reg.exe', args, { windowsHide: true, encoding: 'utf8' })
}

export async function autoStartEnabled() {
  if (process.platform !== 'win32') return false
  try {
    await runReg(['query', RUN_REG, '/v', RUN_NAME])
    return true
  } catch {
    return false
  }
}

export async function setAutoStart(enabled) {
  if (process.platform !== 'win32') {
    if (enabled) throw new Error('开机自启目前只支持 Windows')
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
