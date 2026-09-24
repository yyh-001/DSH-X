import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { APP_DIR, IS_MAC, IS_WINDOWS, MAC_BUNDLE_ID, appBundle, launcherExecutable, userAppDir } from './platform.js'

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
  // 额外启动参数（一行文本，空格分词，含空格的值用引号包起来）
  args: '',
  autoStart: false,
  seedMarket: true,
  // 启动失败时按错误点名自动禁用问题插件（兼容模式），再重试
  autoDisablePlugins: true,
  // 用户在更新弹窗里点过「不更新」的版本 { dsh?, self? }：同一个版本不再提示
  skippedUpdate: {},
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
