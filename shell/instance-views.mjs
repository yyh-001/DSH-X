// 实例页面由登记器持有；宿主只借用视图，迁移不能触发 WebContents 的销毁。
import { dataUrl, idlePage, stoppedPage, tabBaseColor } from './pages.mjs'
import { followAction, isBootingUrl, parseTabTarget, sameOrigin } from './model.mjs'

export function cleanTitle(value) {
  return [...String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')]
    .filter((char) => char >= ' ' && char !== '\u007f').slice(0, 160).join('').trim()
}

export function instanceWindowTitle(record, duplicates = false) {
  const target = record.target
  const identity = [target.profile, target.version].filter(Boolean).join(' · ')
  return [...new Set([cleanTitle(target.title), cleanTitle(identity),
    duplicates ? cleanTitle(target.homeName) : '', cleanTitle(record.pageTitle)])].filter(Boolean).join(' — ').slice(0, 240) + ' — DSH-X'
}

// 旧核心只给 URL；只能从可信等待页或当前实例列表认领，未知地址不获得实例操作能力。
export function legacyWindowTarget(url, managerUrl, instances) {
  const known = instances.find((target) => target.url && sameOrigin(target.url, url))
  if (known) return known
  const parsed = new URL(url)
  if (sameOrigin(url, managerUrl) && isBootingUrl(url)) {
    const home = parsed.searchParams.get('home') || ''
    const version = parsed.searchParams.get('version') || ''
    const profile = parsed.searchParams.get('profile') || ''
    if (home && profile && version) return {
      id: JSON.stringify([home, home.startsWith('wsl://') ? '' : version, profile]),
      home, version, profile, title: parsed.searchParams.get('name') || `${profile} · ${version}`,
      url, status: 'starting', managed: true,
    }
  }
  return { id: `unmanaged:${parsed.origin}`, title: 'DSH', url, status: 'running', managed: false }
}

export function launchForView(record, launches) {
  return launches.find((row) => {
    const targetId = row.target?.id || row.viewId
    if (targetId) return targetId === record.target.id
    return record.launch && row.id === record.launch.id && row.instanceId === record.launch.instanceId
  })
}

export class InstanceViews {
  constructor(hooks) {
    this.hooks = hooks
    this.views = new Map()
    this.targets = new Map()
    this.serial = 0
    this.lang = 'zh'
    this.dark = false
  }

  presentInstance(value, { presentation = 'internal', explicit = false } = {}) {
    const target = parseTabTarget(value)
    if (!target) throw new Error('无效的实例页面')
    // 旧核心没有标题元数据，但受管理页面的 id 已使用同一三元组；只解码，不另做路径规范化。
    if (target.managed && !target.home) {
      try {
        const parts = JSON.parse(target.id)
        if (Array.isArray(parts) && parts.length === 3 && parts.every((part) => typeof part === 'string')) {
          const [home, version, profile] = parts
          Object.assign(target, { home, profile, version: version || (home.startsWith('wsl://') ? 'auto' : ''), homeName: home })
        }
      } catch { /* 未知旧协议的 id 保持不透明，不猜实例 */ }
    }
    let record = this.targets.get(target.id)
    if (!record) {
      record = { viewId: `instance-view-${++this.serial}`, target, view: null, host: null,
        loaded: '', localUrl: '', pageTitle: '', visible: false, surface: '', ink: '', booting: false, epoch: 0 }
      this.views.set(record.viewId, record)
      this.targets.set(target.id, record)
      try {
        record.view = this.hooks.createView(record.viewId)
        record.view.setBackgroundColor(tabBaseColor(this.dark))
        this.transferView(record.viewId, this.hooks.createHost(presentation), { activate: false })
        this.update(record, target)
      } catch (error) {
        this.disposeView(record.viewId)
        throw error
      }
    } else {
      if (explicit && record.host.kind !== presentation) {
        this.transferView(record.viewId, this.hooks.createHost(presentation), { activate: false })
      }
      this.update(record, target)
    }
    this.focusInstance(target.id)
    return record
  }

  focusInstance(targetId) {
    const record = this.targets.get(targetId)
    if (!record || record.pendingClose) return false
    record.host.reveal(record)
    return true
  }

  // 整个移交同步完成，不在摘出与附加之间让出事件循环；失败原样回挂，绝不重建页面。
  transferView(viewId, destination, { index, activate = true, preservePage = false, focus = true } = {}) {
    const record = this.views.get(viewId)
    if (!record || record.pendingClose || record.moving) throw new Error('页面正在关闭或移动')
    if (record.host === destination) {
      if (activate && focus) destination.reveal(record)
      return record
    }
    const source = record.host
    const destinationSelection = destination.selected
    let position
    record.moving = true
    record.epoch++
    try {
      position = source?.detach(record)
      destination.attach(record, { index, activate })
      record.host = destination
      // 标题/聚焦失败也必须回挂；只有新宿主完成呈现后，才能释放旧的空窗口。
      destination.changed?.(record)
      if (activate && focus) destination.reveal(record)
      else if (activate) destination.present(destination.presentation)
    } catch (error) {
      destination.detach(record)
      if (destinationSelection !== undefined) {
        destination.selected = destinationSelection
        destination.render?.(true)
      }
      destination.disposeEmpty?.()
      if (source) {
        record.host = source
        source.attach(record, { ...position, rollback: true })
      }
      throw error
    } finally {
      record.moving = false
    }
    source?.disposeEmpty?.()
    // 显式拖出承诺保留整张页面，停止页也不例外；普通打开方式切换仍沿用本地页桥更新。
    if (record.localUrl && !preservePage) this.load(record, this.placeholder(record), true)
    return record
  }

  retire(record) {
    record.pendingClose = true
    record.epoch++
    if (this.targets.get(record.target.id) === record) this.targets.delete(record.target.id)
  }

  disposeView(viewId) {
    const record = this.views.get(viewId)
    if (!record) return
    this.retire(record)
    this.views.delete(viewId)
    record.host?.detach(record)
    record.host?.disposeEmpty?.()
    // Electron 退出时先发 destroyed，再清理宿主；此时视图的 webContents getter 可能已为空。
    const contents = record.view?.webContents
    if (contents && !contents.isDestroyed()) contents.close()
  }

  dispose() {
    for (const id of [...this.views.keys()]) this.disposeView(id)
  }

  load(record, url, local = false) {
    record.surface = ''
    record.localUrl = local ? url : ''
    record.view.webContents.loadURL(url).catch(() => {})
  }

  placeholder(record) {
    return dataUrl(record.host?.kind === 'window' && record.target.managed
      ? idlePage(this.lang) : stoppedPage(this.lang, this.dark))
  }

  update(record, target) {
    // 旧核心后续快照没有元数据，不能覆盖等待页认领的目录和 profile。
    target = { ...record.target, ...target }
    const action = followAction(record, target, record.view.webContents.getURL())
    record.target = target
    if (action === 'adopt') {
      record.loaded = target.url
      record.booting = false
      record.localUrl = ''
    } else if (action === 'load') {
      const url = ['running', 'starting'].includes(target.status) ? target.url : ''
      if (record.loaded !== url || !record.loaded && !record.localUrl) {
        record.loaded = url
        record.booting = isBootingUrl(url)
        record.pageTitle = ''
        this.load(record, url || this.placeholder(record), !url)
      }
    }
    record.host?.changed?.(record)
  }

  follow(instances, launches = []) {
    for (const record of this.targets.values()) {
      if (!record.target.managed) continue
      const next = instances.find((target) => target.id === record.target.id)
      const row = launchForView(record, launches)
      if (row) record.launch = { id: row.id, instanceId: row.instanceId }
      // 显式停止须撤掉等待页；启动失败没有 stopping，仍让等待页显示本次诊断。
      if (next?.status === 'stopping' || row?.status === 'stopping') record.booting = false
      // 起过一次的页面重启时回到自己的等待页；初次等待继续交给 /booting 诊断失败。
      const starting = next?.status === 'starting' || row?.status === 'starting'
      if (starting && !next?.url && !record.booting && this.hooks.bootUrl) {
        const url = this.hooks.bootUrl({ ...record.target, ...next })
        if (url) {
          record.loaded = url
          record.booting = true
          record.pageTitle = ''
          this.load(record, url)
        }
      }
      this.update(record, next || { ...record.target, url: '', status: row?.status || 'stopped' })
    }
  }

  preferences(lang, dark) {
    if (this.lang === lang && this.dark === dark) return
    this.lang = lang
    this.dark = dark
    for (const record of this.targets.values()) {
      record.view.setBackgroundColor(tabBaseColor(dark))
      if (record.localUrl) this.load(record, this.placeholder(record), true)
    }
  }

  title(viewId, title) {
    const record = this.views.get(viewId)
    if (!record || record.pendingClose) return
    record.pageTitle = cleanTitle(title)
    record.host?.changed?.(record)
  }

  link(viewId, url) {
    const record = this.views.get(viewId)
    if (!record || record.pendingClose || !sameOrigin(url, record.target.url)) return false
    this.load(record, url)
    return true
  }

  recover(viewId) {
    const record = this.views.get(viewId)
    if (record && !record.pendingClose) this.load(record, record.loaded || this.placeholder(record), !record.loaded)
  }

  localSender(event) {
    return [...this.targets.values()].find((record) => record.localUrl && record.target.managed
      && record.view.webContents === event.sender && event.senderFrame === event.sender.mainFrame
      && event.senderFrame.url === record.localUrl)
  }
}
