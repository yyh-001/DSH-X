import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parsePnpmProgress } from '../src/registry.js'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
const envPage = readFileSync(fileURLToPath(new URL('../src/public/environments-page.js', import.meta.url)), 'utf8')
/** 页面里的一段：从 from 到 to（不含）。 */
const slice = (source, from, to) => {
  const start = source.indexOf(from)
  assert.ok(start >= 0, `找不到起点：${from}`)
  const end = source.indexOf(to, start)
  assert.ok(end > start, `找不到终点：${to}`)
  return source.slice(start, end)
}

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
  assert.match(server, /async function updatePlugin\(name, \{ latest = '', profile = PROFILE_NAME \} = \{\}\)/)
  assert.match(server, /await addPlugin\(await pluginCommandVersion\(profile\), `\$\{name\}@\$\{target\}`, \{ profile \}\)/, '升级复用 addPlugin，并定向到目标 profile')
  assert.match(server, /const after = listPlugins\(profileDirOf\(profile\)\)\.plugins\.find/, '装完回读同一 profile 清单')
  assert.match(server, /不是 \$\{target\}（看终端日志/, '版本没换要报出来，而不是看成成功')
  assert.match(server, /pluginUpdateCache\.at = 0/, '更新完让下次检查重新拉')
})

test('全部更新逐个来：单个失败不影响其它，最后如实汇总', () => {
  assert.match(server, /async function updateAllPlugins\(profile = PROFILE_NAME\)/)
  assert.match(server, /failed\.push\(\{ name, error:/, '失败的插件要记下来')
  assert.match(server, /return \{ checked: names\.length, done, failed \}/)
})

test('更新入口：配置页不再更新插件；「升级插件」在实例页插件卡片顶上那栏，一次升整个实例', () => {
  // 插件清单属于实例：配置页只管开关和数据（设计：配置只保留数据和插件设置）。检查更新、逐个「更新到 x」、
  // 「更新 N 个」/ 分组更新都不在配置页；实例页的「升级插件」不跟随上游，把实例里的插件逐个升到最新
  assert.ok(!/id="pluginCheckUpdates"/.test(html), '不再有单独的「检查更新」按钮')
  assert.ok(!/id="pluginUpdateAll"/.test(html), '不再有单独的「全部更新」按钮')
  assert.ok(!/id="pluginRefresh"/.test(html), '插件页顶部的刷新按钮也撤了')
  assert.doesNotMatch(html, /data-pack-check-updates|class="plugin-update"|data-update=/, '配置详情里没有检查更新、逐个更新的按钮')
  assert.doesNotMatch(html, /\/api\/plugins\/updates?['?`]/, '配置页不调插件的查更新 / 更新接口')
  assert.doesNotMatch(html, /\/api\/packs\/update|data-pack-update|data-group-update/, '没有「更新 N 个」和分组更新，也不调整合包更新接口')
  assert.doesNotMatch(server, /url\.pathname === '\/api\/packs\/update'/, '服务端的整合包更新接口也撤了')
  const bar = slice(html, '<form class="environment-plugin-bar" id="environmentAddForm">', '</form>')
  assert.match(bar, /<button class="ghost icon-btn" id="environmentUpgrade" type="button" title="升级插件" aria-label="升级插件"/, '升级插件是插件卡片顶上那栏的图标按钮')
  assert.match(envPage, /el\.upgrade\.onclick = \(\) => \{[\s\S]{0,120}?post\('\/api\/environments\/plugins\/upgrade', \{ id: env\.id \}\)/, '按当前打开的实例升')
  // 升完把结果说清：升了哪些（从哪版到哪版）、哪些没升成
  assert.match(envPage, /`\$\{item\.name\} \$\{item\.from\} → \$\{item\.to\}`/)
  assert.match(envPage, /notify\(done \|\| t\('都已经是最新版本'\), t\('升级结果'\), failed\)/)
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

test('插件进度事件：配置页没有行内进度了，只给配置备份回退时的依赖重装画进度条', () => {
  assert.doesNotMatch(html, /class="plugin-row-progress"|function setPluginProgress\(/, '插件行不再有更新进度')
  assert.match(html, /if \(data\?\.kind === 'plugin'\) \{\s*pluginProgress = !data \|\| data\.phase === 'idle' \? null : data\s*paintBackupProgress\(\)/)
  assert.match(html, /const progress = pluginProgress && pluginProgress\.profile === backupProfile \? pluginProgress : null/, '只画正在回退的那个配置的进度')
})

test('服务端在插件操作期间发进度，结束时收掉', () => {
  assert.match(server, /function emitPluginProgress\(state\) \{/, '有专门的发进度函数')
  assert.match(server, /\{ \.\.\.state, kind: 'plugin', name: pluginProgressName, profile: pluginProgressProfile \}/, '事件要带 kind、插件名和 profile')
  assert.match(server, /const progress = parsePnpmProgress\(text, progressState\)/, 'runPluginCommand 里解析 pnpm 输出')
  assert.match(server, /pluginProgressName = pkg\s*\n\s*pluginProgressProfile = profile\s*\n\s*emitPluginProgress\(\{ phase: 'resolve' \}\)/, '开始时就绑定插件名与 profile')
  assert.match(server, /emitPluginProgress\(null\)/, '结束时收掉（成功失败都要收）')
})

test('插件行：配置页那行只有开关；实例页那行没有开关，「移除」贴在插件右边、官方组件不给', () => {
  const profileRow = slice(html, 'function pluginRowHtml(', 'function bindPluginRowEvents(')
  assert.match(profileRow, /<input type="checkbox" data-plugin=/, '配置页的插件行是开关')
  assert.doesNotMatch(profileRow, /plugin-update|plugin-remove|data-update|data-remove/, '配置页的插件行没有更新、卸载按钮')
  const instanceRow = slice(envPage, '  function pluginRow(plugin) {', '  function paintUpstream(')
  assert.doesNotMatch(instanceRow, /type="checkbox"/, '实例页的插件行不是开关：开关在配置页')
  assert.match(instanceRow, /plugin\.official \? '' : `<button class="ghost" type="button" data-remove-plugin="\$\{escapeHtml\(plugin\.name\)\}"/, '第三方插件带「移除」，官方组件没有')
})
