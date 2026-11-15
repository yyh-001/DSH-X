import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// 执行实际页面脚本；仅替代 DOM/动画，不复制拖动状态机。
export function internalTabs({ reducedMotion = true } = {}) {
  const sent = [], errors = [], frames = new Map(), timers = new Map()
  const captures = new Map(), downTargets = new Map()
  const metrics = { reads: 0, animations: 0 }
  let serial = 0, document, now = 0
  class Node {
    constructor(className = '') {
      this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.scrollLeft = 0
      this.scrollTop = 0; this.clientLeft = 0; this.clientTop = 0
      this.textContent = ''; this.hidden = false; this.disabled = false; this.pointer = null
      const classes = new Set(className.split(' ').filter(Boolean))
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name) },
      }
      Object.defineProperty(this, 'className', { set(value) { classes.clear(); value.split(' ').forEach((name) => classes.add(name)) } })
      this.style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
    }
    get firstElementChild() { return this.children[0] }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] }
    get isConnected() { return !!this.parentNode }
    get offsetLeft() { return this.parentNode?.children.indexOf(this) * 200 || 0 }
    get offsetWidth() { return 200 }
    get offsetTop() { return 0 }
    get offsetHeight() { return 30 }
    get scrollWidth() { return this.children.length * 200 }
    set innerHTML(_value) {
      const label = new Node('internal-tab-label')
      label.append(new Node('span'))
      this.append(label, new Node('internal-tab-menu'), new Node('internal-tab-close'))
    }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node) }
    }
    after(node) {
      const parent = this.parentNode
      node.remove(); node.parentNode = parent
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node)
    }
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
      this.parentNode = null
    }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)) }
    matches(selector) { return selector === 'span' ? this.classList.contains('span') : this.classList.contains(selector.slice(1)) }
    closest(selector) {
      return selector.split(',').some((part) => this.matches(part.trim())) ? this : this.parentNode?.closest(selector)
    }
    querySelector(selector) {
      const [head, tail] = selector.split(' ')
      for (const child of this.children) {
        if (child.matches(head)) return tail ? child.querySelector(tail) : child
        const found = child.querySelector(selector)
        if (found) return found
      }
      return null
    }
    getBoundingClientRect() { metrics.reads++; return this.bounds || { left: 100 + this.offsetLeft - list.scrollLeft, right: 300 + this.offsetLeft - list.scrollLeft, top: 10, bottom: 40, width: 200, height: 30 } }
    setAttribute(name, value) { this.attributes[name] = value }
    removeAttribute(name) { delete this.attributes[name] }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener) }
    emit(name, event) { for (const listener of this.listeners[name] || []) listener(event) }
    setPointerCapture(id) {
      const previous = captures.get(id)
      if (previous === this) return
      captures.set(id, this); this.pointer = id
      if (previous) {
        previous.pointer = null
        if (list.contains(previous)) list.emit('lostpointercapture', { target: previous, pointerId: id })
      }
    }
    releasePointerCapture(id) {
      if (captures.get(id) !== this) return
      captures.delete(id); this.pointer = null
      if (list.contains(this)) list.emit('lostpointercapture', { target: this, pointerId: id })
    }
    focus() { document.activeElement = this }
    scrollIntoView() {}
    animate() { metrics.animations++; return { cancel() {}, finished: new Promise(() => {}) } }
  }
  const list = new Node(), area = new Node(), header = new Node(), main = new Node(), reload = new Node()
  list.bounds = { left: 100, right: 700, top: 10, bottom: 40, width: 600 }
  header.bounds = { bottom: 40 }
  area.append(list, reload)
  const root = new Node(reducedMotion ? 'reduce-motion' : ''), body = new Node()
  body.append(header, area, main)
  const nodes = { internalTabsArea: area, internalTabList: list, internalTabReload: reload }
  document = Object.assign(new Node(), {
    documentElement: root, body, activeElement: null,
    getElementById: (id) => nodes[id], createElement: () => new Node(),
    querySelector: (selector) => selector === 'header' ? header : selector === 'main' ? main : null,
  })
  const window = Object.assign(new Node(), { innerWidth: 1000, ipc: { postMessage(message) {
    sent.push(message.startsWith('{') ? JSON.parse(message) : message)
  } }, notifyError: (error) => errors.push(error.message) })
  const context = vm.createContext({ window, document, Date: { now: () => now }, matchMedia: () => ({ matches: reducedMotion }),
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn) => { frames.set(++serial, fn); return serial }, cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (fn) => { timers.set(++serial, fn); return serial }, clearTimeout: (id) => timers.delete(id),
  })
  vm.runInContext(readFileSync(new URL('../../src/public/internal-tabs.js', import.meta.url), 'utf8'), context)
  const state = { enabled: true, active: 'a', lang: 'zh', presentation: 1, detach: { supported: true, drag: true },
    tabs: ['a', 'b', 'c'].map((id) => ({ id, title: id })) }
  const update = (patch = {}) => { Object.assign(state, patch); window.updateInternalTabs(state) }
  update()
  sent.length = 0
  const item = (id) => list.children.find((node) => node.dataset.id === id)
  const event = (id, patch = {}) => ({ target: item(id)?.querySelector('.internal-tab-label'), button: 0, isPrimary: true,
    pointerId: 1, pointerType: 'mouse', clientX: 150, clientY: 25,
    preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true }, ...patch })
  // 浏览器按 pointerup 当时的捕获目标派发 click，之后释放捕获也不会把 click 还给原按钮。
  // 独立模拟平台派发边界；不在夹具里补 select，真正处理仍由实际页面脚本的点击监听器完成。
  const activate = (id, patch = {}) => {
    const click = event(id, { detail:0, ...patch })
    if (list.contains(click.target)) list.emit('click', click)
    for (let node = click.target; node && !click.stopped; node = node.parentNode) node.onclick?.(click)
    return click
  }
  const releaseClick = (id, patch = {}) => {
    const up = event(id, patch), captured = captures.get(up.pointerId)
    document.emit('pointerup', { ...up, target: captured || up.target })
    captures.get(up.pointerId)?.releasePointerCapture(up.pointerId)
    let target = captured || up.target
    if (!captured) {
      const down = downTargets.get(up.pointerId)
      while (target && !target.contains(down)) target = target.parentNode
    }
    const click = activate(id, { ...patch, target, detail:1 })
    downTargets.delete(up.pointerId)
    return click
  }
  const tick = () => { const next = [...frames.values()]; frames.clear(); for (const fn of next) fn() }
  return { list, window, document, state, update, item, event, sent, errors, metrics,
    pendingFrames: () => frames.size,
    ids: () => list.children.map((node) => node.dataset.id),
    captureTarget: (id = 1) => captures.get(id) || null,
    releaseClick, activate, advanceTime: ms => { now += ms },
    down(id, patch) { const down = event(id, patch); downTargets.set(down.pointerId, down.target); list.emit('pointerdown', down) },
    move(id, patch, paint = true) { document.emit('pointermove', event(id, patch)); if (paint) tick() },
    up(id, patch) { document.emit('pointerup', event(id, patch)) },
    tick,
  }
}
