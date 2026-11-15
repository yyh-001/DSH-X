import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { WindowFade } from '../shell/window-fade.mjs'

function fixture(platform = 'win32') {
  let time = 0, serial = 0, enabled = true
  const frames = new Map(), values = []
  const window = Object.assign(new EventEmitter(), {
    opacity: 1, visible: true, destroyed: false,
    isDestroyed() { return this.destroyed }, isVisible() { return this.visible },
    getOpacity() { return this.opacity },
    setOpacity(value) { assert.ok(!this.destroyed); this.opacity = value; values.push(value) },
    showInactive() { this.visible = true }, hide() { this.visible = false },
    destroy() { this.destroyed = true; this.emit('closed') },
  })
  const host = { window }
  const fade = new WindowFade(host, { platform, enabled: () => enabled, now: () => time,
    schedule(fn) { frames.set(++serial, fn); return serial }, cancel(id) { frames.delete(id) } })
  return { host, window, fade, frames, values, disable() { enabled = false },
    advance(ms) { time += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() } }
}

test('新窗口先透明后显示，140ms 内单调淡入且完成后没有空转帧', () => {
  const f = fixture()
  f.window.visible = false
  f.fade.prepareEnter()
  assert.equal(f.window.opacity, 0)
  f.window.showInactive()
  f.fade.enter()
  assert.equal(f.window.visible, true)
  f.advance(16)
  assert.ok(f.window.opacity > 0 && f.window.opacity < 1)
  f.advance(140)
  assert.equal(f.window.opacity, 1)
  assert.equal(f.frames.size, 0)
  assert.ok(f.values.every((value, i) => i === 0 || value >= f.values[i - 1]))
})

test('重复淡入从当前透明度接续，不叠加定时器', () => {
  const f = fixture()
  f.window.visible = false
  f.fade.prepareEnter(); f.window.showInactive(); f.fade.enter()
  f.advance(32)
  const intermediate = f.window.opacity
  assert.ok(intermediate > 0 && intermediate < 1)
  f.fade.enter()
  assert.equal(f.window.opacity, intermediate)
  assert.equal(f.frames.size, 1)
  f.fade.enter()
  assert.equal(f.frames.size, 1)
  f.advance(140)
  assert.equal(f.window.opacity, 1)
  assert.equal(f.window.visible, true)
  assert.equal(f.frames.size, 0)
})

test('新窗销毁立即清理淡入回调，不保留空窗口', () => {
  const f = fixture()
  f.window.visible = false
  f.fade.prepareEnter(); f.window.showInactive(); f.fade.enter()
  f.window.destroy()
  assert.doesNotThrow(() => f.advance(100))
  assert.equal(f.window.destroyed, true)
  assert.equal(f.frames.size, 0)
})

test('减少动画或 Linux 直接应用终态；动画中禁用也立即收尾', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform)
    if (platform === 'win32') f.disable()
    f.window.visible = false
    f.fade.prepareEnter(); f.window.showInactive(); f.fade.enter()
    assert.equal(f.window.opacity, 1)
    assert.equal(f.frames.size, 0)
  }
  const f = fixture()
  f.window.visible = false
  f.fade.prepareEnter(); f.window.showInactive(); f.fade.enter()
  f.disable()
  f.advance(16)
  assert.equal(f.window.opacity, 1)
  assert.equal(f.frames.size, 0)
})
