/**
 * 桌面增强：三个首方插件跟着启动项走（新建时勾选、编辑时按 profile 回显并可补装）。
 *
 * 和以前「设置页一键安装」的区别：入口在启动项弹窗里，装到哪个 profile 由启动项决定，
 * 构建隔离环境时顺手带上。这里按仓库惯例做结构检查（真装插件要跑 pnpm，单测不碰网络）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const server = read('src/server.js')
const page = read('src/public/index.html')
const css = read('src/public/launcher.css')
const settings = read('src/settings.js')

test('启动不再自动补装任何插件', () => {
  assert.doesNotMatch(server, /ensureDesktopPlugins/, '启动路径里没有自动安装')
  assert.doesNotMatch(server, /desktopPluginsToInstall/, '不再按启动版本算缺装')
})

test('插件列表里以一组「整合包」显示（合成记录，不碰真实安装记录）', () => {
  assert.match(server, /DESKTOP_ENHANCE_ID/, '合成包 id 只写一处')
  assert.match(server, /synthetic: true/, '借记录做分组，不是真安装记录')
  assert.match(server, /selector\?\.pack === DESKTOP_ENHANCE_ID/, '整组开关认这个 id')
  assert.match(page, /record && !record\.synthetic/, '合成组不显示卸载按钮')
  assert.match(page, /records\.filter\(\(record\) => !record\.synthetic\)\.at\(-1\)/, '「最近安装」只算真实记录')
})

test('安装 / 卸载两条路由：只动缺的或装了的那几个，版本不对的给失败信息', () => {
  assert.match(server, /url\.pathname === '\/api\/desktop-enhance\/install'/)
  assert.match(server, /async function installDesktopEnhance\(profile = PROFILE_NAME, version = ''\)/)
  assert.match(server, /const wanted = desktopEnhanceMissing\(profile\)/)
  assert.match(server, /await addPlugin\(ver, `\$\{plugin\.name\}@\$\{plugin\.spec\}`, \{ profile \}\)/, '装法和插件页同一条链路')
  assert.match(server, /versionAtLeast\(ver, plugin\.minDsh\)/, '内核版本不够时跳过并报原因')
  assert.match(server, /desktopEnhance: desktopEnhanceSummary\(profile\)/, '响应里带安装进度')
  assert.match(server, /url\.pathname === '\/api\/desktop-enhance\/uninstall'/, '一键卸载路由')
  assert.match(server, /runPluginCommand\(version, \['remove', plugin\.name\]/, '走 dsh plugin remove')
  assert.match(server, /removeBundleMounted\(profileDirOf\(profile\), \[plugin\.name\]\)/, '同时从层栈摘掉')
})

test('启动项保存后补装，编辑时可以单独查这个 profile 装了几个', () => {
  // 写锁放掉之后再装：装插件慢不该卡住别的启动项编辑。
  assert.match(server, /body\.desktopEnhance === true/)
  assert.match(server, /saved\.desktopEnhance = await launchScope\.run\(\{ home \}, \(\) => installDesktopEnhance\(saved\.entry\.profile\)\)/)
  // 状态接口按 profile 查，home 走 x-dsh-home 头（会话隔离/项目环境也能读对）。
  assert.match(server, /req\.method === 'GET' && url\.pathname === '\/api\/desktop-enhance'/)
  assert.match(server, /missing: desktopEnhanceMissing\(profile\)\.map\(\(plugin\) => plugin\.name\)/)
})

test('启动项弹窗：开关 + 说明 + 保存时带上；设置页那块已经撤掉', () => {
  assert.match(page, /id="launchDesktopEnhance" type="checkbox"/)
  assert.match(page, /data-i18n="桌面增强">桌面增强/)
  assert.match(page, /id="launchDesktopEnhanceHint"/)
  // 说明不占一行：收进标题旁的问号，悬停/聚焦才显示
  assert.match(page, /class="launch-enhance-help"[\s\S]{0,160}>\?<\/span>/)
  assert.match(page, /class="launch-enhance-tip"[\s\S]{0,220}下次启动时加载/)
  assert.match(css, /\.launch-enhance-help:hover \+ \.launch-enhance-tip/)
  assert.doesNotMatch(page, /function launchDesktopEnhanceHintText/)
  // 新建一律不勾；编辑只看 profile 实际装没装（装齐了就勾上），界面上不写「已安装 x/3」
  const pageLf = page.replace(/\r\n/g, '\n')
  assert.match(pageLf, /launchDesktopEnhanceEl\.checked = false\n      launchDesktopEnhanceHintEl\.textContent = ''/)
  assert.match(page, /if \(entry\) void refreshLaunchDesktopEnhance\(entry\)/)
  assert.match(page, /function refreshLaunchDesktopEnhance\(entry\)/)
  assert.match(page, /getJson\(`\/api\/desktop-enhance\?profile=\$\{encodeURIComponent\(entry\.profile\)\}`/)
  assert.doesNotMatch(page, /已安装 \{installed\}/, '安装数不再写进界面')
  assert.doesNotMatch(page, /正在读取安装状态/)
  // 保存只发一个布尔；取消勾选不会卸载，服务端只补缺的
  assert.match(page, /desktopEnhance: launchDesktopEnhanceEl\.checked/)
  assert.match(page, /data\.desktopEnhance\?\.failed/)
  // 旧设置页入口整套撤掉：按钮、说明行、转圈样式
  assert.doesNotMatch(page, /id="desktopEnhanceInstall"/)
  assert.doesNotMatch(page, /id="desktopEnhanceHint"/)
  assert.doesNotMatch(css, /#desktopEnhanceInstall/)
  // 设置接口不再回显当前 profile 的进度（状态改由启动项弹窗按 profile 查）
  assert.doesNotMatch(server, /desktopEnhance: desktopEnhanceSummary\(\),/)
  const dict = new Function(`return (${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`)()
  for (const key of [
    '桌面增强', '正在保存并安装桌面增强…',
    '启动项已保存，但桌面增强有 {n} 个没装上：{error}',
    '保存时把官方插件（原生通知、侧栏浏览器）装进这个环境；下次启动时加载，正在运行的环境重启后生效。',
  ]) {
    assert.ok(dict[key], `「${key}」有英文`)
  }
})

test('桌面增强不再记住上次的勾选：设置里没有这个键，新建永远从「不勾」开始', () => {
  assert.doesNotMatch(settings, /launchDesktopEnhance/, '设置里不再存这个默认值')
  assert.doesNotMatch(server, /launchDesktopEnhance: stored/)
  assert.doesNotMatch(page, /launchDesktopEnhanceSaved/, '页面上也不再有「上次的勾选」')
  assert.doesNotMatch(page, /queueSetting\('launchDesktopEnhance'/, '勾选不再写回设置')
  assert.match(page, /\/\/ 桌面增强：新建一律不勾/, '新建固定不勾')
})

test('右键菜单 / 浏览器控制不再有独立开关：只有安装 + 插件页开关', () => {
  assert.doesNotMatch(settings, /contextMenu/, '设置里没有右键菜单键')
  assert.doesNotMatch(settings, /browserControl/, '设置里没有浏览器总开关')
  assert.doesNotMatch(page, /data-category="browser"/, '浏览器控制不再是独立分类')
  assert.doesNotMatch(page, /id="contextMenu"/, '右键菜单开关已撤')
})
