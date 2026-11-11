import { nativeTheme } from 'electron'
import { dataUrl, resolveDark, stoppedPage, tabBaseColor } from './pages.mjs'
import { reorderBy, sameOrigin, isBootingUrl, followAction, surfaceInk } from './model.mjs'

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
/** 标签页标题的长度上限：标题来自远端页面，不能无限长地塞进菜单栏。 */
const PAGE_TITLE_MAX = 160

export class BrowserTabs {
  /**
   * @param {import('electron').BrowserWindow} window 主窗口；manager 就是它的 webContents
   * @param {object} hooks 外壳提供的行为：
   *   createView(id) → WebContentsView 的事件接线（标题、链接、导航、崩溃、快捷键）由外壳负责
   */
  constructor(window, hooks) {
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
    const dark = resolveDark(this.theme, nativeTheme.shouldUseDarkColors)
    if (dark === this.dark && !langChanged) return
    this.dark = dark
    this.paintBackgrounds()
    for (const tab of this.tabs) {
      if (tab.target.managed && !tab.loaded) this.load(tab, dataUrl(stoppedPage(this.lang, this.dark)))
    }
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
    return { x: 0, y: this.headerHeight, width, height: Math.max(0, height - this.headerHeight) }
  }

  layout() {
    const bounds = this.tabBounds()
    const geometry = JSON.stringify(bounds)
    if (geometry === this.geometry) return
    this.geometry = geometry
    for (const tab of [...this.tabs, ...this.retired]) tab.view.setBounds(bounds)
  }

  present(serial) {
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
    if (shown) tab?.view.webContents.focus()
    else this.manager.focus()
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

  open(target) {
    let tab = this.tabs.find((item) => item.target.id === target.id)
    if (!tab) {
      const view = this.hooks.createView(target.id)
      // 先上底色再装页面：present 不等页面画出第一帧，中间那段由视图自己兜住。
      view.setBackgroundColor(tabBaseColor(this.dark))
      view.setVisible(false)
      view.setBounds(this.tabBounds())
      this.window.contentView.addChildView(view)
      tab = { target, view, loaded: '', pageTitle: '', visible: false, surface: '', ink: '', booting: false }
      this.tabs.push(tab)
    }
    // 这个标签是来等启动的：进度页要一直留着，直到实例起来（见 follow）。
    tab.booting = isBootingUrl(target.url)
    if (tab.loaded !== target.url) {
      this.load(tab, target.url)
      tab.loaded = target.url
    }
    this.selected = target.id
    tab.target = target
    this.layout()
    this.render(false)
  }

  /** 导航失败（ERR_ABORTED 之类）由页面自己显示，这里只防未处理的 Promise。 */
  load(tab, url) {
    // 换了页面，之前采到的底色作废：等它显示出来再采一次。
    tab.surface = ''
    tab.view.webContents.loadURL(url).catch(() => {})
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
      case 'next': {
        const index = this.tabs.findIndex((tab) => tab.target.id === this.selected)
        this.selected = this.tabs[index + 1]?.target.id ?? ''
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
    if (this.selected === id) this.selected = this.tabs[Math.max(0, index - 1)]?.target.id ?? ''
  }

  destroy(tab) {
    this.window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }

  /** 跟上实例列表：重启换了端口 / token 就换地址，停了就换成本地提示页。 */
  follow(instances) {
    for (const tab of this.tabs) {
      if (!tab.target.managed) continue
      const next = instances.find((item) => item.id === tab.target.id)
      const action = followAction(tab, next, tab.view.webContents.getURL())
      if (action === 'leave') {
        if (next) tab.target = next
        continue
      }
      if (action === 'adopt') {
        // 进度页自己跳进去了：认下这个地址，不再 loadURL 一遍。
        tab.loaded = next.url
        tab.booting = false
        tab.target = next
        continue
      }
      const url = next && (next.status === 'running' || next.status === 'starting') ? next.url : ''
      if (tab.loaded !== url) {
        // 不在占用的旧端口上反复刷新，以免重启间隙误加载到另一个实例。
        this.load(tab, url || dataUrl(stoppedPage(this.lang, this.dark)))
        tab.loaded = url
        tab.pageTitle = ''
        tab.booting = false
      }
      if (next) tab.target = next
      else tab.target = { ...tab.target, status: 'stopped' }
    }
    this.render(false)
  }

  /**
   * 页面进程崩溃后重新装回这个标签：重新导航到带启动 token 的地址，而不是 reload。
   * token 在这个 dsh 进程的生命周期内一直有效，服务端会重发 cookie 并 303 到主页，
   * 和从管理页「打开」走的是同一条认证路径（原因见旧外壳 tabs.rs 的 recover：WKWebView 崩溃后
   * reload 不带 SameSite=Strict 的认证 cookie；Chromium 下这条路同样稳妥）。
   */
  recover(id) {
    const tab = this.tabs.find((item) => item.target.id === id)
    // 实例已停止时 loaded 为空，标签上那张停止提示页由下一次 follow 重画，这里不抢。
    if (!tab?.loaded) return
    this.load(tab, tab.loaded)
  }

  title(id, title) {
    const tab = this.tabs.find((item) => item.target.id === id)
    if (!tab) return
    tab.pageTitle = [...String(title)].filter((char) => char >= ' ' && char !== '\u007f').slice(0, PAGE_TITLE_MAX).join('')
    this.render(false)
  }

  /** 标签页里点出来的新窗口链接：同一个 dsh 就在本标签里开，其余交给外壳分派。 */
  link(id, url) {
    const tab = this.tabs.find((item) => item.target.id === id)
    if (!tab || !sameOrigin(url, tab.target.url)) return false
    this.load(tab, url)
    return true
  }

  render(force) {
    if (force || this.presentation === 0 || this.renderedSelection !== this.selected || this.retired.length) {
      this.presentation += 1
      this.renderedSelection = this.selected
    }
    const value = JSON.stringify({
      active: this.selected,
      lang: this.lang,
      theme: this.theme,
      presentation: this.presentation,
      request: this.selectionRequest,
      orderRequest: this.orderRequest,
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
