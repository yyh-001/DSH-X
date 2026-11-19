/**
 * 启动器统一动效原语：收口时长、缓动曲线与「减少动态」检测。
 * 供启动脚本、列表排序、标签栏与内联业务共用；各模块也会在单独测试时兜底。
 */
(() => {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

  const duration = Object.freeze({
    // 与 launcher.css 的 --motion-* 五档基础刻度对齐，再为特定手势保留语义别名
    instant: 120,
    fast: 150,
    base: 220,
    slow: 280,
    enter: 460,
    paneExit: 90,
    paneEnter: 260,
    dialogOpen: 220,
    dialogClose: 170,
    disclosure: 220,
    tabGlide: 220,
    tabEnter: 180,
    listAdd: 420,
    listShift: 360,
    listRemove: 180,
    listDelay: 70,
    sortLift: 160,
    sortSettle: 200,
    bootOut: 300,
    bootStagger: 100,
  })

  const ease = Object.freeze({
    standard: 'cubic-bezier(.2, .8, .2, 1)',
    decelerate: 'cubic-bezier(.22, 1, .36, 1)',
    accelerate: 'cubic-bezier(.4, 0, 1, 1)',
    spring: 'cubic-bezier(.2, 1.3, .32, 1)',
  })

  // 同时认系统媒体查询、应用内类名与 data 属性，避免开场期只有 dataset 时漏判
  const reduced = () => Boolean(
    media?.matches
    || root?.classList?.contains?.('reduce-motion')
    || root?.dataset?.reduceMotion === 'true',
  )

  const listeners = new Set()
  let observer = null
  const notify = () => {
    const state = reduced()
    for (const listener of [...listeners]) listener(state)
  }

  function attach() {
    media?.addEventListener?.('change', notify)
    if (typeof MutationObserver === 'function' && root && !observer) {
      observer = new MutationObserver(notify)
      observer.observe(root, { attributes: true, attributeFilter: ['data-reduce-motion', 'class'] })
    }
  }

  function detach() {
    media?.removeEventListener?.('change', notify)
    observer?.disconnect()
    observer = null
  }

  function onReduceChange(listener) {
    if (typeof listener !== 'function') return () => {}
    if (!listeners.size) attach()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) detach()
    }
  }

  function animate(node, frames, options = {}) {
    if (!node || reduced() || typeof node.animate !== 'function') return null
    return node.animate(frames, { duration: duration.base, easing: ease.standard, ...options })
  }

  globalThis.launcherMotion = Object.freeze({
    duration,
    ease,
    reduced,
    onReduceChange,
    animate,
  })
})()
