// DSH-X 手机版 PWA 主逻辑（纯原生 ESM，零第三方依赖）
// 负责扫码/手工配对、多主机与多链路并发测速选路、实例启停、日志查看与设备管理。

const STORAGE = {
  deviceKey: 'dshx_mobile_device_key',
  hosts: 'dshx_mobile_hosts_v1',
  activeHostId: 'dshx_mobile_active_host_id',
  theme: 'dshx_mobile_theme',
  lang: 'dshx_mobile_lang',
  autoSwitch: 'dshx_mobile_auto_switch',
  lastLogKey: 'dshx_mobile_last_log_key',
  pwaDismissed: 'dshx_mobile_pwa_dismissed',
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
    footerPwaHint: '提示：可通过下方「安装为手机 App」或浏览器菜单添加到主屏幕',
    pwaInstallTitle: '安装为手机 App（PWA）',
    pwaInstalledToast: '已添加到主屏幕',
    pwaDismiss: '关闭提示',
    pwaClose: '知道了',
    pwaBannerTitleNative: '安装 DSH-X 手机版',
    pwaBannerSubNative: '添加到主屏幕后可全屏独立运行，打开更快',
    pwaBannerBtnNative: '立即安装',
    pwaSettingsDescNative: '支持一键添加到手机桌面，全屏独立运行',
    pwaBannerTitleInApp: '请改用系统浏览器打开',
    pwaBannerSubInApp: '微信、QQ 等内置浏览器不支持安装 PWA，点右上角菜单切换',
    pwaBannerBtnInApp: '查看引导',
    pwaSettingsDescInApp: '当前在应用内浏览器中，需改用 Safari 或 Chrome 安装',
    pwaGuideTitleInApp: '切换系统浏览器以安装 PWA',
    pwaGuideIntroInApp: '内置浏览器不支持安装独立 PWA 应用，请先切换到系统浏览器：',
    pwaGuideInAppStep1: '点击右上角「⋯」或「⋮」菜单按钮',
    pwaGuideInAppStep2: '选择「在 Safari 中打开」或「在默认浏览器打开」',
    pwaGuideInAppStep3: '在系统浏览器打开后，再按「添加到主屏幕」安装',
    pwaGuideInAppNote: '注：长期固定 PWA 建议通过固定 HTTPS 域名访问（可在电脑端「高级设置」配置自建 Worker / Tunnel / 反代）。',
    pwaBannerTitleEphemeral: '临时体验域名不建议安装 PWA',
    pwaBannerSubEphemeralHttps: '*.trycloudflare.com 每次重启都会换新地址，检测到已配置固定 HTTPS，切换后再安装。',
    pwaBannerBtnEphemeralHttps: '切换固定 HTTPS',
    pwaSettingsDescEphemeralHttps: '当前为临时域名；点击切换到固定 HTTPS 地址后可安装 PWA',
    pwaBannerSubEphemeralNoHttps: '*.trycloudflare.com 每次重启都会换新地址，装到桌面的图标下次会打不开；配置固定 HTTPS 域名后再安装。',
    pwaBannerBtnEphemeralNoHttps: '配置说明',
    pwaSettingsDescEphemeralNoHttps: '临时随机域名重启后失效，配置固定 HTTPS 域名后再安装',
    pwaGuideTitleEphemeral: '如何用固定域名安装为手机 PWA',
    pwaGuideIntroEphemeral: 'Cloudflare 临时体验隧道（*.trycloudflare.com）每次重启都会生成新域名；PWA 图标绑定创建时的域名，下次重启就会打不开。配置固定公网域名后即可长期使用：',
    pwaGuideEphemeralStep1: '在电脑端 DSH-X 打开「远程 → 手机访问」，展开「高级设置」',
    pwaGuideEphemeralStep2: '选择「自建 Worker」或「已有 Tunnel」绑定永久域名，或在「自定义公网 HTTPS 地址」填入 Tailscale / 自建反代域名',
    pwaGuideEphemeralStep3: '用手机打开该固定 https:// 地址后，再添加到主屏幕即可长期生效',
    pwaGuideEphemeralNote: '临时体验适合快速扫码试用；需要常驻手机桌面图标时请先固定公网域名。',
    pwaBannerTitleInsecureHttps: '局域网 HTTP 无法安装 PWA',
    pwaBannerSubInsecureHttps: '检测到已配置固定 HTTPS，切换后即可安装为独立 App',
    pwaBannerBtnInsecureHttps: '切换固定 HTTPS',
    pwaSettingsDescInsecureHttps: '手机浏览器要求固定 HTTPS；点击可切换后安装',
    pwaBannerTitleInsecureNoHttps: '为什么没看到 PWA？需要固定 HTTPS',
    pwaBannerSubInsecureNoHttps: '手机浏览器仅在 HTTPS 下启用 PWA，局域网可先添加到浏览器书签',
    pwaBannerBtnInsecureNoHttps: '查看原因',
    pwaSettingsDescInsecureNoHttps: '当前为局域网 HTTP，浏览器已禁用 PWA 安装',
    pwaGuideTitleInsecure: '局域网 HTTP 无法安装 PWA',
    pwaGuideIntroInsecure: '受手机浏览器安全限制，http://192.168.x.x 等局域网 HTTP 地址不会激活 Service Worker 与 PWA 安装（局域网推荐直接收藏书签；如需独立 PWA 请使用固定 HTTPS）：',
    pwaGuideInsecureStep1: '在电脑端 DSH-X 打开「远程 → 手机访问 → 高级设置」',
    pwaGuideInsecureStep2: '配置「自建 Worker」「已有 Tunnel」或固定公网 HTTPS 域名（临时 *.trycloudflare.com 重启会变，不建议用来装 PWA）',
    pwaGuideInsecureStep3: '用手机打开该固定 https:// 链接，即可安装为长期有效的桌面 App',
    pwaGuideInsecureNoteHttps: '检测到可用固定 HTTPS 地址：{url}',
    pwaGuideInsecureExtraBtn: '立即切换固定 HTTPS',
    pwaBannerTitleIosSafari: '添加到主屏幕（PWA）',
    pwaBannerSubIosSafari: '添加到主屏幕后可像原生 App 一样全屏运行',
    pwaBannerBtnIosSafari: '查看步骤',
    pwaSettingsDescIosSafari: '点 Safari 底部「分享」→「添加到主屏幕」即可安装',
    pwaGuideTitleIosSafari: '在 iPhone / iPad 上安装 DSH-X',
    pwaGuideIntroIosSafari: '在 Safari 浏览器中按以下步骤即可安装到主屏幕：',
    pwaGuideIosSafariStep1: '点击浏览器底部的「分享」图标（方框带向上箭头）',
    pwaGuideIosSafariStep2: '在弹出菜单中向下滑，点击「添加到主屏幕」',
    pwaGuideIosSafariStep3: '确认名称后点击右上角「添加」即可完成',
    pwaGuideIosSafariNote: '从主屏幕图标启动后将全屏独立运行，不显示浏览器地址栏。',
    pwaBannerTitleIosOther: '使用 Safari 添加到主屏幕',
    pwaBannerSubIosOther: '在 iOS 上通过分享菜单或 Safari 可安装为独立 App',
    pwaBannerBtnIosOther: '查看步骤',
    pwaSettingsDescIosOther: '点「分享 → 添加到主屏幕」，或改用 Safari 打开',
    pwaGuideTitleIosOther: '在 iOS 浏览器安装 DSH-X',
    pwaGuideIntroIosOther: 'iOS 设备需通过分享菜单或 Safari 将应用安装到主屏幕：',
    pwaGuideIosOtherStep1: '点击地址栏旁或右上角的「分享」按钮',
    pwaGuideIosOtherStep2: '在列表中找到并点击「添加到主屏幕」',
    pwaGuideIosOtherStep3: '若当前浏览器无此选项，请复制地址改用 Safari 打开后重复上述步骤',
    pwaGuideIosOtherNote: '请确保当前使用以 https:// 开头的安全地址访问。',
    pwaBannerTitleManual: '安装 DSH-X 到桌面 / 主屏幕',
    pwaBannerSubManual: '通过浏览器菜单「安装应用 / 添加到主屏幕」即可独立使用',
    pwaBannerBtnManual: '查看步骤',
    pwaSettingsDescManual: '点浏览器右上角菜单选择「安装应用 / 添加到主屏幕」',
    pwaGuideTitleManual: '手动安装 DSH-X PWA',
    pwaGuideIntroManual: '若浏览器未自动弹出安装窗口，可通过菜单手动添加：',
    pwaGuideManualStep1: '点击浏览器右上角菜单图标（⋮ 或 ⋯）',
    pwaGuideManualStep2: '选择「安装应用」或「添加到主屏幕」',
    pwaGuideManualStep3: '在确认框中点击「安装 / 添加」即可在桌面打开',
    pwaGuideManualNote: 'Android 设备建议使用 Chrome 或 Edge，可获得完整独立窗口体验。',
    defaultHostName: 'DSH-X 主机',
    noEndpoints: '暂未获取到链路地址',
    scanQrBtn: '扫码配对',
    scanQrFailed: '扫码失败或未识别到有效配对码',
    scanQrCancelled: '已取消扫码',
    routeSwitched: '已切换至{type}链路',
    nativeOpeningDsh: '正在打开 DSH…',
    nativeOpenFailed: '打开 DSH 失败：{msg}',
    pairServerRequired: '请先扫码或填写主机服务器地址',
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
    footerPwaHint: 'Tip: Use "Install as Mobile App" below or your browser menu for standalone mode',
    pwaInstallTitle: 'Install as Mobile App (PWA)',
    pwaInstalledToast: 'Added to Home Screen',
    pwaDismiss: 'Dismiss',
    pwaClose: 'Got it',
    pwaBannerTitleNative: 'Install DSH-X App',
    pwaBannerSubNative: 'Add to Home Screen for full-screen standalone launch',
    pwaBannerBtnNative: 'Install',
    pwaSettingsDescNative: 'Ready to install to your Home Screen as a standalone app',
    pwaBannerTitleInApp: 'Open in System Browser',
    pwaBannerSubInApp: 'In-app browsers (WeChat/QQ) cannot install PWAs. Use top-right menu.',
    pwaBannerBtnInApp: 'How to Open',
    pwaSettingsDescInApp: 'Opened inside an in-app browser; switch to Safari or Chrome to install',
    pwaGuideTitleInApp: 'Open in System Browser to Install PWA',
    pwaGuideIntroInApp: 'This in-app browser disables PWA installation. Switch to your system browser first:',
    pwaGuideInAppStep1: 'Tap the "⋯" or "⋮" menu button in the top-right corner',
    pwaGuideInAppStep2: 'Choose "Open in Safari" or "Open in Browser"',
    pwaGuideInAppStep3: 'Once opened there, add the page to your Home Screen',
    pwaGuideInAppNote: 'Note: Installing a lasting PWA also requires a stable HTTPS URL (configure Worker / Tunnel / custom HTTPS in desktop Advanced Settings).',
    pwaBannerTitleEphemeral: 'Temporary URL — Not Recommended for PWA',
    pwaBannerSubEphemeralHttps: '*.trycloudflare.com changes on every restart. Switch to your stable HTTPS URL to install.',
    pwaBannerBtnEphemeralHttps: 'Switch Stable HTTPS',
    pwaSettingsDescEphemeralHttps: 'Temporary domain active; switch to your stable HTTPS URL to install PWA',
    pwaBannerSubEphemeralNoHttps: '*.trycloudflare.com changes on every restart, breaking Home Screen icons. Configure a stable HTTPS domain first.',
    pwaBannerBtnEphemeralNoHttps: 'Setup Guide',
    pwaSettingsDescEphemeralNoHttps: 'Random tunnel domain expires on restart; configure a stable HTTPS domain first',
    pwaGuideTitleEphemeral: 'Use a Stable HTTPS Domain for PWA',
    pwaGuideIntroEphemeral: 'Cloudflare Quick Tunnels (*.trycloudflare.com) generate a new URL on every restart. Because a PWA icon stays bound to its creation origin, it stops working after a restart:',
    pwaGuideEphemeralStep1: 'On DSH-X desktop, open Remote → Mobile Access and expand Advanced Settings',
    pwaGuideEphemeralStep2: 'Use a Custom Worker or Named Tunnel for a permanent domain, or enter a Tailscale / reverse-proxy URL under Custom Public HTTPS URL',
    pwaGuideEphemeralStep3: 'Open that fixed https:// URL on your phone and add it to your Home Screen',
    pwaGuideEphemeralNote: 'Quick Tunnels work well for one-off scanning; bind a permanent domain if you want a lasting Home Screen app.',
    pwaBannerTitleInsecureHttps: 'LAN HTTP cannot install PWA',
    pwaBannerSubInsecureHttps: 'Stable HTTPS URL detected — switch over to install as a standalone app',
    pwaBannerBtnInsecureHttps: 'Switch Stable HTTPS',
    pwaSettingsDescInsecureHttps: 'Mobile browsers require stable HTTPS; switch to install PWA',
    pwaBannerTitleInsecureNoHttps: 'Why no PWA? Stable HTTPS required',
    pwaBannerSubInsecureNoHttps: 'Mobile browsers disable PWA over LAN HTTP. Bookmark it, or configure a fixed HTTPS URL.',
    pwaBannerBtnInsecureNoHttps: 'See Why',
    pwaSettingsDescInsecureNoHttps: 'Connected over LAN HTTP; mobile browsers disable PWA install',
    pwaGuideTitleInsecure: 'LAN HTTP Cannot Install PWA',
    pwaGuideIntroInsecure: 'Mobile browsers disable Service Workers and PWA installation on plain LAN HTTP URLs (such as http://192.168.x.x). Add a browser bookmark for LAN access, or set up a stable HTTPS domain for PWA:',
    pwaGuideInsecureStep1: 'On DSH-X desktop, open Remote → Mobile Access → Advanced Settings',
    pwaGuideInsecureStep2: 'Configure a Custom Worker, Named Tunnel, or stable HTTPS domain (avoid installing random *.trycloudflare.com URLs as they expire on restart)',
    pwaGuideInsecureStep3: 'Open that fixed https:// link on your phone to install a permanent PWA',
    pwaGuideInsecureNoteHttps: 'Stable HTTPS URL detected: {url}',
    pwaGuideInsecureExtraBtn: 'Switch to Stable HTTPS',
    pwaBannerTitleIosSafari: 'Add to Home Screen',
    pwaBannerSubIosSafari: 'Install for full-screen native-like experience',
    pwaBannerBtnIosSafari: 'Show Steps',
    pwaSettingsDescIosSafari: 'Tap Share at the bottom of Safari and choose "Add to Home Screen"',
    pwaGuideTitleIosSafari: 'Install DSH-X on iPhone / iPad',
    pwaGuideIntroIosSafari: 'Follow these steps in Safari to install a standalone app icon:',
    pwaGuideIosSafariStep1: 'Tap the Share icon (square with an upward arrow) at the bottom bar',
    pwaGuideIosSafariStep2: 'Scroll down and tap "Add to Home Screen"',
    pwaGuideIosSafariStep3: 'Confirm the name and tap "Add" in the top-right corner',
    pwaGuideIosSafariNote: 'Opening from the Home Screen launches in full-screen standalone mode.',
    pwaBannerTitleIosOther: 'Use Safari to Add to Home Screen',
    pwaBannerSubIosOther: 'Install via the Share menu or reopen this page in Safari',
    pwaBannerBtnIosOther: 'Show Steps',
    pwaSettingsDescIosOther: 'Tap Share → "Add to Home Screen", or open in Safari',
    pwaGuideTitleIosOther: 'Install DSH-X on iOS Browsers',
    pwaGuideIntroIosOther: 'On iOS, installing to Home Screen requires the Share sheet or Safari:',
    pwaGuideIosOtherStep1: 'Tap the Share icon next to the address bar or top bar',
    pwaGuideIosOtherStep2: 'Find and tap "Add to Home Screen" in the sheet',
    pwaGuideIosOtherStep3: 'If the option is missing, copy this link, open it in Safari, and repeat above',
    pwaGuideIosOtherNote: 'Make sure the page URL begins with https://.',
    pwaBannerTitleManual: 'Install DSH-X App',
    pwaBannerSubManual: 'Open your browser menu and select Install App / Add to Home Screen',
    pwaBannerBtnManual: 'Show Steps',
    pwaSettingsDescManual: 'Open browser menu (⋮) and choose "Install app" or "Add to Home Screen"',
    pwaGuideTitleManual: 'Install DSH-X PWA Manually',
    pwaGuideIntroManual: 'If no install prompt popped up automatically, install from the browser menu:',
    pwaGuideManualStep1: 'Tap the browser menu button (⋮ or ⋯) in the top right',
    pwaGuideManualStep2: 'Tap "Install app" or "Add to Home Screen"',
    pwaGuideManualStep3: 'Confirm "Install" or "Add" in the system dialog',
    pwaGuideManualNote: 'Chrome or Edge on Android provides the best standalone PWA experience.',
    defaultHostName: 'DSH-X Host',
    noEndpoints: 'No route URLs configured yet',
    scanQrBtn: 'Scan QR Code',
    scanQrFailed: 'Scan failed or no valid pairing code found',
    scanQrCancelled: 'Scan cancelled',
    routeSwitched: 'Switched to {type} route',
    nativeOpeningDsh: 'Opening DSH…',
    nativeOpenFailed: 'Failed to open DSH: {msg}',
    pairServerRequired: 'Scan a QR code or enter a host server URL first',
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

function getNativeBridge() {
  return window.DSHXNative && window.DSHXNative.isNative ? window.DSHXNative : null
}

function isNativeApp() {
  return Boolean(getNativeBridge())
}

function getActiveOrigin() {
  return isNativeApp() ? normalizeOrigin(state.activeOrigin) : normalizeOrigin(window.location.origin)
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
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan') || h === '[::1]') return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isStandalonePwa() {
  return Boolean(
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true
  )
}

function isEphemeralTunnelHost(hostname) {
  return /\.trycloudflare\.com$/i.test(String(hostname || '').toLowerCase())
}

function isSecurePwaOrigin() {
  return (
    window.location.protocol === 'https:' ||
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(window.location.hostname || '')
  )
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

function parsePairingParams(hashParams, searchParams, fallbackOrigin = '') {
  const getParam = (key) => hashParams.get(key) ?? searchParams.get(key)
  const rawPair = getParam('pair') || getParam('code')
  if (!rawPair) return null

  const result = {
    code: '',
    hostId: '',
    hostName: getParam('hostName') || getParam('host') || '',
    deviceName: getParam('name') || '',
    endpoints: {
      lan: normalizeOrigin(getParam('lan') || ''),
      tunnel: normalizeOrigin(getParam('tunnel') || ''),
      custom: normalizeOrigin(getParam('custom') || ''),
    },
    serverUrl: normalizeOrigin(getParam('server') || fallbackOrigin),
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

  return result.code ? result : null
}

function parsePairingText(rawText) {
  const input = String(rawText || '').trim()
  if (!input) return null

  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input)
      const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''))
      const searchParams = new URLSearchParams(parsed.search)
      return parsePairingParams(hashParams, searchParams, parsed.origin)
    } catch {
      return null
    }
  }

  const decoded = decodeBase64UrlJson(input)
  if (decoded && (decoded.code || decoded.c || decoded.pairCode)) {
    const ep = decoded.endpoints || decoded.e || {}
    return {
      code: String(decoded.code || decoded.c || decoded.pairCode || '').trim(),
      hostId: String(decoded.hostId || decoded.id || '').trim(),
      hostName: String(decoded.hostName || decoded.name || decoded.n || '').trim(),
      deviceName: '',
      endpoints: {
        lan: normalizeOrigin(ep.lan || decoded.lan || ''),
        tunnel: normalizeOrigin(ep.tunnel || decoded.tunnel || ''),
        custom: normalizeOrigin(ep.custom || decoded.custom || ''),
      },
      serverUrl: normalizeOrigin(decoded.url || decoded.server || ''),
    }
  }

  return {
    code: input,
    hostId: '',
    hostName: '',
    deviceName: '',
    endpoints: { lan: '', tunnel: '', custom: '' },
    serverUrl: '',
  }
}

function parseUrlPairing(rawHref = window.location.href) {
  let parsedUrl
  try {
    parsedUrl = new URL(rawHref)
  } catch {
    return null
  }
  const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''))
  const searchParams = new URLSearchParams(parsedUrl.search)
  const result = parsePairingParams(hashParams, searchParams)
  if (!result) return null

  // 解析完成后立刻从地址栏移除一次性配对码，防止刷新重复提交或留在浏览器历史记录中
  if (rawHref === window.location.href) {
    try {
      const cleanUrl = new URL(window.location.href)
      const keys = ['pair', 'name', 'host', 'hostName', 'lan', 'tunnel', 'custom', 'server']
      for (const k of keys) {
        cleanUrl.searchParams.delete(k)
        hashParams.delete(k)
      }
      const nextHash = hashParams.toString()
      cleanUrl.hash = nextHash ? `#${nextHash}` : ''
      window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash)
    } catch {
      // 忽略 history API 受限场景
    }
  }

  return result
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
  const origin = normalizeOrigin(incoming.origin || getActiveOrigin())
  const incomingId = String(incoming.hostId || '').trim()
  const nextEndpoints = {
    lan: normalizeOrigin(incoming.endpoints?.lan || ''),
    tunnel: normalizeOrigin(incoming.endpoints?.tunnel || ''),
    custom: normalizeOrigin(incoming.endpoints?.custom || ''),
  }
  const idx = hosts.findIndex((h) => {
    if (incomingId && h.hostId && h.hostId === incomingId) return true
    return origin ? hostContainsOrigin(h, origin) : false
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
    if (origin) {
      const curType = classifyEndpointType(origin, mergedEndpoints)
      if (!mergedEndpoints[curType]) mergedEndpoints[curType] = origin
    }

    hosts[idx] = {
      hostId: incomingId || prev.hostId || origin,
      hostName: String(incoming.hostName || prev.hostName || '').trim(),
      endpoints: mergedEndpoints,
      activeEndpoint: origin || prev.activeEndpoint || '',
    }
    return hosts[idx]
  }

  if (origin) {
    const curType = classifyEndpointType(origin, nextEndpoints)
    if (!nextEndpoints[curType]) nextEndpoints[curType] = origin
  }

  const entry = {
    hostId: incomingId || origin,
    hostName: String(incoming.hostName || '').trim(),
    endpoints: nextEndpoints,
    activeEndpoint: origin || nextEndpoints.lan || nextEndpoints.custom || nextEndpoints.tunnel || '',
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
  activeHostId: lsGet(STORAGE.activeHostId, ''),
  activeOrigin: '',
  activeToken: '',
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
  deferredInstallPrompt: null,
  pwaInstalled: isStandalonePwa(),
  pwaDismissed: lsGet(STORAGE.pwaDismissed, '0') === '1',
  pwaDialogScenario: '',
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
  pwaBanner: document.getElementById('pwaBanner'),
  pwaBannerTitle: document.getElementById('pwaBannerTitle'),
  pwaBannerSub: document.getElementById('pwaBannerSub'),
  pwaBannerActions: document.getElementById('pwaBannerActions'),

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
  pwaSettingsRow: document.getElementById('pwaSettingsRow'),
  pwaSettingsDesc: document.getElementById('pwaSettingsDesc'),
  pwaSettingsBtn: document.getElementById('pwaSettingsBtn'),
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
  pairScanQrBtn: document.getElementById('pairScanQrBtn'),
  pairForm: document.getElementById('pairForm'),
  pairCodeInput: document.getElementById('pairCodeInput'),
  pairDeviceNameInput: document.getElementById('pairDeviceNameInput'),
  pairServerUrlInput: document.getElementById('pairServerUrlInput'),
  pairServerHint: document.getElementById('pairServerHint'),
  pairError: document.getElementById('pairError'),
  pairSubmitBtn: document.getElementById('pairSubmitBtn'),
  pairPwaBanner: document.getElementById('pairPwaBanner'),
  pairPwaTitle: document.getElementById('pairPwaTitle'),
  pairPwaSub: document.getElementById('pairPwaSub'),
  pairPwaActions: document.getElementById('pairPwaActions'),
  pairSavedHostsBox: document.getElementById('pairSavedHostsBox'),
  pairSavedHostsList: document.getElementById('pairSavedHostsList'),

  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmBody: document.getElementById('confirmBody'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
  confirmOkBtn: document.getElementById('confirmOkBtn'),
  pwaGuideDialog: document.getElementById('pwaGuideDialog'),
  pwaGuideTitle: document.getElementById('pwaGuideTitle'),
  pwaGuideIntro: document.getElementById('pwaGuideIntro'),
  pwaGuideSteps: document.getElementById('pwaGuideSteps'),
  pwaGuideNote: document.getElementById('pwaGuideNote'),
  pwaGuideExtraBtn: document.getElementById('pwaGuideExtraBtn'),
  pwaGuideCloseBtn: document.getElementById('pwaGuideCloseBtn'),
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
  getNativeBridge()?.setStatusBarTheme?.(dark)
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
  el.pairServerUrlInput.placeholder = t('serverUrlPlaceholder', {
    origin: getActiveOrigin() || 'http://192.168.1.10:3790',
  })
  updatePairServerHint()
  renderAll()
  if (!el.pwaGuideDialog.hidden) {
    openPwaGuideDialog(state.pwaDialogScenario)
  }
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

async function apiFetch(path, { method = 'GET', body, timeoutMs = 10000, skipAuthHandling = false, origin = '', token } = {}) {
  const native = getNativeBridge()
  if (native) {
    const targetOrigin = normalizeOrigin(origin || getActiveOrigin())
    if (!targetOrigin) {
      throw new ApiError(t('pairServerRequired'), { status: 0 })
    }
    const authToken = token !== undefined ? token : state.activeToken
    const res = await native.request(targetOrigin, path, {
      method,
      body,
      token: authToken,
      timeoutMs,
    })
    const status = Number(res?.status || 0)
    const data = res?.data ?? null
    if (status < 200 || status >= 300) {
      if (status === 401 && !skipAuthHandling) {
        handleSessionUnauthorized()
      }
      const msg = (data && (data.error || data.message)) || (status ? `HTTP ${status}` : 'Network error')
      throw new ApiError(msg, { status, data, retryAfterSec: Number(res?.retryAfterSec || 0) })
    }
    return data || {}
  }

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
  const origin = getActiveOrigin()
  const hostId = state.me?.host?.hostId || state.health?.hostId || state.activeHostId || ''
  let host = state.hosts.find((h) => (hostId && h.hostId === hostId) || (origin && hostContainsOrigin(h, origin)))
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
  const origin = getActiveOrigin()
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
      isCurrent: Boolean(origin && url === origin),
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
  const native = getNativeBridge()
  if (native) {
    const res = await native.probeHealth(candidate.url, PROBE_TIMEOUT_MS)
    return {
      ...candidate,
      status: res.status || (res.ok ? 'ok' : 'error'),
      rttMs: res.ok ? res.rttMs : null,
      data: res.ok ? res.data : null,
    }
  }

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
  if (!clean || clean === getActiveOrigin()) return
  if (isNativeApp()) {
    state.activeOrigin = clean
    state.bannerDismissedUrl = ''
    const host = getCurrentHostRecord()
    if (host.hostId) {
      upsertSavedHost(state.hosts, {
        hostId: host.hostId,
        hostName: host.hostName,
        endpoints: host.endpoints,
        origin: clean,
      })
      saveHosts(state.hosts)
    }
    el.routeBanner.hidden = true
    renderAll()
    showToast(t('routeSwitched', { type: linkTypeLabel(classifyEndpointType(clean, host.endpoints)) }))
    void Promise.all([
      loadInstances({ silent: true }),
      probeHostRoutes({ allowAutoSwitch: false }),
    ])
    return
  }
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
  renderPwaGuideUI()
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
  const primaryAction = isNativeApp()
    ? createEl('button', {
        type: 'button',
        class: 'btn btn-sm btn-primary',
        text: actionLabel,
        onClick: () => redirectToEndpoint(targetUrl),
      })
    : createEl('a', {
        class: 'btn btn-sm btn-primary',
        href: `${targetUrl}/_dshx/m/`,
        text: actionLabel,
      })
  el.routeBannerActions.replaceChildren(
    primaryAction,
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
      if (isNativeApp() && state.activeHostId) {
        await getNativeBridge().deleteHostToken(state.activeHostId).catch(() => {})
      }
      state.authenticated = false
      state.me = null
      state.activeToken = ''
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
  if (isNativeApp() && state.activeHostId) {
    await getNativeBridge().deleteHostToken(state.activeHostId).catch(() => {})
  }
  state.authenticated = false
  state.me = null
  state.activeToken = ''
  stopPolling()
  showPairView({ modal: false })
}

// ===== 配对视图与提交 =====

function updatePairServerHint() {
  const val = el.pairServerUrlInput.value.trim()
  const targetOrigin = normalizeOrigin(val)
  const curOrigin = getActiveOrigin()
  if (isNativeApp()) {
    const shown = targetOrigin || curOrigin
    el.pairServerHint.textContent = shown ? t('serverUrlHintCurrent', { origin: shown }) : t('pairServerRequired')
    return
  }
  if (targetOrigin && targetOrigin !== curOrigin) {
    el.pairServerHint.textContent = t('serverUrlHintCross')
  } else {
    el.pairServerHint.textContent = t('serverUrlHintCurrent', { origin: curOrigin })
  }
}

function showPairView({ modal = false, pairPayload = null, errorMessage = '' } = {}) {
  state.pairModalOpen = modal
  el.pairView.hidden = false
  el.pairView.classList.toggle('as-modal', modal)
  el.pairTopbar.hidden = modal
  el.pairCloseBtn.hidden = !modal
  el.consoleShell.hidden = !modal
  el.pairScanQrBtn.hidden = !isNativeApp()

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
    const candidateServer = pairPayload.serverUrl || pairPayload.endpoints?.lan || pairPayload.endpoints?.tunnel || pairPayload.endpoints?.custom || ''
    if (candidateServer && (isNativeApp() || candidateServer !== getActiveOrigin())) {
      el.pairServerUrlInput.value = candidateServer
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
  renderPwaGuideUI()
}

function hidePairView() {
  state.pairModalOpen = false
  el.pairView.hidden = true
  el.consoleShell.hidden = false
  renderPwaGuideUI()
}

async function handlePairSubmit(event) {
  event.preventDefault()
  el.pairError.hidden = true

  const rawCode = el.pairCodeInput.value.trim()
  const parsedPaste = rawCode.includes('://') || rawCode.includes('pair=') ? parsePairingText(rawCode) : null
  const code = (parsedPaste?.code || rawCode).trim()
  if (parsedPaste && !state.pendingUrlPair) {
    state.pendingUrlPair = parsedPaste
  }
  const deviceName = el.pairDeviceNameInput.value.trim() || deviceProfile.defaultName
  const rawServer = el.pairServerUrlInput.value.trim()

  if (!code) {
    el.pairError.textContent = t('pairFailed')
    el.pairError.hidden = false
    return
  }

  let targetServerOrigin = ''
  if (rawServer) {
    targetServerOrigin = normalizeOrigin(rawServer)
    if (!targetServerOrigin) {
      el.pairError.textContent = t('invalidUrl')
      el.pairError.hidden = false
      return
    }
    // 跨主机配对必须跳转到目标源发起同源 POST，否则浏览器不会为目标域种下 SameSite=Lax HttpOnly Cookie
    if (!isNativeApp() && targetServerOrigin !== window.location.origin) {
      const target = new URL('/_dshx/m/', targetServerOrigin)
      const hashParams = new URLSearchParams()
      hashParams.set('pair', code)
      hashParams.set('name', deviceName)
      target.hash = hashParams.toString()
      window.location.href = target.toString()
      return
    }
  }

  el.pairSubmitBtn.disabled = true
  el.pairSubmitBtn.textContent = t('pairing')

  try {
    let pairOrigin = ''
    if (isNativeApp()) {
      const candidates = [
        targetServerOrigin,
        parsedPaste?.serverUrl,
        state.pendingUrlPair?.serverUrl,
        parsedPaste?.endpoints?.lan,
        state.pendingUrlPair?.endpoints?.lan,
        parsedPaste?.endpoints?.custom,
        state.pendingUrlPair?.endpoints?.custom,
        parsedPaste?.endpoints?.tunnel,
        state.pendingUrlPair?.endpoints?.tunnel,
        getActiveOrigin(),
      ]
        .map(normalizeOrigin)
        .filter((u, idx, arr) => u && arr.indexOf(u) === idx)

      if (!candidates.length) {
        el.pairError.textContent = t('pairServerRequired')
        el.pairError.hidden = false
        return
      }
      if (candidates.length === 1) {
        pairOrigin = candidates[0]
      } else {
        const probeResults = await Promise.all(candidates.map((url) => probeSingleEndpoint({ url, type: 'custom', isCurrent: false })))
        const fastest = probeResults
          .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
          .sort((a, b) => a.rttMs - b.rttMs)[0]
        pairOrigin = fastest ? fastest.url : candidates[0]
      }
    }

    const native = getNativeBridge()
    const data = await apiFetch('/_dshx/api/pair/complete', {
      method: 'POST',
      skipAuthHandling: true,
      origin: pairOrigin,
      token: '',
      body: {
        code,
        deviceName,
        platform: native?.platform || deviceProfile.platform,
        deviceKey: state.deviceKey,
      },
    })

    const qrEndpoints = state.pendingUrlPair?.endpoints || {}
    const hostInfo = data.host || {}
    const effectiveOrigin = pairOrigin || getActiveOrigin()
    const mergedHost = upsertSavedHost(state.hosts, {
      hostId: hostInfo.hostId || state.pendingUrlPair?.hostId || state.health?.hostId || effectiveOrigin,
      hostName: hostInfo.hostName || state.pendingUrlPair?.hostName || state.health?.hostName || t('defaultHostName'),
      origin: effectiveOrigin,
      endpoints: {
        lan: hostInfo.endpoints?.lan || qrEndpoints.lan || '',
        tunnel: hostInfo.endpoints?.tunnel || qrEndpoints.tunnel || state.health?.tunnel?.publicUrl || '',
        custom: hostInfo.endpoints?.custom || qrEndpoints.custom || '',
      },
    })
    saveHosts(state.hosts)

    if (native) {
      if (data.token) {
        await native.setHostToken(mergedHost.hostId, data.token)
      }
      state.activeHostId = mergedHost.hostId
      lsSet(STORAGE.activeHostId, mergedHost.hostId)
      state.activeOrigin = effectiveOrigin
      state.activeToken = String(data.token || '')
    }

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
  const origin = getActiveOrigin()
  const currentHost = getCurrentHostRecord()
  const options = []

  const list = state.hosts.length ? state.hosts : [currentHost]
  for (const h of list) {
    const isCur = h.hostId === currentHost.hostId || (origin && hostContainsOrigin(h, origin))
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
  const curType = current?.type || classifyEndpointType(getActiveOrigin(), host.endpoints)

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

async function openNativeDshInstance(instanceKey, instanceTitle = '') {
  const native = getNativeBridge()
  const origin = getActiveOrigin()
  if (!native || !origin || !instanceKey) return
  try {
    const host = getCurrentHostRecord()
    await native.openDshInstance({
      origin,
      instanceKey,
      token: state.activeToken,
      hostName: host?.hostName || '',
      instanceTitle,
    })
    await loadInstances({ silent: true })
  } catch (err) {
    showToast(t('nativeOpenFailed', { msg: err?.message || 'Error' }), { error: true })
  }
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
            onClick: isNativeApp()
              ? (e) => {
                  e.preventDefault()
                  void openNativeDshInstance(inst.key, titleText)
                }
              : undefined,
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
            onClick: isNativeApp()
              ? (e) => {
                  e.preventDefault()
                  void openNativeDshInstance(launch.runningKey, name)
                }
              : undefined,
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
        isNativeApp()
          ? createEl('button', {
              type: 'button',
              class: 'btn btn-sm btn-ghost',
              text: t('switchTo'),
              onClick: () => redirectToEndpoint(c.url),
            })
          : createEl('a', {
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
  const origin = getActiveOrigin()
  if (!state.hosts.length) {
    el.hostsList.replaceChildren(
      createEl('div', { class: 'list-row' }, [
        createEl('span', { class: 'row-sub', text: t('noSavedHosts') }),
      ])
    )
    return
  }

  const rows = state.hosts.map((host) => {
    const isCurrent = isNativeApp()
      ? (Boolean(state.activeHostId && host.hostId === state.activeHostId) || (origin && hostContainsOrigin(host, origin)))
      : hostContainsOrigin(host, origin)
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
  const origin = getActiveOrigin()
  const others = state.hosts.filter((h) => !(origin && hostContainsOrigin(h, origin)))
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

  let targetOrigin = candidates[0]
  if (candidates.length > 1) {
    const curOrigin = getActiveOrigin()
    const probeCandidates = candidates.map((url) => ({
      url,
      type: classifyEndpointType(url, host.endpoints),
      isCurrent: Boolean(curOrigin && url === curOrigin),
    }))
    const results = await Promise.all(probeCandidates.map(probeSingleEndpoint))
    const fastest = results
      .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
      .sort((a, b) => a.rttMs - b.rttMs)[0]
    targetOrigin = fastest ? fastest.url : (host.activeEndpoint || candidates[0])
  }

  if (isNativeApp()) {
    const native = getNativeBridge()
    const token = await native.getHostToken(host.hostId)
    state.activeHostId = host.hostId
    lsSet(STORAGE.activeHostId, host.hostId)
    state.activeOrigin = targetOrigin
    state.activeToken = token || ''
    state.bannerDismissedUrl = ''
    if (!token) {
      state.authenticated = false
      state.me = null
      stopPolling()
      showPairView({
        modal: false,
        pairPayload: { code: '', hostName: host.hostName, serverUrl: targetOrigin },
      })
      el.pairServerUrlInput.value = targetOrigin
      updatePairServerHint()
      return
    }
    try {
      const [healthData, meData] = await Promise.all([
        apiFetch('/_dshx/api/health', { skipAuthHandling: true, timeoutMs: 4000, origin: targetOrigin, token: '' }).catch(() => null),
        apiFetch('/_dshx/api/me', { skipAuthHandling: true, timeoutMs: 4000, origin: targetOrigin, token }),
      ])
      if (healthData?.ok) state.health = healthData
      if (meData?.device) {
        state.authenticated = true
        state.me = meData
        upsertSavedHost(state.hosts, {
          hostId: meData.host?.hostId || host.hostId,
          hostName: meData.host?.hostName || host.hostName,
          origin: targetOrigin,
          endpoints: meData.host?.endpoints || host.endpoints,
        })
        saveHosts(state.hosts)
        await enterAuthenticatedConsole()
        return
      }
    } catch {
      // 回落到配对界面
    }
    state.authenticated = false
    state.me = null
    stopPolling()
    showPairView({ modal: false, errorMessage: t('sessionExpired') })
    el.pairServerUrlInput.value = targetOrigin
    updatePairServerHint()
    return
  }

  redirectToEndpoint(targetOrigin)
}

function findStableHttpsEndpoint() {
  const host = state.authenticated ? getCurrentHostRecord() : null
  const candidates = [
    host?.endpoints?.custom,
    host?.endpoints?.tunnel,
    state.health?.tunnel?.publicUrl,
    state.pendingUrlPair?.endpoints?.custom,
    state.pendingUrlPair?.endpoints?.tunnel,
    state.pendingUrlPair?.serverUrl,
  ]
  for (const raw of candidates) {
    const origin = normalizeOrigin(raw)
    if (!origin || !origin.startsWith('https://')) continue
    try {
      const { hostname } = new URL(origin)
      if (!isEphemeralTunnelHost(hostname)) return origin
    } catch {
      // 忽略无效 URL
    }
  }
  return ''
}

function switchToHttpsOrigin(httpsOrigin) {
  const clean = normalizeOrigin(httpsOrigin)
  if (!clean) return
  const target = new URL('/_dshx/m/', clean)
  const pendingCode = (el.pairCodeInput?.value || state.pendingUrlPair?.code || '').trim()
  if (pendingCode) {
    const hashParams = new URLSearchParams()
    hashParams.set('pair', pendingCode)
    const devName = (el.pairDeviceNameInput?.value || state.pendingUrlPair?.deviceName || '').trim()
    if (devName) hashParams.set('name', devName)
    target.hash = hashParams.toString()
  } else if (window.location.hash) {
    target.hash = window.location.hash
  } else if (window.location.search) {
    target.search = window.location.search
  }
  window.location.href = target.toString()
}

function detectPwaScenario() {
  if (isNativeApp()) return 'installed'
  if (state.pwaInstalled) return 'installed'
  const ua = navigator.userAgent || ''
  if (/MicroMessenger|QQ\/|DingTalk|Weibo|AlipayClient/i.test(ua)) return 'inApp'
  if (isEphemeralTunnelHost(window.location.hostname)) return 'ephemeral'
  if (!isSecurePwaOrigin()) return 'insecure'
  if (state.deferredInstallPrompt) return 'native'
  const isIos = deviceProfile.platform === 'ios' || /iPhone|iPad|iPod/i.test(ua)
  if (isIos) {
    const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua)
    return isSafari ? 'iosSafari' : 'iosOther'
  }
  return 'manual'
}

function buildPwaScenarioDescriptor(scenario) {
  const stableHttps = findStableHttpsEndpoint()

  if (scenario === 'native') {
    return {
      warn: false,
      title: t('pwaBannerTitleNative'),
      sub: t('pwaBannerSubNative'),
      primaryLabel: t('pwaBannerBtnNative'),
      settingsDesc: t('pwaSettingsDescNative'),
      onPrimaryAction: () => triggerNativeInstall(),
      dialog: null,
    }
  }

  if (scenario === 'inApp') {
    return {
      warn: true,
      title: t('pwaBannerTitleInApp'),
      sub: t('pwaBannerSubInApp'),
      primaryLabel: t('pwaBannerBtnInApp'),
      settingsDesc: t('pwaSettingsDescInApp'),
      onPrimaryAction: () => openPwaGuideDialog('inApp'),
      dialog: {
        title: t('pwaGuideTitleInApp'),
        intro: t('pwaGuideIntroInApp'),
        steps: [t('pwaGuideInAppStep1'), t('pwaGuideInAppStep2'), t('pwaGuideInAppStep3')],
        note: t('pwaGuideInAppNote'),
      },
    }
  }

  if (scenario === 'ephemeral') {
    return {
      warn: true,
      title: t('pwaBannerTitleEphemeral'),
      sub: stableHttps ? t('pwaBannerSubEphemeralHttps') : t('pwaBannerSubEphemeralNoHttps'),
      primaryLabel: stableHttps ? t('pwaBannerBtnEphemeralHttps') : t('pwaBannerBtnEphemeralNoHttps'),
      settingsDesc: stableHttps ? t('pwaSettingsDescEphemeralHttps') : t('pwaSettingsDescEphemeralNoHttps'),
      onPrimaryAction: stableHttps
        ? () => switchToHttpsOrigin(stableHttps)
        : () => openPwaGuideDialog('ephemeral'),
      dialog: {
        title: t('pwaGuideTitleEphemeral'),
        intro: t('pwaGuideIntroEphemeral'),
        steps: [t('pwaGuideEphemeralStep1'), t('pwaGuideEphemeralStep2'), t('pwaGuideEphemeralStep3')],
        note: stableHttps ? t('pwaGuideInsecureNoteHttps', { url: stableHttps }) : t('pwaGuideEphemeralNote'),
        extraLabel: stableHttps ? t('pwaGuideInsecureExtraBtn') : '',
        onExtraAction: stableHttps ? () => switchToHttpsOrigin(stableHttps) : null,
      },
    }
  }

  if (scenario === 'insecure') {
    return {
      warn: true,
      title: stableHttps ? t('pwaBannerTitleInsecureHttps') : t('pwaBannerTitleInsecureNoHttps'),
      sub: stableHttps ? t('pwaBannerSubInsecureHttps') : t('pwaBannerSubInsecureNoHttps'),
      primaryLabel: stableHttps ? t('pwaBannerBtnInsecureHttps') : t('pwaBannerBtnInsecureNoHttps'),
      settingsDesc: stableHttps ? t('pwaSettingsDescInsecureHttps') : t('pwaSettingsDescInsecureNoHttps'),
      onPrimaryAction: stableHttps
        ? () => switchToHttpsOrigin(stableHttps)
        : () => openPwaGuideDialog('insecure'),
      dialog: {
        title: t('pwaGuideTitleInsecure'),
        intro: t('pwaGuideIntroInsecure'),
        steps: [t('pwaGuideInsecureStep1'), t('pwaGuideInsecureStep2'), t('pwaGuideInsecureStep3')],
        note: stableHttps ? t('pwaGuideInsecureNoteHttps', { url: stableHttps }) : '',
        extraLabel: stableHttps ? t('pwaGuideInsecureExtraBtn') : '',
        onExtraAction: stableHttps ? () => switchToHttpsOrigin(stableHttps) : null,
      },
    }
  }

  if (scenario === 'iosSafari') {
    return {
      warn: false,
      title: t('pwaBannerTitleIosSafari'),
      sub: t('pwaBannerSubIosSafari'),
      primaryLabel: t('pwaBannerBtnIosSafari'),
      settingsDesc: t('pwaSettingsDescIosSafari'),
      onPrimaryAction: () => openPwaGuideDialog('iosSafari'),
      dialog: {
        title: t('pwaGuideTitleIosSafari'),
        intro: t('pwaGuideIntroIosSafari'),
        steps: [t('pwaGuideIosSafariStep1'), t('pwaGuideIosSafariStep2'), t('pwaGuideIosSafariStep3')],
        note: t('pwaGuideIosSafariNote'),
      },
    }
  }

  if (scenario === 'iosOther') {
    return {
      warn: false,
      title: t('pwaBannerTitleIosOther'),
      sub: t('pwaBannerSubIosOther'),
      primaryLabel: t('pwaBannerBtnIosOther'),
      settingsDesc: t('pwaSettingsDescIosOther'),
      onPrimaryAction: () => openPwaGuideDialog('iosOther'),
      dialog: {
        title: t('pwaGuideTitleIosOther'),
        intro: t('pwaGuideIntroIosOther'),
        steps: [t('pwaGuideIosOtherStep1'), t('pwaGuideIosOtherStep2'), t('pwaGuideIosOtherStep3')],
        note: t('pwaGuideIosOtherNote'),
      },
    }
  }

  return {
    warn: false,
    title: t('pwaBannerTitleManual'),
    sub: t('pwaBannerSubManual'),
    primaryLabel: t('pwaBannerBtnManual'),
    settingsDesc: t('pwaSettingsDescManual'),
    onPrimaryAction: () => openPwaGuideDialog('manual'),
    dialog: {
      title: t('pwaGuideTitleManual'),
      intro: t('pwaGuideIntroManual'),
      steps: [t('pwaGuideManualStep1'), t('pwaGuideManualStep2'), t('pwaGuideManualStep3')],
      note: t('pwaGuideManualNote'),
    },
  }
}

async function triggerNativeInstall() {
  const promptEvent = state.deferredInstallPrompt
  // BeforeInstallPromptEvent 只能消费一次；无论用户是否接受都要先清掉防止重复调用报错
  state.deferredInstallPrompt = null
  if (!promptEvent || isEphemeralTunnelHost(window.location.hostname)) {
    renderPwaGuideUI()
    openPwaGuideDialog(detectPwaScenario())
    return
  }
  try {
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    if (choice && choice.outcome === 'accepted') {
      state.pwaInstalled = true
    }
  } catch {
    openPwaGuideDialog('manual')
  }
  renderPwaGuideUI()
}

function openPwaGuideDialog(requestedScenario) {
  const scenario = requestedScenario || detectPwaScenario()
  const desc = buildPwaScenarioDescriptor(scenario)
  if (!desc.dialog) {
    desc.onPrimaryAction()
    return
  }
  state.pwaDialogScenario = scenario
  el.pwaGuideTitle.textContent = desc.dialog.title
  el.pwaGuideIntro.textContent = desc.dialog.intro
  el.pwaGuideSteps.replaceChildren(
    ...desc.dialog.steps.map((step) => createEl('li', { text: step }))
  )
  if (desc.dialog.note) {
    el.pwaGuideNote.textContent = desc.dialog.note
    el.pwaGuideNote.hidden = false
  } else {
    el.pwaGuideNote.textContent = ''
    el.pwaGuideNote.hidden = true
  }
  if (desc.dialog.extraLabel && typeof desc.dialog.onExtraAction === 'function') {
    el.pwaGuideExtraBtn.textContent = desc.dialog.extraLabel
    el.pwaGuideExtraBtn.onclick = () => {
      closePwaGuideDialog()
      desc.dialog.onExtraAction()
    }
    el.pwaGuideExtraBtn.hidden = false
  } else {
    el.pwaGuideExtraBtn.hidden = true
    el.pwaGuideExtraBtn.onclick = null
  }
  el.pwaGuideCloseBtn.textContent = t('pwaClose')
  el.pwaGuideDialog.hidden = false
}

function closePwaGuideDialog() {
  el.pwaGuideDialog.hidden = true
  state.pwaDialogScenario = ''
}

function dismissPwaBanner() {
  state.pwaDismissed = true
  lsSet(STORAGE.pwaDismissed, '1')
  renderPwaGuideUI()
}

function renderPwaBannerSlot({ bannerEl, titleEl, subEl, actionsEl, descriptor, allowDismiss }) {
  bannerEl.hidden = false
  bannerEl.classList.toggle('warn', Boolean(descriptor.warn))
  titleEl.textContent = descriptor.title
  subEl.textContent = descriptor.sub
  const buttons = [
    createEl('button', {
      type: 'button',
      class: 'btn btn-sm btn-primary',
      text: descriptor.primaryLabel,
      onClick: descriptor.onPrimaryAction,
    }),
  ]
  if (allowDismiss) {
    buttons.push(
      createEl('button', {
        type: 'button',
        class: 'pwa-close-btn',
        'aria-label': t('pwaDismiss'),
        title: t('pwaDismiss'),
        onClick: dismissPwaBanner,
      }, [
        createSvgIcon(['M18 6 6 18', 'm6 6 12 12'], 'icon-sm'),
      ])
    )
  }
  actionsEl.replaceChildren(...buttons)
}

function renderPwaGuideUI() {
  const scenario = detectPwaScenario()
  if (scenario === 'installed') {
    el.pwaBanner.hidden = true
    el.pairPwaBanner.hidden = true
    el.pwaSettingsRow.hidden = true
    return
  }

  const descriptor = buildPwaScenarioDescriptor(scenario)

  el.pwaSettingsRow.hidden = false
  el.pwaSettingsDesc.textContent = descriptor.settingsDesc
  el.pwaSettingsBtn.textContent = descriptor.primaryLabel

  if (state.pwaDismissed) {
    el.pwaBanner.hidden = true
    el.pairPwaBanner.hidden = true
    return
  }

  renderPwaBannerSlot({
    bannerEl: el.pwaBanner,
    titleEl: el.pwaBannerTitle,
    subEl: el.pwaBannerSub,
    actionsEl: el.pwaBannerActions,
    descriptor,
    allowDismiss: true,
  })

  if (state.pairModalOpen) {
    el.pairPwaBanner.hidden = true
  } else {
    renderPwaBannerSlot({
      bannerEl: el.pairPwaBanner,
      titleEl: el.pairPwaTitle,
      subEl: el.pairPwaSub,
      actionsEl: el.pairPwaActions,
      descriptor,
      allowDismiss: true,
    })
  }
}

function renderFooterNote() {
  const parts = []
  if (state.health?.version) {
    parts.push(t('footerVersion', { version: state.health.version }))
  }
  if (!isStandalonePwa()) {
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
  renderPwaGuideUI()
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

async function bootstrapNative() {
  const native = getNativeBridge()
  native.onDeepLink((rawUrl) => {
    const parsed = parsePairingText(rawUrl)
    if (!parsed || !parsed.code) return
    state.pendingUrlPair = parsed
    showPairView({ modal: state.authenticated, pairPayload: parsed })
  })

  if (!state.hosts.length) {
    state.authenticated = false
    showPairView({ modal: false })
    return
  }

  const host = state.hosts.find((h) => state.activeHostId && h.hostId === state.activeHostId) || state.hosts[0]
  state.activeHostId = host.hostId
  lsSet(STORAGE.activeHostId, host.hostId)
  const token = await native.getHostToken(host.hostId)
  state.activeToken = token || ''

  const candidates = [
    host.endpoints?.lan,
    host.endpoints?.custom,
    host.endpoints?.tunnel,
    host.activeEndpoint,
  ]
    .map(normalizeOrigin)
    .filter((u, i, arr) => u && arr.indexOf(u) === i)

  if (candidates.length > 1) {
    const probeResults = await Promise.all(candidates.map((url) => probeSingleEndpoint({ url, type: 'custom', isCurrent: false })))
    const fastest = probeResults
      .filter((r) => r.status === 'ok' && Number.isFinite(r.rttMs))
      .sort((a, b) => a.rttMs - b.rttMs)[0]
    state.activeOrigin = fastest ? fastest.url : (host.activeEndpoint || candidates[0])
  } else {
    state.activeOrigin = candidates[0] || ''
  }

  if (!state.activeOrigin || !state.activeToken) {
    state.authenticated = false
    showPairView({ modal: false })
    if (state.activeOrigin) {
      el.pairServerUrlInput.value = state.activeOrigin
      updatePairServerHint()
    }
    return
  }

  const [healthRes, meRes] = await Promise.allSettled([
    apiFetch('/_dshx/api/health', { skipAuthHandling: true, timeoutMs: 4000, token: '' }),
    apiFetch('/_dshx/api/me', { skipAuthHandling: true, timeoutMs: 4000 }),
  ])

  if (healthRes.status === 'fulfilled' && healthRes.value?.ok) {
    state.health = healthRes.value
  }
  if (meRes.status === 'fulfilled' && meRes.value?.device) {
    state.authenticated = true
    state.me = meRes.value
    const hostInfo = meRes.value.host || {}
    upsertSavedHost(state.hosts, {
      hostId: hostInfo.hostId || host.hostId,
      hostName: hostInfo.hostName || host.hostName || t('defaultHostName'),
      origin: state.activeOrigin,
      endpoints: {
        lan: hostInfo.endpoints?.lan || host.endpoints?.lan || '',
        tunnel: hostInfo.endpoints?.tunnel || state.health?.tunnel?.publicUrl || host.endpoints?.tunnel || '',
        custom: hostInfo.endpoints?.custom || host.endpoints?.custom || '',
      },
    })
    saveHosts(state.hosts)
    await enterAuthenticatedConsole()
    return
  }

  state.authenticated = false
  showPairView({ modal: false, errorMessage: meRes.status === 'rejected' && meRes.reason?.status === 401 ? t('sessionExpired') : '' })
  if (state.activeOrigin) {
    el.pairServerUrlInput.value = state.activeOrigin
    updatePairServerHint()
  }
}

async function bootstrap() {
  applyTheme(state.theme)
  applyLanguage(state.lang)

  if (isNativeApp()) {
    await bootstrapNative()
    return
  }

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

  // 若携带了 #pair= / ?pair= 扫码参数，优先弹出配对卡片让用户一键完成/轮换配对
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
    if (targetHost && (isNativeApp() ? targetHost.hostId !== state.activeHostId : !hostContainsOrigin(targetHost, getActiveOrigin()))) {
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
  el.pairScanQrBtn?.addEventListener('click', async () => {
    const native = getNativeBridge()
    if (!native) return
    el.pairError.hidden = true
    try {
      const res = await native.scanQr()
      if (!res || res.cancelled) {
        return
      }
      const parsed = parsePairingText(res.text || '')
      if (!parsed || !parsed.code) {
        el.pairError.textContent = t('scanQrFailed')
        el.pairError.hidden = false
        return
      }
      state.pendingUrlPair = parsed
      showPairView({ modal: state.pairModalOpen, pairPayload: parsed })
      el.pairSubmitBtn.focus()
    } catch (err) {
      el.pairError.textContent = err?.message || t('scanQrFailed')
      el.pairError.hidden = false
    }
  })
  el.pairForm.addEventListener('submit', handlePairSubmit)

  // 确认弹窗
  el.confirmCancelBtn.addEventListener('click', () => closeConfirm(false))
  el.confirmOkBtn.addEventListener('click', () => closeConfirm(true))
  el.confirmDialog.addEventListener('click', (e) => {
    if (e.target === el.confirmDialog) closeConfirm(false)
  })

  // PWA 安装引导弹窗与浏览器安装事件
  el.pwaSettingsBtn.addEventListener('click', () => {
    const scenario = detectPwaScenario()
    if (scenario !== 'installed') {
      buildPwaScenarioDescriptor(scenario).onPrimaryAction()
    }
  })
  el.pwaGuideCloseBtn.addEventListener('click', closePwaGuideDialog)
  el.pwaGuideDialog.addEventListener('click', (e) => {
    if (e.target === el.pwaGuideDialog) closePwaGuideDialog()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.pwaGuideDialog.hidden) {
      closePwaGuideDialog()
    }
  })

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    // 临时体验域名重启即失效：拦下原生安装弹窗并不存储 prompt，防止引导用户装失效图标
    if (isEphemeralTunnelHost(window.location.hostname)) return
    state.deferredInstallPrompt = e
    renderPwaGuideUI()
  })

  window.addEventListener('appinstalled', () => {
    state.pwaInstalled = true
    state.deferredInstallPrompt = null
    closePwaGuideDialog()
    renderPwaGuideUI()
    renderFooterNote()
    showToast(t('pwaInstalledToast'))
  })

  window.matchMedia?.('(display-mode: standalone)').addEventListener('change', (e) => {
    state.pwaInstalled = Boolean(e.matches || window.navigator.standalone === true)
    renderPwaGuideUI()
    renderFooterNote()
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
