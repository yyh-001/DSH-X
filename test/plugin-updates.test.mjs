import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { parsePnpmProgress } from '../src/registry.js'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')

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

test('更新入口：检查更新在 Profile 详情里强制查一次，只能逐个更新，行内按钮不会误触发开关', () => {
  // 顶部没有「检查更新 / 全部更新 / 刷新」：更新入口全部收进每个 Profile 的详情（详情里的「检查更新」强制查一次）。
  // 「更新 N 个」/ 分组更新（走 /api/packs/update，把整组插件升到最新）撤了：设计稿第三期里环境的更新只跟上游 release 走，
  // Profile 详情里只剩单个插件的「更新到 x」
  assert.ok(!/id="pluginCheckUpdates"/.test(html), '不再有单独的「检查更新」按钮')
  assert.ok(!/id="pluginUpdateAll"/.test(html), '不再有单独的「全部更新」按钮')
  assert.ok(!/id="pluginRefresh"/.test(html), '插件页顶部的刷新按钮也撤了')
  assert.match(html, /data-pack-check-updates[\s\S]{0,300}?await refreshPluginUpdates\(\{ force: true \}\)/, '详情里的检查更新强制查一次')
  assert.doesNotMatch(html, /\/api\/packs\/update|data-pack-update|data-group-update/, '没有「更新 N 个」和分组更新，也不调整合包更新接口')
  assert.doesNotMatch(server, /url\.pathname === '\/api\/packs\/update'/, '服务端的整合包更新接口也撤了')
  assert.match(html, /post\('\/api\/plugins\/update', \{ name, profile \}\)/, '逐个更新按目标 Profile 走')
  // 列表保持两行，更新按钮本身说明目标版本，不重复放状态标签。
  assert.match(html, /t\('更新到 \{latest\}', \{ latest: update\.latest \}\)/, '按钮上写清更新到哪版')
  assert.match(html, /class="plugin-update"[^>]*data-update=/, '可更新的行有更新按钮')
  // 整行是个 label，点哪都会开关插件；按钮的点击必须拦住，不能顺带把插件关了
  assert.match(html, /data-update[\s\S]{0,600}?event\.preventDefault\(\)[\s\S]{0,80}?event\.stopPropagation\(\)/, '更新按钮要挡住 label 的默认行为')
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

test('插件更新进度属于具体插件行和环境', () => {
  assert.match(html, /class="plugin-row-progress" data-plugin-progress="\$\{escapeHtml\(plugin\.name\)\}" data-profile="\$\{escapeHtml\(profile\)\}" hidden/)
  assert.match(html, /function setPluginProgress\(busy\) \{[\s\S]{0,650}?row\.hidden = !active/)
  assert.match(html, /if \(data\?\.kind === 'plugin'\) \{[\s\S]{0,260}?pluginProgress = !data \|\| data\.phase === 'idle' \? null : data[\s\S]{0,120}?setPluginProgress\(Boolean\(pluginProgress\)\)/)
})

function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `找到 ${signature}`)
  let depth = 0, quote = '', escaped = false
  const open = source.indexOf('{', start)
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '\"' || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  assert.fail(`函数 ${signature} 没有闭合`)
}

test('更新期间重画按钮，成功和失败都会在 finally 恢复', async () => {
  const functions = [
    extractFunction(html, 'function setPluginProgress(busy)'),
    extractFunction(html, 'function pluginButtons()'),
    extractFunction(html, 'async function updatePlugin(name, profile = pluginProfile)'),
  ].join('\n')
  for (const fails of [false, true]) {
    let settle
    const pending = new Promise((resolve, reject) => { settle = fails ? () => reject(new Error('failed')) : resolve })
    let buttonsDisabled = false
    const context = {
      pluginProfile: 'web', pluginUpdating: '', pluginUpdatingProfile: '', pluginProgress: null, packBusy: false,
      pluginRemoving: '', pluginAdding: false,
      document: { querySelectorAll: () => [] }, paintProgress() {},
      renderPackGrid() { buttonsDisabled = Boolean(context.pluginUpdating) },
      renderPackView() { buttonsDisabled = Boolean(context.pluginUpdating) },
      post: () => pending, loadPlugins: async () => {}, refreshPluginUpdates: async () => {}, notify() {},
    }
    vm.createContext(context)
    vm.runInContext(functions, context)
    const run = vm.runInContext("updatePlugin('alpha', 'web')", context)
    assert.equal(buttonsDisabled, true, 'DOM 重画后的更新按钮被锁定')
    settle()
    await run
    assert.equal(context.pluginUpdating, '')
    assert.equal(context.pluginUpdatingProfile, '')
    assert.equal(buttonsDisabled, false, 'DOM 重画后的其它更新按钮恢复')
  }
})

test('行内进度仅显示在名称和 profile 均匹配的行', () => {
  const fn = extractFunction(html, 'function setPluginProgress(busy)')
  const makeRow = (name, profile) => {
    const button = { classList: { toggle() {} }, setAttribute() {} }
    return { dataset: { pluginProgress: name, profile }, hidden: true, previousElementSibling: { querySelector: () => button }, querySelector: () => ({ classList: { add() {}, remove() {} }, dataset: {}, style: {} }) }
  }
  const rows = [makeRow('alpha', 'web'), makeRow('alpha', 'dev'), makeRow('beta', 'web')]
  const context = { pluginProgress: { name: 'alpha@2.0.0', profile: 'web' }, pluginUpdating: 'alpha', pluginUpdatingProfile: 'web', document: { querySelectorAll: () => rows }, paintProgress() {} }
  vm.createContext(context)
  vm.runInContext(fn + '\nsetPluginProgress(true)', context)
  assert.deepEqual(rows.map((row) => row.hidden), [false, true, true])
})

test('服务端在插件操作期间发进度，结束时收掉', () => {
  assert.match(server, /function emitPluginProgress\(state\) \{/, '有专门的发进度函数')
  assert.match(server, /\{ \.\.\.state, kind: 'plugin', name: pluginProgressName, profile: pluginProgressProfile \}/, '事件要带 kind、插件名和 profile')
  assert.match(server, /const progress = parsePnpmProgress\(text, progressState\)/, 'runPluginCommand 里解析 pnpm 输出')
  assert.match(server, /pluginProgressName = pkg\s*\n\s*pluginProgressProfile = profile\s*\n\s*emitPluginProgress\(\{ phase: 'resolve' \}\)/, '开始时就绑定插件名与 profile')
  assert.match(server, /emitPluginProgress\(null\)/, '结束时收掉（成功失败都要收）')
})

test('插件行的删除按钮固定在开关左边：有没有更新按钮都不改变位置', () => {
  const start = html.indexOf('function pluginRowHtml(')
  const end = html.indexOf('function bindPluginRowEvents(', start)
  assert.ok(start > 0 && end > start, '找得到插件行模板')
  const row = html.slice(start, end)
  const update = row.indexOf('class="plugin-update"')
  const remove = row.indexOf('plugin-remove"')
  const toggle = row.indexOf('<input type="checkbox" data-plugin=')
  assert.ok(update > 0 && remove > 0 && toggle > 0, '更新、删除、开关都在模板里')
  assert.ok(update < remove, '更新按钮在删除按钮左边，有更新时也不会把删除挤走')
  assert.ok(remove < toggle, '删除按钮紧挨开关左边')
})
