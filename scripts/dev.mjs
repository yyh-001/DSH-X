#!/usr/bin/env node
/**
 * 不打包的本地验收实例。日常测试用它，不再每次 `npm run dist` + 安装：
 *
 *   npm run dev:core   已安装的外壳 + release/core-stage，临时数据目录；
 *                      可以和正式版同时开着，适合验核心/管理页（语言、WSL 选择窗）。
 *   npm run dev:shell  源码外壳（node_modules/electron）+ release/core-stage，真实数据目录；
 *                      适合验 preload / 拖拽 / 托盘 / 内部标签；跑之前先退出已安装的 DSH-X。
 *   npm run dev:app    伪安装：把 shell/ 同步进 release/dev-app，app.isPackaged=true；
 *                      临时数据目录，适合验打包后行为（托盘图标资源、核心恢复的 installed 守卫）。
 *
 * 参数：
 *   --fresh     先清掉这次用的临时数据目录（验证首次启动；dev:shell 拒绝）
 *   --no-stage  不重新组装 core-stage，直接用现有的 release/core-stage
 *   --dry-run   只打印启动计划，不组装、不复制、不启动
 *   其余参数原样传给应用，例如 --remote-debugging-port=9223
 *
 * 环境变量：
 *   DSH_DEV_APPDATA  覆盖数据目录（F 节的核心恢复用它固定路径）
 *   DSH_CORE_DIR     覆盖核心目录；设了就不再组装 core-stage
 *                    （F 节指向 <APPDATA>\DSH\core\current，recoverCore 的守卫才生效）
 *   DSH_INSTALLED    覆盖安装版 DSH.exe 路径（mac/Linux 上 dev:core 必填）
 *
 * 临时数据目录只隔离 Windows 的 APPDATA；mac/Linux 的 APP_DIR 不认这个变量，
 * 那边 dev:core / dev:app 也共用真实应用数据目录，启动前同样要先退出正在运行的 DSH-X。
 *
 * 子进程不用 detached：Windows 上 detached 会把控制台子进程静默杀掉（见 AGENTS 的踩坑记录）。
 * 这里用 stdio: 'inherit' 等应用退出，日志直接可见，Ctrl+C / 关窗口就是结束。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_STAGE = join(ROOT, 'release', 'core-stage')
const DEV_APP = join(ROOT, 'release', 'dev-app')
const DEV_ROOT = join(tmpdir(), 'dshx-dev')
const MODES = ['core', 'shell', 'app']

const USAGE = `用法：node scripts/dev.mjs <core|shell|app> [--fresh] [--no-stage] [--dry-run] [-- 应用参数]
  core   已安装外壳 + 本地核心，临时数据目录（可与正式版并行）
  shell  源码外壳 + 本地核心，真实数据目录（先退出已安装的 DSH-X）
  app    伪安装（release/dev-app），临时数据目录（app.isPackaged=true）`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function installedExe() {
  if (process.env.DSH_INSTALLED) return process.env.DSH_INSTALLED
  const candidates = IS_WIN
    ? [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'DSH', 'DSH.exe'),
        join(process.env.ProgramFiles || '', 'DSH', 'DSH.exe'),
        join(process.env['ProgramFiles(x86)'] || '', 'DSH', 'DSH.exe'),
      ]
    : IS_MAC
      ? ['/Applications/DSH.app/Contents/MacOS/DSH']
      : []
  return candidates.find((candidate) => existsSync(candidate)) || ''
}

function unpackedDir() {
  if (IS_WIN) return join(ROOT, 'release', 'eb', 'win-unpacked')
  if (IS_MAC) {
    return [join(ROOT, 'release', 'eb', 'mac-arm64', 'DSH.app'), join(ROOT, 'release', 'eb', 'mac', 'DSH.app')]
      .find((candidate) => existsSync(candidate)) || ''
  }
  return join(ROOT, 'release', 'eb', 'linux-unpacked')
}

function appResources(bundle) {
  return IS_MAC ? join(bundle, 'Contents', 'Resources', 'app') : join(bundle, 'resources', 'app')
}

function appExe(bundle) {
  if (IS_WIN) return join(bundle, 'DSH.exe')
  if (IS_MAC) return join(bundle, 'Contents', 'MacOS', 'DSH')
  return join(bundle, 'DSH')
}

/** 已安装的 DSH-X 在跑吗（Windows 按进程名；mac/Linux 用 pgrep 粗判）。dev:shell 共用真实数据目录，必须先退出。 */
function installedRunning() {
  if (IS_WIN) {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DSH.exe', '/NH'], { encoding: 'utf8' })
    return /DSH\.exe/i.test(out.stdout || '')
  }
  const out = spawnSync('pgrep', ['-f', 'DSH'], { encoding: 'utf8' })
  return out.status === 0 && (out.stdout || '').trim() !== ''
}

/** 组装核心层：只跑 pack.mjs 的核心 stage，不碰 electron-builder / NSIS（约 6 秒）。 */
function stageCore() {
  console.log('组装核心层（release/core-stage）…')
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--stage-only'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) fail('核心层组装失败，见上面的输出。')
}

/** 伪安装：第一次复制解包目录，之后只同步 shell/ 和 assets/（app.isPackaged 保持 true）。 */
function syncDevApp() {
  const unpacked = unpackedDir()
  if (!unpacked || !existsSync(unpacked)) {
    fail(`还没有解包目录：${unpacked || '（本平台未知）'}\n先 npm run dist 打一次包，之后 dev:app 只同步 shell，不再重打。`)
  }
  if (!existsSync(DEV_APP)) {
    console.log(`复制解包目录（只需一次）：${unpacked}\n  → ${DEV_APP}`)
    cpSync(unpacked, DEV_APP, { recursive: true })
  }
  const app = appResources(DEV_APP)
  if (!existsSync(app)) fail(`解包目录里没有 resources/app：${app}`)
  // 整目录替换：删除的文件（例如退役的 startup-error.mjs）不会残留在伪安装里。
  rmSync(join(app, 'shell'), { recursive: true, force: true })
  cpSync(join(ROOT, 'shell'), join(app, 'shell'), { recursive: true })
  rmSync(join(app, 'assets'), { recursive: true, force: true })
  cpSync(join(ROOT, 'src', 'assets'), join(app, 'assets'), { recursive: true })
  console.log('已同步 shell/ 与 assets/ 到伪安装。')
}

const [mode, ...rest] = process.argv.slice(2)
if (!MODES.includes(mode)) fail(USAGE)
const fresh = rest.includes('--fresh')
const noStage = rest.includes('--no-stage')
const dryRun = rest.includes('--dry-run')
const passthrough = rest.filter((arg) => !['--fresh', '--no-stage', '--dry-run'].includes(arg))

// 数据目录：core/app 默认用临时目录（Windows 上才真正隔离）；shell 默认用真实目录。
// 显式给了 DSH_DEV_APPDATA 就按它来（shell 也能借此跑隔离实例）。
const isolated = mode !== 'shell'
const appdata = process.env.DSH_DEV_APPDATA || (IS_WIN && isolated ? join(DEV_ROOT, mode) : '')
if (fresh && !appdata) {
  fail('dev:shell 默认使用真实数据目录，--fresh 会删除真实设置，拒绝执行；要隔离请先设 DSH_DEV_APPDATA。')
}

let coreDir = process.env.DSH_CORE_DIR || CORE_STAGE
if (!dryRun) {
  if (fresh && appdata) {
    rmSync(appdata, { recursive: true, force: true })
    console.log(`已清空数据目录：${appdata}`)
  }
  if (appdata) mkdirSync(appdata, { recursive: true })
  if (!process.env.DSH_CORE_DIR && !noStage) stageCore()
  if (!existsSync(join(coreDir, 'server.js'))) fail(`核心目录里没有 server.js：${coreDir}`)
}

let exe = ''
let args = []
if (mode === 'core') {
  exe = installedExe()
  if (!exe && !dryRun) {
    fail(`找不到已安装的 DSH-X。用 DSH_INSTALLED 指到 DSH.exe，或改用 npm run dev:shell。\n${USAGE}`)
  }
  args = passthrough
} else if (mode === 'shell') {
  try {
    exe = createRequire(import.meta.url)('electron')
  } catch {
    exe = ''
  }
  if (!exe && !dryRun) fail('找不到 node_modules/electron：先 npm install。')
  args = [...passthrough, join(ROOT, 'shell', 'main.mjs')]
  if (!dryRun && !appdata && installedRunning()) {
    fail('检测到 DSH-X 正在运行。dev:shell 用真实数据目录，和它共用单实例锁：\n先托盘退出已安装的 DSH-X，或设 DSH_DEV_APPDATA 跑一个隔离实例（已有 dsh 版本不会跟着过去）。')
  }
} else {
  if (!dryRun) syncDevApp()
  exe = appExe(DEV_APP)
  args = passthrough
  if (!dryRun && !appdata && installedRunning()) {
    fail('检测到 DSH-X 正在运行。伪安装和它共用真实数据目录（本平台无法用 APPDATA 隔离）：\n先托盘退出已安装的 DSH-X。')
  }
}

const dataNote = appdata ? `${appdata}（隔离，可与正式版并行）` : '真实数据目录（%APPDATA%\\DSH）'
console.log(`\n模式：${mode}`)
console.log(`数据目录：${dataNote}`)
console.log(`核心目录：${coreDir}`)
console.log(`启动：${exe || '（未找到安装版；dry-run 只打印计划）'}`)
if (args.length) console.log(`参数：${args.join(' ')}`)
if (dryRun) {
  if (mode === 'app' && !existsSync(DEV_APP)) console.log(`伪安装目录：${DEV_APP}（尚无，首次运行会从解包目录复制）`)
  console.log('\n--dry-run：没有组装、复制或启动。')
  process.exit(0)
}

// stdio: inherit 让主进程日志直接可见；Windows 上不要 detached（会把子进程静默杀掉）。
const child = spawn(exe, args, {
  cwd: ROOT,
  env: { ...process.env, ...(appdata ? { APPDATA: appdata } : {}), DSH_CORE_DIR: coreDir },
  stdio: 'inherit',
})
child.on('error', (error) => fail(`启动失败：${error.message}`))
child.on('exit', (code) => process.exit(code ?? 0))
console.log(`\n应用已启动（PID ${child.pid ?? '?'}；关窗口或 Ctrl+C 结束这个进程；托盘可能在后台继续跑，用托盘「退出」收尾）。`)
