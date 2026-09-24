import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parsePnpmProgress } from '../registry.js'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')

// 插件更新：查的是 registry 上真实的最新版，升级复用 addPlugin（装和升同一条路）。
// 这几条钉的都是「容易在重构里悄悄丢掉的意图」，不是实现细节。

test('更新检查跳过官方组件，且不盲信 dist-tags 的最新', () => {
  assert.match(server, /url\.pathname === '\/api\/plugins\/updates'/, '查更新有独立接口')
  assert.match(server, /plugins\.filter\(\(plugin\) => !plugin\.official\)/, '官方组件（@deepseek-ai/*）不参与更新检查')
  assert.match(server, /const \{ versions, tags \} = await listPackage\(plugin\.name\)/, '走 registry 的版本列表')
  // 插件多是预发布版，dist-tags.latest 可能指向更旧的稳定版，必须按版本号比
  assert.match(server, /cmpVer\(parseVer\(latest\), parseVer\(plugin\.version\)\)/, '按版本号判断有没有更新')
})

test('装完回读磁盘确认版本真的换了，失败要说清', () => {
  assert.match(server, /async function updatePlugin\(name, \{ latest = '' \} = \{\}\)/)
  assert.match(server, /await addPlugin\(await pluginCommandVersion\(\), `\$\{name\}@\$\{target\}`\)/, '升级复用 addPlugin')
  assert.match(server, /const after = listPlugins\(profileDir\(\)\)\.plugins\.find/, '装完回读 profile 清单')
  assert.match(server, /不是 \$\{target\}（看终端日志/, '版本没换要报出来，而不是看成成功')
  assert.match(server, /pluginUpdateCache\.at = 0/, '更新完让下次检查重新拉')
})

test('全部更新逐个来：单个失败不影响其它，最后如实汇总', () => {
  assert.match(server, /async function updateAllPlugins\(\)/)
  assert.match(server, /failed\.push\(\{ name, error:/, '失败的插件要记下来')
  assert.match(server, /return \{ checked: names\.length, done, failed \}/)
})

test('插件页有检查/全部更新入口，行内按钮不会误触发开关', () => {
  assert.match(html, /id="pluginCheckUpdates"/, '面板上有「检查更新」')
  assert.match(html, /id="pluginUpdateAll"/, '有「全部更新」')
  // 列表保持两行，更新按钮本身说明目标版本，不重复放状态标签。
  assert.match(html, /t\('更新到 \{latest\}', \{ latest: update\.latest \}\)/, '按钮上写清更新到哪版')
  assert.match(html, /class="plugin-update"[^>]*data-update=/, '可更新的行有更新按钮')
  // 整行是个 label，点哪都会开关插件；按钮的点击必须拦住，不能顺带把插件关了
  assert.match(html, /data-update[\s\S]{0,600}?event\.preventDefault\(\)[\s\S]{0,80}?event\.stopPropagation\(\)/, '更新按钮要挡住 label 的默认行为')
  assert.match(html, /pluginUpdateAllEl\.textContent = t\('全部更新（\{n\}）', \{ n: pending \}\)/, '全部更新带上可更新的个数')
  assert.match(html, /post\('\/api\/plugins\/update', \{ all: true \}\)/, '全部更新走同一个接口的 all 分支')
  assert.match(html, /重启 dsh 后生效/, '要提醒重启才生效（插件是启动时加载的）')
})

test('插件装/升级的进度：认得出 pnpm 的输出，也认百分比', () => {
  const state = { resolved: 0, reused: 0, downloaded: 0, added: 0, total: 0 }
  // 「要装多少个」只是给了分母，等 Progress 行再出进度
  assert.equal(parsePnpmProgress('Packages: +123', state), null)
  assert.equal(state.total, 123, '分母要记住')
  // 还在解析依赖图：没有确定的分母，交给页面用饱和曲线
  assert.deepEqual(parsePnpmProgress('Progress: resolved 5, reused 0, downloaded 0, added 0', state), { phase: 'resolve', done: 5 })
  // 开始写 node_modules：用「要装多少个」当分母，是真比例
  assert.deepEqual(
    parsePnpmProgress('Progress: resolved 123, reused 40, downloaded 3, added 12', state),
    { phase: 'download', done: 12, total: 123 },
  )
  assert.deepEqual(
    parsePnpmProgress('Progress: resolved 123, reused 40, downloaded 3, added 123, done', state),
    { phase: 'download', done: 123, total: 123 },
  )
  // 无关的输出（含 npm 那套的行）不能被误认，否则进度条会乱跳
  assert.equal(parsePnpmProgress('Done in 5.2s', state), null)
  assert.equal(parsePnpmProgress('http fetch GET 200 https://registry/x/-/y.tgz', state), null)
})

test('插件页有独立进度条，并按 kind 与装 dsh 的那条分开', () => {
  assert.match(html, /<div class="progress" id="pluginProgress" hidden><div class="progress-bar" id="pluginProgressBar"><\/div><\/div>/, '插件页要有自己的进度条')
  assert.match(html, /if \(data\?\.kind === 'plugin'\) \{[\s\S]{0,160}?setPluginProgress\(Boolean\(pluginProgress\)\)/, '插件进度事件走插件页那条')
  // 峰值与相位记在条子自己身上，两条条子互不干扰
  assert.match(html, /wrap\.dataset\.max = String\(max\)/)
  assert.match(html, /paintProgress\(document\.getElementById\('pluginProgress'\), document\.getElementById\('pluginProgressBar'\)/, '两条条子共用同一套画法')
})

test('服务端在插件操作期间发进度，结束时收掉', () => {
  assert.match(server, /function emitPluginProgress\(state\) \{/, '有专门的发进度函数')
  assert.match(server, /kind: 'plugin', name: pluginProgressName/, '事件要带 kind 和插件名')
  assert.match(server, /const progress = parsePnpmProgress\(text, progressState\)/, 'runPluginCommand 里解析 pnpm 输出')
  assert.match(server, /pluginProgressName = pkg\s*\n\s*emitPluginProgress\(\{ phase: 'resolve' \}\)/, '开始时就摆出进度条')
  assert.match(server, /emitPluginProgress\(null\)/, '结束时收掉（成功失败都要收）')
})
