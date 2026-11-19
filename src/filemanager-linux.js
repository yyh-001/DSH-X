import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PosixFileManager } from './filemanager-base.js'
import { APP_DIR_NAME, IN_ELECTRON } from './platform.js'

/** 对话框等用户的时间：目录 5 分钟、文件 10 分钟，和其他平台一致。 */
const DIRECTORY_TIMEOUT = 5 * 60 * 1000
const FILE_TIMEOUT = 10 * 60 * 1000

/**
 * Linux 这一套：xdg-open、zenity/kdialog 的系统对话框、XDG autostart。
 *
 * 目录放在 $XDG_CONFIG_HOME/DSH（默认 ~/.config/DSH），和 AppImage 的只读挂载分开。
 * 对话框优先 zenity，其次 kdialog；两个都没装时提示用户直接输入路径。
 * 自启写 ~/.config/autostart/dsh-x.desktop，不依赖 systemd。
 */
export class LinuxFileManager extends PosixFileManager {
  constructor(deps = {}) {
    super(deps)
    this.writeFile = deps.writeFile || writeFile
    this.mkdir = deps.mkdir || mkdir
    this.rm = deps.rm || rm
  }

  get platform() { return 'linux' }

  get directoryOpener() { return 'xdg-open' }

  /** $XDG_CONFIG_HOME/DSH（默认 ~/.config/DSH）。 */
  userAppDir() {
    return join(this.env.XDG_CONFIG_HOME || join(this.home, '.config'), APP_DIR_NAME)
  }

  /**
   * 登录自启要执行的外壳：AppImage 用 APPIMAGE 本身（挂载目录每次启动都会变），
   * 安装版用当前 Electron 可执行文件；源码运行返回空串。
   */
  launcherExecutable() {
    const appImage = String(this.env.APPIMAGE || '').trim()
    if (appImage && this.exists(appImage)) return appImage
    if (IN_ELECTRON && !process.defaultApp) return process.execPath
    return ''
  }

  /** AppImage 是单文件，父目录通常是用户自己的软件/下载目录，不视为应用安装目录。 */
  installDir() {
    const appImage = String(this.env.APPIMAGE || '').trim()
    if (appImage) return ''
    if (IN_ELECTRON && !process.defaultApp) return dirname(process.execPath)
    return ''
  }

  /** XDG autostart 的 .desktop 文件。 */
  get autoStartPath() {
    return join(this.env.XDG_CONFIG_HOME || join(this.home, '.config'), 'autostart', 'dsh-x.desktop')
  }

  autoStartEntry() {
    return [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DSH-X',
      'Comment=DeepSeek Harness launcher',
      `Exec=${this.launchCommand()}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n')
  }

  async autoStartEnabled() {
    return this.exists(this.autoStartPath)
  }

  async setAutoStart(enabled) {
    if (!enabled) {
      await this.rm(this.autoStartPath, { force: true })
      return
    }
    await this.mkdir(dirname(this.autoStartPath), { recursive: true })
    await this.writeFile(this.autoStartPath, this.autoStartEntry())
  }

  async pickDirectory(initialPath = '') {
    const start = initialPath && this.exists(initialPath) ? initialPath : ''
    const zenity = await this.dialog('zenity', [
      '--file-selection', '--directory', '--title=选择目录',
      ...(start ? [`--filename=${start}${start.endsWith('/') ? '' : '/'}`] : []),
    ], DIRECTORY_TIMEOUT)
    if (zenity !== null) return zenity
    const kdialog = await this.dialog('kdialog', ['--getexistingdirectory', start || this.home, '--title', '选择目录'], DIRECTORY_TIMEOUT)
    if (kdialog !== null) return kdialog
    throw new Error('目录选择需要安装 zenity 或 kdialog；也可以直接输入路径')
  }

  async pickFile({ save = false, defaultName = '', title = '', prompt = '' } = {}) {
    const ask = prompt || title || (save ? '选择保存位置' : '选择文件')
    const zenity = await this.dialog('zenity', [
      '--file-selection', '--title', ask,
      ...(save ? ['--save', '--confirm-overwrite'] : []),
      ...(defaultName ? [`--filename=${defaultName}`] : []),
    ], FILE_TIMEOUT)
    if (zenity !== null) return zenity
    const kdialog = await this.dialog('kdialog', save
      ? ['--getsavefilename', defaultName || this.home, '--title', ask]
      : ['--getopenfilename', this.home, '--title', ask], FILE_TIMEOUT)
    if (kdialog !== null) return kdialog
    throw new Error('文件选择需要安装 zenity 或 kdialog；也可以直接输入路径')
  }

  async revealPath(path) {
    await this.openWith('xdg-open', [dirname(String(path))], { windowsHide: true })
  }

  async openUrl(url) {
    await this.openWith('xdg-open', [String(url)], {})
  }

  /**
   * 跑 zenity / kdialog：返回路径；用户取消返回空串；命令不存在返回 null（换下一个）。
   * 两个都没装时调用方给出明确提示。
   */
  async dialog(command, args, timeout) {
    try {
      return String(await this.exec(command, args, { timeout, encoding: 'utf8' })).trim()
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error?.code === 1) return ''
      throw error
    }
  }
}
