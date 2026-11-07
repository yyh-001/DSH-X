// 把核心层打成 npm 核心包：dsh-x-core@<版本>。
//
//   node scripts/pack-core.mjs                    # 用 release/core-stage，当前核心版本
//   node scripts/pack-core.mjs --version 0.1.21   # 本地演示用假版本
//   node scripts/pack-core.mjs --publish          # 发到 npm（CI 里用 NPM_TOKEN）
//
// 核心包跨平台：两套 filemanager 和两套 node 包装都在里面，Windows 和 mac 共用同一个包。
// 发布脚本只做打包，不碰安装包；安装包仍然由 pack.mjs 出（外壳 + 基线核心）。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionChannel } from '../src/version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_APP = join(ROOT, 'release', 'core-stage')

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

export function corePackageName() {
  return process.env.DSH_CORE_PACKAGE || 'dsh-x-core'
}

/** 生成核心 tarball；返回路径与完整性信息（演示和 CI 共用）。 */
export async function buildCorePackage({ appDir = DEFAULT_APP, version, outDir = join(ROOT, 'release'), electronVersion, name } = {}) {
  if (!existsSync(join(appDir, 'server.js'))) throw new Error(`缺少核心层：${appDir}（先跑 npm run stage:core）`)
  // 跨平台核心包要在 mac 上也能直接跑：POSIX 包装脚本必须带可执行位（npm pack 会保留）
  if (process.platform !== 'win32') {
    for (const name of ['node', 'npm', 'npx', 'pnpm', 'pnpx']) {
      const shim = join(appDir, 'node', name)
      if (!existsSync(shim) || (statSync(shim).mode & 0o111) === 0) throw new Error(`核心层的 POSIX 包装不可执行：${shim}`)
    }
  }
  const pkgVersion = String(version || JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)
  const electron = String(electronVersion || JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version)
  const packageName = String(name || corePackageName())
  const staging = join(outDir, `.core-pack-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(appDir, staging, { recursive: true })
  await writeFile(join(staging, 'package.json'), `${JSON.stringify({
    name: packageName,
    productName: 'DSH',
    version: pkgVersion,
    private: false,
    type: 'module',
    // 核心由外壳用 server.js 启动，不是 Electron 入口
    main: 'server.js',
    files: ['**/*'],
    // 核心按哪个 Electron 版本构建；外壳发现不一致就让用户更新外壳
    dshX: { electron },
  }, null, 2)}\n`)
  await mkdir(outDir, { recursive: true })
  try {
    run(npmCommand(), ['pack', '--pack-destination', outDir], staging)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const tgzPath = join(outDir, `${packageName}-${pkgVersion}.tgz`)
  if (!existsSync(tgzPath)) throw new Error(`npm pack 没有产出 ${tgzPath}`)
  const bytes = readFileSync(tgzPath)
  return {
    packageName,
    version: pkgVersion,
    tgzPath,
    size: bytes.length,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const appDir = argValue('--app', DEFAULT_APP)
  const version = argValue('--version')
  const outDir = argValue('--out', join(ROOT, 'release'))
  const result = await buildCorePackage({ appDir, version, outDir })
  console.log(`核心包：${basename(result.tgzPath)}（${(result.size / 1048576).toFixed(1)} MB）`)
  console.log(`integrity：${result.integrity}`)
  if (process.argv.includes('--publish')) {
    const tag = { official: 'latest', rc: 'rc', alpha: 'alpha' }[versionChannel(result.version)] || 'latest'
    const npm = npmCommand()
    // 只改外壳的版本里核心版本不变：同一个核心包已经发过就跳过
    const existing = spawnSync(npm, ['view', `${result.packageName}@${result.version}`, 'version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
    if (existing.status === 0 && existing.stdout.trim()) {
      console.log(`${result.packageName}@${result.version} 已经在 npm 上，跳过发布`)
    } else {
      run(npm, ['publish', result.tgzPath, '--tag', tag, '--access', 'public'])
      console.log(`已发布 ${result.packageName}@${result.version}（${tag}）`)
    }
  }
}
