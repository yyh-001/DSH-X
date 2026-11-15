/** 菜单新窗口的短淡入；不再为实时拖动保留透明捕获空壳。 */
export class WindowFade {
  constructor(host, { enabled, platform = process.platform, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { host, enabled, platform, now, schedule, cancel })
    this.timer = null
    host.window.once('closed', () => this.stop())
  }

  stop() {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
  }

  prepareEnter() {
    // 菜单迁移会同步 attach + reveal，先设透明度，避免首帧全亮后再淡入。
    const window = this.host.window
    if (!window.isDestroyed() && !window.isVisible() && this.platform !== 'linux' && this.enabled()) window.setOpacity(0)
  }

  enter() {
    const window = this.host.window
    if (window.isDestroyed()) return
    this.stop()
    const animate = this.platform !== 'linux' && this.enabled()
    if (this.platform === 'linux') return
    const from = window.getOpacity(), start = this.now(), duration = 140
    const finish = () => {
      this.timer = null
      if (window.isDestroyed()) return
      window.setOpacity(1)
    }
    if (!animate || from === 1) { finish(); return }
    const tick = () => {
      if (window.isDestroyed()) { this.stop(); return }
      const progress = Math.min(1, (this.now() - start) / duration)
      if (progress >= 1 || !this.enabled()) { finish(); return }
      window.setOpacity(from + (1 - from) * (1 - (1 - progress) ** 3))
      this.timer = this.schedule(tick, 16)
    }
    this.timer = this.schedule(tick, 16)
  }
}
