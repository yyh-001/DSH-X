// 把 npm-package/ + shell/ 打成 dsh-x 的 npm 包；--publish 时发到 npm。
//
//   node scripts/pack-npm.mjs
//   node scripts/pack-npm.mjs --publish
//
// CLI 包本身很小：外壳代码在这里，核心在运行时按平台从 npm 拉，Electron 是依赖。
// 版本跟外壳走（shell/package.json），核心版本由 npm 上的 dsh-x-core-* 决定。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionChannel } from '../src/version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'npm-package')
const OUT = join(ROOT, 'release')
const STAGE = join(OUT, 'npm-package-stage')

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const shellPkg = JSON.parse(readFileSync(join(ROOT, 'shell', 'package.json'), 'utf8'))
const version = shellPkg.version
const electron = String(rootPkg.devDependencies?.electron || '').replace(/^[~^]/, '') || '44.7.0'

await rm(STAGE, { recursive: true, force: true })
await mkdir(STAGE, { recursive: true })
await cp(SOURCE, STAGE, { recursive: true })
// 外壳：Electron 入口是包根的 shell/main.mjs；托盘图标在 src/assets（Windows 用 tray.ico）
await cp(join(ROOT, 'shell'), join(STAGE, 'shell'), { recursive: true })
// lib/core.mjs 在仓库里指向 ../../shell（npm-package/lib 的上一级才是仓库根）；
// 打进包里以后 lib/ 和 shell/ 都在包根下，路径要重写成 ../shell。
await writeFile(join(STAGE, 'lib', 'core.mjs'), [
  '// 核心获取的实现见 shell/core-fetch.mjs（安装版外壳共用这一份）。',
  "export * from '../shell/core-fetch.mjs'",
  '',
].join('\n'))
await mkdir(join(STAGE, 'assets'), { recursive: true })
for (const icon of ['icon.png', 'tray.ico', 'tray.png']) {
  await cp(join(ROOT, 'src', 'assets', icon), join(STAGE, 'assets', icon))
}
const pkgPath = join(STAGE, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = version
pkg.main = 'shell/main.mjs'
pkg.dependencies = { ...pkg.dependencies, electron }
pkg.files = [...new Set([...(pkg.files || []), 'shell', 'assets/icon.png', 'assets/tray.ico', 'assets/tray.png'])]
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
await mkdir(OUT, { recursive: true })
try {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', OUT], STAGE)
} finally {
  await rm(STAGE, { recursive: true, force: true }).catch(() => {})
}
const base = String(pkg.name).replace(/^@/, '').replace('/', '-')
const tgz = join(OUT, `${base}-${version}.tgz`)
if (!existsSync(tgz)) throw new Error(`npm pack 没有产出 ${tgz}`)
console.log(`npm 包：${tgz}`)
if (process.argv.includes('--publish')) {
  const tag = { official: 'latest', rc: 'rc', alpha: 'alpha' }[versionChannel(version)] || 'latest'
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // 只改核心的版本里外壳版本不变：同一个 CLI 版本已经发过就跳过，别让 CI 红在「不能覆盖已发布版本」
  const existing = spawnSync(npm, ['view', `${pkg.name}@${version}`, 'version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
  if (existing.status === 0 && existing.stdout.trim()) {
    console.log(`${pkg.name}@${version} 已经在 npm 上，跳过发布`)
  } else {
    run(npm, ['publish', tgz, '--tag', tag, '--access', 'public'])
    console.log(`已发布 dsh-x@${version}（${tag}）`)
  }
}
