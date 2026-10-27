import { existsSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { packager } from '@electron/packager'
import { LAUNCHER_NAME } from '../platform.js'
import { pruneWinElectron } from './electron-prune.mjs'
import {
  NODE_VERSION,
  PKG,
  ROOT,
  VENDOR,
  copyAppFiles,
  copyNpmModules,
  copyPnpm as copyPnpmModule,
  download,
  downloadNodeFile,
  run,
} from './pack-common.mjs'
import { collectArtifacts, writeReleaseManifest } from './release-manifest.mjs'
import { collectComponents, writeSbom } from './release-sbom.mjs'

// Windows 和 macOS 都是 Electron 外壳（shell/）；这里负责 Windows 的包 + Inno 安装包。
if (process.platform === 'darwin') {
  await import('./pack-mac.mjs')
  process.exit(0)
}

const DIST = `node-v${NODE_VERSION}-win-x64`
const ZIP = `${DIST}.zip`
const ZIP_PATH = join(VENDOR, ZIP)
const EXTRACTED = join(VENDOR, DIST)
/** 安装目录（Inno 的 {app}）：DSH.exe + Electron 运行时 + resources/app/ 里的启动器代码。 */
const OUT = join(ROOT, 'release', 'DSH')
/** packager 的输出目录，组装完挪进 OUT。 */
const ELECTRON_OUT = join(ROOT, 'release', 'electron-out')
/** 外壳源码：平铺拷进 resources/app/shell（和 mac 的 Resources/app/shell 同一份）。 */
const SHELL_DIR = join(ROOT, 'shell')
/** Electron 按这个目录找 app 入口（resources/app/package.json 的 main）。 */
const APP = join(OUT, 'resources', 'app')
const INNO_DIR = join(VENDOR, 'inno')
const INNO_SETUP = join(VENDOR, 'innosetup.exe')
const ISCC = join(INNO_DIR, 'ISCC.exe')
const SETUP_ISS = join(ROOT, 'scripts', 'dsh-setup.iss')
const SETUP_NAME = 'DSH-Setup'
// Windows 按路径缓存快捷方式图标：同名文件覆盖后，Explorer 仍会显示缓存里的旧位图，
// 升级用户会以为图标没更新。图标文件名带上版本号，路径一变缓存就失效，不用指望用户
// 去清图标缓存。
const ICON_NAME = `dsh-${PKG.version}.ico`
const DESKTOP = join(process.env.USERPROFILE || ROOT, 'Desktop')

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node.exe'))) return
  await downloadNodeFile(ZIP, ZIP_PATH)
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

/**
 * 自带运行时目录（resources/app/node）。现在这里**没有 node.exe**：dsh 子进程直接用
 * Electron 自带的 Node（platform.js 的 runtimeNode 返回 DSH.exe 本体，配 ELECTRON_RUN_AS_NODE=1）。
 * 目录里留下 npm / pnpm 的 JS 包和包装脚本，外加一个 `node` 命令包装：插件构建脚本需要
 * `node` 时也能落到 Electron 上。旧安装包里的 node.exe 仍然兼容（runtimeNode 先找它）。
 */
const NODE_SHIM_CMD = [
  '@ECHO off',
  'SETLOCAL',
  'SET "ELECTRON_RUN_AS_NODE=1"',
  'IF DEFINED DSH_ELECTRON_BIN (',
  '  "%DSH_ELECTRON_BIN%" %*',
  ') ELSE (',
  '  "%~dp0..\\..\\..\\DSH.exe" %*',
  ')',
  '',
].join('\r\n')
const NODE_SHIM_SH = [
  '#!/bin/sh',
  'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
  'ELECTRON_RUN_AS_NODE=1 exec "$(dirname "$0")/../../../DSH.exe" "$@"',
  '',
].join('\n')

async function copyNodeRuntime(nodeDir) {
  await mkdir(nodeDir, { recursive: true })
  await writeFile(join(nodeDir, 'node.cmd'), NODE_SHIM_CMD)
  await writeFile(join(nodeDir, 'node'), NODE_SHIM_SH)
  await copyNpmModules(join(EXTRACTED, 'node_modules'), nodeDir)
  await copyPnpm(nodeDir)
}

/** pnpm 本体见 pack-common.mjs 的 copyPnpm；这里只写 Windows 的命令行包装。 */
async function copyPnpm(nodeDir) {
  await copyPnpmModule(nodeDir, join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  await writeFile(join(nodeDir, 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    'call "%~dp0node.cmd" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(nodeDir, 'pnpm'), [
    '#!/bin/sh',
    'exec node "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
  await writeFile(join(nodeDir, 'pnpx.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'call "%~dp0node.cmd" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

/**
 * 只要 Electron 的空壳：packager 负责下载 win32 x64 的 Electron、改名（electron.exe → DSH.exe）、
 * 写 exe 的图标与版本信息。app 目录给它一个只含 package.json 的占位，真正的内容 assemble 时再换——
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
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    name: 'DSH-X',
    executableName: LAUNCHER_NAME,
    appVersion: PKG.version,
    buildVersion: PKG.version,
    appCopyright: 'Copyright (C) 2026 yyh',
    icon: join(ROOT, 'assets', 'dsh.ico'),
    win32metadata: {
      CompanyName: 'yyh',
      FileDescription: 'DSH-X 启动器',
      // 安装包升级时 Restart Manager 靠版本信息认「要关的是哪个程序」
      OriginalFilename: `${LAUNCHER_NAME}.exe`,
      ProductName: 'DSH-X',
      InternalName: LAUNCHER_NAME,
      'requested-execution-level': 'asInvoker',
    },
    asar: false,
    prune: false,
    overwrite: true,
    quiet: true,
  })
  rmSync(stub, { recursive: true, force: true })
  return out
}

async function assemble(shellDir) {
  rmSync(OUT, { recursive: true, force: true })
  await rename(shellDir, OUT)
  rmSync(ELECTRON_OUT, { recursive: true, force: true })
  // packager 放的占位 app 换成真正的内容
  rmSync(APP, { recursive: true, force: true })
  await copyAppFiles(APP)
  await cp(SHELL_DIR, join(APP, 'shell'), { recursive: true })
  // Electron 按 resources/app/package.json 的 main 找入口；仓库里的 main 是给 npm start 的 start.js，
  // 包里改指外壳。版本号等其余字段原样保留（server.js 读它显示版本、比较自更新）。
  const appPackage = join(APP, 'package.json')
  await writeFile(appPackage, `${JSON.stringify({ ...JSON.parse(await readFile(appPackage, 'utf8')), main: 'shell/main.mjs' }, null, 2)}\n`)
  // 自带运行时跟着 app 走：platform.js 的 runtimeNode() 会把这里的 node.cmd 目录拼进 PATH；
  // node 本体就是上面的 DSH.exe（Electron），包里不再有 node/node.exe
  await copyNodeRuntime(join(APP, 'node'))
  // Inno 的快捷方式图标用这个单独文件（路径带版本号，换版后图标缓存失效）
  await mkdir(join(OUT, 'assets'), { recursive: true })
  await copyFile(join(ROOT, 'assets', 'dsh.ico'), join(OUT, 'assets', ICON_NAME))
  // 安装包之前裁剪 Electron 自带的多语言与软件渲染（见 electron-prune.mjs 的理由）
  const prunedBytes = pruneWinElectron(OUT)
  if (prunedBytes > 0) console.log(`已裁剪 Electron 运行时：省下 ${(prunedBytes / 1048576).toFixed(1)} MB`)
  console.log(`已打包到 ${OUT}`)
}

function findIscc() {
  const candidates = [
    ISCC,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
  ]
  return candidates.find((path) => path && existsSync(path)) || ''
}

async function ensureInno() {
  const existing = findIscc()
  if (existing) return existing
  await mkdir(VENDOR, { recursive: true })
  const url = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
  console.log(`下载 Inno Setup ${url}`)
  await download(url, INNO_SETUP)
  if (!existsSync(INNO_SETUP) || readFileSync(INNO_SETUP).length < 1_000_000) {
    throw new Error('Inno Setup 下载失败')
  }
  await mkdir(INNO_DIR, { recursive: true })
  console.log(`安装 Inno Setup 到 ${INNO_DIR}`)
  run(INNO_SETUP, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    `/DIR=${INNO_DIR}`,
  ])
  const installed = findIscc()
  if (!installed) throw new Error('Inno Setup 安装后找不到 ISCC.exe')
  return installed
}

async function buildInstaller() {
  const iscc = await ensureInno()
  // Inno 只打内层负载，最终分发的单文件由网页外壳内嵌它；用户不需要旁边再放一个 exe。
  const engineDir = join(VENDOR, 'installer-engine')
  await mkdir(engineDir, { recursive: true })
  console.log('编译安装引擎')
  run(iscc, [
    SETUP_ISS,
    `/DMyAppVersion=${PKG.version}`,
    `/DMyAppIcon=${ICON_NAME}`,
    `/O${engineDir}`,
    '/FDSH-Install-Engine',
  ])
  const previousEngine = process.env.DSH_INSTALL_ENGINE
  try {
    process.env.DSH_INSTALL_ENGINE = join(engineDir, 'DSH-Install-Engine.exe')
    run('cargo', ['build', '--release', '--features', 'installer', '--bin', 'DSH-Setup'], join(ROOT, 'launcher'))
  } finally {
    if (previousEngine === undefined) delete process.env.DSH_INSTALL_ENGINE
    else process.env.DSH_INSTALL_ENGINE = previousEngine
  }
  const setup = join(ROOT, 'release', `${SETUP_NAME}.exe`)
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH-Setup.exe'), setup)
  if (!existsSync(setup)) throw new Error(`没有生成 ${setup}`)
  const desktop = join(DESKTOP, `${SETUP_NAME}.exe`)
  await copyFile(setup, desktop)
  console.log(`安装包: ${setup}`)
  console.log(`已复制到桌面: ${desktop}`)
}

// 发布资产：先出 SBOM，再出覆盖「安装包 + SBOM」的发布清单（有私钥时顺带签名）。
// 核心走 npm 单独发版，这里不再产出 app zip/清单。
async function buildReleaseArtifacts() {
  const releaseDir = join(ROOT, 'release')
  const { path: sbomPath } = writeSbom({ releaseDir, version: PKG.version })
  console.log(`SBOM: ${sbomPath}`)
  const artifacts = collectArtifacts(releaseDir, [
    `${SETUP_NAME}.exe`,
    basename(sbomPath),
  ])
  const { manifest, signed } = writeReleaseManifest({
    releaseDir,
    version: PKG.version,
    artifacts,
    components: collectComponents({ nodeDir: join(APP, 'node') }),
  })
  const where = manifest.tag ? `tag ${manifest.tag}` : '没有 tag'
  console.log(`发布清单: release/release-manifest.json（${where}${manifest.dirty ? '，有未提交改动' : ''}）`)
  console.log(signed ? '已用 release/release-key.pem 签名' : '未签名：没有 release/release-key.pem（node scripts/release-manifest.mjs keygen 生成）')
}

await downloadNode()
await assemble(await buildShell())
await buildInstaller()
await buildReleaseArtifacts()
