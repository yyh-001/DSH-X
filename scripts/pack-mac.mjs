import { existsSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
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
import { LAUNCHER_NAME, MAC_APP_NAME, MAC_BUNDLE_ID, NODE_BINARY } from '../platform.js'

/**
 * macOS 打包：release/DSH-X.app + release/DSH-X-mac-<arch>.dmg。
 *
 * 包的布局（platform.js 的 appBundle / 外壳的 app_root 都按它找文件）：
 *   DSH-X.app/Contents/MacOS/DSH            原生外壳（launcher/）
 *   DSH-X.app/Contents/Resources/app/…      和 Windows 安装目录一样的内容，node 在 app/node/node
 *   DSH-X.app/Contents/Resources/AppIcon.icns
 *
 * dmg 的文件名带架构，和 server.js 的 APP_SETUP 对上——自更新按它去发布页取包。
 * 默认打当前机器的架构；DSH_MAC_ARCH=x64 / arm64 可以指定（外壳交叉编译需要装好对应的 rust target）。
 */

const ARCH = process.env.DSH_MAC_ARCH || process.arch
const RUST_TARGETS = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }
const RUST_TARGET = RUST_TARGETS[ARCH]
if (!RUST_TARGET) throw new Error(`不支持的架构：${ARCH}（只支持 ${Object.keys(RUST_TARGETS).join(' / ')}）`)

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
// 和 Windows 版一样读 npmmirror；最低系统版本跟 Node 22 官方二进制的要求走
const MIN_MACOS = '11.0'
/** iconset 需要的尺寸（每个再配一张 @2x）。 */
const ICON_SIZES = [16, 32, 128, 256, 512]

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'bin', 'node'))) return
  await downloadNodeFile(TARBALL, TARBALL_PATH)
  run('tar', ['-xzf', TARBALL_PATH, '-C', VENDOR])
}

/**
 * 自带运行时摆成和 Windows 一样的扁平布局（node/node + node/node_modules），
 * server.js 的 withBundledRuntime、registry.js 的 LOCAL_NODE 只认这一种。
 * 发行包里的 npm/npx 是指向 ../lib/node_modules 的符号链接，换了布局就断了，所以自己写包装。
 */
async function copyNodeRuntime() {
  const nodeDir = join(APP, 'node')
  await mkdir(nodeDir, { recursive: true })
  await copyFile(join(EXTRACTED, 'bin', 'node'), join(nodeDir, NODE_BINARY))
  await chmod(join(nodeDir, NODE_BINARY), 0o755)
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
      `exec "$dir/${NODE_BINARY}" "$dir/node_modules/${cli}" "$@"`,
      '',
    ].join('\n'))
    await chmod(file, 0o755)
  }
}

function buildLauncher() {
  run('cargo', ['build', '--release', '--target', RUST_TARGET], join(ROOT, 'launcher'))
  return join(ROOT, 'launcher', 'target', RUST_TARGET, 'release', LAUNCHER_NAME)
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

function infoPlist() {
  const entries = {
    CFBundleDevelopmentRegion: 'zh_CN',
    CFBundleDisplayName: 'DSH-X',
    CFBundleExecutable: LAUNCHER_NAME,
    CFBundleIconFile: ICON_FILE,
    CFBundleIdentifier: MAC_BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: 'DSH-X',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: PKG.version,
    CFBundleVersion: PKG.version,
    LSApplicationCategoryType: 'public.app-category.developer-tools',
    LSMinimumSystemVersion: MIN_MACOS,
    NSHumanReadableCopyright: 'Copyright (C) 2026 yyh',
  }
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    // 支持深色模式、高分屏（不写的话 WKWebView 在 Retina 上是糊的）
    '  <key>NSHighResolutionCapable</key>\n  <true/>',
    '  <key>NSRequiresAquaSystemAppearance</key>\n  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

async function assemble(launcher) {
  rmSync(BUNDLE, { recursive: true, force: true })
  await mkdir(join(CONTENTS, 'MacOS'), { recursive: true })
  await copyAppFiles(APP)
  await copyNodeRuntime()
  await copyFile(launcher, join(CONTENTS, 'MacOS', LAUNCHER_NAME))
  await chmod(join(CONTENTS, 'MacOS', LAUNCHER_NAME), 0o755)
  buildIcon(join(CONTENTS, 'Resources', ICON_FILE))
  await writeFile(join(CONTENTS, 'Info.plist'), infoPlist())
  await writeFile(join(CONTENTS, 'PkgInfo'), 'APPL????')
  // 没有开发者证书，做一次 ad-hoc 签名：Apple Silicon 上完全没签名的二进制直接不让跑，
  // 包内文件改动后也要重签，所以放在最后。用户第一次打开仍会被 Gatekeeper 拦（见 README）。
  run('codesign', ['--force', '--deep', '--sign', '-', BUNDLE])
  console.log(`已打包到 ${BUNDLE}`)
}

/** dmg 里放包本体和一个指向 /Applications 的链接，拖过去就装好了。 */
function buildDmg() {
  const staging = join(tmpdir(), `dsh-x-dmg-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  run('mkdir', ['-p', staging])
  run('ditto', [BUNDLE, join(staging, MAC_APP_NAME)])
  run('ln', ['-s', '/Applications', join(staging, 'Applications')])
  rmSync(DMG, { force: true })
  run('hdiutil', ['create', '-volname', DMG_VOLUME, '-srcfolder', staging, '-ov', '-format', 'UDZO', DMG])
  rmSync(staging, { recursive: true, force: true })
  console.log(`安装包: ${DMG}`)
}

await downloadNode()
const launcher = buildLauncher()
await assemble(launcher)
buildDmg()
