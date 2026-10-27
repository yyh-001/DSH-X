import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 平台常量，外加「Electron 本体当 node 用」的那套推导。
 *
 * 文件管理那一摊的行为（每用户目录在哪、外壳在哪、怎么弹对话框、怎么打开目录、
 * 开机自启）不在这里，在 filemanager.js 选出来的实现类里——这边只留常量，
 * 是为了让打包脚本能在任何一台机器上 import 它，不被平台判断牵连。
 */

const ROOT = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** 管理服务是不是跑在 Electron 主进程里（Windows/macOS 外壳都是，见 shell/main.mjs）。 */
export const IN_ELECTRON = Boolean(process.versions.electron)

/** 打包后的 Electron 外壳（`electron .` 源码运行时 process.defaultApp 为 true）。 */
export const PACKAGED = IN_ELECTRON && !process.defaultApp

/** npm 版（dsh-x 包拉起 Electron）：更新走 npm，不走安装包/核心自更新。 */
export const NPM_MODE = process.env.DSH_NPM === '1'

/**
 * 拉子进程（dsh、npm、pnpm）用的 node。
 *
 * 普通情况下就是正在跑的这个 node（源码运行 = 系统 node）。Electron 外壳里没有单独的 node
 * 可执行文件：Electron 本体就带着 Node（44 起是 Node 24），子进程设 ELECTRON_RUN_AS_NODE=1
 * 后按 node 跑。所以这里把 Electron 本体当 node 返回，环境变量由 RUNTIME_NODE_ENV 补。
 * （0.1.19 及以前的安装包在 node/ 下自带过一份 node，保留 existsSync 判断兼容它们。）
 * DSH_RUNTIME_NODE 可以显式指定（打包脚本和开发测试用）。
 */
export function runtimeNode(env = process.env, root = ROOT, inElectron = IN_ELECTRON) {
  if (!inElectron) return process.execPath
  if (env.DSH_RUNTIME_NODE) return env.DSH_RUNTIME_NODE
  const bundled = join(root, 'node', IS_WINDOWS ? 'node.exe' : 'node')
  if (existsSync(bundled)) return bundled
  return process.execPath
}

/** 进程启动时定一次；server.js / registry.js / settings.js 都从这里取，别再各自读 process.execPath。 */
export const RUNTIME_NODE = runtimeNode()

/** RUNTIME_NODE 是不是 Electron 本体（Electron 自带 Node）。 */
export function runtimeNodeEnv(nodePath = RUNTIME_NODE, execPath = process.execPath, inElectron = IN_ELECTRON) {
  if (!inElectron || !nodePath) return {}
  const left = IS_WINDOWS ? String(nodePath).toLowerCase() : String(nodePath)
  const right = IS_WINDOWS ? String(execPath).toLowerCase() : String(execPath)
  return left === right ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** 过滤掉 node_modules 里随包发的 node 之后的环境变量；spawn 子进程时展开它。 */
export const RUNTIME_NODE_ENV = runtimeNodeEnv()

/** 每用户目录的名字（settings.json、manager.log、webview 数据都在它下面；旧 Rust 外壳里有同名常量）。 */
export const APP_DIR_NAME = 'DSH'

/** macOS 包的名字和 bundle id：Info.plist、LaunchAgent、自更新都认它们。 */
export const MAC_APP_NAME = 'DSH-X.app'
export const MAC_BUNDLE_ID = 'io.github.yyh-001.dsh-x'
/** 外壳可执行文件名（Windows：Cargo.toml 的 [[bin]] name；macOS：Electron 包的 executableName）。 */
export const LAUNCHER_NAME = 'DSH'
