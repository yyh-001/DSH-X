/**
 * dsh-x-computer-use 客户端面板：在 dsh 插件详情页解释启用状态与原因（未启用 / 非 DSH-X 启动 / 已就绪）。
 * 授权卡片、全局权限页与系统提示仍复用 `@deepseek-ai/dsh-cua` 原生 UI。
 */
window.__ModuleLoader__.load({
  id: 'dsh-x-computer-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function ComputerUseStatusCard() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const res = await fetch('/dsh-x-computer-use/status', { credentials: 'same-origin' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setStatus(await res.json())
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const reasonLabel = (data) => {
        if (!data) return '正在读取 DSH-X 电脑操作状态…'
        if (data.live?.halted) return '已在 DSH-X 中紧急停止：请到 DSH-X 托盘或设置页点击「恢复可用」。'
        switch (data.reason) {
          case 'ok':
            return '已就绪：工具通过 DSH-X 桌面外壳执行，首次操作应用前会在会话中弹出授权卡片。'
          case 'disabled':
            return '当前默认关闭：未向模型暴露电脑操作工具。请在 DSH-X 管理器「设置 → 常规 → 电脑操作」开启并重启本实例。'
          case 'no-desktop':
            return '当前不是由 DSH-X 桌面外壳启动的实例，电脑操作已静默停用（不向模型暴露工具）。'
          case 'unsupported':
            return '当前 DSH-X 外壳版本不支持电脑操作，请更新 DSH-X。'
          case 'slot-occupied':
            return `电脑操作槽位已被其他提供者（${data.provider || 'unknown'}）占用，本插件已主动禁用。`
          default:
            return data.detail || '当前不可用。'
        }
      }

      return h(
        'div',
        {
          style: {
            border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.25))',
            borderRadius: '10px',
            padding: '14px 16px',
            display: 'grid',
            gap: '8px',
            fontSize: '13px',
            lineHeight: '1.6',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('strong', null, 'DSH-X 电脑操作（Computer Use）'),
          h('button', {
            type: 'button',
            onClick: () => { void refresh() },
            style: {
              padding: '3px 10px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            },
          }, '刷新')),
        error
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #e5484d)' } }, `状态读取失败：${error}`)
          : h('div', null, reasonLabel(status)),
        status?.live?.shortcut
          ? h('div', { style: { opacity: 0.75, fontSize: '12px' } }, `全局急停快捷键：${status.live.shortcut}（或在 DSH-X 托盘 / 设置页停止）`)
          : null,
        h('div', { style: { opacity: 0.75, fontSize: '12px' } },
          '边界提示：Windows 下不能操作以管理员身份运行的窗口（UIPI），UAC 安全桌面与锁屏界面不可操作；输入正文绝不写入审计日志。'),
      )
    }

    function apply(ctx) {
      ctx.inject(['slots'], (scope) => {
        for (const key of ['dsh-x-computer-use', 'dsh-x-desktop-bundle']) {
          scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
            name: 'plugins.bundle.config',
            key,
          }, ComputerUseStatusCard))
        }
      })
    }

    return { inject: [], apply }
  },
})
