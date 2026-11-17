/**
 * 实例页顶栏与「新建实例」弹窗的黑盒用例：只按约定（结构、文案、交互结果）断言，不看实现怎么写。
 *
 * 做法和别的页面用例不同：那些多半把函数从源码里抠出来单跑，这里要验的是「点哪个按钮、敲什么键、页面变成什么样」，
 * 抠函数就等于照着实现写用例。所以把整份 index.html 解析成一棵假 DOM（仓库零依赖，没有 jsdom，只能自己写一个够用的），
 * 再把整份 environments-page.js 跑在这棵树上——页面怎么取元素、挂事件都不管，只看用户能看到的结果。
 *
 * 假 DOM 刻意照着 Chromium（Electron）的行为写了几处，免得「测试过、真机不过」：
 *   - 藏着（祖先带 hidden）或禁用的控件 focus() 无效，弹窗还没露出来就抢焦点在真机上会落空；
 *   - 禁用的按钮 click() 不触发任何事件；表单里没写 type 的按钮就是提交钮；
 *   - 提交前先做 required 校验（不通过不发 submit，焦点落到那个框）；submit 没 preventDefault 记成「整页跳走」；
 *   - 输入框里按 Enter 走隐式提交，默认提交钮禁用时不提交；
 *   - 焦点所在的元素被藏起来后 activeElement 回到 body。
 *
 * 主脚本的全局一律换成桩（见 openPage）。弹窗的显隐 / 动画 / 焦点陷阱（showPackDialog、hidePackDialog、trapPackDialog）
 * 依赖 WAAPI 和真实布局，假 DOM 跑不动，换成语义等价的桩：显示 = 去掉 hidden 再聚焦传进来的控件，
 * 隐藏 = 加上 hidden 再把焦点还给打开前的元素，陷阱 = Esc 关闭、点遮罩关闭——和真实现对外表现一致，只是没有动画。
 * 所以如果实现不走这三个公共函数、改由主脚本里别的全局键盘监听处理 Esc，这里的 Esc 用例会误报。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const envPage = readFileSync(new URL('../src/public/environments-page.js', import.meta.url), 'utf8')

// ---- 一棵够用的假 DOM ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
// 这些标签里的内容是纯文本：脚本里的模板字符串不能被当成标签解析
const RAW = new Set(['script', 'style', 'textarea', 'title'])
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', times: '×', middot: '·', mdash: '—', ndash: '–', rarr: '→', larr: '←' }
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => entity[0] === '#'
  ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10))
  : ENTITIES[entity.toLowerCase()] ?? match)
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: false, key: '', shiftKey: false, ...init })
    this.defaultPrevented = false
    this.target = this.currentTarget = null
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this.stopped = true }
  stopImmediatePropagation() { this.stopped = this.immediate = true }
}

function* walk(node) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue
    yield child
    yield* walk(child)
  }
}

// 选择器：逗号分组、后代 / 子代组合、标签、#id、.class、[attr] / [attr=v] / ^= $= *= ~=、:not()、:checked、:disabled、:enabled
function parseCompound(text) {
  const compound = { tag: '', ids: [], classes: [], attrs: [], nots: [], pseudos: [] }
  const re = /#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|:not\(([^)]*)\)|:([\w-]+)|(\*|[a-zA-Z][\w-]*)/gy
  let match
  while (re.lastIndex < text.length && (match = re.exec(text))) {
    if (match[1]) compound.ids.push(match[1])
    else if (match[2]) compound.classes.push(match[2])
    else if (match[3]) compound.attrs.push({ name: match[3].toLowerCase(), op: match[4], value: match[5] ?? match[6] ?? match[7] })
    else if (match[8] !== undefined) compound.nots.push(...parseSelector(match[8]))
    else if (match[9]) {
      if (!['checked', 'disabled', 'enabled'].includes(match[9])) throw new Error(`假 DOM 不支持 :${match[9]}`)
      compound.pseudos.push(match[9])
    } else compound.tag = match[10] === '*' ? '' : match[10].toLowerCase()
  }
  if (re.lastIndex !== text.length && text.length) throw new Error(`假 DOM 解析不了选择器：${text}`)
  return compound
}
function parseSelector(selector) {
  return selector.split(',').map((group) => {
    const parts = []
    let combinator = ' '
    for (const token of group.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
      if (token === '>') { combinator = '>'; continue }
      parts.push({ combinator, compound: parseCompound(token) })
      combinator = ' '
    }
    return parts
  })
}
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false
  if (c.ids.some((id) => el.getAttribute('id') !== id)) return false
  if (c.classes.some((name) => !el.classList.contains(name))) return false
  for (const { name, op, value } of c.attrs) {
    const actual = el.getAttribute(name)
    if (actual === null) return false
    if (op === '=' && actual !== value) return false
    if (op === '^=' && !actual.startsWith(value)) return false
    if (op === '$=' && !actual.endsWith(value)) return false
    if (op === '*=' && !actual.includes(value)) return false
    if (op === '~=' && !actual.split(/\s+/).includes(value)) return false
  }
  if (c.nots.some((parts) => matchParts(el, parts, parts.length - 1))) return false
  for (const pseudo of c.pseudos) {
    if (pseudo === 'checked' && !el.checked) return false
    if (pseudo === 'disabled' && !el.disabled) return false
    if (pseudo === 'enabled' && el.disabled) return false
  }
  return true
}
function matchParts(el, parts, index) {
  if (!matchCompound(el, parts[index].compound)) return false
  if (index === 0) return true
  let parent = el.parentElement
  if (parts[index].combinator === '>') return Boolean(parent) && matchParts(parent, parts, index - 1)
  for (; parent; parent = parent.parentElement) if (matchParts(parent, parts, index - 1)) return true
  return false
}
const matches = (el, selector) => parseSelector(selector).some((parts) => matchParts(el, parts, parts.length - 1))

class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; this.listeners = {} }
  appendChild(node) {
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node) }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1) }
  get firstElementChild() { return this.children[0] || null }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false }
  querySelectorAll(selector) {
    const groups = parseSelector(selector)
    return [...walk(this)].filter((el) => groups.some((parts) => matchParts(el, parts, parts.length - 1)))
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener) }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter((one) => one !== listener) }
  dispatchEvent(event) {
    event.target = this
    const path = []
    for (let node = this; node; node = node.parentNode) path.push(node)
    for (const node of event.bubbles ? path : [this]) {
      event.currentTarget = node
      for (const listener of [...(node.listeners[event.type] || [])]) {
        typeof listener === 'function' ? listener.call(node, event) : listener.handleEvent(event)
        if (event.immediate) break
      }
      if (!event.immediate && typeof node[`on${event.type}`] === 'function') node[`on${event.type}`](event)
      if (event.stopped) break
    }
    return !event.defaultPrevented
  }
}

class FakeText {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null }
  get textContent() { return this.data }
}

class FakeElement extends FakeNode {
  constructor(tag, doc) {
    super()
    this.nodeType = 1
    this.localName = tag
    this.tagName = tag.toUpperCase()
    this.ownerDocument = doc
    this.attributes = new Map()
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }
    this.inert = false
    this._value = null
    const element = this
    this.dataset = new Proxy({}, {
      get: (target, key) => typeof key === 'string' ? element.getAttribute(`data-${kebab(key)}`) ?? undefined : undefined,
      set: (target, key, value) => { element.setAttribute(`data-${kebab(key)}`, String(value)); return true },
      deleteProperty: (target, key) => { element.removeAttribute(`data-${kebab(key)}`); return true },
      has: (target, key) => element.hasAttribute(`data-${kebab(key)}`),
    })
    this.classList = {
      contains: (name) => element.className.split(/\s+/).includes(name),
      add: (...names) => { for (const name of names) if (!element.classList.contains(name)) element.className = `${element.className} ${name}`.trim() },
      remove: (...names) => { element.className = element.className.split(/\s+/).filter((one) => one && !names.includes(one)).join(' ') },
      toggle: (name, force) => {
        const on = force === undefined ? !element.classList.contains(name) : Boolean(force)
        on ? element.classList.add(name) : element.classList.remove(name)
        return on
      },
    }
  }
  getAttribute(name) { return this.attributes.has(name.toLowerCase()) ? this.attributes.get(name.toLowerCase()) : null }
  setAttribute(name, value) { this.attributes.set(name.toLowerCase(), String(value)) }
  hasAttribute(name) { return this.attributes.has(name.toLowerCase()) }
  removeAttribute(name) { this.attributes.delete(name.toLowerCase()) }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force)
    on ? this.setAttribute(name, '') : this.removeAttribute(name)
    return on
  }
  get id() { return this.getAttribute('id') || '' }
  set id(value) { this.setAttribute('id', value) }
  get className() { return this.getAttribute('class') || '' }
  set className(value) { this.setAttribute('class', value) }
  get title() { return this.getAttribute('title') || '' }
  set title(value) { this.setAttribute('title', value) }
  get ariaLabel() { return this.getAttribute('aria-label') }
  set ariaLabel(value) { this.setAttribute('aria-label', value) }
  get placeholder() { return this.getAttribute('placeholder') || '' }
  set placeholder(value) { this.setAttribute('placeholder', value) }
  get htmlFor() { return this.getAttribute('for') || '' }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null }
  get isConnected() { return this.ownerDocument.contains(this) }
  // 布尔属性和真元素一样跟着 HTML 属性走：选择器 [hidden] / [disabled] 才对得上
  get hidden() { return this.hasAttribute('hidden') }
  set hidden(value) { this.toggleAttribute('hidden', Boolean(value)) }
  get disabled() { return this.hasAttribute('disabled') }
  set disabled(value) { this.toggleAttribute('disabled', Boolean(value)) }
  get required() { return this.hasAttribute('required') }
  set required(value) { this.toggleAttribute('required', Boolean(value)) }
  get checked() { return this._checked ?? this.hasAttribute('checked') }
  set checked(value) { this._checked = Boolean(value) }
  get open() { return this.hasAttribute('open') }
  set open(value) { this.toggleAttribute('open', Boolean(value)) }
  get type() {
    const type = (this.getAttribute('type') || '').toLowerCase()
    if (this.localName === 'button') return ['button', 'reset'].includes(type) ? type : 'submit'
    return type || 'text'
  }
  set type(value) { this.setAttribute('type', value) }
  get maxLength() {
    const value = parseInt(this.getAttribute('maxlength'), 10)
    return Number.isFinite(value) ? value : -1
  }
  set maxLength(value) { this.setAttribute('maxlength', String(value)) }
  get options() { return this.querySelectorAll('option') }
  get value() {
    if (this.localName === 'select') {
      const options = this.options
      if (this._value === null) return (options.find((o) => o.hasAttribute('selected')) || options[0])?.value ?? ''
      return options.some((o) => o.value === this._value) ? this._value : ''
    }
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent
    if (this._value !== null) return this._value
    return this.localName === 'textarea' ? this.textContent : this.getAttribute('value') ?? ''
  }
  set value(value) { this._value = String(value) }
  get form() {
    const owner = this.getAttribute('form')
    return owner ? this.ownerDocument.getElementById(owner) : this.closest('form')
  }
  get elements() { return this.querySelectorAll('input, select, textarea, button') }
  get textContent() { return this.childNodes.map((node) => node.textContent).join('') }
  set textContent(value) {
    for (const node of this.childNodes) node.parentNode = null
    this.childNodes = []
    if (value !== '' && value != null) this.appendChild(new FakeText(String(value)))
  }
  get innerText() { return this.textContent }
  set innerText(value) { this.textContent = value }
  get innerHTML() { return this.childNodes.map(serialize).join('') }
  set innerHTML(value) {
    this.textContent = ''
    if (this.localName === 'select') this._value = null
    parseInto(this, String(value), this.ownerDocument)
  }
  insertAdjacentHTML(position, markup) {
    const holder = new FakeElement('div', this.ownerDocument)
    holder.innerHTML = markup
    const nodes = [...holder.childNodes]
    if (position === 'beforeend') this.append(...nodes)
    else if (position === 'afterbegin') { this.append(...nodes); this.childNodes = [...nodes, ...this.childNodes.filter((n) => !nodes.includes(n))] }
    else throw new Error(`假 DOM 不支持 insertAdjacentHTML(${position})`)
  }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes) }
  remove() { this.parentNode?.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null }
  matches(selector) { return matches(this, selector) }
  closest(selector) { for (let el = this; el; el = el.parentElement) if (matches(el, selector)) return el; return null }
  /** 看不看得见：自己或祖先带 hidden 就不渲染（不读 CSS）。 */
  get rendered() {
    if (!this.isConnected) return false
    for (let el = this; el; el = el.parentElement) if (el.hidden) return false
    return true
  }
  getClientRects() { return this.rendered ? [{ width: 1, height: 1 }] : [] }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 } }
  scrollTo() {}
  scrollIntoView() {}
  select() {}
  setSelectionRange() {}
  focus() {
    // Chromium：禁用、没渲染、在 inert 子树里的元素 focus() 什么都不做
    if (this.disabled || !this.rendered) return
    for (let el = this; el; el = el.parentElement) if (el.inert) return
    this.ownerDocument.focused = this
  }
  blur() { if (this.ownerDocument.focused === this) this.ownerDocument.focused = null }
  click() {
    if (this.disabled) return
    const event = new FakeEvent('click', { bubbles: true, cancelable: true })
    this.dispatchEvent(event)
    if (event.defaultPrevented) return
    if (this.localName === 'input' && this.type === 'checkbox') this.checked = !this.checked
    if (this.localName === 'button' && this.type === 'submit' && this.form) this.form.requestSubmit(this)
  }
  requestSubmit(submitter = null) {
    if (!this.hasAttribute('novalidate') && !submitter?.hasAttribute('formnovalidate')) {
      const invalid = this.elements.find((control) => control.required && !control.disabled && control.value === '')
      if (invalid) { invalid.focus(); return }
    }
    const event = new FakeEvent('submit', { bubbles: true, cancelable: true, submitter })
    this.dispatchEvent(event)
    // 没人 preventDefault：真页面会整页跳走（管理页就没了）
    if (!event.defaultPrevented) this.ownerDocument.navigations.push(this.id)
  }
  submit() { this.ownerDocument.navigations.push(this.id) }
}

function serialize(node) {
  if (node.nodeType === 3) return escapeHtml(node.data)
  const attrs = [...node.attributes].map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`)).join('')
  return VOID.has(node.localName) ? `<${node.localName}${attrs}>` : `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`
}

function parseInto(parent, markup, doc) {
  const stack = [parent]
  const top = () => stack[stack.length - 1]
  const tagRe = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  let match
  const text = (value) => { if (value) top().appendChild(new FakeText(decode(value))) }
  while ((match = tagRe.exec(markup))) {
    text(markup.slice(last, match.index))
    last = tagRe.lastIndex
    if (match[1]) {
      const tag = match[1].toLowerCase()
      const at = stack.findLastIndex((node, index) => index > 0 && node.localName === tag)
      if (at > 0) stack.length = at
      continue
    }
    if (!match[2]) continue
    const tag = match[2].toLowerCase()
    let attrText = match[3] || ''
    const selfClosing = /\/\s*$/.test(attrText)
    if (selfClosing) attrText = attrText.replace(/\/\s*$/, '')
    // 两个常见的省略结束标签：连着写的 <li> / <option>
    if ((tag === 'li' || tag === 'option') && top().localName === tag) stack.pop()
    const el = new FakeElement(tag, doc)
    for (const attr of attrText.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      el.attributes.set(attr[1].toLowerCase(), decode(attr[2] ?? attr[3] ?? attr[4] ?? ''))
    }
    top().appendChild(el)
    if (RAW.has(tag)) {
      const endRe = new RegExp(`</${tag}\\s*>`, 'ig')
      endRe.lastIndex = last
      const end = endRe.exec(markup)
      const stop = end ? end.index : markup.length
      if (stop > last) el.appendChild(new FakeText(tag === 'textarea' || tag === 'title' ? decode(markup.slice(last, stop)) : markup.slice(last, stop)))
      last = tagRe.lastIndex = end ? endRe.lastIndex : markup.length
      continue
    }
    if (!selfClosing && !VOID.has(tag)) stack.push(el)
  }
  text(markup.slice(last))
}

class FakeDocument extends FakeNode {
  constructor(markup) {
    super()
    this.nodeType = 9
    this.focused = null
    this.navigations = []
    parseInto(this, markup, this)
  }
  get documentElement() { return this.children.find((node) => node.localName === 'html') }
  get body() { return this.querySelector('body') }
  // 焦点所在的元素被藏起来（弹窗关了）后，浏览器把焦点交回 body
  get activeElement() { return this.focused?.rendered ? this.focused : this.body }
  getElementById(id) { for (const el of walk(this)) if (el.getAttribute('id') === id) return el; return null }
  createElement(tag) { return new FakeElement(tag.toLowerCase(), this) }
  createTextNode(data) { return new FakeText(data) }
}

// ---- 页面上下文：主脚本的全局换成桩，GET / POST 由用例说了算 ----
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setImmediate(resolve))
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const makeEnv = (id, name, extra = {}) => ({
  id, name, dshVersion: '1.0.0', updateChannel: 'official', plugins: [], usedBy: [], applied: [], history: [],
  following: false, source: null, delta: null, ...extra,
})
const following = (id, name) => makeEnv(id, name, { following: true, source: { repo: 'someone/pack', release: 'v1', label: 'someone/pack' } })
const t = (zh, vars) => {
  let text = zh
  for (const [name, value] of Object.entries(vars || {})) text = text.split(`{${name}}`).join(String(value))
  return text
}

/**
 * 打开实例页（等同于在导航里点「实例」）。routes：POST 地址 → (payload, state) => 回包 / Promise / 抛错。
 * state.list 就是 GET /api/environments 的回包，路由里改它等于服务端那边改了数据。
 */
async function openPage({ environments = [makeEnv('a', '甲')], nameMax = 24, routes = {} } = {}) {
  const doc = new FakeDocument(html)
  const state = { list: { environments, builtin: [], limits: { nameMax }, defaults: {} } }
  const calls = []
  const dialogOrigins = new Map()
  const showPackDialog = (dialog, focus) => {
    if (!dialog.hidden) return
    dialogOrigins.set(dialog, doc.activeElement)
    dialog.hidden = false
    focus?.focus()
  }
  const hidePackDialog = async (dialog) => {
    if (dialog.hidden) return
    dialog.hidden = true
    dialogOrigins.get(dialog)?.focus()
    dialogOrigins.delete(dialog)
  }
  const context = vm.createContext({
    document: doc, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone,
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    Event: FakeEvent, KeyboardEvent: FakeEvent, CustomEvent: FakeEvent,
    getComputedStyle: () => ({ zIndex: '0', opacity: '1', transform: 'none' }),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    t, escapeHtml, notify() {}, notifyError() {}, appConfirm: async () => true,
    AUTO_VERSION: 'auto', UPDATE_CHANNELS: ['official', 'rc', 'alpha'], UPDATE_CHANNEL_NAMES: { official: '正式版', rc: '预览版', alpha: '测试版' },
    installedList: () => ['1.0.0'], recommendedVersion: () => '1.0.0',
    switchChannel: (input) => ['official', 'rc', 'alpha'][Number(input.value)] || 'official',
    paintChannelSwitch() {}, createUiSelect() {}, syncUiSelect() {}, closeUiSelect() {}, openVersionManager() {},
    paintCompatibilityResult() {}, paintLaunchVersionGroup() {}, setLaunchVersion() {}, launchChannel: () => 'official',
    openImportDialog() {}, inspectPack: async () => {}, openExportDialog() {}, packNotes: () => '',
    packMoreIcons: { copy: '', export: '', trash: '' },
    gridCardHtml: ({ data, name, menu = '' }) => `<div class="pack-card"><button type="button" ${Object.entries(data).map(([key, value]) => `data-${kebab(key)}="${escapeHtml(value)}"`).join(' ')}>${escapeHtml(name)}</button><details>${menu}</details></div>`,
    environmentState: { pendingOpen: '', defaults: {}, reload: null }, paneLoaders: {},
    showPackDialog, hidePackDialog, forceHidePackDialog: hidePackDialog,
    trapPackDialog(dialog, close) {
      dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } })
      dialog.addEventListener('click', (event) => { if (event.target === dialog) close() })
    },
    showDialog: async (dialog) => { dialog.hidden = false; return true },
    hideDialog: async (dialog) => { dialog.hidden = true; return true },
    async getJson(url) {
      calls.push({ method: 'GET', url })
      return structuredClone(state.list)
    },
    async post(url, payload) {
      // 在主上下文里拷一份：vm 里的对象原型不同，deepStrictEqual 会因为原型不等而失败
      calls.push({ method: 'POST', url, payload: structuredClone(payload) })
      return routes[url] ? routes[url](payload, state) : {}
    },
  })
  context.window = context
  vm.runInContext(envPage, context, { filename: 'environments-page.js' })
  await context.paneLoaders.environments()
  await settle()
  const $ = (id) => doc.getElementById(id)
  return {
    doc, $, state, context, calls,
    created: () => calls.filter((call) => call.url === '/api/environments/create'),
    focused: () => doc.activeElement?.id || doc.activeElement?.localName,
  }
}

// 用户动作：点之前先聚焦（Chromium 点按钮会给它焦点），敲字后发 input
function click(h, id) {
  const node = h.$(id)
  assert.ok(node, `页面上要有 #${id}`)
  node.focus()
  node.click()
}
function typeInto(h, id, text) {
  const node = h.$(id)
  assert.ok(node, `页面上要有 #${id}`)
  node.focus()
  node.value = text
  node.dispatchEvent(new FakeEvent('input', { bubbles: true }))
}
/** 在当前焦点上按键；Enter 在文本框里走浏览器的隐式提交（默认提交钮禁用时不提交）。 */
function press(h, key) {
  const target = h.doc.activeElement
  const event = new FakeEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  if (key !== 'Enter' || event.defaultPrevented || target.localName !== 'input' || target.disabled || !target.form) return
  const fallback = target.form.elements.find((control) => ['button', 'input'].includes(control.localName) && control.type === 'submit')
  if (!fallback?.disabled) target.form.requestSubmit(fallback || null)
}
async function openCreateDialog(h) {
  click(h, 'environmentCreate')
  await settle()
  assert.equal(h.$('environmentCreateDialog')?.hidden, false, '点「新建实例」要打开新建弹窗')
}

// ---- 结构：只读 index.html 解析出来的树 ----
const page = new FakeDocument(html)
const byId = (id) => page.getElementById(id)
const header = page.querySelector('#pane-environments .pane-top')
const EN = new vm.Script(`(${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`).runInNewContext()
const CJK = /[一-鿿]/
/** 按钮上看得见的字：图标（svg）里的东西不算。 */
const visibleText = (node) => node.childNodes.map((child) => (child.nodeType === 3 ? child.data : child.localName === 'svg' ? '' : visibleText(child))).join('')
const iconOf = (node) => node.querySelector('svg use')?.getAttribute('href') || node.querySelector('svg use')?.getAttribute('xlink:href') || ''
const ownText = (node) => node.childNodes.filter((child) => child.nodeType === 3).map((child) => child.data).join('').trim()

test('顶栏不再常驻名字输入框：新实例的名字只在新建弹窗里填', () => {
  assert.ok(header, '实例页要有顶栏 #pane-environments .pane-top')
  const textInputs = header.querySelectorAll('input').filter((input) => ['text', 'search'].includes(input.type))
  assert.deepEqual(textInputs.map((input) => input.id), [], '顶栏里不该再有文本输入框')
  const name = byId('environmentNewName')
  assert.ok(name, '名字框 #environmentNewName 还在（挪进了弹窗）')
  assert.ok(!header.contains(name), '名字框不在顶栏里')
  assert.ok(byId('environmentCreateDialog')?.contains(name), '名字框在新建弹窗里')
  assert.equal(name.rendered, false, '弹窗默认藏着，所以名字框一开始看不见')
})

test('顶栏右侧依次是检查更新、导入、新建实例，三个都是普通按钮（不提交任何表单）', () => {
  const ids = ['environmentCheckUpdates', 'environmentImport', 'environmentCreate']
  const order = header.querySelectorAll('button').map((button) => button.id).filter((id) => ids.includes(id))
  assert.deepEqual(order, ids, '三个动作都在顶栏里，DOM 顺序是检查更新 → 导入 → 新建实例')
  for (const id of ids) {
    assert.equal(byId(id).localName, 'button', `#${id} 是按钮`)
    assert.equal(byId(id).getAttribute('type'), 'button', `#${id} 要写明 type="button"`)
  }
  // 标题在左、动作在右：动作排在标题后面
  const all = [...walk(header)]
  assert.ok(all.indexOf(header.querySelector('h1')) < all.indexOf(byId('environmentCheckUpdates')), '动作排在标题后面')
})

test('检查更新是只有图标的按钮：refresh-cw 图标，提示和读屏名都是「检查更新」并且会翻译', () => {
  const button = byId('environmentCheckUpdates')
  assert.equal(iconOf(button), '/icons.svg#lucide-refresh-cw', '图标走 Lucide 雪碧图的 refresh-cw')
  assert.equal(visibleText(button).trim(), '', '只有图标，不带看得见的字')
  for (const name of ['title', 'aria-label', 'data-i18n-title', 'data-i18n-aria-label']) {
    assert.equal(button.getAttribute(name), '检查更新', `${name} 是「检查更新」`)
  }
  // data-i18n 会让 applyLang 用文字整个替换按钮内容，图标就没了
  assert.equal(button.closest('[data-i18n]'), null, '按钮本身不能带 data-i18n')
  assert.equal(button.querySelector('[data-i18n]'), null, '只有图标的按钮里没有要翻译的文字')
})

test('导入、新建实例是图标加文字；翻译时只换文字那一截，不会把图标冲掉', () => {
  for (const [id, icon, label] of [['environmentImport', 'lucide-download', '导入…'], ['environmentCreate', 'lucide-plus', '新建实例']]) {
    const button = byId(id)
    assert.equal(iconOf(button), `/icons.svg#${icon}`, `#${id} 用 ${icon} 图标`)
    assert.equal(visibleText(button).trim(), label, `#${id} 的字是「${label}」`)
    // applyLang 把 [data-i18n] 元素的 textContent 整个换掉：挂标记的元素里不能还有图标
    const carriers = [button, ...button.querySelectorAll('[data-i18n]')].filter((node) => node.hasAttribute('data-i18n'))
    assert.equal(carriers.length, 1, `#${id} 里恰好一处翻译标记`)
    assert.equal(carriers[0].getAttribute('data-i18n'), label)
    assert.equal(carriers[0].children.length, 0, `#${id} 的翻译标记挂在纯文字元素上，不能挂在带图标的按钮上`)
  }
})

test('新建弹窗的结构：对话框语义、标题、带 label 的名字框、错误提示和三个按钮', () => {
  const dialog = byId('environmentCreateDialog')
  assert.ok(dialog, '要有 #environmentCreateDialog')
  assert.ok(dialog.classList.contains('ask'), '和别的弹窗一样是 .ask 遮罩')
  assert.equal(dialog.hidden, true, '默认藏着')
  const form = byId('environmentCreateForm')
  assert.equal(form?.localName, 'form', '#environmentCreateForm 是表单')
  assert.ok(dialog.contains(form), '表单在弹窗里')
  assert.equal(form.getAttribute('role'), 'dialog')
  assert.equal(form.getAttribute('aria-modal'), 'true')
  assert.equal(form.getAttribute('aria-labelledby'), 'environmentCreateTitle')

  const title = byId('environmentCreateTitle')
  assert.ok(form.contains(title), '标题在表单里，读屏才念得到')
  assert.equal(title.textContent.trim(), '新建实例')
  assert.ok([title, ...title.querySelectorAll('[data-i18n]')].some((node) => node.getAttribute('data-i18n') === '新建实例'), '标题会翻译')

  const label = form.querySelector('label[for="environmentNewName"]')
  assert.ok(label, '名字框有自己的 label（点字也能聚焦，读屏念得出名字）')
  assert.equal(label.textContent.trim(), '实例名称')
  const name = byId('environmentNewName')
  assert.equal(name.localName, 'input')
  assert.equal(name.type, 'text')
  assert.equal(name.getAttribute('autocomplete'), 'off', '浏览器别把以前填过的名字弹出来')
  assert.equal(name.form, form, '名字框属于新建表单，回车就能提交')

  const error = byId('environmentCreateError')
  assert.ok(form.contains(error), '错误提示在弹窗里')
  assert.equal(error.getAttribute('role'), 'alert', '出错时读屏要马上念')
  assert.equal(error.hidden, true, '错误提示默认藏着')

  const cancel = byId('environmentCreateCancel')
  assert.ok(form.contains(cancel))
  assert.equal(cancel.localName, 'button')
  assert.equal(cancel.getAttribute('type'), 'button', '取消不能是提交钮')
  assert.equal(visibleText(cancel).trim(), '取消')

  const close = byId('environmentCreateClose')
  assert.ok(form.contains(close))
  assert.equal(close.localName, 'button')
  assert.equal(close.getAttribute('type'), 'button', '关闭不能是提交钮')
  assert.ok(close.querySelector('svg'), '关闭是图标按钮')
  assert.ok(close.getAttribute('aria-label') || close.getAttribute('title'), '图标按钮要有可读的名字')

  const save = byId('environmentCreateSave')
  assert.ok(form.contains(save))
  assert.equal(save.localName, 'button')
  assert.equal(save.type, 'submit', '创建是表单的提交钮')
  assert.equal(visibleText(save).trim(), '创建')
})

test('英文界面：顶栏和新建弹窗的文案都有英文，弹窗里看得见的中文都挂了翻译标记', () => {
  for (const zh of ['新建实例', '实例名称', '创建', '取消', '检查更新', '导入…']) {
    assert.ok(EN[zh], `「${zh}」缺英文`)
    assert.doesNotMatch(EN[zh], CJK, `「${zh}」的英文里不该还有中文`)
  }
  const dialog = byId('environmentCreateDialog')
  for (const region of [header, dialog]) {
    for (const node of [region, ...walk(region)]) {
      // 直接写在元素里的中文（标题、label、名字框下面的说明……）要能被 applyLang 换掉
      const text = ownText(node)
      if (CJK.test(text)) {
        assert.equal(node.getAttribute('data-i18n'), node.textContent.trim(), `「${text}」要挂 data-i18n`)
      }
      if (CJK.test(node.getAttribute('placeholder') || '')) assert.ok(node.hasAttribute('data-placeholder-i18n'), `占位「${node.placeholder}」要挂 data-placeholder-i18n`)
      for (const name of ['data-i18n', 'data-i18n-title', 'data-i18n-aria-label', 'data-placeholder-i18n']) {
        const key = node.getAttribute(name)
        if (key) assert.ok(EN[key], `「${key}」缺英文（${name}）`)
      }
    }
  }
  // 顶栏的图标按钮靠 title / aria-label 说话，它们也要跟着翻
  for (const node of walk(header)) {
    for (const [name, marker] of [['title', 'data-i18n-title'], ['aria-label', 'data-i18n-aria-label']]) {
      const value = node.getAttribute(name)
      if (value && CJK.test(value)) assert.equal(node.getAttribute(marker), value, `顶栏 #${node.id} 的 ${name}「${value}」要挂 ${marker}`)
    }
  }
})

test('实例页脚本里 t() 用到的文案都有英文（弹窗的提示、报错不会在英文界面露中文）', () => {
  const keys = [...envPage.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2])
  assert.ok(keys.length > 0)
  const missing = [...new Set(keys)].filter((key) => !EN[key])
  assert.deepEqual(missing, [], '这些文案缺英文')
})

// ---- 交互 ----
test('点「新建实例」打开弹窗：名字框是空的、错误藏着、焦点在名字框上', async () => {
  const h = await openPage()
  await openCreateDialog(h)
  assert.equal(h.$('environmentNewName').value, '')
  assert.equal(h.$('environmentCreateError').hidden, true)
  assert.equal(h.focused(), 'environmentNewName', '打开就能直接敲名字')
  assert.equal(h.created().length, 0, '光打开不发请求')
})

test('每次打开都是干净的：取消过、失败过、成功过之后再开，旧名字清空、旧错误藏起来', async () => {
  // 判定表：上一次怎么收场 × 再次打开后的样子（都一样：空名字、无错误、焦点在名字框）
  const scenarios = {
    '敲了名字后取消': async (h) => {
      typeInto(h, 'environmentNewName', '没建成')
      click(h, 'environmentCreateCancel')
    },
    '提交失败后取消': async (h) => {
      h.state.fail = true
      typeInto(h, 'environmentNewName', '重名了')
      click(h, 'environmentCreateSave')
      await settle()
      assert.equal(h.$('environmentCreateError').hidden, false, '先确认错误确实露出来过')
      click(h, 'environmentCreateCancel')
    },
    '提交失败后按 Esc': async (h) => {
      h.state.fail = true
      typeInto(h, 'environmentNewName', '重名了')
      click(h, 'environmentCreateSave')
      await settle()
      h.$('environmentNewName').focus()
      press(h, 'Escape')
    },
    '创建成功': async (h) => {
      typeInto(h, 'environmentNewName', '乙')
      click(h, 'environmentCreateSave')
    },
  }
  for (const [name, finish] of Object.entries(scenarios)) {
    const h = await openPage({
      routes: {
        '/api/environments/create': (payload, state) => {
          if (state.fail) throw new Error('已经有这个名字的实例了')
          state.list.environments.push(makeEnv('env-new', payload.name))
          return { environment: { id: 'env-new', name: payload.name } }
        },
      },
    })
    await openCreateDialog(h)
    await finish(h)
    await settle()
    assert.equal(h.$('environmentCreateDialog').hidden, true, `${name}：弹窗先关上了`)
    await openCreateDialog(h)
    assert.equal(h.$('environmentNewName').value, '', `${name}：再开时名字框是空的`)
    assert.equal(h.$('environmentCreateError').hidden, true, `${name}：再开时旧错误藏起来`)
    assert.equal(h.focused(), 'environmentNewName', `${name}：再开时焦点在名字框`)
  }
})

test('名字为空或只有空白：不发请求，弹窗留着，焦点回到名字框（点创建、按回车都一样）', async () => {
  // 等价类：空串 / 半角空格 / 混合空白 / 全角空格（trim 会去掉 U+3000）
  for (const value of ['', ' ', '\t \n', '　　']) {
    for (const how of ['点创建', '按回车']) {
      const h = await openPage()
      await openCreateDialog(h)
      typeInto(h, 'environmentNewName', value)
      if (how === '点创建') click(h, 'environmentCreateSave')
      else press(h, 'Enter')
      await settle()
      const label = `${JSON.stringify(value)}，${how}`
      assert.equal(h.created().length, 0, `${label}：不该发新建请求`)
      assert.equal(h.$('environmentCreateDialog').hidden, false, `${label}：弹窗留着`)
      assert.equal(h.focused(), 'environmentNewName', `${label}：焦点回到名字框`)
      assert.deepEqual(h.doc.navigations, [], `${label}：表单提交不能让整页跳走`)
    }
  }
})

test('提交：名字去掉首尾空白后 POST 一次；一个字、刚好到上限、中间带空格都照原样发', async () => {
  // 边界值：最短 1 个字、上限 24 个字（limits.nameMax）
  const cases = [[' 甲 ', '甲'], ['a', 'a'], [`  ${'名'.repeat(24)}  `, '名'.repeat(24)], ['工作 实例', '工作 实例']]
  for (const [typed, sent] of cases) {
    for (const how of ['点创建', '按回车']) {
      const h = await openPage({ nameMax: 24, routes: { '/api/environments/create': () => ({ environment: { id: 'a', name: sent } }) } })
      await openCreateDialog(h)
      typeInto(h, 'environmentNewName', typed)
      if (how === '点创建') click(h, 'environmentCreateSave')
      else press(h, 'Enter')
      await settle()
      const label = `${JSON.stringify(typed)}，${how}`
      assert.deepEqual(h.created().map((call) => call.payload), [{ name: sent }], `${label}：只发一次，内容就是去掉首尾空白的名字`)
      assert.deepEqual(h.doc.navigations, [], `${label}：表单提交不能让整页跳走`)
    }
  }
})

test('请求还没回来时连点两次创建、再按回车，也只发一个新建请求', async () => {
  const pending = deferred()
  const h = await openPage({
    routes: {
      '/api/environments/create': (payload, state) => pending.promise.then(() => {
        state.list.environments.push(makeEnv('env-new', payload.name))
        return { environment: { id: 'env-new', name: payload.name } }
      }),
    },
  })
  await openCreateDialog(h)
  typeInto(h, 'environmentNewName', '乙')
  click(h, 'environmentCreateSave')
  click(h, 'environmentCreateSave')
  h.$('environmentNewName').focus()
  press(h, 'Enter')
  await settle()
  assert.equal(h.created().length, 1, '请求进行中再提交不能重复建')
  pending.resolve()
  await settle()
  assert.equal(h.created().length, 1, '回包之后也没有补发')
  assert.equal(h.$('environmentCreateDialog').hidden, true)
  assert.deepEqual(h.doc.navigations, [])
})

test('创建成功：弹窗关上，进入服务端回包里 environment.id 那个实例的详情', async () => {
  // 同名的老实例在前面：只有按回包的 id 找，才会打开 9.9.9 那个新的
  const h = await openPage({
    environments: [makeEnv('a', '乙')],
    routes: {
      '/api/environments/create': (payload, state) => {
        state.list.environments.push(makeEnv('env-new', payload.name, { dshVersion: '9.9.9' }))
        return { environment: { id: 'env-new', name: payload.name } }
      },
    },
  })
  assert.equal(h.$('environmentView').hidden, true, '起初在实例列表')
  await openCreateDialog(h)
  typeInto(h, 'environmentNewName', '乙')
  click(h, 'environmentCreateSave')
  await settle()
  assert.equal(h.$('environmentCreateDialog').hidden, true, '成功后弹窗关上')
  assert.equal(h.$('environmentView').hidden, false, '进入详情')
  assert.equal(h.$('environmentOverview').hidden, true, '列表收起来')
  assert.equal(h.$('environmentDetailName').textContent, '乙')
  assert.match(h.$('environmentDetailSub').textContent, /9\.9\.9/, '打开的是新建出来的那个（id 来自回包），不是同名的老实例')
  assert.equal(h.$('environmentName').value, '乙', '详情页的名字框填的是新实例')
})

test('创建失败：弹窗留着，名字框下面的错误提示露出来，写着服务端给的原因', async () => {
  const message = '实例名称不能超过 24 个字'
  const h = await openPage({ routes: { '/api/environments/create': () => { throw new Error(message) } } })
  await openCreateDialog(h)
  typeInto(h, 'environmentNewName', '甲')
  click(h, 'environmentCreateSave')
  await settle()
  assert.equal(h.created().length, 1)
  assert.equal(h.$('environmentCreateDialog').hidden, false, '失败不关弹窗，用户改了名字还能再试')
  const error = h.$('environmentCreateError')
  assert.equal(error.hidden, false, '错误提示露出来')
  assert.match(error.textContent, new RegExp(message), '写的是服务端的原因')
  assert.equal(h.$('environmentView').hidden, true, '没建成就不进详情')
})

test('失败之后改个名字再提交可以重试；成功后照常关弹窗进详情', async () => {
  // 状态迁移：打开 → 提交失败（报错）→ 再提交（第二个请求）→ 成功（关弹窗、进详情）
  const h = await openPage({
    routes: {
      '/api/environments/create': (payload, state) => {
        if (payload.name === '甲') throw new Error('已经有叫「甲」的实例了')
        state.list.environments.push(makeEnv('env-new', payload.name))
        return { environment: { id: 'env-new', name: payload.name } }
      },
    },
  })
  await openCreateDialog(h)
  typeInto(h, 'environmentNewName', '甲')
  click(h, 'environmentCreateSave')
  await settle()
  assert.equal(h.$('environmentCreateError').hidden, false)
  typeInto(h, 'environmentNewName', '甲二')
  click(h, 'environmentCreateSave')
  await settle()
  assert.deepEqual(h.created().map((call) => call.payload.name), ['甲', '甲二'], '失败后不能被「请求中」的标记卡住')
  assert.equal(h.$('environmentCreateDialog').hidden, true)
  assert.equal(h.$('environmentDetailName').textContent, '甲二')
})

test('取消、关闭按钮、Esc 都只关弹窗，不发任何请求', async () => {
  const closers = {
    取消: (h) => click(h, 'environmentCreateCancel'),
    关闭按钮: (h) => click(h, 'environmentCreateClose'),
    Esc: (h) => { h.$('environmentNewName').focus(); press(h, 'Escape') },
  }
  for (const [name, close] of Object.entries(closers)) {
    const h = await openPage()
    await openCreateDialog(h)
    typeInto(h, 'environmentNewName', '不建了')
    const before = h.calls.length
    close(h)
    await settle()
    assert.equal(h.$('environmentCreateDialog').hidden, true, `${name}：弹窗关上`)
    assert.equal(h.created().length, 0, `${name}：不发新建请求`)
    assert.deepEqual(h.calls.slice(before).filter((call) => call.method === 'POST'), [], `${name}：不发任何 POST`)
    assert.deepEqual(h.doc.navigations, [], `${name}：不触发整页提交`)
  }
})

test('名字框的长度上限跟着 GET /api/environments 的 limits.nameMax 走，和详情页的名字框一样', async () => {
  const h = await openPage({ nameMax: 24 })
  assert.equal(h.$('environmentNewName').maxLength, 24, '新建弹窗的名字框')
  assert.equal(h.$('environmentName').maxLength, 24, '详情页的名字框')
  await openCreateDialog(h)
  assert.equal(h.$('environmentNewName').maxLength, 24, '打开弹窗不会把上限冲掉')
  click(h, 'environmentCreateCancel')
  await settle()
  // 服务端改了上限：再进实例页就按新的来（边界：最小 1，再到一个更大的值）
  for (const nameMax of [1, 64]) {
    h.state.list.limits = { nameMax }
    await h.context.paneLoaders.environments()
    await settle()
    assert.equal(h.$('environmentNewName').maxLength, nameMax, `上限 ${nameMax}：新建弹窗跟上`)
    assert.equal(h.$('environmentName').maxLength, nameMax, `上限 ${nameMax}：详情页跟上`)
  }
})

test('检查更新进行中：按钮禁用并带 is-checking；成功或失败结束后两者都撤掉，还能再查', async () => {
  const checks = []
  const h = await openPage({
    environments: [following('a', '甲')],
    routes: { '/api/environments/updates': () => { const one = deferred(); checks.push(one); return one.promise } },
  })
  // 进页面时那次自动检查先收掉，下面只看按钮触发的
  for (const one of checks.splice(0)) one.resolve({ updates: {} })
  await settle()
  const button = h.$('environmentCheckUpdates')
  const idle = (label) => {
    assert.equal(button.disabled, false, `${label}：按钮恢复可点`)
    assert.equal(button.classList.contains('is-checking'), false, `${label}：去掉 is-checking`)
  }
  const running = (label) => {
    assert.equal(button.disabled, true, `${label}：按钮禁用，免得连点`)
    assert.equal(button.classList.contains('is-checking'), true, `${label}：带 is-checking（图标转起来）`)
  }
  idle('起初')
  for (const outcome of ['成功', '失败', '再次成功']) {
    click(h, 'environmentCheckUpdates')
    await settle()
    assert.equal(checks.length, 1, `${outcome}：点一下发一次检查`)
    running(`${outcome}：检查中`)
    const one = checks.pop()
    outcome === '失败' ? one.reject(new Error('offline')) : one.resolve({ updates: {} })
    await settle()
    idle(`${outcome}：检查结束`)
  }
})

test('进实例页时的自动检查也一样：检查中按钮禁用带 is-checking，回来后恢复', async () => {
  const checks = []
  const h = await openPage({
    environments: [following('a', '甲')],
    routes: { '/api/environments/updates': () => { const one = deferred(); checks.push(one); return one.promise } },
  })
  const button = h.$('environmentCheckUpdates')
  assert.equal(checks.length, 1, '进页面会查一次上游')
  assert.equal(button.disabled, true)
  assert.equal(button.classList.contains('is-checking'), true)
  checks.pop().resolve({ updates: {} })
  await settle()
  assert.equal(button.disabled, false)
  assert.equal(button.classList.contains('is-checking'), false)
})

test('没有跟随上游的实例时点检查更新，按钮不会卡在「检查中」', async () => {
  const h = await openPage({ environments: [makeEnv('a', '甲')] })
  click(h, 'environmentCheckUpdates')
  await settle()
  const button = h.$('environmentCheckUpdates')
  assert.equal(button.disabled, false)
  assert.equal(button.classList.contains('is-checking'), false)
})
