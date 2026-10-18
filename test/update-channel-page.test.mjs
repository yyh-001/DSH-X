/**
 * 版本类型的页面测试：从 index.html 的内联脚本里抠出函数，在 vm 沙箱里配桩运行。
 * 期望来自需求、不看实现。服务端在 state.channelPlans 里按「选的类型」给出计划：
 *   { channel: 退档后实际生效的类型, installed: 它接受的已装版本（高到低）, latest: 它接受的最新已发布版本（没拉到远端为 ''） }
 *
 * 用例清单
 *   U1 launchChannel 等价类：rc / alpha / official 原样；缺字段、坏值 → official
 *   U2 channelLatestVersion / launchLatestVersion：读 state.channelPlans[type].latest；缺表 / 缺键 / 空值 / 未知类型 → ''，
 *      不拿 remote.latest 或已去掉的 remote.latestByChannel 顶替；未设置 / 坏值的启动项按正式版的计划（可能已退到 RC）
 *   U3 recommendedVersion 判定表：类型 × 在跑（同组合且被接受 / 不被接受 / 别的 profile / 别的目录 / 多个取最高）
 *      × 远端状态（未拉到 / 已拉到无正式版 / 正式版出现）；旧服务进程没有 channelPlans 时退回不分类型
 *   U4 resolveLaunchVersion：auto 按启动项自己的类型与目录；钉死的版本原样（哪怕类型不接受它）
 *   U5 selected()：编辑草稿为自动时，跟着开关的草稿类型与草稿 profile 解析；钉死版本不受开关影响
 *   U6 卡片判定表：卡片上解析出的版本、「新版本」按钮（只给 auto、严格更新才有、版本 = 生效类型的最新版）、
 *      点按钮升级到同一个版本；状态迁移：没有正式版 → 正式版出现
 *   U7 三档开关的标记（边界值 0 / 2、步长 1，原生 range、可 Tab）
 *   U8 标签「版本类型」用 for 关联开关，英文是 Version type
 *   U9 同一行结构；U10 这一行最多一个档名可见
 *   U11 打开编辑器的初值；U12 三档之间的状态迁移（中英文）：档名、读屏文字、说明（说明讲「自动挑选」和「提醒」两件事）
 *   U13 保存判定表：打开时的档 × 拨到哪一档 → 提交的 updateChannel
 *   U14 退档说明：选的类型被退档时，说明点名两种类型（中文「还没有正式版」+ RC，英文 no Official release yet + RC）；
 *      没退档的档不这么说；开关旁的档名仍是选的那档
 *   U15 状态推送（弹窗开着时 channelPlans 变了）：说明跟着变（正式版出现 → 不再退档 → 又没了），开关草稿不被改回
 *
 * 没覆盖的：开关「短、长得像两档开关」是纯视觉要求，node 里没有布局引擎，这里不判定，留给真浏览器看。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { TYPES, expectedPlan, newestFirst } from './update-channel-fixture.mjs'

// Windows checkout 会转成 CRLF；统一换行后再按行首缩进找顶层声明。
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const CLOSERS = { '(': ')', '{': '}' }

function parses(code) {
  try { new vm.Script(code); return true } catch { return false }
}

/** 从 from 起第一个 open 到与之配对的闭括号（含）的结束下标。 */
function matchClose(from, open) {
  const start = page.indexOf(open, from)
  let depth = 0
  for (let i = start; i >= 0 && i < page.length; i += 1) {
    if (page[i] === open) depth += 1
    else if (page[i] === CLOSERS[open] && --depth === 0) return i + 1
  }
  return -1
}

/** 一条顶层语句：括号配平后遇到的第一个换行处结束。 */
function statementAt(at) {
  let depth = 0
  for (let i = at; i < page.length; i += 1) {
    const char = page[i]
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === '\n' && depth <= 0) return page.slice(at, i)
  }
  return page.slice(at)
}

/** 顶层函数：先按花括号配对；字符串里的括号让配对失效时，退回「下一行四空格的 }」。 */
function functionAt(at) {
  const end = matchClose(matchClose(at, '('), '{')
  const paired = end > 0 ? page.slice(at, end) : ''
  if (paired && parses(paired)) return paired
  const close = page.indexOf('\n    }\n', at)
  return page.slice(at, close + 6)
}

// 页面脚本顶层（4 空格缩进）的函数与 const/let 声明索引，只建一次。
const TOP = new Map()
for (const match of page.matchAll(/^    (?:async )?function ([\w$]+)\(/gm)) {
  if (!TOP.has(match[1])) TOP.set(match[1], { kind: 'function', at: match.index })
}
for (const match of page.matchAll(/^    (?:const|let) ([\w$]+)\b/gm)) {
  if (!TOP.has(match[1])) TOP.set(match[1], { kind: 'declaration', at: match.index })
}
const sourceOf = (name) => {
  const item = TOP.get(name)
  if (!item) return null
  item.code ??= item.kind === 'function' ? functionAt(item.at) : statementAt(item.at)
  return item
}

/** 顶层上给某个元素接线的语句（例如 `xxxEl.oninput = ...`），不是声明也不是函数。 */
function wiringStatements(token) {
  const out = []
  for (const match of page.matchAll(/^    (?!(?:async )?function |const |let |\/\/|\/\*|\*|<)\S[^\n]*$/gm)) {
    if (match[0].includes(token)) out.push(statementAt(match.index))
  }
  return out
}

/** 简易 DOM：按 id 复用同一个元素，querySelector('#id') 也落到同一个元素上；事件可以手动触发。 */
function makeDom() {
  const elements = {}
  const byId = (id) => (elements[id] ||= element(id))
  const select = (selector) => (/^#[\w-]+$/.test(selector) ? byId(selector.slice(1)) : null)
  function element(id = '') {
    const listeners = {}
    // 属性要真记下来：档名给读屏是写在 aria-valuetext 上的，用例得能读回来。
    const attributes = {}
    const node = {
      id, value: '', checked: false, hidden: false, disabled: false, inert: false, textContent: '', innerHTML: '', title: '',
      dataset: {}, style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(name, value) { attributes[name] = String(value) },
      removeAttribute(name) { delete attributes[name] },
      toggleAttribute(name, force = !(name in attributes)) { if (force) attributes[name] = ''; else delete attributes[name]; return force },
      getAttribute: (name) => attributes[name] ?? null, focus() {}, blur() {},
      animate: () => ({ finished: Promise.resolve(), cancel() {} }), getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
      querySelector: select, querySelectorAll: () => [], closest: () => null, contains: () => false,
      append() {}, appendChild() {}, replaceChildren() {}, insertAdjacentElement() {}, dispatchEvent() { return true },
      addEventListener(type, handler) { (listeners[type] ||= []).push(handler) },
      removeEventListener() {},
      /** 模拟用户操作：先跑 on<type>，再跑 addEventListener 注册的。 */
      fire(type) {
        const event = { type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} }
        // 事件处理里可能碰到桩没覆盖的浏览器能力；吞掉异常，结果交给后面的档名 / 说明 / 保存断言判定。
        for (const handler of [node[`on${type}`], ...(listeners[type] || [])]) {
          try { handler?.(event) } catch { /* 见上 */ }
        }
      },
    }
    Object.defineProperty(node, 'valueAsNumber', { get() { return Number(node.value) }, set(value) { node.value = String(value) }, enumerable: false })
    // 浏览器的 ARIA 反射：页面写 el.ariaValueText 和 setAttribute('aria-valuetext') 是同一件事，两种写法都认。
    Object.defineProperty(node, 'ariaValueText', {
      get: () => attributes['aria-valuetext'] ?? null,
      set(value) { if (value === null) delete attributes['aria-valuetext']; else attributes['aria-valuetext'] = String(value) },
      enumerable: false,
    })
    return node
  }
  const document = {
    getElementById: byId, querySelector: select, querySelectorAll: () => [], createElement: () => element(),
    documentElement: element('html'), body: element('body'), activeElement: null, addEventListener() {},
  }
  return { elements, element, document }
}

/**
 * 只装用例要用的代码；它们调用到的、没被桩替掉的页面函数和顶层声明按需一并装进来（依赖先装），
 * 这样页面新增的辅助函数不会让沙箱缺名字。期望仍然只来自需求。
 * 沙箱里不给定时器：被顺带装进来的声明若起了定时器，回调会在用例之外抛错。
 */
function sandbox(roots, stubs = {}, optional = []) {
  const dom = makeDom()
  const context = vm.createContext({
    document: dom.document, console,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    t: (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''),
    escapeHtml: (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    ...(typeof stubs === 'function' ? stubs(dom) : stubs),
  })
  const known = new Set(Object.keys(context))
  const seen = new Set()
  const functions = [], declarations = []
  const visit = (code) => {
    // 「a.b」里的 b 是属性不是名字，但「...b」（展开）里的 b 是名字：只排除前面恰好一个点的
    for (const [, name] of code.matchAll(/(?<![\w$])(?<![^.]\.)([A-Za-z_$][\w$]*)/g)) {
      if (seen.has(name) || known.has(name)) continue
      seen.add(name)
      const item = sourceOf(name)
      if (!item) continue
      visit(item.code)
      ;(item.kind === 'function' ? functions : declarations).push(item.code)
    }
  }
  const rootSources = roots.map((root) => {
    const source = /[\s(=]/.test(root) ? root : sourceOf(root)?.code
    assert.ok(source, `index.html 里找不到 ${root}`)
    return source
  })
  rootSources.forEach(visit)
  optional.forEach(visit)
  for (const source of [...functions, ...declarations]) {
    try { vm.runInContext(source, context) } catch { /* 依赖浏览器环境的声明初始化不了，真用到才会让用例失败 */ }
  }
  for (const source of rootSources) vm.runInContext(source, context)
  // 可选代码（如给元素接事件）装不上不算功能失败，后面的行为断言会如实暴露结果。
  for (const source of optional) {
    try { vm.runInContext(source, context) } catch { /* 依赖浏览器环境的接线跳过 */ }
  }
  return { context, elements: dom.elements, element: dom.element }
}

test('launchChannel：合法类型原样，缺字段或坏值按正式版', () => {
  const { context: c } = sandbox(['launchChannel'])
  assert.equal(c.launchChannel({ id: 'a', updateChannel: 'rc' }), 'rc')
  assert.equal(c.launchChannel({ id: 'a', updateChannel: 'alpha' }), 'alpha')
  assert.equal(c.launchChannel({ id: 'a', updateChannel: 'official' }), 'official')
  assert.equal(c.launchChannel({ id: 'a' }), 'official', '从没选过的启动项是正式版')
  for (const bad of ['beta', 'RC', '', 2, null, {}]) {
    assert.equal(c.launchChannel({ id: 'a', updateChannel: bad }), 'official', `${JSON.stringify(bad)} 按正式版`)
  }
})

// 两套远端：dsh 至今没有正式版（PUB_NO_OFFICIAL），以及正式版出现之后（PUB_WITH_OFFICIAL）。
// 数值边界放在里面：rc.10 > rc.9（逐段按数值比）；beta 归 Alpha；正式版出现后 Alpha 能收到的最新是一个 RC。
const PUB_NO_OFFICIAL = ['0.1.0-rc.1', '0.2.0-rc.1', '0.2.1-rc.9', '0.2.1-rc.10', '0.3.0-alpha.2', '0.4.0-alpha.1', '0.4.0-beta.1']
const PUB_WITH_OFFICIAL = [...PUB_NO_OFFICIAL, '0.5.0', '0.5.1-rc.1']

/** 服务端该给的 channelPlans：照需求算（见 update-channel-fixture.mjs 的预言），published = null 是「还没拉到远端」。 */
const plansFor = (installed, published) => Object.fromEntries(TYPES.map((type) => [type, expectedPlan(type, installed, published)]))
const running = (version, profile = 'web', home = 'home', status = 'running') => ({ version, profile, home, status, url: `http://127.0.0.1/${version}` })

/** 状态里的「已装 / 在跑 / 远端」一处给齐，页面函数都读同一份。plans: undefined = 照需求算，null = 旧服务进程（没有这个字段）。 */
function stateOf({ installed = [], published = null, instances = [], plans, entries = [] }) {
  return {
    dshHome: 'home', installing: null, installed, instances, launchPresets: entries,
    ...(plans === null ? {} : { channelPlans: plans ?? plansFor(installed, published) }),
  }
}
const remoteOf = (published, latestTag = '') => ({ tags: latestTag ? { latest: latestTag } : {}, versions: published || [], latest: published ? newestFirst(published)[0] : '' })

/** 自动选版本那一串的真实页面代码（recommendedVersion → installedList / runningInfo / compareVersion …）只桩掉状态。 */
function resolver(scene) {
  const { context } = sandbox(['recommendedVersion', 'resolveLaunchVersion', 'launchLatestVersion', 'channelLatestVersion'], {
    state: stateOf(scene), remote: scene.remote ?? remoteOf(scene.published),
  })
  return context
}

test('channelLatestVersion / launchLatestVersion：读 state.channelPlans[类型].latest，缺了就是空串', () => {
  const c = resolver({ installed: ['0.2.0-rc.1'], published: PUB_NO_OFFICIAL })
  // 没有正式版时，正式版这档的计划已退到 RC：它的 latest 就是 RC 的最新版
  assert.equal(c.channelLatestVersion('official'), '0.2.1-rc.10')
  assert.equal(c.channelLatestVersion('rc'), '0.2.1-rc.10', 'rc.10 比 rc.9 新（按数值）')
  assert.equal(c.channelLatestVersion('alpha'), '0.4.0-beta.1', 'beta 归 Alpha')
  assert.equal(c.channelLatestVersion('nightly'), '', '未知类型没有最新版')
  assert.equal(c.launchLatestVersion({ id: 'a', version: 'auto' }), '0.2.1-rc.10', '未设置类型的启动项按正式版的计划')
  assert.equal(c.launchLatestVersion({ id: 'a', version: 'auto', updateChannel: 'nightly' }), '0.2.1-rc.10', '坏值按正式版的计划')
  assert.equal(c.launchLatestVersion({ id: 'a', version: 'auto', updateChannel: 'alpha' }), '0.4.0-beta.1')
  c.state.channelPlans = plansFor(['0.2.0-rc.1'], PUB_WITH_OFFICIAL)
  assert.equal(c.channelLatestVersion('official'), '0.5.0', '正式版一出现，正式版这档只看正式版')
  assert.equal(c.channelLatestVersion('alpha'), '0.5.1-rc.1', 'Alpha 也收 RC：它能收到的最新可以是 RC')
  c.state.channelPlans = { official: { channel: 'rc', installed: [], latest: '' }, alpha: { channel: 'alpha', installed: [], latest: '0.4.0-beta.1' } }
  assert.equal(c.channelLatestVersion('official'), '', '空值仍是空串')
  assert.equal(c.channelLatestVersion('rc'), '', '缺键是空串')
  c.state.channelPlans = undefined
  c.remote = { latest: '9.9.9', tags: { latest: '9.9.9' }, versions: ['9.9.9'], latestByChannel: { official: '9.9.9', rc: '9.9.9', alpha: '9.9.9' } }
  for (const type of TYPES) {
    assert.equal(c.channelLatestVersion(type), '', `${type}：没有 channelPlans 时是空串，不拿远端最高或旧的 latestByChannel 顶替`)
  }
})

test('recommendedVersion 判定表：类型 × 在跑 × 已装 × 远端（没有正式版时正式版按 RC）', async (t) => {
  // 已装：RC 0.2.0-rc.1 与更高的 Alpha 0.3.0-alpha.2；正式版、RC 两档永远不能挑到这个 Alpha，哪怕它是最高的已装版本。
  const installed = ['0.2.0-rc.1', '0.3.0-alpha.2', '0.1.0-rc.1']
  const cases = [
    // [说明, 场景, { 类型: 期望 }]
    ['没拉到远端，不在跑：按已装版本退档', { installed, published: null },
      { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.3.0-alpha.2' }],
    ['已拉到远端（没有正式版），不在跑', { installed, published: PUB_NO_OFFICIAL },
      { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.3.0-alpha.2' }],
    ['同组合在跑一个 Alpha：正式版 / RC 不用它', { installed, published: PUB_NO_OFFICIAL, instances: [running('0.3.0-alpha.2')] },
      { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.3.0-alpha.2' }],
    ['同组合在跑一个较旧的 RC：被接受的在跑版本胜过更高的已装版本', { installed, published: PUB_NO_OFFICIAL, instances: [running('0.1.0-rc.1')] },
      { official: '0.1.0-rc.1', rc: '0.1.0-rc.1', alpha: '0.1.0-rc.1' }],
    ['同组合在跑两个都被接受的：取最高', { installed, published: PUB_NO_OFFICIAL, instances: [running('0.1.0-rc.1'), running('0.2.0-rc.1')] },
      { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.2.0-rc.1' }],
    ['在跑的是别的 profile / 别的目录：不算', { installed, published: PUB_NO_OFFICIAL, instances: [running('0.1.0-rc.1', 'work'), running('0.1.0-rc.1', 'web', 'other')] },
      { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.3.0-alpha.2' }],
    ['只装了 Alpha：正式版 / RC 首次启动下载 RC 的最新已发布版', { installed: ['0.3.0-alpha.2'], published: PUB_NO_OFFICIAL },
      { official: '0.2.1-rc.10', rc: '0.2.1-rc.10', alpha: '0.3.0-alpha.2' }],
    ['什么都没装：各自下载自己能收的最新已发布版', { installed: [], published: PUB_NO_OFFICIAL },
      { official: '0.2.1-rc.10', rc: '0.2.1-rc.10', alpha: '0.4.0-beta.1' }],
    ['正式版出现、但没装：正式版这档只用正式版（下载 0.5.0），在跑的 RC 也不用', { installed, published: PUB_WITH_OFFICIAL, instances: [running('0.2.0-rc.1')] },
      { official: '0.5.0', rc: '0.2.0-rc.1', alpha: '0.2.0-rc.1' }],
    ['正式版装上了：RC、Alpha 也收正式版，取已装最高', { installed: [...installed, '0.5.0'], published: PUB_WITH_OFFICIAL },
      { official: '0.5.0', rc: '0.5.0', alpha: '0.5.0' }],
    ['没拉到远端、只装了 Alpha：正式版退两档到 Alpha', { installed: ['0.3.0-alpha.2'], published: null },
      { official: '0.3.0-alpha.2', rc: '0.3.0-alpha.2', alpha: '0.3.0-alpha.2' }],
  ]
  for (const [name, scene, expected] of cases) {
    await t.test(name, () => {
      // 远端的 latest 标签故意指着一个 Alpha：类型不收它时，不能被它顶上
      const c = resolver({ ...scene, remote: remoteOf(scene.published, '0.4.0-alpha.1') })
      for (const type of TYPES) {
        assert.equal(c.recommendedVersion('web', 'home', type), expected[type], `${type} 类型`)
      }
    })
  }
})

test('recommendedVersion 边界：计划里一个能用的版本都没有时不挑类型以外的版本；旧服务进程没有 channelPlans 时退回不分类型', () => {
  const empty = resolver({ installed: [], remote: remoteOf(['0.4.0-alpha.1'], '0.4.0-alpha.1'),
    plans: Object.fromEntries(TYPES.map((type) => [type, { channel: type, installed: [], latest: '' }])) })
  assert.equal(empty.recommendedVersion('web', 'home', 'official'), '', '正式版这档不能拿远端 latest 标签上的 Alpha 顶替')
  // 旧服务进程：已装最高（不分类别）优先，其次 registry 的 latest 标签
  const legacy = resolver({ installed: ['0.2.0-rc.1', '0.3.0-alpha.2'], plans: null, remote: remoteOf(['0.9.0'], '0.9.0') })
  assert.equal(legacy.recommendedVersion('web', 'home', 'official'), '0.3.0-alpha.2', '没有 channelPlans：已装的最高版本，不分类别')
  const legacyEmpty = resolver({ installed: [], plans: null, remote: remoteOf(['0.9.0', '1.0.0-alpha.1'], '0.9.0') })
  assert.equal(legacyEmpty.recommendedVersion('web', 'home', 'official'), '0.9.0', '没有 channelPlans 又没装：用 registry 的 latest 标签')
})

test('resolveLaunchVersion：auto 按启动项自己的类型、profile 与目录；钉死的版本原样', () => {
  const c = resolver({ installed: ['0.2.0-rc.1', '0.3.0-alpha.2', '0.1.0-rc.1'], published: PUB_NO_OFFICIAL,
    instances: [running('0.1.0-rc.1', 'web', 'other')] })
  assert.equal(c.resolveLaunchVersion({ id: 'a', version: 'auto', profile: 'web' }), '0.2.0-rc.1', '未设置类型 = 正式版，眼下按 RC')
  assert.equal(c.resolveLaunchVersion({ id: 'a', version: 'auto', profile: 'web', updateChannel: 'alpha' }), '0.3.0-alpha.2')
  assert.equal(c.resolveLaunchVersion({ id: 'a', version: 'auto', profile: 'web', updateChannel: 'rc', dshHome: 'other' }), '0.1.0-rc.1', '独立目录里在跑的版本优先')
  assert.equal(c.resolveLaunchVersion({ id: 'a', version: '0.3.0-alpha.2', profile: 'web', updateChannel: 'official' }), '0.3.0-alpha.2', '钉死的版本不受类型影响')
})

test('selected()：草稿为自动时跟着开关的草稿类型与草稿 profile 走；钉死版本不受开关影响', () => {
  const scene = { installed: ['0.2.0-rc.1', '0.3.0-alpha.2', '0.1.0-rc.1'], published: PUB_NO_OFFICIAL, instances: [running('0.1.0-rc.1', 'work')] }
  const { context: c, elements } = sandbox(['selected'], ({ document }) => ({
    state: stateOf(scene), remote: remoteOf(scene.published), versionValue: 'auto', launchProfile: 'web', picked: 'auto', userPicked: true,
    _slider: document.getElementById('launchUpdateChannel'),
  }))
  const slider = elements.launchUpdateChannel
  const expected = { official: '0.2.0-rc.1', rc: '0.2.0-rc.1', alpha: '0.3.0-alpha.2' }
  for (const type of ['official', 'alpha', 'rc', 'alpha', 'official']) {
    slider.value = String(TYPES.indexOf(type))
    assert.equal(c.selected(), expected[type], `开关拨到 ${type}`)
  }
  c.launchProfile = 'work'
  slider.value = '1'
  assert.equal(c.selected(), '0.1.0-rc.1', '草稿 profile 换成 work：那边在跑的 RC 优先')
  c.versionValue = '0.2.0-rc.1'
  slider.value = '2'
  assert.equal(c.selected(), '0.2.0-rc.1', '钉死的版本原样')
})

/** 渲染启动项列表：返回 id → { version: 卡片解析出的版本, button: 「新版本」按钮文字（没有为 null）, click(): 点按钮后的升级目标 }。 */
function paint(entries, scene) {
  const asks = []
  const { context } = sandbox(['paintLaunchHome'], ({ element }) => {
    const list = element('launchPresets')
    // 点「新版本」要能真的点：按渲染出的 data-version-id 造按钮，页面给它们挂 onclick
    let buttons = []
    list.querySelectorAll = (selector) => {
      if (selector !== '[data-version-id]') return []
      buttons = [...list.innerHTML.matchAll(/data-version-id="([^"]+)"/g)].map(([, id]) => ({ dataset: { versionId: id }, onclick: null }))
      return buttons
    }
    list.buttons = () => buttons
    return {
      remote: remoteOf(scene.published), action: '', launchDialogClosing: false, launchHomeMarkup: '', DEFAULT_LAUNCH_ID: '0000000000000000',
      state: stateOf({ ...scene, entries }), launchEntries: () => entries, launchEntryTask: () => undefined, versionInstalls: new Map(),
      launchPresetsEl: list, launchDialogEl: { hidden: true }, launchSaveEl: { disabled: false }, launchDeleteEl: { disabled: false },
      launchAddEl: element('launchAdd'), launchIconMarkup: () => '<svg></svg>',
      render() {}, notify(message) { asks.push({ notify: message }) }, openInstance: async () => {}, positionLaunchLink() {},
      showAsk(update) { asks.push(update) },
    }
  })
  context.paintLaunchHome()
  const cards = {}
  for (const chunk of context.launchPresetsEl.innerHTML.split('data-launch-key="').slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'))
    const button = /<button\b[^>]*\bclass="[^"]*\blaunch-new-version\b[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(chunk)
    const entry = entries.find((item) => item.id === id)
    cards[id] = {
      version: context.resolveLaunchVersion(entry),
      button: button ? button[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null,
      click() {
        const target = context.launchPresetsEl.buttons().find((item) => item.dataset.versionId === id)
        assert.ok(target?.onclick, `${id} 的「新版本」按钮要能点`)
        asks.length = 0
        target.onclick()
        return asks.at(-1)?.dsh?.latest ?? null
      },
    }
  }
  return cards
}

const auto = (id, updateChannel, extra = {}) => ({ id, name: id, version: 'auto', profile: 'web', port: 0, ...(updateChannel === undefined ? {} : { updateChannel }), ...extra })

/** 卡片判定表的一行：解析版本、按钮有无与文字、点了升级到同一个版本。 */
function expectCards(cards, expected, why) {
  for (const [id, [version, latest]] of Object.entries(expected)) {
    assert.ok(id in cards, `${why}：${id} 的卡片要渲染出来`)
    assert.equal(cards[id].version, version, `${why}：${id} 解析出的版本`)
    assert.equal(cards[id].button, latest && `新版本 ${latest}`, `${why}：${id} 的「新版本」按钮`)
    if (latest) assert.equal(cards[id].click(), latest, `${why}：${id} 点「新版本」升级到按钮上写的同一个版本`)
  }
}

test('卡片判定表：解析版本与「新版本」按钮都按启动项的生效类型；只给 auto，严格更新才显示', () => {
  const entries = [
    auto('unset'), auto('official', 'official'), auto('rc', 'rc'), auto('alpha', 'alpha'), auto('bogus', 'nightly'),
    { id: 'pinned', name: 'pinned', version: '0.2.0-rc.1', profile: 'web', port: 0, updateChannel: 'alpha' },
  ]
  // [版本, 按钮上的版本（null = 没有按钮）]：今天没有正式版，正式版 / 未设置 / 坏值都按 RC 提醒
  expectCards(paint(entries, { installed: ['0.2.0-rc.1', '0.3.0-alpha.2'], published: PUB_NO_OFFICIAL }), {
    unset: ['0.2.0-rc.1', '0.2.1-rc.10'], official: ['0.2.0-rc.1', '0.2.1-rc.10'], rc: ['0.2.0-rc.1', '0.2.1-rc.10'],
    alpha: ['0.3.0-alpha.2', '0.4.0-beta.1'], bogus: ['0.2.0-rc.1', '0.2.1-rc.10'], pinned: ['0.2.0-rc.1', null],
  }, '没有正式版')
  // 边界：解析版本等于生效类型的最新 → 不显示；rc.9 对 rc.10 按数值 → 显示；解析版本新于最新 → 不显示
  expectCards(paint([auto('same', 'rc'), auto('alpha', 'alpha')], { installed: ['0.2.1-rc.10'], published: PUB_NO_OFFICIAL }), {
    same: ['0.2.1-rc.10', null], alpha: ['0.2.1-rc.10', '0.4.0-beta.1'],
  }, '已是 RC 最新')
  expectCards(paint([auto('older', 'rc')], { installed: ['0.2.1-rc.9'], published: PUB_NO_OFFICIAL }), { older: ['0.2.1-rc.9', '0.2.1-rc.10'] }, 'rc.9 → rc.10')
  expectCards(paint([auto('ahead'), auto('aheadAlpha', 'alpha')], { installed: ['0.6.0-rc.1'], published: PUB_NO_OFFICIAL }), {
    ahead: ['0.6.0-rc.1', null], aheadAlpha: ['0.6.0-rc.1', null],
  }, '已装的比远端都新')
  expectCards(paint([auto('offline'), auto('offlineAlpha', 'alpha')], { installed: ['0.2.0-rc.1', '0.3.0-alpha.2'], published: null }), {
    offline: ['0.2.0-rc.1', null], offlineAlpha: ['0.3.0-alpha.2', null],
  }, '还没拉到远端：照样按已装版本解析，没有可提醒的')
})

test('状态迁移：没有正式版 → 正式版发布 → 装上正式版 → 又发了新正式版，正式版启动项的版本与提醒跟着走', () => {
  const entries = [auto('official'), auto('rc', 'rc'), auto('alpha', 'alpha')]
  const installed = ['0.2.0-rc.1', '0.3.0-alpha.2']
  expectCards(paint(entries, { installed, published: PUB_NO_OFFICIAL }), {
    official: ['0.2.0-rc.1', '0.2.1-rc.10'], rc: ['0.2.0-rc.1', '0.2.1-rc.10'], alpha: ['0.3.0-alpha.2', '0.4.0-beta.1'],
  }, '没有正式版')
  // 正式版一出现，正式版项不再用 RC：没装正式版 → 首次启动下载 0.5.0，没有「新版本」可点（它要用的就是最新的）
  expectCards(paint(entries, { installed, published: PUB_WITH_OFFICIAL }), {
    official: ['0.5.0', null], rc: ['0.2.0-rc.1', '0.5.1-rc.1'], alpha: ['0.3.0-alpha.2', '0.5.1-rc.1'],
  }, '正式版发布')
  expectCards(paint(entries, { installed: [...installed, '0.5.0'], published: PUB_WITH_OFFICIAL }), {
    official: ['0.5.0', null], rc: ['0.5.0', '0.5.1-rc.1'], alpha: ['0.5.0', '0.5.1-rc.1'],
  }, '装上正式版')
  expectCards(paint(entries, { installed: [...installed, '0.5.0'], published: [...PUB_WITH_OFFICIAL, '0.5.2'] }), {
    official: ['0.5.0', '0.5.2'], rc: ['0.5.0', '0.5.2'], alpha: ['0.5.0', '0.5.2'],
  }, '又发了 0.5.2')
})

test('旧服务进程没有 channelPlans：不显示「新版本」按钮', () => {
  const cards = paint([auto('a', 'alpha')], { installed: ['0.2.0-rc.1'], published: ['9.9.9'], plans: null })
  assert.equal(cards.a.button, null)
})

// ---- 编辑弹窗里的三档开关 ----
// 静态结构从标记里判定：node 没有布局引擎，「同一行」「紧挨着」只能看元素树里谁和谁同属一个容器。
// 不认样式类名——类名是实现随手起的，需求只关心元素之间的包含关系与先后。

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

/** 把某个 id 的元素连同子树解析成树（只认标签、属性与文字，够判断包含关系）。 */
function markupTree(rootId) {
  const at = page.indexOf(`id="${rootId}"`)
  if (at < 0) return null
  const stack = []
  let root = null
  TAG.lastIndex = page.lastIndexOf('<', at)
  for (let match; (match = TAG.exec(page));) {
    const [, closing, rawTag, rawAttrs, selfClosing, text] = match
    const parent = stack.at(-1)
    if (text !== undefined) { parent?.children.push({ text, parent }); continue }
    if (!rawTag) continue
    const tag = rawTag.toLowerCase()
    if (closing) {
      // 容错：漏写的闭标签按浏览器的做法一并收掉，不让后面的元素挂错父节点。
      const open = stack.findLastIndex((node) => node.tag === tag)
      if (open >= 0) stack.length = open
      if (!stack.length) break
      continue
    }
    const attrs = {}
    for (const [, name, ...values] of (rawAttrs || '').matchAll(ATTR)) attrs[name.toLowerCase()] = values.find((value) => value !== undefined) ?? ''
    const node = { tag, attrs, children: [], parent }
    if (parent) parent.children.push(node)
    else root = node
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node)
    if (!stack.length) break
  }
  return root
}

function* walk(node) {
  yield node
  for (const child of node.children || []) yield* walk(child)
}
const findById = (root, id) => [...walk(root)].find((node) => node.attrs?.id === id)
const ancestors = (node) => { const out = []; for (let at = node; at; at = at.parent) out.push(at); return out }
const commonAncestor = (a, b) => { const mine = new Set(ancestors(a)); return ancestors(b).find((node) => mine.has(node)) }
const containsNode = (outer, inner) => ancestors(inner).includes(outer)
/** 肉眼能看到的文字：带 hidden 的子树不算；aria-hidden 只对读屏隐藏，眼睛照样看得见，所以要算。 */
const visibleTexts = (node) => node.text !== undefined ? [node.text.trim()].filter(Boolean)
  : 'hidden' in node.attrs ? [] : node.children.flatMap(visibleTexts)

const CHANNELS = ['official', 'rc', 'alpha']
const CHANNEL_NAMES = { zh: { official: '正式版', rc: 'RC', alpha: 'Alpha' }, en: { official: 'Official', rc: 'RC', alpha: 'Alpha' } }
// 说明的判定表：选哪一档，自动挑选与提醒会用到哪几类。只判断「提到了该档接受的类别」「讲了挑选也讲了提醒」与
// 「三档说明各不相同」，不抄具体措辞，也不要求说明避开别的类别名（写成「不用 Alpha」同样合需求）。
const NOTIFIED = { official: ['official'], rc: ['rc', 'official'], alpha: ['alpha', 'rc', 'official'] }
const HINT_MENTIONS = { zh: { official: /正式版/, rc: /RC/, alpha: /Alpha/ }, en: { official: /official/i, rc: /\bRC\b/, alpha: /\bAlpha\b/ } }
// 需求 R7：说明要同时讲「自动挑哪些版本」和「提醒哪些新版本」两件事
const HINT_TOPICS = {
  zh: { pick: /自动|选/, notify: /提醒|通知/ },
  en: { pick: /\b(auto|pick|choose|chosen|select|use[sd]?)\b/i, notify: /\bnotif|\bremind|\balert/i },
}
// 需求 R7 的退档说明：选的档名与实际生效的档名都要点出来；这里是「正式版退到 RC」那一种
const FALLBACK_SAYS = { zh: [/还没有正式版/, /RC/], en: [/no official release yet/i, /\bRC\b/] }

/** 弹窗里几个用例都要用的元素；任何一个找不到就直接让用例失败，并说清缺的是谁。 */
function dialogParts() {
  const dialog = markupTree('launchDialog')
  assert.ok(dialog, '找不到编辑启动项弹窗')
  const parts = { dialog }
  for (const [key, id] of Object.entries({ control: 'launchUpdateChannel', picker: 'versionPicker', trigger: 'versionTrigger', home: 'launchDshHome' })) {
    parts[key] = findById(dialog, id)
    assert.ok(parts[key], `编辑弹窗里要有 #${id}`)
  }
  parts.label = [...walk(dialog)].find((node) => node.tag === 'label' && node.attrs.for === 'launchUpdateChannel')
  parts.row = commonAncestor(parts.control, parts.picker)
  return parts
}

/** 用页面自己的 EN 词典和 t() 翻译，英文用例走的是真实的多语言路径。 */
function pageTranslator(lang) {
  const sources = ['EN', 't'].map((name) => sourceOf(name)?.code)
  assert.ok(sources.every(Boolean), '找不到页面的 EN 词典或 t()')
  return vm.runInContext(`${sources.join('\n')}\nt`, vm.createContext({ lang }))
}

test('三档开关仍是原生 range：0..2、步长 1，没被禁用、也没移出 Tab 顺序', () => {
  const { dialog, control } = dialogParts()
  assert.equal(control.tag, 'input', '开关是 input，键盘方向键、拖动都靠原生控件')
  assert.equal(control.attrs.type, 'range')
  // 边界值：两端与步长。缺省的 min/step 在浏览器里就是 0 / 1，也算符合。
  assert.equal(control.attrs.min ?? '0', '0', '最低档是 0（正式版）')
  assert.equal(control.attrs.max, '2', '最高档是 2（Alpha），一共三档')
  assert.equal(control.attrs.step ?? '1', '1', '一档一格，停不到档与档之间')
  assert.ok(!('disabled' in control.attrs), '不能禁用')
  assert.notEqual(control.attrs.tabindex, '-1', '要能用 Tab 走到，键盘才能操作')
  // 弹窗本身平时是 hidden 的，打开时才显示；它里面的祖先不能再藏起来或设成 inert。
  for (const node of ancestors(control).filter((node) => node !== dialog)) {
    assert.ok(!('hidden' in node.attrs) && !('inert' in node.attrs), `开关所在的 <${node.tag}> 不能是 hidden / inert`)
  }
})

test('「版本类型」标签用 for 指着开关，英文是 Version type', () => {
  // 改名的原因：开关不再只管提醒，也决定「自动最新版本」挑哪些版本，「更新提醒」这个名字会误导
  const { label } = dialogParts()
  assert.ok(label, '要有 <label for="launchUpdateChannel">')
  assert.equal(visibleTexts(label).join(''), '版本类型', '标签文字是「版本类型」')
  assert.equal(label.attrs['data-i18n'], '版本类型', '标签参加界面语言切换')
  assert.equal(pageTranslator('en')('版本类型'), 'Version type', '英文界面叫 Version type')
})

test('开关和版本下拉在同一行：共同的行容器里没有目录字段，两者都在目录字段之前', () => {
  const { dialog, control, picker, trigger, home, label, row } = dialogParts()
  assert.ok(containsNode(picker, trigger), '版本下拉的触发按钮在 #versionPicker 里')
  // 「同一行」的结构含义：两者最近的共同容器只装这一行。旧版开关独占一行时，两者的共同容器是整张表单，里面也有目录字段。
  assert.ok(row, '开关和版本下拉要在同一个弹窗里')
  assert.ok(!containsNode(row, home), '开关与版本下拉的共同行容器里不能还装着 dsh 用户目录字段')
  assert.ok(label && containsNode(row, label), '「版本类型」标签跟开关在同一行')
  const order = [...walk(dialog)]
  assert.ok(order.indexOf(picker) < order.indexOf(home), '版本下拉在目录字段之前')
  assert.ok(order.indexOf(control) < order.indexOf(home), '开关在目录字段之前')
})

test('这一行的标记里最多只有一个档名是可见文字（不再在开关下面排三个刻度）', () => {
  const { row } = dialogParts()
  const names = new Set([...Object.values(CHANNEL_NAMES.zh), ...Object.values(CHANNEL_NAMES.en)])
  const shown = visibleTexts(row).filter((text) => names.has(text))
  assert.ok(shown.length <= 1, `开关太短放不下三档文字，只该显示当前那一档；标记里可见的档名有 ${JSON.stringify(shown)}`)
})

const EDIT_ENTRIES = [
  { id: '0000000000000000', name: 'DSH', version: 'auto', profile: 'web', port: 0 },
  { id: 'aaaaaaaaaaaaaaaa', name: '尝鲜', version: 'auto', profile: 'web', port: 0, updateChannel: 'alpha' },
  { id: 'bbbbbbbbbbbbbbbb', name: '候选', version: '1.0.0', profile: 'web', port: 0, updateChannel: 'rc' },
  { id: 'cccccccccccccccc', name: '坏值', version: 'auto', profile: 'web', port: 0, updateChannel: 'nightly' },
]

// 三类都已知（不退档）：U11–U13 只看「选哪档就是哪档」，退档另由 U14、U15 判定。
const NO_FALLBACK = { installed: ['1.0.0'], published: ['1.0.0', '1.1.0-rc.1', '1.2.0-alpha.1'] }
// 今天的 dsh：一个正式版都没有，正式版这档退到 RC
const NO_OFFICIAL = { installed: ['0.2.0-rc.1'], published: ['0.2.0-rc.1', '0.3.0-alpha.1'] }
// 只装了 Alpha、还没拉到远端：正式版与 RC 两档都退到 Alpha
const ONLY_ALPHA = { installed: ['0.3.0-alpha.1'], published: null }

/**
 * 编辑弹窗的沙箱。连页面真实的 render 一起装（live = true 时再加 applyState）：拨开关后页面是直接重画说明、
 * 还是经 render 重画，属于实现细节，用例不该押宝；状态推送走 applyState，「弹窗开着时 channelPlans 变了
 * 说明要跟着变」只能这样从入口验证。只桩掉跟弹窗无关、又要真浏览器的绘制。
 */
function editorHarness({ lang = 'zh', scene = NO_FALLBACK, live = false } = {}) {
  const entries = structuredClone(EDIT_ENTRIES)
  const posts = []
  const submit = page.slice(page.indexOf('    launchFormEl.onsubmit = async'), page.indexOf('    launchDeleteEl.onclick = async'))
  assert.ok(submit.trim(), '找不到保存启动项的代码')
  const unrelated = {
    paintLaunchHome() {}, paintInstances() {}, setProgress() {}, setPluginProgress() {}, paintVersionTrigger() {}, paintVersionPanel() {},
    closeVersionPanel() {}, maybeLaunch() {}, resetPluginView() {}, loadPlugins() {}, renderPackGrid() {}, renderPackView() {},
    pluginTargetHome: () => 'home', launchPluginScope: '', currentPane: 'home', stateAutoFix: () => '', paintVersionManager() {},
  }
  const harness = sandbox(['openLaunchEditor', submit, 'render', ...(live ? ['applyState'] : [])], ({ element, document }) => ({
    action: '', DEFAULT_LAUNCH_ID: '0000000000000000', launchDialogRevision: 0, launchHomeRevision: 0, launchDialogClosing: false,
    editingLaunchId: '', launchIcon: 'terminal', picked: 'auto', versionValue: 'auto', userPicked: false, launchProfile: 'web',
    state: stateOf({ ...scene, entries }), remote: remoteOf(scene.published),
    launchFormEl: element('launchForm'), launchNameEl: element('launchName'), launchPortEl: element('launchPort'),
    launchDshHomeEl: element('launchDshHome'), launchAutoLaunchEl: element('launchAutoLaunch'),
    launchSaveEl: element('launchSave'), launchDeleteEl: element('launchDelete'), launchDialogEl: element('launchDialog'),
    launchEntries: () => entries,
    closeLaunchIcons() {}, paintLaunchIcons() {}, paintLaunchHomes() {}, showDialog() {}, hideDialog: async () => true, paintLaunchProfiles() {},
    refreshLaunchHomeProfiles: async () => true, loadRecovery: async () => {}, notify(message) { posts.push(['notify', message]) },
    notifyError(error) { posts.push(['notify', error?.message]) }, closeLaunchEditor: async () => {}, updateLaunchEntry() {},
    post: async (path, body) => { posts.push([path, body]); return { entry: { ...body, id: body.id || 'dddddddddddddddd' } } },
    ...unrelated,
    // 先建好开关，页面不论用变量还是按 id 现取，都是同一个桩元素。
    _slider: document.getElementById('launchUpdateChannel'),
    ...(lang === 'en' ? { t: pageTranslator('en') } : {}),
  }), wiringStatements('launchUpdateChannel'))
  return { ...harness, lang, entries, posts, slider: harness.elements.launchUpdateChannel }
}

const hintOf = (h) => String(h.elements.launchUpdateChannelHint?.textContent ?? '').trim()

/** 模拟用户把开关拨到某一档：浏览器里拖动和方向键都是先改值、再发 input，松手（或按键结束）再发 change。 */
function move(h, channel, expectAfterInput) {
  h.slider.value = String(CHANNELS.indexOf(channel))
  h.slider.fire('input')
  expectAfterInput?.()
  h.slider.fire('change')
}

/** 某一刻用户看到的：开关的值、旁边的档名、读屏的 aria-valuetext、说明文字，四样都要指着同一档。 */
function expectShown(h, channel, why) {
  const names = CHANNEL_NAMES[h.lang]
  const name = names[channel]
  assert.equal(String(h.slider.value), String(CHANNELS.indexOf(channel)), `${why}：开关停在 ${channel} 那一档`)
  assert.equal(h.slider.getAttribute('aria-valuetext'), name, `${why}：aria-valuetext 是档名「${name}」`)
  // 档名元素不认 id：凡是页面运行时写成某个档名、又没隐藏的元素，都算「显示出来的档名」。
  const shown = Object.values(h.elements).filter((node) => node !== h.slider && !node.hidden
    && Object.values(names).includes(String(node.textContent ?? '').trim()))
  assert.ok(shown.length, `${why}：页面上要有元素显示档名「${name}」（若档名元素不是按 id 取的，这个沙箱看不到）`)
  assert.deepEqual([...new Set(shown.map((node) => node.textContent.trim()))], [name], `${why}：只显示当前档名「${name}」，其它档名不显示`)
  const { dialog, control, picker } = dialogParts()
  // 「紧挨着」的结构含义：和开关是同级兄弟，或者两者所在的那一小组里没有版本下拉（没跨到版本那一边）。
  const beside = shown.filter((node) => {
    const at = node.id && findById(dialog, node.id)
    return at && (at.parent === control.parent || !containsNode(commonAncestor(at, control), picker))
  })
  assert.ok(beside.length, `${why}：显示档名的元素要紧挨开关，不能跨到版本下拉那边，实际是 ${shown.map((node) => `#${node.id}`).join('、')}`)
  const hint = hintOf(h)
  for (const kind of NOTIFIED[channel]) assert.match(hint, HINT_MENTIONS[h.lang][kind], `${why}：说明要提到该档会用的 ${kind}，实际「${hint}」`)
  for (const [topic, pattern] of Object.entries(HINT_TOPICS[h.lang])) {
    assert.match(hint, pattern, `${why}：说明要讲${topic === 'pick' ? '自动挑选版本' : '更新提醒'}，实际「${hint}」`)
  }
  // 说明跟着档走：同一档每次都是同一句，不同档的说明不一样（否则就是没随开关更新）。
  h.hints ??= {}
  h.hints[channel] ??= hint
  assert.equal(hint, h.hints[channel], `${why}：同一档的说明前后一致`)
  for (const [other, seen] of Object.entries(h.hints)) {
    if (other !== channel) assert.notEqual(hint, seen, `${why}：${channel} 的说明要和 ${other} 的不一样，实际都是「${hint}」`)
  }
}

test('打开编辑器时开关、档名、读屏文字、说明都落在启动项的档上；不残留上一次的档', () => {
  const h = editorHarness()
  const [unset, alpha, rc, bogus] = h.entries
  // 每次打开前先把开关拨到「别的」档，打开后必须被改回来；新建排在 alpha 之后，验证不会带着 2 进来。
  for (const [entry, expected, stale] of [
    [unset, 'official', '2'], [alpha, 'alpha', '0'], [rc, 'rc', '2'], [bogus, 'official', '1'],
    [unset, 'official', 'stale'], [alpha, 'alpha', '1'], [undefined, 'official', '2'],
  ]) {
    h.slider.value = stale
    h.context.openLaunchEditor(entry)
    expectShown(h, expected, entry ? `${entry.name}（${entry.updateChannel ?? '未设置'}）` : '新建启动项')
  }
})

test('状态迁移：三档之间来回拨（含原地不动），档名、读屏文字、说明每一步都跟着变', async (t) => {
  // 正式版起步，依次经过 0→0、0→1、1→1、1→2、2→2、2→1、1→0、0→2、2→0：3×3 的迁移每条恰好走一次，两端 0 与 2 都碰到。
  const path = ['official', 'rc', 'rc', 'alpha', 'alpha', 'rc', 'official', 'alpha', 'official']
  for (const lang of ['zh', 'en']) {
    await t.test(lang === 'zh' ? '中文界面' : '英文界面', () => {
      const h = editorHarness({ lang })
      h.context.openLaunchEditor(h.entries[0])
      expectShown(h, 'official', '打开时')
      let from = 'official'
      for (const to of ['official', ...path]) {
        const why = `${from} → ${to}`
        move(h, to, () => expectShown(h, to, `${why}（拨动中）`))
        expectShown(h, to, `${why}（松手后）`)
        from = to
      }
    })
  }
})

test('保存判定表：打开时的档 × 拨到哪一档 → 提交的 updateChannel；拨回 0 要明确提交 official', async () => {
  const h = editorHarness()
  const [unset, alpha, rc, bogus] = h.entries
  const opened = [[unset, 'official'], [alpha, 'alpha'], [rc, 'rc'], [bogus, 'official'], [undefined, 'official']]
  // null = 打开后不碰开关直接保存：提交的应该就是打开时显示的那一档。
  for (const [entry, initial] of opened) {
    for (const target of [null, ...CHANNELS]) {
      const why = `${entry ? `${entry.name}（${entry.updateChannel ?? '未设置'}）` : '新建'}，${target ? `拨到 ${target}` : '不动开关'}`
      h.context.openLaunchEditor(entry)
      if (target) move(h, target)
      h.posts.length = 0
      await h.context.launchFormEl.onsubmit({ preventDefault() {} })
      const write = h.posts.find(([path]) => path === '/api/launch-presets')
      assert.ok(write, `${why}：要提交保存，实际 ${JSON.stringify(h.posts)}`)
      if (entry) assert.equal(write[1].id, entry.id, `${why}：改的是这个启动项`)
      assert.equal(write[1].updateChannel, target ?? initial, `${why}：提交 ${target ?? initial}`)
    }
  }
})

/** 不退档时每一档的说明（作对照：退档后的说明要和它不一样）。 */
function plainHints(lang) {
  const h = editorHarness({ lang })
  return Object.fromEntries(CHANNELS.map((channel) => {
    h.context.openLaunchEditor(h.entries[0])
    move(h, channel)
    return [channel, hintOf(h)]
  }))
}

test('退档说明：正式版这档还没有正式版时说明讲清「按 RC」，档名仍是正式版；RC、Alpha 不退档就不这么说', async (t) => {
  for (const lang of ['zh', 'en']) {
    await t.test(lang === 'zh' ? '中文界面' : '英文界面', () => {
      const plain = plainHints(lang)
      const h = editorHarness({ lang, scene: NO_OFFICIAL })
      h.context.openLaunchEditor(h.entries[0])
      const hint = hintOf(h)
      assert.equal(h.slider.getAttribute('aria-valuetext'), CHANNEL_NAMES[lang].official, '开关仍停在用户选的正式版，档名不换成实际生效的')
      for (const pattern of FALLBACK_SAYS[lang]) assert.match(hint, pattern, `退档说明要点名两种类型，实际「${hint}」`)
      for (const [topic, pattern] of Object.entries(HINT_TOPICS[lang])) assert.match(hint, pattern, `退档说明也要讲${topic}，实际「${hint}」`)
      assert.notEqual(hint, plain.official, '退档时的说明不能还是「只用正式版」那句')
      for (const channel of ['rc', 'alpha']) {
        move(h, channel)
        assert.equal(hintOf(h), plain[channel], `${channel} 有已知版本、没退档：说明就是平常那句`)
        assert.doesNotMatch(hintOf(h), FALLBACK_SAYS[lang][0], `${channel} 没退档，不该说「还没有正式版」`)
      }
      move(h, 'official')
      assert.equal(hintOf(h), hint, '拨回正式版，退档说明回来')
    })
  }
})

test('退档说明：只认得 Alpha 时，正式版和 RC 两档都点名「选的」与「实际的 Alpha」', () => {
  const plain = plainHints('zh')
  const h = editorHarness({ scene: ONLY_ALPHA })
  h.context.openLaunchEditor(h.entries[0])
  for (const channel of ['official', 'rc']) {
    move(h, channel)
    const hint = hintOf(h)
    assert.match(hint, HINT_MENTIONS.zh[channel], `${channel}：说明点名选的类型，实际「${hint}」`)
    assert.match(hint, /Alpha/, `${channel}：说明点名实际生效的 Alpha，实际「${hint}」`)
    assert.notEqual(hint, plain[channel], `${channel}：退档后的说明不能还是平常那句`)
  }
  move(h, 'alpha')
  assert.equal(hintOf(h), plain.alpha, 'Alpha 本来就有，不退档')
})

test('状态推送：弹窗开着时 channelPlans 变了，说明跟着变，开关草稿不被改回', () => {
  const h = editorHarness({ scene: NO_OFFICIAL, live: true })
  const plain = plainHints('zh')
  h.context.openLaunchEditor(h.entries[1])
  move(h, 'official')
  assert.match(hintOf(h), FALLBACK_SAYS.zh[0], '起点：还没有正式版')
  /** 服务端推来的一份完整状态（applyState 是页面收推送的入口）。 */
  const push = (scene) => h.context.applyState({ ...stateOf({ ...scene, entries: h.entries }), versions: [], running: null })
  // 正式版发布了：正式版这档不再退档
  push({ installed: NO_OFFICIAL.installed, published: [...NO_OFFICIAL.published, '0.5.0'] })
  assert.equal(String(h.slider.value), '0', '状态推送不能把用户拨的草稿改回启动项原来的 alpha')
  assert.equal(hintOf(h), plain.official, '正式版出现后说明回到「只用正式版」')
  // 换了下载源、远端还没拉回来，已装里也没有正式版：又退回 RC
  push({ installed: NO_OFFICIAL.installed, published: null })
  assert.match(hintOf(h), FALLBACK_SAYS.zh[0], '又不认得正式版了：说明再次讲退档')
  assert.equal(String(h.slider.value), '0')
})
