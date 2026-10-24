import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Windows（pack.mjs）和 macOS（pack-mac.mjs）两套打包共用的部分：拷哪些文件、pnpm 从哪来。 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
// 发行包只用来取 npm（软件本体已经改用 Electron 自带的 Node，不再发 node.exe）；
// 这份缓存还留着，是为了两个平台的构建脚本共用、并且能离线重打。
export const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
// 便携目录兜底的那份 pnpm：要读得动现代 profile —— lockfile 9.0、pnpm-workspace.yaml
// 里的设置（后者 pnpm 10.6 起才认）。store 主版本也跟着 pnpm 主版本走（8→v3、10→v10、
// 11/12→v11），8.x 那份拿到 v11 store 的 profile 上会以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装。
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '11.27.1'
export const VENDOR = join(ROOT, 'vendor')
export const NODE_MIRRORS = [
  'https://npmmirror.com/mirrors/node',
  'https://nodejs.org/dist',
]

/** 启动器自己的源码文件（安装目录顶层）。 */
const APP_FILES = [
  'start.js',
  'server.js',
  'startup-diagnosis.js',
  'runtime-diagnostics.mjs',
  'repair-plan.js',
  'diagnostic-repair.js',
  'repair-actions.js',
  'repair-probe.mjs', 'optional-analytics-proof.js', 'repair-evidence.js',
  'repair-dependencies.js', 'repair-uninstall.mjs',
  'configuration-evidence.js', 'diagnostic-command-error.js',
  'log-writer.js',
  'registry.js',
  'settings.js',
  'proxy.js',
  'platform.js',
  'filemanager.js',
  'filemanager-base.js',
  'plugins.js',
  'recovery.js',
  'packs.js',
  'pack-market.js',
  'zip.js',
  'mcp.js',
  'skills.js',
  'sync.js',
  'version.js',
  'zipfile.js',
  'plugin-tool.js',
  'reserved-profile-boot.mjs',
  'stdio-unblock.cjs',
  'package.json',
]
// 不装进安装包的 public 素材（文件留在仓库里备回滚；要重新启用就从这份名单去掉）
const SKIP_PUBLIC = new Set([
  'head-v2.png', 'accessories-v2.png', 'ear.png',
  // v3 设计稿仅供回看；运行时使用 v8 / v9，不把旧图带进安装包
  'head-v3.png', 'tuft-v3.png', 'bow-v3.png',
  // v7 换装（docs/mascot-design/compose-v7.py）后退役的原版素材
  'base.png', 'base-dark.png', 'base-dark-soft.png', 'tuft.svg', 'tuft-dark.svg', 'bow.svg', 'bow-dark.svg',
  // v8 排布（docs/mascot-design/prepare-v8.py）后退役的 v7 均匀倍率版
  'head-v7.png', 'tuft-v7.png', 'bow-v7.png', 'ear-v7.png',
])

export function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

export async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

/** 依次试各个镜像下载 node 发行包的某个文件。 */
export async function downloadNodeFile(file, dest) {
  let last
  for (const mirror of NODE_MIRRORS) {
    const url = `${mirror}/v${NODE_VERSION}/${file}`
    try {
      console.log(`下载 ${url}`)
      await download(url, dest)
      return
    } catch (error) {
      last = error
    }
  }
  throw last
}

/** 把启动器的源码和静态资源拷进 out（node 运行时和原生外壳由各平台自己放）。 */
/**
 * 文件管理的实现类按平台分开打包：装到哪台机器上就只带哪一套。
 * filemanager.js 用动态 import 挑实现，所以另一套不在安装目录里也不会报模块找不到。
 */
const FILE_MANAGERS = {
  win32: 'filemanager-windows.js',
  darwin: 'filemanager-mac.js',
}

/**
 * platform 决定带哪套文件管理实现，默认跟着当前这台机器 —— Windows 的包在
 * Windows 上打、mac 的包在 mac 上打，两条链路本来就各自在自己的平台跑。
 */
export async function copyAppFiles(out, platform = process.platform) {
  await mkdir(join(out, 'public'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  const fileManager = FILE_MANAGERS[platform]
  if (!fileManager) throw new Error(`没有 ${platform} 的文件管理实现：照 filemanager-base.js 的契约补一个再打包`)
  for (const file of [...APP_FILES, fileManager]) {
    await copyFile(join(ROOT, file), join(out, file))
  }
  await cp(join(ROOT, 'public'), join(out, 'public'), {
    recursive: true,
    filter: (src) => !SKIP_PUBLIC.has(basename(src)),
  })
  await cp(join(ROOT, 'assets'), join(out, 'assets'), { recursive: true })
  await cp(join(ROOT, 'perf'), join(out, 'perf'), { recursive: true })
  await cp(join(ROOT, 'compat'), join(out, 'compat'), { recursive: true })
  // 整合包配方（packs/）：随安装包发，插件页的「内置整合包」就地安装，不用联网去 Release 拿。
  // 插件本身不随包发（仓库的 plugins/ 只是源码与发布源，插件都从 npm 装）。
  await cp(join(ROOT, 'packs'), join(out, 'packs'), { recursive: true })
}

/**
 * 把 npm 从解压好的 node 发行包拷进 nodeDir/node_modules。
 *
 * 只拷 npm：corepack 以前跟着 node.exe 一起发，现在 dsh 子进程用 Electron 自带的 Node，
 * corepack 又依赖 node 本体，带进来只会多 1MB 死代码。pnpm 由 copyPnpm 另外准备。
 */
export async function copyNpmModules(modulesSrc, nodeDir) {
  await mkdir(join(nodeDir, 'node_modules'), { recursive: true })
  await cp(join(modulesSrc, 'npm'), join(nodeDir, 'node_modules', 'npm'), { recursive: true })
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件。机器上有没有全局
 * pnpm 全看运气，所以便携目录自带一个，启动器再把它加进子进程 PATH。
 * 命令行包装（pnpm / pnpm.cmd）由各平台自己写。
 *
 * npmCli 是用来装 pnpm 的 npm-cli.js；pnpm 是纯 JS 包，在哪个平台装出来都一样。
 */
export async function copyPnpm(nodeDir, npmCli) {
  const target = join(nodeDir, 'node_modules', 'pnpm')
  if (pnpmVersionOf(target) === PNPM_VERSION) return
  const staging = join(VENDOR, 'pnpm')
  const staged = join(staging, 'node_modules', 'pnpm')
  if (pnpmVersionOf(staged) !== PNPM_VERSION) {
    console.log(`下载 pnpm@${PNPM_VERSION}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'pnpm-bootstrap',
      private: true,
      dependencies: { pnpm: PNPM_VERSION },
    }, null, 2))
    await rm(staged, { recursive: true, force: true })
    run(process.execPath, [npmCli, 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  // 整目录替换：合并拷贝会把上一个版本的残留文件（pnpm 11 起 dist 是分块的）留在里面
  await rm(target, { recursive: true, force: true })
  await cp(staged, target, { recursive: true })
}

/**
 * 目录里那份 pnpm 的版本，没有或读不出来就是空串。判定看版本号、不看文件在不在 ——
 * 否则换了版本常量，缓存里那份旧的还会被继续发出去。
 */
function pnpmVersionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}
