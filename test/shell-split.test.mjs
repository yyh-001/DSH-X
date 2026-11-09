import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { coreSetupPage, coreSetupPaintScript } from '../shell/pages.mjs'

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

test('构建把外壳和核心分成两个 stage，安装包只带外壳', () => {
  const pack = read('scripts/pack.mjs')
  assert.match(pack, /shell-stage/)
  assert.match(pack, /core-stage/)
  assert.match(pack, /name: 'dsh-x-core'/, '核心包跨平台，只有一个名字')
  assert.match(pack, /main: 'server\.js'/, '核心 package.json 指向 server.js')
  assert.match(pack, /main: 'shell\/main\.mjs'/, '外壳 package.json 指向 shell/main.mjs')
  const builder = read('electron-builder.config.mjs')
  assert.match(builder, /app: 'release\/shell-stage'/)
  assert.doesNotMatch(builder, /extraResources/, '安装包不再带 resources/core')
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

test('外壳第一次启动从 npm 取核心，挑和当前 Electron 兼容的版本', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /from '\.\/core-fetch\.mjs'/)
  assert.match(main, /await setupCore\(\)/, 'current 缺失时先下载核心再启动')
  assert.match(main, /pickCoreRelease\(metadata, \{[\s\S]*?electron: process\.versions\.electron/, '挑兼容版本，不盲拿 dist-tag 头部')
  assert.match(main, /previous: PREVIOUS_CORE/, '换核心前把旧的留一份，起不来能回滚')
  assert.match(main, /async function setupCore\(\)[\s\S]*?writeFileSync\(join\(APP_DIR, 'core', 'pending'\)[\s\S]*?return ACTIVE_CORE/,
    '首启装好的核心也写 pending：起不来时 recoverCore 才能记下坏版本，不会下载同一版死循环')
  assert.match(main, /skip: failedCoreVersions\(\)/, '起不来的版本按列表跳过，两个坏版本不会来回转')
  assert.doesNotMatch(main, /resources\/core/, '安装包里不再有基线核心')
  const fetchCore = read('shell/core-fetch.mjs')
  assert.match(fetchCore, /registry\.npmmirror\.com[\s\S]*?registry\.npmjs\.org/, '镜像优先，失败退回官方')
  assert.match(fetchCore, /sha512/, '下载后校验 integrity')
  assert.match(fetchCore, /--strip-components=1/, '解压剥掉 npm tarball 的 package/ 层')
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
  assert.match(read('npm-package/lib/core.mjs'), /shell\/core-fetch\.mjs/, 'CLI 复用外壳那套核心获取逻辑')
  assert.match(read('shell/core-fetch.mjs'), /'dsh-x-core'/, '核心包名跨平台，只有一个')
})

test('首启下载页：实时进度与下载源，总大小未知时走不确定态', () => {
  const zh = coreSetupPage('zh')
  for (const id of ['hint', 'track', 'bar', 'detail', 'source']) {
    assert.match(zh, new RegExp(`id="${id}"`), `下载页缺少 #${id}`)
  }
  assert.match(zh, /is-indeterminate/, '总大小未知时进度条要滑动，不能停在 0%')
  assert.match(zh, /html, body \{[^}]*overflow: hidden/, '页面禁止滚动，窗口右侧不能冒出滚动条')
  assert.match(zh, /正在连接下载源/)
  assert.doesNotMatch(zh, /取消/, '首启窗口不放取消按钮')
  const en = coreSetupPage('en')
  assert.match(en, /Contacting the download source/)

  const main = read('shell/main.mjs')
  assert.match(main, /width: 480,[\s\S]{0,40}height: 280/, '窗口要放得下整页内容，别靠滚动条')
  assert.match(main, /paintCoreSetup\(/, '进度统一走节流绘制')
  assert.match(main, /coreSetupPaintAt/, '每个 chunk 都跨进程执行会让窗口发卡')
  assert.match(main, /下载源：/, '窗口要显示实际下载源')
  assert.match(main, /timeoutMs: index === 0 \? 6_000/, '慢镜像 6 秒就换官方源')
  assert.match(main, /tarballFor\(alternate/, 'tarball 下载失败换源重试')
  assert.match(main, /await paint\(\{ phase \}, \{ immediate: true \}\)/, '解压前同步画「安装中」')
  assert.match(main, /const percent = extracting \? 100 :/, '解压时进度条保持满格，别看起来从 0 重来')
  assert.match(main, /indeterminate: !extracting && !known/, '解压阶段不要切回不确定态')
  assert.match(main, /setTimeout\(resolve, 80\)/, '解压前留一帧，窗口别停在 100% 就消失')
  assert.match(main, /1_200 - \(Date\.now\(\) - shownAt\)/, '网快时窗口至少留 1.2 秒，别一闪而过')
  assert.match(read('shell/core-fetch.mjs'), /await onPhase\?\.\('extract'\)/, '解压阶段回调要 await')
})

test('下载窗口注入脚本必须是合法 JS，并能更新进度/来源', () => {
  const nodes = {
    bar: { style: {} },
    track: { classList: { value: null, toggle(name, on) { this.value = [name, on] } } },
    hint: { textContent: '' },
    detail: { textContent: '' },
    source: { textContent: '' },
  }
  const document = { getElementById: (id) => nodes[id] }
  const script = coreSetupPaintScript({ percent: 42, indeterminate: false, hint: '下载中', detail: '1.0 MB / 2.0 MB · 50%', source: '下载源：example.test' })
  // 解析失败会直接抛 SyntaxError（曾因为 bar.style.width = 50% 少引号整段被空 catch 吞掉）
  assert.doesNotThrow(() => new Function('document', script))
  new Function('document', script)(document)
  assert.equal(nodes.bar.style.width, '42%')
  assert.deepEqual(nodes.track.classList.value, ['is-indeterminate', false])
  assert.equal(nodes.hint.textContent, '下载中')
  assert.equal(nodes.detail.textContent, '1.0 MB / 2.0 MB · 50%')
  assert.equal(nodes.source.textContent, '下载源：example.test')
  // 总大小未知：不确定态 + 百分号仍被正确引起来
  const unknown = coreSetupPaintScript({ percent: 0, indeterminate: true, hint: 'h', detail: '已下载 0.5 MB' })
  new Function('document', unknown)(document)
  assert.equal(nodes.bar.style.width, '0%')
  assert.deepEqual(nodes.track.classList.value, ['is-indeterminate', true])
})
