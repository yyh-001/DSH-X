(() => {
  const area = document.getElementById('internalTabsArea')
  const list = document.getElementById('internalTabList')
  const reload = document.getElementById('internalTabReload')
  const header = document.querySelector('header')
  if (!area || !list || !reload || !header) return

  const root = document.documentElement
  const send = (message) => window.ipc?.postMessage(typeof message === 'string' ? message : JSON.stringify(message))
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-x"/></svg>'
  const items = new Map()
  let lastHeight = 0
  let selected = ''
  let presentation = 0
  let submittedPresentation = 0
  let nextRequest = Date.now()
  let pendingSelection = null
  let presentationFrame = 0
  let presentationTimer = 0
  let drag = null
  let dragFrame = 0
  let pendingOrder = null
  let suppressedClick = null
  const moves = new Map()
  const reducedMotion = () => root.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches
  const tabNodes = () => [...list.children]
  const order = () => tabNodes().map((item) => item.dataset.id)
  const glide = (item, from) => {
    moves.get(item)?.cancel()
    moves.delete(item)
    if (!from || reducedMotion()) return
    const animation = item.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    moves.set(item, animation)
    animation.finished.catch(() => {}).then(() => { if (moves.get(item) === animation) moves.delete(item) })
  }
  /** 新标签淡入并轻微放大到原尺寸。用独立的 scale 属性，不和 glide 的 translateX 抢 transform。 */
  const enter = (item) => {
    if (reducedMotion()) return
    item.animate([{ opacity: 0, scale: '0.94' }, { opacity: 1, scale: '1' }], { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  }
  const arrange = (ids, animate = false, snapshot = null) => {
    const current = order()
    const desired = [...ids.filter((id) => items.has(id)), ...current.filter((id) => !ids.includes(id))]
    // 原生回执和标题轮询经常不改变顺序，不能因此提前结束正在播放的让位动画。
    if (desired.join('\0') === current.join('\0')) return
    const focus = list.contains(document.activeElement) ? document.activeElement : null
    // snapshot 是调用方在删掉节点之前量好的位置（关标签时用），拿不到才现量。
    const before = snapshot || new Map(tabNodes().map((item) => [item, item.getBoundingClientRect().left]))
    for (const animation of moves.values()) animation.cancel()
    moves.clear()
    let previous = null
    // 只移动节点，保留点击焦点；拖动期间新出现的标签继续排在末尾。
    for (const id of desired) {
      const item = items.get(id)
      if (!item) continue
      if (!previous) list.append(item)
      else if (previous.nextSibling !== item) previous.after(item)
      previous = item
    }
    if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true })
    // 移动被捕获的节点可能清掉浏览器的指针捕获，重排后立即重新绑定，避免拖到一半被当作取消。
    if (drag) { try { drag.capture.setPointerCapture(drag.pointer) } catch {} }
    if (animate) for (const item of tabNodes()) {
      if (item !== drag?.item && before.has(item)) glide(item, before.get(item) - item.getBoundingClientRect().left)
    }
  }
  const commitOrder = () => {
    pendingOrder = { ids: order(), request: ++nextRequest }
    send({ action: 'reorder', ...pendingOrder })
  }

  const selectVisual = (id) => {
    const changed = id !== selected
    selected = id
    for (const [key, item] of items) {
      item.classList.toggle('active', key === id)
      item.querySelector('.internal-tab-label').setAttribute('aria-selected', String(key === id))
    }
    if (changed) items.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const selectTab = (id) => {
    // 点击即开始滑动，不等待跨 WebView 的回传；请求编号防止快速连点被旧状态拉回。
    pendingSelection = { id, request: ++nextRequest }
    selectVisual(id)
    send({ action: 'select', ...pendingSelection })
  }

  const reportHeight = () => {
    if (area.hidden) return
    const height = Math.ceil(header.getBoundingClientRect().bottom)
    if (height !== lastHeight) {
      lastHeight = height
      send({ action: 'layout', height })
    }
  }

  const moveDrag = () => {
    if (!drag?.started) return
    const bounds = list.getBoundingClientRect()
    const item = drag.item
    const intended = drag.x - bounds.left + list.scrollLeft - drag.grab
    const left = Math.max(0, Math.min(list.scrollWidth - item.offsetWidth, intended))
    const peers = tabNodes().filter((node) => node !== item)
    // 图形停在条内，排序仍跟随指针；否则首尾标签会被边界夹住，永远跨不过相邻项的中心。
    const index = peers.filter((node) => intended + item.offsetWidth / 2 > node.offsetLeft + node.offsetWidth / 2).length
    const ids = peers.map((node) => node.dataset.id)
    ids.splice(index, 0, item.dataset.id)
    if (ids.join('\0') !== order().join('\0')) arrange(ids, true)
    drag.offset = left - item.offsetLeft
    item.style.transform = `translateX(${drag.offset}px)`
  }
  const scrollDrag = () => {
    if (!drag?.started) return
    const bounds = list.getBoundingClientRect()
    const delta = drag.x < bounds.left + 28 ? -8 : drag.x > bounds.right - 28 ? 8 : 0
    if (delta) { list.scrollLeft += delta; moveDrag() }
    dragFrame = requestAnimationFrame(scrollDrag)
  }
  const finishDrag = (cancel = false) => {
    if (!drag) return
    const ended = drag
    drag = null
    cancelAnimationFrame(dragFrame)
    list.classList.remove('dragging')
    ended.item.classList.remove('dragging')
    ended.item.style.removeProperty('transform')
    try { ended.capture.releasePointerCapture(ended.pointer) } catch {}
    if (ended.started) {
      suppressedClick = { item: ended.item, until: Date.now() + 400 }
      if (cancel) arrange(ended.original, true)
      else {
        glide(ended.item, ended.offset)
        if (order().join('\0') !== ended.original.join('\0')) commitOrder()
      }
    }
  }
  list.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false || drag) return
    const item = event.target.closest('.internal-tab')
    if (!item || event.target.closest('.internal-tab-close')) return
    suppressedClick = null
    const bounds = item.getBoundingClientRect()
    const capture = event.target.closest('.internal-tab-label') || item
    drag = { item, capture, pointer: event.pointerId, x: event.clientX, start: event.clientX, grab: event.clientX - bounds.left, original: order(), started: false, offset: 0 }
    // 捕获指针，拖到原生页面区域或标签条外也能正常松手；不触发标题栏拖窗口。
    try { capture.setPointerCapture(event.pointerId) } catch {}
  })
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return
    drag.x = event.clientX
    if (!drag.started && Math.abs(drag.x - drag.start) < 5) return
    if (!drag.started) {
      drag.started = true
      list.classList.add('dragging')
      drag.item.classList.add('dragging')
      scrollDrag()
    }
    event.preventDefault()
    moveDrag()
  })
  document.addEventListener('pointerup', (event) => { if (event.pointerId === drag?.pointer) finishDrag() })
  document.addEventListener('pointercancel', (event) => { if (event.pointerId === drag?.pointer) finishDrag(true) })
  list.addEventListener('lostpointercapture', (event) => { if (event.pointerId === drag?.pointer) finishDrag(true) })
  window.addEventListener('blur', () => finishDrag(true))
  list.addEventListener('click', (event) => {
    if (suppressedClick && Date.now() < suppressedClick.until && suppressedClick.item.contains(event.target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressedClick = null
    }
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(true); return }
    const item = event.target.closest?.('.internal-tab-label')?.closest('.internal-tab')
    if (!item || drag || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const ids = order(), index = ids.indexOf(item.dataset.id)
    const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
    if (next < 0 || next >= ids.length) return
    event.preventDefault()
    ;[ids[index], ids[next]] = [ids[next], ids[index]]
    arrange(ids, true)
    commitOrder()
  })

  window.updateInternalTabs = (state) => {
    const enabled = state.enabled === true
    const active = String(state.active || '')
    const en = state.lang === 'en'
    root.classList.toggle('internal-tabs', enabled)
    // 顶栏形态由「有没有标签」决定：一个标签都没有时还是原来那条高顶栏，浏览器式扁条只在真有标签时出现。
    root.classList.toggle('has-tabs', enabled && (state.tabs || []).length > 0)
    root.classList.toggle('internal-dsh-active', enabled && !!active)
    // 选中标签的底色跟选中那块页面走（外壳采样来的）：同色才看不出接缝，采样不到就退回主题色。
    if (state.surface) root.style.setProperty('--tab-surface', state.surface)
    else root.style.removeProperty('--tab-surface')
    // 标签上的字跟着采到的底色走（亮底给深字）：外壳算好放在 state.ink 里
    if (state.ink) root.style.setProperty('--tab-ink', state.ink)
    else root.style.removeProperty('--tab-ink')
    area.hidden = !enabled
    // 隐藏的管理内容不能被键盘 Tab 聚焦；顶部设置、Star 与窗口控制仍保留原来的交互。
    const main = document.querySelector('main')
    if (main) {
      main.inert = enabled && !!active
      if (main.inert) main.setAttribute('aria-hidden', 'true')
      else main.removeAttribute('aria-hidden')
    }
    reload.title = en ? 'Reload page' : '刷新页面'
    reload.setAttribute('aria-label', reload.title)
    const ids = new Set((state.tabs || []).map((tab) => tab.id))
    if (drag && (!enabled || !ids.has(drag.item.dataset.id))) finishDrag(true)
    if (pendingOrder && state.orderRequest === pendingOrder.request) pendingOrder = null
    if (pendingSelection && (state.request === pendingSelection.request || (pendingSelection.id && !ids.has(pendingSelection.id)))) pendingSelection = null
    // 关标签：先量一遍现在的位置，删掉节点后让剩下的从老位置滑过去，别硬跳一格。
    const closing = [...items].filter(([id]) => !ids.has(id))
    const closingBefore = closing.length ? new Map(tabNodes().map((item) => [item, item.getBoundingClientRect().left])) : null
    for (const [id, item] of closing) {
      item.remove()
      items.delete(id)
    }
    const localOrder = drag || pendingOrder ? order() : null
    for (const tab of state.tabs || []) {
      let item = items.get(tab.id)
      const created = !item
      if (created) {
        item = document.createElement('div')
        item.className = 'internal-tab'
        item.dataset.id = tab.id
        item.innerHTML = `<button type="button" class="internal-tab-label" role="tab"><span></span></button><button type="button" class="internal-tab-close">${closeIcon}</button>`
        item.querySelector('.internal-tab-label').onclick = () => selectTab(tab.id)
        item.querySelector('.internal-tab-close').onclick = () => send({ action: 'close-tab', id: tab.id })
        item.onauxclick = (event) => {
          if (event.button === 1) { event.preventDefault(); send({ action: 'close-tab', id: tab.id }) }
        }
        items.set(tab.id, item)
      }
      // 复用节点让选中态连续过渡，也保留键盘焦点；后台标题变化不能重建整排标签。
      if (!item.parentNode) list.append(item)
      // 入场动画要等节点进了文档再起，否则（未挂载的元素不动画）什么都看不到。
      if (created) enter(item)
      item.classList.toggle('stopped', !!tab.stopped)
      const label = item.querySelector('.internal-tab-label')
      label.title = [tab.title, tab.pageTitle].filter(Boolean).join(' — ')
      const text = label.firstElementChild
      if (text.textContent !== tab.title) text.textContent = tab.title
      const close = item.querySelector('.internal-tab-close')
      close.title = en ? 'Close tab' : '关闭标签'
      close.setAttribute('aria-label', close.title)
    }
    arrange(localOrder || (state.tabs || []).map((tab) => tab.id), !!closingBefore, closingBefore)
    if (drag?.started) moveDrag()
    selectVisual(pendingSelection?.id ?? active)
    reportHeight()
    const serial = state.presentation
    if (!pendingSelection && Number.isSafeInteger(serial) && serial !== submittedPresentation) {
      presentation = serial
      cancelAnimationFrame(presentationFrame)
      clearTimeout(presentationTimer)
      const submit = () => {
        if (!pendingSelection && serial === presentation && serial !== submittedPresentation) {
          cancelAnimationFrame(presentationFrame)
          clearTimeout(presentationTimer)
          submittedPresentation = serial
          send({ action: 'present', serial })
        }
      }
      // 保留主页画面后无需等两帧；内容层遮挡可能让管理页的 rAF 降频，短超时避免切换卡住。
      presentationFrame = requestAnimationFrame(submit)
      presentationTimer = setTimeout(submit, 50)
    }
  }

  reload.onclick = () => send({ action: 'reload' })
  document.getElementById('brandHome')?.addEventListener('click', () => {
    selectTab('')
  }, true)
  // 先切回管理页再让原来的齿轮处理器打开设置，避免设置页被 DSH 的原生内容层盖住。
  document.getElementById('settingsEntry')?.addEventListener('click', () => {
    if (root.classList.contains('internal-dsh-active')) selectTab('')
  }, true)
  new ResizeObserver(reportHeight).observe(header)

  /**
   * 标签中心的 x（给外壳采「这张标签正下方」的底色用）：视图和管理页同宽同原点，
   * 所以 DOM 坐标就是页面里的坐标。拿不到（刚建、已关）返回 0，外壳那边退回左上角。
   */
  window.launcherTabCenterX = (id) => {
    const item = items.get(id)
    if (!item) return 0
    const box = item.getBoundingClientRect()
    return Math.round(box.left + box.width / 2)
  }

  // 原生标签页叠在管理页之上，管理页的弹窗（.ask）会被它盖住、遮罩却挡住了标签栏，弹窗就关不掉了。
  // 有弹窗开着就让外壳先收起标签页，关完再放回；初值为 null，保证页面重载后先把真实状态同步一次。
  let overlay = null
  const syncOverlay = () => {
    const open = !!document.querySelector('.ask:not([hidden])')
    if (open === overlay) return
    overlay = open
    send({ action: 'overlay', open })
  }
  new MutationObserver(syncOverlay).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] })
  send('internal-tabs-ready')
  syncOverlay()
})()
