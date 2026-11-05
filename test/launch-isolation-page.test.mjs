/**
 * 「添加启动项」的隔离方式引导：三档 tab 切换——插件隔离（默认）/ 会话隔离两档一键新建，
 * 各自下面挂一块可展开的折叠用来指定 Profile 名称 / 目录、自定义档露出原来的完整表单。
 * 页面是无构建的原生 JS，这里读 HTML/CSS 源码做结构断言（和 launch-home-page、update-channel-page
 * 一个路子），交互函数抠出来放进 vm 里跑，不起服务。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (name) => readFileSync(new URL(`../src/public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const page = read('index.html')
const css = read('launcher.css')

function section(from, to) {
  const start = page.indexOf(from)
  assert.ok(start >= 0, `页面里找不到「${from}」`)
  const end = page.indexOf(to, start + from.length)
  assert.ok(end > start, `「${from}」后面找不到「${to}」`)
  return page.slice(start, end)
}

/** 抠一个具名函数的源码（数花括号配平），给 vm 单独跑；sync / async 都认。 */
function functionSource(name) {
  const start = [`    function ${name}(`, `    async function ${name}(`]
    .map((mark) => page.indexOf(mark)).find((index) => index >= 0)
  assert.ok(start >= 0, `页面里找不到函数 ${name}()`)
  let depth = 0
  for (let i = page.indexOf('{', start); i < page.length; i += 1) {
    if (page[i] === '{') depth += 1
    else if (page[i] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, i + 1)
    }
  }
  throw new Error(`函数 ${name}() 的花括号没有配平`)
}

/** 两个路径比较的小工具（页面里就是这两行 const）。 */
const pathHelpers = page.slice(page.indexOf('    const normalizeHomePath ='), page.indexOf('    /** 会话隔离的默认目录'))

const EN_REQUIRED = [
  '隔离方式', '插件隔离', '会话隔离', '自定义',
  '将自动新建 Profile「{name}」：沿用全局 dsh 目录，会话与记忆共享，插件与配置独立。',
  '将自动新建独立目录：会话、记忆、插件与配置全部独立。',
  '数据目录还没就绪，稍后再试',
  '版本、端口、目录和 Profile 都在这里手动选；要新目录先去「管理目录」里添加。',
  '自定义 Profile', '自定义目录', '自动新建（{path}）',
  'Profile 名称，留空用 web',
  '这个 Profile 不能启动网页，换一个名称',
  '编辑 Profile…',
  'Profile「{profile}」还没初始化：先用它启动一次，dsh 会建好这个环境，之后就能在这里编辑。',
]

test('三档 tab：默认插件隔离，顺序固定，tab 带无障碍角色和选中态', () => {
  const dialog = section('id="launchDialog"', '</form>')
  assert.match(dialog, /<div class="launch-isolation" id="launchIsolationField">/)
  assert.match(dialog, /<div class="launch-isolation-tabs" id="launchIsolationTabs" role="tablist" aria-label="隔离方式"[^>]*data-active="profile">/, '浮块默认停在插件隔离')
  const tabs = [...dialog.matchAll(/<button class="launch-isolation-tab"[^>]*data-isolation="(profile|home|custom)"[^>]*>/g)]
  assert.deepEqual(tabs.map((match) => match[1]), ['profile', 'home', 'custom'], 'tab 顺序：插件隔离 → 会话隔离 → 自定义')
  assert.equal((dialog.match(/role="tab"/g) || []).length, 3, '三个 tab 都要 role=tab')
  assert.equal((dialog.match(/aria-selected="true"/g) || []).length, 1, '只允许一个当前档')
  assert.match(dialog, /data-isolation="profile" aria-selected="true"/, '默认选中插件隔离')
  for (const label of ['插件隔离', '会话隔离', '自定义']) {
    assert.ok(dialog.includes(`data-i18n="${label}">${label}</button>`), `tab 文案要有中英翻译：${label}`)
  }
  // 说明行是 JS 按当前档动态写的，不能写死在标签里（切档/切语言都要跟着变）
  assert.match(dialog, /<p class="hint" id="launchIsolationHint"><\/p>/)
  // 前两档什么都不用填：不再有目录输入或 Profile 名字输入
  assert.ok(!page.includes('launchHomePath'), '旧的「新用户目录」输入已经删掉')
  assert.ok(!page.includes('launchProfileName'), '旧的「新 Profile 名称」输入已经删掉')
  assert.ok(!page.includes('launchPickHome'), '旧的「选择目录…」按钮已经删掉')
  assert.ok(!page.includes('launchIsolationOption'), '旧的单选卡片已经换成 tab')
  assert.ok(!page.includes('launch-isolation-option'), '旧的单选卡片样式已经换成 tab')
})

test('前两档下面各挂一块折叠：默认收起，展开可指定 Profile 名称 / 目录', () => {
  const isolation = section('<div class="launch-isolation" id="launchIsolationField">', '<div class="launch-custom-fields" id="launchCustomFields">')
  // 折叠顺序跟 tab 一致：插件隔离那块在前，会话隔离那块在后
  const profileAt = isolation.indexOf('id="launchProfileAdvanced"')
  const homeAt = isolation.indexOf('id="launchHomeAdvanced"')
  assert.ok(profileAt >= 0 && homeAt > profileAt, '两块折叠按 Profile / 会话隔离的顺序排列')
  // 折叠头是按钮（开合动画由 setLaunchAdvanced 控制），默认 aria-expanded=false、面板 hidden
  assert.match(isolation, /<div class="launch-isolation-advanced" id="launchProfileAdvanced">\s*<button class="launch-isolation-advanced-toggle" type="button" aria-expanded="false" aria-controls="launchProfileAdvancedPanel">/)
  assert.match(isolation, /<div class="launch-isolation-advanced" id="launchHomeAdvanced">\s*<button class="launch-isolation-advanced-toggle" type="button" aria-expanded="false" aria-controls="launchHomeAdvancedPanel">/)
  assert.match(isolation, /<span class="launch-isolation-advanced-label" data-i18n="自定义 Profile">/)
  assert.match(isolation, /<span class="launch-isolation-advanced-label" data-i18n="自定义目录">/)
  assert.match(isolation, /<div class="launch-isolation-advanced-panel" id="launchProfileAdvancedPanel" hidden>/)
  assert.match(isolation, /<div class="launch-isolation-advanced-panel" id="launchHomeAdvancedPanel" hidden>/)
  //插件隔离折叠：只留一个输入框，占位符就是自动会取的名字
  assert.match(isolation, /id="launchProfileAdvanced"[\s\S]*<input id="launchProfileCustom" type="text" maxlength="32"/)
  assert.match(isolation, /id="launchProfileCustom"[^>]*aria-label="Profile 名称"/, '没有可见 label，读屏靠 aria-label')
  // 会话隔离折叠：目录下拉（和「自定义」一样是登记目录）+ Profile 名称
  assert.match(isolation, /id="launchHomeAdvanced"[\s\S]*<select id="launchHomeCustom" aria-label="dsh 用户目录"[^>]*><\/select>/)
  assert.ok(!isolation.includes('launchHomePick'), '目录改成下拉后不再需要「选择目录…」按钮')
  assert.match(isolation, /id="launchHomeProfile"[^>]*maxlength="32"/)
  assert.match(isolation, /id="launchHomeProfile"[^>]*aria-label="Profile 名称"/)
  // 折叠里不再堆 label / 说明文字：标题 + 控件 + 开关就够，说明只在顶上那一行
  const profilePanel = section('id="launchProfileAdvancedPanel"', 'id="launchHomeAdvanced"')
  // 折叠面板到「运行位置」为止：运行位置在完整表单外面，里面的 WSL 发行版有可见 label，不能算进折叠
  const homePanel = section('id="launchHomeAdvancedPanel"', 'id="launchBackendField"')
  for (const panel of [profilePanel, homePanel]) {
    assert.ok(!panel.includes('<p class="hint"'), '折叠里不再放说明段')
    assert.ok(!panel.includes('<label for='), '折叠里不再放可见 label')
  }
  // 自动启动开关也放进折叠：展开就能勾，不用切回自定义档
  assert.match(isolation, /id="launchProfileAdvanced"[\s\S]*<input id="launchAutoLaunchProfile" type="checkbox"/)
  assert.match(isolation, /id="launchHomeAdvanced"[\s\S]*<input id="launchAutoLaunchHome" type="checkbox"/)
  // 折叠夹在说明行和完整表单之间，不打断原来的字段顺序
  assert.ok(isolation.indexOf('id="launchIsolationHint"') < profileAt, '折叠放在说明行下面')
})

test('自定义档是可显隐的字段块：原来那张完整表单原样搬进来，id 一个没改', () => {
  const fields = section('<div class="launch-custom-fields" id="launchCustomFields">', '<!-- /launch-custom-fields -->')
  assert.match(fields, /id="versionPicker"[\s\S]*id="launchUpdateChannel"/, '版本行也在里面')
  assert.match(fields, /id="launchIdentityField"[\s\S]*id="launchName"/)
  assert.match(fields, /id="launchHomeSelectField"[\s\S]*<label for="launchDshHome"[\s\S]*<select id="launchDshHome"[^>]*><\/select>/)
  assert.match(fields, /id="launchProfileSelectField"[\s\S]*<select id="launchProfile" title="Profile"><\/select>/)
  assert.match(fields, /id="launchPort"/)
  // 「打开启动器时启动」自定义档里也有一份（折叠里那两份跟它同步）
  assert.match(fields, /<label class="toggle launch-auto-launch">[\s\S]*id="launchAutoLaunch"/, '自动启动开关自定义档里也有一份')
  // 字段块夹在 tab 和底部工具条之间；前两档页面上只剩三档 tab、说明和折叠
  const fieldAt = page.indexOf('id="launchCustomFields"')
  assert.ok(page.indexOf('id="launchIsolationField"') < fieldAt, 'tab 在前，字段块在后')
  assert.ok(fieldAt < page.indexOf('class="launch-tool-actions"'), '字段块在底部工具条前面')
})

test('切档时字段块靠 hidden 显隐，tab 是胶囊分段：底槽 + 当前档浮块滑动', () => {
  assert.match(css, /\.launch-isolation\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-custom-fields\[hidden\] \{ display: none; \}/)
  // 胶囊分段：底槽浅色圆角，当前档浮块按 data-active 平移到对应三份之一
  assert.match(css, /\.launch-isolation-tabs \{ position: relative; display: flex; gap: 2px; padding: 4px; border-radius: 12px; background: var\(--accent-soft\); \}/)
  assert.match(css, /\.launch-isolation-tabs::after \{ content: ''; position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc\(\(100% - 12px\) \/ 3\);/, '浮块等分三份')
  assert.match(css, /\.launch-isolation-tabs::after \{[^}]*transition: transform 240ms cubic-bezier/, '切档浮块要滑动')
  assert.match(css, /\.launch-isolation-tabs\[data-active="home"\]::after \{ transform: translateX\(calc\(100% \+ 2px\)\); \}/)
  assert.match(css, /\.launch-isolation-tabs\[data-active="custom"\]::after \{ transform: translateX\(calc\(200% \+ 4px\)\); \}/)
  assert.match(css, /\.launch-isolation-tab \{ flex: 1 1 0; position: relative; z-index: 1; padding: 8px; border: 0; border-radius: 9px; background: transparent/, 'tab 透明让浮块露出来')
  assert.match(css, /\.launch-isolation-tab\[aria-selected="true"\] \{ color: var\(--accent\); font-weight: 600; \}/, '当前档只改文字，不铺底')
  assert.match(css, /\.launch-isolation-tab:focus-visible \{ outline:/, '键盘焦点描边')
  assert.match(css, /html\.reduce-motion \.launch-isolation-tabs::after,/, '减少动态时浮块不滑动')
  // 折叠条：浅色小横条 + 自绘箭头，展开时箭头转 180°（开合由 setLaunchAdvanced 做高度动画）
  assert.match(css, /\.launch-isolation-advanced \{ border-radius: 12px; background: var\(--accent-soft\); overflow: hidden; transition: box-shadow 160ms ease; \}/)
  assert.match(css, /\.launch-isolation-advanced\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-isolation-advanced-toggle \{ display: flex; align-items: center; gap: 8px; width: 100%;/)
  assert.match(css, /\.launch-isolation-advanced-chevron \{ width: 14px; height: 14px; flex: 0 0 auto; transition: transform 220ms/, '箭头旋转要有过渡')
  assert.match(css, /\.launch-isolation-advanced\.is-open \.launch-isolation-advanced-chevron \{ transform: rotate\(180deg\); \}/)
  assert.match(css, /\.launch-isolation-advanced-panel \{ overflow: hidden; \}/)
  assert.match(css, /\.launch-isolation-advanced-panel\[hidden\] \{ display: none; \}/)
  // 目录改成下拉后，输入框那套行样式一并撤掉；下拉本体要占满折叠宽度（.ui-select 默认 148px 太窄）
  assert.match(css, /\.launch-isolation-advanced-fields \.ui-select \{ width: 100%; \}/)
  assert.ok(!css.includes('.launch-home-path-row'), '目录改成下拉后不再需要输入框那一行')
  assert.ok(!css.includes('.launch-isolation-option'), '旧的单选卡片样式换成了 tab')
})

test('英文界面有全部引导文案（t() 的字典里逐条存在，不能漏翻）', () => {
  const dict = section('const EN = {', 'function t(zh, vars)')
  for (const zh of EN_REQUIRED) assert.ok(dict.includes(`${JSON.stringify(zh)}: `), `缺少英文翻译：${zh}`)
})

/** setLaunchIsolation 的 vm 环境：字段桩 + 代填函数桩，只关心"切档后谁藏谁露、名字怎么代填"。 */
function isolationHarness() {
  const calls = { paint: 0, autoNames: 0 }
  const context = vm.createContext({
    paintLaunchIsolation: () => { calls.paint += 1 },
    guidedLaunchName: () => { calls.autoNames += 1; return 'auto-name' },
    launchIsolationFieldEl: { hidden: false },
    launchCustomFieldsEl: { hidden: false },
    launchProfileAdvancedEl: { hidden: false },
    launchHomeAdvancedEl: { hidden: false },
    launchNameEl: { value: '', required: true },
    launchNameAuto: '',
    launchRecoverEl: { hidden: false },
  })
  vm.runInContext(functionSource('setLaunchIsolation'), context)
  return { context, calls }
}

test('切档只改可见性：前两档收起字段块、名字代填，自定义档把原表单还回来', () => {
  const { context, calls } = isolationHarness()

  context.setLaunchIsolation('profile', true)
  assert.equal(context.launchIsolationFieldEl.hidden, false, '新建时 tab 要露出来')
  assert.equal(context.launchCustomFieldsEl.hidden, true, '插件隔离什么都不用填')
  assert.equal(context.launchProfileAdvancedEl.hidden, false, '插件隔离的折叠可以展开')
  assert.equal(context.launchHomeAdvancedEl.hidden, true, '另一档的折叠不露')
  assert.equal(context.launchNameEl.value, 'auto-name', '名字代填好，用户不用填')
  assert.equal(context.launchNameEl.required, false, '藏起来的名称输入不能拦着提交')
  assert.equal(context.launchRecoverEl.hidden, true, '一键新建没什么可修的，修复环境按钮不露')
  assert.ok(calls.paint > 0, '切档后要重画选中态和说明')

  context.launchNameEl.value = ''
  context.setLaunchIsolation('home', true)
  assert.equal(context.launchCustomFieldsEl.hidden, true, '会话隔离同样什么都不用填')
  assert.equal(context.launchProfileAdvancedEl.hidden, true)
  assert.equal(context.launchHomeAdvancedEl.hidden, false, '会话隔离的折叠可以展开')
  assert.equal(context.launchNameEl.value, 'auto-name')

  context.setLaunchIsolation('custom', true)
  assert.equal(context.launchCustomFieldsEl.hidden, false, '自定义档把完整表单还回来')
  assert.equal(context.launchProfileAdvancedEl.hidden, true, '完整表单里不重复给折叠')
  assert.equal(context.launchHomeAdvancedEl.hidden, true)
  assert.equal(context.launchNameEl.required, true, '自定义档名称仍然是必填')
  assert.equal(context.launchRecoverEl.hidden, false, '自定义档照旧给修复环境入口')
})

test('编辑已有启动项不显示隔离 tab，字段块直接露出来', () => {
  const { context, calls } = isolationHarness()
  context.launchNameEl.value = '我的工作环境'
  context.setLaunchIsolation('custom', false)
  assert.equal(context.launchIsolationFieldEl.hidden, true, '编辑老启动项时引导整块收起')
  assert.equal(context.launchCustomFieldsEl.hidden, false, '手填字段不能藏起来')
  assert.equal(context.launchProfileAdvancedEl.hidden, true, '编辑时折叠跟着收起')
  assert.equal(context.launchHomeAdvancedEl.hidden, true)
  assert.equal(context.launchNameEl.value, '我的工作环境', '编辑时不代填名字')
  assert.equal(context.launchNameEl.required, true)
  assert.equal(calls.autoNames, 0, '编辑不调用代填')
})

/** prepareGuidedLaunch 的 vm 环境：真实建议值函数 + 接口收集桩，验证它算出什么、发了哪些请求。 */
function guidedHarness({ mode, dataDir = 'C:\\data', dshHomes = [], profiles = ['web'], webProfiles = ['web'], home, profileCustom = '', homeCustom = '', homeProfile = '', projectDir = '', copyHome = '', copyProfile = '' } = {}) {
  const calls = { gets: [], posts: [] }
  const context = vm.createContext({
    t: (text) => text,
    state: { dataDir, dshHomes, profiles, webProfiles },
    launchEntries: () => [],
    launchProfile: 'web',
    launchProfileCustomEl: { value: profileCustom },
    launchHomeCustomEl: { value: homeCustom },
    launchHomeProfileEl: { value: homeProfile },
    launchProjectDirEl: { value: projectDir },
    launchCopyHomeEl: { value: copyHome },
    launchCopyProfileEl: { value: copyProfile },
    PLUGIN_HOME_MANAGE: '__manage__',
    getJson: async (url) => {
      calls.gets.push(url)
      const requested = url.includes('home=') ? decodeURIComponent(url.slice(url.indexOf('home=') + 5)) : ''
      return { home: home ?? (requested || 'C:\\global'), profiles, webProfiles }
    },
    post: async (url, body) => { calls.posts.push([url, body]); return { ok: true } },
  })
  context.launchIsolation = mode
  vm.runInContext(
    `${pathHelpers}\n${functionSource('suggestIsolatedHome')}\n${functionSource('suggestIsolatedProfile')}\n${functionSource('projectHomeOf')}
${functionSource('selectedCopy')}
${functionSource('prepareGuidedLaunch')}`,
    context,
  )
  return { context, calls }
}

test('插件隔离：名字和 Profile 全代算，不存在的 Profile 交给保存接口补建', async () => {
  const h = guidedHarness({ mode: 'profile', profiles: ['web'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.deepEqual({ name: target.name, profile: target.profile, dshHome: target.dshHome }, { name: 'work', profile: 'work', dshHome: '' })
  assert.equal(h.context.launchProfile, 'work', '保存时用的 profile 变量也要跟着改')
  assert.deepEqual(h.calls.posts, [], '不先建 Profile：一次保存请求里由服务端 ensureProfile 完成')
  assert.deepEqual(h.calls.gets, [], '连目录探测都不用，全是代算的')

  // 工作名被占了就往后挑一个，不会跟现有 Profile 撞车
  const busy = guidedHarness({ mode: 'profile', profiles: ['web', 'work', 'home'] })
  const next = await busy.context.prepareGuidedLaunch()
  assert.equal(next.profile, 'work2')
  assert.equal(next.name, 'work2')
})

test('会话隔离：目录代算在数据目录 homes 下、自动登记，重名往后顺延', async () => {
  const fresh = guidedHarness({ mode: 'home', dshHomes: [] })
  const target = await fresh.context.prepareGuidedLaunch()
  assert.equal(target.dshHome, 'C:\\data\\homes\\dsh', '默认开在数据目录的 homes 下')
  assert.equal(target.profile, 'web', '新目录用模板 profile 直接能起网页')
  assert.equal(target.name, 'dsh', '启动项名字取目录最后一段')
  assert.equal(fresh.calls.gets.length, 1, '先探一次目录里有哪些 Profile')
  assert.deepEqual(fresh.calls.posts.map(([url]) => url), ['/api/dsh-homes/add'], '新目录顺手登记到管理目录')
  assert.equal(fresh.calls.posts[0][1].home, 'C:\\data\\homes\\dsh')

  const known = guidedHarness({ mode: 'home', dshHomes: ['C:/data/homes/dsh'] })
  const second = await known.context.prepareGuidedLaunch()
  assert.equal(second.dshHome, 'C:\\data\\homes\\dsh-2', '已登记的目录不重复用，序号顺延')
  assert.equal(second.name, 'dsh-2')

  const noData = guidedHarness({ mode: 'home', dataDir: '' })
  await assert.rejects(noData.context.prepareGuidedLaunch(), /数据目录还没就绪/)
})

test('折叠里填了就用填的：Profile 名称 / 目录 / Profile 都能覆盖自动取名', async () => {
  //插件隔离：填一个没占用的名字，就用它
  const named = guidedHarness({ mode: 'profile', profileCustom: 'dev' })
  const target = await named.context.prepareGuidedLaunch()
  assert.deepEqual({ name: target.name, profile: target.profile, dshHome: target.dshHome }, { name: 'dev', profile: 'dev', dshHome: '' })

  // 已存在但不起网页的 Profile（headless 之类）选了也开不了页面，先拦下来
  const notWeb = guidedHarness({ mode: 'profile', profiles: ['web', 'headless'], profileCustom: 'headless' })
  await assert.rejects(notWeb.context.prepareGuidedLaunch(), /不能启动网页/)

  // 会话隔离：自己填目录，Profile 留空还是 web；名字仍取目录最后一段
  const homeCustom = guidedHarness({ mode: 'home', homeCustom: 'D:\\custom\\dsh' })
  const custom = await homeCustom.context.prepareGuidedLaunch()
  assert.equal(custom.dshHome, 'D:\\custom\\dsh')
  assert.equal(custom.profile, 'web')
  assert.equal(custom.name, 'dsh')
  assert.equal(homeCustom.calls.gets[0], `/api/launch-home/profiles?home=${encodeURIComponent('D:\\custom\\dsh')}`, '先探测自定义目录里有哪些 Profile')
  assert.deepEqual(homeCustom.calls.posts.map(([url]) => url), ['/api/dsh-homes/add'], '新目录顺手登记')

  // 目录和 Profile 都填：profile 用填的（这里 work 是能起网页的），启动项名字用它
  const both = guidedHarness({ mode: 'home', homeCustom: 'D:\\custom\\dsh', homeProfile: 'work', profiles: ['web', 'work'], webProfiles: ['web', 'work'] })
  const namedHome = await both.context.prepareGuidedLaunch()
  assert.equal(namedHome.dshHome, 'D:\\custom\\dsh')
  assert.equal(namedHome.profile, 'work')
  assert.equal(namedHome.name, 'work', '填了 Profile 就用它当启动项名')

  // 自定义目录里已有的非网页 Profile 也拦
  const notWebHome = guidedHarness({ mode: 'home', homeCustom: 'D:\\custom\\dsh', homeProfile: 'headless', profiles: ['web', 'headless'] })
  await assert.rejects(notWebHome.context.prepareGuidedLaunch(), /不能启动网页/)
})

test('折叠接线：说明行/号占位符随档刷新、目录下拉由登记目录铺开、打开新建时清空上次填的值', () => {
  const paint = section('    function paintLaunchIsolation() {', '    launchIsolationFieldEl.onclick =')
  assert.match(paint, /tabsEl\.dataset\.active = launchIsolation/, '切档把胶囊浮块滑到对应位置')
  assert.match(paint, /paintLaunchHomeCustom\(\)/, '切档时重画目录下拉（第一项跟着自动目录变）')
  assert.match(paint, /launchProfileCustomEl\.placeholder = suggestIsolatedProfile\(\)/, 'Profile 名称占位符就是自动会取的名字')
  assert.match(paint, /launchHomeProfileEl\.placeholder = t\('Profile 名称，留空用 web'\)/)
  const homePaint = section('    function paintLaunchHomeCustom() {', '    launchHomeCustomEl.onchange = () => {')
  assert.match(homePaint, /const auto = t\('自动新建（\{path\}）', \{ path: suggestIsolatedHome\(\) \|\| t\('数据目录'\) \}\)/, '第一项亮出自动会建的目录')
  assert.match(homePaint, /for \(const home of homeOptions\(current\)\)/, '登记过的目录都能选')
  assert.match(homePaint, /options\.push\(`<option value="\$\{PLUGIN_HOME_MANAGE\}">/, '管理目录放最后')
  assert.match(homePaint, /syncUiSelect\(launchHomeCustomEl\)/, '重铺后要同步 ui-select 触发器')
  const manage = section('    launchHomeCustomEl.onchange = () => {', '    /**')
  assert.match(manage, /openPluginHomesDialog\(\)/, '选「管理目录…」打开目录管理弹窗')
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /launchProfileCustomEl\.value = ''/, '每次打开都清掉上次折叠里填的值')
  assert.match(open, /launchHomeCustomEl\.value = ''/)
  assert.match(open, /launchHomeProfileEl\.value = ''/)
  assert.match(open, /setLaunchAdvanced\(launchProfileAdvancedEl, false, false\)/, '折叠也收回默认的收起状态（不动画）')
  assert.match(open, /setLaunchAdvanced\(launchHomeAdvancedEl, false, false\)/)
})

/** paintLaunchHomeCustom 的 vm 环境：真实铺选项逻辑 + 桩掉的页面函数。 */
function homeCustomHarness({ current = '', homes = ['D:\\a', 'D:\\b'] } = {}) {
  const calls = { synced: 0 }
  const select = { value: current, innerHTML: '' }
  const context = vm.createContext({
    launchHomeCustomEl: select,
    t: (text, vars) => (vars ? Object.entries(vars).reduce((out, [key, value]) => out.split(`{${key}}`).join(value), text) : text),
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    suggestIsolatedHome: () => 'C:\\data\\homes\\dsh',
    homeOptions: () => homes,
    homeOptionLabel: (home) => home,
    PLUGIN_HOME_MANAGE: '__manage__',
    syncUiSelect: () => { calls.synced += 1 },
  })
  vm.runInContext(functionSource('paintLaunchHomeCustom'), context)
  return { context, select, calls }
}

test('会话隔离的目录下拉：自动新建排第一、登记目录跟后面、管理目录垫底，选中值保留', () => {
  const { context, select, calls } = homeCustomHarness({ current: 'D:\\a' })
  context.paintLaunchHomeCustom()
  const autoAt = select.innerHTML.indexOf('<option value="">自动新建（')
  const firstHomeAt = select.innerHTML.indexOf('D:\\a')
  const manageAt = select.innerHTML.indexOf('__manage__')
  assert.ok(autoAt === 0, '「自动新建」是第一条')
  assert.ok(select.innerHTML.includes('C:\\data\\homes\\dsh'), '自动新建的文案亮出会建在哪')
  assert.ok(autoAt < firstHomeAt && firstHomeAt < manageAt, '顺序：自动新建 → 登记目录 → 管理目录')
  assert.equal(select.value, 'D:\\a', '已选目录保持选中')
  assert.equal(calls.synced, 1, '铺完要同步 ui-select 触发器')

  // 哨兵值不能留在 select 上，否则保存时会把「__manage__」当目录发出去
  const sentinel = homeCustomHarness({ current: '__manage__' })
  sentinel.context.paintLaunchHomeCustom()
  assert.equal(sentinel.select.value, '')
})

test('「打开启动器时启动」三份互相同步：折叠里勾了保存也生效，打开弹窗按启动项回填', () => {
  const sync = section('    function syncLaunchAutoLaunch(checked) {', '    /**')
  assert.match(sync, /for \(const box of \[launchAutoLaunchEl, launchAutoLaunchProfileEl, launchAutoLaunchHomeEl\]\)/, '三份一起同步')
  assert.match(sync, /box\.onchange = \(\) => syncLaunchAutoLaunch\(box\.checked\)/, '勾任意一份都同步到其它两份')
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /syncLaunchAutoLaunch\(entry\?\.autoLaunch === true\)/, '打开弹窗按启动项回填三份开关')
  // 保存只读主开关（#launchAutoLaunch），所以折叠里那份勾上后也一定能带出去
  assert.match(section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async'), /autoLaunch: launchAutoLaunchEl\.checked/)

  // vm：勾任意一份，三份一起变
  const boxes = [{ checked: false }, { checked: false }, { checked: false }]
  const context = vm.createContext({ launchAutoLaunchEl: boxes[0], launchAutoLaunchProfileEl: boxes[1], launchAutoLaunchHomeEl: boxes[2] })
  vm.runInContext(functionSource('syncLaunchAutoLaunch'), context)
  context.syncLaunchAutoLaunch(true)
  assert.deepEqual(boxes.map((box) => box.checked), [true, true, true])
  context.syncLaunchAutoLaunch(false)
  assert.deepEqual(boxes.map((box) => box.checked), [false, false, false])
})

test('折叠开合走高度动画：展开从 0 长到内容高度，收起缩回再隐藏，减少动态时直接跳', () => {
  const build = (reduceMotion = false) => {
    const state = { expanded: 'false', classes: new Set(), animations: [] }
    const panel = {
      hidden: true,
      style: {},
      scrollHeight: 120,
      animate(keyframes, options) {
        const animation = { keyframes, options, cancelled: false, onfinish: null, cancel() { this.cancelled = true } }
        state.animations.push(animation)
        return animation
      },
      getAnimations() { return state.animations.filter((animation) => !animation.cancelled) },
    }
    const toggle = { getAttribute: () => state.expanded, setAttribute: (_, value) => { state.expanded = value } }
    const box = {
      querySelector: (selector) => (selector.includes('toggle') ? toggle : panel),
      classList: { toggle(name, on) { if (on) state.classes.add(name); else state.classes.delete(name) } },
    }
    const context = vm.createContext({
      document: { documentElement: { classList: { contains: () => reduceMotion } } },
      launchProfileAdvancedEl: box,
    })
    vm.runInContext(functionSource('prefersReducedMotion'), context)
    vm.runInContext(functionSource('setLaunchAdvanced'), context)
    return { context, state, panel }
  }

  const opened = build()
  opened.context.setLaunchAdvanced(opened.context.launchProfileAdvancedEl, true)
  assert.equal(opened.state.expanded, 'true', '按钮 aria-expanded 跟着翻')
  assert.ok(opened.state.classes.has('is-open'), '箭头靠 is-open 转向')
  assert.equal(opened.panel.hidden, false, '展开时面板先放出来才能量高度')
  const openAnimation = opened.state.animations[0]
  assert.deepEqual(Array.from(openAnimation.keyframes, (frame) => frame.height), ['0px', '120px'], '从 0 长到实际高度')
  assert.equal(openAnimation.options.duration, 220)
  openAnimation.onfinish()
  assert.equal(opened.panel.style.height, '', '动画收尾清掉临时高度，交回内容自适应')

  opened.context.setLaunchAdvanced(opened.context.launchProfileAdvancedEl, false)
  const closeAnimation = opened.state.animations[1]
  assert.deepEqual(Array.from(closeAnimation.keyframes, (frame) => frame.height), ['120px', '0px'], '收起缩回 0')
  assert.equal(opened.panel.hidden, false, '收起动画期间面板还在')
  closeAnimation.onfinish()
  assert.equal(opened.panel.hidden, true, '收起动画结束才隐藏')
  assert.equal(opened.state.classes.has('is-open'), false)

  // 打开弹窗复位：只翻状态，不做动画
  const instant = build()
  instant.context.setLaunchAdvanced(instant.context.launchProfileAdvancedEl, false, false)
  assert.equal(instant.panel.hidden, true)
  assert.equal(instant.state.animations.length, 0, '复位不做动画')

  // 减少动态：一样直接跳，不排动画
  const reduced = build(true)
  reduced.context.setLaunchAdvanced(reduced.context.launchProfileAdvancedEl, true)
  assert.equal(reduced.panel.hidden, false)
  assert.equal(reduced.state.animations.length, 0, '减少动态时跳过高度动画')

  // 点击折叠头 = 取反当前 aria-expanded
  assert.match(page, /toggle\.onclick = \(\) => setLaunchAdvanced\(box, toggle\.getAttribute\('aria-expanded'\) !== 'true'\)/)
})

test('保存与打开弹窗的接线：新建走引导时名字也代填，带 ensureProfile；编辑/自定义仍用原来的下拉值', () => {
  const submit = section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async')
  assert.match(submit, /const guided = !editingLaunchId && launchIsolation !== 'custom'/)
  assert.match(submit, /prepareGuidedLaunch\(\)/)
  assert.match(submit, /name: guided \? target\.name : launchNameEl\.value/)
  assert.match(submit, /\.\.\.\(guided \? \{ ensureProfile: true \} : \{\}\)/)
  assert.match(submit, /guided \? target\.profile : launchProfile/)
  // 项目环境：数据目录由项目推导，编辑时填了项目目录就不再传下拉值；workdir 一路带到保存接口
  assert.match(submit, /dshHome: guided \? target\.dshHome : \(String\(launchWorkdirEl\.value \|\| ''\)\.trim\(\) \? '' : launchDshHomeEl\.value\.trim\(\)\)/)
  assert.match(submit, /workdir: guided \? \(target\.workdir \|\| ''\) : launchWorkdirEl\.value\.trim\(\)/)
  assert.match(submit, /\.\.\.\(guided && target\.copyFrom \? \{ copyFrom: target\.copyFrom \} : \{\}\)/, '复制来源只在引导档里传')
  // 引导模式不再刷新下拉（新目录/新 Profile 由服务端处理），编辑和自定义才刷新
  assert.match(submit, /if \(!guided && !await refreshLaunchHomeProfiles\(true\)\) return/)

  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /setLaunchIsolation\(entry \? 'custom' : launchIsolationSaved, !entry\)/, '新建用上次保存的档，编辑直接落自定义档')
})

test('记住上次选的档：打开「添加启动项」落在保存过的档，切档时顺手存回设置', () => {
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /setLaunchIsolation\(entry \? 'custom' : launchIsolationSaved, !entry\)/, '新建从上次那一档开始')
  const click = section('    launchIsolationFieldEl.onclick =', '    async function prepareGuidedLaunch(')
  assert.match(click, /if \(editingLaunchId\) return/, '编辑老启动项时不写偏好')
  assert.match(click, /launchIsolationSaved = launchIsolation/, '本地也立刻记住，不等写盘回来')
  assert.match(click, /queueSetting\('launchIsolation', launchIsolation\)/, '切档后记住这一档')
  // 写盘回来以服务端归一化后的值为准
  const flush = section('    async function flushSettings() {', '    function queueSetting(key, value) {')
  assert.match(flush, /if \(!\('launchIsolation' in data\)\) throw new Error/)
  assert.match(flush, /launchIsolationSaved = data\.launchIsolation === 'home' \|\| data\.launchIsolation === 'custom' \? data\.launchIsolation : 'profile'/)
  // 设置加载时回填：服务端只回三档，脏值当插件隔离
  const fill = section('    function fillSettings(data) {', '    function loadSettings()')
  assert.match(fill, /'launchIsolation' in data/)
  assert.match(fill, /launchIsolationSaved = data\.launchIsolation === 'home' \|\| data\.launchIsolation === 'custom' \? data\.launchIsolation : 'profile'/)
})

test('动效接线：胶囊浮块滑动、字段淡入、说明行淡入，都尊重「减少动态」', () => {
  assert.match(css, /\.launch-isolation-tabs::after \{[^}]*transition: transform 240ms/, '胶囊浮块滑动得有过渡')
  assert.match(css, /\.launch-custom-fields:not\(\[hidden\]\) \{ animation: launch-custom-in/, '切到自定义时字段淡入')
  assert.match(css, /#launchIsolationHint\.isolation-hint-in \{ animation: launch-isolation-hint-in/, '换档时说明行淡入')
  assert.match(css, /html\.reduce-motion #launchIsolationHint\.isolation-hint-in \{ animation: none; \}/, '减少动态时不做动画')
  assert.match(css, /html\.reduce-motion \.launch-isolation-tabs::after,\nhtml\.reduce-motion \.launch-isolation-tab,\nhtml\.reduce-motion \.launch-isolation-advanced-chevron \{ transition: none; \}/, '浮块和折叠箭头的过渡都尊重减少动态')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, '系统级减少动态也要跟着关掉')
  assert.match(css, /  \.launch-isolation-tabs::after,\n  \.launch-isolation-tab, \.launch-isolation-advanced-chevron \{ transition: none; \}/, '系统级减少动态时浮块直接跳')
  const paint = section('    function paintLaunchIsolation() {', '    launchIsolationFieldEl.onclick =')
  assert.match(paint, /tab\.setAttribute\('aria-selected'/, '当前档靠 aria-selected，样式跟着它走')
  assert.match(paint, /tabsEl\.dataset\.active = launchIsolation/, '浮块位置靠 data-active 平移')
  assert.match(paint, /if \(launchIsolationHintEl\.textContent === hint\) return/, '文字相同就不重播动画')
  assert.match(paint, /classList\.remove\('isolation-hint-in'\)\n\s+void launchIsolationHintEl\.offsetWidth\n\s+launchIsolationHintEl\.classList\.add\('isolation-hint-in'\)/, '重播动画前先复位，避免连点不触发')
  // tab 点击 = 切档：只认带 data-isolation 的按钮，避免点到容器也触发
  assert.match(page, /event\.target\.closest\?\.\('\.launch-isolation-tab'\)/)
  assert.match(page, /setLaunchIsolation\(tab\.dataset\.isolation\)/)
})

test('项目环境：选了项目目录就把数据目录算成 <项目>/.dsh，不登记成普通用户目录', async () => {
  const h = guidedHarness({ mode: 'home', projectDir: 'D:/projects/app' })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.workdir, 'D:/projects/app', '项目目录要一路带到保存接口')
  assert.equal(String(target.dshHome).replace(/\\/g, '/'), 'D:/projects/app/.dsh', '数据目录固定在项目里')
  assert.equal(target.profile, 'web')
  assert.equal(target.name, 'app', '启动项名字取项目目录最后一段')
  assert.deepEqual(h.calls.posts, [], '项目数据目录不进「管理目录」登记表')
})

test('从已有 Profile 复制：来源目录 + Profile 一起带进保存接口，名字沿用来源', async () => {
  const h = guidedHarness({ mode: 'profile', copyHome: 'C:/global', copyProfile: 'ios-dev', profiles: ['web', 'ios-dev'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.profile, 'ios-dev')
  assert.equal(target.name, 'ios-dev')
  // 跨 realm 的对象原型不同，deepEqual 会较真，逐字段比更实在
  assert.equal(target.copyFrom?.profile, 'ios-dev', '复制来源的 Profile')
  assert.equal(target.copyFrom?.home, 'C:/global', '复制来源的目录')
  assert.deepEqual(h.calls.posts, [], '复制由保存接口一次完成，页面不先建 Profile')
})

test('项目环境也能从已有 Profile 复制：两个选择互不顶替', async () => {
  const h = guidedHarness({ mode: 'home', projectDir: 'D:/projects/app', copyProfile: 'ios-dev', copyHome: 'C:/global', profiles: ['web', 'ios-dev'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.workdir, 'D:/projects/app')
  // 跨 realm 的对象原型不同，deepEqual 会较真，逐字段比更实在
  assert.equal(target.copyFrom?.profile, 'ios-dev', '复制来源的 Profile')
  assert.equal(target.copyFrom?.home, 'C:/global', '复制来源的目录')
  assert.equal(target.profile, 'ios-dev')
})
