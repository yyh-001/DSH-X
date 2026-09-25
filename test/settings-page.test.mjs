import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

/** 页面里那段没有打包器的内联脚本（改设置页时最容易碰坏它）。 */
const inlineScripts = () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length, '页面里应该有内联脚本')
  return scripts.map((match) => match[1])
}

test('设置页有版本目录入口，用整行的设置项样式，旁边是目录选择按钮', () => {
  // 版本目录是长路径，用 .set-row.stacked 占一整行，输入框铺满并带「浏览…」按钮；profile / 端口仍是窄行
  // 标签上带着 data-i18n（静态文案走的是 t() 那条线），所以只认标签文字，不管属性
  assert.match(
    html,
    /<div class="set-row stacked">[\s\S]{0,600}?<input id="dataDir" type="text" \/>[\s\S]{0,200}?<button class="ghost" id="pickDir"/,
    '版本目录单独占一行（.set-row.stacked），旁边有目录选择按钮',
  )
  assert.match(html, /post\('\/api\/pick-dir'/, '浏览按钮走 /api/pick-dir')
  assert.match(html, /\.set-row\.stacked \{ display: block; \}/, '整行样式存在')
  assert.match(html, /<div class="plugin-actions">[\s\S]{0,200}?<select id="profile"/, 'profile 下拉在插件页顶部')
  assert.match(html, /<p class="hint" id="dataDirHint"><\/p>/, '提示行复用 .hint（空内容自动隐藏）')
  // 文本输入框本来就在样式表里，新控件不需要额外 CSS
  assert.match(html, /input\[type=text\], input\[type=number\], select \{/)
})

test('顶栏四个 tab 已取消，设置分类在左侧导航，主页右上角是齿轮入口', () => {
  assert.ok(!/<nav>/.test(html), '顶栏那排 tab 应该去掉')
  assert.ok(!/data-tab=/.test(html), '不该再用 data-tab 切页面')
  assert.match(html, /<button type="button" class="gear-btn" id="settingsEntry"/, '右上角是设置入口')
  // 控制仍是主界面：落地就是它，回到控制时把左侧导航收起来，主页还是那张控制卡片
  assert.match(html, /<main class="home">/, '落地时是控制面板')
  assert.match(html, /main\.home \.settings-nav \{ display: none; \}/, '主界面不显示左侧导航')
  for (const [pane, label] of [['control', '控制'], ['plugins', '插件'], ['log', '日志'], ['settings', '设置']]) {
    assert.match(html, new RegExp(`class="nav-item[^"]*" data-pane="${pane}"`), `${label} 要在左侧导航里`)
    assert.match(html, new RegExp(`<section class="pane[^"]*" id="pane-${pane}">`), `${label} 的面板要在设置页里`)
  }
  for (const category of ['general', 'appearance', 'advanced']) {
    assert.match(html, new RegExp(`data-pane="settings" data-category="${category}"`), `${category} 有独立的导航入口`)
    assert.match(html, new RegExp(`class="set-section" data-category="${category}"`), `${category} 有独立的设置内容`)
  }
  // dsh 不再单开一类：入口没了，那组设置项并进了常规（给个 set-caption 小标题）
  assert.doesNotMatch(html, /data-category="dsh"/, 'dsh 分类已经并进常规')
  assert.match(
    html,
    /<section class="set-section" data-category="general"[\s\S]{0,3000}?<div class="set-caption"[^>]*>dsh<\/div>[\s\S]{0,3000}?id="seedMarket"[\s\S]{0,2000}?id="args"/,
    '插件市场 / 额外启动参数现在挂在常规里',
  )
  // 启动 profile 的入口挪到了插件页：插件就是按 profile 分的，选择器跟着插件走
  assert.match(
    html,
    /<section class="pane[^"]*" id="pane-plugins"[\s\S]{0,1200}?<select id="profile"[^>]*>/,
    '插件页能切 profile',
  )
  assert.doesNotMatch(
    html,
    /<section class="set-section" data-category="general"[\s\S]{0,4000}?<select id="profile"[^>]*>/,
    '常规里不再重复一份 profile 选择器',
  )
  // 必须等这一次保存真的返回再重读：queueSetting 是排队异步的，等它返回不代表服务端已经换了 profile
  assert.match(html, /await post\('\/api\/settings', \{ profile: value \}\)[\s\S]{0,240}?await loadPlugins\(\)/, '切换 profile 后等保存落地再重读插件列表')
  assert.match(html, /section\.hidden = section\.dataset\.category !== nextCategory/, '切换分类只显示对应设置')
  assert.match(html, /gearEl\.onclick = \(\) => showPane\(currentPane === 'settings' \? 'control' : 'settings', currentSettingsCategory\)/, '齿轮在设置与主界面间切换')
  assert.match(html, /const paneLoaders = \{ plugins: loadPlugins, settings: loadSettings \}/, '进面板时才按需加载')
})

test('设置改变后自动提交，目录留空时拒绝提交', () => {
  assert.doesNotMatch(html, /id="saveSettings"/, '不再显示保存按钮')
  assert.match(html, /autoStartEl\.onchange = \(\) => queueSetting\('autoStart', autoStartEl\.checked\)/)
  assert.match(html, /uiLangEl\.onchange = \(\) => queueSetting\('lang', uiLangEl\.value\)/)
  assert.match(html, /dataDirEl\.onchange = \(\) => \{[\s\S]*?if \(dir\) queueSetting\('dataDir', dir\)/)
  assert.match(html, /const data = await post\('\/api\/settings', patch\)/)
})

test('读到的设置填进输入框，并说明插件/profile 位置与迁移语义', () => {
  assert.match(html, /if \('dataDir' in data\) \{[\s\S]*?dataDirEl\.value = String\(data\.dataDir \?\? ''\)/)
  // 文案走 t()，家目录用 {home} 占位（界面语言切换后同一句话要能换掉）
  const hint = html.match(/dataDirHint\.textContent = t\('([^']*\{home\}[^']*)', \{ home: data\.dshHome/)
  assert.ok(hint, '提示行把 dsh 家目录填进 {home}')
  assert.match(hint[1], /插件和 profile 仍在/)
  assert.match(hint[1], /已安装版本不会迁移/)
})

test('改过目录的保存提示说明立即生效和不迁移', () => {
  // 末尾斜杠不该误判成"改过"：用户常带着 '\' 保存
  assert.match(html, /const normDir = \(value\) => String\(value \?\? ''\)\.trim\(\)\.replace\(\/\[\\\\\/\]\+\$\/, ''\)/)
  assert.match(html, /normDir\(data\.dataDir\) !== normDir\(patch\.dataDir\)/)
  // 新目录名用 {dir} 占位传进去，别只断言写死了半句
  assert.match(
    html,
    /t\('已保存。版本目录已改为 \{dir\}（立即生效）[\s\S]{0,60}?\{ dir: data\.dataDir \}\)/,
    '提示里用 {dir} 占位，并把新目录填进去',
  )
})

test('内联脚本仍能解析', () => {
  // 只编译不运行：语法坏了这里就炸，运行时的行为靠上面的结构断言看住
  for (const script of inlineScripts()) new vm.Script(script)
})

test('设置页有 dsh 用户目录与更新下载源两项：前者可浏览、后者是下拉', () => {
  assert.match(html, /<input id="dshHome" type="text"/, 'dsh 用户目录是文本框')
  assert.match(html, /<button class="ghost" id="pickDshHome"[\s\S]{0,120}?浏览…/, 'dsh 用户目录带「浏览…」')
  assert.match(html, /<select id="updateSource"><\/select>/, '更新下载源是下拉（选项由服务端给）')
  // 两项都要能存：一处漏了就会变成「改了没反应」
  assert.match(html, /queueSetting\('dshHome'/, 'dsh 用户目录改动即保存')
  assert.match(html, /queueSetting\('updateSource'/, '更新下载源改动即保存')
})

test('设置页有「打开 dsh 的方式」：两项可选、改动即保存', () => {
  assert.match(html, /<select id="openMode"><\/select>/, '下拉的选项由服务端给')
  assert.match(html, /queueSetting\('openMode'/, '改动即保存')
  assert.match(html, /#openMode'\)\)/, '用自绘下拉统一处理')
})
