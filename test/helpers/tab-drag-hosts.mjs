import { EventEmitter } from 'node:events'
import { internalTabs } from './internal-tabs-dom.mjs'
import { InstanceViews } from '../../shell/instance-views.mjs'
import { BrowserTabs } from '../../shell/tabs.mjs'
import { InstanceWindow } from '../../shell/instance-window.mjs'
import { parseTabAction } from '../../shell/model.mjs'

export function harness({ animation = false } = {}) {
  const ui = internalTabs({ reducedMotion: !animation }), states = [], animations = new Map()
  // 原 helper 没有动画几何：只补 getBoundingClientRect 的 transform，完成时归零。
  if (animation) {
    const proto = Object.getPrototypeOf(ui.list), rect = proto.getBoundingClientRect
    proto.animate = function (frames) {
      let resolve
      const finished = new Promise(done => { resolve = done })
      const offset = Number(frames[0].transform?.match(/translateX\(([-\d.]+)px\)/)?.[1] || 0)
      const entry = { offset, finish: () => { if (animations.get(this) === entry) animations.delete(this); resolve() } }
      animations.set(this, entry)
      return { finished, cancel: entry.finish }
    }
    proto.getBoundingClientRect = function () {
      const box = rect.call(this), offset = animations.get(this)?.offset || 0
      return { ...box, left: box.left + offset, right: box.right + offset }
    }
  }
  class Window extends EventEmitter {
    constructor(manager = {}) {
      super(); this.visible = true; this.destroyed = false
      this.webContents = { executeJavaScript: async () => 0, focus() {}, getZoomFactor: () => 1, ...manager }
      this.contentView = { addChildView() {}, removeChildView() {} }
      this.bounds = { x: 0, y: 0, width: 1000, height: 700 }
    }
    getBounds() { return this.bounds }
    getContentBounds() { return this.bounds }
    setBounds(bounds) { this.bounds = bounds }
    isDestroyed() { return this.destroyed }
    isFocused() { return true }
    isVisible() { return this.visible }
    isMinimized() { return false }
    isMaximized() { return false }
    isFullScreen() { return false }
    getOpacity() { return this.opacity ?? 1 }
    setOpacity(value) { this.opacity = value }
    setSkipTaskbar(value) { this.skipTaskbar = value }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  let registry
  const hooks = { retire: record => registry.retire(record), dispose: id => registry.disposeView(id), reveal() {}, titles() {}, quitting: () => false, hidden() {}, detach: () => ({ supported: true, drag: true, merge: true, live: true }) }
  const source = new BrowserTabs(new Window({ executeJavaScript: async script => {
    const match = script.match(/^window.updateInternalTabs\?\.\((.*)\)$/)
    if (match) states.push(JSON.parse(match[1]))
    return 0
  } }), hooks)
  const createHost = () => new InstanceWindow(new Window(), hooks)
  registry = new InstanceViews({ createHost: kind => kind === 'internal' ? source : createHost(), createView: () => ({ setVisible() {}, setBounds() {}, setBackgroundColor() {}, webContents: {
    url: '', loads: [], getURL() { return this.url }, async loadURL(url) { this.url = url; this.loads.push(url) }, focus() {}, isDestroyed: () => false, close() {}, executeJavaScript: async () => '',
  } }) })
  const records = ['a','b','c'].map(id => registry.presentInstance({ id, title: id, url: `http://127.0.0.1:4444/${id}`, managed: false, status: 'running' }))
  let processed = 0
  // 仅传输真实 BrowserTabs.render 产生的 state；布局命令经真实 parser/action 送回宿主。
  const flush = () => {
    let n = 0
    while (states.length) { if (++n > 100) throw Error('unexpected render loop'); ui.update(states.shift()) }
    const commands = []
    while (processed < ui.sent.length) {
      const message = ui.sent[processed++]
      const action = parseTabAction(typeof message === 'string' ? message : JSON.stringify(message))
      if (!action) continue
      if (['tab-strip','layout','present','overlay'].includes(action.action)) source.action(action)
      else commands.push(action)
    }
    return commands
  }
  flush(); ui.tick(); flush()
  return { ui, source, registry, records, createHost, flush, states, animations, Window, hooks }
}
