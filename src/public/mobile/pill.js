// DSH-X 远程网关悬浮返回胶囊（注入到反代后的 DSH 原版页面）
// 设计原则：
// 1. 自包含 IIFE + closed Shadow DOM，与上游 DSH 页面的 CSS / DOM / 全局变量彻底隔离；
// 2. 容器默认 pointer-events: none，未展开时不监听任何全局键盘事件，绝不干扰 DSH 输入与快捷键；
// 3. 仅在用户点击展开浮层时按需请求 /_dshx/api/instances，零常驻后台轮询开销。
(() => {
  if (window.__dshxMobilePillLoaded) return
  // 避免在子 iframe、原生 App 内置顶部切换栏或移动端控制台页面自身重复挂载
  if (window.self !== window.top) return
  if (window.location.pathname.startsWith('/_dshx/m')) return
  if (/DSHXNativeApp\//i.test(navigator.userAgent || '')) return
  window.__dshxMobilePillLoaded = true

  const POS_KEY = 'dshx_pill_pos_v1'
  const LANG_KEY = 'dshx_mobile_lang'
  const THEME_KEY = 'dshx_mobile_theme'

  function getLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY)
      if (saved === 'en' || saved === 'zh') return saved
    } catch {
      // 忽略存储受限
    }
    return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }

  function isDarkTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      if (saved === 'dark') return true
      if (saved === 'light') return false
    } catch {
      // 忽略
    }
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  }

  const COPY = {
    zh: {
      backConsole: '返回控制台',
      switchInstance: '切换实例',
      loading: '正在获取运行中实例…',
      empty: '暂无其他运行中的实例',
      loadError: '无法读取实例列表',
      current: '当前',
      close: '关闭',
    },
    en: {
      backConsole: 'Back to Console',
      switchInstance: 'Switch Instance',
      loading: 'Loading running instances…',
      empty: 'No running instances found',
      loadError: 'Failed to load instances',
      current: 'Active',
      close: 'Close',
    },
  }

  function text(key) {
    const lang = getLang()
    return (COPY[lang] && COPY[lang][key]) || COPY.zh[key] || key
  }

  function loadSavedPos() {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        const side = parsed.side === 'left' ? 'left' : 'right'
        const yRatio = Number(parsed.yRatio)
        if (Number.isFinite(yRatio) && yRatio >= 0.05 && yRatio <= 0.95) {
          return { side, yRatio }
        }
      }
    } catch {
      // 忽略
    }
    return { side: 'right', yRatio: 0.78 }
  }

  function savePos(pos) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch {
      // 忽略
    }
  }

  function mount() {
    if (!document.body) return

    const host = document.createElement('div')
    host.setAttribute('data-dshx-pill', '1')
    // all: initial 阻断宿主页面继承下来的字体/行高/颜色干扰；挂最高层级但不截获空白区域点击
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
    const shadow = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = `
      :host {
        all: initial;
      }
      * {
        box-sizing: border-box;
        -webkit-tap-highlight-color: transparent;
      }
      .wrap {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
        --pill-bg: rgba(255, 255, 255, 0.9);
        --pill-fg: #0f172a;
        --pill-muted: #64748b;
        --pill-border: rgba(15, 23, 42, 0.12);
        --pill-accent: #2563eb;
        --pill-accent-soft: rgba(37, 99, 235, 0.11);
        --pill-dot: #16a34a;
        --pill-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
      }
      .wrap.dark {
        --pill-bg: rgba(24, 26, 32, 0.92);
        --pill-fg: #f4f4f6;
        --pill-muted: #989aa6;
        --pill-border: rgba(255, 255, 255, 0.14);
        --pill-accent: #f4f4f6;
        --pill-accent-soft: rgba(255, 255, 255, 0.1);
        --pill-dot: #4ade80;
        --pill-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
      }
      .pill {
        position: fixed;
        top: 0;
        left: 0;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 34px;
        padding: 0 11px;
        border-radius: 999px;
        border: 1px solid var(--pill-border);
        background: var(--pill-bg);
        color: var(--pill-fg);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        box-shadow: var(--pill-shadow);
        font: inherit;
        font-size: 12px;
        font-weight: 650;
        letter-spacing: -0.01em;
        cursor: grab;
        opacity: 0.84;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        transition: opacity 160ms ease, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .pill.dragging {
        transition: none;
        cursor: grabbing;
        opacity: 0.98;
      }
      .pill:hover,
      .pill.open {
        opacity: 1;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--pill-dot);
        flex-shrink: 0;
      }
      .label {
        max-width: 112px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 999px;
        background: var(--pill-accent-soft);
        color: var(--pill-accent);
        font-size: 10px;
        font-weight: 700;
      }
      .count-badge[hidden] {
        display: none;
      }
      .popover {
        position: fixed;
        pointer-events: auto;
        width: 246px;
        max-width: calc(100vw - 24px);
        border-radius: 14px;
        border: 1px solid var(--pill-border);
        background: var(--pill-bg);
        color: var(--pill-fg);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: var(--pill-shadow);
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .popover[hidden] {
        display: none;
      }
      .pop-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 2px 6px;
        border-bottom: 1px solid var(--pill-border);
      }
      .pop-title {
        font-size: 12.5px;
        font-weight: 700;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pop-close {
        border: 0;
        background: transparent;
        color: var(--pill-muted);
        width: 24px;
        height: 24px;
        border-radius: 6px;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .pop-close:hover {
        background: var(--pill-accent-soft);
        color: var(--pill-fg);
      }
      .action-link {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 36px;
        padding: 0 12px;
        border-radius: 9px;
        background: var(--pill-accent);
        color: #ffffff;
        font-size: 13px;
        font-weight: 650;
        text-decoration: none;
      }
      .wrap.dark .action-link {
        color: #18181b;
      }
      .section-label {
        font-size: 11px;
        font-weight: 650;
        color: var(--pill-muted);
        padding: 2px 2px 0;
      }
      .inst-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 200px;
        overflow-y: auto;
      }
      .inst-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--pill-fg);
        text-decoration: none;
        font-size: 12.5px;
        font-weight: 550;
        cursor: pointer;
      }
      .inst-item:hover {
        background: var(--pill-accent-soft);
      }
      .inst-item.active {
        background: var(--pill-accent-soft);
        border-color: var(--pill-border);
        font-weight: 650;
      }
      .inst-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .inst-tag {
        font-size: 10.5px;
        color: var(--pill-dot);
        font-weight: 700;
        flex-shrink: 0;
      }
      .status-note {
        padding: 8px 4px;
        font-size: 12px;
        color: var(--pill-muted);
        text-align: center;
      }
    `

    const wrap = document.createElement('div')
    wrap.className = isDarkTheme() ? 'wrap dark' : 'wrap'

    const pillBtn = document.createElement('button')
    pillBtn.type = 'button'
    pillBtn.className = 'pill'
    pillBtn.setAttribute('aria-expanded', 'false')
    pillBtn.setAttribute('aria-label', 'DSH-X')

    const dot = document.createElement('span')
    dot.className = 'dot'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = 'DSH-X'
    const countBadge = document.createElement('span')
    countBadge.className = 'count-badge'
    countBadge.hidden = true
    pillBtn.append(dot, label, countBadge)

    const popover = document.createElement('div')
    popover.className = 'popover'
    popover.hidden = true

    const popHead = document.createElement('div')
    popHead.className = 'pop-head'
    const popTitle = document.createElement('span')
    popTitle.className = 'pop-title'
    popTitle.textContent = 'DSH-X'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'pop-close'
    closeBtn.setAttribute('aria-label', text('close'))
    closeBtn.textContent = '×'
    popHead.append(popTitle, closeBtn)

    const backLink = document.createElement('a')
    backLink.className = 'action-link'
    backLink.href = '/_dshx/m/'
    backLink.textContent = text('backConsole')

    const secLabel = document.createElement('div')
    secLabel.className = 'section-label'
    secLabel.textContent = text('switchInstance')

    const instList = document.createElement('div')
    instList.className = 'inst-list'

    popover.append(popHead, backLink, secLabel, instList)
    wrap.append(pillBtn, popover)
    shadow.append(style, wrap)
    document.body.appendChild(host)

    // ===== 贴边位置与拖拽状态 =====
    const pos = loadSavedPos()
    let currentX = 0
    let currentY = 0
    let popoverOpen = false
    let dragging = false
    let moved = false
    let startClientX = 0
    let startClientY = 0
    let startX = 0
    let startY = 0
    const EDGE_MARGIN = 10

    function clampY(y) {
      const h = pillBtn.offsetHeight || 36
      const minY = 20
      const maxY = Math.max(minY, window.innerHeight - h - 28)
      return Math.max(minY, Math.min(maxY, y))
    }

    function applyDockedPosition() {
      const w = pillBtn.offsetWidth || 72
      const vw = window.innerWidth
      currentX = pos.side === 'left' ? EDGE_MARGIN : Math.max(EDGE_MARGIN, vw - w - EDGE_MARGIN)
      currentY = clampY(Math.round(window.innerHeight * pos.yRatio))
      pillBtn.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`
      if (popoverOpen) positionPopover()
    }

    function positionPopover() {
      const pillW = pillBtn.offsetWidth || 72
      const pillH = pillBtn.offsetHeight || 36
      const popW = popover.offsetWidth || 246
      const popH = popover.offsetHeight || 190
      const vw = window.innerWidth
      const vh = window.innerHeight

      let left = pos.side === 'left' ? currentX : currentX + pillW - popW
      left = Math.max(12, Math.min(vw - popW - 12, left))

      let top = currentY - popH - 8
      if (top < 12) top = currentY + pillH + 8
      if (top + popH > vh - 12) top = Math.max(12, vh - popH - 12)

      popover.style.left = `${Math.round(left)}px`
      popover.style.top = `${Math.round(top)}px`
    }

    // ===== 按需加载实例列表 =====
    async function fetchAndRenderInstances() {
      instList.replaceChildren()
      const loading = document.createElement('div')
      loading.className = 'status-note'
      loading.textContent = text('loading')
      instList.appendChild(loading)
      positionPopover()

      try {
        const res = await fetch('/_dshx/api/instances', {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const instances = Array.isArray(data.instances) ? data.instances : []
        const activeKey = String(data.activeInstanceKey || '')

        instList.replaceChildren()
        if (!instances.length) {
          const empty = document.createElement('div')
          empty.className = 'status-note'
          empty.textContent = text('empty')
          instList.appendChild(empty)
          positionPopover()
          return
        }

        for (const inst of instances) {
          const isActive = Boolean(inst.active || (activeKey && inst.key === activeKey))
          const display =
            inst.version && inst.profile ? `${inst.version} · ${inst.profile}` : (inst.key || 'DSH')
          if (isActive) {
            popTitle.textContent = display
            label.textContent = inst.profile || 'DSH-X'
            if (instances.length > 1) {
              countBadge.textContent = String(instances.length)
              countBadge.hidden = false
            } else {
              countBadge.hidden = true
            }
            // 文本宽度可能变化，重新计算右贴边坐标
            applyDockedPosition()
          }
          const item = document.createElement('a')
          item.className = isActive ? 'inst-item active' : 'inst-item'
          item.href = `/_dshx/open/${encodeURIComponent(inst.key)}`
          if (isActive) {
            item.addEventListener('click', (e) => {
              e.preventDefault()
              closePopover()
            })
          }
          const nameSpan = document.createElement('span')
          nameSpan.className = 'inst-name'
          nameSpan.textContent = display
          item.appendChild(nameSpan)
          if (isActive) {
            const tag = document.createElement('span')
            tag.className = 'inst-tag'
            tag.textContent = text('current')
            item.appendChild(tag)
          }
          instList.appendChild(item)
        }
        positionPopover()
      } catch {
        instList.replaceChildren()
        const errNode = document.createElement('div')
        errNode.className = 'status-note'
        errNode.textContent = text('loadError')
        instList.appendChild(errNode)
        positionPopover()
      }
    }

    function onDocPointerDown(e) {
      // 点击事件路径不包含我们的 shadow host 时关闭浮层
      const path = e.composedPath ? e.composedPath() : []
      if (!path.includes(host)) closePopover()
    }

    function onDocKeyDown(e) {
      if (e.key === 'Escape') closePopover()
    }

    function openPopover() {
      if (popoverOpen) return
      popoverOpen = true
      wrap.className = isDarkTheme() ? 'wrap dark' : 'wrap'
      backLink.textContent = text('backConsole')
      secLabel.textContent = text('switchInstance')
      closeBtn.setAttribute('aria-label', text('close'))
      popover.hidden = false
      pillBtn.classList.add('open')
      pillBtn.setAttribute('aria-expanded', 'true')
      positionPopover()
      // 仅在浮层展开期间挂载外部点击与 Esc 监听，平时对 DSH 页面零影响
      document.addEventListener('pointerdown', onDocPointerDown, true)
      document.addEventListener('keydown', onDocKeyDown, false)
      fetchAndRenderInstances()
    }

    function closePopover() {
      if (!popoverOpen) return
      popoverOpen = false
      popover.hidden = true
      pillBtn.classList.remove('open')
      pillBtn.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onDocKeyDown, false)
    }

    closeBtn.addEventListener('click', closePopover)

    // ===== 拖拽与轻点区分 =====
    pillBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return
      dragging = true
      moved = false
      startClientX = e.clientX
      startClientY = e.clientY
      startX = currentX
      startY = currentY
      try { pillBtn.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    })

    pillBtn.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dx = e.clientX - startClientX
      const dy = e.clientY - startClientY
      if (!moved && Math.hypot(dx, dy) > 6) {
        moved = true
        pillBtn.classList.add('dragging')
        if (popoverOpen) closePopover()
      }
      if (!moved) return
      const w = pillBtn.offsetWidth || 72
      const maxX = Math.max(EDGE_MARGIN, window.innerWidth - w - EDGE_MARGIN)
      currentX = Math.max(EDGE_MARGIN, Math.min(maxX, startX + dx))
      currentY = clampY(startY + dy)
      pillBtn.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`
    })

    function finishPointer(e) {
      if (!dragging) return
      dragging = false
      pillBtn.classList.remove('dragging')
      try { pillBtn.releasePointerCapture(e.pointerId) } catch { /* 忽略 */ }

      if (moved) {
        const w = pillBtn.offsetWidth || 72
        const centerX = currentX + w / 2
        pos.side = centerX < window.innerWidth / 2 ? 'left' : 'right'
        pos.yRatio = Math.max(0.05, Math.min(0.95, currentY / Math.max(1, window.innerHeight)))
        savePos(pos)
        applyDockedPosition()
      } else {
        if (popoverOpen) closePopover()
        else openPopover()
      }
    }

    pillBtn.addEventListener('pointerup', finishPointer)
    pillBtn.addEventListener('pointercancel', finishPointer)

    window.addEventListener('resize', applyDockedPosition, { passive: true })
    window.addEventListener('orientationchange', () => setTimeout(applyDockedPosition, 120), { passive: true })

    // 挂载后轻量拉取一次当前实例名称与多实例计数，无常驻轮询开销
    async function prefetchActiveMeta() {
      try {
        const res = await fetch('/_dshx/api/instances', {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!res.ok) return
        const data = await res.json()
        const instances = Array.isArray(data.instances) ? data.instances : []
        const activeKey = String(data.activeInstanceKey || '')
        const cur = instances.find((i) => i.active || (activeKey && i.key === activeKey))
        if (cur) {
          label.textContent = cur.profile || 'DSH-X'
          popTitle.textContent = cur.version && cur.profile ? `${cur.version} · ${cur.profile}` : (cur.key || 'DSH')
        }
        if (instances.length > 1) {
          countBadge.textContent = String(instances.length)
          countBadge.hidden = false
        } else {
          countBadge.hidden = true
        }
        applyDockedPosition()
      } catch {
        // 静默忽略
      }
    }

    // 首次渲染对齐贴边位置
    requestAnimationFrame(applyDockedPosition)
    void prefetchActiveMeta()
  }

  if (document.readyState === 'loading' && !document.body) {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
