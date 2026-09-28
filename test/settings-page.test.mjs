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
  // 文本输入框本来就在样式表里，新控件不需要额外 CSS（password 也走这条规则）
  assert.match(html, /input\[type=text\], input\[type=number\], input\[type=password\], select \{/)
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
  assert.match(html, /const paneLoaders = \{[^}]*plugins: loadPlugins[^}]*mcp: loadMcp[^}]*\}/, '进面板时才按需加载')
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

test('自动清理旧版本：开关在 dsh 那组里，改动即保存，读设置时回显', () => {
  // 装完新版删掉更旧的是默认行为（老设置文件里没这个键也是这个行为），
  // 开关只是把它变成可选：关掉就一个都不删
  assert.match(
    html,
    /id="autoDisable"[\s\S]{0,600}?<input id="autoCleanVersions" type="checkbox" \/>[\s\S]{0,1400}?id="args"/,
    '开关跟在兼容模式后面，额外启动参数仍收在组尾',
  )
  assert.match(html, /data-i18n="自动清理旧版本"/, '标题走静态文案那条线')
  assert.match(
    html,
    /if \('autoCleanVersions' in data\) autoCleanEl\.checked = data\.autoCleanVersions !== false/,
    '缺省当开着，只有 false 才显示成关',
  )
  assert.match(html, /queueSetting\('autoCleanVersions', autoCleanEl\.checked\)/, '改动即保存')
  // 服务端三处都得认这个键：读出来给页面、写回去、默认值
  const server = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8')
  const settings = readFileSync(fileURLToPath(new URL('../settings.js', import.meta.url)), 'utf8')
  assert.match(server, /autoCleanVersions: autoCleanEnabled\(stored\)/, '读设置时交给页面')
  assert.match(server, /'autoCleanVersions' in body \? \{ autoCleanVersions: body\.autoCleanVersions !== false \}/, '保存时认这个键')
  assert.match(settings, /autoCleanVersions: true,/, '默认值在 DEFAULTS 里')
  assert.match(settings, /merged\.autoCleanVersions = merged\.autoCleanVersions !== false/, '存盘时归一成布尔')
  // 英文也要有，否则界面切成英文这里还是中文
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['自动清理旧版本', '装完新版本后删掉更旧的，只留最新的和最近装的一个（正在运行的除外）。关掉就全部留着——回退时想退到哪个版本都在，代价是每个版本要占几百 MB。']) {
    assert.ok(dict[key], `「${key.slice(0, 12)}…」有英文`)
  }
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
  // 用自绘下拉统一处理：认这份 selector 名单里有没有它，别把整行的形状钉死（名单一直在长）
  const uiSelectList = html.match(/document\.querySelectorAll\('([^']*#profile[^']*)'\)/)?.[1] || ''
  assert.ok(uiSelectList.includes('#openMode'), '打开方式进自绘下拉名单')
})

test('同步面板：已从设置页摘下来（引擎与接线留着），面板本身四套配置仍齐全、密钥走 password', () => {
  // 同步改由 dsh 插件（dsh-x-sync）提供，启动器设置页不再挂这个入口；
  // 面板结构、加载函数、自绘下拉名单都不删——放回去只差导航项和 paneLoaders 两行
  assert.ok(!/class="nav-item[^"]*" data-pane="sync"/.test(html), '左侧导航不该再有同步入口')
  assert.ok(!/const paneLoaders = \{[^}]*sync: loadSync/.test(html), '面板加载表里也不挂它')
  assert.match(html, /<section class="pane" id="pane-sync">/, '面板结构留着（放回来不用重写）')
  assert.match(html, /async function loadSync\(\)/, '面板自己的加载函数也留着')
  for (const id of [
    'syncStore', 'syncEndpoint', 'syncRegion', 'syncBucket', 'syncPrefix', 'syncAccessKey', 'syncSecretKey',
    'syncSessionToken', 'syncInsecure', 'syncDavUrl', 'syncDavUser', 'syncDavSecret', 'syncDavPrefix',
    'syncDavInsecure', 'syncFolderPath', 'syncPickFolder', 'syncZipPath', 'syncPickZip', 'syncPolicy', 'syncStyle', 'syncScopeGroup',
    'syncTest', 'syncUpload', 'syncDownload', 'syncStop', 'syncProgress', 'syncHint', 'syncDetail',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 在页面上`)
  }
  assert.match(html, /<input id="syncSecretKey" type="password"/, 'SecretKey 不明文显示')
  assert.match(html, /<input id="syncSessionToken" type="password"/, '会话令牌不明文显示')
  assert.match(html, /<input id="syncDavSecret" type="password"/, 'WebDAV 密码不明文显示')
  // 几组字段靠 data-store 显隐（.set-row 有 display:flex，得有一条 [hidden] 规则压得住）
  assert.match(html, /\.set-row\[hidden\], \.set-row\.stacked\[hidden\] \{ display: none; \}/, '整行能按存储类型藏起来（权重得压过 .set-row.stacked）')
  assert.match(html, /showSyncStoreRows\(syncStoreEl\.value\)/, '切类型时显隐对应那组')
  assert.match(html, /const s3Inputs = \{[\s\S]{0,900}?const davInputs = \{/, '两套输入各存一份')
  assert.match(html, /post\('\/api\/sync\/save', \{ s3: read\(s3Inputs\), webdav: read\(davInputs\), folder: read\(folderInputs\), zip: read\(zipInputs\), sync \}\)/, '保存时几套配置一起交上去')
  assert.match(html, /const zipInputs = \{[\s\S]{0,80}?syncZipPath/, 'ZIP 那套输入')
  assert.match(html, /post\('\/api\/pick-file'/, '「选择…」走文件选择接口')
  assert.match(html, /const folderInputs = \{[\s\S]{0,80}?syncFolderPath/, '本地目录那套输入')
  assert.match(html, /local \? '导出' : '上传'/, '本地目录模式下按钮改叫导出/导入')
  assert.match(html, /post\('\/api\/pick-dir'/, '「浏览…」复用目录选择接口')
  assert.match(html, /const paneLoaders = \{ plugins: loadPlugins[^}]*\}/, '面板加载表还在（放回来加一行 sync: loadSync）')
  // 摘下来是临时的：怎么放回来得写在原地，别留给下一个人去猜
  assert.match(html, /放回来[\s\S]{0,160}?paneLoaders/, 'pane-sync 上方写清了放回来的两步')
  assert.match(html, /post\('\/api\/sync\/save'/, '配置改动即保存')
  assert.match(html, /post\('\/api\/sync\/run', \{ mode \}\)/, '上传/下载走同一个接口，用 mode 分方向')
  assert.match(html, /post\('\/api\/sync\/stop'/, '跑得太久能停')
  assert.match(html, /addEventListener\('sync'/, '同步进度走 SSE 的 sync 事件')
  const syncSelects = html.match(/document\.querySelectorAll\('([^']*#syncStore[^']*)'\)/)?.[1] || ''
  for (const id of ['#openMode', '#syncStore', '#syncPolicy', '#syncStyle']) {
    assert.ok(syncSelects.includes(id), `新下拉 ${id} 也进自绘下拉名单`)
  }
})

test('同步面板的中文文案都有英文', () => {
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  const cjk = /[\u4e00-\u9fff]/
  const missing = []
  const check = (text) => { if (cjk.test(text) && !dict[text]) missing.push(text) }
  const pane = html.match(/<section class="pane" id="pane-sync">[\s\S]*?<\/section>/)[0]
  for (const match of pane.matchAll(/data-i18n="([^"]+)"/g)) check(match[1])
  // 面板 JS 里的中文：范围/策略/风格的文案表和所有 t('…') 的字面量
  const block = html.match(/\/\/ ---- 同步[\s\S]*?\n    loadSettings\(\)/)[0]
  for (const match of block.matchAll(/'([^'\n]+)'/g)) check(match[1])
  assert.deepEqual([...new Set(missing)], [], '同步面板里没翻的中文')
})
