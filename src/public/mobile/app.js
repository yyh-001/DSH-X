// DSH-X 手机版 PWA 主逻辑（纯原生 ESM，零第三方依赖）
// 负责扫码/手工配对、多主机与多链路并发测速选路、实例启停、日志查看与设备管理。

const STORAGE = {
  deviceKey: 'dshx_mobile_device_key',
  hosts: 'dshx_mobile_hosts_v1',
  theme: 'dshx_mobile_theme',
  lang: 'dshx_mobile_lang',
  autoSwitch: 'dshx_mobile_auto_switch',
  lastLogKey: 'dshx_mobile_last_log_key',
}

const REDIRECT_GUARD_KEY = 'dshx_mobile_route_redirected'
const PROBE_TIMEOUT_MS = 2500
const INSTANCES_POLL_MS = 6000
const LOGS_POLL_MS = 2500

// 中英文双语文案：保持简洁直白，贴合移动端小屏排版
const I18N = {
  zh: {
    connecting: '连接中',
    online: '在线',
    offline: '离线',
    linkLan: '局域网',
    linkTunnel: '公网隧道',
    linkCustom: '自定义',
    addNewHostOption: '+ 配对新主机…',
    tabInstances: '实例',
    tabLogs: '日志',
    tabSettings: '设备与设置',
    runningInstances: '运行中实例',
    configuredLaunches: '启动项',
    enterDsh: '进入 DSH',
    stop: '停止',
    start: '启动',
    starting: '启动中…',
    stopping: '停止中…',
    statusRunning: '运行中',
    statusStarting: '启动中',
    statusActive: '当前',
    viewLogs: '查看日志',
    noRunningTitle: '暂无运行中的实例',
    noRunningDesc: '可从下方启动项一键启动，或在电脑端 DSH-X 中启动实例。',
    noLaunchesTitle: '暂无已配置的启动项',
    noLaunchesDesc: '请在电脑端 DSH-X 中先添加环境与启动项。',
    loadFailedTitle: '加载失败',
    retry: '重试',
    uptimePrefix: '已运行',
    justNow: '刚刚',
    minutesAgo: '{n} 分钟',
    hoursAgo: '{n} 小时',
    daysAgo: '{n} 天',
    autoRefresh: '自动刷新',
    autoScroll: '自动滚动',
    copyLogs: '复制',
    logsCopied: '日志已复制',
    logsCopyFailed: '复制失败，请手动选中复制',
    noLogsInstance: '当前没有运行中的实例可查看日志',
    logsEmpty: '（暂无日志输出）',
    linesCount: '{n} 行',
    routesSection: '链路与测速',
    probeRoutes: '测速选路',
    probing: '测速中…',
    probeDone: '测速完成',
    currentRoute: '当前',
    fastestRoute: '最快',
    switchTo: '切换',
    openDirect: '直接访问',
    routeUnreachable: '不可达',
    routeTimeout: '超时',
    routeMixedContent: '受 HTTPS 混合内容限制，无法后台测速',
    routeMixedBannerTitle: '局域网地址需直接跳转',
    routeMixedBannerSub: '当前为 HTTPS 公网隧道，浏览器禁止后台探测 HTTP 局域网，回到同一 Wi-Fi 时可直接点击切换。',
    fasterRouteTitle: '检测到更快的{type}链路',
    fasterRouteSub: '{bestRtt}ms（当前 {curRtt}ms），点击立即切换',
    offlineFallbackTitle: '当前链路不可达，已发现可用备用链路',
    offlineFallbackSub: '{type} {rtt}ms：{url}',
    dismiss: '忽略',
    customEndpointLabel: '自定义地址（Tailscale / 自建反代）',
    customEndpointHint: '保存后会参与当前主机的并发测速选路，留空可清除',
    save: '保存',
    saved: '已保存',
    invalidUrl: '请输入以 http:// 或 https:// 开头的有效地址',
    autoSwitchRoute: '自动切换更快链路',
    autoSwitchRouteDesc: '检测到更低延迟的同主机链路时自动跳转',
    pairedDevices: '已配对设备',
    thisDevice: '当前设备',
    revoke: '吊销',
    revoking: '吊销中…',
    revokeConfirmTitle: '吊销设备？',
    revokeConfirmBody: '吊销「{name}」后，该设备的登录会话与实时连接将立即失效。',
    revokeSelfConfirmBody: '将吊销当前手机的配对凭证并退出控制台，需要重新扫码才能进入。',
    deviceRevoked: '已吊销设备',
    noDevices: '暂无已配对设备记录',
    lastActive: '最近活跃',
    pairedAt: '配对于',
    hostsSection: '已保存主机',
    addHost: '配对新主机',
    removeHost: '移除',
    removeHostTitle: '移除本地主机记录？',
    removeHostBody: '仅从本机列表移除「{name}」，不会影响电脑端设置。',
    hostRemoved: '已移除主机记录',
    noSavedHosts: '当前主机配对后会自动保存在这里',
    preferencesSection: '外观与语言',
    themeLabel: '主题',
    themeAuto: '自动',
    themeLight: '浅色',
    themeDark: '深色',
    languageLabel: '语言',
    unpairTitle: '退出当前设备',
    unpairDesc: '吊销本机在此主机上的会话并返回配对页',
    unpairBtn: '退出配对',
    pairTitle: '配对此设备',
    pairAddTitle: '配对新主机',
    pairSubtitle: '在电脑端 DSH-X「远程访问」中生成配对二维码或配对码',
    pairAutoRecognized: '已自动识别扫码配对信息，确认设备名后点击配对',
    pairAutoRecognizedHost: '已识别主机「{host}」的配对信息，点击下方即可配对',
    pairCodeLabel: '配对码',
    pairCodePlaceholder: '输入 5 分钟有效的一次性配对码',
    deviceNameLabel: '设备名称',
    serverUrlLabel: '服务器地址（可选）',
    serverUrlPlaceholder: '留空使用当前地址：{origin}',
    serverUrlHintCurrent: '当前网关：{origin}',
    serverUrlHintCross: '填写其他主机地址后，提交时将跳转到该地址完成安全配对',
    pairSubmit: '立即配对',
    pairing: '正在配对…',
    pairSuccess: '配对成功',
    pairFailed: '配对失败，请检查配对码是否有效或已过期',
    rateLimited: '操作过于频繁，请 {s} 秒后再试',
    sessionExpired: '设备会话已失效或已被吊销，请重新配对',
    switchSavedHost: '或切换到已保存的主机',
    stopConfirmTitle: '停止运行中的实例？',
    stopConfirmBody: '确定要停止实例「{name}」吗？正在进行的任务会中断。',
    cancel: '取消',
    confirm: '确定',
    instanceStarted: '实例启动请求已发送',
    instanceStopped: '实例已停止',
    actionFailed: '操作失败：{msg}',
    targetLocal: '本机',
    targetWsl: 'WSL',
    targetSsh: 'SSH',
    footerVersion: 'DSH-X 网关 {version}',
    footerPwaHint: '提示：可通过浏览器菜单「添加到主屏幕」以独立 App 形态使用',
    defaultHostName: 'DSH-X 主机',
    noEndpoints: '暂未获取到链路地址',
  },
  en: {
    connecting: 'Connecting',
    online: 'Online',
    offline: 'Offline',
    linkLan: 'LAN',
    linkTunnel: 'Tunnel',
    linkCustom: 'Custom',
    addNewHostOption: '+ Pair New Host…',
    tabInstances: 'Instances',
    tabLogs: 'Logs',
    tabSettings: 'Settings',
    runningInstances: 'Running Instances',
    configuredLaunches: 'Launches',
    enterDsh: 'Open DSH',
    stop: 'Stop',
    start: 'Start',
    starting: 'Starting…',
    stopping: 'Stopping…',
    statusRunning: 'Running',
    statusStarting: 'Starting',
    statusActive: 'Active',
    viewLogs: 'View Logs',
    noRunningTitle: 'No running instances',
    noRunningDesc: 'Start one from Launches below, or launch an instance from DSH-X on desktop.',
    noLaunchesTitle: 'No launches configured',
    noLaunchesDesc: 'Add environments and launch profiles in DSH-X desktop first.',
    loadFailedTitle: 'Failed to load',
    retry: 'Retry',
    uptimePrefix: 'Up',
    justNow: 'just now',
    minutesAgo: '{n}m',
    hoursAgo: '{n}h',
    daysAgo: '{n}d',
    autoRefresh: 'Auto-refresh',
    autoScroll: 'Auto-scroll',
    copyLogs: 'Copy',
    logsCopied: 'Logs copied',
    logsCopyFailed: 'Copy failed; please select and copy manually',
    noLogsInstance: 'No running instance available for logs',
    logsEmpty: '(No log output yet)',
    linesCount: '{n} lines',
    routesSection: 'Routes & Latency',
    probeRoutes: 'Probe Routes',
    probing: 'Probing…',
    probeDone: 'Route probe finished',
    currentRoute: 'Current',
    fastestRoute: 'Fastest',
    switchTo: 'Switch',
    openDirect: 'Open',
    routeUnreachable: 'Unreachable',
    routeTimeout: 'Timeout',
    routeMixedContent: 'Blocked by HTTPS mixed-content policy',
    routeMixedBannerTitle: 'LAN link requires direct navigation',
    routeMixedBannerSub: 'HTTPS pages cannot background-probe HTTP LAN endpoints. Tap Open when on the same Wi-Fi.',
    fasterRouteTitle: 'Faster {type} route available',
    fasterRouteSub: '{bestRtt}ms vs current {curRtt}ms. Tap to switch.',
    offlineFallbackTitle: 'Current route offline; reachable route found',
    offlineFallbackSub: '{type} {rtt}ms: {url}',
    dismiss: 'Dismiss',
    customEndpointLabel: 'Custom URL (Tailscale / Reverse Proxy)',
    customEndpointHint: 'Included in concurrent route probing for this host. Leave empty to clear.',
    save: 'Save',
    saved: 'Saved',
    invalidUrl: 'Enter a valid http:// or https:// URL',
    autoSwitchRoute: 'Auto-switch to faster route',
    autoSwitchRouteDesc: 'Automatically redirect when a lower-latency link is detected',
    pairedDevices: 'Paired Devices',
    thisDevice: 'This device',
    revoke: 'Revoke',
    revoking: 'Revoking…',
    revokeConfirmTitle: 'Revoke device?',
    revokeConfirmBody: 'Revoking "{name}" immediately ends its session and active connections.',
    revokeSelfConfirmBody: 'This revokes the current device and returns to the pairing screen.',
    deviceRevoked: 'Device revoked',
    noDevices: 'No paired devices',
    lastActive: 'Last active',
    pairedAt: 'Paired',
    hostsSection: 'Saved Hosts',
    addHost: 'Pair Host',
    removeHost: 'Remove',
    removeHostTitle: 'Remove saved host?',
    removeHostBody: 'Removes "{name}" from this device only; desktop settings are unchanged.',
    hostRemoved: 'Host removed',
    noSavedHosts: 'Paired hosts appear here automatically',
    preferencesSection: 'Appearance & Language',
    themeLabel: 'Theme',
    themeAuto: 'Auto',
    themeLight: 'Light',
    themeDark: 'Dark',
    languageLabel: 'Language',
    unpairTitle: 'Unpair this device',
    unpairDesc: 'Revoke this device session on the host and return to pairing',
    unpairBtn: 'Unpair',
    pairTitle: 'Pair This Device',
    pairAddTitle: 'Pair New Host',
    pairSubtitle: 'Generate a pairing QR code or code in DSH-X desktop under Remote Access',
    pairAutoRecognized: 'QR pairing code detected. Review device name and tap Pair.',
    pairAutoRecognizedHost: 'Detected pairing info for "{host}". Tap Pair to connect.',
    pairCodeLabel: 'Pairing Code',
    pairCodePlaceholder: 'Enter one-time 5-min pairing code',
    deviceNameLabel: 'Device Name',
    serverUrlLabel: 'Server URL (optional)',
    serverUrlPlaceholder: 'Default: {origin}',
    serverUrlHintCurrent: 'Current gateway: {origin}',
    serverUrlHintCross: 'Entering another host URL will navigate there to complete pairing securely',
    pairSubmit: 'Pair Now',
    pairing: 'Pairing…',
    pairSuccess: 'Paired successfully',
    pairFailed: 'Pairing failed. Check that the code is valid and not expired.',
    rateLimited: 'Too many attempts. Retry in {s}s.',
    sessionExpired: 'Session expired or device was revoked. Please pair again.',
    switchSavedHost: 'Or switch to a saved host',
    stopConfirmTitle: 'Stop running instance?',
    stopConfirmBody: 'Stop instance "{name}"? Any running tasks will be interrupted.',
    cancel: 'Cancel',
    confirm: 'Confirm',
    instanceStarted: 'Instance start requested',
    instanceStopped: 'Instance stopped',
    actionFailed: 'Action failed: {msg}',
    targetLocal: 'Local',
    targetWsl: 'WSL',
    targetSsh: 'SSH',
    footerVersion: 'DSH-X Gateway {version}',
    footerPwaHint: 'Tip: Use "Add to Home Screen" in your browser menu for standalone app mode',
    defaultHostName: 'DSH-X Host',
    noEndpoints: 'No route URLs configured yet',
  },
}

// ===== 本地存储与工具函数 =====

function lsGet(key, fallback = '') {
  try {
    const val = localStorage.getItem(key)
    return val === null ? fallback : val
  } catch {
    return fallback
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式或空间不足时静默忽略
  }
}

function detectInitialLang() {
  const saved = lsGet(STORAGE.lang)
  if (saved === 'zh' || saved === 'en') return saved
  const nav = (navigator.language || 'zh').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

function getOrCreateDeviceKey() {
  let key = lsGet(STORAGE.deviceKey)
  if (key && /^devkey_[a-f0-9]{16,}$/i.test(key)) return key
  const bytes = new Uint8Array(12)
  if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  key = `devkey_${hex}`
  lsSet(STORAGE.deviceKey, key)
  return key
}

function detectDeviceProfile() {
  const ua = navigator.userAgent || ''
  const isIPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
  const isIPhone = /iPhone/i.test(ua)
  const isAndroid = /Android/i.test(ua)

  let platform = 'web'
  let osLabel = 'Mobile'
  if (isIPhone) {
    platform = 'ios'
    osLabel = 'iPhone'
  } else if (isIPad) {
    platform = 'ios'
    osLabel = 'iPad'
  } else if (isAndroid) {
    platform = 'android'
    osLabel = 'Android'
  } else if (/Macintosh/i.test(ua)) {
    platform = 'macos'
    osLabel = 'Mac'
  } else if (/Windows/i.test(ua)) {
    platform = 'windows'
    osLabel = 'Windows'
  } else if (/Linux/i.test(ua)) {
    platform = 'linux'
    osLabel = 'Linux'
  }

  let browser = 'Browser'
  if (/EdgA?|EdgiOS/i.test(ua)) browser = 'Edge'
  else if (/CriOS|Chrome/i.test(ua)) browser = 'Chrome'
  else if (/FxiOS|Firefox/i.test(ua)) browser = 'Firefox'
  else if (/Safari/i.test(ua)) browser = 'Safari'

  return {
    platform,
    defaultName: `${osLabel} ${browser}`.trim(),
  }
}

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.origin
  } catch {
    return ''
  }
}

function isPrivateLanHost(hostname) {
  const h = (hostname || '').toLowerCase()
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local') || h.endsWith('.lan')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isTailscaleHost(hostname) {
  const h = (hostname || '').toLowerCase()
  if (h.endsWith('.ts.net')) return true
  const m = h.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (!m) return false
  const b = Number(m[1])
  return b >= 64 && b <= 127
}

function classifyEndpointType(origin, endpoints = {}) {
  const norm = normalizeOrigin(origin)
  if (!norm) return 'custom'
  if (normalizeOrigin(endpoints.lan) === norm) return 'lan'
  if (normalizeOrigin(endpoints.tunnel) === norm) return 'tunnel'
  if (normalizeOrigin(endpoints.custom) === norm) return 'custom'
  try {
    const { hostname } = new URL(norm)
    if (isPrivateLanHost(hostname)) return 'lan'
    if (isTailscaleHost(hostname)) return 'custom'
    return 'tunnel'
  } catch {
    return 'custom'
  }
}

function isMixedContentUrl(targetOrigin) {
  return window.location.protocol === 'https:' && targetOrigin.startsWith('http:')
}

function decodeBase64UrlJson(input) {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  // 先尝试直接当 JSON 解析（兼容未编码的 JSON 字符串）
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed) } catch { return null }
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) return null
  try {
    const b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    const bin = atob(b64 + pad)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseUrlPairing() {
  const params = new URLSearchParams(window.location.search)
  const rawPair = params.get('pair')
  const nameParam = params.get('name') || ''
  if (!rawPair) return null

  let result = {
    code: '',
    hostId: '',
    hostName: params.get('hostName') || params.get('host') || '',
    deviceName: nameParam,
    endpoints: {
      lan: normalizeOrigin(params.get('lan') || ''),
      tunnel: normalizeOrigin(params.get('tunnel') || ''),
      custom: normalizeOrigin(params.get('custom') || ''),
    },
    serverUrl: normalizeOrigin(params.get('server') || ''),
  }

  const decoded = decodeBase64UrlJson(rawPair)
  if (decoded && (decoded.code || decoded.c || decoded.pairCode)) {
    result.code = String(decoded.code || decoded.c || decoded.pairCode || '').trim()
    result.hostId = String(decoded.hostId || decoded.id || '').trim()
    result.hostName = String(decoded.hostName || decoded.name || decoded.n || result.hostName || '').trim()
    const ep = decoded.endpoints || decoded.e || {}
    result.endpoints = {
      lan: normalizeOrigin(ep.lan || decoded.lan || result.endpoints.lan),
      tunnel: normalizeOrigin(ep.tunnel || decoded.tunnel || result.endpoints.tunnel),
      custom: normalizeOrigin(ep.custom || decoded.custom || result.endpoints.custom),
    }
    if (decoded.url || decoded.server) {
      result.serverUrl = normalizeOrigin(decoded.url || decoded.server)
    }
  } else {
    result.code = rawPair.trim()
  }

  // 解析完成后立刻从地址栏移除一次性配对码，防止刷新重复提交或留在浏览器历史记录中
  try {
    const cleanUrl = new URL(window.location.href)
    cleanUrl.searchParams.delete('pair')
    cleanUrl.searchParams.delete('name')
    cleanUrl.searchParams.delete('host')
    cleanUrl.searchParams.delete('hostName')
    cleanUrl.searchParams.delete('lan')
    cleanUrl.searchParams.delete('tunnel')
    cleanUrl.searchParams.delete('custom')
    cleanUrl.searchParams.delete('server')
    window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash)
  } catch {
    // 忽略 history API 受限场景
  }

  return result.code ? result : null
}

function loadSavedHosts() {
  try {
    const raw = lsGet(STORAGE.hosts, '[]')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        hostId: String(h.hostId || ''),
        hostName: String(h.hostName || ''),
        endpoints: {
          lan: normalizeOrigin(h.endpoints?.lan || ''),
          tunnel: normalizeOrigin(h.endpoints?.tunnel || ''),
          custom: normalizeOrigin(h.endpoints?.custom || ''),
        },
        activeEndpoint: normalizeOrigin(h.activeEndpoint || ''),
      }))
  } catch {
    return []
  }
}

function saveHosts(hosts) {
  lsSet(STORAGE.hosts, JSON.stringify(hosts))
}

function hostContainsOrigin(host, origin) {
  const norm = normalizeOrigin(origin)
  if (!norm || !host) return false
  return (
    normalizeOrigin(host.activeEndpoint) === norm ||
    normalizeOrigin(host.endpoints?.lan) === norm ||
    normalizeOrigin(host.endpoints?.tunnel) === norm ||
    normalizeOrigin(host.endpoints?.custom) === norm
  )
}

function upsertSavedHost(hosts, incoming) {
  const origin = normalizeOrigin(window.location.origin)
  const incomingId = String(incoming.hostId || '').trim()
  const nextEndpoints = {
    lan: normalizeOrigin(incoming.endpoints?.lan || ''),
    tunnel: normalizeOrigin(incoming.endpoints?.tunnel || ''),
    custom: normalizeOrigin(incoming.endpoints?.custom || ''),
  }
  const idx = hosts.findIndex((h) => {
    if (incomingId && h.hostId && h.hostId === incomingId) return true
    return hostContainsOrigin(h, origin)
  })

  if (idx >= 0) {
    const prev = hosts[idx]
    const mergedEndpoints = {
      lan: nextEndpoints.lan || prev.endpoints?.lan || '',
      tunnel: nextEndpoints.tunnel || prev.endpoints?.tunnel || '',
      custom: incoming.overwriteCustom
        ? nextEndpoints.custom
        : (nextEndpoints.custom || prev.endpoints?.custom || ''),
    }
    // 将当前访问来源自动补录到对应类型槽位，避免用户从局域网打开时丢掉局域网地址
    const curType = classifyEndpointType(origin, mergedEndpoints)
    if (!mergedEndpoints[curType]) mergedEndpoints[curType] = origin

    hosts[idx] = {
      hostId: incomingId || prev.hostId || origin,
      hostName: String(incoming.hostName || prev.hostName || '').trim(),
      endpoints: mergedEndpoints,
      activeEndpoint: origin || prev.activeEndpoint || '',
    }
    return hosts[idx]
  }

  const curType = classifyEndpointType(origin, nextEndpoints)
  if (origin && !nextEndpoints[curType]) nextEndpoints[curType] = origin

  const entry = {
    hostId: incomingId || origin,
    hostName: String(incoming.hostName || '').trim(),
    endpoints: nextEndpoints,
    activeEndpoint: origin,
  }
  hosts.unshift(entry)
  return entry
}

// ===== 应用全局状态 =====

const deviceProfile = detectDeviceProfile()

const state = {
  lang: detectInitialLang(),
  theme: (() => {
    const v = lsGet(STORAGE.theme, 'auto')
    return v === 'light' || v === 'dark' ? v : 'auto'
  })(),
  autoSwitch: lsGet(STORAGE.autoSwitch, '0') === '1',
  deviceKey: getOrCreateDeviceKey(),
  hosts: loadSavedHosts(),
  authenticated: false,
  pairModalOpen: false,
  pendingUrlPair: null,
  health: null,
  me: null,
  activeTab: 'instances',
  instances: [],
  launches: [],
  activeInstanceKey: '',
  instancesLoaded: false,
  instancesError: '',
  pendingStartIds: new Set(),
  pendingStopKeys: new Set(),
  selectedLogKey: lsGet(STORAGE.lastLogKey, ''),
  logLines: [],
  logAutoRefresh: true,
  logAutoScroll: true,
  logLoading: false,
  devices: [],
  devicesLoaded: false,
  probeResults: [],
  probing: false,
  bannerDismissedUrl: '',
  instancesTimer: null,
  logsTimer: null,
}

// ===== DOM 引用 =====

const el = {
  consoleShell: document.getElementById('consoleShell'),
  hostSelect: document.getElementById('hostSelect'),
  connChip: document.getElementById('connChip'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  connRtt: document.getElementById('connRtt'),
  refreshBtn: document.getElementById('refreshBtn'),
  routeBanner: document.getElementById('routeBanner'),
  routeBannerTitle: document.getElementById('routeBannerTitle'),
  routeBannerSub: document.getElementById('routeBannerSub'),
  routeBannerActions: document.getElementById('routeBannerActions'),

  runningCount: document.getElementById('runningCount'),
  runningList: document.getElementById('runningList'),
  launchesCount: document.getElementById('launchesCount'),
  launchesList: document.getElementById('launchesList'),

  logInstanceSelect: document.getElementById('logInstanceSelect'),
  logRefreshBtn: document.getElementById('logRefreshBtn'),
  logAutoRefreshBtn: document.getElementById('logAutoRefreshBtn'),
  logAutoScrollBtn: document.getElementById('logAutoScrollBtn'),
  logCopyBtn: document.getElementById('logCopyBtn'),
  logMetaKey: document.getElementById('logMetaKey'),
  logMetaLines: document.getElementById('logMetaLines'),
  logOutput: document.getElementById('logOutput'),

  probeRoutesBtn: document.getElementById('probeRoutesBtn'),
  endpointsList: document.getElementById('endpointsList'),
  customEndpointForm: document.getElementById('customEndpointForm'),
  customEndpointInput: document.getElementById('customEndpointInput'),
  autoSwitchToggle: document.getElementById('autoSwitchToggle'),
  devicesCount: document.getElementById('devicesCount'),
  devicesList: document.getElementById('devicesList'),
  addHostBtn: document.getElementById('addHostBtn'),
  hostsList: document.getElementById('hostsList'),
  unpairSelfBtn: document.getElementById('unpairSelfBtn'),
  appFooterNote: document.getElementById('appFooterNote'),

  pairView: document.getElementById('pairView'),
  pairTopbar: document.getElementById('pairTopbar'),
  pairLangBtn: document.getElementById('pairLangBtn'),
  pairThemeBtn: document.getElementById('pairThemeBtn'),
  pairTitle: document.getElementById('pairTitle'),
  pairSubtitle: document.getElementById('pairSubtitle'),
  pairCloseBtn: document.getElementById('pairCloseBtn'),
  pairAutoNotice: document.getElementById('pairAutoNotice'),
  pairAutoNoticeText: document.getElementById('pairAutoNoticeText'),
  pairForm: document.getElementById('pairForm'),
  pairCodeInput: document.getElementById('pairCodeInput'),
  pairDeviceNameInput: document.getElementById('pairDeviceNameInput'),
  pairServerUrlInput: document.getElementById('pairServerUrlInput'),
  pairServerHint: document.getElementById('pairServerHint'),
  pairError: document.getElementById('pairError'),
  pairSubmitBtn: document.getElementById('pairSubmitBtn'),
  pairSavedHostsBox: document.getElementById('pairSavedHostsBox'),
  pairSavedHostsList: document.getElementById('pairSavedHostsList'),

  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmBody: document.getElementById('confirmBody'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
  confirmOkBtn: document.getElementById('confirmOkBtn'),
  toastContainer: document.getElementById('toastContainer'),
}

// ===== 国际化与主题 =====

function t(key, vars = {}) {
  const dict = I18N[state.lang] || I18N.zh
  let text = dict[key] ?? I18N.zh[key] ?? key
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, String(v))
  }
  return text
}

function linkTypeLabel(type) {
  if (type === 'lan') return t('linkLan')
  if (type === 'tunnel') return t('linkTunnel')
  return t('linkCustom')
}

function applyTheme(mode) {
  const normalized = mode === 'light' || mode === 'dark' ? mode : 'auto'
  state.theme = normalized
  lsSet(STORAGE.theme, normalized)
  const dark =
    normalized === 'dark' ||
    (normalized === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = normalized
  document.documentElement.dataset.colorScheme = dark ? 'dark' : 'light'
  const meta = document.getElementById('metaThemeColor')
  if (meta) meta.setAttribute('content', dark ? '#18181b' : '#eef3fd')
  document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeOpt === normalized))
  })
}

function applyLanguage(lang) {
  state.lang = lang === 'en' ? 'en' : 'zh'
  lsSet(STORAGE.lang, state.lang)
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN'
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n
    if (key) node.textContent = t(key)
  })
  document.querySelectorAll('[data-lang-opt]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.langOpt === state.lang))
  })
  el.pairLangBtn.textContent = state.lang === 'zh' ? 'EN' : '中文'
  el.pairCodeInput.placeholder = t('pairCodePlaceholder')
  el.pairServerUrlInput.placeholder = t('serverUrlPlaceholder', { origin: window.location.origin })
  updatePairServerHint()
  renderAll()
}

// ===== 辅助 UI（Toast、确认弹窗、时间与节点构造） =====

function showToast(message, { error = false, duration = 2600 } = {}) {
  const node = document.createElement('div')
  node.className = error ? 'toast error' : 'toast'
  node.textContent = message
  el.toastContainer.appendChild(node)
  setTimeout(() => {
    node.remove()
  }, duration)
}

let confirmResolver = null

function askConfirm({ title, body, okText, danger = true }) {
  el.confirmTitle.textContent = title
  el.confirmBody.textContent = body
  el.confirmCancelBtn.textContent = t('cancel')
  el.confirmOkBtn.textContent = okText || t('confirm')
  el.confirmOkBtn.className = danger ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary'
  el.confirmDialog.hidden = false
  return new Promise((resolve) => {
    confirmResolver = resolve
  })
}

function closeConfirm(result) {
  el.confirmDialog.hidden = true
  if (confirmResolver) {
    const fn = confirmResolver
    confirmResolver = null
    fn(result)
  }
}

function formatRelativeDuration(isoOrMs) {
  if (!isoOrMs) return ''
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs)
  if (!Number.isFinite(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return t('justNow')
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return t('minutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('hoursAgo', { n: hours })
  return t('daysAgo', { n: Math.floor(hours / 24) })
}

function formatTargetInfo(target) {
  // 后端 target 可能是字符串 ('local'|'wsl'|'ssh') 或结构化对象 ({ type, label, name })
  let rawType = 'local'
  let extra = ''
  if (typeof target === 'string' && target.trim()) {
    rawType = target.trim().toLowerCase()
  } else if (target && typeof target === 'object') {
    rawType = String(target.type || target.kind || 'local').toLowerCase()
    extra = String(target.label || target.name || target.host || target.distro || '').trim()
  }
  if (rawType.includes('wsl')) {
    return { cls: 'target-wsl', label: extra ? `WSL · ${extra}` : t('targetWsl') }
  }
  if (rawType.includes('ssh') || rawType.includes('remote')) {
    return { cls: 'target-ssh', label: extra ? `SSH · ${extra}` : t('targetSsh') }
  }
  return { cls: 'target-local', label: t('targetLocal') }
}

function createEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = String(v)
    else if (k === 'dataset' && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv)
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v)
    } else {
      node.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function createSvgIcon(paths, sizeClass = 'icon-sm') {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon ${sizeClass}`)
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

// ===== 网络请求层 =====

class ApiError extends Error {
  constructor(message, { status = 0, data = null, retryAfterSec = 0 } = {}) {
    super(message)
    this.status = status
    this.data = data
    this.retryAfterSec = retryAfterSec
  }
}

async function apiFetch(path, { method = 'GET', body, timeoutMs = 10000, skipAuthHandling = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {}
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
    let data = null
    try {
      const text = await res.text()
      if (text) data = JSON.parse(text)
    } catch {
      data = null
    }
    if (!res.ok) {
      let retryAfterSec = 0
      const headerRetry = Number(res.headers.get('Retry-After'))
      if (Number.isFinite(headerRetry) && headerRetry > 0) retryAfterSec = Math.ceil(headerRetry)
      else if (data && Number(data.retryAfterMs) > 0) retryAfterSec = Math.ceil(Number(data.retryAfterMs) / 1000)

      if (res.status === 401 && !skipAuthHandling) {
        handleSessionUnauthorized()
      }
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`
      throw new ApiError(msg, { status: res.status, data, retryAfterSec })
    }
    return data || {}
  } finally {
    clearTimeout(timer)
  }
}

function handleSessionUnauthorized() {
  if (!state.authenticated) return
  state.authenticated = false
  state.me = null
  stopPolling()
  showPairView({ modal: false, errorMessage: t('sessionExpired') })
}

// ===== 主机与多链路并发测速选路 =====

function getCurrentHostRecord() {
  const origin = normalizeOrigin(window.location.origin)
  const hostId = state.me?.host?.hostId || state.health?.hostId || ''
  let host = state.hosts.find((h) => (hostId && h.hostId === hostId) || hostContainsOrigin(h, origin))
  if (!host) {
    host = {
      hostId: hostId || origin,
      hostName: state.me?.host?.hostName || state.health?.hostName || t('defaultHostName'),
      endpoints: {
        lan: normalizeOrigin(state.me?.host?.endpoints?.lan || ''),
        tunnel: normalizeOrigin(state.me?.host?.endpoints?.tunnel || state.health?.tunnel?.publicUrl || ''),
        custom: normalizeOrigin(state.me?.host?.endpoints?.custom || ''),
      },
      activeEndpoint: origin,
    }
  }
  return host
}

function buildCandidateEndpoints(host) {
  const origin = normalizeOrigin(window.location.origin)
  const ep = host?.endpoints || {}
  const list = []
  const seen = new Set()

  const add = (raw, explicitType) => {
    const url = normalizeOrigin(raw)
    if (!url || seen.has(url)) return
    seen.add(url)
    list.push({
      url,
      type: explicitType || classifyEndpointType(url, ep),
      isCurrent: url === origin,
    })
  }

  add(ep.lan, 'lan')
  add(ep.tunnel, 'tunnel')
  add(ep.custom, 'custom')
  // 确保当前正在访问的入口也在候选列表中
  add(origin, classifyEndpointType(origin, ep))
  return list
}

async function probeSingleEndpoint(candidate) {
  if (!candidate.isCurrent && isMixedContentUrl(candidate.url)) {
    return {
      ...candidate,
      status: 'mixed-content',
      rttMs: null,
      data: null,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const startedAt = performance.now()
  try {
    const res = await fetch(`${candidate.url}/_dshx/api/health`, {
      method: 'GET',
      cache: 'no-store',
      mode: candidate.isCurrent ? 'same-origin' : 'cors',
      credentials: 'omit',
      signal: controller.signal,
    })
    const rttMs = Math.max(1, Math.round(performance.now() - startedAt))
    if (!res.ok) {
      return { ...candidate, status: 'error', rttMs: null, data: null }
    }
    const data = await res.json().catch(() => null)
    if (!data || data.ok !== true) {
      return { ...candidate, status: 'error', rttMs: null, data: null }
    }
    return { ...candidate, status: 'ok', rttMs, data }
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError'
    return {
      ...candidate,
      status: isTimeout ? 'timeout' : 'error',
      rttMs: null,
      data: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

function canAutoRedirectNow(targetUrl) {
  try {
    const raw = sessionStorage.getItem(REDIRECT_GUARD_KEY)
    if (!raw) return true
    const prev = JSON.parse(raw)
    // 30 秒内不对同一目标重复跳转，避免双链路互相来回重定向形成死循环
    if (Date.now() - Number(prev.ts || 0) < 30000) return false
    if (prev.from === targetUrl && Date.now() - Number(prev.ts || 0) < 120000) return false
  } catch {
    return true
  }
  return true
}

function redirectToEndpoint(targetOrigin) {
  const clean = normalizeOrigin(targetOrigin)
  if (!clean || clean === window.location.origin) return
  try {
    sessionStorage.setItem(
      REDIRECT_GUARD_KEY,
      JSON.stringify({ from: window.location.origin, to: clean, ts: Date.now() })
    )
  } catch {
    // 忽略
  }
  window.location.href = `${clean}/_dshx/m/`
}

async function probeHostRoutes({ allowAutoSwitch = false, manual = false } = {}) {
  if (state.probing) return state.probeResults
  state.probing = true
  renderConnectionChip()
  renderEndpointsPanel()

  const host = getCurrentHostRecord()
  const candidates = buildCandidateEndpoints(host)
  const results = await Promise.all(candidates.map(probeSingleEndpoint))

  // 用当前端点的健康检查结果顺手刷新 host 元信息与隧道公网地址
  const curRes = results.find((r) => r.isCurrent)
  if (curRes && curRes.status === 'ok' && curRes.data) {
    state.health = curRes.data
    const discoveredTunnel = normalizeOrigin(curRes.data.tunnel?.publicUrl || '')
    if (discoveredTunnel && state.authenticated) {
      upsertSavedHost(state.hosts, {
        hostId: curRes.data.hostId || host.hostId,
        hostName: curRes.data.hostName || host.hostName,
        endpoints: { tunnel: discoveredTunnel },
      })
      saveHosts(state.hosts)
    }
  }

  state.probeResults = results
  state.probing = false

  renderConnectionChip()
  renderEndpointsPanel()
  evaluateSmartRouteBanner({ allowAutoSwitch })
  renderFooterNote()

  if (manual) showToast(t('probeDone'))
  return results
}

function evaluateSmartRouteBanner({ allowAutoSwitch = false } = {}) {
  if (!state.authenticated || state.pairModalOpen) {
    el.routeBanner.hidden = true
    return
  }

  const results = state.probeResults
  const current = results.find((r) => r.isCurrent)
  const reachable = results
    .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
    .sort((a, b) => a.rttMs - b.rttMs)
  const best = reachable[0] || null

  // 情况 1：当前链路不可达，但其他链路可用 -> 立即提示切换（允许自动切换时自动跳转）
  if (current && current.status !== 'ok' && best && !best.isCurrent) {
    if (allowAutoSwitch && canAutoRedirectNow(best.url)) {
      redirectToEndpoint(best.url)
      return
    }
    showRouteBanner({
      warn: true,
      title: t('offlineFallbackTitle'),
      sub: t('offlineFallbackSub', {
        type: linkTypeLabel(best.type),
        rtt: best.rttMs,
        url: best.url,
      }),
      targetUrl: best.url,
      actionLabel: t('switchTo'),
    })
    return
  }

  // 情况 2：当前可达，但发现了显著更快的另一条链路（尤其是从公网隧道回到局域网）
  if (current && current.status === 'ok' && best && !best.isCurrent) {
    const isLanUpgrade = best.type === 'lan' && current.type !== 'lan' && best.rttMs < current.rttMs
    const isMuchFaster = current.rttMs - best.rttMs >= 30 && best.rttMs < current.rttMs * 0.7
    if (isLanUpgrade || isMuchFaster) {
      if (allowAutoSwitch && state.autoSwitch && canAutoRedirectNow(best.url)) {
        redirectToEndpoint(best.url)
        return
      }
      if (state.bannerDismissedUrl !== best.url) {
        showRouteBanner({
          warn: false,
          title: t('fasterRouteTitle', { type: linkTypeLabel(best.type) }),
          sub: t('fasterRouteSub', { bestRtt: best.rttMs, curRtt: current.rttMs }),
          targetUrl: best.url,
          actionLabel: t('switchTo'),
        })
        return
      }
    }
  }

  el.routeBanner.hidden = true
}

function showRouteBanner({ warn, title, sub, targetUrl, actionLabel }) {
  el.routeBanner.className = warn ? 'route-banner warn' : 'route-banner'
  el.routeBannerTitle.textContent = title
  el.routeBannerSub.textContent = sub
  el.routeBannerActions.replaceChildren(
    createEl('a', {
      class: 'btn btn-sm btn-primary',
      href: `${targetUrl}/_dshx/m/`,
      text: actionLabel,
    }),
    createEl('button', {
      type: 'button',
      class: 'btn btn-sm btn-ghost',
      text: t('dismiss'),
      onClick: () => {
        state.bannerDismissedUrl = targetUrl
        el.routeBanner.hidden = true
      },
    })
  )
  el.routeBanner.hidden = false
}

// ===== 业务数据加载 =====

async function loadInstances({ silent = false } = {}) {
  if (!state.authenticated) return
  if (!silent && !state.instancesLoaded) {
    renderInstancesLoading()
  }
  try {
    const data = await apiFetch('/_dshx/api/instances')
    state.launches = Array.isArray(data.launches) ? data.launches : []
    state.instances = Array.isArray(data.instances) ? data.instances : []
    state.activeInstanceKey = String(data.activeInstanceKey || '')
    state.instancesLoaded = true
    state.instancesError = ''
    syncLogInstanceSelection()
    renderInstancesTab()
  } catch (err) {
    if (err && err.status === 401) return
    state.instancesError = err?.message || 'Network error'
    state.instancesLoaded = true
    renderInstancesTab()
  }
}

function syncLogInstanceSelection() {
  const keys = state.instances.map((i) => i.key)
  if (state.selectedLogKey && keys.includes(state.selectedLogKey)) {
    renderLogInstanceSelect()
    return
  }
  const preferred =
    (state.activeInstanceKey && keys.includes(state.activeInstanceKey) && state.activeInstanceKey) ||
    keys[0] ||
    ''
  state.selectedLogKey = preferred
  if (preferred) lsSet(STORAGE.lastLogKey, preferred)
  renderLogInstanceSelect()
}

async function loadLogs({ silent = false } = {}) {
  if (!state.authenticated) return
  const key = state.selectedLogKey
  if (!key) {
    state.logLines = []
    renderLogsOutput()
    return
  }
  if (!silent) {
    state.logLoading = true
    el.logRefreshBtn.classList.add('spinning')
  }
  try {
    const data = await apiFetch(`/_dshx/api/logs?key=${encodeURIComponent(key)}&limit=150`)
    const rawLines = Array.isArray(data.lines) ? data.lines : []
    state.logLines = rawLines.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const prefix = item.ts ? `[${item.ts}] ` : ''
        return `${prefix}${item.text ?? item.line ?? item.message ?? JSON.stringify(item)}`
      }
      return String(item)
    })
    renderLogsOutput()
  } catch (err) {
    if (err && err.status === 401) return
    if (!silent) showToast(t('actionFailed', { msg: err.message || 'Error' }), { error: true })
  } finally {
    state.logLoading = false
    el.logRefreshBtn.classList.remove('spinning')
  }
}

async function loadDevices() {
  if (!state.authenticated) return
  try {
    const data = await apiFetch('/_dshx/api/devices')
    state.devices = Array.isArray(data.devices) ? data.devices : []
    state.devicesLoaded = true
    renderDevicesList()
  } catch (err) {
    if (err && err.status === 401) return
    showToast(t('actionFailed', { msg: err.message || 'Error' }), { error: true })
  }
}

async function refreshCurrentTab({ manual = false } = {}) {
  if (!state.authenticated) return
  if (manual) el.refreshBtn.classList.add('spinning')
  try {
    const jobs = [loadInstances({ silent: true })]
    if (state.activeTab === 'logs') jobs.push(loadLogs({ silent: !manual }))
    if (state.activeTab === 'settings') jobs.push(loadDevices())
    if (manual) jobs.push(probeHostRoutes({ allowAutoSwitch: false, manual: false }))
    await Promise.all(jobs)
  } finally {
    el.refreshBtn.classList.remove('spinning')
  }
}

function startPolling() {
  stopPolling()
  state.instancesTimer = setInterval(() => {
    if (document.hidden || !state.authenticated) return
    if (state.activeTab === 'instances') loadInstances({ silent: true })
  }, INSTANCES_POLL_MS)

  state.logsTimer = setInterval(() => {
    if (document.hidden || !state.authenticated) return
    if (state.activeTab === 'logs' && state.logAutoRefresh && state.selectedLogKey) {
      loadLogs({ silent: true })
    }
  }, LOGS_POLL_MS)
}

function stopPolling() {
  if (state.instancesTimer) clearInterval(state.instancesTimer)
  if (state.logsTimer) clearInterval(state.logsTimer)
  state.instancesTimer = null
  state.logsTimer = null
}

// ===== 实例操作 =====

async function startLaunch(launch) {
  const idKey = launch.id || `${launch.version}@${launch.profile}`
  if (state.pendingStartIds.has(idKey)) return
  state.pendingStartIds.add(idKey)
  renderInstancesTab()
  try {
    const payload = launch.id
      ? { launchId: launch.id }
      : { version: launch.version, profile: launch.profile }
    await apiFetch('/_dshx/api/instances/start', { method: 'POST', body: payload })
    showToast(t('instanceStarted'))
    await loadInstances({ silent: true })
  } catch (err) {
    if (err && err.status !== 401) {
      showToast(t('actionFailed', { msg: err.message || 'Error' }), { error: true })
    }
  } finally {
    state.pendingStartIds.delete(idKey)
    renderInstancesTab()
  }
}

async function stopInstance(inst) {
  const displayName = `${inst.version || ''} · ${inst.profile || ''}`.replace(/^\s*·\s*|\s*·\s*$/g, '') || inst.key
  const ok = await askConfirm({
    title: t('stopConfirmTitle'),
    body: t('stopConfirmBody', { name: displayName }),
    okText: t('stop'),
    danger: true,
  })
  if (!ok) return

  state.pendingStopKeys.add(inst.key)
  renderInstancesTab()
  try {
    await apiFetch('/_dshx/api/instances/stop', { method: 'POST', body: { key: inst.key } })
    showToast(t('instanceStopped'))
    await loadInstances({ silent: true })
  } catch (err) {
    if (err && err.status !== 401) {
      showToast(t('actionFailed', { msg: err.message || 'Error' }), { error: true })
    }
  } finally {
    state.pendingStopKeys.delete(inst.key)
    renderInstancesTab()
  }
}

// ===== 设备吊销与退出 =====

async function revokeDevice(dev) {
  const isSelf = Boolean(dev.current || (state.me?.device?.deviceId && dev.deviceId === state.me.device.deviceId))
  const ok = await askConfirm({
    title: t('revokeConfirmTitle'),
    body: isSelf
      ? t('revokeSelfConfirmBody')
      : t('revokeConfirmBody', { name: dev.deviceName || dev.deviceId }),
    okText: t('revoke'),
    danger: true,
  })
  if (!ok) return

  try {
    await apiFetch(`/_dshx/api/devices/${encodeURIComponent(dev.deviceId)}`, { method: 'DELETE' })
    showToast(t('deviceRevoked'))
    if (isSelf) {
      state.authenticated = false
      state.me = null
      stopPolling()
      showPairView({ modal: false })
      return
    }
    await loadDevices()
  } catch (err) {
    if (err && err.status !== 401) {
      showToast(t('actionFailed', { msg: err.message || 'Error' }), { error: true })
    }
  }
}

async function unpairSelf() {
  const curId = state.me?.device?.deviceId || state.devices.find((d) => d.current)?.deviceId
  if (curId) {
    await revokeDevice({ deviceId: curId, deviceName: state.me?.device?.deviceName || '', current: true })
    return
  }
  state.authenticated = false
  state.me = null
  stopPolling()
  showPairView({ modal: false })
}

// ===== 配对视图与提交 =====

function updatePairServerHint() {
  const val = el.pairServerUrlInput.value.trim()
  const targetOrigin = normalizeOrigin(val)
  if (targetOrigin && targetOrigin !== window.location.origin) {
    el.pairServerHint.textContent = t('serverUrlHintCross')
  } else {
    el.pairServerHint.textContent = t('serverUrlHintCurrent', { origin: window.location.origin })
  }
}

function showPairView({ modal = false, pairPayload = null, errorMessage = '' } = {}) {
  state.pairModalOpen = modal
  el.pairView.hidden = false
  el.pairView.classList.toggle('as-modal', modal)
  el.pairTopbar.hidden = modal
  el.pairCloseBtn.hidden = !modal
  el.consoleShell.hidden = !modal

  el.pairTitle.textContent = modal ? t('pairAddTitle') : t('pairTitle')
  el.pairSubtitle.textContent = t('pairSubtitle')

  if (pairPayload && pairPayload.code) {
    el.pairCodeInput.value = pairPayload.code
    el.pairAutoNotice.hidden = false
    el.pairAutoNoticeText.textContent = pairPayload.hostName
      ? t('pairAutoRecognizedHost', { host: pairPayload.hostName })
      : t('pairAutoRecognized')
    if (pairPayload.deviceName) {
      el.pairDeviceNameInput.value = pairPayload.deviceName
    }
    if (pairPayload.serverUrl && pairPayload.serverUrl !== window.location.origin) {
      el.pairServerUrlInput.value = pairPayload.serverUrl
    }
  } else {
    if (modal) {
      el.pairCodeInput.value = ''
      el.pairServerUrlInput.value = ''
    }
    el.pairAutoNotice.hidden = true
  }

  if (!el.pairDeviceNameInput.value.trim()) {
    el.pairDeviceNameInput.value = deviceProfile.defaultName
  }

  if (errorMessage) {
    el.pairError.textContent = errorMessage
    el.pairError.hidden = false
  } else {
    el.pairError.hidden = true
    el.pairError.textContent = ''
  }

  updatePairServerHint()
  renderPairSavedHosts()
}

function hidePairView() {
  state.pairModalOpen = false
  el.pairView.hidden = true
  el.consoleShell.hidden = false
}

async function handlePairSubmit(event) {
  event.preventDefault()
  el.pairError.hidden = true

  const code = el.pairCodeInput.value.trim()
  const deviceName = el.pairDeviceNameInput.value.trim() || deviceProfile.defaultName
  const rawServer = el.pairServerUrlInput.value.trim()

  if (!code) {
    el.pairError.textContent = t('pairFailed')
    el.pairError.hidden = false
    return
  }

  if (rawServer) {
    const targetOrigin = normalizeOrigin(rawServer)
    if (!targetOrigin) {
      el.pairError.textContent = t('invalidUrl')
      el.pairError.hidden = false
      return
    }
    // 跨主机配对必须跳转到目标源发起同源 POST，否则浏览器不会为目标域种下 SameSite=Lax HttpOnly Cookie
    if (targetOrigin !== window.location.origin) {
      const target = new URL('/_dshx/m/', targetOrigin)
      target.searchParams.set('pair', code)
      target.searchParams.set('name', deviceName)
      window.location.href = target.toString()
      return
    }
  }

  el.pairSubmitBtn.disabled = true
  el.pairSubmitBtn.textContent = t('pairing')

  try {
    const data = await apiFetch('/_dshx/api/pair/complete', {
      method: 'POST',
      skipAuthHandling: true,
      body: {
        code,
        deviceName,
        platform: deviceProfile.platform,
        deviceKey: state.deviceKey,
      },
    })

    const qrEndpoints = state.pendingUrlPair?.endpoints || {}
    const hostInfo = data.host || {}
    const mergedHost = upsertSavedHost(state.hosts, {
      hostId: hostInfo.hostId || state.pendingUrlPair?.hostId || state.health?.hostId || window.location.origin,
      hostName: hostInfo.hostName || state.pendingUrlPair?.hostName || state.health?.hostName || t('defaultHostName'),
      endpoints: {
        lan: hostInfo.endpoints?.lan || qrEndpoints.lan || '',
        tunnel: hostInfo.endpoints?.tunnel || qrEndpoints.tunnel || state.health?.tunnel?.publicUrl || '',
        custom: hostInfo.endpoints?.custom || qrEndpoints.custom || '',
      },
    })
    saveHosts(state.hosts)

    state.pendingUrlPair = null
    state.authenticated = true
    state.me = {
      device: data.device || null,
      host: mergedHost,
    }

    el.pairCodeInput.value = ''
    hidePairView()
    showToast(t('pairSuccess'))
    await enterAuthenticatedConsole()
  } catch (err) {
    if (err && err.status === 429) {
      el.pairError.textContent = t('rateLimited', { s: err.retryAfterSec || 30 })
    } else {
      el.pairError.textContent = (err && err.message && err.status >= 400 && err.status < 500)
        ? err.message
        : t('pairFailed')
    }
    el.pairError.hidden = false
  } finally {
    el.pairSubmitBtn.disabled = false
    el.pairSubmitBtn.textContent = t('pairSubmit')
  }
}

// ===== 渲染函数 =====

function renderHostSelect() {
  const origin = normalizeOrigin(window.location.origin)
  const currentHost = getCurrentHostRecord()
  const options = []

  const list = state.hosts.length ? state.hosts : [currentHost]
  for (const h of list) {
    const isCur = h.hostId === currentHost.hostId || hostContainsOrigin(h, origin)
    const opt = createEl('option', {
      value: h.hostId,
      text: h.hostName || h.activeEndpoint || t('defaultHostName'),
      selected: isCur,
    })
    options.push(opt)
  }

  options.push(createEl('option', {
    value: '__add__',
    text: t('addNewHostOption'),
  }))

  el.hostSelect.replaceChildren(...options)
}

function renderConnectionChip() {
  const current = state.probeResults.find((r) => r.isCurrent)
  const host = getCurrentHostRecord()
  const curType = current?.type || classifyEndpointType(window.location.origin, host.endpoints)

  if (state.probing && !current) {
    el.connDot.className = 'conn-dot probing'
    el.connLabel.textContent = t('connecting')
    el.connRtt.textContent = ''
    return
  }

  if (current && current.status === 'ok') {
    el.connDot.className = 'conn-dot online'
    el.connLabel.textContent = linkTypeLabel(curType)
    el.connRtt.textContent = `${current.rttMs}ms`
    return
  }

  if (current && current.status !== 'ok') {
    el.connDot.className = 'conn-dot offline'
    el.connLabel.textContent = t('offline')
    el.connRtt.textContent = ''
    return
  }

  el.connDot.className = state.authenticated ? 'conn-dot online' : 'conn-dot probing'
  el.connLabel.textContent = linkTypeLabel(curType)
  el.connRtt.textContent = ''
}

function renderInstancesLoading() {
  el.runningList.replaceChildren(
    createEl('div', { class: 'skeleton-card' }),
    createEl('div', { class: 'skeleton-card' })
  )
  el.launchesList.replaceChildren(createEl('div', { class: 'skeleton-card' }))
}

function renderInstancesTab() {
  el.runningCount.textContent = String(state.instances.length)
  el.launchesCount.textContent = String(state.launches.length)

  if (state.instancesError && !state.instances.length && !state.launches.length) {
    el.runningList.replaceChildren(
      createEl('div', { class: 'empty-state' }, [
        createEl('p', { class: 'empty-title', text: t('loadFailedTitle') }),
        createEl('p', { class: 'empty-desc', text: state.instancesError }),
        createEl('button', {
          type: 'button',
          class: 'btn btn-sm btn-primary',
          text: t('retry'),
          onClick: () => loadInstances(),
        }),
      ])
    )
    el.launchesList.replaceChildren()
    return
  }

  // 渲染运行中实例
  if (!state.instances.length) {
    el.runningList.replaceChildren(
      createEl('div', { class: 'empty-state' }, [
        createEl('p', { class: 'empty-title', text: t('noRunningTitle') }),
        createEl('p', { class: 'empty-desc', text: t('noRunningDesc') }),
      ])
    )
  } else {
    const nodes = state.instances.map((inst) => {
      const isActive = Boolean(inst.active || (state.activeInstanceKey && inst.key === state.activeInstanceKey))
      const isReady = inst.ready !== false
      const isStopping = state.pendingStopKeys.has(inst.key)
      const target = formatTargetInfo(inst.target)
      const titleText =
        inst.version && inst.profile ? `${inst.version} · ${inst.profile}` : (inst.key || 'DSH')
      const uptime = formatRelativeDuration(inst.startedAt)

      const badges = [
        createEl('span', { class: `badge ${target.cls}`, text: target.label }),
        createEl('span', { class: `badge ${isReady ? 'status-running' : 'status-starting'}` }, [
          createEl('span', { class: 'badge-dot' }),
          isReady ? t('statusRunning') : t('statusStarting'),
        ]),
      ]
      if (isActive) {
        badges.push(createEl('span', { class: 'badge status-active', text: t('statusActive') }))
      }

      const openHref = `/_dshx/open/${encodeURIComponent(inst.key)}`

      return createEl('article', { class: `card instance-card${isActive ? ' is-active' : ''}` }, [
        createEl('div', { class: 'instance-top' }, [
          createEl('div', { class: 'instance-title-group' }, [
            createEl('h3', { class: 'instance-name', text: titleText }),
            createEl('div', { class: 'meta-row' }, badges),
            uptime
              ? createEl('div', { class: 'instance-sub', text: `${t('uptimePrefix')} ${uptime}` })
              : null,
          ]),
        ]),
        createEl('div', { class: 'instance-actions' }, [
          createEl('a', {
            class: 'btn btn-primary',
            href: openHref,
          }, [
            createSvgIcon(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']),
            t('enterDsh'),
          ]),
          createEl('button', {
            type: 'button',
            class: 'btn btn-ghost btn-icon-only',
            title: t('viewLogs'),
            'aria-label': t('viewLogs'),
            onClick: () => {
              state.selectedLogKey = inst.key
              lsSet(STORAGE.lastLogKey, inst.key)
              switchTab('logs')
            },
          }, [
            createSvgIcon(['M4 17l6-6-6-6', 'M12 19h8']),
          ]),
          createEl('button', {
            type: 'button',
            class: 'btn btn-danger',
            disabled: isStopping,
            text: isStopping ? t('stopping') : t('stop'),
            onClick: () => stopInstance(inst),
          }),
        ]),
      ])
    })
    el.runningList.replaceChildren(...nodes)
  }

  // 渲染已配置启动项
  if (!state.launches.length) {
    el.launchesList.replaceChildren(
      createEl('div', { class: 'empty-state' }, [
        createEl('p', { class: 'empty-title', text: t('noLaunchesTitle') }),
        createEl('p', { class: 'empty-desc', text: t('noLaunchesDesc') }),
      ])
    )
  } else {
    const nodes = state.launches.map((launch) => {
      const idKey = launch.id || `${launch.version}@${launch.profile}`
      const isStarting = state.pendingStartIds.has(idKey)
      const isRunning = Boolean(launch.runningKey)
      const target = formatTargetInfo(launch.target)
      const name = launch.name || `${launch.version || ''} · ${launch.profile || ''}`.trim()

      const meta = [
        launch.version ? createEl('span', { class: 'badge mono', text: launch.version }) : null,
        launch.profile ? createEl('span', { class: 'badge', text: launch.profile }) : null,
        createEl('span', { class: `badge ${target.cls}`, text: target.label }),
        isRunning
          ? createEl('span', { class: 'badge status-running' }, [
              createEl('span', { class: 'badge-dot' }),
              t('statusRunning'),
            ])
          : null,
      ]

      const actionBtn = isRunning
        ? createEl('a', {
            class: 'btn btn-primary',
            href: `/_dshx/open/${encodeURIComponent(launch.runningKey)}`,
            text: t('enterDsh'),
          })
        : createEl('button', {
            type: 'button',
            class: 'btn btn-primary',
            disabled: isStarting,
            text: isStarting ? t('starting') : t('start'),
            onClick: () => startLaunch(launch),
          })

      return createEl('article', { class: 'card instance-card' }, [
        createEl('div', { class: 'instance-top' }, [
          createEl('div', { class: 'instance-title-group' }, [
            createEl('h3', { class: 'instance-name', text: name }),
            createEl('div', { class: 'meta-row' }, meta),
          ]),
        ]),
        createEl('div', { class: 'instance-actions' }, [actionBtn]),
      ])
    })
    el.launchesList.replaceChildren(...nodes)
  }
}

function renderLogInstanceSelect() {
  if (!state.instances.length) {
    el.logInstanceSelect.replaceChildren(
      createEl('option', { value: '', text: t('noLogsInstance') })
    )
    el.logInstanceSelect.disabled = true
    return
  }
  el.logInstanceSelect.disabled = false
  const opts = state.instances.map((inst) => {
    const label = inst.version && inst.profile ? `${inst.version} · ${inst.profile}` : inst.key
    return createEl('option', {
      value: inst.key,
      text: label,
      selected: inst.key === state.selectedLogKey,
    })
  })
  el.logInstanceSelect.replaceChildren(...opts)
}

function renderLogsOutput() {
  el.logAutoRefreshBtn.setAttribute('aria-pressed', String(state.logAutoRefresh))
  el.logAutoScrollBtn.setAttribute('aria-pressed', String(state.logAutoScroll))
  el.logMetaKey.textContent = state.selectedLogKey || '—'
  el.logMetaLines.textContent = t('linesCount', { n: state.logLines.length })

  if (!state.selectedLogKey) {
    el.logOutput.textContent = t('noLogsInstance')
    return
  }
  el.logOutput.textContent = state.logLines.length ? state.logLines.join('\n') : t('logsEmpty')
  if (state.logAutoScroll) {
    el.logOutput.scrollTop = el.logOutput.scrollHeight
  }
}

function renderEndpointsPanel() {
  const host = getCurrentHostRecord()
  const candidates = buildCandidateEndpoints(host)
  const resultMap = new Map(state.probeResults.map((r) => [r.url, r]))
  const okResults = state.probeResults
    .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
    .sort((a, b) => a.rttMs - b.rttMs)
  const fastestUrl = okResults.length > 1 ? okResults[0].url : ''

  el.probeRoutesBtn.disabled = state.probing
  const probeLabel = el.probeRoutesBtn.querySelector('[data-i18n]')
  if (probeLabel) probeLabel.textContent = state.probing ? t('probing') : t('probeRoutes')

  // 用户正在输入自定义地址时不覆写输入框，避免后台刷新打断输入
  if (document.activeElement !== el.customEndpointInput) {
    el.customEndpointInput.value = host.endpoints?.custom || ''
  }
  el.autoSwitchToggle.checked = state.autoSwitch

  if (!candidates.length) {
    el.endpointsList.replaceChildren(
      createEl('div', { class: 'list-row' }, [
        createEl('span', { class: 'row-sub', text: t('noEndpoints') }),
      ])
    )
    return
  }

  const rows = candidates.map((c) => {
    const res = resultMap.get(c.url)
    const badges = [createEl('span', { class: 'badge', text: linkTypeLabel(c.type) })]
    if (c.isCurrent) {
      badges.push(createEl('span', { class: 'badge status-active', text: t('currentRoute') }))
    }
    if (fastestUrl && c.url === fastestUrl) {
      badges.push(createEl('span', { class: 'badge status-running', text: t('fastestRoute') }))
    }

    let statusBadge = null
    if (state.probing && !res) {
      statusBadge = createEl('span', { class: 'badge', text: t('probing') })
    } else if (res) {
      if (res.status === 'ok') {
        statusBadge = createEl('span', { class: 'badge status-running mono', text: `${res.rttMs}ms` })
      } else if (res.status === 'mixed-content') {
        statusBadge = createEl('span', { class: 'badge status-starting', text: 'HTTPS→HTTP' })
      } else if (res.status === 'timeout') {
        statusBadge = createEl('span', { class: 'badge status-danger', text: t('routeTimeout') })
      } else {
        statusBadge = createEl('span', { class: 'badge status-danger', text: t('routeUnreachable') })
      }
    }
    if (statusBadge) badges.push(statusBadge)

    const actionNodes = []
    if (!c.isCurrent) {
      actionNodes.push(
        createEl('a', {
          class: 'btn btn-sm btn-ghost',
          href: `${c.url}/_dshx/m/`,
          text: res?.status === 'mixed-content' ? t('openDirect') : t('switchTo'),
        })
      )
    }

    return createEl('div', { class: 'list-row' }, [
      createEl('div', { class: 'row-info' }, [
        createEl('div', { class: 'row-title' }, badges),
        createEl('div', { class: 'row-sub', text: c.url }),
        res?.status === 'mixed-content'
          ? createEl('div', { class: 'row-sub', text: t('routeMixedContent') })
          : null,
      ]),
      actionNodes.length ? createEl('div', { class: 'row-actions' }, actionNodes) : null,
    ])
  })

  el.endpointsList.replaceChildren(...rows)
}

function renderDevicesList() {
  el.devicesCount.textContent = String(state.devices.length)
  if (!state.devices.length) {
    el.devicesList.replaceChildren(
      createEl('div', { class: 'list-row' }, [
        createEl('span', { class: 'row-sub', text: t('noDevices') }),
      ])
    )
    return
  }

  const rows = state.devices.map((dev) => {
    const isSelf = Boolean(dev.current || (state.me?.device?.deviceId && dev.deviceId === state.me.device.deviceId))
    const titleChildren = [
      createEl('span', { text: dev.deviceName || dev.deviceId }),
      dev.platform ? createEl('span', { class: 'badge', text: String(dev.platform).toUpperCase() }) : null,
      isSelf ? createEl('span', { class: 'badge status-active', text: t('thisDevice') }) : null,
    ]

    const subParts = []
    if (dev.lastSeenAt) subParts.push(`${t('lastActive')} ${formatRelativeDuration(dev.lastSeenAt)}`)
    if (dev.lastSeenIP) subParts.push(dev.lastSeenIP)
    if (!subParts.length && dev.createdAt) {
      subParts.push(`${t('pairedAt')} ${formatRelativeDuration(dev.createdAt)}`)
    }

    return createEl('div', { class: 'list-row' }, [
      createEl('div', { class: 'row-info' }, [
        createEl('div', { class: 'row-title' }, titleChildren),
        createEl('div', { class: 'row-sub', text: subParts.join(' · ') || dev.deviceId }),
      ]),
      createEl('div', { class: 'row-actions' }, [
        createEl('button', {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          text: t('revoke'),
          onClick: () => revokeDevice(dev),
        }),
      ]),
    ])
  })

  el.devicesList.replaceChildren(...rows)
}

function renderSavedHostsList() {
  const origin = normalizeOrigin(window.location.origin)
  if (!state.hosts.length) {
    el.hostsList.replaceChildren(
      createEl('div', { class: 'list-row' }, [
        createEl('span', { class: 'row-sub', text: t('noSavedHosts') }),
      ])
    )
    return
  }

  const rows = state.hosts.map((host) => {
    const isCurrent = hostContainsOrigin(host, origin)
    const target = host.activeEndpoint || host.endpoints?.lan || host.endpoints?.tunnel || host.endpoints?.custom
    return createEl('div', { class: 'list-row' }, [
      createEl('div', { class: 'row-info' }, [
        createEl('div', { class: 'row-title' }, [
          createEl('span', { text: host.hostName || t('defaultHostName') }),
          isCurrent ? createEl('span', { class: 'badge status-active', text: t('currentRoute') }) : null,
        ]),
        createEl('div', { class: 'row-sub', text: target || host.hostId }),
      ]),
      createEl('div', { class: 'row-actions' }, [
        !isCurrent && target
          ? createEl('button', {
              type: 'button',
              class: 'btn btn-sm btn-ghost',
              text: t('switchTo'),
              onClick: () => switchToSavedHost(host),
            })
          : null,
        !isCurrent
          ? createEl('button', {
              type: 'button',
              class: 'btn btn-sm btn-danger',
              text: t('removeHost'),
              onClick: async () => {
                const ok = await askConfirm({
                  title: t('removeHostTitle'),
                  body: t('removeHostBody', { name: host.hostName || target || host.hostId }),
                  okText: t('removeHost'),
                  danger: true,
                })
                if (!ok) return
                state.hosts = state.hosts.filter((h) => h.hostId !== host.hostId)
                saveHosts(state.hosts)
                showToast(t('hostRemoved'))
                renderHostSelect()
                renderSavedHostsList()
                renderPairSavedHosts()
              },
            })
          : null,
      ]),
    ])
  })

  el.hostsList.replaceChildren(...rows)
}

function renderPairSavedHosts() {
  const origin = normalizeOrigin(window.location.origin)
  const others = state.hosts.filter((h) => !hostContainsOrigin(h, origin))
  if (state.pairModalOpen || !others.length) {
    el.pairSavedHostsBox.hidden = true
    return
  }
  el.pairSavedHostsBox.hidden = false
  const rows = others.map((host) => {
    const target = host.activeEndpoint || host.endpoints?.tunnel || host.endpoints?.lan || host.endpoints?.custom
    return createEl('div', { class: 'list-row' }, [
      createEl('div', { class: 'row-info' }, [
        createEl('div', { class: 'row-title', text: host.hostName || t('defaultHostName') }),
        createEl('div', { class: 'row-sub', text: target || host.hostId }),
      ]),
      target
        ? createEl('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            text: t('switchTo'),
            onClick: () => switchToSavedHost(host),
          })
        : null,
    ])
  })
  el.pairSavedHostsList.replaceChildren(...rows)
}

async function switchToSavedHost(host) {
  const candidates = [
    host.endpoints?.lan,
    host.endpoints?.custom,
    host.endpoints?.tunnel,
    host.activeEndpoint,
  ]
    .map(normalizeOrigin)
    .filter((u, i, arr) => u && arr.indexOf(u) === i)

  if (!candidates.length) return
  if (candidates.length === 1) {
    redirectToEndpoint(candidates[0])
    return
  }

  // 切换多主机时优先并发探测未受混合内容阻拦的端点，跳到最快可达地址
  const probeCandidates = candidates.map((url) => ({
    url,
    type: classifyEndpointType(url, host.endpoints),
    isCurrent: url === window.location.origin,
  }))
  const results = await Promise.all(probeCandidates.map(probeSingleEndpoint))
  const fastest = results
    .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
    .sort((a, b) => a.rttMs - b.rttMs)[0]

  redirectToEndpoint(fastest ? fastest.url : (host.activeEndpoint || candidates[0]))
}

function renderFooterNote() {
  const parts = []
  if (state.health?.version) {
    parts.push(t('footerVersion', { version: state.health.version }))
  }
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  if (!standalone) {
    parts.push(t('footerPwaHint'))
  }
  el.appFooterNote.textContent = parts.join(' · ')
}

function renderAll() {
  renderHostSelect()
  renderConnectionChip()
  renderInstancesTab()
  renderLogInstanceSelect()
  renderLogsOutput()
  renderEndpointsPanel()
  renderDevicesList()
  renderSavedHostsList()
  renderPairSavedHosts()
  renderFooterNote()
}

// ===== Tab 切换 =====

function switchTab(tab) {
  if (!['instances', 'logs', 'settings'].includes(tab)) return
  state.activeTab = tab
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab))
  })
  document.getElementById('panel-instances').hidden = tab !== 'instances'
  document.getElementById('panel-logs').hidden = tab !== 'logs'
  document.getElementById('panel-settings').hidden = tab !== 'settings'

  if (tab === 'logs') {
    loadLogs()
  } else if (tab === 'settings') {
    loadDevices()
    renderEndpointsPanel()
    renderSavedHostsList()
  } else if (tab === 'instances') {
    loadInstances({ silent: true })
  }
}

// ===== 复制剪贴板（兼容 HTTP 局域网环境） =====

async function copyTextSafe(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 回落到 execCommand
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

// ===== 启动流程与事件绑定 =====

async function enterAuthenticatedConsole({ keepPairModal = false } = {}) {
  el.consoleShell.hidden = false
  if (!keepPairModal) el.pairView.hidden = true
  renderAll()
  startPolling()
  await Promise.all([
    loadInstances(),
    probeHostRoutes({ allowAutoSwitch: !keepPairModal }),
  ])
}

async function bootstrap() {
  applyTheme(state.theme)
  applyLanguage(state.lang)

  // 注册 Service Worker（限定在 /_dshx/m/ 作用域，绝不接管上游 dsh 路径）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/_dshx/m/sw.js', { scope: '/_dshx/m/' }).catch(() => {})
  }

  state.pendingUrlPair = parseUrlPairing()

  // 并行拉取公开健康信息与当前设备会话状态
  const [healthRes, meRes] = await Promise.allSettled([
    apiFetch('/_dshx/api/health', { skipAuthHandling: true, timeoutMs: 4000 }),
    apiFetch('/_dshx/api/me', { skipAuthHandling: true, timeoutMs: 4000 }),
  ])

  if (healthRes.status === 'fulfilled' && healthRes.value?.ok) {
    state.health = healthRes.value
  }

  // 若携带了 ?pair= 扫码参数，优先弹出配对卡片让用户一键完成/轮换配对
  if (state.pendingUrlPair) {
    if (meRes.status === 'fulfilled' && meRes.value?.device) {
      state.authenticated = true
      state.me = meRes.value
      const hostInfo = meRes.value.host || {}
      upsertSavedHost(state.hosts, {
        hostId: hostInfo.hostId || state.health?.hostId || window.location.origin,
        hostName: hostInfo.hostName || state.health?.hostName || t('defaultHostName'),
        endpoints: {
          lan: hostInfo.endpoints?.lan || '',
          tunnel: hostInfo.endpoints?.tunnel || state.health?.tunnel?.publicUrl || '',
          custom: hostInfo.endpoints?.custom || '',
        },
      })
      saveHosts(state.hosts)
      showPairView({ modal: true, pairPayload: state.pendingUrlPair })
      await enterAuthenticatedConsole({ keepPairModal: true })
    } else {
      showPairView({ modal: false, pairPayload: state.pendingUrlPair })
    }
    return
  }

  if (meRes.status === 'fulfilled' && meRes.value?.device) {
    state.authenticated = true
    state.me = meRes.value
    const hostInfo = meRes.value.host || {}
    upsertSavedHost(state.hosts, {
      hostId: hostInfo.hostId || state.health?.hostId || window.location.origin,
      hostName: hostInfo.hostName || state.health?.hostName || t('defaultHostName'),
      endpoints: {
        lan: hostInfo.endpoints?.lan || '',
        tunnel: hostInfo.endpoints?.tunnel || state.health?.tunnel?.publicUrl || '',
        custom: hostInfo.endpoints?.custom || '',
      },
    })
    saveHosts(state.hosts)
    await enterAuthenticatedConsole()
    return
  }

  // 未认证：进入配对页
  state.authenticated = false
  showPairView({ modal: false })
}

function bindEvents() {
  // 系统暗色偏好变化时跟随更新
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme('auto')
  })

  // 顶部主机切换
  el.hostSelect.addEventListener('change', () => {
    const val = el.hostSelect.value
    if (val === '__add__') {
      renderHostSelect()
      showPairView({ modal: true })
      return
    }
    const targetHost = state.hosts.find((h) => h.hostId === val)
    if (targetHost && !hostContainsOrigin(targetHost, window.location.origin)) {
      switchToSavedHost(targetHost)
    }
  })

  // 顶部连接胶囊点击直达设置里的测速面板
  el.connChip.addEventListener('click', () => {
    switchTab('settings')
    probeHostRoutes({ manual: true })
  })

  el.refreshBtn.addEventListener('click', () => refreshCurrentTab({ manual: true }))

  // 底部 Tab 切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })

  // 日志页交互
  el.logInstanceSelect.addEventListener('change', () => {
    state.selectedLogKey = el.logInstanceSelect.value
    if (state.selectedLogKey) lsSet(STORAGE.lastLogKey, state.selectedLogKey)
    loadLogs()
  })

  el.logRefreshBtn.addEventListener('click', () => loadLogs())

  el.logAutoRefreshBtn.addEventListener('click', () => {
    state.logAutoRefresh = !state.logAutoRefresh
    el.logAutoRefreshBtn.setAttribute('aria-pressed', String(state.logAutoRefresh))
  })

  el.logAutoScrollBtn.addEventListener('click', () => {
    state.logAutoScroll = !state.logAutoScroll
    el.logAutoScrollBtn.setAttribute('aria-pressed', String(state.logAutoScroll))
    if (state.logAutoScroll) {
      el.logOutput.scrollTop = el.logOutput.scrollHeight
    }
  })

  // 用户手动上滑阅读历史日志时暂停自动滚底，拉回底部自动恢复
  el.logOutput.addEventListener('scroll', () => {
    const gap = el.logOutput.scrollHeight - el.logOutput.scrollTop - el.logOutput.clientHeight
    const nearBottom = gap < 28
    if (!nearBottom && state.logAutoScroll) {
      state.logAutoScroll = false
      el.logAutoScrollBtn.setAttribute('aria-pressed', 'false')
    }
  }, { passive: true })

  el.logCopyBtn.addEventListener('click', async () => {
    const text = state.logLines.join('\n')
    const ok = await copyTextSafe(text)
    showToast(ok ? t('logsCopied') : t('logsCopyFailed'), { error: !ok })
  })

  // 设置页：测速选路 & 自定义地址 & 自动切路
  el.probeRoutesBtn.addEventListener('click', () => probeHostRoutes({ allowAutoSwitch: false, manual: true }))

  el.customEndpointForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const raw = el.customEndpointInput.value.trim()
    const norm = raw ? normalizeOrigin(raw) : ''
    if (raw && !norm) {
      showToast(t('invalidUrl'), { error: true })
      return
    }
    const host = getCurrentHostRecord()
    upsertSavedHost(state.hosts, {
      hostId: host.hostId,
      hostName: host.hostName,
      endpoints: { custom: norm },
      overwriteCustom: true,
    })
    saveHosts(state.hosts)
    showToast(t('saved'))
    probeHostRoutes({ allowAutoSwitch: false })
  })

  el.autoSwitchToggle.addEventListener('change', () => {
    state.autoSwitch = el.autoSwitchToggle.checked
    lsSet(STORAGE.autoSwitch, state.autoSwitch ? '1' : '0')
  })

  el.addHostBtn.addEventListener('click', () => showPairView({ modal: true }))
  el.unpairSelfBtn.addEventListener('click', () => unpairSelf())

  // 主题与语言切换
  document.querySelectorAll('[data-theme-opt]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeOpt))
  })
  document.querySelectorAll('[data-lang-opt]').forEach((btn) => {
    btn.addEventListener('click', () => applyLanguage(btn.dataset.langOpt))
  })

  // 配对页顶栏快捷切换
  el.pairLangBtn.addEventListener('click', () => {
    applyLanguage(state.lang === 'zh' ? 'en' : 'zh')
  })
  el.pairThemeBtn.addEventListener('click', () => {
    const isDark = document.documentElement.dataset.colorScheme === 'dark'
    applyTheme(isDark ? 'light' : 'dark')
  })

  el.pairCloseBtn.addEventListener('click', () => {
    if (state.authenticated) hidePairView()
  })
  el.pairView.addEventListener('click', (e) => {
    if (e.target === el.pairView && state.pairModalOpen && state.authenticated) hidePairView()
  })
  el.pairServerUrlInput.addEventListener('input', updatePairServerHint)
  el.pairForm.addEventListener('submit', handlePairSubmit)

  // 确认弹窗
  el.confirmCancelBtn.addEventListener('click', () => closeConfirm(false))
  el.confirmOkBtn.addEventListener('click', () => closeConfirm(true))
  el.confirmDialog.addEventListener('click', (e) => {
    if (e.target === el.confirmDialog) closeConfirm(false)
  })

  // 页面从后台切回前台时立即刷新状态与路由延迟
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.authenticated) {
      refreshCurrentTab({ manual: false })
    }
  })
}

bindEvents()
bootstrap()
