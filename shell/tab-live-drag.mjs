/** 一次按住鼠标的迁移事务；窗口/页面身份仍只来自 InstanceViews。 */
export class LiveTabDrag {
  constructor(registry, source, id, hooks) {
    this.registry = registry
    this.source = source
    this.record = registry.targets.get(id)
    this.hooks = hooks
    this.saved = new Map()
    this.moved = false
    this.finished = false
    this.floating = null
    this.sourceBounds = source.window.getBounds?.()
    this.sourceOpacity = source.fade ? 1 : source.window.getOpacity?.() ?? 1
    this.sourceMoved = false
    this.hold(source)
    source.dragSource = id
    source.render(false)
  }

  hold(host) {
    if (!this.saved.has(host)) this.saved.set(host, { order: [...host.tabs], selected: host.selected })
    host.dragHold = true
  }

  valid() {
    return !this.finished && this.registry.views.get(this.record.viewId) === this.record
      && !this.record.pendingClose && !this.record.host.window.isDestroyed()
  }

  transfer(host, index) {
    this.hold(host)
    const previous = this.record.host
    if (previous !== host) {
      // 切换原生键盘焦点会使源顶栏丢失 pointer capture；松手前只展示，不激活窗口。
      this.registry.transferView(this.record.viewId, host, { index, preservePage: true, focus: false })
      previous.present(previous.presentation)
      this.moved = true
    } else {
      const order = host.tabs.filter((tab) => tab !== this.record)
      order.splice(Math.max(0, Math.min(index ?? order.length, order.length)), 0, this.record)
      if (order.some((tab, i) => tab !== host.tabs[i])) {
        host.tabs = order
        host.render(false)
      }
    }
    if (host !== this.floating) this.shownFloating = null
    if (previous !== host && this.floating && this.floating !== this.source && host !== this.floating && !this.floating.window.isDestroyed()) {
      this.floating.dragHidden = true
      if (this.floating.fade) this.floating.fade.to(0, { hide: true })
      else this.floating.window.hide()
    }
    this.updateCaptureWindow()
    this.source.render(false)
  }

  updateCaptureWindow() {
    const source = this.source
    if (source.kind !== 'window' || source.window.isDestroyed()) return
    const empty = !source.tabs.length && !source.retired.length
    if (empty === !!this.captureEmpty) return
    // hide 会让源顶栏失去捕获；透明空壳继续接收松手/Escape，但不再遮住目标或留在任务栏。
    this.captureEmpty = empty
    if (source.fade) source.fade.to(empty ? 0 : this.sourceOpacity)
    else source.window.setOpacity(empty ? 0 : this.sourceOpacity)
    source.window.setSkipTaskbar(empty)
    // Linux 不支持窗口透明度，不把仍可见的源窗口当成可穿透的目标区域。
    source.dragHidden = empty && (source.window.getOpacity() === 0 || source.fade?.target === 0)
  }

  update(point, drop, outside) {
    if (!this.valid()) return false
    if (drop && (drop.host !== this.source || this.moved)) {
      this.transfer(drop.host, drop.index)
    } else if (!drop && outside) {
      if (!this.floating || this.floating.window.isDestroyed()) {
        // 最后一张标签就是整扇独立窗口；复用它，避免出现一扇页面窗口和一扇捕获空壳。
        const source = this.source
        const reusable = source.kind === 'window' && !source.window.isDestroyed() && !source.retired.length
          && !source.window.isMaximized?.() && !source.window.isFullScreen?.()
          && source.tabs.every((tab) => tab === this.record)
        this.floating = reusable ? source : this.hooks.createHost(point)
      }
      if (this.record.host !== this.floating) this.transfer(this.floating, 0)
      if (this.floating === this.source && !this.sourceMoved) {
        this.sourceMoved = true
        this.source.dragFloating = this.record.target.id
        this.source.render(false)
      }
      const positioned = this.hooks.position(this.floating, point)
      if (positioned !== false && this.shownFloating !== this.floating) {
        this.shownFloating = this.floating
        this.floating.dragHidden = false
        if (this.floating.fade) this.floating.fade.to(1, { show: true, lift: this.floating === this.source })
        else if (!this.floating.window.isVisible()) this.floating.window.showInactive()
      }
    }
    return true
  }

  finish(cancel = false) {
    if (this.finished) return
    // 松手会停止定位轮询。新顶栏尚未就绪时立即撤销，不能提交一扇未定位的窗口。
    // 按住期间仍由 position 的五秒上限负责失败回挂；不留下脱离手势的等待任务。
    if (this.record.host === this.floating && this.shownFloating !== this.floating) cancel = true
    this.finished = true
    const record = this.record, source = this.source
    try {
      if (cancel && this.moved && this.registry.views.get(record.viewId) === record && !record.pendingClose
        && !source.window.isDestroyed()) {
        const original = this.saved.get(source)
        this.registry.transferView(record.viewId, source, {
          index: original.order.indexOf(record), preservePage: true, focus: false,
        })
        // 撤销只恢复仍存在的标签；拖动期间新增/关闭的页面不能被撤销操作抹掉或复活。
        for (const [host, saved] of this.saved) {
          if (host.window.isDestroyed()) continue
          const existing = new Set(host.tabs)
          host.tabs = [...saved.order.filter((tab) => existing.has(tab)), ...host.tabs.filter((tab) => !saved.order.includes(tab))]
          if (!saved.selected || host.tabs.some((tab) => tab.target.id === saved.selected)) host.selected = saved.selected
          host.render(true)
          host.present(host.presentation)
        }
      }
    } finally {
      source.dragSource = null
      source.dragFloating = null
      if (!source.window.isDestroyed()) {
        if (cancel && this.sourceMoved && this.sourceBounds) source.window.setBounds(this.sourceBounds)
        if (this.sourceMoved) delete source.dragBounds
        if (this.captureEmpty && source.tabs.length) {
          source.fade?.stop(this.sourceOpacity)
          source.window.setOpacity(this.sourceOpacity)
          source.window.setSkipTaskbar(false)
        }
        source.dragHidden = !source.tabs.length && source.fade?.target === 0
      }
      for (const host of this.saved.keys()) {
        if (cancel) host.fade?.stop(host === source ? this.sourceOpacity : 1)
        host.dragHold = false
        if (!host.window.isDestroyed()) { host.render(false); host.disposeEmpty?.() }
      }
      this.saved.clear()
    }
    if (!cancel && (this.moved || this.sourceMoved) && this.registry.views.get(record.viewId) === record && !record.host.window.isDestroyed()) {
      record.host.reveal(record, { preserveBounds: record.host === this.floating })
    }
  }
}

/** 使用当前宿主内容区的 CSS 坐标；24px 迟滞避免刚合并后边缘抖动立即再拆。 */
export function outsideTabStrip(point, host) {
  if (!host.stripLayout || host.window.isDestroyed()) return false
  const bounds = host.window.getContentBounds(), zoom = host.manager.getZoomFactor?.() || 1
  const x = (point.x - bounds.x) / zoom, y = (point.y - bounds.y) / zoom
  const rect = host.stripLayout.rect
  return y < rect.top - 24 || y > rect.bottom + 24 || x < -24 || x > bounds.width / zoom + 24
}
