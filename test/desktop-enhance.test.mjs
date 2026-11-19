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

test('桌面增强已迁入「加入插件」弹窗：编辑启动项与设置页均不再放开关或单独按钮', () => {
  assert.doesNotMatch(server, /body\.desktopEnhance === true/, '保存启动项不再触发补装桌面增强')
  assert.match(server, /url\.pathname === '\/api\/plugin-market'/, '提供插件市场索引查询与桌面增强清单')
  // 状态接口仍保留，方便外部或兼容路径按 profile 查询
  assert.match(server, /req\.method === 'GET' && url\.pathname === '\/api\/desktop-enhance'/)
  assert.match(server, /missing: desktopEnhanceMissing\(profile\)\.map\(\(plugin\) => plugin\.name\)/)

  assert.doesNotMatch(page, /id="launchDesktopEnhance"/)
  assert.doesNotMatch(page, /id="launchDesktopEnhanceField"/)
  assert.doesNotMatch(page, /id="desktopEnhanceInstall"/)
  assert.doesNotMatch(page, /id="desktopEnhanceHint"/)
  assert.doesNotMatch(css, /#desktopEnhanceInstall/)
  assert.doesNotMatch(css, /#launchDesktopEnhanceField/)
  assert.doesNotMatch(server, /desktopEnhance: desktopEnhanceSummary\(\),/)

  assert.match(page, /id="environmentAddSearch"/)
  assert.match(page, /id="environmentAddCategories"/)
  assert.match(page, /id="environmentAddMarket"/)
  const envPage = read('src/public/environments-page.js')
  assert.match(envPage, /dsh-x-desktop-notify/)
  assert.match(envPage, /dsh-x-sidebar-browser/)
  assert.match(envPage, /dsh-x-computer-use/)
  assert.match(envPage, /\/api\/plugin-market/)
  assert.doesNotMatch(envPage, /data-market-toggle/, '加入插件弹窗只负责安装，不放开关')
})

test('桌面增强不再记住上次的勾选：设置里没有这个键，新建永远从「不勾」开始', () => {
  assert.doesNotMatch(settings, /launchDesktopEnhance/, '设置里不再存这个默认值')
  assert.doesNotMatch(server, /launchDesktopEnhance: stored/)
  assert.doesNotMatch(page, /launchDesktopEnhanceSaved/, '页面上也不再有「上次的勾选」')
  assert.doesNotMatch(page, /queueSetting\('launchDesktopEnhance'/, '勾选不再写回设置')
  assert.doesNotMatch(page, /launchDesktopEnhanceEl/, '编辑窗不再保留桌面增强勾选框')
})

test('右键菜单 / 浏览器控制不再有独立开关：只有安装 + 插件页开关', () => {
  assert.doesNotMatch(settings, /contextMenu/, '设置里没有右键菜单键')
  assert.doesNotMatch(settings, /browserControl/, '设置里没有浏览器总开关')
  assert.doesNotMatch(page, /data-category="browser"/, '浏览器控制不再是独立分类')
  assert.doesNotMatch(page, /id="contextMenu"/, '右键菜单开关已撤')
})
