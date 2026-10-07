(() => {
  let observer = null
  let frame = 0
  let grid = null
  const layout = () => {
    if (!grid?.getClientRects().length) return
    const style = getComputedStyle(grid)
    const row = parseFloat(style.gridAutoRows) || 4
    const gap = parseFloat(style.getPropertyValue('--market-gap')) || 14
    // 用行跨度形成瀑布流，DOM 仍按搜索/排序结果排列，键盘导航不会像 CSS 多栏那样先走完一整列。
    for (const item of grid.querySelectorAll('.market-card, .market-empty')) {
      const span = `span ${Math.ceil((item.offsetHeight + gap) / row)}`
      if (item.style.gridRowEnd !== span) item.style.gridRowEnd = span
    }
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(layout)
  }
  window.launcherMarketLayout = {
    refresh(element) {
      if (!element) return
      grid = element
      cancelAnimationFrame(frame)
      observer?.disconnect()
      // 渲染后立即测量，避免首帧卡片互相盖住；字体、窗口宽度和详情展开再通过观察器更新。
      layout()
      observer ||= new ResizeObserver(schedule)
      observer.observe(grid)
      for (const item of grid.querySelectorAll('.market-card, .market-empty')) observer.observe(item)
    },
  }
})()
