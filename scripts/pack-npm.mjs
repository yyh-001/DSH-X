// 把 npm-package/ 打成 dsh-x 的 npm 包；--publish 时发到 npm。
//
//   node scripts/pack-npm.mjs
//   node scripts/pack-npm.mjs --publish
//
// CLI 包本身很小，核心和 Electron 都在运行时按平台获取（核心从 npm，Electron 是依赖）。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionChannel } from '../version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'npm-package')
const OUT = join(ROOT, 'release')
const STAGE = join(OUT, 'npm-package-stage')

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = rootPkg.version
const electron = String(rootPkg.devDependencies?.electron || '').replace(/^[~^]/, '') || '44.7.0'

await rm(STAGE, { recursive: true, force: true })
await mkdir(STAGE, { recursive: true })
await cp(SOURCE, STAGE, { recursive: true })
const pkgPath = join(STAGE, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = version
pkg.dependencies = { ...pkg.dependencies, electron }
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
await mkdir(OUT, { recursive: true })
try {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', OUT], STAGE)
} finally {
  await rm(STAGE, { recursive: true, force: true }).catch(() => {})
}
const tgz = join(OUT, `dsh-x-${version}.tgz`)
if (!existsSync(tgz)) throw new Error(`npm pack 没有产出 ${tgz}`)
console.log(`npm 包：${tgz}`)
if (process.argv.includes('--publish')) {
  const tag = { official: 'latest', rc: 'rc', alpha: 'alpha' }[versionChannel(version)] || 'latest'
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['publish', tgz, '--tag', tag, '--access', 'public'])
  console.log(`已发布 dsh-x@${version}（${tag}）`)
}
