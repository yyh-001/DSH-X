/** 拖出只协调一次用户操作；页面、宿主与生命周期始终归 InstanceViews。 */
export function tabDragSupported(platform, ozonePlatform = '', env = {}) {
  if (platform !== 'linux') return true
  if (ozonePlatform === 'x11') return true
  // Wayland 不提供全局鼠标坐标；auto/未指定时宁可保留菜单入口，也不猜落点。
  return ozonePlatform !== 'wayland' && env.XDG_SESSION_TYPE !== 'wayland' && !env.WAYLAND_DISPLAY
}

export function detachedBounds(point, workArea, size) {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  return {
    x: Math.round(Math.max(workArea.x, Math.min(point.x - width / 2, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(point.y - 20, workArea.y + workArea.height - height))),
    width, height,
  }
}

/** 拖动是鼠标减去抓取偏移，不按菜单新开窗口的规则逐帧夹进工作区。 */
export function draggedBounds(point, size, offset) {
  return { x: Math.round(point.x - offset.x), y: Math.round(point.y - offset.y), width: size.width, height: size.height }
}

/** 标签压缩或页面缩放后，仍抓住同一相对位置；所有返回值为 Electron DIP。 */
export function tabGrabOffset(grab, tab, zoom, inset = { x: 0, y: 0 }) {
  return {
    x: inset.x + (tab.left + (tab.right - tab.left) * grab.x / grab.width) * zoom,
    y: inset.y + (tab.top + (tab.bottom - tab.top) * grab.y / grab.height) * zoom,
  }
}

export function managerTabSender(event, manager, managerUrl) {
  try {
    if (!manager || manager.isDestroyed?.() || event.sender !== manager || !event.senderFrame || event.senderFrame !== manager.mainFrame) return false
    const url = new URL(event.senderFrame.url)
    return url.origin === new URL(managerUrl).origin && url.pathname === '/'
  } catch { return false }
}

/** 从前到后的应用窗口中，只接受最上面一扇的标签区域；不穿透源窗口或遮挡窗口。 */
export function tabDropTarget(point, source, hosts, excludeId = '') {
  for (const host of [...hosts].sort((a, b) => (b.focusOrder || 0) - (a.focusOrder || 0))) {
    const win = host.window
    if (host.dragHidden || win.isDestroyed() || !win.isVisible() || win.isMinimized()) continue
    const bounds = win.getBounds()
    if (point.x < bounds.x || point.x >= bounds.x + bounds.width || point.y < bounds.y || point.y >= bounds.y + bounds.height) continue
    if (host === source || host.overlay || !host.stripLayout) return null
    const content = win.getContentBounds(), zoom = host.manager.getZoomFactor?.() || 1
    const x = (point.x - content.x) / zoom, y = (point.y - content.y) / zoom
    const { rect } = host.stripLayout
    const tabs = host.stripLayout.tabs.filter((tab) => tab.id !== excludeId)
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
    const index = tabs.filter((tab) => x > (tab.left + tab.right) / 2).length
    const marker = index < tabs.length ? tabs[index].left : tabs.at(-1)?.right ?? rect.left
    return { host, index, marker: Math.max(rect.left, Math.min(rect.right, marker)) }
  }
  return null
}

/** 只给提示实际变化的窗口发消息；拖动结束后清空，不持有常驻窗口注册表。 */
export class TabDragFeedback {
  constructor(send) {
    this.send = send
    this.values = new Map()
  }

  update(source, drop) {
    const next = new Map()
    if (drop) {
      next.set(source, { merging: true })
      next.set(drop.host, { marker: drop.marker })
    }
    for (const host of this.values.keys()) if (!next.has(host)) this.send(host, null)
    for (const [host, value] of next) {
      const previous = this.values.get(host)
      if (!previous || previous.marker !== value.marker || previous.merging !== value.merging) this.send(host, value)
    }
    this.values = next
  }

  clear() { this.update(null, null) }
}

export class TabDetacher {
  constructor(registry, tabs, hooks) {
    this.registry = registry
    this.tabs = tabs
    this.hooks = hooks
    this.lastRequest = -1
  }

  available(id) {
    const record = this.registry.targets.get(id)
    return !!record && record.host === this.tabs && this.tabs.tabs.includes(record)
      && !record.pendingClose && !record.moving && !this.tabs.overlay && !this.hooks.quitting()
      && !this.tabs.window.isDestroyed()
  }

  canCreateWindow(id) {
    return this.available(id) && (this.tabs.kind !== 'window' || this.tabs.tabs.length > 1)
  }

  detach({ id, source = 'menu', request = null, destination: chosenHost, index }) {
    // 原生菜单不借用页面的编号；同一页重放请求不能把后来重新打开的标签再次搬走。
    if (request !== null) {
      if (request <= this.lastRequest) return
      this.lastRequest = request
    }
    let destination
    let result
    try {
      if (!this.available(id)) throw new Error('该标签现在无法移到新窗口')
      // 唯一标签已经在独立窗口；仅禁止重复开窗，仍允许它合并到指定宿主。
      if (source === 'menu' && !chosenHost && !this.canCreateWindow(id)) throw new Error('该标签已在独立窗口')
      if (source === 'drag' && !this.hooks.dragSupported()) throw new Error('当前桌面请使用标签菜单移到新窗口')
      const record = this.registry.targets.get(id)
      // 宿主构造同步可用，不加载第二张页面，也不等待永远不会发生的 ready-to-show。
      const drop = source === 'drag' ? this.hooks.dropTarget?.() : null
      destination = chosenHost || drop?.host || this.hooks.createHost(source)
      if (destination.window.isDestroyed() || destination.overlay) throw new Error('目标窗口不可用')
      const entering = !destination.window.isVisible() && !destination.tabs.length
      if (entering) destination.fade?.prepareEnter()
      this.registry.transferView(record.viewId, destination, { index: index ?? drop?.index, preservePage: true })
      if (entering) destination.fade?.to(1)
      result = { id, request, status: 'success' }
    } catch (error) {
      destination?.disposeEmpty?.()
      result = { id, request, status: 'error' }
      this.hooks.failed?.(error, request)
    }
    this.tabs.detachResult = result
    // 源窗口马上补上相邻页面；窗口已失焦时，present 不得从新窗口抢焦点。
    this.tabs.present(this.tabs.presentation)
    this.tabs.render(false)
    return result
  }
}
