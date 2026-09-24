import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
  assert.match(html, /可更新到 \{latest\}/, 'meta 里写出可更新到的版本')
  assert.match(html, /class="plugin-update"[^>]*data-update=/, '可更新的行有更新按钮')
  // 整行是个 label，点哪都会开关插件；按钮的点击必须拦住，不能顺带把插件关了
  assert.match(html, /data-update[\s\S]{0,600}?event\.preventDefault\(\)[\s\S]{0,80}?event\.stopPropagation\(\)/, '更新按钮要挡住 label 的默认行为')
  assert.match(html, /pluginUpdateAllEl\.textContent = t\('全部更新（\{n\}）', \{ n: pending \}\)/, '全部更新带上可更新的个数')
  assert.match(html, /post\('\/api\/plugins\/update', \{ all: true \}\)/, '全部更新走同一个接口的 all 分支')
  assert.match(html, /重启 dsh 后生效/, '要提醒重启才生效（插件是启动时加载的）')
})
