import { IS_MAC, IS_WINDOWS } from './platform.js'
import { FileManager, PosixFileManager } from './filemanager-base.js'

/**
 * 按平台挑一套文件管理实现，业务代码只认这里导出的 `fileManager`。
 *
 * 实现类分开打包：`filemanager-windows.js` 只进 Windows 安装包，`filemanager-mac.js`
 * 只进 macOS 的 .app（见 scripts/pack-common.mjs 的 APP_FILES）。所以只能用动态
 * import —— 静态 import 会在「另一套实现没被打进来」的那一侧直接报模块找不到。
 *
 * 契约、基类和 Linux 的兜底实现都在 filemanager-base.js：实现类静态 import 的是它，
 * 不是本文件——本文件有顶层 await，实现类再回头 import 它就会死锁。
 *
 * 要加 Linux：照着两个实现类写一个 `filemanager-linux.js`（整份契约在基类的注释里），
 * 在下面挂上，再把它加进 `APP_FILES` 的平台分支。在那之前 Linux 落到 PosixFileManager：
 * xdg-open 能用，系统对话框和自启直接报不支持——和这次重构之前的行为一致。
 */
async function pickFileManager() {
  if (IS_WINDOWS) return (await import('./filemanager-windows.js')).WindowsFileManager
  if (IS_MAC) return (await import('./filemanager-mac.js')).MacFileManager
  return PosixFileManager
}

const Implementation = await pickFileManager()

/** 本进程用的那一个。业务代码只认它，不再自己判平台。 */
export const fileManager = new Implementation()

/** settings.json 与日志所在的目录（老代码从 platform.js 拿的那个 APP_DIR）。 */
export const APP_DIR = fileManager.appDir

export { FileManager, PosixFileManager }
