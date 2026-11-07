import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 外壳的进程环境，必须在 platform.js / server.js 求值之前定好（main.mjs 第一个 import 的就是本文件，
 * ES 模块按 import 顺序求值）：platform.js 在加载时就定下子进程用的 node（RUNTIME_NODE），
 * server.js 启动管理服务时还会再拼一次 PATH。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
/** 从 Finder / 程序坞打开的应用只拿到 launchd 的精简 PATH；插件的构建脚本会用到 git 之类，补上常见位置。 */
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']

// 用户自己的 PATH 要在改动之前留一份：下面会把自带运行时塞到最前面，而那里面的 node
// 是转调 Electron 的包装脚本，在它里面找到的「系统 node」其实是 Electron 自己。
const userDirs = String(process.env.PATH || '').split(delimiter).filter(Boolean)
const dirs = [...userDirs]
// 自带运行时目录排最前：现在里面是 npm / pnpm 和 node.cmd（转调 Electron，见 scripts/pack.mjs）
const bundled = join(ROOT, 'node')
if (existsSync(bundled)) dirs.unshift(bundled)
for (const extra of EXTRA_PATHS) if (!dirs.includes(extra)) dirs.push(extra)
process.env.PATH = [...new Set(dirs)].join(delimiter)

/** 每用户目录：和核心的 filemanager 同一套约定（%APPDATA%\DSH / ~/Library/Application Support/DSH / $XDG_CONFIG_HOME/DSH）。 */
const APP_DATA = IS_MAC
  ? join(homedir(), 'Library', 'Application Support')
  : IS_WINDOWS
    ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'))
const SETTINGS_FILE = join(APP_DATA, 'DSH', 'settings.json')

/**
 * 从用户自己的 PATH（外加 mac 的常见前缀）里找 node：显式路径优先，只填命令名时按 PATH 找。
 * 找不到返回空串。和 server.js 的 findSystemNode 是一份逻辑，但外壳不能 import 核心
 * （核心在用户目录的 core/current，更新后会整个换掉，外壳只认自己的文件）。
 */
function findSystemNode(explicit = '') {
  const name = IS_WINDOWS ? 'node.exe' : 'node'
  const searchDirs = [...userDirs, ...EXTRA_PATHS]
  const given = String(explicit || '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (given) {
    if (existsSync(given)) return given
    // 只填了命令名（没带路径分隔符）：按 PATH 找。Windows 上还要补 PATHEXT 那几种后缀
    if (!/[\\/]/.test(given)) {
      const names = IS_WINDOWS && !/\.[a-z0-9]+$/i.test(given)
        ? [given, `${given}.exe`, `${given}.cmd`, `${given}.bat`]
        : [given]
      for (const dir of searchDirs) {
        for (const name of names) {
          const file = join(dir, name)
          if (existsSync(file)) return file
        }
      }
    }
    return ''
  }
  for (const dir of searchDirs) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return ''
}

/**
 * 设置里选了「系统 node」就在这里定下 RUNTIME_NODE：platform.js 加载时只认 DSH_RUNTIME_NODE，
 * 之后 server.js / registry.js / dsh shim 全跟着它走。找不到就什么都不设 —— 回落到 Electron
 * 自带的 Node，管理页按「设置值 ≠ 生效值」提示没找到 / 重启后生效。
 * 用户环境里显式设了 DSH_RUNTIME_NODE（开发用）时以它为准，设置不覆盖。
 */
if (!process.env.DSH_RUNTIME_NODE) {
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
  } catch {
    // 没有设置文件（首次运行）或内容坏了：按默认的自带 Node 走
  }
  if (stored.nodeRuntime === 'system') {
    const found = findSystemNode(stored.systemNodePath)
    if (found) process.env.DSH_RUNTIME_NODE = found
  }
}

// 告诉管理服务：管理页由外壳自己的窗口承载、外壳会开内部标签页（server.js 的 shellWindowHost /
// internalTabsHost）。同进程，所以直接写自己的环境变量。
process.env.DSH_APP_WINDOW = '1'
process.env.DSH_INTERNAL_TABS = '1'
// 这个外壳认设置文件里的系统开关（硬件加速 / 更新通道 / 通知 / 托盘 / 防休眠，见 prefs.mjs）。
// 旧外壳没有这个标记，管理页据此把那一组开关标成「更新后可用」，而不是假装它们已经生效。
process.env.DSH_SHELL_PREFS = '1'
