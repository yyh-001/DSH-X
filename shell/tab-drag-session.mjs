import { randomUUID } from 'node:crypto'

/** 指针/原生投放共用一次提交；预览不拥有页面，也不改变宿主。 */
export class TabDragSession {
  constructor(registry, { quitting = () => false } = {}) {
    this.registry = registry
    this.quitting = quitting
    this.session = null
  }

  available(host) {
    return host && !this.quitting() && !host.overlay && !host.window.isDestroyed()
      && host.window.isVisible() && !host.window.isMinimized()
  }

  begin(source, id) {
    const record = this.registry.targets.get(id)
    if (!this.available(source) || !record || record.host !== source || !source.tabs.includes(record)
      || record.pendingClose || record.moving) return null
    this.clear()
    const token = randomUUID()
    // 最后一张标签的源窗口必须等输入适配完成收尾才释放。
    source.dragHold = true
    this.session = { token, source, record, epoch: record.epoch, dropped: false }
    return token
  }

  cancel(source, token) {
    if (!this.session || this.session.source !== source || this.session.token !== token) return false
    this.clear()
    return true
  }

  forget(host) {
    if (this.session?.source === host) this.clear()
  }

  clear() {
    const source = this.session?.source
    this.session = null
    if (source) {
      source.dragHold = false
      source.disposeEmpty?.()
    }
  }

  valid() {
    const session = this.session
    if (!session || session.dropped) return false
    const { source, record, epoch } = session
    return this.available(source) && this.registry.views.get(record.viewId) === record && record.epoch === epoch
      && record.host === source && source.tabs.includes(record) && !record.pendingClose && !record.moving
  }

  drop(destination, token, index, { newWindow = false } = {}) {
    const session = this.session
    if (!session || session.dropped || session.token !== token || !Number.isSafeInteger(index) || index < 0
      || !destination || this.quitting() || destination.overlay || destination.window.isDestroyed()
      || !newWindow && !this.available(destination)) return false
    const { source, record } = session
    // 绑定记录本身，不能让拖动途中关闭后重开的同名标签继承旧会话。
    const valid = this.valid()
    session.dropped = true
    if (!valid) return false
    if (source === destination) {
      const order = source.tabs.filter(tab => tab !== record)
      order.splice(Math.min(index, order.length), 0, record)
      source.tabs = order
      source.render(false)
    } else {
      // InstanceViews 负责附加失败回挂、空宿主释放与 guest 所有权；这里不复制生命周期。
      this.registry.transferView(record.viewId, destination, { index, preservePage: true })
      if (!source.window.isDestroyed()) {
        source.present(source.presentation)
        source.render(false)
      }
    }
    return true
  }
}
