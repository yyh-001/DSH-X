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

  globalThis.launcherLaunchList = {
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
      const animate = structural && list.initialized && !reduced()
        && root.classList.contains('launcher-ready') && container.getClientRects().length > 0
      const before = new Map(), box = container.getBoundingClientRect()
      if (animate) for (const [key, { node }] of list.rows) {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
        before.set(key, {
          top: rect.top, height: rect.height, width: rect.width,
          paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth,
        })
      }

      if (structural) {
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
