import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/** Windows（pack.mjs）和 macOS（pack-mac.mjs）两套打包共用的部分：拷哪些文件、pnpm 从哪来。 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
export const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
// dsh 的 profile 用 pnpm 8（lockfile 6.0），便携目录带同主版本
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '8.15.9'
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
  'platform.js',
  'plugins.js',
  'mcp.js',
  'skills.js',
  'plugin-tool.js',
  'stdio-unblock.cjs',
  'package.json',
]
// 分层版看板娘的素材暂时不装进包（文件留在仓库里；以后切回分层版就把名字从这份名单去掉）
const SKIP_PUBLIC = new Set(['head-v2.png', 'accessories-v2.png', 'ear.png'])

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
    run(process.execPath, [npmCli, 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  await cp(join(staging, 'node_modules', 'pnpm'), target, { recursive: true })
}
