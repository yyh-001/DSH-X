// 设置页「移动与远程访问」交互模块：网关开关与状态、手机配对二维码、已配对设备管理、Cloudflare 外网隧道。
// 跑在 index.html 主脚本之后，复用主脚本的全局：t、appConfirm、createUiSelect、syncUiSelect。
// 全部 DOM 走原生节点构建（textContent / createElement / createElementNS），不拼 innerHTML，
// 配对二维码 SVG 通过 DOMParser + 严格白名单重建，防止任何不可信脚本或属性注入。
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const ALLOWED_SVG_TAGS = new Set(['svg', 'rect', 'path', 'g', 'circle', 'polygon', 'line', 'title'])
  const ALLOWED_SVG_ATTRS = new Set([
    'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width',
    'd', 'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'x1', 'y1', 'x2', 'y2',
    'transform', 'shape-rendering', 'role', 'aria-label',
  ])
  const SAFE_PAINT_RE = /^(?:none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d.,\s%]+\))$/
  const TRANSITIONAL_TUNNEL_STATES = new Set(['downloading', 'probing', 'starting'])

  const tr = (zh, vars) => (typeof t === 'function' ? t(zh, vars) : zh)
  const byId = (id) => document.getElementById(id)

  const sectionEl = document.querySelector('#pane-settings .set-section[data-category="remote-access"]')
  if (!sectionEl) return

  const dom = {
    hostChip: byId('raHostChip'),
    gatewayPill: byId('raGatewayPill'),
    gatewayPillText: byId('raGatewayPillText'),
    gatewayPortBadge: byId('raGatewayPortBadge'),
    refreshBtn: byId('raRefreshBtn'),
    gatewayError: byId('raGatewayError'),
    gatewayErrorText: byId('raGatewayErrorText'),
    endpointsRow: byId('raEndpointsRow'),
    endpointList: byId('raEndpointList'),
    enabled: byId('raEnabled'),
    bindLan: byId('raBindLan'),
    gatewayPort: byId('raGatewayPort'),
    customPublicUrl: byId('raCustomPublicUrl'),
    gatewayHint: byId('raGatewayHint'),
    gatewaySave: byId('raGatewaySave'),

    generatePair: byId('raGeneratePair'),
    pairNeedGateway: byId('raPairNeedGateway'),
    pairingBox: byId('raPairingBox'),
    pairSourceTabs: byId('raPairSourceTabs'),
    qrFrame: byId('raQrFrame'),
    pairCountdownPill: byId('raPairCountdownPill'),
    pairCountdown: byId('raPairCountdown'),
    pairCode: byId('raPairCode'),
    copyPairCode: byId('raCopyPairCode'),
    pairUrl: byId('raPairUrl'),
    copyPairUrl: byId('raCopyPairUrl'),
    openPairUrl: byId('raOpenPairUrl'),
    pairHint: byId('raPairHint'),

    deviceCount: byId('raDeviceCount'),
    revokeAll: byId('raRevokeAll'),
    deviceList: byId('raDeviceList'),
    devicesHint: byId('raDevicesHint'),

    tunnelPill: byId('raTunnelPill'),
    tunnelPillText: byId('raTunnelPillText'),
    tunnelLocations: byId('raTunnelLocations'),
    tunnelStart: byId('raTunnelStart'),
    tunnelStop: byId('raTunnelStop'),
    tunnelError: byId('raTunnelError'),
    tunnelErrorText: byId('raTunnelErrorText'),
    tunnelUrlRow: byId('raTunnelUrlRow'),
    tunnelPublicUrlDisplay: byId('raTunnelPublicUrlDisplay'),
    copyTunnelUrl: byId('raCopyTunnelUrl'),
    openTunnelUrl: byId('raOpenTunnelUrl'),
    modeRadios: [...sectionEl.querySelectorAll('input[name="raTunnelMode"]')],
    workerUrlRow: byId('raWorkerUrlRow'),
    workerUrl: byId('raWorkerUrl'),
    inviteCodeRow: byId('raInviteCodeRow'),
    inviteCode: byId('raInviteCode'),
    tokenRow: byId('raTokenRow'),
    tokenStatus: byId('raTokenStatus'),
    tunnelToken: byId('raTunnelToken'),
    clearToken: byId('raClearToken'),
    tokenPublicUrlRow: byId('raTokenPublicUrlRow'),
    tunnelPublicUrl: byId('raTunnelPublicUrl'),
    edgeIpVersion: byId('raEdgeIpVersion'),
    tunnelProbe: byId('raTunnelProbe'),
    edgeProbeBox: byId('raEdgeProbeBox'),
    tunnelAutoStart: byId('raTunnelAutoStart'),
    tunnelHint: byId('raTunnelHint'),
    tunnelSave: byId('raTunnelSave'),
  }

  // 页面状态：保留脏标记，防止后台轮询覆盖用户正在输入的字段
  const state = {
    visible: false,
    loaded: false,
    loading: false,
    status: null,
    pairing: null,
    pairSource: 'primary',
    lastProbe: null,
    gatewayDirty: false,
    tunnelDirty: false,
    editingDeviceId: '',
    editingName: '',
    pollTimer: null,
    countdownTimer: null,
    busy: {
      gateway: false,
      pair: false,
      tunnel: false,
      probe: false,
      devices: false,
    },
  }

  // 把原生 select 接进设置页统一的自绘下拉组件（若主脚本已提供）
  if (dom.edgeIpVersion && typeof createUiSelect === 'function') {
    createUiSelect(dom.edgeIpVersion)
  }

  // ---- 工具函数 ----

  async function requestJson(path, { method = 'GET', body } = {}) {
    const headers = {}
    const init = { method, cache: 'no-store', headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(path, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(tr(data.error || res.statusText || `HTTP ${res.status}`))
      err.status = res.status
      throw err
    }
    return data
  }

  function makeIcon(lucideId, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    if (className) svg.setAttribute('class', className)
    const use = document.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', `/icons.svg#${lucideId}`)
    svg.append(use)
    return svg
  }

  function setButtonIcon(button, lucideId) {
    const use = button?.querySelector('svg use')
    if (use) use.setAttribute('href', `/icons.svg#${lucideId}`)
  }

  /**
   * 仅保留严格白名单的 SVG 几何标签与属性重建节点：
   * 二维码由本地服务端生成，但仍遵循零信任原则，绝不把字符串塞进 innerHTML。
   */
  function renderSafeQrSvg(container, rawSvg) {
    container.replaceChildren()
    const source = String(rawSvg || '').trim()
    if (!source) return false
    let doc
    try {
      doc = new DOMParser().parseFromString(source, 'image/svg+xml')
    } catch {
      return false
    }
    if (!doc || doc.querySelector('parsererror')) return false
    const root = doc.documentElement
    if (!root || root.tagName.toLowerCase() !== 'svg') return false

    const cloneSafe = (node) => {
      if (node.nodeType !== 1) return null
      const tag = node.tagName.toLowerCase()
      if (!ALLOWED_SVG_TAGS.has(tag)) return null
      const out = document.createElementNS(SVG_NS, tag)
      for (const attr of node.attributes) {
        const name = attr.name
        if (!ALLOWED_SVG_ATTRS.has(name)) continue
        const value = String(attr.value || '').trim()
        if ((name === 'fill' || name === 'stroke') && !SAFE_PAINT_RE.test(value)) continue
        out.setAttribute(name, value)
      }
      if (tag === 'title') {
        out.textContent = node.textContent || ''
        return out
      }
      for (const child of node.childNodes) {
        const safeChild = cloneSafe(child)
        if (safeChild) out.append(safeChild)
      }
      return out
    }

    const cleanRoot = cloneSafe(root)
    if (!cleanRoot) return false
    cleanRoot.setAttribute('role', 'img')
    cleanRoot.setAttribute('aria-label', tr('手机配对二维码'))
    cleanRoot.classList.add('ra-qr-svg')
    container.append(cleanRoot)
    return true
  }

  function safeHttpUrl(raw) {
    const value = String(raw || '').trim()
    return /^https?:\/\/[^\s]+$/i.test(value) ? value : ''
  }

  /** 把网关根地址拼成手机版 PWA 入口（避免重复拼接 /_dshx/m/）。 */
  function mobileEntryUrl(rawBase) {
    const clean = safeHttpUrl(rawBase)
    if (!clean) return ''
    if (/\/_dshx\/m(?:\/|\?|$)/i.test(clean)) return clean
    return `${clean.replace(/\/+$/, '')}/_dshx/m/`
  }

  function openExternalUrl(rawUrl) {
    const url = safeHttpUrl(rawUrl)
    if (!url) return
    window.open(url, '_blank', 'noopener')
  }

  async function copyText(text, triggerButton, hintEl) {
    const value = String(text || '').trim()
    if (!value) return
    let copied = false
    try {
      await navigator.clipboard.writeText(value)
      copied = true
    } catch {
      // 部分 WebView 权限受限，借临时文本框走同步复制兜底
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      try { copied = document.execCommand('copy') } catch { copied = false }
      finally { area.remove() }
    }
    if (copied && triggerButton) {
      const prevIcon = triggerButton.dataset.origIcon || 'lucide-copy'
      triggerButton.dataset.origIcon = prevIcon
      setButtonIcon(triggerButton, 'lucide-check')
      triggerButton.classList.add('is-copied')
      clearTimeout(Number(triggerButton.dataset.copyTimer || 0))
      triggerButton.dataset.copyTimer = String(setTimeout(() => {
        setButtonIcon(triggerButton, prevIcon)
        triggerButton.classList.remove('is-copied')
      }, 1500))
    }
    if (hintEl) {
      showHint(hintEl, copied ? tr('已复制到剪贴板。') : tr('复制失败，请手动选中复制。'), !copied)
    }
  }

  function showHint(el, message, isError = false) {
    if (!el) return
    el.textContent = message || ''
    el.hidden = !message
    el.classList.toggle('is-error', Boolean(message && isError))
  }

  function formatRelativeTime(timestamp) {
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return tr('未知')
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
    if (diffSec < 60) return tr('刚刚')
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return tr('{n} 分钟前', { n: diffMin })
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return tr('{n} 小时前', { n: diffHour })
    const diffDay = Math.floor(diffHour / 24)
    if (diffDay < 30) return tr('{n} 天前', { n: diffDay })
    return formatExactTime(ts)
  }

  function formatExactTime(timestamp) {
    const ts = Number(timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return ''
    try {
      return new Date(ts).toLocaleString()
    } catch {
      return new Date(ts).toISOString()
    }
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000))
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  function selectedTunnelMode() {
    const checked = dom.modeRadios.find((r) => r.checked)
    return checked ? checked.value : 'quick'
  }

  function setSelectedTunnelMode(mode) {
    const value = mode === 'worker' || mode === 'token' ? mode : 'quick'
    for (const radio of dom.modeRadios) radio.checked = radio.value === value
    updateTunnelModeFields(value)
  }

  function updateTunnelModeFields(mode) {
    dom.workerUrlRow.hidden = mode !== 'worker'
    dom.inviteCodeRow.hidden = mode !== 'worker'
    dom.tokenRow.hidden = mode !== 'token'
    dom.tokenPublicUrlRow.hidden = mode !== 'token'
  }

  function normalizeStatusPayload(payload) {
    if (!payload || typeof payload !== 'object') return null
    if (payload.status && typeof payload.status === 'object' && payload.status.config) {
      return payload.status
    }
    if (payload.config || payload.gateway || payload.tunnel || Array.isArray(payload.devices)) {
      return payload
    }
    return null
  }

  // ---- 渲染各卡片 ----

  function renderAll({ forceFormSync = false } = {}) {
    const st = state.status
    if (!st) return
    renderGatewayCard(st, forceFormSync)
    renderPairingCard(st)
    renderDevicesCard(st)
    renderTunnelCard(st, forceFormSync)
    schedulePoll()
  }

  function renderGatewayCard(st, forceFormSync) {
    const config = st.config || {}
    const gateway = st.gateway || {}
    const host = st.host || {}

    if (host.hostName) {
      dom.hostChip.textContent = host.hostName
      dom.hostChip.hidden = false
    } else {
      dom.hostChip.hidden = true
    }

    // 网关状态胶囊：运行中即便伴随局域网端口冲突告警（仍由下方横幅提示），主状态仍保持「运行中」
    dom.gatewayPill.classList.remove('is-running', 'is-stopped', 'is-error', 'is-pending')
    if (gateway.running) {
      dom.gatewayPill.classList.add('is-running')
      dom.gatewayPillText.textContent = tr('运行中')
    } else if (gateway.error) {
      dom.gatewayPill.classList.add('is-error')
      dom.gatewayPillText.textContent = tr('启动异常')
    } else {
      dom.gatewayPill.classList.add('is-stopped')
      dom.gatewayPillText.textContent = tr('未启动')
    }

    if (gateway.running && gateway.port) {
      dom.gatewayPortBadge.textContent = tr('端口 {port}', { port: gateway.port })
      dom.gatewayPortBadge.hidden = false
    } else {
      dom.gatewayPortBadge.hidden = true
    }

    if (gateway.error) {
      dom.gatewayErrorText.textContent = tr(String(gateway.error))
      dom.gatewayError.hidden = false
    } else {
      dom.gatewayError.hidden = true
    }

    // 入口地址列表：本机预览、局域网直连、自定义公网入口
    const endpoints = []
    if (gateway.running && gateway.localUrl) {
      endpoints.push({ label: tr('本机预览'), url: mobileEntryUrl(gateway.localUrl) })
    }
    if (gateway.running && gateway.lanUrl) {
      endpoints.push({ label: tr('局域网入口'), url: mobileEntryUrl(gateway.lanUrl) })
    }
    if (gateway.running && config.customPublicUrl) {
      const custom = mobileEntryUrl(config.customPublicUrl)
      if (custom) endpoints.push({ label: tr('自定义公网'), url: custom })
    }

    dom.endpointList.replaceChildren()
    if (endpoints.length > 0) {
      for (const item of endpoints) {
        const row = document.createElement('div')
        row.className = 'ra-endpoint-item'

        const label = document.createElement('span')
        label.className = 'ra-endpoint-label'
        label.textContent = item.label

        const code = document.createElement('code')
        code.className = 'ra-url-value'
        code.textContent = item.url
        code.title = item.url

        const actions = document.createElement('div')
        actions.className = 'ra-endpoint-actions'

        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'ghost icon-btn ra-icon-sm'
        copyBtn.title = tr('复制地址')
        copyBtn.setAttribute('aria-label', tr('复制地址'))
        copyBtn.append(makeIcon('lucide-copy'))
        copyBtn.onclick = () => void copyText(item.url, copyBtn, dom.gatewayHint)

        const openBtn = document.createElement('button')
        openBtn.type = 'button'
        openBtn.className = 'ghost icon-btn ra-icon-sm'
        openBtn.title = tr('打开手机版预览')
        openBtn.setAttribute('aria-label', tr('打开手机版预览'))
        openBtn.append(makeIcon('lucide-external-link'))
        openBtn.onclick = () => openExternalUrl(item.url)

        actions.append(copyBtn, openBtn)
        row.append(label, code, actions)
        dom.endpointList.append(row)
      }
      dom.endpointsRow.hidden = false
    } else {
      dom.endpointsRow.hidden = true
    }

    // 表单回填（仅在非脏状态且未聚焦时更新，防止打断用户输入）
    if (forceFormSync || !state.gatewayDirty) {
      dom.enabled.checked = config.enabled === true
      dom.bindLan.checked = config.bindLan === true
      if (forceFormSync || document.activeElement !== dom.gatewayPort) {
        const portVal = Number(config.gatewayPort) || 0
        dom.gatewayPort.value = portVal > 0 ? String(portVal) : ''
      }
      if (forceFormSync || document.activeElement !== dom.customPublicUrl) {
        dom.customPublicUrl.value = String(config.customPublicUrl || '')
      }
    }

    dom.enabled.disabled = state.busy.gateway
    dom.bindLan.disabled = state.busy.gateway
    dom.gatewaySave.disabled = state.busy.gateway
  }

  function activePairingEntry(pairing) {
    if (!pairing) return { url: '', svg: '', hasBoth: false }
    const hasPrimary = Boolean(pairing.url && pairing.svg)
    const hasLan = Boolean(pairing.lanUrl && pairing.lanSvg && pairing.lanUrl !== pairing.url)
    const hasBoth = hasPrimary && hasLan
    if (state.pairSource === 'lan' && hasLan) {
      return { url: pairing.lanUrl, svg: pairing.lanSvg, hasBoth }
    }
    if (hasPrimary) {
      return { url: pairing.url, svg: pairing.svg, hasBoth }
    }
    if (pairing.lanUrl || pairing.lanSvg) {
      return { url: pairing.lanUrl || '', svg: pairing.lanSvg || '', hasBoth: false }
    }
    return { url: pairing.url || '', svg: pairing.svg || '', hasBoth: false }
  }

  function renderPairingCard(st) {
    const gatewayRunning = Boolean(st?.gateway?.running)
    dom.pairNeedGateway.hidden = gatewayRunning
    dom.generatePair.disabled = state.busy.pair || !gatewayRunning

    const pairing = state.pairing
    if (!pairing || !pairing.code) {
      dom.pairingBox.hidden = true
      stopCountdown()
      return
    }

    const entry = activePairingEntry(pairing)
    dom.pairingBox.hidden = false
    dom.pairSourceTabs.hidden = !entry.hasBoth

    for (const tab of dom.pairSourceTabs.querySelectorAll('[data-pair-source]')) {
      const selected = tab.dataset.pairSource === (entry.hasBoth ? state.pairSource : 'primary')
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', String(selected))
    }

    const okSvg = renderSafeQrSvg(dom.qrFrame, entry.svg)
    if (!okSvg) {
      const fallback = document.createElement('span')
      fallback.className = 'ra-qr-empty'
      fallback.textContent = tr('二维码渲染失败')
      dom.qrFrame.replaceChildren(fallback)
    }

    dom.pairCode.textContent = String(pairing.code || '')
    dom.pairUrl.textContent = entry.url
    dom.pairUrl.title = entry.url
    dom.openPairUrl.disabled = !safeHttpUrl(entry.url)

    updatePairingCountdown()
    startCountdown()
  }

  function updatePairingCountdown() {
    const pairing = state.pairing
    if (!pairing || !pairing.expiresAt) return
    const remain = Number(pairing.expiresAt) - Date.now()
    dom.pairCountdownPill.classList.remove('is-running', 'is-pending', 'is-error')
    if (remain <= 0) {
      dom.pairCountdownPill.classList.add('is-error')
      dom.pairCountdown.textContent = tr('已过期，请重新生成')
      dom.qrFrame.classList.add('is-expired')
      stopCountdown()
      return
    }
    dom.qrFrame.classList.remove('is-expired')
    if (remain < 60_000) {
      dom.pairCountdownPill.classList.add('is-pending')
    } else {
      dom.pairCountdownPill.classList.add('is-running')
    }
    dom.pairCountdown.textContent = tr('有效倒计时 {time}', { time: formatCountdown(remain) })
  }

  function startCountdown() {
    if (state.countdownTimer) return
    state.countdownTimer = setInterval(() => {
      if (!state.pairing) {
        stopCountdown()
        return
      }
      updatePairingCountdown()
    }, 1000)
  }

  function stopCountdown() {
    if (!state.countdownTimer) return
    clearInterval(state.countdownTimer)
    state.countdownTimer = null
  }

  function renderDevicesCard(st) {
    const devices = Array.isArray(st?.devices) ? st.devices : []
    dom.deviceCount.textContent = String(devices.length)
    dom.revokeAll.hidden = devices.length === 0
    dom.revokeAll.disabled = state.busy.devices

    // 若当前正在内联重命名且该设备依然存在，则先不整表重建，避免打断输入焦点
    if (state.editingDeviceId && devices.some((d) => d.deviceId === state.editingDeviceId)) {
      const activeInput = dom.deviceList.querySelector('input.ra-device-rename-input')
      if (activeInput && document.activeElement === activeInput) return
    } else if (state.editingDeviceId) {
      state.editingDeviceId = ''
      state.editingName = ''
    }

    dom.deviceList.replaceChildren()

    if (devices.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ra-empty-state'
      empty.append(makeIcon('lucide-shield-check', 'ra-empty-icon'))
      const title = document.createElement('div')
      title.className = 'ra-empty-title'
      title.textContent = tr('暂未配对任何移动设备')
      const desc = document.createElement('p')
      desc.className = 'ra-empty-desc'
      desc.textContent = tr('在上方生成配对二维码并用手机扫码后，设备会出现在这里。')
      empty.append(title, desc)
      dom.deviceList.append(empty)
      return
    }

    for (const device of devices) {
      const row = document.createElement('div')
      row.className = 'ra-device-row'
      const isEditing = state.editingDeviceId === device.deviceId

      const info = document.createElement('div')
      info.className = 'ra-device-info'

      const head = document.createElement('div')
      head.className = 'ra-device-head'

      if (isEditing) {
        const form = document.createElement('form')
        form.className = 'ra-device-rename-form'
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'ra-device-rename-input'
        input.maxLength = 64
        input.value = state.editingName
        input.setAttribute('aria-label', tr('设备名称'))
        input.oninput = () => { state.editingName = input.value }
        input.onkeydown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            state.editingDeviceId = ''
            state.editingName = ''
            renderDevicesCard(state.status)
          }
        }

        const saveBtn = document.createElement('button')
        saveBtn.type = 'submit'
        saveBtn.className = 'primary icon-btn ra-icon-sm'
        saveBtn.title = tr('保存名称')
        saveBtn.setAttribute('aria-label', tr('保存名称'))
        saveBtn.disabled = state.busy.devices
        saveBtn.append(makeIcon('lucide-check'))

        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'ghost icon-btn ra-icon-sm'
        cancelBtn.title = tr('取消')
        cancelBtn.setAttribute('aria-label', tr('取消'))
        cancelBtn.append(makeIcon('lucide-x'))
        cancelBtn.onclick = () => {
          state.editingDeviceId = ''
          state.editingName = ''
          renderDevicesCard(state.status)
        }

        form.onsubmit = (event) => {
          event.preventDefault()
          void submitRenameDevice(device.deviceId, input.value)
        }
        form.append(input, saveBtn, cancelBtn)
        head.append(form)
        requestAnimationFrame(() => {
          input.focus()
          input.select()
        })
      } else {
        const nameEl = document.createElement('span')
        nameEl.className = 'ra-device-name'
        nameEl.textContent = device.deviceName || device.deviceId

        const platform = document.createElement('span')
        platform.className = 'ra-platform-badge'
        platform.textContent = device.platform || tr('未知设备')

        head.append(nameEl, platform)
      }

      const meta = document.createElement('div')
      meta.className = 'ra-device-meta'

      const lastActive = document.createElement('span')
      lastActive.textContent = tr('最近活跃：{time}', { time: formatRelativeTime(device.lastSeenAt || device.createdAt) })
      lastActive.title = formatExactTime(device.lastSeenAt || device.createdAt)
      meta.append(lastActive)

      if (device.lastSeenIP) {
        const sep = document.createElement('span')
        sep.className = 'ra-meta-sep'
        sep.textContent = '·'
        const ip = document.createElement('span')
        ip.textContent = `IP ${device.lastSeenIP}`
        meta.append(sep, ip)
      }

      if (device.createdAt) {
        const sep = document.createElement('span')
        sep.className = 'ra-meta-sep'
        sep.textContent = '·'
        const created = document.createElement('span')
        created.textContent = tr('配对于 {time}', { time: formatExactTime(device.createdAt) })
        meta.append(sep, created)
      }

      info.append(head, meta)

      const actions = document.createElement('div')
      actions.className = 'ra-device-actions'

      if (!isEditing) {
        const renameBtn = document.createElement('button')
        renameBtn.type = 'button'
        renameBtn.className = 'ghost icon-btn ra-icon-sm'
        renameBtn.title = tr('重命名')
        renameBtn.setAttribute('aria-label', tr('重命名'))
        renameBtn.disabled = state.busy.devices
        renameBtn.append(makeIcon('lucide-pencil'))
        renameBtn.onclick = () => {
          state.editingDeviceId = device.deviceId
          state.editingName = device.deviceName || ''
          renderDevicesCard(state.status)
        }
        actions.append(renameBtn)
      }

      const revokeBtn = document.createElement('button')
      revokeBtn.type = 'button'
      revokeBtn.className = 'ghost danger icon-btn ra-icon-sm'
      revokeBtn.title = tr('吊销设备')
      revokeBtn.setAttribute('aria-label', tr('吊销设备'))
      revokeBtn.disabled = state.busy.devices
      revokeBtn.append(makeIcon('lucide-trash-2'))
      revokeBtn.onclick = () => void confirmRevokeDevice(device)
      actions.append(revokeBtn)

      row.append(info, actions)
      dom.deviceList.append(row)
    }
  }

  function tunnelStateLabel(tunnelState) {
    switch (tunnelState) {
      case 'downloading': return tr('正在下载 cloudflared…')
      case 'probing': return tr('正在探测边缘节点…')
      case 'starting': return tr('正在建立隧道…')
      case 'running': return tr('运行中')
      case 'error': return tr('连接异常')
      default: return tr('已停止')
    }
  }

  function renderTunnelCard(st, forceFormSync) {
    const tCfg = st?.config?.tunnel || {}
    const tunnel = st?.tunnel || {}
    const tState = String(tunnel.state || 'stopped')

    dom.tunnelPill.classList.remove('is-running', 'is-stopped', 'is-pending', 'is-error')
    if (tState === 'running') dom.tunnelPill.classList.add('is-running')
    else if (TRANSITIONAL_TUNNEL_STATES.has(tState)) dom.tunnelPill.classList.add('is-pending')
    else if (tState === 'error') dom.tunnelPill.classList.add('is-error')
    else dom.tunnelPill.classList.add('is-stopped')
    dom.tunnelPillText.textContent = tunnelStateLabel(tState)

    // 已连接的边缘机房（colo）
    const locations = Array.isArray(tunnel.locations) ? tunnel.locations.filter(Boolean) : []
    dom.tunnelLocations.replaceChildren()
    if (locations.length > 0) {
      for (const colo of locations) {
        const chip = document.createElement('span')
        chip.className = 'ra-colo-chip'
        chip.textContent = String(colo)
        dom.tunnelLocations.append(chip)
      }
      dom.tunnelLocations.hidden = false
    } else {
      dom.tunnelLocations.hidden = true
    }

    // 启动 / 停止按钮显隐与禁用态
    const isActive = tState === 'running' || TRANSITIONAL_TUNNEL_STATES.has(tState)
    dom.tunnelStart.hidden = isActive
    dom.tunnelStop.hidden = !isActive
    dom.tunnelStart.disabled = state.busy.tunnel
    dom.tunnelStop.disabled = state.busy.tunnel

    // 错误横幅
    if (tunnel.lastError) {
      dom.tunnelErrorText.textContent = tr(String(tunnel.lastError))
      dom.tunnelError.hidden = false
    } else {
      dom.tunnelError.hidden = true
    }

    // 运行中的公网 HTTPS 地址
    const activePublicUrl = safeHttpUrl(tunnel.publicUrl)
    if (activePublicUrl) {
      dom.tunnelPublicUrlDisplay.textContent = activePublicUrl
      dom.tunnelPublicUrlDisplay.title = activePublicUrl
      dom.tunnelUrlRow.hidden = false
    } else {
      dom.tunnelUrlRow.hidden = true
    }

    // Token 配置状态（不回显明文）
    const hasToken = tCfg.hasToken === true
    dom.tokenStatus.hidden = !hasToken
    dom.clearToken.hidden = !hasToken
    dom.clearToken.disabled = state.busy.tunnel
    dom.tunnelToken.placeholder = hasToken
      ? tr('已保存 Token，留空保持不变；输入新值以更新')
      : tr('粘贴 Cloudflare Tunnel Token')

    // 表单字段回填（不覆盖用户正在编辑的内容，且绝不回填明文 Token）
    if (forceFormSync || !state.tunnelDirty) {
      setSelectedTunnelMode(tCfg.mode || 'quick')
      if (forceFormSync || document.activeElement !== dom.workerUrl) {
        dom.workerUrl.value = String(tCfg.workerUrl || '')
      }
      if (forceFormSync || document.activeElement !== dom.inviteCode) {
        dom.inviteCode.value = String(tCfg.inviteCode || '')
      }
      if (forceFormSync || document.activeElement !== dom.tunnelPublicUrl) {
        dom.tunnelPublicUrl.value = String(tCfg.publicUrl || '')
      }
      const edgeVer = tCfg.edgeIPVersion === '4' || tCfg.edgeIPVersion === '6' ? tCfg.edgeIPVersion : 'auto'
      dom.edgeIpVersion.value = edgeVer
      if (typeof syncUiSelect === 'function') syncUiSelect(dom.edgeIpVersion)
      dom.tunnelAutoStart.checked = tCfg.enabled === true
    }

    // 边缘测速结果（优先显示状态里的最新结果或上次手动测速结果）
    const probe = tunnel.edgeProbe || state.lastProbe
    renderEdgeProbe(probe)

    dom.tunnelProbe.disabled = state.busy.probe
    dom.tunnelSave.disabled = state.busy.tunnel
  }

  function renderEdgeProbe(probe) {
    dom.edgeProbeBox.replaceChildren()
    if (!probe || typeof probe !== 'object') {
      dom.edgeProbeBox.hidden = true
      return
    }
    const v4 = typeof probe.v4RttMs === 'number' && Number.isFinite(probe.v4RttMs) ? `${Math.round(probe.v4RttMs)} ms` : tr('不可达')
    const v6 = typeof probe.v6RttMs === 'number' && Number.isFinite(probe.v6RttMs) ? `${Math.round(probe.v6RttMs)} ms` : tr('不可达')
    const chosen = probe.chosen === '6' || probe.chosen === 6 ? 'IPv6'
      : (probe.chosen === '4' || probe.chosen === 4 ? 'IPv4' : (probe.chosen ? String(probe.chosen) : tr('自动')))

    const metrics = document.createElement('div')
    metrics.className = 'ra-probe-metrics'

    const items = [
      { label: 'IPv4 RTT', value: v4 },
      { label: 'IPv6 RTT', value: v6 },
      { label: tr('推荐协议'), value: chosen },
    ]
    for (const item of items) {
      const chip = document.createElement('span')
      chip.className = 'ra-probe-chip'
      const k = document.createElement('span')
      k.className = 'ra-probe-key'
      k.textContent = item.label
      const v = document.createElement('strong')
      v.textContent = item.value
      chip.append(k, v)
      metrics.append(chip)
    }
    dom.edgeProbeBox.append(metrics)

    // probeCloudflareEdge 返回的 polluted 通常是可疑 IP 数组（干净网络为空数组 []），
    // 不能直接写 if (probe.polluted)，否则空数组也会被当作真值误报污染告警。
    const pollutedList = Array.isArray(probe.polluted)
      ? probe.polluted.map((ip) => String(ip || '').trim()).filter(Boolean)
      : []
    const hasPolluted = pollutedList.length > 0 || probe.polluted === true
    if (hasPolluted) {
      const warn = document.createElement('div')
      warn.className = 'ra-probe-warn'
      warn.append(makeIcon('lucide-triangle-alert'))
      const msg = document.createElement('span')
      const baseText = tr('检测到 Cloudflare 边缘 DNS 污染风险，建议优先使用 IPv6 或配置代理。')
      msg.textContent = pollutedList.length > 0 ? `${baseText} (${pollutedList.join(', ')})` : baseText
      warn.append(msg)
      dom.edgeProbeBox.append(warn)
    }

    dom.edgeProbeBox.hidden = false
  }

  // ---- 数据同步与轮询 ----

  function applyStatus(raw, { forceFormSync = false } = {}) {
    const next = normalizeStatusPayload(raw)
    if (!next) return
    const prevDevicesCount = Array.isArray(state.status?.devices) ? state.status.devices.length : 0
    const hadPairing = Boolean(state.pairing)
    state.status = next
    state.loaded = true

    if (next.pairing && typeof next.pairing === 'object') {
      state.pairing = next.pairing
    } else if (next.pairing === null) {
      const nextDevicesCount = Array.isArray(next.devices) ? next.devices.length : 0
      if (hadPairing && nextDevicesCount > prevDevicesCount) {
        showHint(dom.pairHint, tr('新设备已配对成功！'))
      }
      state.pairing = null
    }
    if (next.tunnel?.edgeProbe) {
      state.lastProbe = next.tunnel.edgeProbe
    }
    renderAll({ forceFormSync })
  }

  async function loadStatus({ forceFormSync = false, silent = false } = {}) {
    if (state.loading) return
    state.loading = true
    dom.refreshBtn.classList.add('is-spinning')
    try {
      const data = await requestJson('/api/remote-access/status')
      applyStatus(data, { forceFormSync: forceFormSync || !state.loaded })
      if (!silent) showHint(dom.gatewayHint, '')
    } catch (error) {
      if (!silent) showHint(dom.gatewayHint, error.message, true)
    } finally {
      state.loading = false
      dom.refreshBtn.classList.remove('is-spinning')
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer)
    state.pollTimer = null
    if (!state.visible || document.hidden) return
    const tState = state.status?.tunnel?.state || 'stopped'
    const fast = TRANSITIONAL_TUNNEL_STATES.has(tState) || Boolean(state.pairing)
    state.pollTimer = setTimeout(() => {
      void loadStatus({ silent: true })
    }, fast ? 2000 : 8000)
  }

  // ---- 操作处理 ----

  function collectGatewayPatch() {
    const rawPort = dom.gatewayPort.value.trim()
    let gatewayPort = 0
    if (rawPort !== '') {
      const parsed = Number(rawPort)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(tr('端口必须是 0 到 65535 之间的整数。'))
      }
      gatewayPort = parsed
    }
    const customPublicUrl = dom.customPublicUrl.value.trim()
    if (customPublicUrl && !/^https?:\/\/[^\s]+$/i.test(customPublicUrl)) {
      throw new Error(tr('自定义公网地址请填写完整的 http(s):// 链接。'))
    }
    return {
      enabled: dom.enabled.checked,
      bindLan: dom.bindLan.checked,
      gatewayPort,
      customPublicUrl,
    }
  }

  function collectTunnelPatch() {
    const mode = selectedTunnelMode()
    const workerUrl = dom.workerUrl.value.trim()
    const inviteCode = dom.inviteCode.value.trim()
    const publicUrl = dom.tunnelPublicUrl.value.trim()
    const token = dom.tunnelToken.value.trim()
    const edgeIPVersion = dom.edgeIpVersion.value || 'auto'

    if (mode === 'worker' && workerUrl && !/^https?:\/\/[^\s]+$/i.test(workerUrl)) {
      throw new Error(tr('Worker 地址请填写完整的 http(s):// 链接。'))
    }
    if (mode === 'token' && publicUrl && !/^https?:\/\/[^\s]+$/i.test(publicUrl)) {
      throw new Error(tr('绑定公网域名请填写完整的 http(s):// 链接。'))
    }

    const tunnelPatch = {
      enabled: dom.tunnelAutoStart.checked,
      mode,
      workerUrl,
      inviteCode,
      publicUrl,
      edgeIPVersion,
    }
    if (token) tunnelPatch.token = token
    return { tunnel: tunnelPatch }
  }

  async function saveGatewayToggle(field, checked, inputEl) {
    if (state.busy.gateway) {
      inputEl.checked = !checked
      return
    }
    state.busy.gateway = true
    dom.enabled.disabled = true
    dom.bindLan.disabled = true
    dom.gatewaySave.disabled = true
    showHint(dom.gatewayHint, tr('正在应用设置…'))
    try {
      const data = await requestJson('/api/remote-access/config', {
        method: 'POST',
        body: { [field]: checked },
      })
      applyStatus(data, { forceFormSync: !state.gatewayDirty })
      showHint(dom.gatewayHint, tr('已更新。'))
    } catch (error) {
      inputEl.checked = !checked
      showHint(dom.gatewayHint, error.message, true)
    } finally {
      state.busy.gateway = false
      renderGatewayCard(state.status || {}, false)
    }
  }

  async function saveGatewayForm() {
    let patch
    try {
      patch = collectGatewayPatch()
    } catch (error) {
      showHint(dom.gatewayHint, error.message, true)
      return
    }
    state.busy.gateway = true
    renderGatewayCard(state.status || {}, false)
    showHint(dom.gatewayHint, tr('正在保存设置…'))
    try {
      const data = await requestJson('/api/remote-access/config', {
        method: 'POST',
        body: patch,
      })
      state.gatewayDirty = false
      applyStatus(data, { forceFormSync: true })
      showHint(dom.gatewayHint, tr('已保存网关设置。'))
    } catch (error) {
      showHint(dom.gatewayHint, error.message, true)
    } finally {
      state.busy.gateway = false
      renderGatewayCard(state.status || {}, false)
    }
  }

  async function generatePairing() {
    if (state.busy.pair) return
    state.busy.pair = true
    dom.generatePair.disabled = true
    showHint(dom.pairHint, tr('正在生成配对二维码…'))
    try {
      const data = await requestJson('/api/remote-access/pair', { method: 'POST', body: {} })
      if (!data?.pairing) throw new Error(tr('服务端未返回配对信息。'))
      state.pairing = data.pairing
      state.pairSource = (data.pairing.url && data.pairing.svg) ? 'primary' : 'lan'
      showHint(dom.pairHint, '')
      renderPairingCard(state.status || {})
      schedulePoll()
    } catch (error) {
      showHint(dom.pairHint, error.message, true)
    } finally {
      state.busy.pair = false
      renderPairingCard(state.status || {})
    }
  }

  async function submitRenameDevice(deviceId, rawName) {
    const deviceName = String(rawName || '').trim()
    if (!deviceName) {
      showHint(dom.devicesHint, tr('设备名称不能为空。'), true)
      return
    }
    state.busy.devices = true
    showHint(dom.devicesHint, tr('正在保存设备名称…'))
    try {
      await requestJson(`/api/remote-access/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        body: { deviceName },
      })
      state.editingDeviceId = ''
      state.editingName = ''
      showHint(dom.devicesHint, tr('已更新设备名称。'))
      await loadStatus({ silent: true })
    } catch (error) {
      showHint(dom.devicesHint, error.message, true)
    } finally {
      state.busy.devices = false
      if (state.status) renderDevicesCard(state.status)
    }
  }

  async function confirmRevokeDevice(device) {
    const name = device.deviceName || device.deviceId
    const ok = typeof appConfirm === 'function'
      ? await appConfirm(
        tr('吊销设备「{name}」后，该设备会立即断开连接并需要重新扫码配对。', { name }),
        { title: tr('吊销设备'), okText: tr('吊销'), cancelText: tr('取消') },
      )
      : window.confirm(tr('吊销设备「{name}」？', { name }))
    if (!ok) return

    state.busy.devices = true
    showHint(dom.devicesHint, tr('正在吊销设备…'))
    try {
      await requestJson(`/api/remote-access/devices/${encodeURIComponent(device.deviceId)}`, {
        method: 'DELETE',
      })
      if (state.editingDeviceId === device.deviceId) {
        state.editingDeviceId = ''
        state.editingName = ''
      }
      showHint(dom.devicesHint, tr('已吊销设备「{name}」。', { name }))
      await loadStatus({ silent: true })
    } catch (error) {
      showHint(dom.devicesHint, error.message, true)
    } finally {
      state.busy.devices = false
      if (state.status) renderDevicesCard(state.status)
    }
  }

  async function confirmRevokeAllDevices() {
    const count = Array.isArray(state.status?.devices) ? state.status.devices.length : 0
    if (count === 0) return
    const ok = typeof appConfirm === 'function'
      ? await appConfirm(
        tr('确定要吊销全部 {count} 台已配对设备吗？所有设备会立即断开，需要重新扫码配对。', { count }),
        { title: tr('吊销全部设备'), okText: tr('吊销全部'), cancelText: tr('取消') },
      )
      : window.confirm(tr('确定要吊销全部 {count} 台已配对设备吗？', { count }))
    if (!ok) return

    state.busy.devices = true
    showHint(dom.devicesHint, tr('正在吊销全部设备…'))
    try {
      const data = await requestJson('/api/remote-access/devices', { method: 'DELETE' })
      state.editingDeviceId = ''
      state.editingName = ''
      const removed = Number(data?.removed ?? count)
      showHint(dom.devicesHint, tr('已吊销 {count} 台设备。', { count: removed }))
      await loadStatus({ silent: true })
    } catch (error) {
      showHint(dom.devicesHint, error.message, true)
    } finally {
      state.busy.devices = false
      if (state.status) renderDevicesCard(state.status)
    }
  }

  async function saveTunnelForm({ silent = false } = {}) {
    let patch
    try {
      patch = collectTunnelPatch()
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
      return false
    }
    state.busy.tunnel = true
    renderTunnelCard(state.status || {}, false)
    if (!silent) showHint(dom.tunnelHint, tr('正在保存隧道配置…'))
    try {
      const data = await requestJson('/api/remote-access/config', {
        method: 'POST',
        body: patch,
      })
      // 写完即清输入框里的明文 Token，不留在 DOM 内存中
      dom.tunnelToken.value = ''
      state.tunnelDirty = false
      applyStatus(data, { forceFormSync: true })
      if (!silent) showHint(dom.tunnelHint, tr('已保存隧道配置。'))
      return true
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
      return false
    } finally {
      state.busy.tunnel = false
      renderTunnelCard(state.status || {}, false)
    }
  }

  async function clearSavedToken() {
    const ok = typeof appConfirm === 'function'
      ? await appConfirm(
        tr('确定清除已保存的 Cloudflare Tunnel Token 吗？清除后「已有 Tunnel」模式需重新填入 Token 才能启动。'),
        { title: tr('清除 Tunnel Token'), okText: tr('清除'), cancelText: tr('取消') },
      )
      : window.confirm(tr('确定清除已保存的 Cloudflare Tunnel Token 吗？'))
    if (!ok) return

    state.busy.tunnel = true
    showHint(dom.tunnelHint, tr('正在清除 Token…'))
    try {
      const data = await requestJson('/api/remote-access/config', {
        method: 'POST',
        body: { tunnel: { clearToken: true } },
      })
      dom.tunnelToken.value = ''
      applyStatus(data, { forceFormSync: !state.tunnelDirty })
      showHint(dom.tunnelHint, tr('已清除 Tunnel Token。'))
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
    } finally {
      state.busy.tunnel = false
      renderTunnelCard(state.status || {}, false)
    }
  }

  async function startTunnel() {
    if (state.busy.tunnel) return
    // 用户改了隧道参数或刚粘贴 Token 还没点保存，启动前顺手保存，避免用旧配置拉起隧道
    if (state.tunnelDirty || dom.tunnelToken.value.trim()) {
      const saved = await saveTunnelForm({ silent: true })
      if (!saved) return
    }
    state.busy.tunnel = true
    renderTunnelCard(state.status || {}, false)
    showHint(dom.tunnelHint, tr('正在启动 Cloudflare 隧道…'))
    try {
      const data = await requestJson('/api/remote-access/tunnel/start', { method: 'POST', body: {} })
      if (state.status) {
        if (data.tunnel) state.status.tunnel = data.tunnel
        if (data.gateway) state.status.gateway = data.gateway
        renderAll()
      }
      showHint(dom.tunnelHint, '')
      await loadStatus({ silent: true })
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
      await loadStatus({ silent: true })
    } finally {
      state.busy.tunnel = false
      if (state.status) renderTunnelCard(state.status, false)
    }
  }

  async function stopTunnel() {
    if (state.busy.tunnel) return
    state.busy.tunnel = true
    renderTunnelCard(state.status || {}, false)
    showHint(dom.tunnelHint, tr('正在停止隧道…'))
    try {
      const data = await requestJson('/api/remote-access/tunnel/stop', { method: 'POST', body: {} })
      if (state.status && data.tunnel) {
        state.status.tunnel = data.tunnel
        renderAll()
      }
      showHint(dom.tunnelHint, tr('隧道已停止。'))
      await loadStatus({ silent: true })
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
    } finally {
      state.busy.tunnel = false
      if (state.status) renderTunnelCard(state.status, false)
    }
  }

  async function probeEdge() {
    if (state.busy.probe) return
    state.busy.probe = true
    dom.tunnelProbe.disabled = true
    dom.tunnelProbe.classList.add('is-spinning')
    showHint(dom.tunnelHint, tr('正在探测 Cloudflare 边缘节点延迟…'))
    try {
      const data = await requestJson('/api/remote-access/tunnel/probe', { method: 'POST', body: {} })
      if (data?.edgeProbe) {
        state.lastProbe = data.edgeProbe
        if (state.status?.tunnel) state.status.tunnel.edgeProbe = data.edgeProbe
        renderEdgeProbe(data.edgeProbe)
        showHint(dom.tunnelHint, tr('边缘测速完成。'))
      } else {
        showHint(dom.tunnelHint, tr('未获取到测速结果。'), true)
      }
    } catch (error) {
      showHint(dom.tunnelHint, error.message, true)
    } finally {
      state.busy.probe = false
      dom.tunnelProbe.disabled = false
      dom.tunnelProbe.classList.remove('is-spinning')
    }
  }

  // ---- 事件绑定 ----

  dom.refreshBtn.onclick = () => void loadStatus()
  dom.enabled.onchange = () => void saveGatewayToggle('enabled', dom.enabled.checked, dom.enabled)
  dom.bindLan.onchange = () => void saveGatewayToggle('bindLan', dom.bindLan.checked, dom.bindLan)
  dom.gatewayPort.oninput = () => { state.gatewayDirty = true }
  dom.customPublicUrl.oninput = () => { state.gatewayDirty = true }
  dom.gatewaySave.onclick = () => void saveGatewayForm()

  dom.generatePair.onclick = () => void generatePairing()
  dom.pairSourceTabs.onclick = (event) => {
    const btn = event.target.closest('[data-pair-source]')
    if (!btn) return
    const next = btn.dataset.pairSource === 'lan' ? 'lan' : 'primary'
    if (state.pairSource === next) return
    state.pairSource = next
    renderPairingCard(state.status || {})
  }
  dom.copyPairCode.onclick = () => void copyText(dom.pairCode.textContent, dom.copyPairCode, dom.pairHint)
  dom.copyPairUrl.onclick = () => void copyText(dom.pairUrl.textContent, dom.copyPairUrl, dom.pairHint)
  dom.openPairUrl.onclick = () => openExternalUrl(dom.pairUrl.textContent)

  dom.revokeAll.onclick = () => void confirmRevokeAllDevices()

  for (const radio of dom.modeRadios) {
    radio.onchange = () => {
      state.tunnelDirty = true
      updateTunnelModeFields(radio.value)
    }
  }
  dom.workerUrl.oninput = () => { state.tunnelDirty = true }
  dom.inviteCode.oninput = () => { state.tunnelDirty = true }
  dom.tunnelToken.oninput = () => { state.tunnelDirty = true }
  dom.tunnelPublicUrl.oninput = () => { state.tunnelDirty = true }
  dom.edgeIpVersion.onchange = () => { state.tunnelDirty = true }
  dom.tunnelAutoStart.onchange = () => { state.tunnelDirty = true }
  dom.clearToken.onclick = () => void clearSavedToken()
  dom.tunnelSave.onclick = () => void saveTunnelForm()
  dom.tunnelStart.onclick = () => void startTunnel()
  dom.tunnelStop.onclick = () => void stopTunnel()
  dom.tunnelProbe.onclick = () => void probeEdge()
  dom.copyTunnelUrl.onclick = () => void copyText(dom.tunnelPublicUrlDisplay.textContent, dom.copyTunnelUrl, dom.tunnelHint)
  dom.openTunnelUrl.onclick = () => openExternalUrl(mobileEntryUrl(dom.tunnelPublicUrlDisplay.textContent))

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.pollTimer)
      state.pollTimer = null
    } else if (state.visible) {
      void loadStatus({ silent: true })
    }
  })

  // 暴露给 index.html 的面板切换、语言重绘与 SSE 回调
  globalThis.remoteAccessUi = {
    onViewChange(paneName, settingsCategory) {
      const nowVisible = paneName === 'settings' && settingsCategory === 'remote-access'
      const becameVisible = nowVisible && !state.visible
      state.visible = nowVisible
      if (becameVisible) {
        void loadStatus({ silent: state.loaded })
      } else if (!nowVisible) {
        clearTimeout(state.pollTimer)
        state.pollTimer = null
        stopCountdown()
      }
    },
    applyStatus(payload) {
      applyStatus(payload)
    },
    repaint() {
      if (state.status) renderAll()
    },
  }
})()
