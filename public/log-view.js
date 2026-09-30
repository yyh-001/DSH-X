(() => {
  // 页面只保留最近的日志；完整记录仍从后端导出，长时间挂着不会让 DOM 无限增长。
  const LIMIT = 400
  const LINE_LIMIT = 4000
  window.createLogView = (node) => {
    let lines = []
    let timer = null
    function flush() {
      timer = null
      const follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24
      node.textContent = lines.join('\n')
      if (follow) node.scrollTop = node.scrollHeight
    }
    return {
      append(batch) {
        for (const value of batch) {
          const text = String(value ?? '')
          lines.push(text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text)
        }
        if (lines.length > LIMIT) lines.splice(0, lines.length - LIMIT)
        // 安装期间会一口气收到很多行，合成一次更新；用户向上翻时不强行拉回底部。
        if (timer === null) timer = setTimeout(flush, 80)
      },
      clear() {
        if (timer !== null) clearTimeout(timer)
        timer = null
        lines = []
        node.textContent = ''
      },
    }
  }
})()
