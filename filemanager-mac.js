import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { basename, dirname } from 'node:path'
import { FileManager } from './filemanager-base.js'
import { APP_DIR_NAME, LAUNCHER_NAME, MAC_BUNDLE_ID } from './platform.js'

/** AppleScript 里用户点「取消」的错误号：不算失败，当作没选。 */
const USER_CANCELED = '-128'
/** 对话框等用户的时间：目录 5 分钟、文件 10 分钟，和重构前一样。 */
const DIRECTORY_TIMEOUT = 5 * 60 * 1000
const FILE_TIMEOUT = 10 * 60 * 1000

/**
 * macOS 这一套：访达、AppleScript 的系统对话框、每用户 LaunchAgent。
 * 只会被打进 DSH-X.app（见 scripts/pack-common.mjs），Windows 安装包里没有这个文件。
 */
export class MacFileManager extends FileManager {
  constructor(deps = {}) {
    super(deps)
    this.writeFile = deps.writeFile || writeFile
    this.mkdir = deps.mkdir || mkdir
    this.rm = deps.rm || rm
  }

  get platform() { return 'mac' }

  get directoryOpener() { return 'open' }

  /**
   * ~/Library/Application Support/DSH。
   * 不看 APPDATA：那个变量在 mac 上多半是别的工具随手设的，跟我们无关。
   * .app 包里不能写（一更新整个包就被换掉，改包内文件还会破坏签名），所以必须落在这。
   */
  userAppDir() {
    return join(this.home, 'Library', 'Application Support', APP_DIR_NAME)
  }

  /**
   * 当前代码所在的 .app 包路径；源码运行返回空串。
   * 打包布局是 <X>.app/Contents/Resources/app/<本文件>。
   */
  appBundle(root = this.root) {
    const resources = dirname(root)
    const contents = dirname(resources)
    const bundle = dirname(contents)
    if (basename(root) !== 'app' || basename(resources) !== 'Resources' || basename(contents) !== 'Contents') return ''
    return bundle.endsWith('.app') ? bundle : ''
  }

  launcherExecutable() {
    const bundle = this.appBundle()
    const exe = bundle ? join(bundle, 'Contents', 'MacOS', LAUNCHER_NAME) : ''
    return exe && this.exists(exe) ? exe : ''
  }

  /** 走 open 而不是直接执行包里的二进制：LaunchServices 负责单实例和把应用带到前台。 */
  launchArgs() {
    const exe = this.launcherExecutable()
    if (exe) return ['/usr/bin/open', '-a', this.appBundle()]
    return super.launchArgs()
  }

  /** 每用户 LaunchAgent 的位置：文件在就算开着（登录时 launchd 按它拉起启动器）。 */
  get launchAgentPath() {
    return join(this.home, 'Library', 'LaunchAgents', `${MAC_BUNDLE_ID}.plist`)
  }

  /** 只在登录时跑一次（RunAtLoad），不设 KeepAlive——用户退出了就别再拉起来。 */
  launchAgentPlist(args = this.launchArgs(), cwd = this.root) {
    const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${escape(MAC_BUNDLE_ID)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...args.map((arg) => `    <string>${escape(arg)}</string>`),
      '  </array>',
      '  <key>WorkingDirectory</key>',
      `  <string>${escape(cwd)}</string>`,
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n')
  }

  async autoStartEnabled() {
    return this.exists(this.launchAgentPath)
  }

  /** 只写/删文件，不 launchctl load：load 会立刻再拉起一个启动器，而这里要的只是「下次登录时」。 */
  async setAutoStart(enabled) {
    const path = this.launchAgentPath
    if (enabled) {
      await this.mkdir(dirname(path), { recursive: true })
      await this.writeFile(path, this.launchAgentPlist())
      return
    }
    await this.rm(path, { force: true })
  }

  /** AppleScript 的 choose folder（系统自带，不需要额外权限）。 */
  async pickDirectory(initialPath = '') {
    const location = initialPath && this.exists(initialPath)
      ? ` default location (POSIX file "${initialPath.replace(/["\\]/g, '\\$&')}")`
      : ''
    // activate 把对话框带到最前，否则它可能躲在管理页窗口后面
    return this.ask(['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "选择目录"${location})`], DIRECTORY_TIMEOUT)
  }

  async pickFile({ save = false, defaultName = '', title = '', prompt = '' } = {}) {
    // 注入到 AppleScript 里的字符串先把引号和反斜杠去掉——整段是双引号包裹的
    const name = String(defaultName || '').replace(/["\\]/g, '')
    const ask = prompt || title || (save ? '选择保存位置' : '选择文件')
    const what = save
      ? `choose file name with prompt "${ask}"${name ? ` default name "${name}"` : ''}`
      : `choose file with prompt "${ask}"`
    return this.ask(['-e', 'activate', '-e', `POSIX path of (${what})`], FILE_TIMEOUT)
  }

  async revealPath(path) {
    await this.openWith('open', ['-R', String(path)], { windowsHide: true })
  }

  async openUrl(url) {
    await this.openWith('open', [String(url)], {})
  }

  /** 跑一段 AppleScript 取路径：取消返回空串，其余错误照抛。 */
  async ask(args, timeout) {
    let out
    try {
      out = await this.exec('osascript', args, { timeout, encoding: 'utf8' })
    } catch (error) {
      if (String(error?.stderr || '').includes(`(${USER_CANCELED})`)) return ''
      throw error
    }
    // POSIX path 带尾斜杠，去掉和其它地方的目录写法保持一致
    return out.trim().replace(/(.)\/+$/, '$1')
  }
}
