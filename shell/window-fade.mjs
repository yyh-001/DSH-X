/** 只负责原生窗口透明度；反向拖动接续当前帧，不能排队播放或延迟页面移交。 */
export class WindowFade {
  constructor(host, { enabled, platform = process.platform, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { host, enabled, platform, now, schedule, cancel })
    this.timer = null
    this.target = null
    host.window.once('closed', () => this.stop())
  }

  stop(opacity) {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    this.target = null
    this.host.fadeHold = false
    if (opacity !== undefined && !this.host.window.isDestroyed()) this.host.window.setOpacity(opacity)
  }

  prepareEnter() {
    // 菜单迁移会同步 attach + reveal，先设透明度，避免首帧全亮后再淡入。
    const window = this.host.window
    if (!window.isDestroyed() && !window.isVisible() && this.platform !== 'linux' && this.enabled()) window.setOpacity(0)
  }

  to(opacity, { show = false, hide = false, lift = false } = {}) {
    const host = this.host, window = host.window
    if (window.isDestroyed()) return
    if (this.timer !== null && this.target === opacity) return
    const reversing = this.timer !== null
    this.stop()
    const animate = this.platform !== 'linux' && this.enabled()
    if (show && !window.isVisible()) {
      if (animate) window.setOpacity(0)
      window.showInactive()
    } else if (animate && lift && !reversing && window.getOpacity() === 1) {
      // 原窗口仍在鼠标下，只轻微变淡后恢复，避免整扇已有页面闪灭。
      window.setOpacity(.86)
    }
    const from = window.getOpacity(), start = this.now(), duration = opacity === 0 ? 90 : 140
    this.target = opacity
    const finish = () => {
      this.timer = null
      this.target = null
      host.fadeHold = false
      if (window.isDestroyed()) return
      window.setOpacity(opacity)
      if (hide) window.hide()
      host.disposeEmpty?.()
    }
    if (!animate || from === opacity) { finish(); return }
    // 松手时页面已经移交，最多保留 90ms 的空外壳用于淡出，结束立即释放。
    host.fadeHold = opacity === 0
    const tick = () => {
      if (window.isDestroyed()) { this.stop(); return }
      const progress = Math.min(1, (this.now() - start) / duration)
      if (progress >= 1 || !this.enabled()) { finish(); return }
      window.setOpacity(from + (opacity - from) * (1 - (1 - progress) ** 3))
      this.timer = this.schedule(tick, 16)
    }
    this.timer = this.schedule(tick, 16)
  }
}
