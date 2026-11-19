(() => {
  const area = document.getElementById('internalTabsArea')
  const list = document.getElementById('internalTabList')
  const reload = document.getElementById('internalTabReload')
  const header = document.querySelector('header')
  if (!area || !list || !reload || !header) return

  const root = document.documentElement
  const send = (message) => window.ipc?.postMessage(typeof message === 'string' ? message : JSON.stringify(message))
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-x"/></svg>'
  const menuIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-ellipsis"/></svg>'
  // 提示浮在顶栏内，不挤压列表；进入拖出状态时标签宽度和命中边界必须保持稳定。
  const detachHint = document.createElement('span')
  detachHint.className = 'internal-tab-hint'
  detachHint.setAttribute('role', 'status')
  detachHint.setAttribute('aria-atomic', 'true')
  detachHint.hidden = true
  area.append(detachHint)
  const dropMarker = document.createElement('span')
  dropMarker.className = 'internal-tab-drop-marker'
  dropMarker.setAttribute('aria-hidden', 'true')
  dropMarker.hidden = true
  area.append(dropMarker)
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
  let detach = { supported: false, drag: false }
  let pendingDetach = null
  let lastDetachError = null
  let en = false
  let standalone = false
  let merging = false
  let lastStrip = ''
  const moves = new Map()
  const shared = globalThis.launcherMotion
  const motionPreference = shared ? null : matchMedia('(prefers-reduced-motion: reduce)')
  const reducedMotion = () => (
    shared?.reduced
      ? shared.reduced()
      : Boolean(root.classList.contains('reduce-motion') || root.dataset?.reduceMotion === 'true' || motionPreference.matches)
  )
  shared?.onReduceChange?.(() => {
    if (!reducedMotion()) return
    for (const animation of moves.values()) animation.cancel()
    moves.clear()
  })
  const tabNodes = () => [...list.children]
  const order = () => tabNodes().map((item) => item.dataset.id)
  const glide = (item, from) => {
    moves.get(item)?.cancel()
    moves.delete(item)
    if (!from || reducedMotion()) return
    const animation = item.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], {
      duration: shared?.duration?.tabGlide ?? 220,
      easing: shared?.ease?.standard ?? 'cubic-bezier(.2, .8, .2, 1)',
    })
    moves.set(item, animation)
    animation.finished.catch(() => {}).then(() => { if (moves.get(item) === animation) moves.delete(item) })
  }
  /** 新标签只淡入；缩放会改变上报的抓取区域，使窗口淡入期间的鼠标锚点漂移。 */
  const enter = (item) => {
    if (reducedMotion()) return
    item.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: shared?.duration?.tabEnter ?? 180,
      easing: shared?.ease?.standard ?? 'cubic-bezier(.2, .8, .2, 1)',
    })
  }
  const arrange = (ids, animate = false, snapshot = null) => {
    const current = order()
    const wanted = new Set(ids)
    const desired = [...ids.filter((id) => items.has(id)), ...current.filter((id) => !wanted.has(id))]
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
    if (animate) {
      // 先一次读完新位置，再启动动画，避免逐个节点交错测量与样式写入。
      const after = new Map(tabNodes().map((item) => [item, item.getBoundingClientRect().left]))
      for (const [item, left] of after) {
        if (item !== drag?.item && before.has(item)) glide(item, before.get(item) - left)
      }
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
    const focused = document.activeElement?.closest?.('.internal-tab')?.dataset.id
    tabStops(items.has(focused) ? focused : id || order()[0])
    if (changed) items.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const tabStops = (id) => {
    for (const [key, item] of items) {
      for (const selector of ['.internal-tab-label', '.internal-tab-menu', '.internal-tab-close']) {
        item.querySelector(selector).tabIndex = key === id ? 0 : -1
      }
    }
  }
  const selectTab = (id) => {
    if (standalone && !id) { send('manager'); return }
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
    reportStrip()
  }

  const reportStrip = () => {
    if (!detach.merge || area.hidden) return
    const { left, right, top, bottom } = list.getBoundingClientRect()
    const value = { action: 'tab-strip', rect: { left, right, top, bottom }, tabs: tabNodes().map((item) => {
      // 列表是定位父级；offset 几何不含让位动画/鼠标跟随的 transform。
      // 缓存中间动画帧会在迁出后永久过期，甚至把回并提交到错误的槽位。
      const x = left + list.clientLeft + item.offsetLeft - list.scrollLeft
      const y = top + list.clientTop + item.offsetTop - list.scrollTop
      return { id: item.dataset.id, left: x, right: x + item.offsetWidth, top: y, bottom: y + item.offsetHeight }
    }) }
    const key = JSON.stringify(value)
    if (key !== lastStrip) { lastStrip = key; send(value) }
  }

  window.updateTabDrop = (value) => {
    merging = value?.merging === true
    dropMarker.hidden = !Number.isFinite(value?.marker)
    if (!dropMarker.hidden) {
      const bounds = list.getBoundingClientRect()
      dropMarker.style.left = `${value.marker}px`
      dropMarker.style.top = `${bounds.top + 4}px`
      dropMarker.style.height = `${Math.max(4, bounds.height - 8)}px`
    }
    if (drag?.detach) paintDragHint()
  }

  const paintDragHint = () => {
    const text = drag?.live ? (en ? 'Moving tab · Esc to cancel' : '正在移动标签 · Esc 撤销')
      : merging ? (en ? 'Release to join window' : '松手并入此窗口') : (en ? 'Release for new window' : '松手移到新窗口')
    // 状态提示是 live region，同一条文字不随每次 pointermove 重复播报。
    if (detachHint.textContent !== text) detachHint.textContent = text
  }

  const requestDetach = (id, source) => {
    if (!detach.supported || pendingDetach) return
    pendingDetach = { id, request: ++nextRequest }
    items.get(id)?.setAttribute('aria-busy', 'true')
    send({ action: source === 'menu' ? 'tab-menu' : 'detach-tab', ...pendingDetach, source })
  }

  const detachCandidate = () => {
    if (!drag?.started) return false
    const bounds = list.getBoundingClientRect()
    // 与外壳 outsideTabStrip 同一契约：上下24/8迟滞，左右退出需回视口内。
    const outside = drag.y < bounds.top - 24 || drag.y > bounds.bottom + 24
      || drag.x < -24 || drag.x > window.innerWidth + 24
    const inside = drag.y >= bounds.top - 8 && drag.y <= bounds.bottom + 8
      && drag.x >= 0 && drag.x <= window.innerWidth
    drag.detach = detach.drag && drag.mouse && (outside || drag.detach && !inside)
    drag.item.classList.toggle('detach-ready', drag.detach)
    if (detachHint.hidden === drag.detach) detachHint.hidden = !drag.detach
    if (drag.detach) paintDragHint()
    return drag.detach
  }

  const moveDrag = () => {
    if (!drag?.started) return
    if (drag.deferred) {
      // 布局/滚动可能刚发生变化；先发送本帧几何，再发坐标，避免外壳按旧边界决定动作。
      reportStrip()
      send({ action: 'tab-drag-move', id: drag.id, point: { x: drag.x, y: drag.y } })
    }
    // 跨窗后由外壳维护当前位置；源顶栏只保留指针捕获，不再对旧节点做排序。
    if (drag.remote) { detachHint.hidden = false; paintDragHint(); return }
    if (detachCandidate()) return
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
    dragFrame = 0
    if (!drag?.started) return
    moveDrag()
    if (!drag || drag.detach || drag.remote) return
    const bounds = list.getBoundingClientRect()
    const delta = drag.x < bounds.left + 28 ? -8 : drag.x > bounds.right - 28 ? 8 : 0
    const before = list.scrollLeft
    if (delta) list.scrollLeft = Math.max(0, Math.min(list.scrollWidth - bounds.width, before + delta))
    // 仅边缘还可滚动时续帧。静止拖动、到达首尾、拖出候选都不维持空转 rAF。
    if (list.scrollLeft !== before) {
      moveDrag()
      dragFrame = requestAnimationFrame(scrollDrag)
    }
  }
  const scheduleDrag = () => { if (!dragFrame) dragFrame = requestAnimationFrame(scrollDrag) }
  const finishDrag = (cancel = false) => {
    if (!drag) return
    const ended = drag
    drag = null
    cancelAnimationFrame(dragFrame)
    dragFrame = 0
    list.classList.remove('dragging')
    ended.item.classList.remove('dragging')
    ended.item.classList.remove('detach-ready')
    detachHint.hidden = true
    merging = false
    ended.item.style.removeProperty('transform')
    try { ended.capture.releasePointerCapture(ended.pointer) } catch {}
    // 尚未越过门槛也可能被 Esc/失焦取消，随后到达的原生 click 不能再激活标签。
    if (ended.started || cancel) suppressedClick = { item: ended.item, pointer: ended.pointer }
    if (ended.started) {
      if (ended.deferred) {
        const ids = order()
        if (cancel || ended.detach) arrange(ended.original, true)
        else glide(ended.item, ended.offset)
        // 排序和跨窗提交共用松手消息，主进程按最终落点只选择其中一项。
        send({ action: 'tab-drag', id: ended.id, active: false, deferred: true, cancel,
          point: { x: ended.x, y: ended.y }, order: ids, request: ++nextRequest })
        return
      }
      if (ended.live) {
        // 移交后由主进程排序/撤销；回源松手不能先把 DOM 恢复到手势开始的顺序。
        if (!ended.remote) {
          if (cancel || ended.detach) arrange(ended.original, true)
          else if (order().join('\0') !== ended.original.join('\0')) commitOrder()
        }
        send({ action: 'tab-drag', id: ended.id, active: false, live: true, cancel })
        return
      }
      if (cancel || ended.detach) {
        // 松手拆窗与取消都不提交途中排序；失败时源标签仍在原位置。
        arrange(ended.original, true)
        if (!cancel) requestDetach(ended.item.dataset.id, 'drag')
      }
      else {
        glide(ended.item, ended.offset)
        if (order().join('\0') !== ended.original.join('\0')) commitOrder()
      }
      if (detach.merge && (cancel || !ended.detach)) send({ action: 'tab-drag', id: ended.item.dataset.id, active: false, cancel })
    }
  }
  // hide/minimize 不保证产生 pointercancel；外壳主动撤销时必须释放 Chromium 捕获。
  window.cancelTabDrag = () => finishDrag(true)
  document.addEventListener('visibilitychange', () => { if (document.hidden) finishDrag(true) })
  list.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false) return
    // 新的一次物理按下（包括关闭/菜单按钮）不属于上次取消留下的 click。
    suppressedClick = null
    if (drag || pendingDetach) return
    const item = event.target.closest('.internal-tab')
    if (!item || event.target.closest('.internal-tab-close, .internal-tab-menu')) return
    const bounds = item.getBoundingClientRect()
    const live = detach.live && (!event.pointerType || event.pointerType === 'mouse')
    const deferred = detach.deferred && (!event.pointerType || event.pointerType === 'mouse')
    // pointerup 时的捕获目标也决定随后 click 的目标；未开始拖动前保留原按钮的原生点击。
    const capture = event.target.closest('.internal-tab-label') || item
    drag = { item, id: item.dataset.id, live, deferred, remote: false, capture, pointer: event.pointerId, x: event.clientX, y: event.clientY, start: event.clientX, startY: event.clientY,
      grab: event.clientX - bounds.left,
      windowGrab: { x: event.clientX - bounds.left, y: event.clientY - bounds.top, width: bounds.width, height: bounds.height,
        clientX: event.clientX, clientY: event.clientY },
      original: order(), started: false, offset: 0, detach: false,
      mouse: !event.pointerType || event.pointerType === 'mouse' }
    // 捕获指针，拖到原生页面区域或标签条外也能正常松手；不触发标题栏拖窗口。
    try { capture.setPointerCapture(event.pointerId) } catch {}
  })
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.started && Math.hypot(drag.x - drag.start, drag.y - drag.startY) < 5) return
    if (!drag.started) {
      if (drag.live || drag.deferred) {
        // 真正拖动才交给不会随排序/移交消失的列表，发送开始 IPC 前先接好捕获。
        const previous = drag.capture
        drag.capture = list
        try { list.setPointerCapture(drag.pointer) } catch { drag.capture = previous }
      }
      drag.started = true
      list.classList.add('dragging')
      drag.item.classList.add('dragging')
      if (detach.merge && drag.mouse && detach.drag) send({ action: 'tab-drag', id: drag.id, active: true,
        ...(drag.live ? { live: true, grab: drag.windowGrab } : {}),
        ...(drag.deferred ? { deferred: true, grab: drag.windowGrab, point: { x: drag.x, y: drag.y } } : {}) })
    }
    event.preventDefault()
    // 高频鼠标事件只记最新坐标，每个显示帧最多计算一次排序；松手时另行同步最后位置。
    scheduleDrag()
  })
  document.addEventListener('pointerup', (event) => {
    if (event.pointerId !== drag?.pointer) return
    drag.x = event.clientX
    drag.y = event.clientY
    moveDrag()
    finishDrag()
  })
  document.addEventListener('pointercancel', (event) => { if (event.pointerId === drag?.pointer) finishDrag(true) })
  // label → list 的捕获交接会冒泡旧 label 的 lostcapture；只有当前捕获者丢失才取消。
  list.addEventListener('lostpointercapture', (event) => { if (event.pointerId === drag?.pointer && event.target === drag.capture) finishDrag(true) })
  window.addEventListener('blur', () => finishDrag(true))
  list.addEventListener('click', (event) => {
    // 键盘激活的 detail=0 是新操作；物理松手可能很迟，不能以固定毫秒数把旧 click 当成新选择。
    if (event.detail !== 0 && suppressedClick && (event.pointerId === undefined || event.pointerId === suppressedClick.pointer)
      && suppressedClick.item.contains(event.target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressedClick = null
    }
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(true); return }
    const tab = event.target.closest?.('.internal-tab')
    if (tab && detach.supported && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      finishDrag(true)
      requestDetach(tab.dataset.id, 'menu')
      return
    }
    const item = event.target.closest?.('.internal-tab-label')?.closest('.internal-tab')
    if (!item || drag || event.ctrlKey || event.metaKey) return
    const ids = order(), index = ids.indexOf(item.dataset.id)
    if (!event.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length
      tabStops(ids[next])
      const label = items.get(ids[next]).querySelector('.internal-tab-label')
      label.focus({ preventScroll: true })
      label.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
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
    en = state.lang === 'en'
    standalone = state.standalone === true
    if (standalone) root.classList.toggle('reduce-motion', state.reduceMotion === true)
    detach = { supported: state.detach?.supported === true, drag: state.detach?.supported === true && state.detach?.drag === true,
      merge: state.detach?.merge === true, live: state.detach?.supported === true && state.detach?.drag === true && state.detach?.merge === true && state.detach?.live === true,
      deferred: state.detach?.supported === true && state.detach?.drag === true && state.detach?.merge === true && state.detach?.deferred === true }
    root.classList.toggle('tab-detach-enabled', detach.supported)
    const result = state.detachResult
    if (pendingDetach && result?.request === pendingDetach.request && result.id === pendingDetach.id) {
      items.get(pendingDetach.id)?.removeAttribute('aria-busy')
      pendingDetach = null
    }
    if (result?.status === 'error' && result.request !== null && result.request !== lastDetachError) {
      lastDetachError = result.request
      window.notifyError?.(new Error(en ? 'Could not move the tab. Your page is still in its original window. Please try again.' : '无法移到新窗口，页面仍保留在原窗口，请重试。'))
    }
    root.classList.toggle('internal-tabs', enabled)
    // 顶栏形态由「有没有标签」决定：一个标签都没有时还是原来那条高顶栏，浏览器式扁条只在真有标签时出现。
    root.classList.toggle('has-tabs', enabled && ((state.tabs || []).length > 0 || !!state.dragging))
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
    if (drag?.live && state.floating === drag.id) {
      // 窗口已经在跟随鼠标，标签不能再叠加一次条内位移。
      drag.remote = true
      drag.item.style.removeProperty('transform')
    }
    if (drag && !ids.has(drag.id) && drag.live && state.dragging === drag.id) drag.remote = true
    if (drag && (!enabled || !ids.has(drag.id) && !(drag.live && state.dragging === drag.id))) finishDrag(true)
    if (pendingOrder && state.orderRequest === pendingOrder.request) pendingOrder = null
    if (pendingSelection && (state.request === pendingSelection.request || (pendingSelection.id && !ids.has(pendingSelection.id)))) pendingSelection = null
    // 关标签：先量一遍现在的位置，删掉节点后让剩下的从老位置滑过去，别硬跳一格。
    const closing = [...items].filter(([id]) => !ids.has(id))
    const closingBefore = closing.length ? new Map(tabNodes().map((item) => [item, item.getBoundingClientRect().left])) : null
    for (const [id, item] of closing) {
      item.remove()
      items.delete(id)
    }
    const localOrder = drag && !drag.remote || pendingOrder ? order() : null
    for (const tab of state.tabs || []) {
      let item = items.get(tab.id)
      const created = !item
      if (created) {
        item = document.createElement('div')
        item.className = 'internal-tab'
        item.dataset.id = tab.id
        item.innerHTML = `<button type="button" class="internal-tab-label" role="tab"><span></span></button><button type="button" class="internal-tab-menu" aria-haspopup="menu" hidden>${menuIcon}</button><button type="button" class="internal-tab-close">${closeIcon}</button>`
        item.querySelector('.internal-tab-label').onclick = () => selectTab(tab.id)
        item.querySelector('.internal-tab-close').onclick = () => send({ action: 'close-tab', id: tab.id })
        item.querySelector('.internal-tab-menu').onclick = () => requestDetach(tab.id, 'menu')
        item.oncontextmenu = (event) => {
          if (!detach.supported) return
          event.preventDefault()
          finishDrag(true)
          requestDetach(tab.id, 'menu')
        }
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
      const menu = item.querySelector('.internal-tab-menu')
      menu.hidden = !detach.supported
      menu.disabled = !!pendingDetach
      menu.title = en ? 'Tab actions' : '标签操作'
      menu.setAttribute('aria-label', menu.title)
    }
    arrange(localOrder || (state.tabs || []).map((tab) => tab.id), !!closingBefore, closingBefore)
    if (drag?.started) scheduleDrag()
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
  new ResizeObserver(reportStrip).observe(list)
  list.addEventListener('scroll', reportStrip)

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
