import { resolveDark, tabBaseColor } from './pages.mjs'
import { reorderBy, surfaceInk } from './model.mjs'

/**
 * 「DSH-X 内部标签页」：每个 dsh 实例一块独立的 WebContentsView，叠在管理页（窗口自己的 webContents）
 * 之上、菜单栏之下。不用 iframe：避免跨源嵌入限制，切换也不会重载会话、不丢草稿。
 *
 * 状态机逐条照搬已删的 Rust 外壳 launcher/tabs.rs（BrowserTabs，git 历史可查），管理页那一侧（public/internal-tabs.js）
 * 不用改：选中、排序都带请求编号，只有管理页画完、回执 present(serial) 之后才切换原生视图的可见性，
 * 中间始终有完整内容，不露出底层。
 */

/** 管理页还没报告菜单栏高度之前用的默认值（逻辑像素），和旧外壳 tabs.rs 的 HEADER_HEIGHT 一致。 */
const DEFAULT_HEADER_HEIGHT = 72
export class BrowserTabs {
  /**
   * @param {import('electron').BrowserWindow} window 主窗口；manager 就是它的 webContents
   * @param {object} hooks 外壳提供的行为：
   *   retire / dispose → 视图生命周期交给登记器，容器只管布局与呈现
   */
  constructor(window, hooks) {
    this.kind = 'internal'
    this.window = window
    this.manager = window.webContents
    this.hooks = hooks
    this.tabs = []
    this.selected = ''
    this.enabled = false
    this.lang = 'zh'
    this.theme = 'system'
    // 设置里的主题换算出来的实际深浅色：停止页是外壳自己画的，跟不上管理页的 CSS 变量（#58）
    this.dark = false
    this.rendered = ''
    this.headerHeight = DEFAULT_HEADER_HEIGHT
    this.geometry = ''
    this.presentation = 0
    this.renderedSelection = ''
    this.selectionRequest = null
    this.orderRequest = null
    this.detachResult = null
    this.stripLayout = null
    // 关闭当前标签时先保留旧画面，替代页面显示后再释放原生视图。
    this.retired = []
    // 管理页有弹窗开着：原生标签页总叠在管理页之上，弹窗画不过它，只能先把标签页收起来。
    this.overlay = false
  }

  /** 菜单栏里是不是正显示着标签条（管理页的快捷键只在这时接管 ⌘W / ⌃Tab）。 */
  get active() {
    return this.enabled || this.tabs.length > 0
  }

  preferences(enabled, lang, theme) {
    const langChanged = this.lang !== lang
    const themeChanged = this.theme !== theme
    this.enabled = enabled
    this.lang = lang
    this.theme = theme
    // 状态轮询每次都会走到这里；只有配色或语言真的变了才重画停止页，免得反复重载
    this.syncPlaceholder(langChanged)
    this.layout()
    // 标签底色是下面那块页面的颜色：启动器换主题时重采一次（页面自己换配色只能等下次选中，
    // 不做定时轮询 —— 每几秒叫醒一次渲染进程，页面就没法进深度节流了）。
    if (themeChanged) this.resampleSelected()
    this.render(false)
  }

  /** 系统深浅色在运行中变了：由外壳的 nativeTheme 'updated' 事件调用。 */
  systemThemeChanged() {
    this.syncPlaceholder(false)
  }

  /** 只动正显示停止页的标签（loaded 为空）：运行中的实例页面有自己的配色，重载会丢掉内容。 */
  syncPlaceholder(langChanged) {
    const dark = resolveDark(this.theme, this.hooks.systemDark?.() || false)
    if (dark === this.dark && !langChanged) return
    this.dark = dark
    this.paintBackgrounds()
  }

  /**
   * 刷一遍原生视图的底色。WebContentsView 不设底色就是白的：页面画出第一帧之前，
   * 露出来的是这块白（深色模式下就是打开标签页那一下白屏）。换主题时也要跟着换。
   */
  paintBackgrounds() {
    const color = tabBaseColor(this.dark)
    for (const tab of [...this.tabs, ...this.retired]) tab.view.setBackgroundColor(color)
  }

  tabBounds() {
    const { width, height } = this.window.getContentBounds()
    // 管理页报告 CSS 像素，原生视图使用 DIP；页面缩放不能让内容层盖住标签栏。
    const top = Math.round(this.headerHeight * (this.manager.getZoomFactor?.() || 1))
    return { x: 0, y: top, width, height: Math.max(0, height - top) }
  }

  layout() {
    const bounds = this.tabBounds()
    const geometry = JSON.stringify(bounds)
    if (geometry === this.geometry) return
    this.geometry = geometry
    for (const tab of [...this.tabs, ...this.retired]) tab.view.setBounds(bounds)
  }

  present(serial) {
    if (this.window.isDestroyed()) return
    // 快速连点产生的旧绘制回执不能把页面切回去。只响应最新一次选择。
    if (serial !== this.presentation) return
    // 弹窗开着时按「选中管理页」呈现：露出完整弹窗，在任何标签下都能直接关掉；弹窗关了原样放回。
    const shown = this.overlay ? '' : this.selected
    const tab = this.tabs.find((item) => item.target.id === shown)
    // 先显示新页面，后隐藏旧页面；两者之间始终有完整内容，不露出管理页底层。
    if (tab && !tab.visible) {
      tab.view.setVisible(true)
      tab.visible = true
    }
    for (const item of [...this.tabs, ...this.retired]) {
      if (item.visible && item.target.id !== shown) {
        item.view.setVisible(false)
        item.visible = false
      }
    }
    for (const item of this.retired) this.destroy(item)
    this.retired = []
    if (this.window.isDestroyed()) return
    // 拖出后管理页还会回传 present；后台窗口的绘制回执只能更新画面，不能抢回焦点。
    if (!this.dragHold && this.window.isFocused?.() !== false) {
      if (shown) tab?.view.webContents.focus()
      else this.manager.focus()
    }
    // 页面刚显示出来才画得准：采一次它的底色，给选中的标签用（标签要和下面那块页面同色才连得起来）。
    if (tab) this.sampleSurface(tab)
  }

  /**
   * 采一次页面顶部的底色，交给管理页画选中的标签。
   * 取的是**这张标签正下方**那一点（不是页面左上角）：两栏布局的页面（左导航 + 右内容）
   * 左上角是导航，标签压在内容上，取左上角会差出几个色阶、接缝看得出来。
   * 页面能画的层不一定是 body，所以从那个点沿父链找第一个不透明的背景色；
   * 拿不到（页面没就绪、纯透明、被关掉）就留空串，管理页那边退回自己的主题色。
   */
  async sampleSurface(tab) {
    const epoch = tab.epoch
    const contents = tab.view.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      // 标签的中心 x 在管理页的 DOM 里：视图和管理页同宽同原点，这个 x 直接就是页面里的 x。
      const centerX = await this.manager
        .executeJavaScript(`window.launcherTabCenterX?.(${JSON.stringify(tab.target.id)}) ?? 0`, true)
        .catch(() => 0)
      const x = Math.max(4, Math.round(Number(centerX) || 8))
      const color = await contents.executeJavaScript(
        `(() => {
          const opaque = (value) => !!value && value !== 'transparent' && !/rgba\\([^)]*,\\s*0(\\.0+)?\\s*\\)$/.test(value)
          for (let el = document.elementFromPoint(${x}, 8); el; el = el.parentElement) {
            const value = getComputedStyle(el).backgroundColor
            if (opaque(value)) return value
          }
          const body = getComputedStyle(document.body).backgroundColor
          return opaque(body) ? body : ''
        })()`,
        true,
      )
      const surface = typeof color === 'string' ? color.trim().slice(0, 40) : ''
      // 异步采色返回时视图可能已经迁到另一窗口，旧容器不能再改它的呈现状态。
      if (!this.tabs.includes(tab) || tab.epoch !== epoch) return
      // 标签上的字也跟着底色走：底色亮用深字、暗用浅字（按亮度取，不看主题 —— 底色是下面那块页面给的）。
      const ink = surfaceInk(surface)
      if (surface === tab.surface && ink === tab.ink) return
      tab.ink = ink
      tab.surface = surface
      // 只有选中的那个标签要这个颜色；不是当前标签就等它被选中时再重画。
      if (tab.target.id === this.selected) this.render(false)
    } catch { /* 页面还没准备好：下次 present 再采 */ }
  }

  /** 重采当前选中标签的底色（页面配色变了、或者主题切了）。 */
  resampleSelected() {
    const tab = this.tabs.find((item) => item.target.id === this.selected)
    if (tab) void this.sampleSurface(tab)
  }

  /** 页面加载完再采一次（present 那次可能采到加载屏的颜色）；只关心正选中的那张。 */
  resample(id) {
    const tab = this.tabs.find((item) => item.target.id === id)
    if (!tab || tab.target.id !== this.selected) return
    // 首屏画出来再采：did-stop-loading 之后应用还会补一帧布局/主题。
    setTimeout(() => { if (this.tabs.includes(tab) && tab.target.id === this.selected) void this.sampleSurface(tab) }, 300)
  }

  attach(tab, { index = this.tabs.length, activate = true, selected, rollback = false } = {}) {
    tab.view.setVisible(false)
    tab.visible = false
    tab.view.setBounds(this.tabBounds())
    this.window.contentView.addChildView(tab.view)
    this.tabs.splice(index, 0, tab)
    if (rollback) this.selected = selected
    else if (activate) this.selected = tab.target.id
    this.render(true)
  }

  detach(tab) {
    const index = this.tabs.indexOf(tab)
    const selected = this.selected
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    tab.view.setVisible(false)
    tab.visible = false
    if (index >= 0) this.tabs.splice(index, 1)
    this.retired = this.retired.filter((item) => item !== tab)
    if (index >= 0 && this.selected === tab.target.id) this.selected = this.tabs[Math.max(0, index - 1)]?.target.id ?? ''
    this.render(true)
    return { index, selected }
  }

  reveal(tab, options) {
    this.selected = tab.target.id
    this.render(true)
    this.hooks.reveal(options)
  }

  changed() {
    this.render(false)
  }

  action(request) {
    switch (request.action) {
      case 'select':
        if ('request' in request) this.selectionRequest = request.request
        if (!request.id || this.tabs.some((tab) => tab.target.id === request.id)) this.selected = request.id
        break
      case 'reorder':
        if (this.orderRequest !== null && request.request <= this.orderRequest) return
        this.tabs = reorderBy(this.tabs, request.ids, (tab) => tab.target.id)
        this.orderRequest = request.request
        break
      case 'close-tab':
        this.close(request.id)
        break
      case 'close-active':
        this.close(this.selected)
        break
      case 'next':
      case 'previous': {
        // 管理首页只属于启动器窗口；独立窗口正反循环都只在自己的标签之间切换。
        const ids = this.tabs.map((tab) => tab.target.id)
        if (this.kind === 'internal') ids.unshift('')
        const index = ids.indexOf(this.selected)
        this.selected = ids[(index + (request.action === 'previous' ? -1 : 1) + ids.length) % ids.length] ?? ''
        break
      }
      case 'reload': {
        const tab = this.tabs.find((item) => item.target.id === this.selected)
        if (tab) tab.view.webContents.reload()
        else this.manager.reload()
        break
      }
      case 'layout':
        this.headerHeight = request.height
        this.layout()
        return
      case 'tab-strip':
        this.stripLayout = request
        return
      case 'present':
        this.present(request.serial)
        return
      case 'overlay':
        if (this.overlay === request.open) return
        this.overlay = request.open
        // 换一个呈现序号，走同一条「管理页画完再回执」的路径切换可见性，不另开一套显示逻辑。
        this.render(true)
        return
      default:
        return
    }
    this.layout()
    this.render(false)
  }

  close(id) {
    const index = this.tabs.findIndex((tab) => tab.target.id === id)
    if (index < 0) return
    // 只释放页面，不向服务端发 stop；关闭标签不等于关闭正在运行的 DSH 实例。
    this.retired.push(...this.tabs.splice(index, 1))
    this.hooks.retire(this.retired.at(-1))
    if (this.selected === id) this.selected = this.tabs[Math.max(0, index - 1)]?.target.id ?? ''
  }

  destroy(tab) {
    this.hooks.dispose(tab.viewId)
  }

  render(force) {
    if (this.window.isDestroyed()) return
    this.hooks.changed?.()
    if (force || this.presentation === 0 || this.renderedSelection !== this.selected || this.retired.length) {
      this.presentation += 1
      this.renderedSelection = this.selected
    }
    const value = JSON.stringify({
      active: this.selected,
      lang: this.lang,
      theme: this.theme,
      standalone: this.kind === 'window',
      reduceMotion: this.hooks.reducedMotion?.() === true,
      presentation: this.presentation,
      request: this.selectionRequest,
      orderRequest: this.orderRequest,
      detach: this.hooks.detach?.() || { supported: false, drag: false },
      detachResult: this.detachResult,
      enabled: this.active,
      // 选中那块页面顶部的底色：管理页拿它画选中的标签，标签才和下面的页面连成一片。
      surface: this.tabs.find((tab) => tab.target.id === this.selected)?.surface || '',
      // ink 是配套的标签字色（底色亮就给深字）
      ink: this.tabs.find((tab) => tab.target.id === this.selected)?.ink || '',
      tabs: this.tabs.map((tab) => ({ id: tab.target.id, title: tab.target.title, pageTitle: tab.pageTitle, stopped: !tab.loaded })),
    })
    if (!force && value === this.rendered) return
    this.rendered = value
    this.manager.executeJavaScript(`window.updateInternalTabs?.(${value})`).catch(() => {})
  }
}
