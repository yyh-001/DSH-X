import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chmod, copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyNpmModules,
  copyPnpm,
  downloadNodeFile,
  run,
} from './pack-common.mjs'
import { packager } from '@electron/packager'
import { LAUNCHER_NAME, MAC_APP_NAME, MAC_BUNDLE_ID } from '../platform.js'
import { macSigningIdentity, signMacBundle } from './mac-signing.mjs'
import { pruneMacElectron } from './electron-prune.mjs'

/**
 * macOS 打包：release/DSH-X.app + release/DSH-X-mac-<arch>.dmg。
 *
 * 外壳是 Electron（shell/），不再是 launcher/ 的 Rust + WKWebView；Rust 那边现在只剩安装引擎。
 * 包的布局（platform.js 的 appBundle 按它找文件，自更新按它换包）：
 *   DSH-X.app/Contents/MacOS/DSH            Electron 主程序（executableName 改成了 DSH）
 *   DSH-X.app/Contents/Frameworks/…         Electron 框架与 Helper
 *   DSH-X.app/Contents/Resources/app/…      和 Windows 安装目录一样的内容 + shell/；node 就地是 Electron 本身
 *   DSH-X.app/Contents/Resources/AppIcon.icns
 *
 * Resources/app 是普通目录、不打 asar：dsh 子进程要用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）
 * 去跑里面的 compat/、perf/ 钩子，管理服务也要按真实路径找 public/ 和随包的整合包，asar 里的文件外部进程读不到。
 *
 * dmg 的文件名带架构，和 server.js 的 APP_SETUP 对上——自更新按它去发布页取包。
 * 默认打当前机器的架构；DSH_MAC_ARCH=x64 / arm64 可以指定（Electron 和 node 都按架构下载，不用交叉编译）。
 */

const ARCH = process.env.DSH_MAC_ARCH || process.arch
const ARCHS = new Set(['arm64', 'x64'])
if (!ARCHS.has(ARCH)) throw new Error(`不支持的架构：${ARCH}（只支持 ${[...ARCHS].join(' / ')}）`)
macSigningIdentity() // 缺固定证书时在下载 Node / 编译 Rust 前就中止正式构建

const DIST = `node-v${NODE_VERSION}-darwin-${ARCH}`
const TARBALL = `${DIST}.tar.gz`
const TARBALL_PATH = join(VENDOR, TARBALL)
const EXTRACTED = join(VENDOR, DIST)
const RELEASE = join(ROOT, 'release')
const BUNDLE = join(RELEASE, MAC_APP_NAME)
const CONTENTS = join(BUNDLE, 'Contents')
const APP = join(CONTENTS, 'Resources', 'app')
const ICON_FILE = 'AppIcon.icns'
const DMG = join(RELEASE, `DSH-X-mac-${ARCH}.dmg`)
const DMG_VOLUME = 'DSH-X'
const DMG_BACKGROUND = 'background.tiff'
const DS_STORE_WAIT_SECONDS = 20
/** Finder 窗口 bounds 含标题栏，内容区要完整露出背景图就得加上这一截。 */
const DMG_TITLE_BAR = 28
/** dmg 窗口布局（点，左上角为原点）：背景图和 Finder 摆图标共用这一份。 */
const DMG_LAYOUT = { width: 640, height: 440, iconSize: 112, appX: 170, appsX: 470, iconY: 190 }
/** Electron 官方构建要求的最低系统版本：比 Node 22 的 11.0 高，以它为准（Electron 44 起是 13.0）。 */
const MIN_MACOS = '13.0'
/** Electron 包装出来的临时目录（packager 的 out），组装好之后挪到 release/DSH-X.app。 */
const ELECTRON_OUT = join(RELEASE, 'electron-out')
/** 外壳源码：和 APP_FILES 一样平铺拷进 Resources/app/shell。 */
const SHELL_DIR = join(ROOT, 'shell')
/** iconset 需要的尺寸（每个再配一张 @2x）。 */
const ICON_SIZES = [16, 32, 128, 256, 512]

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'bin', 'node'))) return
  await downloadNodeFile(TARBALL, TARBALL_PATH)
  run('tar', ['-xzf', TARBALL_PATH, '-C', VENDOR])
}

/**
 * 自带运行时目录摆成和 Windows 一样的扁平布局（node/node_modules + 包装脚本），
 * server.js 的 withBundledRuntime、registry.js 的 LOCAL_NODE 只认这一种。
 * 这里**不再放 node 可执行文件**：dsh 子进程用 Electron 本体（ELECTRON_RUN_AS_NODE=1），和 Windows 一致。
 * 发行包里的 npm/npx 是指向 ../lib/node_modules 的符号链接，换了布局就断了，所以自己写包装。
 */
async function copyNodeRuntime() {
  const nodeDir = join(APP, 'node')
  await mkdir(nodeDir, { recursive: true })
  // 插件构建脚本里叫 `node` 时落到 Electron 上；路径从 Resources/app/node 指回 Contents/MacOS/DSH
  const nodeShim = join(nodeDir, 'node')
  await writeFile(nodeShim, [
    '#!/bin/sh',
    'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$(dirname "$0")/../../../MacOS/DSH" "$@"',
    '',
  ].join('\n'))
  await chmod(nodeShim, 0o755)
  const modules = join(EXTRACTED, 'lib', 'node_modules')
  await copyNpmModules(modules, nodeDir)
  await copyPnpm(nodeDir, join(modules, 'npm', 'bin', 'npm-cli.js'))
  const shims = {
    npm: 'npm/bin/npm-cli.js',
    npx: 'npm/bin/npx-cli.js',
    pnpm: 'pnpm/bin/pnpm.cjs',
    pnpx: 'pnpm/bin/pnpx.cjs',
  }
  for (const [name, cli] of Object.entries(shims)) {
    const file = join(nodeDir, name)
    await writeFile(file, [
      '#!/bin/sh',
      'dir="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$dir/node" "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }
}

/**
 * 只要 Electron 的空壳：packager 负责下载对应架构的 Electron、改名（可执行文件 → DSH，Helper 跟着改）、
 * 写 Info.plist 的基础项。app 目录给它一个只含 package.json 的占位，真正的内容下面自己拷——
 * packager 默认会打 asar、按 package.json 裁 node_modules，这两样都不适合这个布局（见文件头）。
 */
async function buildShell() {
  const stub = join(tmpdir(), `dsh-x-electron-stub-${process.pid}`)
  rmSync(stub, { recursive: true, force: true })
  await mkdir(stub, { recursive: true })
  await writeFile(join(stub, 'package.json'), JSON.stringify({ name: 'dsh-x', productName: 'DSH-X', version: PKG.version, main: 'shell/main.mjs' }))
  // packager 会检查入口文件存在；占位而已，assemble 时整个 app 目录换成真正的内容
  await mkdir(join(stub, 'shell'), { recursive: true })
  await writeFile(join(stub, 'shell', 'main.mjs'), '')
  rmSync(ELECTRON_OUT, { recursive: true, force: true })
  const electronVersion = JSON.parse(await readFile(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  const [out] = await packager({
    dir: stub,
    out: ELECTRON_OUT,
    platform: 'darwin',
    arch: ARCH,
    electronVersion,
    name: 'DSH-X',
    executableName: LAUNCHER_NAME,
    appBundleId: MAC_BUNDLE_ID,
    appVersion: PKG.version,
    buildVersion: PKG.version,
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: 'Copyright (C) 2026 yyh',
    darwinDarkModeSupport: true,
    asar: false,
    prune: false,
    overwrite: true,
    quiet: true,
    // 签名在组装完之后统一做（scripts/mac-signing.mjs），这里不签
    osxSign: false,
  })
  rmSync(stub, { recursive: true, force: true })
  return join(out, 'DSH-X.app')
}

/**
 * Info.plist：packager 已写好基础项，这里补上我们自己的（图标、语言、最低系统）和
 * 媒体权限的用途说明——dsh 的语音输入要麦克风，没有说明文字 macOS 会直接拒绝、连询问都不弹。
 */
function patchInfoPlist(plist) {
  const set = (key, type, value) => run('plutil', ['-replace', key, `-${type}`, value, plist])
  set('CFBundleIconFile', 'string', ICON_FILE)
  set('CFBundleDevelopmentRegion', 'string', 'zh_CN')
  set('CFBundleDisplayName', 'string', 'DSH-X')
  set('LSMinimumSystemVersion', 'string', MIN_MACOS)
  set('NSHighResolutionCapable', 'bool', 'YES')
  set('NSMicrophoneUsageDescription', 'string', 'DSH 的语音输入需要使用麦克风。 / DSH voice input uses the microphone.')
  set('NSCameraUsageDescription', 'string', 'DSH 页面请求使用摄像头时需要。 / Needed when a DSH page asks for the camera.')
}

/** assets/icon.png（512 母版）→ AppIcon.icns。 */
function buildIcon(dest) {
  const iconset = join(tmpdir(), `dsh-x-${process.pid}.iconset`)
  rmSync(iconset, { recursive: true, force: true })
  run('mkdir', ['-p', iconset])
  const master = join(ROOT, 'assets', 'icon.png')
  for (const size of ICON_SIZES) {
    run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)])
    run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', dest])
  rmSync(iconset, { recursive: true, force: true })
}

async function assemble(shellApp) {
  rmSync(BUNDLE, { recursive: true, force: true })
  await rename(shellApp, BUNDLE)
  rmSync(ELECTRON_OUT, { recursive: true, force: true })
  // packager 放的占位 app 换成真正的内容
  rmSync(APP, { recursive: true, force: true })
  await copyAppFiles(APP)
  await cp(SHELL_DIR, join(APP, 'shell'), { recursive: true })
  // Electron 按 Resources/app/package.json 的 main 找入口；仓库里的 main 是给 npm start 的 start.js，
  // 包里改指外壳。版本号等其余字段原样保留（server.js 读它显示版本、比较自更新）。
  const appPackage = join(APP, 'package.json')
  await writeFile(appPackage, `${JSON.stringify({ ...JSON.parse(await readFile(appPackage, 'utf8')), main: 'shell/main.mjs' }, null, 2)}\n`)
  await copyNodeRuntime()
  // Electron 默认的 electron.icns 换成我们的图标
  rmSync(join(CONTENTS, 'Resources', 'electron.icns'), { force: true })
  buildIcon(join(CONTENTS, 'Resources', ICON_FILE))
  patchInfoPlist(join(CONTENTS, 'Info.plist'))
  // 签名之前裁剪 Electron 自带的多语言与软件渲染（见 electron-prune.mjs 的理由）
  const prunedBytes = pruneMacElectron(BUNDLE)
  if (prunedBytes > 0) console.log(`已裁剪 Electron 运行时：省下 ${(prunedBytes / 1048576).toFixed(1)} MB`)
  signMacBundle(BUNDLE)
  console.log(`已打包到 ${BUNDLE}`)
}

/** 背景图（标题、箭头、首次打开指引）：1x + 2x 合成一张多分辨率 tiff，Retina 上不糊。 */
function buildDmgBackground(dest) {
  const script = join(ROOT, 'scripts', 'make-dmg-background.swift')
  const layout = JSON.stringify(DMG_LAYOUT)
  const pngs = [1, 2].map((scale) => {
    const png = join(tmpdir(), `dsh-x-dmg-bg-${process.pid}@${scale}x.png`)
    run('swift', [script, png, String(scale), layout])
    return png
  })
  run('tiffutil', ['-cathidpicheck', ...pngs, '-out', dest])
  for (const png of pngs) rmSync(png, { force: true })
}

/** 用 Finder 摆好窗口：图标视图、隐藏工具栏、背景图、两个图标的位置。 */
function layoutDmgWindow(mount) {
  const { width, height, iconSize, appX, appsX, iconY } = DMG_LAYOUT
  // 按挂载路径找卷，不按卷名：机器上可能还挂着旧的同名安装盘
  const script = `
    tell application "Finder"
      tell folder (POSIX file "${mount}" as alias)
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, ${200 + width}, ${120 + height + DMG_TITLE_BAR}}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to ${iconSize}
        set text size of opts to 13
        set background picture of opts to (POSIX file "${mount}/.background/${DMG_BACKGROUND}" as alias)
        set position of item "${MAC_APP_NAME}" of container window to {${appX}, ${iconY}}
        set position of item "Applications" of container window to {${appsX}, ${iconY}}
        close
        -- 重开一次再关：Finder 只在关掉已改过的窗口时落盘 .DS_Store（create-dmg 同样做法）
        open
        update without registering applications
        delay 2
        close
      end tell
    end tell`
  run('osascript', ['-e', script])
}

/**
 * 挂载可写镜像，返回卷设备和挂载点。必须挂在 /Volumes 下（Finder 不给别处的卷写 .DS_Store），
 * 所以挂载点让 hdiutil 按卷名自己挑。
 */
function attachDmg(image) {
  const result = spawnSync('hdiutil', ['attach', image, '-readwrite', '-noverify', '-noautoopen'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`hdiutil attach ${image} failed: ${result.stderr}`)
  const volume = result.stdout.split('\n').map((line) => line.split('\t').map((field) => field.trim()))
    .find((fields) => fields.at(-1).startsWith('/Volumes/'))
  if (!volume) throw new Error(`hdiutil attach 没给出挂载点：${result.stdout}`)
  return { device: volume[0], mount: volume.at(-1) }
}

/** Finder 关窗后才异步写 .DS_Store；不等它就卸载的话布局会丢。 */
function waitForFinderLayout(mount) {
  const store = join(mount, '.DS_Store')
  for (let i = 0; i < DS_STORE_WAIT_SECONDS; i += 1) {
    if (existsSync(store)) return
    run('sleep', ['1'])
  }
  throw new Error(`${DS_STORE_WAIT_SECONDS} 秒内 Finder 没写出 .DS_Store`)
}

/**
 * 卸载临时卷。卷改名后 Finder / Spotlight / diskimages-help 还会短暂占着它，
 * 立刻 detach 会「Resource busy」——跑得慢的 intel runner 上几乎每次都踩到；
 * 所以先反复等它松手，实在不行再 -force 强卸（内容已写完，强卸不会丢窗口布局）。
 */
function detachVolume(device) {
  let last = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const forced = attempt >= 6
    const result = spawnSync('hdiutil', forced ? ['detach', device, '-force'] : ['detach', device], { encoding: 'utf8' })
    if (result.status === 0) return
    last = result
    run('sleep', ['2'])
  }
  throw new Error(`hdiutil detach ${device} failed: ${last?.stderr || last?.stdout || ''}`)
}

/**
 * dmg 里放包本体和一个指向 /Applications 的链接，拖过去就装好了。
 * 先做可写镜像、挂上用 Finder 摆窗口（写进卷里的 .DS_Store），再压成只读 UDZO。
 * 摆窗口要求能控制 Finder（第一次跑会弹「自动化」授权）；没有图形会话时退回朴素布局。
 */
function buildDmg() {
  const staging = join(tmpdir(), `dsh-x-dmg-${process.pid}`)
  const rw = join(tmpdir(), `dsh-x-dmg-${process.pid}-rw.dmg`)
  rmSync(staging, { recursive: true, force: true })
  run('mkdir', ['-p', join(staging, '.background')])
  run('ditto', [BUNDLE, join(staging, MAC_APP_NAME)])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', join(staging, MAC_APP_NAME)])
  run('ln', ['-s', '/Applications', join(staging, 'Applications')])
  buildDmgBackground(join(staging, '.background', DMG_BACKGROUND))
  rmSync(rw, { force: true })
  // 摆窗口时用一个独一无二的临时卷名：Finder 按卷名认窗口，机器上挂着旧的「DSH-X」安装盘时
  // 它会把设置写到别的卷上。摆完再改回正式卷名。
  const buildVolume = `${DMG_VOLUME}-build-${process.pid}`
  run('hdiutil', ['create', '-volname', buildVolume, '-srcfolder', staging, '-ov', '-format', 'UDRW', rw])
  rmSync(staging, { recursive: true, force: true })

  const { device, mount } = attachDmg(rw)
  try {
    layoutDmgWindow(mount)
    waitForFinderLayout(mount)
    // 卷图标用应用图标
    run('cp', [join(CONTENTS, 'Resources', ICON_FILE), join(mount, '.VolumeIcon.icns')])
    run('SetFile', ['-a', 'C', mount])
  } catch (error) {
    console.warn(`dmg 窗口布局失败，用默认布局：${error.message}`)
  } finally {
    run('sync', [])
    run('diskutil', ['rename', device, DMG_VOLUME])
    // 改名后挂载点跟着变，按设备卸载
    detachVolume(device)
  }

  rmSync(DMG, { force: true })
  // UDBZ（bzip2）比 UDZO（zlib-9）压得更小，Chromium 的大二进制上大概再省 5%
  run('hdiutil', ['convert', rw, '-format', 'UDBZ', '-o', DMG])
  rmSync(rw, { force: true })
  console.log(`安装包: ${DMG}`)
}

await downloadNode()
const shellApp = await buildShell()
await assemble(shellApp)
buildDmg()
