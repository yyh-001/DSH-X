import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('外壳不依赖核心模块，核心目录在运行时解析', () => {
  const main = read('shell/main.mjs')
  assert.doesNotMatch(main, /from '\.\.\/platform\.js'/, '外壳不再顶层 import 核心的 platform.js')
  assert.doesNotMatch(main, /from '\.\.\/filemanager\.js'/, '外壳不再顶层 import 核心的 filemanager.js')
  assert.match(main, /DSH_CORE_DIR/, 'CLI 用 DSH_CORE_DIR 指定核心')
  assert.match(main, /core', 'current'/, '安装版优先加载用户目录的 core/current')
  assert.match(main, /DSH_CORE = '1'/, '加载核心前标成打包态')
  assert.match(main, /pathToFileURL\(join\(coreDir, 'server\.js'\)\)/, '动态 import 核心的 server.js')
  assert.match(main, /TRAY_ICON_FILE.*tray\.ico/s, 'Windows 托盘用带圆角的 tray.ico，不用方形 icon.png')
})

test('核心更新换的是用户目录 core/current，不再碰 resources/app', () => {
  const server = read('src/server.js')
  assert.match(server, /join\(APP_DIR, 'core', 'current'\)/)
  assert.match(server, /fileManager\.samePath\(ROOT, activeCore\)/, '已经在 core/current 时走原地替换助手')
  assert.match(server, /writeFileSync\(pending/, '首次换核心写 pending 标记，外壳启动失败可回退')
  assert.doesNotMatch(server, /chmodSync\(script, 0o755\)[\s\S]{0,200}MAC_APP_SWAP_SCRIPT/, '核心更新不再重签 mac 包')
})

test('构建把外壳和核心分成两个 stage，安装包用 extraResources 带基线核心', () => {
  const pack = read('scripts/pack.mjs')
  assert.match(pack, /shell-stage/)
  assert.match(pack, /core-stage/)
  assert.match(pack, /name: 'dsh-x-core'/, '核心包跨平台，只有一个名字')
  assert.match(pack, /main: 'server\.js'/, '核心 package.json 指向 server.js')
  assert.match(pack, /main: 'shell\/main\.mjs'/, '外壳 package.json 指向 shell/main.mjs')
  const builder = read('electron-builder.config.mjs')
  assert.match(builder, /app: 'release\/shell-stage'/)
  assert.match(builder, /from: 'release\/core-stage', to: 'core'/)
  assert.match(builder, /target: 'AppImage'/, 'Linux 出 AppImage')
  assert.match(builder, /minimumSystemVersion: '13\.0'/, 'macOS 最低版本跟 Electron 44（Chromium 152）对齐')
  const core = read('scripts/pack-core.mjs')
  assert.match(core, /release', 'core-stage'/)
  assert.match(core, /main: 'server\.js'/)
  assert.match(core, /'dsh-x-core'/, 'pack-core 默认包名跨平台')
  const common = read('scripts/pack-common.mjs')
  assert.match(common, /filemanager-windows\.js/)
  assert.match(common, /filemanager-mac\.js/)
  assert.match(common, /filemanager-linux\.js/)
})

test('外壳版本和核心版本分开：shell/package.json + 关于页显示两行', () => {
  const shell = JSON.parse(read('shell/package.json'))
  const root = JSON.parse(read('package.json'))
  assert.ok(shell.version, 'shell/package.json 有外壳版本')
  assert.ok(root.version, '根 package.json 是核心版本')
  const html = read('src/public/index.html')
  assert.match(html, /id="aboutShellVersion"/)
  assert.match(html, /data\.shell\?\.current/, '关于页从 /api/self 回填外壳版本')
  assert.match(html, /DSH-X 核心/, '核心和外壳在更新弹窗里分开显示')
})

test('npm CLI 带着外壳启动，核心目录通过 DSH_CORE_DIR 传入', () => {
  const bin = read('npm-package/bin/dsh-x.mjs')
  assert.match(bin, /DSH_CORE_DIR: core\.dir/)
  assert.match(bin, /spawn\(electron, \[appRoot\]/)
  const pack = read('scripts/pack-npm.mjs')
  assert.match(pack, /join\(ROOT, 'shell'\)/)
  assert.match(pack, /shell\/main\.mjs/)
  assert.match(pack, /shellPkg\.version/, 'CLI 版本跟外壳走')
  assert.match(read('npm-package/lib/core.mjs'), /'dsh-x-core'/, 'npm 版下载跨平台核心包')
})
