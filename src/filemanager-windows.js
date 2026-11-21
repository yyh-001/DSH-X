import { dirname, join } from 'node:path'
import { FileManager } from './filemanager-base.js'
import { APP_DIR_NAME, IN_ELECTRON, LAUNCHER_NAME } from './platform.js'

/** 自启写在这条注册表项下：每用户的 Run，不需要管理员。 */
const RUN_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'DSH'
/** 对话框等用户的时间：目录 5 分钟、文件 10 分钟，和重构前一样。 */
const DIRECTORY_TIMEOUT = 5 * 60 * 1000
const FILE_TIMEOUT = 10 * 60 * 1000
/**
 * `cmd /c start` 会把命令行**再解析一遍**：URL 里的 `&` 是语句分隔符，`|<>^()%"`
 * 各有含义，于是 `http://127.0.0.1:1/?&calc` 能直接跑起任意命令（Node 只给含空格的
 * 参数加引号，而 URL 里通常没有空格）。所以只放行 cmd 会原样看待的字符——够用（本机
 * 地址就是 `http://127.0.0.1:端口/路径?k=v`），其余一律拒绝，比在字符串上做转义可靠。
 */
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#\[\]@$'*,;=+]+$/

/**
 * Windows 这一套：资源管理器、PowerShell 的系统对话框、HKCU\Run 的登录自启。
 * 只会被打进 Windows 安装包（见 scripts/pack-common.mjs），macOS 的 .app 里没有这个文件。
 */
export class WindowsFileManager extends FileManager {
  get platform() { return 'windows' }

  get nodeBinary() { return 'node.exe' }

  /** C:\A 和 c:\a 是同一个目录：比路径一律先转小写。 */
  get caseInsensitivePaths() { return true }

  /** 符号链接要管理员权限，建目录别名只能用 junction。 */
  get directoryLinkType() { return 'junction' }

  /** 查命令时按 PATHEXT 补后缀（`pnpm` 实际是 `pnpm.cmd`）。 */
  get commandExtensions() {
    return ['', ...String(this.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
  }

  get directoryOpener() { return 'explorer.exe' }

  /** Explorer 接管已有窗口时会返回 1，这不是失败。 */
  ignoreOpenError(error) { return error?.code === 1 }

  /** %APPDATA%\DSH；没有 APPDATA 就返回空串，调用方退回安装目录下的 data/。 */
  userAppDir() {
    return this.env.APPDATA ? join(this.env.APPDATA, APP_DIR_NAME) : ''
  }

  /**
   * Electron 外壳里 DSH.exe 就是 process.execPath（打包后在安装目录根上，不在 resources/app 里）。
   * 源码运行（npm run electron）时 defaultApp 为真，execPath 是 node_modules 里的 electron.exe，
   * 不能让开机自启把它写进注册表。老的 Rust 外壳布局仍然认（装过 0.1.19 及以前的机器）。
   */
  launcherExecutable() {
    if (IN_ELECTRON) {
      if (process.defaultApp) return ''
      return process.execPath
    }
    const exe = join(this.root, `${LAUNCHER_NAME}.exe`)
    return this.exists(exe) ? exe : ''
  }

  installDir() {
    const exe = this.launcherExecutable()
    return exe ? dirname(exe) : ''
  }

  async autoStartEnabled() {
    if (this._autoStartCache && Date.now() - this._autoStartCache.at < 5000) {
      return this._autoStartCache.value
    }
    let value = false
    try {
      await this.exec('reg.exe', ['query', RUN_REG, '/v', RUN_NAME], { windowsHide: true, encoding: 'utf8' })
      value = true
    } catch {
      value = false
    }
    this._autoStartCache = { value, at: Date.now() }
    return value
  }

  async setAutoStart(enabled) {
    this._autoStartCache = null
    const on = await this.autoStartEnabled()
    if (on === Boolean(enabled)) return
    if (enabled) {
      await this.exec('reg.exe', ['add', RUN_REG, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', this.launchCommand(), '/f'], { windowsHide: true, encoding: 'utf8' })
      this._autoStartCache = { value: true, at: Date.now() }
      return
    }
    try {
      await this.exec('reg.exe', ['delete', RUN_REG, '/v', RUN_NAME, '/f'], { windowsHide: true, encoding: 'utf8' })
    } catch {
      // 已经不在了
    }
    this._autoStartCache = { value: false, at: Date.now() }
  }

  /**
   * FolderBrowserDialog。脚本单独抽出来是为了能直接验（见 test/directory-picker.test.mjs）：
   * 路径走 base64 传进去，中文、空格、引号都不会在拼字符串时被弄坏。
   */
  directoryScript(initialPath = '') {
    const encodedPath = Buffer.from(initialPath, 'utf8').toString('base64')
    return [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = '选择目录'",
      '$d.ShowNewFolderButton = $true',
      `$initialPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
      'if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) { $d.SelectedPath = $initialPath }',
      // 无主窗口的隐藏 PowerShell 可能把对话框留在浏览器后方，用透明置顶窗口承载系统选择器。
      '$owner = New-Object System.Windows.Forms.Form',
      "$owner.Text = 'DSH 目录选择'",
      '$owner.ShowInTaskbar = $false; $owner.TopMost = $true; $owner.Opacity = 0',
      "$owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1",
      '$owner.Show(); $owner.Activate()',
      'try { if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } } finally { $d.Dispose(); $owner.Dispose() }',
    ].join('; ')
  }

  async pickDirectory(initialPath = '') {
    // -EncodedCommand 收 UTF-16LE 的 base64：命令行里再没有要转义的东西
    const encoded = Buffer.from(this.directoryScript(initialPath), 'utf16le').toString('base64')
    const out = await this.exec('powershell', ['-STA', '-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, timeout: DIRECTORY_TIMEOUT, encoding: 'utf8' })
    return out.trim()
  }

  async pickFile({ save = false, defaultName = '', filter = '', title = '' } = {}) {
    // 参数统一走 UTF-8 Base64 + -EncodedCommand：避免 PowerShell 单引号/Unicode 引号注入，
    // 并强制 UTF-8 输出编码，避免中文 Windows 路径在 GBK 下乱码。
    const b64 = (value) => Buffer.from(String(value || ''), 'utf8').toString('base64')
    const decode = (encoded) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `$d = New-Object System.Windows.Forms.${save ? 'SaveFileDialog' : 'OpenFileDialog'}`,
      save ? `$d.FileName = ${decode(b64(defaultName))}; $d.OverwritePrompt = $true` : '',
      filter ? `$d.Filter = ${decode(b64(filter))}` : '',
      title ? `$d.Title = ${decode(b64(title))}` : '',
      'try { if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) } } finally { $d.Dispose() }',
    ].filter(Boolean).join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const out = await this.exec('powershell', ['-STA', '-NoProfile', '-EncodedCommand', encoded], { windowsHide: true, timeout: FILE_TIMEOUT, encoding: 'utf8' })
    return out.trim()
  }

  async revealPath(path) {
    await this.openWith('explorer', [`/select,${String(path)}`], { windowsHide: true })
  }

  async openUrl(url) {
    const value = String(url)
    if (!CMD_SAFE_URL.test(value)) throw new Error('地址里含不能安全打开的字符')
    await this.openWith('cmd', ['/c', 'start', '', value], { windowsHide: true })
  }
}
