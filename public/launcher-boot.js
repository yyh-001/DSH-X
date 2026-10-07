(() => {
  const root = document.documentElement
  const screen = document.getElementById('launcherBoot')
  if (!screen) return
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const pending = new Set(['document', 'state', 'settings'])
  let finished = false, leaving = false, exitTimer, entryTimer, watchdog, observer
  let entryRows = []
  const reduced = () => motion.matches || root.dataset.reduceMotion === 'true'
  const status = document.getElementById('launcherBootStatus')
  if (root.dataset.lang === 'en') status.textContent = 'Loading console…'

  function finish(animate) {
    if (finished) return
    finished = true
    clearTimeout(watchdog)
    clearTimeout(exitTimer)
    observer?.disconnect()
    motion.removeEventListener('change', onMotionChange)
    screen.hidden = true
    root.classList.remove('launcher-loading')
    root.classList.add('launcher-ready')
    if (animate && !reduced()) {
      // 固定这次入场的节点；后续刷新状态或添加启动项不重播开场。
      entryRows = [...document.querySelectorAll('#launchPresets .launch-preset')]
      entryRows.forEach((row, index) => {
        row.style.setProperty('--launcher-entry-delay', `${index * 100}ms`)
        row.classList.add('launcher-preset-enter')
      })
      root.classList.add('launcher-entering')
      // 按实际项数等待最后一项完成，长列表也保持逐项入场、不被中途截断。
      entryTimer = setTimeout(() => {
        clearEntry()
        motion.removeEventListener('change', stopEntry)
        observer?.disconnect()
      }, Math.max(1150, 600 + (entryRows.length - 1) * 100))
      // 设置或系统在入场途中切到减少动画，也立即停止位移。
      motion.addEventListener('change', stopEntry)
      observer?.observe(root, { attributes: true, attributeFilter: ['data-reduce-motion'] })
    }
  }

  function clearEntry() {
    root.classList.remove('launcher-entering')
    for (const row of entryRows) {
      row.classList.remove('launcher-preset-enter')
      row.style.removeProperty('--launcher-entry-delay')
    }
    entryRows = []
  }

  function stopEntry() {
    if (!reduced()) return
    clearTimeout(entryTimer)
    clearEntry()
    motion.removeEventListener('change', stopEntry)
    observer?.disconnect()
  }

  function onMotionChange() {
    if (reduced()) finish(false)
    stopEntry()
  }

  function leave() {
    if (finished || leaving) return
    leaving = true
    if (reduced()) return finish(false)
    screen.classList.add('is-leaving')
    exitTimer = setTimeout(() => finish(true), 300)
  }

  // 只等首页的本地状态和设置，不把版本查询、更新检查等外网请求算进开场。
  globalThis.launcherBoot = {
    markReady(part) {
      pending.delete(part)
      if (!pending.size) leave()
    },
  }
  if (reduced()) {
    finish(false)
    return
  }
  root.classList.add('launcher-loading')
  screen.hidden = false
  motion.addEventListener('change', onMotionChange)
  observer = new MutationObserver(onMotionChange)
  observer.observe(root, { attributes: true, attributeFilter: ['data-reduce-motion'] })
  document.addEventListener('DOMContentLoaded', () => globalThis.launcherBoot.markReady('document'), { once: true })
  // 请求或主脚本异常不能让装饰性开场遮住控制台；原有错误提示仍由页面负责。
  watchdog = setTimeout(() => finish(false), 6000)
})()
