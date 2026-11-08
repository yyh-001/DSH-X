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
  '版本、端口和启动环境都在这里手动选；点「启动环境」换目录或 Profile，左栏「+」加目录。',
  '新建 Profile', '自定义目录', '自动新建（{path}）',
  'Profile 名称，留空用 web',
  '这个 Profile 不能启动网页，换一个名称',
  '编辑 Profile…',
  'Profile「{profile}」还没初始化：先用它启动一次，dsh 会建好这个环境，之后就能在这里编辑。',
  // 复制档：说清复制范围 + 目标名的几条错误
  '把「{profile}」复制成新的 Profile「{name}」：插件与配置跟过来，技能、Prompt 管理和会话不跟。',
  '先选一份要复制的 Profile：左边挑用户目录，右边挑 Profile；复制出来的环境从空白会话开始。',
  '「{name}」是系统保留名称，换个 Profile 名称（例如 {name}-copy）。',
  '目标名字不能和来源「{profile}」一样，换一个 Profile 名称。',
  '全局目录里已经有「{name}」，换个名字再复制。',
  '这个目录里已经有「{profile}」，换个名字再复制。',
  '（待定）',
  // 失效目录名
  '失效的目录名', '清除这个失效的目录名',
]

test('三档 tab：默认插件隔离，顺序固定，tab 带无障碍角色和选中态', () => {
  const dialog = section('id="launchDialog"', '</form>')
  assert.match(dialog, /<div class="launch-isolation" id="launchIsolationField">/)
  assert.match(dialog, /<div class="launch-isolation-tabs" id="launchIsolationTabs" role="tablist" aria-label="隔离方式"[^>]*data-active="profile">/, '浮块默认停在插件隔离')
  const tabs = [...dialog.matchAll(/<button class="launch-isolation-tab"[^>]*data-isolation="(profile|home|custom)"[^>]*>/g)]
  assert.deepEqual(tabs.map((match) => match[1]), ['profile', 'home', 'custom'], 'tab 顺序：插件隔离 → 会话隔离 → 自定义')
  assert.equal((dialog.match(/<button class="launch-isolation-tab" type="button" role="tab" data-isolation=/g) || []).length, 3, '三个 tab 都要 role=tab')
  assert.equal((dialog.match(/aria-selected="true"/g) || []).length, 2, '两排 tab 各有一档选中')
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

test('前两档下面挂一条两档 tab：自己起名 / 从已有 Profile 复制，同一时间只露一块', () => {
  const isolation = section('<div class="launch-isolation" id="launchIsolationField">', '<div class="launch-custom-fields" id="launchCustomFields">')
  // 引导块夹在说明行和完整表单之间，不打断原来的字段顺序
  assert.ok(isolation.indexOf('id="launchIsolationHint"') < isolation.indexOf('id="launchGuideField"'), '引导块放在说明行下面')
  assert.match(isolation, /<div class="launch-guide" id="launchGuideField">/)
  // 两档 tab 跟上面三档同款胶囊，只是等分两份；data-active 取值（name / copy）跟三档的错开
  assert.match(isolation, /<div class="launch-isolation-tabs launch-isolation-tabs--pair" id="launchSourceTabs" role="tablist" aria-label="Profile 来源"[^>]*data-active="name">/)
  const tabs = [...isolation.matchAll(/<button class="launch-isolation-tab launch-source-tab"[^>]*data-source="(name|copy)"[^>]*>/g)]
  assert.deepEqual(tabs.map((match) => match[1]), ['name', 'copy'], 'tab 顺序：新建 Profile → 从已有 Profile 复制')
  assert.match(isolation, /data-source="name" aria-selected="true" aria-controls="launchSourceNamePanel"/, '默认停在自己起名那档')
  assert.match(isolation, /data-source="copy" aria-selected="false" aria-controls="launchSourceCopyPanel"/)
  for (const label of ['新建 Profile', '从已有 Profile 复制']) {
    assert.ok(isolation.includes(`data-i18n="${label}">${label}</button>`), `tab 文案要有中英翻译：${label}`)
  }
  // 面板：名字那档默认露出来，复制来源那块先藏着
  assert.match(isolation, /<div class="launch-source-panel" id="launchSourceNamePanel" role="tabpanel">/)
  assert.match(isolation, /<div class="launch-source-panel" id="launchSourceCopyPanel" role="tabpanel" hidden>/)
  // 名字输入两档各一个：插件隔离改 Profile 名，会话隔离给新目录里的 Profile 取名
  assert.match(isolation, /id="launchProfileCustom"[^>]*aria-label="Profile 名称"/, '没有可见 label，读屏靠 aria-label')
  assert.match(isolation, /id="launchHomeProfile"[^>]*aria-label="Profile 名称"/)
  // 会话隔离的目标目录在 tab 上面：它说的是「建到哪」，跟「Profile 从哪来」是两件事
  assert.match(isolation, /id="launchGuideDirField">\s*<select id="launchHomeCustom" aria-label="dsh 用户目录"[^>]*><\/select>/)
  assert.ok(isolation.indexOf('id="launchHomeCustom"') < isolation.indexOf('id="launchSourceTabs"'), '目录在 tab 上面')
  // 复制来源不再用两串下拉：一行按钮打开两栏选择窗（见下面专门的用例）
  assert.match(isolation, /id="launchSourceCopyPanel"[\s\S]*id="launchCopyPick" aria-haspopup="dialog"[\s\S]*id="launchCopyPickValue"/)
  assert.ok(!isolation.includes('id="launchCopyHome"'), '来源目录不再是下拉')
  assert.ok(!isolation.includes('id="launchCopyProfile"'), '来源 Profile 不再是下拉')
  // 自动启动跟「Profile 从哪来」无关，两档共用一份，不跟着隐藏
  assert.match(isolation, /<input id="launchAutoLaunchGuided" type="checkbox"/)
  assert.ok(!isolation.includes('id="launchAutoLaunchHome"'), '不再每档各放一份自动启动开关')
  // 旧的折叠条整套撤掉：不再有标题横条和箭头
  assert.ok(!isolation.includes('launch-isolation-advanced'))
  assert.ok(!isolation.includes('自定义目录'), '标题变成 tab，不再有「自定义目录」那条横条')
})

test('自定义档是可显隐的字段块：原来那张完整表单原样搬进来，id 一个没改', () => {
  const fields = section('<div class="launch-custom-fields" id="launchCustomFields">', '<!-- /launch-custom-fields -->')
  assert.match(fields, /id="versionPicker"[\s\S]*id="launchUpdateChannel"/, '版本行也在里面')
  assert.match(fields, /id="launchIdentityField"[\s\S]*id="launchName"/)
  // 用户目录 + Profile 合并成一个「启动环境」触发器，两个下拉藏在同一格里当真相源
  assert.match(fields, /id="launchEnvField"[\s\S]*<label for="launchEnvPick"[\s\S]*id="launchEnvPick" aria-haspopup="dialog"[\s\S]*id="launchEnvPickValue"[\s\S]*<select id="launchDshHome"[^>]*hidden><\/select>[\s\S]*<select id="launchProfile" title="Profile" hidden><\/select>/, '环境选择窗触发器 + 两个隐藏下拉')
  assert.ok(!fields.includes('id="launchHomeSelectField"'), '目录下拉不再单独占一行')
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
  // 引导块：第二排胶囊等分两份，浮块滑到「复制」那档；面板是网格，切 tab 淡入
  assert.match(css, /\.launch-guide \{ display: grid; gap: 8px; \}/)
  assert.match(css, /\.launch-guide\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-guide-dir\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-guide \.ui-select \{ width: 100%; \}/, '目标目录下拉要占满（.ui-select 默认 148px 太窄）')
  assert.match(css, /\.launch-isolation-tabs--pair::after \{ width: calc\(\(100% - 10px\) \/ 2\); \}/, '浮块等分两份')
  assert.match(css, /\.launch-isolation-tabs--pair\[data-active="copy"\]::after \{ transform: translateX\(calc\(100% \+ 2px\)\); \}/)
  assert.match(css, /\.launch-source-panel \{ display: grid; gap: 8px; \}/)
  assert.match(css, /\.launch-source-panel\[hidden\] \{ display: none; \}/)
  assert.match(css, /\.launch-source-panel:not\(\[hidden\]\) \{ animation: launch-source-in/, '切 tab 时面板淡入')
  // 目录改成下拉后，输入框那套行样式一并撤掉
  assert.ok(!css.includes('.launch-home-path-row'), '目录改成下拉后不再需要输入框那一行')
  assert.ok(!css.includes('.launch-isolation-option'), '旧的单选卡片样式换成了 tab')
  assert.ok(!css.includes('.launch-isolation-advanced'), '旧的折叠条样式整套撤掉')
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
    launchGuideFieldEl: { hidden: false },
    launchGuideDirFieldEl: { hidden: false },
    launchProfileCustomEl: { hidden: false, value: '' },
    launchHomeProfileEl: { hidden: false, value: '' },
    launchNameEl: { value: '', required: true },
    launchNameAuto: '',
    launchRecoverEl: { hidden: false },
    state: { profiles: [] },
  })
  vm.runInContext(
    [
      functionSource('guidedProfileNameEl'),
      functionSource('selectedCopy'),
      functionSource('suggestCopyProfile'),
      functionSource('fillCopyProfileName'),
      functionSource('fillGuidedLaunchName'),
      functionSource('setLaunchIsolation'),
    ].join('\n'),
    context,
  )
  context.launchSourceMode = 'name'
  context.launchCopySource = null
  context.launchCopyNameAuto = { profile: '', home: '' }
  return { context, calls }
}

test('切档只改可见性：前两档收起字段块、名字代填，自定义档把原表单还回来', () => {
  const { context, calls } = isolationHarness()

  context.setLaunchIsolation('profile', true)
  assert.equal(context.launchIsolationFieldEl.hidden, false, '新建时 tab 要露出来')
  assert.equal(context.launchCustomFieldsEl.hidden, true, '插件隔离什么都不用填')
  assert.equal(context.launchGuideFieldEl.hidden, false, '插件隔离的引导块露出来')
  assert.equal(context.launchGuideDirFieldEl.hidden, true, '插件隔离沿用全局目录，没得挑')
  assert.equal(context.launchProfileCustomEl.hidden, false, '名字输入给插件隔离用')
  assert.equal(context.launchHomeProfileEl.hidden, true, '另一档的名字输入不露')
  assert.equal(context.launchNameEl.value, 'auto-name', '名字代填好，用户不用填')
  assert.equal(context.launchNameEl.required, false, '藏起来的名称输入不能拦着提交')
  assert.equal(context.launchRecoverEl.hidden, true, '一键新建没什么可修的，修复环境按钮不露')
  assert.ok(calls.paint > 0, '切档后要重画选中态和说明')

  context.launchNameEl.value = ''
  context.setLaunchIsolation('home', true)
  assert.equal(context.launchCustomFieldsEl.hidden, true, '会话隔离同样什么都不用填')
  assert.equal(context.launchGuideFieldEl.hidden, false)
  assert.equal(context.launchGuideDirFieldEl.hidden, false, '会话隔离要挑建到哪个目录')
  assert.equal(context.launchProfileCustomEl.hidden, true)
  assert.equal(context.launchHomeProfileEl.hidden, false, '会话隔离的名字输入露出来')
  assert.equal(context.launchNameEl.value, 'auto-name')

  context.setLaunchIsolation('custom', true)
  assert.equal(context.launchCustomFieldsEl.hidden, false, '自定义档把完整表单还回来')
  assert.equal(context.launchGuideFieldEl.hidden, true, '完整表单里不重复给引导块')
  assert.equal(context.launchNameEl.required, true, '自定义档名称仍然是必填')
  assert.equal(context.launchRecoverEl.hidden, false, '自定义档照旧给修复环境入口')
})

test('编辑已有启动项不显示隔离 tab，字段块直接露出来', () => {
  const { context, calls } = isolationHarness()
  context.launchNameEl.value = '我的工作环境'
  context.setLaunchIsolation('custom', false)
  assert.equal(context.launchIsolationFieldEl.hidden, true, '编辑老启动项时引导整块收起')
  assert.equal(context.launchCustomFieldsEl.hidden, false, '手填字段不能藏起来')
  assert.equal(context.launchGuideFieldEl.hidden, true, '编辑时引导块跟着收起')
  assert.equal(context.launchNameEl.value, '我的工作环境', '编辑时不代填名字')
  assert.equal(context.launchNameEl.required, true)
  assert.equal(calls.autoNames, 0, '编辑不调用代填')
})

/** prepareGuidedLaunch 的 vm 环境：真实建议值函数 + 接口收集桩，验证它算出什么、发了哪些请求。 */
function guidedHarness({ mode, dataDir = 'C:\\data', dshHomes = [], profiles = ['web'], webProfiles = ['web'], home, profileCustom = '', homeCustom = '', homeProfile = '', copyHome = '', copyProfile = '' } = {}) {
  const calls = { gets: [], posts: [] }
  const context = vm.createContext({
    t: (text) => text,
    state: { dataDir, dshHome: 'C:\\global', dshHomes, profiles, webProfiles },
    launchEntries: () => [],
    launchProfile: 'web',
    launchProfileCustomEl: { value: profileCustom },
    launchHomeCustomEl: { value: homeCustom },
    launchHomeProfileEl: { value: homeProfile },
    PLUGIN_HOME_MANAGE: '__manage__',
    getJson: async (url) => {
      calls.gets.push(url)
      const requested = url.includes('home=') ? decodeURIComponent(url.slice(url.indexOf('home=') + 5)) : ''
      return { home: home ?? (requested || 'C:\\global'), profiles, webProfiles }
    },
    post: async (url, body) => { calls.posts.push([url, body]); return { ok: true } },
  })
  context.launchIsolation = mode
  // 第二排来源 tab：选好了来源（两栏选择窗「用它」写回的状态）才走 copy 分支
  context.launchSourceMode = copyProfile ? 'copy' : 'name'
  context.launchCopySource = copyProfile ? { home: copyHome, profile: copyProfile } : null
  vm.runInContext(
    `${pathHelpers}\n${functionSource('suggestIsolatedHome')}\n${functionSource('suggestIsolatedProfile')}
${functionSource('suggestCopyProfile')}
${functionSource('guidedProfileNameEl')}
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

test('名字或目录填了就用填的：Profile 名称 / 目录 / Profile 都能覆盖自动取名', async () => {
  //插件隔离：填一个没占用的名字，就用它
  const named = guidedHarness({ mode: 'profile', profileCustom: 'dev' })
  const target = await named.context.prepareGuidedLaunch()
  assert.deepEqual({ name: target.name, profile: target.profile, dshHome: target.dshHome }, { name: 'dev', profile: 'dev', dshHome: '' })

  // 已存在但不起网页的 Profile 选了也开不了页面，先拦下来
  const notWeb = guidedHarness({ mode: 'profile', profiles: ['web', 'job'], profileCustom: 'job' })
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

  // 自定义目录里已有的非网页 Profile 也拦（不能用 headless：那是保留名，会先被保留名检查挡下）
  const notWebHome = guidedHarness({ mode: 'home', homeCustom: 'D:\\custom\\dsh', homeProfile: 'job', profiles: ['web', 'job'] })
  await assert.rejects(notWebHome.context.prepareGuidedLaunch(), /不能启动网页/)
})

test('引导接线：说明行/占位符随档刷新、目录下拉由登记目录铺开、打开新建时清空上次填的值', () => {
  const paint = section('    function paintLaunchIsolation() {', '    // 名字边打边更新说明行')
  assert.match(paint, /tabsEl\.dataset\.active = launchIsolation/, '切档把胶囊浮块滑到对应位置')
  assert.match(paint, /paintLaunchHomeCustom\(\)/, '切档时重画目录下拉（第一项跟着自动目录变）')
  assert.match(paint, /launchProfileCustomEl\.placeholder = suggestIsolatedProfile\(\)/, 'Profile 名称占位符就是自动会取的名字')
  assert.match(paint, /launchHomeProfileEl\.placeholder = t\('Profile 名称，留空用 web'\)/)
  assert.match(paint, /paintLaunchHint\(\)/, '说明行由单独的函数画（改名字时只重画它）')
  // 名字边打边更新：说明行和启动项名都跟着变
  const typing = section('    for (const input of [launchProfileCustomEl, launchHomeProfileEl]) {', '    // 两排 tab 共用一个容器')
  assert.match(typing, /input\.oninput = \(\) => \{/, '两个名字输入都要接线')
  assert.match(typing, /fillGuidedLaunchName\(\)/)
  assert.match(typing, /paintLaunchHint\(\)/)
  const homePaint = section('    function paintLaunchHomeCustom() {', '    launchHomeCustomEl.onchange = () => {')
  assert.match(homePaint, /const auto = t\('自动新建（\{path\}）', \{ path: suggestIsolatedHome\(\) \|\| t\('数据目录'\) \}\)/, '第一项亮出自动会建的目录')
  // homeOptions 是 Map：按 [路径, 名字] 解构，否则 String(一对) 会变成「路径,名字」
  assert.match(homePaint, /for \(const \[home, name\] of homeOptions\(current\)\)/, '登记过的目录都能选')
  assert.match(homePaint, /homeOptionLabel\(home, name\)/, '选项文字用登记名，不是整对值')
  assert.match(homePaint, /options\.push\(`<option value="\$\{PLUGIN_HOME_MANAGE\}">/, '管理目录放最后')
  assert.match(homePaint, /syncUiSelect\(launchHomeCustomEl\)/, '重铺后要同步 ui-select 触发器')
  const manage = section('    launchHomeCustomEl.onchange = () => {', '    /**')
  assert.match(manage, /openPluginHomesDialog\(\)/, '选「管理目录…」打开目录管理弹窗')
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /launchProfileCustomEl\.value = ''/, '每次打开都清掉上次引导里填的值')
  assert.match(open, /launchHomeCustomEl\.value = ''/)
  assert.match(open, /launchHomeProfileEl\.value = ''/)
  assert.match(open, /launchCopyNameAuto\.profile = ''/, '复制档代填过的名字也要忘掉')
  assert.match(open, /launchSourceMode = 'name'/, '第二排 tab 回到「新建 Profile」')
  assert.match(open, /paintLaunchSource\(\)/, '复位后连面板一起重画')
})

/** paintLaunchHomeCustom 的 vm 环境：真实铺选项逻辑 + 桩掉的页面函数。 */
function homeCustomHarness({ current = '', homes = [['D:\\a', '工作'], ['D:\\b', 'D:\\b']] } = {}) {
  const calls = { synced: 0 }
  const select = { value: current, innerHTML: '' }
  const context = vm.createContext({
    launchHomeCustomEl: select,
    t: (text, vars) => (vars ? Object.entries(vars).reduce((out, [key, value]) => out.split(`{${key}}`).join(value), text) : text),
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    suggestIsolatedHome: () => 'C:\\data\\homes\\dsh',
    // homeOptions 就是 Map：拿真实形状喂进去，才测得出「把一对拼成路径」那类错
    homeOptions: () => new Map(homes),
    homeOptionLabel: (home, name) => (!name || name === home ? home : `${name}（${home}）`),
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

  // 选项值必须是干净的路径：曾经把 Map 的一对 [路径, 名字] 当成 home，值成了「路径,名字」，
  // 保存时就在盘上建出一个带逗号的畸形目录
  assert.ok(select.innerHTML.includes('<option value="D:\\a">工作（D:\\a）</option>'), '有名字的目录用登记名')
  assert.ok(select.innerHTML.includes('<option value="D:\\b">D:\\b</option>'), '没名字的目录只写路径')
  assert.doesNotMatch(select.innerHTML, /D:\\a,|D:\\b,|,工作/, '选项值里不能出现「路径,名字」')

  // 哨兵值不能留在 select 上，否则保存时会把「__manage__」当目录发出去
  const sentinel = homeCustomHarness({ current: '__manage__' })
  sentinel.context.paintLaunchHomeCustom()
  assert.equal(sentinel.select.value, '')
})

test('「打开启动器时启动」两份互相同步：引导块勾了保存也生效，打开弹窗按启动项回填', () => {
  const sync = section('    function syncLaunchAutoLaunch(checked) {', '    /**')
  assert.match(sync, /for \(const box of \[launchAutoLaunchEl, launchAutoLaunchGuidedEl\]\)/, '两份一起同步')
  assert.match(sync, /box\.onchange = \(\) => syncLaunchAutoLaunch\(box\.checked\)/, '勾任意一份都同步到另一份')
  const open = section('    function openLaunchEditor(entry) {', '    async function closeLaunchEditor()')
  assert.match(open, /syncLaunchAutoLaunch\(entry\?\.autoLaunch === true\)/, '打开弹窗按启动项回填两份开关')
  // 保存只读主开关（#launchAutoLaunch），所以引导块里那份勾上后也一定能带出去
  assert.match(section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async'), /autoLaunch: launchAutoLaunchEl\.checked/)

  // vm：勾任意一份，两份一起变
  const boxes = [{ checked: false }, { checked: false }]
  const context = vm.createContext({ launchAutoLaunchEl: boxes[0], launchAutoLaunchGuidedEl: boxes[1] })
  vm.runInContext(functionSource('syncLaunchAutoLaunch'), context)
  context.syncLaunchAutoLaunch(true)
  assert.deepEqual(boxes.map((box) => box.checked), [true, true])
  context.syncLaunchAutoLaunch(false)
  assert.deepEqual(boxes.map((box) => box.checked), [false, false])
})

test('两档 tab 只换来源面板：浮块按 data-active 平移，选中态各排各的，名字两档共用', () => {
  const paint = section('    function paintLaunchSource() {', '    /** 切第二排 tab')
  assert.match(paint, /launchSourceTabsEl\.dataset\.active = launchSourceMode/, '浮块位置靠 data-active')
  assert.match(paint, /tab\.dataset\.source === launchSourceMode/, '当前档靠 aria-selected，样式跟着它走')
  assert.doesNotMatch(paint, /launchSourceNamePanelEl/, '名字那块两档都露着，不跟着 tab 藏')
  assert.match(paint, /launchSourceCopyPanelEl\.hidden = launchSourceMode !== 'copy'/, '只有来源选择跟着 tab 走')
  const set = section('    function setLaunchSource(mode) {', '    /**')
  assert.match(set, /launchSourceMode = mode === 'copy' \? 'copy' : 'name'/, '只认两档，别的值当自己起名')
  assert.match(set, /if \(launchSourceMode === 'copy' && !launchCopySource\) launchCopySource = defaultCopySource\(\)/, '第一次切到复制那档默认「全局目录 › web」')
  assert.match(set, /paintLaunchSource\(\)/)
  assert.match(set, /fillCopyProfileName\(\)/, '切到复制档要代填「来源-copy」')
  assert.match(set, /paintLaunchIsolation\(\)/, '说明行跟着换（选了复制要说清复制的是谁）')
  // 同一个容器里两排 tab：先认第二排，再认隔离方式那排
  assert.match(page, /const source = event\.target\.closest\?\.\('\.launch-source-tab'\)/)
  assert.match(page, /setLaunchSource\(source\.dataset\.source\)/)
  // 复制来源只在停在「从已有 Profile 复制」时才算数
  const copy = section('    function selectedCopy() {', '    /**')
  assert.match(copy, /if \(launchSourceMode !== 'copy' \|\| !launchCopySource\) return null/, '切回自己起名那档就不再复制')
  assert.match(copy, /profile: launchCopySource\.profile, home: launchCopySource\.home/, '来源是选择窗写回的状态，不再读下拉')
  const prepare = section('    async function prepareGuidedLaunch() {', '    /**\n     * 版本比较')
  assert.match(prepare, /const typed = String\(guidedProfileNameEl\(\)\?\.value \|\| ''\)\.trim\(\)/, '名字两档都读')
  assert.match(prepare, /typed \|\| \(copy \? suggestCopyProfile\(copy\.profile\) : ''\) \|\| suggestIsolatedProfile\(\)/, '复制档建议「来源-copy」')
  assert.match(prepare, /if \(launchSourceMode === 'copy' && !copy\) throw new Error\(t\('先选一份要复制的 Profile'\)\)/, '停在复制那档却没来源就不许保存')
  assert.match(prepare, /RESERVED_PROFILE_NAMES\.has\(lower\)/, '保留名在页面就拦住，错误指向名字输入')
  assert.match(prepare, /已经有「\{name\}」，换个名字再复制/, '目标已存在时说清保存会跳过复制')
})

test('选 Profile 是三栏选择窗：目录 / Profile / 插件，两档用途共用一个窗', () => {
  const dialog = section('id="profilePickDialog"', 'id="versionManageDialog"')
  assert.match(dialog, /data-dialog-size="xlarge"/, '三栏要够宽')
  assert.match(dialog, /<div class="profile-pick">[\s\S]*id="profilePickHomes" role="listbox"[\s\S]*id="profilePickProfiles" role="listbox"[\s\S]*id="profilePickDetails"/, '三栏从左到右：目录 → Profile → 插件')
  assert.ok(dialog.indexOf('id="profilePickHomes"') < dialog.indexOf('id="profilePickProfiles"'), '目录在左，Profile 在中')
  assert.ok(dialog.indexOf('id="profilePickProfiles"') < dialog.indexOf('id="profilePickDetails"'), '插件预览在最右')
  assert.match(dialog, /id="profilePickConfirm" type="button" disabled data-i18n="用它"/, '没选好之前「用它」是灰的')
  // 两栏/中栏的动作按钮：目录加、Profile 建/复制
  assert.match(dialog, /id="profilePickHomeAdd" type="button"/)
  assert.match(dialog, /id="profilePickCreate" type="button"/)
  assert.match(dialog, /id="profilePickCopy" type="button"[^>]*disabled/)
  // 复制来源那行：一个按钮打开弹窗，不再是两串下拉；自定义档同样换了触发器
  const panel = section('id="launchSourceCopyPanel"', 'launch-auto-launch')
  assert.match(panel, /id="launchCopyPick" aria-haspopup="dialog"/)
  assert.ok(!panel.includes('<select'), '面板里不再有下拉')

  // 选项铺法：全局目录排第一；起不了网页的仍然列出但不可选
  const paintHomes = section('    function paintPickerHomes() {', '    /**\n     * 中栏的 Profile')
  assert.match(paintHomes, /\[\{ home: '', name: t\('全局目录'\), path: state\.dshHome \|\| '~\/\.dsh' \}\]/, '全局目录排第一，值是空串')
  assert.match(paintHomes, /data-home-open="\$\{escapeHtml\(row\.home\)\}"/, '行尾带打开（全局那行也有）')
  assert.match(paintHomes, /data-home-rename="\$\{escapeHtml\(row\.home\)\}"/, '行尾带重命名')
  assert.match(paintHomes, /data-home-remove="\$\{escapeHtml\(row\.home\)\}"/, '行尾带移除（全局目录那条不给）')
  const paintProfiles = section('    function paintPickerProfiles(loading = true) {', '    /** 点一行 Profile')
  assert.match(paintProfiles, /aria-disabled="\$\{!row\.web\}" \$\{row\.web \? '' : 'disabled'\}/, '起不了网页的不可选')
  assert.match(paintProfiles, /data-profile-rename|data-profile-remove/, '行尾带重命名/删除')
  assert.ok(!page.includes('不复制'), '「不复制」这个选项整套删掉了')

  // 两档用途：标题不同，确认后写到不同地方
  const open = section('    async function openProfilePicker(mode = ', '    function closeProfilePicker() {')
  assert.match(open, /pickerMode = mode === 'form' \? 'form' : 'copy'/)
  assert.match(open, /setPickerHeading\('选择 Profile'/, 'form 档：给自定义档挑')
  assert.match(open, /setPickerHeading\('选择要复制的 Profile'/, 'copy 档：挑复制来源')
  const confirm = section('    function confirmProfilePick() {', '    /**\n     * form 档的写回')
  assert.match(confirm, /if \(pickerMode === 'form'\) \{\s*void applyPickerToLaunchForm\(choice\)/, 'form 档写回启动项表单')
  assert.match(confirm, /launchCopySource = choice/, 'copy 档写回复制来源')
  const apply = section('    async function applyPickerToLaunchForm(', '    /** 选择窗里干活时统一置忙')
  assert.match(apply, /paintLaunchHomes\(home\)/, '目录落到下拉上')
  assert.match(apply, /await refreshLaunchHomeProfiles\(\)/, '按老路重拉这个目录的 Profile')
  assert.match(apply, /launchProfileEl\.value = profile[\s\S]*launchProfileEl\.onchange\(\)/, '最后走原来的 onchange，恢复查询和保存都不用另写')

  // 三栏数据：一次 /api/packs 就带全部 Profile 的插件
  const load = section('    async function loadPickerHome(home) {', '    /** 点左栏某个目录')
  assert.match(load, /getJson\('\/api\/packs', \{ home, launchId: '' \}\)/, '显式指定目录，别落回环境页那份')
  const details = section('    function paintPickerDetails() {', '    /** 一个目录的清单')
  assert.match(details, /row\.pack\.plugins/, '插件行来自 packs')
  assert.match(details, /还没初始化：先用它启动一次/, '没初始化的那份要说清')

  // 选择窗里改 Profile：请求必须按它挑的目录走（空串 = 全局目录，不能落回环境页那份）
  const submit = section("document.getElementById('profileForm').onsubmit = async", '    // ---- Profile 备份与回退 ----')
  assert.match(submit, /profileDialogFromPicker \? \{ home: profileDialogHome, launchId: '' \} : \{\}/, '选择窗里按 pickerHome 请求')
  assert.match(submit, /if \(profileDialogFromPicker\) \{/, '改完要回刷选择窗')
  const remove = section('    async function removePickerProfile(', '     * 当前停在')
  assert.match(remove, /\{ home: pickerHome, launchId: '' \}/, '删除也按选择窗的目录走')
  const openHome = section('    async function openPickerHome(', '     * 中栏的 Profile')
  assert.match(openHome, /post\('\/api\/dsh-homes\/open', \{ home \}\)/, '「打开」走系统文件管理器那条接口')
  assert.match(page, /button\.onclick = \(\) => void openPickerHome\(button\.dataset\.homeOpen\)/, '行尾按钮接到打开')
  // 默认来源：还没有来源时就是全局目录里的 web
  const fallback = section('    function defaultCopySource() {', '    /** 复制来源那行按钮')
  assert.match(fallback, /web\.includes\('web'\) \? 'web' : \(web\[0\] \|\| ''\)/, '有 web 就默认 web，否则挑第一份')
  assert.match(fallback, /return profile \? \{ home: '', profile \} : null/, '空 home = 全局目录')
})

test('两档 tab 的 vm：切档只翻来源面板，复制档把目标名填成「来源-copy」，切走的值留着', () => {
  const tabs = [
    { dataset: { source: 'name' }, selected: 'true', setAttribute(name, value) { this.selected = value } },
    { dataset: { source: 'copy' }, selected: 'false', setAttribute(name, value) { this.selected = value } },
  ]
  const calls = { paint: 0, defaults: 0, names: 0 }
  const context = vm.createContext({
    launchSourceTabsEl: { dataset: {} },
    launchSourceCopyPanelEl: { hidden: true },
    launchCopySource: null,
    launchIsolation: 'profile',
    launchProfileCustomEl: { value: '' },
    launchHomeProfileEl: { value: '' },
    launchNameEl: { value: '' },
    launchNameAuto: '',
    launchCopyNameAuto: { profile: '', home: '' },
    state: { profiles: ['web', 'ios-dev'] },
    defaultCopySource: () => { calls.defaults += 1; return { home: '', profile: 'ios-dev' } },
    guidedLaunchName: () => { calls.names += 1; return context.launchProfileCustomEl.value || 'auto-name' },
    document: { querySelectorAll: () => tabs },
    paintLaunchIsolation: () => { calls.paint += 1 },
  })
  vm.runInContext(
    [
      functionSource('guidedProfileNameEl'),
      functionSource('suggestCopyProfile'),
      functionSource('fillCopyProfileName'),
      functionSource('fillGuidedLaunchName'),
      functionSource('paintLaunchSource'),
      functionSource('setLaunchSource'),
      functionSource('selectedCopy'),
    ].join('\n'),
    context,
  )

  context.setLaunchSource('copy')
  assert.equal(context.launchSourceTabsEl.dataset.active, 'copy', '浮块滑到复制那档')
  assert.deepEqual(tabs.map((tab) => tab.selected), ['false', 'true'], '选中态跟着换')
  assert.equal(context.launchSourceCopyPanelEl.hidden, false, '复制来源露出来')
  assert.equal(context.launchProfileCustomEl.value, 'ios-dev-copy', '目标名预填「来源-copy」')
  assert.equal(context.launchNameEl.value, 'ios-dev-copy', '启动项名跟着目标 Profile 走')
  assert.equal(calls.paint, 1, '切完要重画说明行')
  assert.equal(context.launchCopySource?.profile, 'ios-dev', '第一次切过来就默认「全局目录 › web」那一份')
  assert.equal(calls.defaults, 1, '只补一次默认值')

  // 手动改过的目标名不能被再次切档盖掉
  context.launchProfileCustomEl.value = 'mine'
  context.setLaunchSource('name')
  assert.equal(context.launchSourceCopyPanelEl.hidden, true, '切回自己起名那档，复制来源收起（值不动）')
  context.setLaunchSource('copy')
  assert.equal(calls.defaults, 1, '有来源之后不再取默认值')
  assert.equal(context.launchCopySource?.profile, 'ios-dev', '来源原样留着')
  assert.equal(context.launchProfileCustomEl.value, 'mine', '手填的名字不再被「来源-copy」覆盖')
})

test('保存与打开弹窗的接线：新建走引导时名字也代填，带 ensureProfile；编辑/自定义仍用原来的下拉值', () => {
  const submit = section('    launchFormEl.onsubmit = async', '    launchDeleteEl.onclick = async')
  assert.match(submit, /const guided = !editingLaunchId && launchIsolation !== 'custom'/)
  assert.match(submit, /prepareGuidedLaunch\(\)/)
  assert.match(submit, /name: guided \? target\.name : launchNameEl\.value/)
  assert.match(submit, /\.\.\.\(guided \? \{ ensureProfile: true \} : \{\}\)/)
  assert.match(submit, /guided \? target\.profile : launchProfile/)
  assert.match(submit, /dshHome: guided \? target\.dshHome : launchDshHomeEl\.value\.trim()/)
  assert.doesNotMatch(submit, /workdir:/, '项目目录已经下线，保存不再带 workdir')
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
  assert.match(css, /html\.reduce-motion \.launch-isolation-tabs::after,\nhtml\.reduce-motion \.launch-isolation-tab \{ transition: none; \}/, '浮块的过渡尊重减少动态')
  assert.match(css, /html\.reduce-motion \.launch-source-panel:not\(\[hidden\]\)/, '切 tab 的面板淡入也尊重减少动态')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, '系统级减少动态也要跟着关掉')
  assert.match(css, /  \.launch-isolation-tabs::after,\n  \.launch-isolation-tab \{ transition: none; \}/, '系统级减少动态时浮块直接跳')
  const paint = section('    function paintLaunchIsolation() {', '    // 名字边打边更新说明行')
  assert.match(paint, /tab\.setAttribute\('aria-selected'/, '当前档靠 aria-selected，样式跟着它走')
  assert.match(paint, /tabsEl\.dataset\.active = launchIsolation/, '浮块位置靠 data-active 平移')
  const hint = section('    function paintLaunchHint() {', '    /** tab 选中态、说明行一起刷新')
  assert.match(hint, /if \(launchIsolationHintEl\.textContent === hint\) return/, '文字相同就不重播动画')
  assert.match(hint, /classList\.remove\('isolation-hint-in'\)\n\s+void launchIsolationHintEl\.offsetWidth\n\s+launchIsolationHintEl\.classList\.add\('isolation-hint-in'\)/, '重播动画前先复位，避免连点不触发')
  // tab 点击 = 切档：只认带 data-isolation 的按钮，避免点到容器也触发
  assert.match(page, /event\.target\.closest\?\.\('\.launch-isolation-tab\[data-isolation\]'\)/)
  assert.match(page, /setLaunchIsolation\(tab\.dataset\.isolation\)/)
})

test('从已有 Profile 复制：目标名默认「来源-copy」，来源目录 + Profile 一起带进保存接口', async () => {
  const h = guidedHarness({ mode: 'profile', copyHome: 'C:/global', copyProfile: 'ios-dev', profiles: ['web', 'ios-dev'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.profile, 'ios-dev-copy', '不再沿用来源名：同名的复制会被服务端当成「已存在」')
  assert.equal(target.name, 'ios-dev-copy', '启动项名字跟着新 Profile 走')
  // 跨 realm 的对象原型不同，deepEqual 会较真，逐字段比更实在
  assert.equal(target.copyFrom?.profile, 'ios-dev', '复制来源的 Profile')
  assert.equal(target.copyFrom?.home, 'C:/global', '复制来源的目录')
  assert.deepEqual(h.calls.posts, [], '复制由保存接口一次完成，页面不先建 Profile')

  // 名字输入填了就按填的来（复制档可以改目标名）
  const named = guidedHarness({ mode: 'profile', copyProfile: 'ios-dev', profileCustom: 'ios-2', profiles: ['web', 'ios-dev'] })
  const renamed = await named.context.prepareGuidedLaunch()
  assert.equal(renamed.profile, 'ios-2')
  assert.equal(renamed.copyFrom?.profile, 'ios-dev')
})

test('复制来源是 desktop（保留名）也能用：目标名自动顺延成 desktop-copy', async () => {
  const h = guidedHarness({ mode: 'profile', copyProfile: 'desktop', profiles: ['web', 'desktop'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.profile, 'desktop-copy', '保留名只挡目标，不挡来源')
  assert.equal(target.copyFrom?.profile, 'desktop')
})

test('复制档的坏输入当场说清：保留名、和来源同名、目标已存在都拦在保存之前', async () => {
  // 手填保留名：服务端只会报「系统保留名称」，页面把错误指到名字输入上
  const reserved = guidedHarness({ mode: 'profile', copyProfile: 'ios-dev', profileCustom: 'desktop', profiles: ['web', 'ios-dev'] })
  await assert.rejects(reserved.context.prepareGuidedLaunch(), /系统保留名称/)
  const reservedTemplate = guidedHarness({ mode: 'profile', copyProfile: 'ios-dev', profileCustom: 'web', profiles: ['web', 'ios-dev'] })
  await assert.rejects(reservedTemplate.context.prepareGuidedLaunch(), /系统保留名称/, '复制总是新建：模板名也不能当目标')

  // 同目录同名字 = 拿自己复制自己
  const same = guidedHarness({ mode: 'home', home: 'C:/global', copyHome: '', copyProfile: 'ios-dev', homeProfile: 'ios-dev', profiles: ['web', 'ios-dev'], webProfiles: ['web', 'ios-dev'] })
  await assert.rejects(same.context.prepareGuidedLaunch(), /不能和来源/)

  // 目标目录里已经有这个名字：保存接口会跳过复制，只挂一个启动项，得当场说明
  // （另一个目录里同名不算冲突，跨目录复制时正好用它）
  const taken = guidedHarness({ mode: 'home', home: 'D:/homes/iso', copyProfile: 'ios-dev', homeProfile: 'ios-dev', profiles: ['web', 'ios-dev'], webProfiles: ['web', 'ios-dev'] })
  await assert.rejects(taken.context.prepareGuidedLaunch(), /已经有「/)
})

test('独立目录也能从已有 Profile 复制：目录和 Profile 一起带进保存接口', async () => {
  const h = guidedHarness({ mode: 'home', home: 'D:/homes/iso', copyProfile: 'ios-dev', copyHome: 'C:/global', profiles: ['web', 'ios-dev'] })
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.dshHome, 'D:/homes/iso')
  // 跨 realm 的对象原型不同，deepEqual 会较真，逐字段比更实在
  assert.equal(target.copyFrom?.profile, 'ios-dev', '复制来源的 Profile')
  assert.equal(target.copyFrom?.home, 'C:/global', '复制来源的目录')
  assert.equal(target.profile, 'ios-dev-copy', '目标名默认「来源-copy」，跟来源分开')
  assert.equal(target.name, 'ios-dev-copy')
  assert.ok(h.calls.posts.some(([url]) => url === '/api/dsh-homes/add'), '独立目录照常登记到「管理目录」')
})

test('复制建议名：撞名顺延、长度不超 32、保留名永远不当目标', () => {
  const { context } = guidedHarness({ mode: 'profile', profiles: ['web', 'ios-dev', 'ios-dev-copy'] })
  assert.equal(context.suggestCopyProfile('ios-dev'), 'ios-dev-copy-2', '「来源-copy」被占了就顺延')
  assert.equal(context.suggestCopyProfile('desktop'), 'desktop-copy', '保留名当来源时也能给出可用目标名')
  assert.equal(context.suggestCopyProfile('a'.repeat(40)).length <= 32, true, '顺延后也不能超过 safeProfile 的 32 字符')
  assert.equal(context.suggestCopyProfile(''), 'work', '没有来源名时退回通用名')
})


test('不复制时模板名 web 照常能用（占位符就写着「留空用 web」），已有的 desktop 也能直接复用', async () => {
  const web = guidedHarness({ mode: 'home', home: 'D:/homes/iso', homeProfile: 'web', profiles: ['web'], webProfiles: ['web'] })
  const target = await web.context.prepareGuidedLaunch()
  assert.equal(target.profile, 'web')
  const desktop = guidedHarness({ mode: 'profile', profileCustom: 'desktop', profiles: ['web', 'desktop'], webProfiles: ['web', 'desktop'] })
  assert.equal((await desktop.context.prepareGuidedLaunch()).profile, 'desktop')
  const fresh = guidedHarness({ mode: 'profile', profileCustom: 'desktop', profiles: ['web'] })
  await assert.rejects(fresh.context.prepareGuidedLaunch(), /系统保留名称/, '没有 desktop 时不许新建这个名字')
  const modules = guidedHarness({ mode: 'profile', profileCustom: 'node_modules', profiles: ['web'] })
  await assert.rejects(modules.context.prepareGuidedLaunch(), /系统保留名称/)
})

test('跨目录复制、名字留空：建议名按目标目录里已有的 Profile 顺延，不会悄悄复用旧的', async () => {
  const h = guidedHarness({ mode: 'home', home: 'D:/homes/iso', copyProfile: 'ios-dev', copyHome: 'C:/global', profileCustom: '', profiles: ['web', 'ios-dev'] })
  h.context.state.profiles = ['web', 'ios-dev']
  const original = h.context.getJson
  h.context.getJson = async (url) => {
    const data = await original(url)
    return url.startsWith('/api/launch-home/profiles') ? { ...data, profiles: ['web', 'ios-dev-copy'] } : data
  }
  const target = await h.context.prepareGuidedLaunch()
  assert.equal(target.profile, 'ios-dev-copy-2', '目标目录里已经有 ios-dev-copy')
})
