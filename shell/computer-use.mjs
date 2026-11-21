/**
 * 电脑操作（Computer Use）的外壳侧执行宿主与急停开关。
 *
 * 为什么放在外壳（Electron 主进程）而不是 dsh 子进程：
 * 1. Windows UIPI / macOS TCC 权限都跟「真正注入输入和抓屏的进程」走。由外壳托管驱动，
 *    系统里授权主体是 DSH-X 自身，而不是某个临时拉起的 node.exe；
 * 2. 急停开关（全局快捷键、托盘菜单、管理页按钮）必须独立于模型/dsh 子进程：即使 dsh 卡死，
 *    外壳也能在 1 秒内中断在途操作、销毁句柄并拒绝后续输入；
 * 3. 审计日志留在外壳内存（绝不记录输入正文），用户随时可查、可停、可清空。
 *
 * 不直接 import 核心（src/）也不顶层 import electron / @trycua/cua-driver：
 * 外壳与核心拆包独立更新，单测也通过注入假 driver 在纯 Node 里覆盖全部协议与急停路径。
 */
import { createHash, randomUUID } from 'node:crypto'

// Windows 上 Ctrl+Shift+Esc 被任务管理器内核保留无法注册；用 Ctrl/Cmd+Alt+Backspace 当跨平台急停键。
export const COMPUTER_USE_SHORTCUT = process.platform === 'darwin'
  ? 'Command+Option+Backspace'
  : 'Control+Alt+Backspace'

const MAX_AUDIT_ENTRIES = 200
const MAX_SNAPSHOTS = 32
const SHUTDOWN_WAIT_MS = 400

/** 供测试与插件对照的能力错误码。 */
export class ComputerUseError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ComputerUseError'
    this.code = code
  }
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function finiteNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function parseJsonSafe(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

/**
 * 从 `@trycua/cua-driver` 的 `ToolResult` 里拆出可读错误并映射到 `dsh-cua` 错误码。
 * 模型依赖这些错误码决定能不能观察后重试（比如 `SESSION_LOCKED` / `ELEMENT_UNAVAILABLE`
 * / `ELEVATED_WINDOW_BLOCKED` / `FOREGROUND_REQUIRED`）。
 */
export function mapDriverFailure(rawResult, fallbackMessage = '桌面操作失败') {
  const structured = rawResult?.structuredContent && typeof rawResult.structuredContent === 'object'
    ? rawResult.structuredContent
    : {}
  const refusal = structured.refusal && typeof structured.refusal === 'object'
    ? structured.refusal
    : (structured.error && typeof structured.error === 'object' ? structured.error : {})
  const textParts = Array.isArray(rawResult?.content)
    ? rawResult.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text)
    : []
  const rawCode = String(refusal.code || structured.code || '').toLowerCase()
  const message = String(refusal.message || textParts.join('\n') || structured.hint || fallbackMessage).trim()
  const lower = `${rawCode} ${message}`.toLowerCase()

  if (lower.includes('session_locked') || lower.includes('workstation is locked') || lower.includes('screen_locked')) {
    return new ComputerUseError('SESSION_LOCKED', '桌面会话已锁定，请解锁后再试')
  }
  if (lower.includes('background_unavailable') || lower.includes('foreground_required')) {
    return new ComputerUseError('FOREGROUND_REQUIRED', message || '目标窗口不支持后台输入，需要先激活到前台并重新观察')
  }
  if (lower.includes('elevated') || lower.includes('uipi') || lower.includes('access is denied') || lower.includes('0x80070005')) {
    return new ComputerUseError('ELEVATED_WINDOW_BLOCKED', '无法操作以管理员身份运行的窗口（受 Windows UIPI 限制；DSH-X 默认不提权）')
  }
  if (lower.includes('stale_snapshot') || lower.includes('expired snapshot') || lower.includes('unknown snapshot')) {
    return new ComputerUseError('STALE_SNAPSHOT', message || '当前窗口快照已失效，请重新获取状态')
  }
  if (lower.includes('element_unavailable') || lower.includes('element not found') || lower.includes('unknown element')) {
    return new ComputerUseError('ELEMENT_UNAVAILABLE', message || '目标元素在最新观察中已不可用，请重新读取界面状态')
  }
  if (lower.includes('window_changed') || lower.includes('window closed') || lower.includes('window_not_found')) {
    return new ComputerUseError('WINDOW_CHANGED', message || '目标窗口已变化或关闭，请重新列举并观察窗口')
  }
  if (lower.includes('permission') || lower.includes('not permitted') || lower.includes('tcc')) {
    return new ComputerUseError('PERMISSION_DENIED', message || '缺少所需的系统桌面权限')
  }
  return new ComputerUseError(rawCode ? rawCode.toUpperCase() : 'NATIVE_FAILED', message || fallbackMessage)
}

/** 审计摘要：绝不记录输入正文、剪贴板正文或按键字符，只保留动作类型和长度等元数据。 */
export function summarizeAuditDetail(method, params = {}) {
  switch (method) {
    case 'typeText':
      return `len=${String(params.text ?? '').length}`
    case 'paste':
      return `format=${params.format || 'text'},len=${String(params.text ?? '').length}`
    case 'setValue':
      return `element=${String(params.elementId ?? '')},type=${typeof params.value}`
    case 'pressKey':
    case 'sendKeyEvent':
      return Array.isArray(params.modifiers) && params.modifiers.length ? 'combo' : 'key'
    case 'click':
    case 'mouseMove':
      return params.elementId ? `element=${params.elementId}` : `point=(${finiteNumber(params.x)},${finiteNumber(params.y)})`
    case 'scroll':
      return `dx=${finiteNumber(params.deltaLinesX)},dy=${finiteNumber(params.deltaLinesY)}`
    case 'drag':
      return `(${finiteNumber(params.fromX)},${finiteNumber(params.fromY)})->(${finiteNumber(params.toX)},${finiteNumber(params.toY)})`
    case 'getApp':
      return `selector=${String(params.selector ?? '').slice(0, 80)}`
    case 'getState':
    case 'screenshot':
    case 'listWindows':
      return params.windowId ? `window=${params.windowId}` : ''
    default:
      return ''
  }
}

/**
 * 创建外壳侧 Computer Use 控制器。
 * @param {object} [options]
 * @param {() => Promise<any>} [options.loadDriver] - 懒加载 `@trycua/cua-driver`，默认动态 import。
 * @param {(path: string) => Promise<string>} [options.getFileIcon] - 取应用 PNG data URL（Electron `app.getFileIcon`）。
 * @param {() => void} [options.onStateChanged] - 状态变化回调（刷新托盘菜单、全局快捷键、SSE）。
 * @param {string} [options.platform] - 平台标识，默认 `process.platform`。
 * @param {number} [options.pid] - 外壳进程 PID。
 * @param {string} [options.execPath] - 外壳可执行文件路径。
 */
export function createComputerUseHost(options = {}) {
  const platform = options.platform || process.platform
  const helperPid = Number(options.pid || process.pid) || 1
  const helperPath = String(options.execPath || process.execPath || '')
  const loadDriver = options.loadDriver || (() => import('@trycua/cua-driver'))
  const getFileIcon = options.getFileIcon || (async () => '')
  const onStateChanged = typeof options.onStateChanged === 'function' ? options.onStateChanged : () => {}

  let enabled = false
  let halted = false
  let stopReason = ''
  let driver = null
  let driverInit = null
  let driverAvailable = null
  let driverError = ''
  let currentApp = ''
  let currentInstance = ''
  let lastAction = ''
  let lastActionAt = 0
  let generation = 0

  const activeOps = new Map()
  const apps = new Map()
  const snapshots = new Map()
  const audit = []

  function recordAudit({ instance = '', app = '', action = '', detail = '', result = 'ok', errorCode = '', durationMs = 0 }) {
    audit.push({
      id: randomUUID(),
      time: new Date().toISOString(),
      instance: String(instance || currentInstance || ''),
      app: String(app || currentApp || ''),
      action: String(action || ''),
      detail: String(detail || ''),
      result: String(result || 'ok'),
      errorCode: String(errorCode || ''),
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    })
    if (audit.length > MAX_AUDIT_ENTRIES) audit.splice(0, audit.length - MAX_AUDIT_ENTRIES)
  }

  function status() {
    return {
      available: true,
      enabled,
      halted,
      running: activeOps.size > 0,
      activeCount: activeOps.size,
      driverAvailable,
      driverError,
      platform,
      shortcut: COMPUTER_USE_SHORTCUT,
      currentApp,
      currentInstance,
      lastAction,
      lastActionAt,
      stopReason,
    }
  }

  async function destroyDriver() {
    const active = driver
    const pendingInit = driverInit
    driver = null
    driverInit = null
    if (!active && pendingInit) {
      try {
        const created = await Promise.race([
          pendingInit.catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), SHUTDOWN_WAIT_MS)),
        ])
        if (created && typeof created.shutdown === 'function') {
          await Promise.race([
            created.shutdown().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
          ])
        }
        created?.uniffiDestroy?.()
      } catch { /* 急停时忽略关闭异常 */ }
      return
    }
    if (!active) return
    try {
      if (typeof active.shutdown === 'function') {
        await Promise.race([
          active.shutdown().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
        ])
      }
      active.uniffiDestroy?.()
    } catch { /* ignore */ }
  }

  async function ensureDriver() {
    if (driver) return driver
    if (driverInit) return driverInit
    const epoch = generation
    const pending = (async () => {
      try {
        const mod = await loadDriver()
        if (epoch !== generation || !enabled || halted) {
          throw new ComputerUseError('COMPUTER_USE_STOPPED', '电脑操作已被停止')
        }
        const CuaDriver = mod?.CuaDriver
        if (!CuaDriver || typeof CuaDriver.create !== 'function') {
          throw new Error('缺少 CuaDriver.create 导出')
        }
        const instance = CuaDriver.create(undefined)
        if (epoch !== generation || !enabled || halted) {
          await instance.shutdown?.().catch(() => {})
          instance.uniffiDestroy?.()
          throw new ComputerUseError('COMPUTER_USE_STOPPED', '电脑操作已被停止')
        }
        driver = instance
        driverAvailable = true
        driverError = ''
        return instance
      } catch (error) {
        if (error instanceof ComputerUseError) throw error
        const message = error instanceof Error ? error.message : String(error)
        driverAvailable = false
        driverError = message
        throw new ComputerUseError('DRIVER_UNAVAILABLE', `桌面操作驱动不可用：${message}`)
      } finally {
        // 避免 stop() 后新一轮 ensureDriver() 的 promise 被上一轮的 finally 覆盖清空
        if (driverInit === pending) driverInit = null
      }
    })()
    driverInit = pending
    return pending
  }

  async function callDriverTool(activeDriver, toolName, args, signal) {
    if (signal?.aborted) throw new ComputerUseError('NATIVE_CANCELLED', '操作已取消')
    if (halted || !enabled) throw new ComputerUseError('COMPUTER_USE_STOPPED', '电脑操作已被停止')
    const raw = await activeDriver.callTool(toolName, JSON.stringify(args ?? {}), signal ? { signal } : undefined)
    if (signal?.aborted) throw new ComputerUseError('NATIVE_CANCELLED', '操作已取消')
    if (halted || !enabled) throw new ComputerUseError('COMPUTER_USE_STOPPED', '电脑操作已被停止')
    const parsed = parseJsonSafe(raw?.rawJson ?? raw)
    if (!parsed) throw new ComputerUseError('NATIVE_PROTOCOL', `驱动返回了无法解析的结果（${toolName}）`)
    if (parsed.isError) throw mapDriverFailure(parsed, `${toolName} 执行失败`)
    return parsed
  }

  // cua-driver 强制先按 background 派发输入，遇到 Chromium/Electron/GTK 会返回
  // background_unavailable 要求改用 delivery_mode: 'foreground'；因为 dsh-cua
  // 协议不允许模型直接传 delivery_mode，这里由外壳按驱动语义自动升级一次。
  async function callInputTool(activeDriver, toolName, args, signal) {
    try {
      return await callDriverTool(activeDriver, toolName, args, signal)
    } catch (error) {
      if (error?.code === 'FOREGROUND_REQUIRED' && args?.delivery_mode !== 'foreground') {
        return callDriverTool(activeDriver, toolName, { ...args, delivery_mode: 'foreground' }, signal)
      }
      throw error
    }
  }

  async function stop(reason = 'user') {
    const wasRunning = activeOps.size > 0 || driver !== null || halted
    generation += 1
    halted = true
    stopReason = String(reason || 'user')
    for (const op of activeOps.values()) {
      try { op.controller.abort(new ComputerUseError('COMPUTER_USE_STOPPED', '电脑操作已被用户停止')) } catch { /* ignore */ }
    }
    activeOps.clear()
    apps.clear()
    snapshots.clear()
    await destroyDriver()
    if (wasRunning || enabled) {
      recordAudit({ action: 'stop', detail: stopReason, result: 'stopped' })
    }
    onStateChanged()
    return status()
  }

  function resume() {
    if (!enabled) throw new ComputerUseError('COMPUTER_USE_DISABLED', '请先在设置中启用「电脑操作」')
    halted = false
    stopReason = ''
    recordAudit({ action: 'resume', result: 'ok' })
    onStateChanged()
    return status()
  }

  function setEnabled(next) {
    const flag = next === true
    if (flag === enabled) return status()
    enabled = flag
    if (!flag) {
      void stop('disabled')
      return status()
    }
    // 从关切到开时清掉旧急停标记，用户新开即处于就绪状态
    halted = false
    stopReason = ''
    onStateChanged()
    return status()
  }

  function matchesSession(session, key) {
    if (!key) return true
    return session === key || session.startsWith(`${key}:`)
  }

  function closeSession(sessionId) {
    const key = String(sessionId || '')
    for (const [opKey, op] of activeOps) {
      if (matchesSession(op.sessionId, key)) {
        try { op.controller.abort(new ComputerUseError('NATIVE_CLOSED', '会话已关闭')) } catch { /* ignore */ }
        activeOps.delete(opKey)
      }
    }
    for (const [handle, entry] of apps) {
      if (matchesSession(entry.sessionId, key)) apps.delete(handle)
    }
    for (const [snapId, snap] of snapshots) {
      if (matchesSession(snap.sessionId, key)) snapshots.delete(snapId)
    }
    onStateChanged()
    return { ok: true }
  }

  function cancel({ sessionId = '', id = '' } = {}) {
    const opKey = `${sessionId}:${id}`
    const op = activeOps.get(opKey)
    if (op) {
      try { op.controller.abort(new ComputerUseError('NATIVE_CANCELLED', '操作已取消')) } catch { /* ignore */ }
      return { ok: true, cancelled: true }
    }
    // 兼容未带 sessionId 的取消匹配
    for (const [candidateKey, candidate] of activeOps) {
      if (candidate.id === id) {
        try { candidate.controller.abort(new ComputerUseError('NATIVE_CANCELLED', '操作已取消')) } catch { /* ignore */ }
        return { ok: true, cancelled: true }
      }
      void candidateKey
    }
    return { ok: true, cancelled: false }
  }

  function requireApp(appHandle) {
    const entry = apps.get(String(appHandle || ''))
    if (!entry) {
      throw new ComputerUseError('APP_ACCESS_REQUIRED', '请先调用 getApp 选择并授权目标应用')
    }
    return entry
  }

  function rememberSnapshot(record) {
    snapshots.set(record.snapshotId, record)
    while (snapshots.size > MAX_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value
      if (oldest === undefined) break
      snapshots.delete(oldest)
    }
  }

  function resolveSnapshotElement(params) {
    const snap = snapshots.get(String(params.snapshotId || ''))
    if (!snap || snap.appHandle !== params.appHandle) {
      throw new ComputerUseError('STALE_SNAPSHOT', '当前界面快照已失效，请重新调用 getAccessibilityTree 获取最新状态')
    }
    if (params.windowId !== undefined && Number(params.windowId) !== snap.windowId) {
      throw new ComputerUseError('WINDOW_CHANGED', '快照所属窗口与当前操作窗口不一致，请重新观察')
    }
    const rawElement = String(params.elementId || '').trim()
    if (!rawElement) throw new ComputerUseError('ELEMENT_UNAVAILABLE', '缺少有效的元素编号')
    // cua-driver 的 element_token 形如 `<snapshot_id>:<row>`；树里通常印成 `[12]` 或 `s00000001:12`
    const normalized = rawElement.replace(/^\[|\]$/g, '')
    const token = normalized.includes(':')
      ? normalized
      : (snap.cuaSnapshotId ? `${snap.cuaSnapshotId}:${normalized}` : normalized)
    return { snap, token }
  }

  function collectAppsFromPayload(structured) {
    const rawApps = Array.isArray(structured?.apps) ? structured.apps : []
    const rawProcs = Array.isArray(structured?.processes) ? structured.processes : []
    const byPid = new Map()
    const installed = []
    for (const item of [...rawApps, ...rawProcs]) {
      const pid = Number(item?.pid) || 0
      const name = String(item?.name || '').trim()
      if (!name) continue
      const bundleId = typeof item?.bundle_id === 'string' && item.bundle_id
        ? item.bundle_id
        : (typeof item?.bundleId === 'string' && item.bundleId ? item.bundleId : undefined)
      const launchPath = typeof item?.launch_path === 'string' && item.launch_path
        ? item.launch_path
        : (typeof item?.launchPath === 'string' && item.launchPath ? item.launchPath : (typeof item?.path === 'string' ? item.path : undefined))
      const running = Boolean(item?.running) || pid > 0
      const record = { pid, name, bundleId, launchPath, running }
      if (running && pid > 0) {
        const prev = byPid.get(pid)
        if (!prev || (!prev.launchPath && launchPath) || (!prev.bundleId && bundleId)) {
          byPid.set(pid, record)
        }
      } else {
        installed.push(record)
      }
    }
    return { running: [...byPid.values()], installed }
  }

  async function resolveWindowsForApp(activeDriver, app, signal) {
    const query = app.pid > 0 ? { pid: app.pid } : { app: app.name }
    const parsed = await callDriverTool(activeDriver, 'list_windows', query, signal)
    const raw = Array.isArray(parsed?.structuredContent?.windows) ? parsed.structuredContent.windows : []
    return raw
      .filter((w) => Number.isInteger(Number(w?.window_id ?? w?.windowId)) && Number(w?.window_id ?? w?.windowId) > 0)
      .map((w) => {
        const b = w.bounds || {}
        return {
          windowId: Number(w.window_id ?? w.windowId),
          appName: String(w.app_name || w.appName || app.name),
          title: String(w.title || ''),
          bounds: {
            x: finiteNumber(b.x),
            y: finiteNumber(b.y),
            width: Math.max(0, finiteNumber(b.width)),
            height: Math.max(0, finiteNumber(b.height)),
          },
          isOnScreen: Boolean(w.is_on_screen ?? w.isOnScreen ?? true),
          onCurrentSpace: null,
        }
      })
  }

  async function resolveCoordinates(activeDriver, app, params, signal) {
    const windowId = Number(params.windowId)
    const x = finiteNumber(params.x)
    const y = finiteNumber(params.y)
    if (params.relative !== true) return { windowId, x, y, targetWindow: null }
    const windows = await resolveWindowsForApp(activeDriver, app, signal)
    const target = windows.find((w) => w.windowId === windowId)
    if (!target) throw new ComputerUseError('WINDOW_CHANGED', `窗口 ${windowId} 已关闭或不可见`)
    return {
      windowId,
      x: Math.round((target.bounds.width * x) / 1000),
      y: Math.round((target.bounds.height * y) / 1000),
      targetWindow: target,
    }
  }

  function mapModifiers(modifiers) {
    if (!Array.isArray(modifiers) || !modifiers.length) return []
    const superKey = platform === 'darwin' ? 'cmd' : 'win'
    const table = {
      command: superKey,
      cmd: superKey,
      control: 'ctrl',
      option: 'alt',
      shift: 'shift',
      ctrl: 'ctrl',
      alt: 'alt',
      win: 'win',
      meta: superKey,
    }
    return modifiers.map((item) => table[String(item).toLowerCase()] || String(item).toLowerCase()).filter(Boolean)
  }

  async function executeMethod(activeDriver, method, params, sessionId, signal) {
    switch (method) {
      case 'permissionStatus': {
        const [permRaw, healthRaw] = await Promise.all([
          callDriverTool(activeDriver, 'check_permissions', { prompt: false }, signal).catch(() => null),
          callDriverTool(activeDriver, 'health_report', {}, signal).catch(() => null),
        ])
        const perm = permRaw?.structuredContent || {}
        const checks = Array.isArray(healthRaw?.structuredContent?.checks) ? healthRaw.structuredContent.checks : []
        const captureCheck = checks.find((item) => item?.name === 'screen_capture_capability')
        const captureAvailable = captureCheck ? captureCheck.status === 'pass' : true
        if (platform === 'darwin') {
          return {
            platform: 'darwin',
            accessibility: Boolean(perm.accessibility),
            screenRecording: Boolean(perm.screen_recording ?? perm.screenRecording),
            helper: { pid: helperPid, path: helperPath, name: 'DSH-X' },
            parent: { pid: helperPid, path: helperPath, name: 'DSH-X' },
          }
        }
        return {
          platform: 'win32',
          sessionLocked: perm.session_locked ?? (captureAvailable ? false : null),
          captureAvailable,
          elevated: Boolean(perm.elevated),
          helper: { pid: helperPid, path: helperPath, name: 'DSH-X' },
        }
      }

      case 'getCapabilities': {
        const perm = await executeMethod(activeDriver, 'permissionStatus', {}, sessionId, signal)
        return {
          permissions: platform === 'darwin'
            ? { accessibility: Boolean(perm.accessibility), screenRecording: Boolean(perm.screenRecording) }
            : { accessibility: true, screenRecording: Boolean(perm.captureAvailable) },
          sessionLocked: perm.sessionLocked ?? false,
        }
      }

      case 'listApps': {
        const parsed = await callDriverTool(activeDriver, 'list_apps', {}, signal)
        const { running } = collectAppsFromPayload(parsed.structuredContent)
        return running.map((item) => ({
          pid: item.pid,
          name: item.name,
          ...(item.bundleId ? { bundleId: item.bundleId } : {}),
        }))
      }

      case 'findApps': {
        const query = String(params.query || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(1000, Number(params.maxAppMatches) || 20))
        const parsed = await callDriverTool(activeDriver, 'list_apps', {}, signal)
        const { running, installed } = collectAppsFromPayload(parsed.structuredContent)
        const matched = []
        for (const item of [...running, ...installed]) {
          const hay = [item.name, item.bundleId || '', item.launchPath || ''].join(' ').toLowerCase()
          if (!hay.includes(query)) continue
          const id = item.bundleId || item.launchPath || `${item.name}:${item.pid}`
          const path = item.launchPath || item.bundleId || item.name
          if (item.running && item.pid > 0) {
            matched.push({ id, displayName: item.name, path, isRunning: true, pid: item.pid })
          } else {
            matched.push({ id, displayName: item.name, path, isRunning: false })
          }
          if (matched.length >= limit) break
        }
        return matched
      }

      case 'getApp': {
        const selector = String(params.selector || '').trim()
        if (!selector) throw new ComputerUseError('APP_NOT_FOUND', '应用标识不能为空')
        const parsed = await callDriverTool(activeDriver, 'list_apps', {}, signal)
        const { running, installed } = collectAppsFromPayload(parsed.structuredContent)
        const all = [...running, ...installed]
        const lower = selector.toLowerCase()
        const numericPid = /^\d+$/.test(selector) ? Number(selector) : 0

        let candidates = []
        if (numericPid > 0) {
          candidates = running.filter((item) => item.pid === numericPid)
        }
        if (!candidates.length) {
          candidates = all.filter((item) =>
            item.name.toLowerCase() === lower
            || (item.bundleId && item.bundleId.toLowerCase() === lower)
            || (item.launchPath && item.launchPath.toLowerCase() === lower))
        }
        if (!candidates.length) {
          // ZCode 约定：精确匹配不上时，仅在运行中应用里做唯一子串匹配；歧义直接报错
          candidates = running.filter((item) => item.name.toLowerCase().includes(lower))
        }
        if (!candidates.length) {
          throw new ComputerUseError('APP_NOT_FOUND', `未找到应用「${selector}」，请先调用 listApps() 确认实际应用名称`)
        }
        // 运行中且同一应用名的不同进程只认唯一应用；若对应不同程序名则报错
        const distinctNames = new Set(candidates.map((item) => item.bundleId || item.launchPath || item.name.toLowerCase()))
        if (distinctNames.size > 1) {
          throw new ComputerUseError('AMBIGUOUS_APP', `应用标识「${selector}」匹配到多个不同应用，请传精确名称或 PID`)
        }
        const chosen = candidates.find((item) => item.running && item.pid > 0) || candidates[0]
        const appHandle = randomUUID()
        const executablePath = chosen.launchPath && /^([a-zA-Z]:[\\/]|\/)/.test(chosen.launchPath)
          ? chosen.launchPath
          : undefined
        const identityKey = chosen.bundleId || executablePath || chosen.launchPath || chosen.name.toLowerCase()
        const authId = sha256Hex(identityKey)
        const persistable = Boolean(chosen.bundleId || chosen.launchPath)
        let applicationIcon
        if (executablePath) {
          const icon = await getFileIcon(executablePath).catch(() => '')
          if (typeof icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon) && icon.length <= 65536) {
            applicationIcon = icon
          }
        }
        apps.set(appHandle, {
          appHandle,
          sessionId,
          pid: chosen.pid,
          name: chosen.name,
          bundleId: chosen.bundleId,
          launchPath: chosen.launchPath,
          executablePath,
          idHash: authId,
          running: chosen.running && chosen.pid > 0,
        })
        // 限制已绑定句柄上限，防止长时间运行的会话持续积累泄漏内存
        while (apps.size > 64) {
          const oldest = apps.keys().next().value
          if (oldest === appHandle) break
          apps.delete(oldest)
        }
        currentApp = chosen.name
        return {
          appHandle,
          name: chosen.name,
          ...(chosen.bundleId ? { bundleId: chosen.bundleId } : {}),
          running: chosen.running && chosen.pid > 0,
          authorization: {
            id: authId,
            name: chosen.name,
            ...(executablePath ? { executablePath } : {}),
            persistable,
          },
          ...(applicationIcon ? { applicationIcon } : {}),
        }
      }

      case 'launchApp': {
        const app = requireApp(params.appHandle)
        const launchArgs = app.launchPath
          ? { launch_path: app.launchPath, start_minimized: false }
          : app.bundleId
            ? { bundle_id: app.bundleId }
            : { name: app.name }
        const parsed = await callDriverTool(activeDriver, 'launch_app', launchArgs, signal)
        const launchedPid = Number(parsed?.structuredContent?.pid) || app.pid || 0
        if (launchedPid > 0) app.pid = launchedPid
        app.running = true
        currentApp = app.name
        return {
          appHandle: app.appHandle,
          name: app.name,
          ...(app.bundleId ? { bundleId: app.bundleId } : {}),
          running: true,
        }
      }

      case 'applicationIcons': {
        const paths = Array.isArray(params.paths) ? params.paths : []
        const out = {}
        for (const p of paths) {
          if (typeof p !== 'string' || !p) continue
          const icon = await getFileIcon(p).catch(() => '')
          if (typeof icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon) && icon.length <= 65536) {
            out[p] = icon
          }
        }
        return out
      }

      case 'listWindows': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        return resolveWindowsForApp(activeDriver, app, signal)
      }

      case 'activate': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        if (app.pid > 0) {
          await callDriverTool(activeDriver, 'bring_to_front', { pid: app.pid }, signal)
        }
        return { dispatched: true }
      }

      case 'show': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const windows = await resolveWindowsForApp(activeDriver, app, signal)
        const targetId = params.windowId ?? windows[0]?.windowId ?? null
        if (app.pid > 0 && targetId) {
          await callDriverTool(activeDriver, 'bring_to_front', { pid: app.pid, window_id: targetId }, signal)
        }
        return { dispatched: Boolean(targetId), windowId: targetId, foregroundChanged: null }
      }

      case 'getState': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const windows = await resolveWindowsForApp(activeDriver, app, signal)
        const windowId = params.windowId ?? windows[0]?.windowId ?? null
        if (!windowId) {
          throw new ComputerUseError('WINDOW_CHANGED', `应用「${app.name}」当前没有可见窗口`)
        }
        const parsed = await callDriverTool(activeDriver, 'get_window_state', {
          pid: app.pid,
          window_id: windowId,
          include_accessibility_tree: true,
          include_screenshot: false,
          tree_format: 'markdown',
          ...(params.maxElements ? { max_elements: Number(params.maxElements) } : {}),
          ...(params.maxDepth ? { max_depth: Number(params.maxDepth) } : {}),
        }, signal)
        const sc = parsed.structuredContent || {}
        const tree = String(sc.tree_markdown || '')
        if (sc.degraded && !tree.trim()) {
          throw new ComputerUseError('STRUCTURED_STATE_UNAVAILABLE', String(sc.degraded_reason || '目标窗口未暴露可用无障碍树，请改用窗口截图'))
        }
        const snapshotId = randomUUID()
        rememberSnapshot({
          snapshotId,
          sessionId,
          cuaSnapshotId: String(sc.snapshot_id || ''),
          appHandle: app.appHandle,
          pid: app.pid,
          windowId,
          createdAt: Date.now(),
        })
        return {
          appHandle: app.appHandle,
          windowId,
          focusedWindowId: windowId,
          snapshotId,
          tree,
          windows,
          truncated: Boolean(sc.truncated),
        }
      }

      case 'screenshot': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const windowId = Number(params.windowId)
        const windows = await resolveWindowsForApp(activeDriver, app, signal)
        const target = windows.find((w) => w.windowId === windowId)
        const parsed = await callDriverTool(activeDriver, 'get_window_state', {
          pid: app.pid,
          window_id: windowId,
          include_accessibility_tree: false,
          include_screenshot: true,
        }, signal)
        const sc = parsed.structuredContent || {}
        const imageBlock = Array.isArray(parsed.content) ? parsed.content.find((item) => item?.type === 'image' && typeof item.data === 'string') : null
        if (!imageBlock) {
          throw new ComputerUseError('SCREENSHOT_UNAVAILABLE', '未能捕获目标窗口截图（窗口可能已最小化或受系统保护）')
        }
        const rawBounds = sc.window_bounds || target?.bounds || { x: 0, y: 0, width: sc.screenshot_width || 1, height: sc.screenshot_height || 1 }
        const pixelWidth = Math.max(1, Number(sc.screenshot_width) || Math.round(finiteNumber(rawBounds.width, 1)))
        const pixelHeight = Math.max(1, Number(sc.screenshot_height) || Math.round(finiteNumber(rawBounds.height, 1)))
        return {
          mimeType: 'image/png',
          data: imageBlock.data,
          pixelWidth,
          pixelHeight,
          windowId,
          bounds: {
            x: finiteNumber(rawBounds.x),
            y: finiteNumber(rawBounds.y),
            width: Math.max(1, finiteNumber(rawBounds.width, pixelWidth)),
            height: Math.max(1, finiteNumber(rawBounds.height, pixelHeight)),
          },
          coordinateSpace: 'window-pixels',
        }
      }

      case 'listActions': {
        requireApp(params.appHandle)
        resolveSnapshotElement(params)
        return ['invoke', 'click', 'setValue']
      }

      case 'invoke': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const { snap, token } = resolveSnapshotElement(params)
        await callInputTool(activeDriver, 'click', {
          pid: snap.pid,
          window_id: snap.windowId,
          element_token: token,
          delivery_mode: 'background',
        }, signal)
        return { dispatched: true }
      }

      case 'performAction': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const { snap, token } = resolveSnapshotElement(params)
        const action = String(params.action || '').trim()
        if (action === 'setValue') {
          await callInputTool(activeDriver, 'set_value', {
            pid: snap.pid,
            window_id: snap.windowId,
            element_token: token,
            value: String(params.argument ?? ''),
          }, signal)
          return { dispatched: true }
        }
        await callInputTool(activeDriver, 'click', {
          pid: snap.pid,
          window_id: snap.windowId,
          element_token: token,
          ...(action && action !== 'invoke' && action !== 'click' ? { action } : {}),
          delivery_mode: 'background',
        }, signal)
        return { dispatched: true }
      }

      case 'setValue': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const { snap, token } = resolveSnapshotElement(params)
        await callInputTool(activeDriver, 'set_value', {
          pid: snap.pid,
          window_id: snap.windowId,
          element_token: token,
          value: String(params.value ?? ''),
        }, signal)
        return { dispatched: true }
      }

      case 'mouseMove': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        if (params.elementId) {
          const { snap, token } = resolveSnapshotElement(params)
          try {
            await callDriverTool(activeDriver, 'move_cursor', {
              target: { kind: 'window', pid: snap.pid, window_id: snap.windowId },
              element_token: token,
              scope: params.useSystemPointer ? 'desktop' : 'window',
            }, signal)
          } catch (error) {
            // 急停 / 取消 / 锁屏 / 提权窗口阻断不能被吞掉，只有驱动不支持按元素移动时才宽容降级
            if (error instanceof ComputerUseError && ['COMPUTER_USE_STOPPED', 'NATIVE_CANCELLED', 'SESSION_LOCKED', 'ELEVATED_WINDOW_BLOCKED'].includes(error.code)) {
              throw error
            }
          }
          return { dispatched: true, hoverRoute: params.useSystemPointer ? 'system-pointer' : 'accessibility', systemPointerMoved: Boolean(params.useSystemPointer) }
        }
        const coords = await resolveCoordinates(activeDriver, app, params, signal)
        const win = coords.targetWindow || (await resolveWindowsForApp(activeDriver, app, signal)).find((w) => w.windowId === coords.windowId)
        const screenX = (win?.bounds?.x || 0) + coords.x
        const screenY = (win?.bounds?.y || 0) + coords.y
        await callDriverTool(activeDriver, 'move_cursor', {
          scope: 'desktop',
          x: screenX,
          y: screenY,
        }, signal)
        return { dispatched: true, hoverRoute: 'system-pointer', systemPointerMoved: true }
      }

      case 'click': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const button = params.mouseButton || 'left'
        const count = params.clickCount || 1
        const modifier = mapModifiers(params.modifiers)
        if (params.elementId) {
          const { snap, token } = resolveSnapshotElement(params)
          await callInputTool(activeDriver, 'click', {
            pid: snap.pid,
            window_id: snap.windowId,
            element_token: token,
            button,
            count,
            ...(modifier.length ? { modifier } : {}),
            delivery_mode: 'background',
          }, signal)
          return { dispatched: true }
        }
        const coords = await resolveCoordinates(activeDriver, app, params, signal)
        await callInputTool(activeDriver, 'click', {
          pid: app.pid,
          window_id: coords.windowId,
          x: coords.x,
          y: coords.y,
          button,
          count,
          ...(modifier.length ? { modifier } : {}),
        }, signal)
        return { dispatched: true }
      }

      case 'scroll': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const coords = await resolveCoordinates(activeDriver, app, params, signal)
        const dy = finiteNumber(params.deltaLinesY)
        const dx = finiteNumber(params.deltaLinesX)
        if (dy !== 0) {
          await callInputTool(activeDriver, 'scroll', {
            pid: app.pid,
            window_id: coords.windowId,
            x: coords.x,
            y: coords.y,
            direction: dy > 0 ? 'up' : 'down',
            amount: Math.min(50, Math.max(1, Math.abs(Math.round(dy)))),
            by: 'line',
          }, signal)
        }
        if (dx !== 0) {
          await callInputTool(activeDriver, 'scroll', {
            pid: app.pid,
            window_id: coords.windowId,
            x: coords.x,
            y: coords.y,
            direction: dx > 0 ? 'left' : 'right',
            amount: Math.min(50, Math.max(1, Math.abs(Math.round(dx)))),
            by: 'line',
          }, signal)
        }
        return { dispatched: true }
      }

      case 'drag': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const windowId = Number(params.windowId)
        let fromX = finiteNumber(params.fromX)
        let fromY = finiteNumber(params.fromY)
        let toX = finiteNumber(params.toX)
        let toY = finiteNumber(params.toY)
        if (params.relative === true) {
          const windows = await resolveWindowsForApp(activeDriver, app, signal)
          const target = windows.find((w) => w.windowId === windowId)
          if (!target) throw new ComputerUseError('WINDOW_CHANGED', `窗口 ${windowId} 已关闭或不可见`)
          fromX = Math.round((target.bounds.width * fromX) / 1000)
          fromY = Math.round((target.bounds.height * fromY) / 1000)
          toX = Math.round((target.bounds.width * toX) / 1000)
          toY = Math.round((target.bounds.height * toY) / 1000)
        }
        await callInputTool(activeDriver, 'drag', {
          pid: app.pid,
          window_id: windowId,
          from_x: fromX,
          from_y: fromY,
          to_x: toX,
          to_y: toY,
          button: params.mouseButton || 'left',
          ...(params.durationMs ? { duration_ms: Number(params.durationMs) } : {}),
          ...(params.steps ? { steps: Number(params.steps) } : {}),
        }, signal)
        return { dispatched: true }
      }

      case 'typeText': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        await callInputTool(activeDriver, 'type_text', {
          pid: app.pid,
          ...(params.windowId ? { window_id: Number(params.windowId) } : {}),
          text: String(params.text ?? ''),
        }, signal)
        return { dispatched: true }
      }

      case 'paste': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        await callDriverTool(activeDriver, 'clipboard_write', { text: String(params.text ?? '') }, signal)
        await callInputTool(activeDriver, 'hotkey', {
          pid: app.pid,
          ...(params.windowId ? { window_id: Number(params.windowId) } : {}),
          keys: [platform === 'darwin' ? 'cmd' : 'ctrl', 'v'],
        }, signal)
        return { dispatched: true }
      }

      case 'pressKey': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        const modifiers = mapModifiers(params.modifiers)
        await callInputTool(activeDriver, 'press_key', {
          pid: app.pid,
          ...(params.windowId ? { window_id: Number(params.windowId) } : {}),
          key: String(params.key || ''),
          ...(modifiers.length ? { modifiers } : {}),
        }, signal)
        return { dispatched: true }
      }

      case 'sendKeyEvent': {
        const app = requireApp(params.appHandle)
        currentApp = app.name
        if (params.direction === 'down') {
          await callInputTool(activeDriver, 'press_key', {
            pid: app.pid,
            ...(params.windowId ? { window_id: Number(params.windowId) } : {}),
            key: String(params.key || ''),
          }, signal)
        }
        return { dispatched: true }
      }

      case 'selectText':
        throw new ComputerUseError('UNSUPPORTED_OPERATION', '当前桌面操作驱动暂不支持 selectText，请改用 click + typeText / paste')

      default:
        throw new ComputerUseError('UNKNOWN_METHOD', `不支持的电脑操作方法：${method}`)
    }
  }

  async function rpc({ sessionId = '', id = '', method = '', params = {}, instance = '' } = {}) {
    if (!enabled) {
      return { error: { code: 'COMPUTER_USE_DISABLED', message: '电脑操作未启用，请在 DSH-X 设置中开启' } }
    }
    if (halted) {
      return { error: { code: 'COMPUTER_USE_STOPPED', message: '电脑操作已被用户停止，请在 DSH-X 中恢复后再试' } }
    }
    const opKey = `${sessionId}:${id || randomUUID()}`
    const controller = new AbortController()
    activeOps.set(opKey, { sessionId, id, controller })
    if (instance) currentInstance = String(instance)
    lastAction = String(method || '')
    lastActionAt = Date.now()
    onStateChanged()

    const startedAt = Date.now()
    const detail = summarizeAuditDetail(method, params)
    const appAtStart = params?.appHandle ? (apps.get(String(params.appHandle))?.name || currentApp) : currentApp

    try {
      const activeDriver = await ensureDriver()
      const result = await executeMethod(activeDriver, method, params || {}, sessionId, controller.signal)
      const appName = params?.appHandle ? (apps.get(String(params.appHandle))?.name || currentApp) : (result?.name || appAtStart)
      // 只读状态探测不必把审计日志刷满，动作和关键观察才记一条
      if (method !== 'permissionStatus' && method !== 'applicationIcons') {
        recordAudit({
          instance,
          app: appName,
          action: method,
          detail,
          result: 'ok',
          durationMs: Date.now() - startedAt,
        })
      }
      return { result }
    } catch (error) {
      const code = error instanceof ComputerUseError ? error.code : 'NATIVE_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      if (method !== 'permissionStatus' && method !== 'applicationIcons') {
        recordAudit({
          instance,
          app: appAtStart,
          action: method,
          detail,
          result: 'error',
          errorCode: code,
          durationMs: Date.now() - startedAt,
        })
      }
      return { error: { code, message } }
    } finally {
      activeOps.delete(opKey)
      onStateChanged()
    }
  }

  /** `/api/desktop/computer` 与管理页接口统一分派入口。 */
  async function dispatch(request = {}) {
    const op = String(request.op || '')
    switch (op) {
      case 'status':
        return { ...status(), audit: [...audit].reverse() }
      case 'rpc':
        return rpc(request)
      case 'cancel':
        return cancel(request)
      case 'closeSession':
        return closeSession(request.sessionId)
      case 'stop':
        return stop(request.reason || 'manager')
      case 'resume':
        return resume()
      case 'clearAudit':
        audit.length = 0
        onStateChanged()
        return { ok: true, count: 0 }
      default:
        throw new ComputerUseError('INVALID_OP', `未知的 computer 操作：${op}`)
    }
  }

  return {
    status,
    auditLog: () => [...audit].reverse(),
    setEnabled,
    stop,
    resume,
    closeSession,
    cancel,
    rpc,
    dispatch,
    dispose: () => stop('quit'),
  }
}
