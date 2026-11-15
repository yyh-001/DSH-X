import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')

/** 页面里那段没有打包器的内联脚本（改设置页时最容易碰坏它）。 */
const inlineScripts = () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.ok(scripts.length, '页面里应该有内联脚本')
  return scripts.map((match) => match[1])
}

test('设置页有版本目录入口，用整行的设置项样式，旁边是目录选择按钮', () => {
  // 版本目录是长路径，用 .set-row.stacked 占一整行，输入框铺满并带文件夹图标按钮；profile / 端口仍是窄行
  // 标签上带着 data-i18n（静态文案走的是 t() 那条线），所以只认标签文字，不管属性
  assert.match(
    html,
    /<div class="set-row stacked">[\s\S]{0,600}?<input id="dataDir" type="text" \/>[\s\S]{0,200}?<button class="ghost browse-btn" id="pickDir"/,
    '版本目录单独占一行（.set-row.stacked），旁边有目录选择按钮',
  )
  assert.match(html, /post\('\/api\/pick-dir'/, '浏览按钮走 /api/pick-dir')
  assert.match(css, /\.set-row\.stacked \{ display: block; \}/, '整行样式存在')
  assert.ok(!/<select id="profile"/.test(html), '插件页不再有 profile 选择器（环境卡片就是入口）')
  assert.match(html, /<p class="hint" id="dataDirHint"><\/p>/, '提示行复用 .hint（空内容自动隐藏）')
  // 文本输入框本来就在样式表里，新控件不需要额外 CSS（password 也走这条规则）
  assert.match(css, /input\[type=text\], input\[type=number\], input\[type=password\], select \{/)
})

test('顶栏四个 tab 已取消，设置分类在左侧导航，主页右上角是齿轮入口', () => {
  assert.ok(!/<nav>/.test(html), '顶栏那排 tab 应该去掉')
  assert.ok(!/data-tab=/.test(html), '不该再用 data-tab 切页面')
  assert.match(html, /<button type="button" class="gear-btn" id="settingsEntry"/, '右上角是设置入口')
  // 控制仍是主界面：落地就是它，回到控制时把左侧导航收起来，主页还是那张控制卡片
  assert.match(html, /<main class="home">/, '落地时是控制面板')
  assert.match(css, /main\.home \.settings-nav \{ display: none; \}/, '主界面不显示左侧导航')
  for (const [pane, label] of [['control', '控制'], ['plugins', '插件'], ['log', '日志'], ['settings', '设置']]) {
    assert.match(html, new RegExp(`class="nav-item[^"]*" data-pane="${pane}"`), `${label} 要在左侧导航里`)
    assert.match(html, new RegExp(`<section class="pane[^"]*" id="pane-${pane}">`), `${label} 的面板要在设置页里`)
  }
  for (const category of ['general', 'appearance', 'advanced', 'about']) {
    assert.match(html, new RegExp(`data-pane="settings" data-category="${category}"`), `${category} 有独立的导航入口`)
    assert.match(html, new RegExp(`class="set-section" data-category="${category}"`), `${category} 有独立的设置内容`)
  }
  // dsh 不再单开一类：入口没了，那组设置项并进了常规（给个 set-caption 小标题）
  assert.doesNotMatch(html, /data-category="dsh"/, 'dsh 分类已经并进常规')
  assert.match(
    html,
    /<section class="set-section" data-category="general"[\s\S]{0,3000}?<div class="set-caption"[^>]*>dsh<\/div>[\s\S]{0,3000}?id="pluginMarketSourcesEdit"/,
    '默认插件源在常规设置中（列表收起，只留编辑入口）',
  )
  // 实际编辑放在弹窗里：设置行不再直接摆一个大文本框，点铅笔才展开
  assert.match(
    html,
    /<div class="ask" id="pluginSourcesDialog"[\s\S]*?id="pluginMarketSources"/,
    '默认插件源的编辑框在弹窗里',
  )
  // profile 选择器整体撤了：插件页以环境卡片为入口，常规里也不再重复一份
  assert.doesNotMatch(
    html,
    /<section class="set-section" data-category="general"[\s\S]{0,4000}?<select id="profile"[^>]*>/,
    '常规里没有 profile 选择器',
  )
  assert.ok(!/profileEl/.test(html), 'profile 选择器的脚本也一并撤掉')
  assert.match(html, /section\.hidden = section\.dataset\.category !== nextCategory/, '切换分类只显示对应设置')
  // 齿轮在设置与主界面之间切面板（设置不再开独立标签页：多一页渲染进程就多一百多兆）
  assert.match(html, /gearEl\.onclick = \(\) => showPane\(currentPane !== 'control' \? 'control' : 'settings', currentSettingsCategory\)/, '齿轮在设置与主界面间切换')
  assert.doesNotMatch(html, /settings-page|openSettingsTab/, '不再有「设置单独一页」那套')
  assert.match(html, /const paneLoaders = \{[^}]*plugins: loadPlugins[^}]*mcp: loadMcp[^}]*\}/, '进面板时才按需加载')
})

test('设置页左侧导航靠底色和内容区分开，不画分隔线', () => {
  const theme = readFileSync(new URL('../src/public/theme.css', import.meta.url), 'utf8')
  assert.match(css, /\.settings-nav \{[^}]*background: var\(--settings-nav-bg\)/, '导航有自己的底色')
  assert.doesNotMatch(css, /\.settings-nav \{[^}]*border-right/, '不再画中间那条线')
  assert.match(css, /--settings-nav-bg: #/, '亮色有一档导航底色')
  assert.match(theme, /--settings-nav-bg: #/, '暗色也有一档，别和内容区同色')
})

test('设置改变后自动提交，目录留空时拒绝提交', () => {
  assert.doesNotMatch(html, /id="saveSettings"/, '不再显示保存按钮')
  assert.match(html, /autoStartEl\.onchange = \(\) => queueSetting\('autoStart', autoStartEl\.checked\)/)
  assert.match(html, /uiLangEl\.onchange = \(\) => queueSetting\('lang', uiLangEl\.value\)/)
  assert.match(html, /dataDirEl\.onchange = \(\) => \{[\s\S]*?if \(dir\) queueSetting\('dataDir', dir\)/)
  assert.match(html, /const data = await post\('\/api\/settings', patch\)/)
})

test('读到的设置填进版本目录输入框，并说明迁移语义', () => {
  assert.match(html, /if \('dataDir' in data\) \{[\s\S]*?dataDirEl\.value = String\(data\.dataDir \?\? ''\)/)
  // 迁移提示走 t()，切换界面语言时仍能翻译。
  assert.match(html, /dataDirHint\.textContent = t\('仅用于新安装的版本，已有版本不迁移。'/)
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
    /<section class="set-section" data-category="general"[\s\S]*?id="autoCleanVersions"[\s\S]*?<section class="set-section" data-category="advanced"[\s\S]*?id="autoDisable"[\s\S]*?id="args"/,
    '清理留在常规，兼容修复与自由参数移到高级设置',
  )
  assert.match(html, /data-i18n="自动清理旧版本"/, '标题走静态文案那条线')
  assert.match(
    html,
    /if \('autoCleanVersions' in data\) autoCleanEl\.checked = data\.autoCleanVersions !== false/,
    '缺省当开着，只有 false 才显示成关',
  )
  assert.match(html, /queueSetting\('autoCleanVersions', autoCleanEl\.checked\)/, '改动即保存')
  // 服务端三处都得认这个键：读出来给页面、写回去、默认值
  const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
  const settings = readFileSync(fileURLToPath(new URL('../src/settings.js', import.meta.url)), 'utf8')
  assert.match(server, /autoCleanVersions: autoCleanEnabled\(stored\)/, '读设置时交给页面')
  assert.match(server, /'autoCleanVersions' in body \? \{ autoCleanVersions: body\.autoCleanVersions !== false \}/, '保存时认这个键')
  assert.match(settings, /autoCleanVersions: true,/, '默认值在 DEFAULTS 里')
  assert.match(settings, /merged\.autoCleanVersions = merged\.autoCleanVersions !== false/, '存盘时归一成布尔')
  // 英文也要有，否则界面切成英文这里还是中文
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['自动清理旧版本', '保留最新版和最近安装的一版，运行中的版本不删除。']) {
    assert.ok(dict[key], `「${key.slice(0, 12)}…」有英文`)
  }
})

test('设置页有「关于」：核心/外壳版本，按钮主动检查更新', () => {
  assert.match(html, /<section class="set-section" data-category="about"[\s\S]*?id="aboutVersion"[\s\S]*?id="aboutCheckUpdate"/, '关于里有当前版本和检查更新按钮')
  assert.match(html, /id="aboutShellVersion"/, '关于里单独显示外壳版本')
  assert.match(html, /<p class="hint" id="aboutUpdateHint" role="status" aria-live="polite"><\/p>/, '检查结果用 hint 行显示')
  assert.match(html, /const aboutVersion = document\.getElementById\('aboutVersion'\)/, '加载 /api/self 时回填核心版本')
  assert.match(html, /const aboutShellVersion = document\.getElementById\('aboutShellVersion'\)/, '加载 /api/self 时回填外壳版本')
  assert.match(html, /getJson\('\/api\/self\?refresh=1'\)/, '按钮绕开缓存重新检查')
  assert.match(html, /showAsk\(\{ dsh: null, self: \{ current: data\.current, latest: data\.latest, url: data\.url \} \}\)/, '有更新时打开更新弹窗')
  assert.match(html, /已是最新版本（核心 \{core\}，外壳 \{shell\}）/, '都最新时同时报两个版本')
  assert.match(html, /核心更新检查失败：\{message\}/, '核心检查失败单独提示')
  assert.match(html, /data\.app\?\.reason === 'manifest'/, 'npm 元数据取不到时也如实报错')
  assert.match(html, /data\.app\?\.reason === 'electron'/, '核心需要新版 Electron 时提示先更新外壳')
  const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
  assert.match(server, /const refresh = url\.searchParams\.get\('refresh'\) === '1'/, 'refresh=1 解析成布尔')
  assert.match(server, /checkAppUpdate\(\{ force: refresh \}\)/, '核心清单也绕缓存')
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['关于', '关于 DSH-X', '当前版本', '外壳版本', 'DSH-X 核心', '检查更新', '正在检查…', '发现新版本 {latest}，正在打开更新窗口…', '检查更新失败：{message}', '核心已是最新；外壳更新检查失败：{message}', '查看当前版本并检查更新。']) {
    assert.ok(dict[key], `「${key.slice(0, 12)}…」有英文`)
  }
})

test('内联脚本仍能解析', () => {
  // 只编译不运行：语法坏了这里就炸，运行时的行为靠上面的结构断言看住
  for (const script of inlineScripts()) new vm.Script(script)
})

test('设置页用一个下载源选择统管插件、整合包和启动器更新', () => {
  assert.match(html, /<select id="downloadSource"><\/select>/, '统一下载源下拉选项由服务端给')
  assert.doesNotMatch(html, /<select id="updateSource"/, '不再单独暴露启动器更新源')
  assert.match(html, /queueSetting\('downloadSource'/, '统一下载源改动即保存')
  assert.match(html, /用于版本、插件、整合包和启动器更新/, '提示明确说明统管范围')
})

test('设置页有「打开 dsh 的方式」：两项可选、改动即保存', () => {
  assert.match(html, /<select id="openMode"><\/select>/, '下拉的选项由服务端给')
  assert.match(html, /queueSetting\('openMode'/, '改动即保存')
  // 用自绘下拉统一处理：认这份 selector 名单里有没有它，别把整行的形状钉死（名单一直在长）
  const uiSelectList = html.match(/document\.querySelectorAll\('([^']*#openMode[^']*)'\)/)?.[1] || ''
  assert.ok(uiSelectList.includes('#openMode'), '打开方式进自绘下拉名单')
})

test('旧同步界面已撤出首页，兼容接口与插件引擎仍保留', () => {
  assert.doesNotMatch(html, /id="pane-sync"|async function loadSync|paintSyncActions|\/api\/sync/)
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  assert.match(server, /url.pathname === '\/api\/sync\/save'/)
  assert.match(server, /url.pathname === '\/api\/sync\/run'/)
  assert.match(readFileSync(new URL('../plugins/dsh-x-sync/lib/index.js', import.meta.url), 'utf8'), /engine\/sync\.js/)
})

test('设置页有「复制自检请求」按钮：路径问技能清单，复制出去的是可直接执行的命令', () => {
  // 按钮放在高级设置的「AI 自检」组里；技能可能装在自定义 DSH_HOME，路径不能写死
  assert.match(html, /<section class="set-section" data-category="advanced"[\s\S]*?id="copySelfcheckPrompt"/, '按钮在高级设置里')
  assert.match(html, /getJson\('\/api\/skills'\)/, '从管理页技能清单拿真实安装路径')
  assert.match(html, /item\.name === 'dsh-x-selfcheck'/, '只认 dsh-x-selfcheck 这个技能')
  assert.match(html, /node "\$\{script\}" --json/, '复制出去的请求带可直接执行的命令')
  assert.match(html, /navigator\.clipboard\.writeText/, '优先用 Clipboard API')
  assert.match(html, /document\.execCommand\('copy'\)/, 'WebView 没有 Clipboard API 时退回选区复制')
  // 英文也要有，否则界面切成英文这里还是中文
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['复制自检请求', '让 AI 给环境做体检', '复制自检指令，发给 AI 检查环境。', '用 dsh-x-selfcheck 技能跑一次体检，命令：']) {
    assert.ok(dict[key], `「${key.slice(0, 12)}…」有英文`)
  }
})

test('外观跟着状态推送走：设置标签里换主题，管窗口的那一页不用刷新也能跟上', () => {
  // 外观在 /api/state 里带一份，页面收到推送就同步（原来只有设置页自己变，别的页要整页刷新）
  assert.match(server, /appearance: \{[\s\S]{0,220}?theme: THEME[\s\S]{0,220}?hideBigFish: HIDE_BIG_FISH/, '状态里带外观：主题/透明度/减少动效/背景')
  assert.match(html, /if \(data\.appearance && typeof data\.appearance === 'object'\) fillSettings\(data\.appearance\)/, '页面收到状态就同步外观')
  // 复用 fillSettings 那条已有路径（含 pendingSettings 保护），别另写一份换主题的逻辑
  assert.match(html, /if \('theme' in data\) \{[\s\S]{0,220}?window\.setLauncherTheme\(savedTheme\)/, 'fillSettings 里换主题那一条还在')
})

test('水面背景默认关：新装不跑 WebGL 动画，想开在设置里打开', () => {
  const settings = readFileSync(fileURLToPath(new URL('../src/settings.js', import.meta.url)), 'utf8')
  assert.match(settings, /hideBackground: true,/, 'DEFAULTS 里默认关')
})

test('常规的系统组有六个桌面端开关，成败都按服务端回值回显', () => {
  // 键名和 shell/prefs.mjs / settings.js 的 DEFAULTS 是同一组，别在页面里改名
  const ids = ['hardwareAcceleration', 'autoUpdate', 'taskNotifications', 'notificationSound', 'closeToTray', 'keepAwake']
  for (const id of ids) {
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox" />`), `${id} 是复选框`)
    assert.match(html, new RegExp(`\\['${id}', document\\.getElementById\\('${id}'\\)\\]`), `${id} 进 systemPrefRows`)
  }
  assert.match(html, /<section class="set-section" data-category="general"[\s\S]*?<div class="set-caption" data-i18n="系统">系统<\/div>/, '系统组在常规里')
  assert.match(html, /input\.onchange = \(\) => queueSetting\(key, input\.checked\)/, '开关走统一保存链路')
  assert.match(html, /if \(systemPrefRows\.some\(\(\[key\]\) => key in patch\)\) showSystemPrefs\(data\)/, '保存后用服务端归一化后的值回显')
  assert.match(html, /input\.checked = savedSystemPrefs\[key\] === true/, '保存失败回滚到最近一次成功的值')
  // 旧外壳 / 浏览器里整组禁用并说明原因（能力字段只在完整设置里，外观推送不带）
  assert.match(html, /if \(!\('desktopShell' in data\) && !\('shellPrefs' in data\)\) return/, '外观推送不能把整组误禁用')
  assert.match(html, /data\.desktopShell === true && data\.shellPrefs === true/, '能力判断用两个字段')
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['系统', 'Chrome 硬件加速', '自动下载 DSH-X 更新', '任务通知', '通知声音', '关闭窗口时隐藏到托盘', '保持电脑运行']) {
    assert.ok(dict[key], `「${key}」有英文`)
  }
})

test('浏览器安全与数据放进常规：证书开关走统一保存链路，清理按钮走 /api/browser/*', () => {
  assert.match(html, /<input id="browserIgnoreCertificate" type="checkbox" \/>/, '证书开关是复选框')
  assert.match(html, /\['browserIgnoreCertificate', document\.getElementById\('browserIgnoreCertificate'\)\]/, '进 browserPrefRows')
  assert.match(html, /<section class="set-section" data-category="general"[^>]*aria-labelledby="settingsBrowserTitle"[\s\S]*?data-i18n="忽略证书校验"[\s\S]*?id="browserClearCache"[\s\S]*?id="browserClearAll"/, '证书校验与浏览数据在常规的同一组里')
  assert.doesNotMatch(html, /data-category="browser"/, '不再是独立分类')
  assert.match(html, /id="browserClearCache" type="button" data-i18n="清除缓存"/, '清缓存按钮')
  assert.match(html, /id="browserClearAll" type="button" data-i18n="清除全部"/, '清全部按钮')
  assert.match(html, /post\(kind === 'cache' \? '\/api\/browser\/clear-cache' : '\/api\/browser\/clear-data'\)/, '两个按钮各走一条接口')
  assert.match(html, /if \(!\('desktopShell' in data\) && !\('browserHost' in data\)\) return/, '外观推送不能把整组误禁用')
  assert.match(html, /data\.desktopShell === true && data\.browserHost === true/, '能力判断用 desktopShell + browserHost')
  assert.match(html, /if \(browserPrefRows\.some\(\(\[key\]\) => key in patch\)\) showBrowserPrefs\(data\)/, '保存后回显')
  const dict = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
  for (const key of ['浏览器', '忽略证书校验', '清除内置浏览器缓存', '清除全部浏览器数据', '清除缓存', '清除全部']) {
    assert.ok(dict[key], `「${key}」有英文`)
  }
})

test('界面语言有「系统默认」选项并默认选中', () => {
  assert.match(
    html,
    /<select id="uiLang">\s*<option value="system" data-i18n="系统默认">系统默认<\/option>\s*<option value="zh">中文<\/option>\s*<option value="en">English<\/option>\s*<\/select>/,
    '系统默认排第一（默认选项），后面才是中文 / English',
  )
  assert.match(html, /"系统默认": "System default",/, '英文界面有翻译')
  assert.match(html, /uiLangEl\.value = pref === 'zh' \|\| pref === 'en' \? pref : 'system'/, '回显时按偏好落位，缺省落在系统默认')
  assert.match(html, /if \('lang' in data && data\.lang &&[\s\S]{0,120}?applyLang\(\)/, '设置刷新时界面语言跟着运行时语言切，下拉和界面不能各说各话')
})

test('默认插件源的铅笔和主页启动项图标同一套：无边框、悬停才铺底色', () => {
  const button = html.match(/<button[^>]*id="pluginMarketSourcesEdit"[^>]*>/)?.[0] || ''
  assert.match(button, /class="set-edit"/, '用设置页自己的铅笔样式')
  assert.doesNotMatch(button, /ghost|icon-btn/, '不再套白底描边的 ghost 按钮')
  assert.match(css, /\.set-control \.set-edit \{[^}]*border: 0;[^}]*background: transparent;/, '静止无边框无底色')
  assert.match(css, /\.set-control \.set-edit:hover:not\(:disabled\) \{[^}]*background: var\(--accent-soft\)/, '悬停才铺浅色')
  assert.match(css, /\.set-control \.set-edit svg \{ width: 18px; height: 18px; \}/, '图标尺寸和启动项卡片一致')
})

test('运行 dsh 的 Node：下拉固定在行尾，系统 Node 的路径输入在下方展开', () => {
  assert.match(html, /<div class="set-row" id="nodeRuntimeRow">[\s\S]{0,200}?运行 dsh 的 Node/, '这一行不再是整行竖排')
  assert.doesNotMatch(html, /<div class="set-row stacked">\s*<div class="set-text">\s*<span class="set-name" data-i18n="运行 dsh 的 Node"/, '不再用 stacked 把下拉挤到下一行')
  assert.match(css, /#nodeRuntimeRow \.set-control \{[^}]*flex-direction: column;[^}]*align-items: flex-end;/, '下拉靠右，路径输入在下面')
  assert.match(css, /#nodeRuntimeRow \.set-control input\[type=text\] \{ width: 100%; \}/, '路径输入撑满这一列')
})
