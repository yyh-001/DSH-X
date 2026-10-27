// 本地模拟一次「发版」，用来验收引导器安装与增量更新，不需要真的发布到 GitHub。
//
//   node scripts/update-flow-demo.mjs
//
// 做三件事：
// 1. 用当前构建产物造一套「0.1.21」的假发布资产（app 版本号改成 0.1.21），连同 0.1.20 与
//    runtime 资产一起放进 release/test-release/
// 2. 在 8899 起一个静态服务器，把这个目录当发布页
// 3. 准备一个干净的安装目录 release/test-install/（只放引导器）
//
// 然后按打印出来的命令启动引导器：它用 DSH_BOOT_* 从本地装 0.1.20；装完应用带着
// DSH_UPDATE_* 环境变量启动，检查更新时会看到本地造的 0.1.21，可以点更新走完整流程。

import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buildAppAssets } from './app-manifest.mjs'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const PARTS = join(RELEASE, 'parts')
const TEST_RELEASE = join(RELEASE, 'test-release')
const TEST_INSTALL = join(RELEASE, 'test-install')
const PORT = 8899
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NEXT = '0.1.21'

const electronVersion = JSON.parse(await readFile(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const { createHash } = await import('node:crypto')

/** 引导器资产：把当前编译产物复制成 boot-<版本>-win.exe，返回清单里的 boot 信息。 */
async function bootAsset(version) {
  const built = join(ROOT, 'launcher', 'target', 'release', 'DSH-Boot.exe')
  const name = `boot-${version}-win.exe`
  const target = join(TEST_RELEASE, name)
  await cp(built, target)
  return { name, size: statSync(target).size, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') }
}

async function buildAssets() {
  await mkdir(TEST_RELEASE, { recursive: true })
  // 0.1.20（首次安装用）：从 parts 重新生成，确保装的是当前代码
  await buildAppAssets({ appDir: join(PARTS, 'app', CURRENT), version: CURRENT, electronVersion, platform: 'win', outDir: TEST_RELEASE })
  for (const name of [`runtime-${electronVersion}-win.zip`, `runtime-${electronVersion}-win.manifest.json`, `runtime-${electronVersion}-win.manifest.json.sig`]) {
    if (!existsSync(join(RELEASE, name))) throw new Error(`缺少 ${name}，先跑一次 npm run dist`)
    await cp(join(RELEASE, name), join(TEST_RELEASE, name))
  }
  // 假 0.1.21：拿当前 app 复制一份，改版本号（界面上能看出来更新成功）
  const source = join(PARTS, 'app', CURRENT)
  if (!existsSync(source)) throw new Error('缺少 release/parts/app，先跑一次 npm run dist')
  const staged = join(RELEASE, 'test-app-src')
  rmSync(staged, { recursive: true, force: true })
  await cp(source, staged, { recursive: true })
  const pkgPath = join(staged, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = NEXT
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const assets = await buildAppAssets({ appDir: staged, version: NEXT, electronVersion, platform: 'win', outDir: TEST_RELEASE, boot: await bootAsset(NEXT) })
  console.log(`假发布资产：${basename(assets.zipPath)}（${(assets.manifest.archive.size / 1048576).toFixed(1)} MB）`)

  // Electron 升级链路：如果准备了 37.5.1 的运行时目录，就再出一套「新版 runtime + 配套 app」
  const runtimeSrc = join(RELEASE, 'test-runtime-37')
  if (existsSync(runtimeSrc)) {
    const rt = await buildAppAssets({ appDir: runtimeSrc, version: '37.5.1', electronVersion: '37.5.1', platform: 'win', prefix: 'runtime', outDir: TEST_RELEASE })
    console.log(`假运行时资产：${basename(rt.zipPath)}（${(rt.manifest.archive.size / 1048576).toFixed(1)} MB）`)
    const staged2 = join(RELEASE, 'test-app-022')
    rmSync(staged2, { recursive: true, force: true })
    await cp(source, staged2, { recursive: true })
    const pkg2 = JSON.parse(readFileSync(join(staged2, 'package.json'), 'utf8'))
    pkg2.version = '0.1.22'
    writeFileSync(join(staged2, 'package.json'), `${JSON.stringify(pkg2, null, 2)}
`)
    const app2 = await buildAppAssets({ appDir: staged2, version: '0.1.22', electronVersion: '37.5.1', platform: 'win', outDir: TEST_RELEASE })
    console.log(`假应用资产：${basename(app2.zipPath)}（0.1.22 / Electron 37.5.1）`)
  }
}

function serve() {
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(String(req.url || '/').split('?')[0]))
    try {
      const file = join(TEST_RELEASE, name)
      const stat = statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
      res.writeHead(200, { 'content-length': stat.size })
      createReadStream(file).on('error', () => res.destroy()).pipe(res)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.log(`端口 ${PORT} 已在用，沿用现有服务`)
    else throw error
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`测试发布页：http://127.0.0.1:${PORT}/`))
  return server
}

function prepareInstall() {
  rmSync(TEST_INSTALL, { recursive: true, force: true })
  mkdirSync(TEST_INSTALL, { recursive: true })
  // 优先用刚编译的引导器（含本地测试钩子）；没有就退回打包产物
  const built = join(ROOT, 'launcher', 'target', 'release', 'DSH-Boot.exe')
  const boot = existsSync(built) ? built : join(RELEASE, 'boot', 'DSH.exe')
  if (!existsSync(boot)) throw new Error('缺少引导器：先在 launcher/ 跑 cargo build --release --bin DSH-Boot')
  writeFileSync(join(TEST_INSTALL, 'DSH.exe'), readFileSync(boot))
  console.log(`测试安装目录：${TEST_INSTALL}`)
}

await buildAssets()
const server = serve()
prepareInstall()
console.log('')
console.log('阶段 A：应用增量（0.1.20 → 0.1.21）——启动引导器：')
console.log(`  DSH_BOOT_BASE=http://127.0.0.1:${PORT} DSH_BOOT_VERSION=${CURRENT} DSH_UPDATE_BASE=http://127.0.0.1:${PORT} DSH_UPDATE_VERSION=${NEXT} "${join(TEST_INSTALL, 'DSH.exe')}"`)
console.log('')
console.log(`装完应用会带着 DSH_UPDATE_* 启动：管理器里点「更新」应看到 ${NEXT}，走增量下载 → 切换 → 重启，版本号变成 ${NEXT}。`)
console.log('')
console.log('阶段 B：Electron 运行时升级（需要 release/test-runtime-37 存在）')
console.log('  重启应用时把 DSH_UPDATE_VERSION 改成 0.1.22：管理器会提示更新运行时（37.5.1，约 120 MB），')
console.log('  切完运行时会重启到新 runtime，随后再提示应用更新到 0.1.22。')
console.log('测试完 Ctrl+C 结束本地发布页。')
void server
