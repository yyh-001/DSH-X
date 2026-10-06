import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Windows（pack.mjs）和 macOS（pack-mac.mjs）两套打包共用的部分：拷哪些文件、pnpm 从哪来。 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
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
  'registry.js',
  'settings.js',
  'proxy.js',
  'platform.js',
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
export async function copyAppFiles(out) {
  await mkdir(join(out, 'public'), { recursive: true })
  await mkdir(join(out, 'assets'), { recursive: true })
  for (const file of APP_FILES) {
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

/** 把 npm、corepack 从解压好的 node 发行包拷进 nodeDir/node_modules。 */
export async function copyNpmModules(modulesSrc, nodeDir) {
  await mkdir(join(nodeDir, 'node_modules'), { recursive: true })
  await cp(join(modulesSrc, 'npm'), join(nodeDir, 'node_modules', 'npm'), { recursive: true })
  const corepack = join(modulesSrc, 'corepack')
  if (existsSync(corepack)) {
    await cp(corepack, join(nodeDir, 'node_modules', 'corepack'), { recursive: true })
  }
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件（含开机预装
 * dshmarket）。机器上有没有全局 pnpm 全看运气，所以便携目录自带一个，启动器再
 * 把它加进子进程 PATH。命令行包装（pnpm / pnpm.cmd）由各平台自己写。
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
