(() => {
  const root = document.documentElement
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const lists = new WeakMap(), active = new Map()
  const reduced = () => motion.matches || root.dataset.reduceMotion === 'true'

  function play(node, frames, options, cleanup = () => {}) {
    active.get(node)?.()
    if (reduced() || typeof node.animate !== 'function') { cleanup(); return }
    const animation = node.animate(frames, { easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both', ...options })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      active.delete(node)
      animation.cancel()
      cleanup()
    }
    active.set(node, finish)
    // 取消动画也必须释放占位，不能让快速连续增删留下幽灵项或固定高度。
    animation.finished.then(finish, finish)
  }

  function stopMotion() {
    if (reduced()) for (const finish of [...active.values()]) finish()
  }
  motion.addEventListener('change', stopMotion)
  new MutationObserver(stopMotion).observe(root, { attributes: true, attributeFilter: ['data-reduce-motion'] })

  function sortable(container, options) {
    let gesture = null
    const rows = () => [...container.children].filter((row) => row.dataset.launchKey && !row.dataset.launchRemoving)
    const order = () => rows().map((row) => row.dataset.launchKey)
    const ready = () => !gesture && rows().length > 1 && options.canStart()
    const markLast = () => {
      const current = rows()
      for (const row of current) {
        if (row === current.at(-1)) row.dataset.launchLast = 'true'
        else delete row.dataset.launchLast
      }
    }

    function moveRows(change, moving) {
      const positions = new Map(rows().map((row) => [row, row.getBoundingClientRect().top]))
      for (const row of rows()) active.get(row)?.()
      change()
      markLast()
      for (const row of rows()) {
        if (row === moving) continue
        const shift = positions.get(row) - row.getBoundingClientRect().top
        if (Math.abs(shift) > .5) play(row, [{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 220 })
      }
    }

    function place(y) {
      const current = rows(), moving = gesture.row
      const top = container.getBoundingClientRect().top - container.scrollTop
      // 补位动画改变视觉坐标，不改变布局；用布局中线命中，避免动画中的项又把拖动项推回去。
      const before = current.find((row) => row !== moving && y < top + row.offsetTop + row.offsetHeight / 2) || null
      if (moving.nextElementSibling === before || (!before && current.at(-1) === moving)) return
      moveRows(() => container.insertBefore(moving, before), moving)
    }

    function tick() {
      if (!gesture?.ghost) return
      const { scroller, y } = gesture
      const box = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect()
      const delta = y < box.top + 36 ? -10 : y > box.bottom - 36 ? 10 : 0
      if (delta) { scroller.scrollTop += delta; place(y) }
      gesture.frame = requestAnimationFrame(tick)
    }

    function finish(cancel = false) {
      if (!gesture) return
      const { original, handle, pointer, row, ghost, frame } = gesture
      const wasDragging = Boolean(ghost)
      gesture = null
      cancelAnimationFrame(frame)
      if (container.hasPointerCapture(pointer)) container.releasePointerCapture(pointer)
      handle.blur()
      delete handle.dataset.pointerFocus
      if (cancel) moveRows(() => { for (const item of original) container.append(item) }, row)
      markLast()
      const ids = order()
      const complete = () => {
        ghost?.remove()
        active.get(row)?.()
        row.classList.remove('launch-sorting-row')
        if (['dragging', 'settling'].includes(container.dataset.sorting)) delete container.dataset.sorting
        if (wasDragging && !cancel && ids.some((id, index) => id !== original[index].dataset.launchKey)) void options.onReorder(ids)
        options.onFinish()
      }
      if (!ghost) { complete(); return }
      // 落位完成前继续暂停状态回填，避免预览还在移动时列表被后台刷新重建。
      container.dataset.sorting = 'settling'
      const target = row.getBoundingClientRect().top - parseFloat(ghost.style.top)
      play(row, [{ opacity: .25 }, { opacity: 1 }], { duration: 200 })
      play(ghost, [
        { transform: ghost.style.transform, opacity: 1 },
        { transform: `translateY(${target}px)`, opacity: 0, boxShadow: '0 2px 6px #00000000' },
      ], { duration: 200 }, complete)
    }

    container.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('[data-launch-drag-handle]')
      if (!handle || !container.contains(handle) || event.button !== 0 || !event.isPrimary || !ready()) return
      const row = handle.closest('[data-launch-key]')
      if (row.dataset.launchRemoving) return
      event.preventDefault()
      handle.dataset.pointerFocus = 'true'
      handle.focus({ preventScroll: true })
      // 排序会移动图标所在的 DOM 节点，捕获放在不移动的列表上，避免跨过一项就丢失捕获。
      container.setPointerCapture(event.pointerId)
      gesture = { row, handle, pointer: event.pointerId, original: rows(), startX: event.clientX, startY: event.clientY, y: event.clientY }
      // 从按下起暂停状态回填，连尚未超过拖动阈值时也不能重建图标。
      container.dataset.sorting = 'dragging'
    })
    container.addEventListener('pointermove', (event) => {
      if (!gesture || event.pointerId !== gesture.pointer) return
      gesture.y = event.clientY
      if (!gesture.ghost) {
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 5) return
        active.get(container)?.()
        for (const row of rows()) active.get(row)?.()
        const rect = gesture.row.getBoundingClientRect()
        const ghost = gesture.row.cloneNode(true)
        ghost.removeAttribute('data-launch-key')
        ghost.classList.add('launch-sort-ghost')
        ghost.setAttribute('aria-hidden', 'true')
        ghost.inert = true
        Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
        document.body.append(ghost)
        // 浮层补上独立卡片的左右留白，同时向外扩展，保持图标和按钮的原始位置及内容宽度。
        const style = getComputedStyle(ghost)
        const left = parseFloat(style.paddingLeft) || 0, right = parseFloat(style.paddingRight) || 0
        ghost.style.left = `${rect.left - left}px`
        ghost.style.width = `${rect.width + left + right}px`
        gesture.ghost = ghost
        gesture.row.classList.add('launch-sorting-row')
        play(ghost, [{ boxShadow: '0 2px 6px #00000010' }, { boxShadow: '0 12px 30px #00000030' }], { duration: 160 })
        let scroller = container.parentElement
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
        gesture.scroller = scroller || document.scrollingElement
        gesture.frame = requestAnimationFrame(tick)
      }
      gesture.ghost.style.transform = `translateY(${event.clientY - gesture.startY}px)`
      place(event.clientY)
    })
    container.addEventListener('pointerup', (event) => { if (gesture?.pointer === event.pointerId) finish() })
    container.addEventListener('pointercancel', (event) => { if (gesture?.pointer === event.pointerId) finish(true) })
    container.addEventListener('lostpointercapture', (event) => { if (gesture?.pointer === event.pointerId) finish(true) })
    container.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && gesture) { event.preventDefault(); finish(true); return }
      const handle = event.target.closest('[data-launch-drag-handle]')
      if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key) || !ready()) return
      event.preventDefault()
      const current = rows(), row = handle.closest('[data-launch-key]')
      const index = current.indexOf(row), next = index + (event.key === 'ArrowUp' ? -1 : 1)
      if (next < 0 || next >= current.length) return
      moveRows(() => container.insertBefore(row, event.key === 'ArrowUp' ? current[next] : current[next].nextElementSibling))
      void options.onReorder(order())
      options.onFinish()
      handle.focus({ preventScroll: true })
    })
    // 原生图片拖动会抢走 Pointer Events；排序统一由列表的指针捕获处理。
    container.addEventListener('dragstart', (event) => { if (event.target.closest('[data-launch-drag-handle]')) event.preventDefault() })
  }

  globalThis.launcherLaunchList = {
    sortable,
    update(container, markup) {
      const template = document.createElement('template')
      template.innerHTML = markup
      const incoming = [...template.content.children]
      let list = lists.get(container)
      if (!list) {
        list = { rows: new Map(), initialized: false }
        lists.set(container, list)
      }
      const keys = new Set(incoming.map((row) => row.dataset.launchKey))
      const structural = incoming.length !== list.rows.size || incoming.some((row) => !list.rows.has(row.dataset.launchKey))
      const currentKeys = [...container.children].filter((row) => !row.dataset.launchRemoving).map((row) => row.dataset.launchKey)
      const reordered = incoming.some((row, index) => row.dataset.launchKey !== currentKeys[index])
      const animate = (structural || reordered) && list.initialized && !reduced()
        && root.classList.contains('launcher-ready') && container.getClientRects().length > 0
      const before = new Map(), box = container.getBoundingClientRect()
      if (animate) for (const [key, { node }] of list.rows) {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
        before.set(key, {
          top: rect.top, height: rect.height, width: rect.width,
          paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth,
        })
      }

      if (structural || reordered) {
        active.get(container)?.()
        for (const row of [...container.children]) {
          active.get(row)?.()
          // 开场和增删各管一次，不让两套位移动画叠在同一项上。
          row.classList.remove('launcher-preset-enter')
          row.style.removeProperty('--launcher-entry-delay')
        }
      }

      for (const [key, { node }] of list.rows) {
        if (keys.has(key)) continue
        list.rows.delete(key)
        if (!animate) { node.remove(); continue }
        const rect = before.get(key)
        // 删除项暂留在原位置淡出，但退出布局；活着的项目和列表高度独立补位。
        node.dataset.launchRemoving = 'true'
        node.inert = true
        Object.assign(node.style, {
          position: 'absolute', top: `${rect.top - box.top + container.scrollTop}px`, left: '0',
          width: `${rect.width}px`, height: `${rect.height}px`, margin: '0',
          paddingTop: rect.paddingTop, paddingBottom: rect.paddingBottom,
          borderBottomWidth: rect.borderBottomWidth, pointerEvents: 'none',
        })
        play(node, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 180 }, () => node.remove())
      }

      const added = new Set()
      let cursor = container.firstElementChild
      for (const [index, fresh] of incoming.entries()) {
        const key = fresh.dataset.launchKey, html = fresh.innerHTML
        let row = list.rows.get(key)
        if (!row) {
          row = { node: fresh, html }
          list.rows.set(key, row)
          added.add(key)
        } else if (row.html !== html) {
          // 状态只更新这一项的内容，保留其他项目及其焦点和入场进度。
          row.node.innerHTML = html
          row.html = html
        }
        while (cursor?.dataset.launchRemoving === 'true') cursor = cursor.nextElementSibling
        if (row.node !== cursor) container.insertBefore(row.node, cursor)
        else cursor = cursor.nextElementSibling
        if (index === incoming.length - 1) row.node.dataset.launchLast = 'true'
        else delete row.node.dataset.launchLast
      }
      container.dataset.launchCount = String(incoming.length)
      list.initialized = true
      if (!animate) return

      const after = container.getBoundingClientRect()
      for (const [key, { node }] of list.rows) {
        if (added.has(key)) {
          play(node, [{ opacity: 0, transform: 'translateY(20px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 70 })
        } else {
          const rect = node.getBoundingClientRect(), previous = before.get(key)
          // 卡片本身会随高度保持居中，补位只计算列表内部的位移，避免重复抵消居中变化。
          const shift = previous.top - box.top - (rect.top - after.top)
          // 从一项变成多项时 padding 规则会变化，同步过渡，避免卡片高度跳一下。
          if (Math.abs(previous.height - rect.height) > .5) {
            const style = getComputedStyle(node)
            // 行位移和高度放在同一条动画里，避免两个动画相互取消。
            play(node, [
              { height: `${previous.height}px`, paddingTop: previous.paddingTop, paddingBottom: previous.paddingBottom, borderBottomWidth: previous.borderBottomWidth, transform: `translateY(${shift}px)` },
              { height: `${rect.height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth, transform: 'none' },
            ], { duration: 360, delay: 70 })
          } else if (Math.abs(shift) > .5) play(node, [{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 360, delay: 70 })
        }
      }
      // 只过渡高度，不给毛玻璃卡片或它的父层加透明度、缩放，保留即时背景模糊。
      if (Math.abs(box.height - after.height) > .5) {
        play(container, [{ height: `${box.height}px` }, { height: `${after.height}px` }], { duration: 360, delay: 70 })
      }
    },
  }
})()
