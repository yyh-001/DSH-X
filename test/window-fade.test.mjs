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
  const host = { window, empty: false, dragHold: true, disposeEmpty() {
    if (this.empty && !this.dragHold && !this.fadeHold) window.destroy()
  } }
  const fade = new WindowFade(host, { platform, enabled: () => enabled, now: () => time,
    schedule(fn) { frames.set(++serial, fn); return serial }, cancel(id) { frames.delete(id) } })
  return { host, window, fade, frames, values, disable() { enabled = false },
    advance(ms) { time += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn() } }
}

test('新窗口先透明后显示，140ms 内单调淡入且完成后没有空转帧', () => {
  const f = fixture()
  f.window.visible = false
  f.fade.to(1, { show: true })
  assert.equal(f.window.opacity, 0)
  assert.equal(f.window.visible, true)
  f.advance(16)
  assert.ok(f.window.opacity > 0 && f.window.opacity < 1)
  f.advance(140)
  assert.equal(f.window.opacity, 1)
  assert.equal(f.frames.size, 0)
  assert.equal(f.fade.target, null)
  assert.ok(f.values.every((value, i) => i === 0 || value >= f.values[i - 1]))
})

test('快速拆合从当前透明度反向，不叠加定时器或执行过期隐藏', () => {
  const f = fixture()
  f.fade.to(0, { hide: true })
  f.advance(32)
  const intermediate = f.window.opacity
  assert.ok(intermediate > 0 && intermediate < 1)
  f.fade.to(1, { show: true, lift: true })
  assert.equal(f.window.opacity, intermediate)
  assert.equal(f.frames.size, 1)
  f.fade.to(1, { show: true })
  assert.equal(f.frames.size, 1)
  f.advance(140)
  assert.equal(f.window.opacity, 1)
  assert.equal(f.window.visible, true)
  assert.equal(f.frames.size, 0)
})

test('松手后只延迟释放淡出空壳，销毁及取消清理所有回调', () => {
  const f = fixture()
  f.host.empty = true
  f.fade.to(0)
  f.host.dragHold = false
  f.host.disposeEmpty()
  assert.equal(f.window.destroyed, false)
  f.advance(90)
  assert.equal(f.window.destroyed, true)
  assert.equal(f.frames.size, 0)
  const other = fixture()
  other.fade.to(0)
  other.fade.stop(1)
  other.advance(100)
  assert.equal(other.window.opacity, 1)
  assert.equal(other.frames.size, 0)
  other.fade.to(0)
  other.window.destroy()
  assert.doesNotThrow(() => other.advance(100))
  assert.equal(other.frames.size, 0)
})

test('减少动画或 Linux 直接应用终态；动画中禁用也立即收尾', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform)
    if (platform === 'win32') f.disable()
    f.fade.to(0, { hide: true })
    assert.equal(f.window.visible, false)
    assert.equal(f.frames.size, 0)
  }
  const f = fixture()
  f.fade.to(0)
  f.disable()
  f.advance(16)
  assert.equal(f.window.opacity, 0)
  assert.equal(f.frames.size, 0)
})
