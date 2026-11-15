import { BrowserTabs } from './tabs.mjs'

/** 每个窗口复用同一套标签容器；关闭窗口仍隐藏整组，移空才释放空外壳。 */
export class InstanceWindow extends BrowserTabs {
  constructor(window, hooks) {
    super(window, { ...hooks, changed: () => { hooks.titles(); hooks.changed?.() }, reveal: (options) => hooks.reveal(window, options) })
    this.kind = 'window'
    this.enabled = true
    this.headerHeight = 44
    window.on('resize', () => this.layout())
    window.on('close', (event) => {
      if (hooks.quitting() || !this.tabs.length) return
      event.preventDefault()
      window.hide()
      hooks.hidden()
    })
    window.on('closed', () => {
      for (const record of [...this.tabs, ...this.retired]) {
        if (record.host === this) hooks.dispose(record.viewId)
      }
    })
  }

  action(request) {
    // 独立窗口没有空白的管理首页，首页按钮只负责唤起启动器。
    if (request.action === 'select' && !request.id) return
    super.action(request)
  }

  reveal(record, options) {
    super.reveal(record, options)
    // 宿主的顶栏可能尚未加载；内容视图无需等顶栏导航，原页面可立即继续显示。
    this.present(this.presentation)
  }

  disposeEmpty() {
    if (!this.dragHold && !this.tabs.length && !this.retired.length && !this.window.isDestroyed()) this.window.destroy()
  }
}
