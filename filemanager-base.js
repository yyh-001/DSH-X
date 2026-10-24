import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_NODE } from './platform.js'

/**
 * 文件管理这一摊的契约：每用户目录与安装布局、路径大小写、目录链接、系统文件
 * 对话框、在资源管理器 / 访达里打开或定位、交给系统默认程序打开地址、登录自启。
 *
 * 业务代码不从这里拿东西，走 filemanager.js 的 `fileManager`；实现类从这里继承。
 *
 * 为什么收成一个接口：这些能力原先散在 server.js、settings.js、start.js、platform.js
 * 里，每处各写一次 `process.platform === 'win32' ? … : …`，加一个平台就得把整份仓库
 * 重新翻一遍。现在业务代码只认 `fileManager.xxx()`，平台差异全压在实现类里。
 *
 * 实现类分开打包：`filemanager-windows.js` 只进 Windows 安装包，`filemanager-mac.js`
 * 只进 macOS 的 .app（见 scripts/pack-common.mjs 的 APP_FILES）。所以这里只能用动态
 * import —— 静态 import 会在「另一套实现没被打进来」的那一侧直接报模块找不到。
 *
 * 要加 Linux：照着两个实现类写一个 `filemanager-linux.js`（整份契约都在下面这个基类
 * 的注释里），在 `pickFileManager()` 里挂上，再把它加进 `APP_FILES` 的平台分支。
 * 在那之前 Linux 落到 PosixFileManager：xdg-open 能用，系统对话框和自启直接报不支持——
 * 和这次重构之前的行为一致。
 */
export class FileManager {
  /**
   * 外部依赖全部可注入，用例里换成假的就能把两套实现跑在同一组断言上
   * （见 test/filemanager.test.mjs），不用按平台 skip。
   */
  constructor(deps = {}) {
    this.run = deps.execFile || execFile
    this.exists = deps.existsSync || existsSync
    this.stat = deps.statSync || statSync
    this.env = deps.env || process.env
    this.home = deps.home || homedir()
    this.root = deps.root || dirname(fileURLToPath(import.meta.url))
  }

  /** 实现类的名字，只用来写日志和断言。 */
  get platform() { return 'posix' }

  /** 自带运行时里 node 的文件名。 */
  get nodeBinary() { return 'node' }

  /** 路径比较要不要忽略大小写：Windows 的 C:\A 和 c:\a 是同一个目录。 */
  get caseInsensitivePaths() { return false }

  /** 建目录别名时用哪种链接：Windows 上符号链接要管理员权限，只能用 junction。 */
  get directoryLinkType() { return 'dir' }

  /** 可执行文件的后缀名（Windows 按 PATHEXT 补；其余平台只有空后缀）。 */
  get commandExtensions() { return [''] }

  /** 把路径规整成可比较、可当 Map 键的形式。 */
  pathKey(path) {
    const value = String(path || '')
    return this.caseInsensitivePaths ? value.toLowerCase() : value
  }

  /** 两个路径是不是同一个（只比字符串，不碰文件系统）。 */
  samePath(left, right) {
    if (!left || !right) return false
    return this.pathKey(left) === this.pathKey(right)
  }

  /** 某个目录里是否已经能直接调到这个命令。 */
  hasCommand(dir, name) {
    return this.commandExtensions.some((ext) => this.exists(join(dir, name + ext)))
  }

  /**
   * 启动器自己的每用户目录（settings.json、日志、webview 数据都在它下面）。
   * 拿不到就返回空串，调用方退回安装目录下的 data/。
   */
  userAppDir() { return '' }

  /** settings.json 与日志实际所在的目录。 */
  get appDir() { return this.userAppDir() || join(this.root, 'data') }

  /** 当前代码所在的应用包路径；不是从包里跑就返回空串（只有 macOS 有包）。 */
  appBundle() { return '' }

  /** 打包后的原生外壳可执行文件；源码运行时返回空串。 */
  launcherExecutable() { return '' }

  /** 登录自启要执行的 argv：装好的走原生外壳，源码运行就直接 node start.js。 */
  launchArgs() {
    const exe = this.launcherExecutable()
    // 源码运行时直接 node start.js；Electron 外壳里 RUNTIME_NODE 就是 Electron 本体
    return exe ? [exe] : [RUNTIME_NODE, join(this.root, 'start.js')]
  }

  /** 自启命令行（每项都加引号：路径里有空格也不会被拆开）。 */
  launchCommand() {
    return this.launchArgs().map((arg) => `"${arg}"`).join(' ')
  }

  /** 现在是不是开着登录自启。查不到、不支持都算没开。 */
  async autoStartEnabled() { return false }

  /** 开关登录自启。不支持的平台：关可以（本来就没开），开要报错说清楚。 */
  async setAutoStart(enabled) {
    if (enabled) throw new Error(this.unsupported('开机自启'))
  }

  /**
   * 弹系统「选择文件夹」对话框，返回绝对路径；用户取消返回空串。
   *
   * 页面里的 `<input type="file" webkitdirectory>` 只能拿到相对路径，浏览器也不给
   * 绝对路径，所以目录选择必须由管理页所在的本机进程来做。
   */
  async pickDirectory(initialPath = '') {
    throw new Error(this.unsupported('目录选择'))
  }

  /**
   * 弹系统的文件对话框，返回绝对路径；用户取消返回空串。
   *
   * - `save`：true 走「保存」对话框（可以是个还不存在的文件名）
   * - `defaultName`：保存时预填的文件名
   * - `filter`：Windows 对话框的筛选器（`说明|*.ext|…`），别的平台用不上
   * - `title` / `prompt`：Windows 的对话框标题 / macOS 的提示语，prompt 默认跟 title 一样
   */
  async pickFile({ save = false, defaultName = '', filter = '', title = '', prompt = '' } = {}) {
    throw new Error(this.unsupported('文件选择'))
  }

  /** 在系统文件管理器里打开一个目录。 */
  async openDirectory(dir) {
    let info
    try { info = this.stat(dir) } catch { throw new Error('目录不存在或已被移动') }
    if (!info.isDirectory()) throw new Error('请选择文件夹')
    await this.openWith(this.directoryOpener, [dir], this.directoryOpenOptions)
  }

  /** 在系统文件管理器里定位一个文件（选中它，而不是打开它）。 */
  async revealPath(path) {
    // 退一步：没有「定位」能力的平台至少把它所在的目录打开。
    await this.openWith(this.directoryOpener, [dirname(String(path))], { windowsHide: true })
  }

  /** 交给系统默认程序打开一个地址。 */
  async openUrl(url) {
    await this.openWith(this.directoryOpener, [String(url)], {})
  }

  /** 打开用的程序名。PosixFileManager 这一份靠 xdg-open 兜底。 */
  get directoryOpener() { return 'xdg-open' }

  /**
   * openDirectory 的 execFile 选项：默认什么都不传。
   * Windows 上尤其不能 windowsHide——连带着会把弹出来的文件夹窗口一起藏掉。
   */
  get directoryOpenOptions() { return {} }

  /** 统一的「这个平台不支持」文案：报错里要点名是哪件事，别只说一句失败。 */
  unsupported(what) {
    return `${what}目前只支持 Windows 和 macOS`
  }

  /** 把回调式 execFile 包成 Promise；子类的对话框都走它。 */
  exec(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      this.run(command, args, options, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: String(stderr || '') }))
        else resolve(String(stdout || ''))
      })
    })
  }

  /** 只管把东西交出去，不要它的输出；失败按 shouldIgnore 决定报不报。 */
  openWith(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      this.run(command, args, options, (error) => {
        if (error && !this.ignoreOpenError(error)) reject(error)
        else resolve()
      })
    })
  }

  /** 哪些「打开」失败可以当成成功（见 Windows 实现里 Explorer 的返回码）。 */
  ignoreOpenError() { return false }
}

/** 还没有专门实现的平台（现在是 Linux）：xdg-open 这条路能走，其余照契约报不支持。 */
export class PosixFileManager extends FileManager {}
