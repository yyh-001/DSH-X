import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { collectArtifacts, writeReleaseManifest } from './release-manifest.mjs'
import { collectComponents, writeSbom } from './release-sbom.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
// dsh 的 profile 用 pnpm 8（lockfile 6.0），便携目录带同主版本
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '8.15.9'
const DIST = `node-v${NODE_VERSION}-win-x64`
const ZIP = `${DIST}.zip`
const VENDOR = join(ROOT, 'vendor')
const ZIP_PATH = join(VENDOR, ZIP)
const EXTRACTED = join(VENDOR, DIST)
const OUT = join(ROOT, 'release', 'DSH')
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

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node.exe'))) return
  const urls = [
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${ZIP}`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${ZIP}`,
  ]
  let last
  for (const url of urls) {
    try {
      console.log(`下载 ${url}`)
      await download(url, ZIP_PATH)
      last = null
      break
    } catch (error) {
      last = error
    }
  }
  if (last) throw last
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

async function copyNodeRuntime() {
  await mkdir(join(OUT, 'node'), { recursive: true })
  await copyFile(join(EXTRACTED, 'node.exe'), join(OUT, 'node', 'node.exe'))
  for (const name of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd']) {
    const src = join(EXTRACTED, name)
    if (existsSync(src)) await copyFile(src, join(OUT, 'node', name))
  }
  await mkdir(join(OUT, 'node', 'node_modules'), { recursive: true })
  await cp(join(EXTRACTED, 'node_modules', 'npm'), join(OUT, 'node', 'node_modules', 'npm'), { recursive: true })
  const corepack = join(EXTRACTED, 'node_modules', 'corepack')
  if (existsSync(corepack)) {
    await cp(corepack, join(OUT, 'node', 'node_modules', 'corepack'), { recursive: true })
  }
  await copyPnpm()
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件（含开机预装
 * dshmarket）。机器上有没有全局 pnpm 全看运气，所以便携目录自带一个，启动器再
 * 把它加进子进程 PATH。
 */
async function copyPnpm() {
  const target = join(OUT, 'node', 'node_modules', 'pnpm')
  if (existsSync(join(target, 'bin', 'pnpm.cjs'))) return
  const staging = join(VENDOR, 'pnpm')
  if (!existsSync(join(staging, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))) {
    console.log(`下载 pnpm@${PNPM_VERSION}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'pnpm-bootstrap',
      private: true,
      dependencies: { pnpm: PNPM_VERSION },
    }, null, 2))
    run(process.execPath, [join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  await cp(join(staging, 'node_modules', 'pnpm'), target, { recursive: true })
  await writeFile(join(OUT, 'node', 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    '"%~dp0node.exe" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(OUT, 'node', 'pnpm'), [
    '#!/bin/sh',
    'exec "$(dirname "$0")/node.exe" "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
  const pnpx = 'pnpx'
  await writeFile(join(OUT, 'node', `${pnpx}.cmd`), [
    '@ECHO off',
    'SETLOCAL',
    '"%~dp0node.exe" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

async function buildLauncher() {
  run('cargo', ['build', '--release'], join(ROOT, 'launcher'))
}

async function assemble() {
  rmSync(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'public'), { recursive: true })
  await mkdir(join(OUT, 'assets'), { recursive: true })
  for (const file of [
    'start.js',
    'server.js',
    'registry.js',
    'settings.js',
    'plugins.js',
    'plugin-tool.js',
    'stdio-unblock.cjs',
    'package.json',
  ]) {
    await copyFile(join(ROOT, file), join(OUT, file))
  }
  // 分层版看板娘的素材暂时不装进包（文件留在仓库里；以后切回分层版就把名字从这份名单去掉）
  const skipAssets = new Set(['head-v2.png', 'accessories-v2.png', 'ear.png'])
  await cp(join(ROOT, 'public'), join(OUT, 'public'), {
    recursive: true,
    filter: (src) => !skipAssets.has(basename(src)),
  })
  await cp(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true })
  await copyFile(join(ROOT, 'assets', 'dsh.ico'), join(OUT, 'assets', ICON_NAME))
  await cp(join(ROOT, 'perf'), join(OUT, 'perf'), { recursive: true })
  await cp(join(ROOT, 'compat'), join(OUT, 'compat'), { recursive: true })
  await copyNodeRuntime()
  // 这里原本要拷 node_modules（装着 systray2）。托盘搬进 DSH.exe 之后启动器不再依赖任何
  // npm 包，只剩 node 内置模块和同目录的自己人，整份拷贝都省了。
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH.exe'), join(OUT, 'DSH.exe'))
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
  console.log('编译安装包')
  run(iscc, [
    SETUP_ISS,
    `/DMyAppVersion=${PKG.version}`,
    `/DMyAppIcon=${ICON_NAME}`,
    `/O${join(ROOT, 'release')}`,
    `/F${SETUP_NAME}`,
  ])
  const setup = join(ROOT, 'release', `${SETUP_NAME}.exe`)
  if (!existsSync(setup)) throw new Error(`没有生成 ${setup}`)
  const desktop = join(DESKTOP, `${SETUP_NAME}.exe`)
  await copyFile(setup, desktop)
  console.log(`安装包: ${setup}`)
  console.log(`已复制到桌面: ${desktop}`)
}

// 发布资产：先出 SBOM，再出覆盖「安装包 + SBOM」的发布清单（有私钥时顺带签名）。
// 没配密钥也不该让打包失败，所以这里只提示。
async function buildReleaseArtifacts() {
  const releaseDir = join(ROOT, 'release')
  const { path: sbomPath } = writeSbom({ releaseDir, version: PKG.version })
  console.log(`SBOM: ${sbomPath}`)
  const artifacts = collectArtifacts(releaseDir, [`${SETUP_NAME}.exe`, basename(sbomPath)])
  const { manifest, signed } = writeReleaseManifest({
    releaseDir,
    version: PKG.version,
    artifacts,
    components: collectComponents({ nodeDir: join(releaseDir, 'DSH', 'node') }),
  })
  const where = manifest.tag ? `tag ${manifest.tag}` : '没有 tag'
  console.log(`发布清单: release/release-manifest.json（${where}${manifest.dirty ? '，有未提交改动' : ''}）`)
  console.log(signed ? '已用 release/release-key.pem 签名' : '未签名：没有 release/release-key.pem（node scripts/release-manifest.mjs keygen 生成）')
}

await downloadNode()
await buildLauncher()
await assemble()
await buildInstaller()
await buildReleaseArtifacts()
