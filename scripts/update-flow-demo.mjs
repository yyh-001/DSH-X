// 本地模拟一次「核心发版」，验收 npm 核心包更新，不需要真的发布到 npm。
//
//   npm run stage:core && npm run dist && node scripts/update-flow-demo.mjs
//
// 做三件事：
// 1. 用 release/core-stage 打一份比当前高一个版本的假核心 tarball，放进 release/test-release/
// 2. 在 8899 起一个假的 npm registry（元数据 + tarball），客户端用 DSH_CORE_REGISTRY 指过来
// 3. 把 electron-builder 产出的安装目录复制成 release/test-install，并预置一份 core/current
//    （安装包里不再带核心，第一次启动会去 npm 取；预置是为了从「已装核心」开始演示更新）
//
// 然后按打印出来的命令启动测试安装：管理器里点更新，走
// 查 npm 元数据 → 下载 tarball → sha512 校验 → 解压 → 替换 core/current → 重启外壳。
// APPDATA 指到 test-install/userdata，测试不会碰本机真实的 DSH 数据。

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buildCorePackage } from './pack-core.mjs'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const TEST_RELEASE = join(RELEASE, 'test-release')
const TEST_INSTALL = join(RELEASE, 'test-install')
const PORT = 8899
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
// 假版本要比当前高，更新检查才会认为「有新版本」；rc 版跟着 rc 通道走
const NEXT = /-rc\.(\d+)$/.test(CURRENT)
  ? CURRENT.replace(/-rc\.(\d+)$/, (_, n) => `-rc.${Number(n) + 1}`)
  : CURRENT.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c) => `${a}.${b}.${Number(c) + 1}`)
const IS_MAC = process.platform === 'darwin'
const APP = join(RELEASE, 'core-stage')
const USER_DATA = join(TEST_INSTALL, 'userdata')
const TEST_APP = IS_MAC ? join(TEST_INSTALL, 'DSH-X.app') : join(TEST_INSTALL, 'DSH.exe')
const LAUNCH = IS_MAC ? join(TEST_APP, 'Contents', 'MacOS', 'DSH') : TEST_APP
const electronVersion = JSON.parse(await readFile(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const PACKAGE = process.env.DSH_CORE_PACKAGE || 'dsh-x-core'

let metadata = null
let tarballName = ''

async function buildAssets() {
  if (!existsSync(join(APP, 'server.js'))) throw new Error(`缺少 ${APP}，先跑 npm run stage:core`)
  rmSync(TEST_RELEASE, { recursive: true, force: true })
  await mkdir(TEST_RELEASE, { recursive: true })
  const core = await buildCorePackage({ appDir: APP, version: NEXT, outDir: TEST_RELEASE, name: PACKAGE, electronVersion })
  tarballName = basename(core.tgzPath)
  metadata = {
    name: PACKAGE,
    // 正式版和 rc 都挂上去：客户端按当前核心版本所在通道查
    'dist-tags': { latest: NEXT, rc: NEXT, alpha: NEXT },
    versions: {
      [NEXT]: {
        name: PACKAGE,
        version: NEXT,
        dist: {
          tarball: `http://127.0.0.1:${PORT}/${tarballName}`,
          integrity: core.integrity,
          shasum: core.shasum,
          unpackedSize: 0,
        },
        dshX: { electron: electronVersion },
      },
    },
  }
  console.log(`假核心包：${tarballName}（${(core.size / 1048576).toFixed(1)} MB，版本 ${NEXT}）`)
}

function serve() {
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(String(req.url || '/').split('?')[0]))
    if (name === PACKAGE) {
      const body = Buffer.from(JSON.stringify(metadata))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
      res.end(body)
      return
    }
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
  server.listen(PORT, '127.0.0.1', () => console.log(`假 npm registry：http://127.0.0.1:${PORT}/`))
  return server
}

async function prepareInstall() {
  if (!existsSync(join(APP, 'server.js'))) throw new Error(`缺少 ${APP}，先跑 npm run stage:core`)
  rmSync(TEST_INSTALL, { recursive: true, force: true })
  await mkdir(TEST_INSTALL, { recursive: true })
  if (IS_MAC) {
    const bundle = ['mac-arm64', 'mac', 'mac-x64']
      .map((name) => join(RELEASE, 'eb', name, 'DSH-X.app'))
      .find((path) => existsSync(join(path, 'Contents', 'MacOS', 'DSH')))
    if (!bundle) throw new Error('找不到 electron-builder 产出的 DSH-X.app')
    const result = spawnSync('ditto', [bundle, TEST_APP], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('ditto 复制 .app 失败')
  } else {
    const built = join(RELEASE, 'eb', 'win-unpacked')
    if (!existsSync(join(built, 'DSH.exe'))) throw new Error('找不到 electron-builder 产出的 win-unpacked')
    await cp(built, TEST_INSTALL, { recursive: true })
  }
  await mkdir(USER_DATA, { recursive: true })
  // 安装包里没有核心（第一次启动会去 registry 取）；预置一份当「当前版本」，才能演示更新
  await cp(APP, join(USER_DATA, 'DSH', 'core', 'current'), { recursive: true })
  console.log(`测试安装目录：${TEST_INSTALL}`)
  console.log(`测试用户数据：${USER_DATA}（预置核心 ${CURRENT}）`)
}

await buildAssets()
const server = serve()
await prepareInstall()
const shellVersion = JSON.parse(readFileSync(join(ROOT, 'shell', 'package.json'), 'utf8')).version
const envPrefix = IS_MAC ? `HOME="${USER_DATA}"` : `APPDATA="${USER_DATA}"`
console.log('')
console.log(`启动测试安装（核心 ${CURRENT}，外壳 ${shellVersion}），管理器里点更新应看到核心 ${NEXT}：`)
console.log(`  ${envPrefix} DSH_CORE_REGISTRY=http://127.0.0.1:${PORT} "${LAUNCH}"`)
console.log('')
console.log(`点「更新到 ${NEXT}」：查 npm 元数据 → 下载核心 tarball → sha512 校验 → 替换 core/current → 重启外壳。`)
console.log('外壳版本不变，所以不会下载完整安装包；Electron 版本变化时才需要更新外壳。')
console.log('测试完 Ctrl+C 结束本地 registry。')
void server
