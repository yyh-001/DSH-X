/** 独立窗口只承载页面，隐藏不释放；空窗口销毁时也不能带走已迁出的视图。 */
export class InstanceWindow {
  constructor(window, hooks) {
    this.kind = 'window'
    this.window = window
    this.hooks = hooks
    this.record = null
    window.on('resize', () => this.layout())
    window.on('close', (event) => {
      if (hooks.quitting() || !this.record) return
      event.preventDefault()
      window.hide()
      hooks.hidden()
    })
    window.on('closed', () => {
      const record = this.record
      this.record = null
      if (record?.host === this) hooks.dispose(record.viewId)
    })
  }

  attach(record) {
    if (this.record && this.record !== record) throw new Error('窗口已经承载其他实例')
    this.window.contentView.addChildView(record.view)
    this.record = record
    this.layout()
    record.view.setVisible(true)
    record.visible = true
  }

  detach(record) {
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(record.view)
    if (this.record === record) this.record = null
    record.view.setVisible(false)
    record.visible = false
  }

  layout() {
    if (!this.record) return
    const { width, height } = this.window.getContentBounds()
    this.record.view.setBounds({ x: 0, y: 0, width, height })
  }

  reveal(record) {
    this.hooks.reveal(this.window)
    record.view.webContents.focus()
  }

  changed() {
    this.hooks.titles()
  }

  disposeEmpty() {
    if (!this.record && !this.window.isDestroyed()) this.window.destroy()
  }
}
