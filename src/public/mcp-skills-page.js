// ---- MCP 服务器：写进 profile 补丁层里的 dsh-mcp-client 条目 ----
let instanceToolScope = { profile: '', home: '' }
let instanceToolMountKey = ''
function toolScopeOptions() {
  return (instanceToolScope.profile || instanceToolScope.home)
    ? { launchId: '', ...(instanceToolScope.home ? { home: instanceToolScope.home } : {}) }
    : {}
}
function withToolProfile(body = {}) {
  return instanceToolScope.profile ? { ...body, profile: instanceToolScope.profile } : body
}
const mcpListEl = document.getElementById('mcpList')
const mcpHintEl = document.getElementById('mcpHint')
const mcpSubtabsEl = document.getElementById('mcpSubtabs')
const mcpTotalCountEl = document.getElementById('mcpTotalCount')
const mcpSearchEl = document.getElementById('mcpSearch')
const mcpMarketPaneEl = document.getElementById('mcpMarketPane')
const mcpMarketListEl = document.getElementById('mcpMarketList')
const mcpMarketErrorEl = document.getElementById('mcpMarketError')
const mcpProbeEl = document.getElementById('mcpProbe')
const mcpRefreshEl = document.getElementById('mcpRefresh')
const mcpDialogEl = document.getElementById('mcpDialog')
const mcpDialogNoteEl = document.getElementById('mcpDialogNote')
const mcpNameEl = document.getElementById('mcpName')
const mcpTransportEl = document.getElementById('mcpTransport')
const mcpCommandEl = document.getElementById('mcpCommand')
const mcpUrlEl = document.getElementById('mcpUrl')
const mcpEnvEl = document.getElementById('mcpEnv')
const mcpHeadersEl = document.getElementById('mcpHeaders')
const mcpTimeoutEl = document.getElementById('mcpTimeout')
let mcpServers = []
let mcpSubTab = 'installed'
let mcpSearch = ''
const mcpMarketState = {
  curatedItems: [],
  curatedLoaded: false,
  registryItems: [],
  registryLoaded: false,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: '',
  installingId: '',
  seq: 0,
  searchTimer: 0,
}

const transportLabel = (value) => value === 'streamable-http' ? 'HTTP' : 'stdio'
const setMcpHint = (text) => {
  mcpHintEl.textContent = text || ''
  mcpHintEl.hidden = !text || (mcpSubTab !== 'installed' && text === t('检测会真的起进程或连端点，可能需要几秒。'))
}
function syncMcpSubtabs() {
  mcpSubtabsEl?.querySelectorAll('[data-mcp-subtab]').forEach((button) => {
    const active = button.dataset.mcpSubtab === mcpSubTab
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', String(active))
  })
  if (mcpProbeEl) mcpProbeEl.hidden = mcpSubTab !== 'installed'
  globalThis.syncSubtabPill?.(mcpSubtabsEl)
}

function mcpRow(server) {
  const row = document.createElement('div')
  // 与已安装插件复用同一套双列卡片样式与紧凑开关/操作条
  row.className = `toggle plugin-row pack-row plugin-market-card plugin-installed-card mcp-card${server.disabled ? ' off' : ''}`
  const isHttp = server.transport === 'streamable-http'
  const timeoutText = !server.broken && server.toolCallTimeoutMs ? `${server.toolCallTimeoutMs}ms` : ''
  const summary = server.broken ? (server.error || '补丁层里这行读不出来，删掉重加一次即可') : (server.command || server.url || '')
  row.title = [server.serverName, server.transport, summary, timeoutText].filter(Boolean).join(' · ')

  const head = document.createElement('div')
  head.className = 'plugin-installed-head'

  const iconWrap = document.createElement('div')
  const iconTone = server.broken ? 'amber' : isHttp ? 'cyan' : toneForCardName(server.serverName)
  const iconId = server.broken ? 'lucide-triangle-alert' : isHttp ? 'lucide-globe' : 'lucide-terminal'
  iconWrap.className = `plugin-market-icon tone-${iconTone}`
  iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${iconId}"/></svg>`

  const meta = document.createElement('div')
  meta.className = 'plugin-market-meta'
  const nameRow = document.createElement('div')
  nameRow.className = 'plugin-market-name'
  const name = document.createElement('span')
  name.className = 'plugin-name'
  name.textContent = server.serverName
  nameRow.append(name)

  const subRow = document.createElement('div')
  subRow.className = 'plugin-installed-sub'
  const transportTag = document.createElement('span')
  transportTag.className = `plugin-status plugin-market-tag${isHttp ? ' is-official' : ''}`
  transportTag.textContent = transportLabel(server.transport)
  subRow.append(transportTag)
  if (timeoutText) {
    const timeoutEl = document.createElement('span')
    timeoutEl.className = 'plugin-version plugin-market-sub'
    timeoutEl.textContent = timeoutText
    subRow.append(timeoutEl)
  }
  if (server.broken || server.disabled) {
    const stateTag = document.createElement('span')
    stateTag.className = `plugin-status plugin-market-tag${server.broken ? ' is-warn' : ''}`
    stateTag.textContent = server.broken ? t('条目损坏') : t('已停用')
    subRow.append(stateTag)
  }
  meta.append(nameRow, subRow)

  const actions = document.createElement('div')
  actions.className = 'plugin-installed-actions'
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.checked = !server.disabled
  toggle.disabled = server.broken === true
  toggle.setAttribute('aria-label', t('启用 {name}', { name: server.serverName }))
  toggle.onchange = async () => {
    const enabled = toggle.checked
    toggle.disabled = true
    try {
      const data = await post('/api/mcp/toggle', withToolProfile({ serverName: server.serverName, enabled }), toolScopeOptions())
      mcpServers = data.servers || []
      renderMcp()
    } catch (error) { setMcpHint(error.message); toggle.checked = !enabled } finally { toggle.disabled = false }
  }
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'ghost icon-btn'
  edit.title = edit.ariaLabel = t('编辑')
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-pencil"/></svg>'
  edit.onclick = () => openMcpDialog(server)
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'ghost icon-btn card-danger-btn'
  remove.title = remove.ariaLabel = t('删除')
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-trash-2"/></svg>'
  remove.onclick = async () => {
    remove.disabled = true
    try {
      const data = await post('/api/mcp/remove', withToolProfile({ serverName: server.serverName }), toolScopeOptions())
      mcpServers = data.servers || []
      renderMcp()
      setMcpHint(t('已删除 {name}。dsh 在跑会热加载。', { name: server.serverName }))
    } catch (error) { setMcpHint(error.message) } finally { remove.disabled = false }
  }
  actions.append(toggle, edit, remove)
  head.append(iconWrap, meta, actions)
  row.append(head)

  if (summary) {
    const desc = document.createElement('div')
    desc.className = 'plugin-desc plugin-market-desc plugin-installed-desc'
    desc.textContent = summary
    row.append(desc)
  }
  return row
}

function isMcpInstalled(item) {
  const target = String(item?.name || item?.installConfig?.name || '').trim().toLowerCase()
  if (!target) return false
  return mcpServers.some((server) => String(server.serverName || '').trim().toLowerCase() === target)
}

function mcpMarketCard(item) {
  const installed = isMcpInstalled(item)
  const installing = mcpMarketState.installingId === item.id
  const busy = Boolean(mcpMarketState.installingId)
  const isHttp = item.transport === 'streamable-http'
  const tone = isHttp ? 'cyan' : toneForCardName(item.name || item.title)
  const fallbackIcon = isHttp ? 'lucide-globe' : 'lucide-terminal'
  const card = document.createElement('div')
  card.className = `plugin-market-card${installed ? ' is-installed' : ''}`
  card.title = [item.title || item.name, item.description].filter(Boolean).join('\n')

  const iconWrap = document.createElement('div')
  const safeIcon = safeIconUrl(item.icon)
  iconWrap.className = `plugin-market-icon tone-${tone}${safeIcon ? ` has-image${isAvatarIconUrl(safeIcon) ? ' has-avatar' : ''}` : ''}`
  if (safeIcon) {
    const img = document.createElement('img')
    img.src = safeIcon
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.onerror = () => {
      iconWrap.classList.remove('has-image', 'has-avatar')
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${fallbackIcon}"/></svg>`
    }
    iconWrap.append(img)
  } else {
    iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${fallbackIcon}"/></svg>`
  }

  const meta = document.createElement('div')
  meta.className = 'plugin-market-meta'
  const nameRow = document.createElement('div')
  nameRow.className = 'plugin-market-name'
  const titleEl = document.createElement('span')
  titleEl.textContent = item.title || item.name
  nameRow.append(titleEl)
  if (item.badge) {
    const badgeEl = document.createElement('span')
    badgeEl.className = `plugin-status plugin-market-tag${item.needsConfig ? '' : ' is-official'}`
    badgeEl.textContent = item.badge
    nameRow.append(badgeEl)
  }
  const subEl = document.createElement('div')
  subEl.className = 'plugin-market-sub'
  const subParts = [transportLabel(item.transport), item.packageName || item.id]
  if (item.version) subParts.push(`v${item.version}`)
  subEl.textContent = subParts.filter(Boolean).join(' · ')
  meta.append(nameRow, subEl)
  if (item.description) {
    const desc = document.createElement('div')
    desc.className = 'plugin-market-desc'
    desc.textContent = item.description
    meta.append(desc)
  }

  const cardActions = document.createElement('div')
  cardActions.className = 'tool-market-card-actions'
  const href = safeExternalHref(item.homepage)
  if (href) {
    const link = document.createElement('a')
    link.className = 'ghost icon-btn plugin-market-link'
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.title = t('官方网站')
    link.setAttribute('aria-label', t('官方网站'))
    link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-external-link"/></svg>'
    cardActions.append(link)
  }
  if (installed) {
    const badge = document.createElement('span')
    badge.className = 'plugin-market-installed'
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg><span>${escapeHtml(t('已安装'))}</span>`
    cardActions.append(badge)
  } else {
    const action = document.createElement('button')
    action.type = 'button'
    action.className = `ghost plugin-market-install${installing ? ' is-installing' : ''}`
    action.disabled = busy
    action.textContent = installing ? t('正在安装…') : (item.needsConfig ? t('配置并安装') : t('安装'))
    action.onclick = async () => {
      const cfg = item.installConfig || {}
      if (item.needsConfig || (!cfg.command && !cfg.url)) {
        openMcpDialog({
          serverName: cfg.name || item.name,
          transport: cfg.transport || item.transport || 'stdio',
          command: cfg.command || '',
          args: cfg.args || [],
          env: cfg.env || {},
          url: cfg.url || '',
          headers: cfg.headers || {},
        }, {
          fromPreset: true,
          note: item.configHint || (item.envHints?.length ? `${item.envHints.map((e) => e.name).join('、')}` : ''),
        })
        return
      }
      mcpMarketState.installingId = item.id
      renderMcpMarket()
      try {
        const payload = {
          serverName: cfg.name || item.name,
          transport: cfg.transport || 'stdio',
          ...(cfg.command ? { command: cfg.command, args: cfg.args || [] } : {}),
          ...(cfg.url ? { url: cfg.url } : {}),
          ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}),
          ...(cfg.headers && Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
        }
        const data = await post('/api/mcp/save', withToolProfile(payload), toolScopeOptions())
        mcpServers = data.servers || []
        if (mcpTotalCountEl) mcpTotalCountEl.textContent = String(mcpServers.length)
        setMcpHint(t('{name} 已保存，dsh 在跑会热加载。', { name: payload.serverName }))
      } catch (error) {
        if (mcpMarketErrorEl) {
          mcpMarketErrorEl.textContent = error.message
          mcpMarketErrorEl.hidden = false
        } else {
          setMcpHint(error.message)
        }
      } finally {
        mcpMarketState.installingId = ''
        renderMcpMarket()
      }
    }
    cardActions.append(action)
  }
  card.append(iconWrap, meta, cardActions)
  return card
}

function renderMcpMarket() {
  if (!mcpMarketListEl) return
  if (mcpRefreshEl) mcpRefreshEl.classList.toggle('is-loading', mcpMarketState.loading)
  const isRegistry = mcpSubTab === 'market'
  const rawItems = isRegistry ? mcpMarketState.registryItems : mcpMarketState.curatedItems
  const terms = mcpSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const items = !isRegistry && terms.length
    ? rawItems.filter((item) => {
        const hay = `${item.title || ''}\n${item.name || ''}\n${item.description || ''}\n${item.packageName || ''}`.toLowerCase()
        return terms.every((term) => hay.includes(term))
      })
    : rawItems

  if (mcpMarketErrorEl) {
    mcpMarketErrorEl.textContent = mcpMarketState.error || ''
    mcpMarketErrorEl.hidden = !mcpMarketState.error
  }
  mcpMarketListEl.textContent = ''
  if (mcpMarketState.loading && !items.length) {
    mcpMarketListEl.innerHTML = globalThis.marketLoadingHtml(t('加载中…'))
    return
  }
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'plugin-empty'
    empty.textContent = mcpMarketState.error
      ? t('暂时无法读取 MCP 市场')
      : (mcpSearch.trim() ? t('没有找到匹配的 MCP 服务器。') : t('还没有精选 MCP 服务器。'))
    mcpMarketListEl.append(empty)
    return
  }
  const grid = document.createElement('div')
  grid.className = 'plugin-market-grid'
  for (const item of items) grid.append(mcpMarketCard(item))
  mcpMarketListEl.append(grid)

  if (isRegistry && mcpMarketState.nextCursor) {
    const moreBtn = document.createElement('button')
    moreBtn.type = 'button'
    moreBtn.className = 'ghost plugin-market-more'
    moreBtn.disabled = mcpMarketState.loadingMore
    moreBtn.textContent = mcpMarketState.loadingMore ? t('加载中…') : t('加载更多')
    moreBtn.onclick = () => { void loadMcpMarket({ append: true, cursor: mcpMarketState.nextCursor }) }
    mcpMarketListEl.append(moreBtn)
  }
}

async function loadMcpMarket({ refresh = false, append = false, cursor = '' } = {}) {
  const mode = mcpSubTab === 'market' ? 'registry' : 'curated'
  const seq = ++mcpMarketState.seq
  if (append) mcpMarketState.loadingMore = true
  else {
    mcpMarketState.loading = true
    mcpMarketState.error = ''
  }
  renderMcpMarket()
  try {
    const params = new URLSearchParams({ mode, limit: '30' })
    if (mode === 'registry' && mcpSearch.trim()) params.set('q', mcpSearch.trim())
    if (append && cursor) params.set('cursor', cursor)
    if (refresh) params.set('refresh', '1')
    const data = await getJson(`/api/mcp-market?${params.toString()}`)
    if (seq !== mcpMarketState.seq) return
    const nextItems = Array.isArray(data?.items) ? data.items : []
    if (mode === 'curated') {
      mcpMarketState.curatedItems = nextItems
      mcpMarketState.curatedLoaded = true
    } else {
      mcpMarketState.registryItems = append ? [...mcpMarketState.registryItems, ...nextItems] : nextItems
      mcpMarketState.registryLoaded = true
      mcpMarketState.nextCursor = data?.nextCursor || null
    }
    mcpMarketState.error = data?.error || ''
  } catch (error) {
    if (seq !== mcpMarketState.seq) return
    mcpMarketState.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (seq === mcpMarketState.seq) {
      mcpMarketState.loading = false
      mcpMarketState.loadingMore = false
      renderMcpMarket()
    }
  }
}

function renderMcp() {
  if (mcpTotalCountEl) mcpTotalCountEl.textContent = String(mcpServers.length)
  syncMcpSubtabs()
  const isInstalled = mcpSubTab === 'installed'
  if (mcpListEl) mcpListEl.hidden = !isInstalled
  if (mcpMarketPaneEl) mcpMarketPaneEl.hidden = isInstalled
  if (mcpHintEl) {
    const defaultProbeHint = t('检测会真的起进程或连端点，可能需要几秒。')
    mcpHintEl.hidden = !mcpHintEl.textContent || (!isInstalled && mcpHintEl.textContent === defaultProbeHint)
  }
  if (!isInstalled) {
    renderMcpMarket()
    return
  }
  mcpRefreshEl?.classList.remove('is-loading')
  mcpListEl.textContent = ''
  const terms = mcpSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = mcpServers.filter((server) => {
    if (!terms.length) return true
    const hay = `${server.serverName}\n${server.command || ''}\n${server.url || ''}\n${server.transport || ''}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'plugin-empty'
    empty.textContent = mcpServers.length ? t('没有匹配的 MCP 服务器。') : t('还没有 MCP 服务器。点右上角「添加」写一台。')
    mcpListEl.append(empty)
    return
  }
  for (const server of filtered) mcpListEl.append(mcpRow(server))
}
mcpSubtabsEl?.addEventListener('click', (event) => {
  const btn = event.target.closest?.('[data-mcp-subtab]')
  if (!btn) return
  const next = btn.dataset.mcpSubtab || 'installed'
  if (next === mcpSubTab) return
  mcpSubTab = next
  if (mcpMarketErrorEl) mcpMarketErrorEl.hidden = true
  renderMcp()
  animateSubPane(next === 'installed' ? mcpListEl : mcpMarketPaneEl)
  if (next === 'curated' && !mcpMarketState.curatedLoaded) void loadMcpMarket()
  else if (next === 'market' && (!mcpMarketState.registryLoaded || mcpSearch.trim())) void loadMcpMarket()
})
if (mcpSearchEl) {
  mcpSearchEl.oninput = () => {
    mcpSearch = mcpSearchEl.value
    if (mcpSubTab === 'installed') {
      renderMcp()
      return
    }
    renderMcpMarket()
    if (mcpSubTab === 'market') {
      clearTimeout(mcpMarketState.searchTimer)
      mcpMarketState.searchTimer = setTimeout(() => {
        void loadMcpMarket()
      }, 250)
    }
  }
}

let mcpLoadSeq = 0
async function loadMcp() {
  const seq = ++mcpLoadSeq
  try {
    const query = instanceToolScope.profile ? `?profile=${encodeURIComponent(instanceToolScope.profile)}` : ''
    const data = await getJson(`/api/mcp${query}`, toolScopeOptions())
    if (seq !== mcpLoadSeq) return
    mcpServers = data.servers || []
    renderMcp()
    requestAnimationFrame(() => globalThis.syncSubtabPill?.(mcpSubtabsEl))
  } catch (error) {
    if (seq === mcpLoadSeq) setMcpHint(error.message)
  }
}

function syncMcpRows() {
  const stdio = mcpTransportEl.value !== 'streamable-http'
  for (const row of mcpDialogEl.querySelectorAll('[data-mcp-row]')) {
    row.hidden = stdio ? row.dataset.mcpRow !== 'stdio' : row.dataset.mcpRow !== 'http'
  }
}

let mcpOriginalCommand = null
function openMcpDialog(server, { fromPreset = false, note = '' } = {}) {
  const isEdit = Boolean(server) && !fromPreset
  mcpDialogEl.dataset.edit = isEdit ? server.serverName : ''
  document.getElementById('mcpDialogTitle').textContent = isEdit ? t('编辑 MCP 服务器') : t('添加 MCP 服务器')
  mcpNameEl.value = server?.serverName ?? ''
  mcpNameEl.disabled = isEdit
  mcpTransportEl.value = server?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  // 直改 value 不会触发 change，触发器文案要手动同步（顺带把 i18n 后的选项文案刷上）
  syncUiSelect(mcpTransportEl)
  const quoteArg = (value) => /^[A-Za-z0-9_@./:=+-]+$/.test(String(value)) ? String(value) : JSON.stringify(String(value))
  mcpCommandEl.value = server?.command ? [server.command, ...(server.args || [])].map(quoteArg).join(' ') : ''
  // 文本框无法原样显示多行参数；用户没改命令时直接沿用 argv，避免编辑超时顺带改坏参数。
  mcpOriginalCommand = server ? { line: mcpCommandEl.value, command: server.command, args: server.args || [] } : null
  mcpUrlEl.value = server?.url ?? ''
  const envEntries = server?.env && typeof server.env === 'object' ? Object.entries(server.env) : []
  if (mcpEnvEl) mcpEnvEl.value = envEntries.map(([k, v]) => `${k}=${v ?? ''}`).join('\n')
  const hasHeaders = Boolean(server?.headers && Object.keys(server.headers).length)
  mcpHeadersEl.value = hasHeaders ? JSON.stringify(server.headers) : ''
  mcpTimeoutEl.value = server?.toolCallTimeoutMs ?? ''
  resetMcpAdvanced(Boolean(hasHeaders || envEntries.length || server?.toolCallTimeoutMs))
  if (note) {
    mcpDialogNoteEl.textContent = note
    mcpDialogNoteEl.hidden = false
  } else {
    mcpDialogNoteEl.hidden = true
  }
  syncMcpRows()
  showDialog(mcpDialogEl)
  if (!isEdit && !fromPreset) mcpNameEl.focus()
  else if (fromPreset && envEntries.length && mcpEnvEl) mcpEnvEl.focus()
}

const closeMcpDialog = () => { void hideDialog(mcpDialogEl) }
const noteInDialog = (text) => { mcpDialogNoteEl.textContent = text; mcpDialogNoteEl.hidden = !text }

async function saveMcp() {
  const button = document.getElementById('mcpSave')
  const name = mcpNameEl.value.trim()
  const transport = mcpTransportEl.value
  const headers = mcpHeadersEl.value.trim()
  if (headers) {
    try {
      JSON.parse(headers)
    } catch {
      noteInDialog(t('请求头不是合法 JSON'))
      return
    }
  }
  let envLines
  if (transport === 'stdio' && mcpEnvEl) {
    envLines = mcpEnvEl.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const bad = envLines.find((line) => line.indexOf('=') <= 0)
    if (bad) {
      noteInDialog(t('每行环境变量都要写 KEY=VALUE：{line}', { line: bad }))
      return
    }
  }
  const spec = {
    serverName: mcpDialogEl.dataset.edit || name,
    transport,
    commandLine: transport === 'stdio' ? mcpCommandEl.value.trim() : undefined,
    ...(transport === 'stdio' && envLines !== undefined ? { env: envLines } : {}),
    url: transport === 'stdio' ? '' : mcpUrlEl.value.trim(),
    headers: transport === 'stdio' || !headers ? undefined : JSON.parse(headers),
    toolCallTimeoutMs: mcpTimeoutEl.value.trim() || undefined,
  }
  if (transport === 'stdio' && mcpOriginalCommand && mcpCommandEl.value === mcpOriginalCommand.line) {
    delete spec.commandLine
    spec.command = mcpOriginalCommand.command
    spec.args = mcpOriginalCommand.args
  }
  button.disabled = true
  try {
    const data = await post('/api/mcp/save', withToolProfile(spec), toolScopeOptions())
    mcpServers = data.servers || []
    closeMcpDialog()
    renderMcp()
    const notes = [...(data.warnings || [])]
    setMcpHint(notes.length ? notes.join('；') : t('{name} 已保存，dsh 在跑会热加载。', { name: spec.serverName }))
  } catch (error) {
    noteInDialog(error.message)
  } finally {
    button.disabled = false
  }
}

document.getElementById('mcpAdd').onclick = () => openMcpDialog(null)
document.getElementById('mcpCancel').onclick = closeMcpDialog
trapPackDialog(mcpDialogEl, closeMcpDialog)
mcpTransportEl.onchange = syncMcpRows
document.getElementById('mcpSave').onclick = saveMcp
const mcpAdvancedEl = document.getElementById('mcpAdvanced')
let mcpAdvancedMotion = null, mcpAdvancedOpening = null
function resetMcpAdvanced(open) {
  mcpAdvancedMotion?.cancel(); mcpAdvancedMotion = null; mcpAdvancedOpening = null
  mcpAdvancedEl.style.overflow = ''; mcpAdvancedEl.open = open
}
mcpAdvancedEl.querySelector('summary').onclick = (event) => {
  event.preventDefault()
  const opening = !(mcpAdvancedOpening ?? mcpAdvancedEl.open)
  const from = mcpAdvancedEl.getBoundingClientRect().height
  mcpAdvancedMotion?.cancel()
  if (isReducedMotion() || typeof mcpAdvancedEl.animate !== 'function') { resetMcpAdvanced(opening); return }
  mcpAdvancedEl.open = true
  mcpAdvancedEl.style.overflow = 'hidden'
  const target = opening ? mcpAdvancedEl.getBoundingClientRect().height : mcpAdvancedEl.querySelector('summary').getBoundingClientRect().height
  mcpAdvancedOpening = opening
  const animation = mcpAdvancedEl.animate([{ height: `${from}px` }, { height: `${target}px` }], { duration: MOTION.duration.disclosure, easing: MOTION.ease.standard, fill: 'both' })
  mcpAdvancedMotion = animation
  animation.finished.then(() => {
    if (mcpAdvancedMotion !== animation) return
    mcpAdvancedEl.open = opening; mcpAdvancedEl.style.overflow = ''; mcpAdvancedOpening = null; mcpAdvancedMotion = null; animation.cancel()
  }).catch(() => {})
}
document.getElementById('mcpRefresh').onclick = () => {
  if (mcpSubTab === 'installed') void loadMcp()
  else void loadMcpMarket({ refresh: true })
}
document.getElementById('mcpProbe').onclick = async () => {
  const button = document.getElementById('mcpProbe')
  button.disabled = true
  setMcpHint(t('正在检测（真起进程 / 真连端点）…'))
  try {
    const data = await post('/api/mcp/probe', withToolProfile({}), toolScopeOptions())
    const results = data.results || []
    const ok = results.filter((item) => item.ok).length
    const failed = results.filter((item) => !item.ok)
    setMcpHint(failed.length
      ? t('{ok} 台可用，{bad} 台有问题：{list}', { ok, bad: failed.length, list: failed.map((item) => `${item.serverName}（${item.detail || item.stage}）`).join('；') })
      : t('{ok} 台都可用。', { ok }))
  } catch (error) { setMcpHint(error.message) } finally { button.disabled = false }
}

// ---- 技能：~/.dsh/skills 与 ~/.agents/skills ----
const skillListEl = document.getElementById('skillList')
const skillHintEl = document.getElementById('skillHint')
const skillSubEl = document.getElementById('skillSub')
const skillSubtabsEl = document.getElementById('skillSubtabs')
const skillTotalCountEl = document.getElementById('skillTotalCount')
const skillSearchEl = document.getElementById('skillSearch')
const skillMarketPaneEl = document.getElementById('skillMarketPane')
const skillMarketListEl = document.getElementById('skillMarketList')
const skillMarketErrorEl = document.getElementById('skillMarketError')
const skillRefreshEl = document.getElementById('skillRefresh')
let skillItems = []
let skillSubTab = 'installed'
let skillSearch = ''
const skillMarketState = {
  marketItems: [],
  marketLoaded: false,
  marketTotal: 0,
  page: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: '',
  installingKey: '',
  seq: 0,
  searchTimer: 0,
}
function syncSkillSubtabs() {
  skillSubtabsEl?.querySelectorAll('[data-skill-subtab]').forEach((button) => {
    const active = button.dataset.skillSubtab === skillSubTab
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', String(active))
  })
  globalThis.syncSubtabPill?.(skillSubtabsEl)
}
const skillDetailDialogEl = document.getElementById('skillDetailDialog')
const skillDetailContentEl = document.getElementById('skillDetailContent')
let skillDetailRequest = 0
let skillDetailOrigin = null
async function openSkillDetail(skill, origin) {
  const request = ++skillDetailRequest
  skillDetailOrigin = origin
  document.getElementById('skillDetailTitle').textContent = skill.name || skill.dirName
  document.getElementById('skillDetailPath').textContent = skill.file || skill.relPath
  document.getElementById('skillDetailDescription').textContent = skill.description || skill.frontmatterIssue || ''
  skillDetailContentEl.textContent = t('正在读取…')
  skillDetailContentEl.scrollTop = 0
  showDialog(skillDetailDialogEl)
  document.getElementById('skillDetailClose').focus()
  try {
    const params = new URLSearchParams({ root: skill.root, path: skill.relPath, ...(instanceToolScope.profile ? { profile: instanceToolScope.profile } : {}) })
    const data = await getJson(`/api/skills/detail?${params}`, toolScopeOptions())
    if (request !== skillDetailRequest) return
    // 技能里的 Markdown/HTML 只显示原文，避免本地技能文件变成页面脚本。
    skillDetailContentEl.textContent = data.content
  } catch (error) {
    if (request === skillDetailRequest) skillDetailContentEl.textContent = error.message
  }
}
async function closeSkillDetail() {
  skillDetailRequest += 1
  if (await hideDialog(skillDetailDialogEl)) skillDetailOrigin?.focus({ preventScroll: true })
}
document.getElementById('skillDetailClose').onclick = closeSkillDetail
trapPackDialog(skillDetailDialogEl, closeSkillDetail)

const skillInstallDialogEl = document.getElementById('skillInstallDialog')
const skillInspectEl = document.getElementById('skillInspect')
const skillInstallGoEl = document.getElementById('skillInstallGo')
const skillImportListEl = document.getElementById('skillImportList')
const skillInstallErrorEl = document.getElementById('skillInstallError')
let skillSourceMode = 'github', skillImportToken = '', skillImportBusy = false, skillLocalFiles = [], skillLocalZip = null
function resetSkillImport() {
  skillImportToken = ''; skillImportListEl.replaceChildren(); skillImportListEl.hidden = true
  skillInstallGoEl.disabled = true
  document.getElementById('skillInspectHint').textContent = ''
  skillInstallErrorEl.textContent = ''
}
function positionSkillInspect() {
  const parent = document.getElementById(skillSourceMode === 'github' ? 'skillGithubFields' : 'skillLocalFields')
  parent.append(skillInspectEl)
  skillInspectEl.classList.toggle('is-local-source', skillSourceMode === 'local')
}
function animateSkillPart(element) {
  if (isReducedMotion()) return
  element.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: MOTION.duration.fast, easing: MOTION.ease.standard })
}
positionSkillInspect()
function selectedSkillImports() { return [...skillImportListEl.querySelectorAll('input:checked')].map((input) => input.value) }
function setSkillImportBusy(busy) {
  skillImportBusy = busy
  skillInspectEl.classList.toggle('loading', busy)
  skillInstallGoEl.classList.toggle('loading', busy && Boolean(skillImportToken))
  for (const element of document.querySelectorAll('#skillSource, #skillRef, [data-skill-source], #skillChooseFolder, #skillChooseZip, #skillInspect')) element.disabled = busy
  skillInstallGoEl.disabled = busy || !skillImportToken || !selectedSkillImports().length
}
async function closeSkillInstall() {
  if (skillImportBusy) return
  if (await hideDialog(skillInstallDialogEl)) document.getElementById('skillAdd').focus()
}
document.getElementById('skillAdd').onclick = () => {
  resetSkillImport(); showDialog(skillInstallDialogEl)
  if (skillSourceMode === 'github') document.getElementById('skillSource').focus()
  else document.getElementById('skillChooseFolder').focus()
}
document.getElementById('skillInstallCancel').onclick = closeSkillInstall
document.getElementById('skillInstallClose').onclick = closeSkillInstall
trapPackDialog(skillInstallDialogEl, closeSkillInstall)
document.querySelectorAll('[data-skill-source]').forEach((button) => {
  button.onclick = () => {
    if (skillImportBusy) return
    skillSourceMode = button.dataset.skillSource; resetSkillImport()
    document.querySelectorAll('[data-skill-source]').forEach((one) => one.setAttribute('aria-pressed', String(one === button)))
    document.getElementById('skillGithubFields').hidden = skillSourceMode !== 'github'
    document.getElementById('skillLocalFields').hidden = skillSourceMode !== 'local'
    positionSkillInspect(); animateSkillPart(document.getElementById(skillSourceMode === 'github' ? 'skillGithubFields' : 'skillLocalFields'))
  }
})
for (const id of ['skillSource', 'skillRef']) document.getElementById(id).oninput = resetSkillImport
document.getElementById('skillChooseFolder').onclick = () => document.getElementById('skillFolderFiles').click()
document.getElementById('skillChooseZip').onclick = () => document.getElementById('skillZipFile').click()
document.getElementById('skillFolderFiles').onchange = (event) => {
  skillLocalFiles = [...event.target.files].filter((file) => !file.webkitRelativePath.split('/').some((part) => part === '.git' || part === 'node_modules'))
  skillLocalZip = null; resetSkillImport()
  document.getElementById('skillLocalName').textContent = t('已选择 {n} 个文件', { n: skillLocalFiles.length })
}
document.getElementById('skillZipFile').onchange = (event) => {
  skillLocalZip = event.target.files[0] || null; skillLocalFiles = []; resetSkillImport()
  document.getElementById('skillLocalName').textContent = skillLocalZip?.name || ''
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error(t('文件读取失败')))
    reader.readAsDataURL(file)
  })
}
skillInspectEl.onclick = async () => {
  if (skillImportBusy) return
  resetSkillImport(); setSkillImportBusy(true)
  document.getElementById('skillInspectHint').textContent = t('正在检查技能…')
  try {
    let payload
    if (skillSourceMode === 'github') payload = { source: document.getElementById('skillSource').value.trim(), ref: document.getElementById('skillRef').value.trim() }
    else if (skillLocalZip) {
      if (skillLocalZip.size > 32 * 1024 * 1024) throw new Error(t('ZIP 最大 32 MB'))
      payload = { zip: await fileBase64(skillLocalZip) }
    } else {
      if (!skillLocalFiles.length) throw new Error(t('请先选择技能文件夹或 ZIP'))
      if (skillLocalFiles.length > 2000 || skillLocalFiles.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024 || skillLocalFiles.some((file) => file.size > 2 * 1024 * 1024)) throw new Error(t('技能包过大：单文件最多 2 MB，总计最多 16 MB，2000 个文件'))
      payload = { files: [] }
      for (const file of skillLocalFiles) payload.files.push({ path: file.webkitRelativePath || file.name, base64: await fileBase64(file) })
    }
    const data = await post('/api/skills/preview', payload, toolScopeOptions())
    skillImportToken = data.token
    skillImportListEl.innerHTML = data.skills.map((skill) => `<label class="skill-import-choice"><input type="checkbox" value="${escapeHtml(skill.id)}" ${skill.issue ? 'disabled' : 'checked'} /><span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(skill.description)}</small><small>${escapeHtml(t('{n} 个文件', { n: skill.fileCount }))}</small>${skill.issue ? `<small class="skill-import-issue">${escapeHtml(skill.issue)}</small>` : ''}</span></label>`).join('')
    skillImportListEl.hidden = false
    animateSkillPart(skillImportListEl)
    skillImportListEl.onchange = () => { skillInstallGoEl.disabled = skillImportBusy || !selectedSkillImports().length }
    document.getElementById('skillInspectHint').textContent = t('找到 {n} 个技能', { n: data.skills.length })
  } catch (error) {
    skillInstallErrorEl.textContent = error.message
    document.getElementById('skillInspectHint').textContent = ''
  } finally { setSkillImportBusy(false) }
}
document.getElementById('skillInstallForm').onsubmit = async (event) => {
  event.preventDefault()
  if (skillImportBusy || !skillImportToken) return
  const selected = selectedSkillImports(); if (!selected.length) return
  setSkillImportBusy(true); skillInstallErrorEl.textContent = ''
  try {
    const data = await post('/api/skills/install', withToolProfile({ token: skillImportToken, selected, root: document.getElementById('skillInstallRoot').value }), toolScopeOptions())
    renderSkills(data); skillHintEl.textContent = t('已安装 {n} 个技能，dsh 在跑会热加载。', { n: data.installed.length })
    setSkillImportBusy(false); await closeSkillInstall(); resetSkillImport()
  } catch (error) { skillInstallErrorEl.textContent = error.message }
  finally { setSkillImportBusy(false) }
}

const skillEditorDialogEl = document.getElementById('skillEditorDialog')
const skillFormEl = document.getElementById('skillForm')
const skillSaveEl = document.getElementById('skillSave')
let skillSaving = false
async function closeSkillEditor() {
  if (skillSaving) return
  if (await hideDialog(skillEditorDialogEl)) document.getElementById('skillCreate').focus()
}
document.getElementById('skillCreate').onclick = () => {
  skillFormEl.reset()
  syncUiSelect(document.getElementById('skillRoot'))
  document.getElementById('skillFormError').textContent = ''
  showDialog(skillEditorDialogEl)
  document.getElementById('skillName').focus()
}
document.getElementById('skillCancel').onclick = closeSkillEditor
trapPackDialog(skillEditorDialogEl, closeSkillEditor)
skillFormEl.onsubmit = async (event) => {
  event.preventDefault()
  if (skillSaving) return
  skillSaving = true
  skillSaveEl.disabled = true
  document.getElementById('skillFormError').textContent = ''
  try {
    const name = document.getElementById('skillName').value.trim()
    const data = await post('/api/skills/create', withToolProfile({
      root: document.getElementById('skillRoot').value, name,
      description: document.getElementById('skillDescription').value,
      content: document.getElementById('skillContent').value,
    }), toolScopeOptions())
    renderSkills(data)
    skillHintEl.textContent = t('{name} 已保存，dsh 在跑会热加载。', { name })
    skillSaving = false
    await closeSkillEditor()
  } catch (error) {
    document.getElementById('skillFormError').textContent = error.message
  } finally {
    skillSaving = false
    skillSaveEl.disabled = false
  }
}

function skillRow(skill) {
  // 详情触发按钮和开关/删除各管一件事，点图标、名称或简介打开详情，点开关或删除不误触详情。
  const displayName = skill.name || skill.dirName
  const title = [displayName, skill.relPath, skill.frontmatterOk ? '' : skill.frontmatterIssue].filter(Boolean).join(' · ')
  const isBroken = !skill.frontmatterOk
  const status = isBroken ? t('frontmatter 有问题') : (skill.disableModelInvocation ? t('已停用') : '')
  const full = skill.frontmatterOk ? (skill.description || '') : (skill.frontmatterIssue || '')
  const truncated = full.length > 140 ? `${full.slice(0, 140)}…` : full
  const isAgents = skill.root === 'agents'
  const iconTone = isBroken ? 'amber' : toneForCardName(displayName)
  const iconId = isBroken ? 'lucide-triangle-alert' : isAgents ? 'lucide-book-open' : 'lucide-sparkles'
  const row = document.createElement('div')
  row.className = `toggle plugin-row pack-row plugin-market-card plugin-installed-card skill-card${skill.disableModelInvocation ? ' off' : ''}`
  row.title = title
  row.innerHTML = `<div class="plugin-installed-head">
      <button type="button" class="skill-open skill-card-trigger" aria-haspopup="dialog">
        <span class="plugin-market-icon tone-${iconTone}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${iconId}"/></svg></span>
        <span class="plugin-market-meta">
          <span class="plugin-market-name"><span class="plugin-name">${escapeHtml(displayName)}</span></span>
          <span class="plugin-installed-sub">
            <span class="plugin-status plugin-market-tag${isAgents ? ' is-official' : ''}">${escapeHtml(isAgents ? '.agents' : '.dsh')}</span>
            ${status ? `<span class="plugin-status plugin-market-tag${isBroken ? ' is-warn' : ''}">${escapeHtml(status)}</span>` : ''}
          </span>
        </span>
      </button>
      <div class="plugin-installed-actions">
        <input type="checkbox" ${skill.disableModelInvocation ? '' : 'checked'} ${skill.frontmatterOk ? '' : 'disabled'} aria-label="${escapeHtml(t('启用 {name}', { name: displayName }))}" />
        <button type="button" class="ghost icon-btn skill-delete card-danger-btn" aria-label="${escapeHtml(t('删除技能 {name}', { name: displayName }))}" title="${escapeHtml(t('删除'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-trash-2"/></svg></button>
      </div>
    </div>
    ${truncated ? `<button type="button" class="skill-open-desc" title="${escapeHtml(full)}"><span class="plugin-desc plugin-installed-desc">${escapeHtml(truncated)}</span></button>` : ''}`
  const detail = row.querySelector('.skill-open')
  detail.onclick = () => openSkillDetail(skill, detail)
  const detailDesc = row.querySelector('.skill-open-desc')
  if (detailDesc) detailDesc.onclick = () => openSkillDetail(skill, detail)
  const input = row.querySelector('input')
  input.onchange = async () => {
    const enabled = input.checked
    input.disabled = true
    try {
      renderSkills(await post('/api/skills/toggle', withToolProfile({ root: skill.root, path: skill.relPath, enabled }), toolScopeOptions()))
    } catch (error) {
      skillHintEl.textContent = error.message
      input.checked = !enabled
      input.disabled = false
    }
  }
  const remove = row.querySelector('.skill-delete')
  remove.onclick = async () => {
    remove.disabled = true
    try {
      if (!await appConfirm(t(skill.linked ? '移除技能「{name}」的链接？原始文件会保留。' : '删除技能「{name}」及其目录内的资源？此操作无法撤销。', { name: displayName }), { title: t('删除技能 {name}', { name: displayName }) })) return
      renderSkills(await post('/api/skills/delete', withToolProfile({ root: skill.root, path: skill.relPath }), toolScopeOptions()))
      skillHintEl.textContent = t('已删除 {name}。dsh 在跑会热加载。', { name: displayName })
      document.getElementById('skillAdd').focus()
    } catch (error) {
      notify(error.message)
    } finally {
      remove.disabled = false
      if (remove.isConnected) remove.focus()
    }
  }
  return row
}

function isSkillInstalled(item) {
  const id = String(item?.skillId || '').trim().toLowerCase()
  const name = String(item?.name || '').trim().toLowerCase()
  return skillItems.some((skill) => {
    const dir = String(skill.dirName || '').trim().toLowerCase()
    const sName = String(skill.name || '').trim().toLowerCase()
    return (id && (dir === id || sName === id)) || (name && (dir === name || sName === name))
  })
}

function formatInstallsBadge(count) {
  const n = Number(count) || 0
  if (!n) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function skillMarketCard(item) {
  const installed = isSkillInstalled(item)
  const installing = skillMarketState.installingKey === item.id
  const busy = Boolean(skillMarketState.installingKey)
  const displayTitle = item.title || item.skillId
  const isOpenAi = item.source === 'openai/skills'
  const tone = isOpenAi ? 'indigo' : toneForCardName(item.skillId)
  const iconId = isOpenAi || item.isOfficial ? 'lucide-sparkles' : 'lucide-book-open'

  const card = document.createElement('div')
  card.className = `plugin-market-card${installed ? ' is-installed' : ''}`
  card.title = [displayTitle, item.description].filter(Boolean).join('\n')

  const iconWrap = document.createElement('div')
  const safeIcon = safeIconUrl(item.icon)
  iconWrap.className = `plugin-market-icon tone-${tone}${safeIcon ? ` has-image${isAvatarIconUrl(safeIcon) ? ' has-avatar' : ''}` : ''}`
  if (safeIcon) {
    const img = document.createElement('img')
    img.src = safeIcon
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    img.onerror = () => {
      iconWrap.classList.remove('has-image', 'has-avatar')
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${iconId}"/></svg>`
    }
    iconWrap.append(img)
  } else {
    iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${iconId}"/></svg>`
  }

  const meta = document.createElement('div')
  meta.className = 'plugin-market-meta'
  const nameRow = document.createElement('div')
  nameRow.className = 'plugin-market-name'
  const titleEl = document.createElement('span')
  titleEl.textContent = displayTitle
  nameRow.append(titleEl)
  if (isOpenAi || item.isOfficial) {
    const tag = document.createElement('span')
    tag.className = 'plugin-status plugin-market-tag is-official'
    tag.textContent = isOpenAi ? 'OpenAI' : t('官方')
    nameRow.append(tag)
  }

  const subEl = document.createElement('div')
  subEl.className = 'plugin-market-sub'
  const installText = formatInstallsBadge(item.installs)
  const subParts = [item.source]
  if (installText) subParts.push(t('{n} 次安装', { n: installText }))
  subEl.textContent = subParts.filter(Boolean).join(' · ')
  meta.append(nameRow, subEl)
  if (item.description) {
    const desc = document.createElement('div')
    desc.className = 'plugin-market-desc'
    desc.textContent = item.description
    meta.append(desc)
  }

  const cardActions = document.createElement('div')
  cardActions.className = 'tool-market-card-actions'
  const href = safeExternalHref(item.pageUrl || item.sourceUrl)
  if (href) {
    const link = document.createElement('a')
    link.className = 'ghost icon-btn plugin-market-link'
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.title = t('GitHub 仓库')
    link.setAttribute('aria-label', t('GitHub 仓库'))
    link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-external-link"/></svg>'
    cardActions.append(link)
  }

  if (installed) {
    const badge = document.createElement('span')
    badge.className = 'plugin-market-installed'
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg><span>${escapeHtml(t('已安装'))}</span>`
    cardActions.append(badge)
  } else {
    const action = document.createElement('button')
    action.type = 'button'
    action.className = `ghost plugin-market-install${installing ? ' is-installing' : ''}`
    action.disabled = busy
    action.textContent = installing ? t('正在安装…') : t('安装')
    action.onclick = async () => {
      skillMarketState.installingKey = item.id
      if (skillMarketErrorEl) skillMarketErrorEl.hidden = true
      renderSkillMarket()
      try {
        const data = await post('/api/skills/market-install', withToolProfile({
          source: item.source,
          skillId: item.skillId,
          root: 'dsh',
        }), toolScopeOptions())
        skillMarketState.installingKey = ''
        renderSkills(data)
        skillHintEl.textContent = t('已安装技能 {name}，dsh 在跑会热加载。', { name: displayTitle })
      } catch (error) {
        skillMarketState.installingKey = ''
        if (skillMarketErrorEl) {
          skillMarketErrorEl.textContent = error.message
          skillMarketErrorEl.hidden = false
        } else {
          skillHintEl.textContent = error.message
        }
        renderSkillMarket()
      }
    }
    cardActions.append(action)
  }
  card.append(iconWrap, meta, cardActions)
  return card
}

function renderSkillMarket() {
  if (!skillMarketListEl) return
  if (skillRefreshEl) skillRefreshEl.classList.toggle('is-loading', skillMarketState.loading)
  const items = skillMarketState.marketItems

  if (skillMarketErrorEl) {
    skillMarketErrorEl.textContent = skillMarketState.error || ''
    skillMarketErrorEl.hidden = !skillMarketState.error
  }
  skillMarketListEl.textContent = ''
  if (skillMarketState.loading && !items.length) {
    skillMarketListEl.innerHTML = globalThis.marketLoadingHtml(t('加载中…'))
    return
  }
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'plugin-empty'
    empty.textContent = skillMarketState.error
      ? t('暂时无法读取技能市场')
      : t('没有找到匹配的技能。')
    skillMarketListEl.append(empty)
    return
  }
  const grid = document.createElement('div')
  grid.className = 'plugin-market-grid'
  for (const item of items) grid.append(skillMarketCard(item))
  skillMarketListEl.append(grid)

  if (skillMarketState.hasMore) {
    const moreBtn = document.createElement('button')
    moreBtn.type = 'button'
    moreBtn.className = 'ghost plugin-market-more'
    moreBtn.disabled = skillMarketState.loadingMore
    moreBtn.textContent = skillMarketState.loadingMore ? t('加载中…') : t('加载更多')
    moreBtn.onclick = () => { void loadSkillMarket({ append: true, page: skillMarketState.page + 1 }) }
    skillMarketListEl.append(moreBtn)
  }
}

async function loadSkillMarket({ refresh = false, append = false, page = 0 } = {}) {
  const seq = ++skillMarketState.seq
  if (append) skillMarketState.loadingMore = true
  else {
    skillMarketState.loading = true
    skillMarketState.error = ''
  }
  renderSkillMarket()
  try {
    const params = new URLSearchParams({ mode: 'market', page: String(page), limit: '30' })
    if (skillSearch.trim()) params.set('q', skillSearch.trim())
    if (refresh) params.set('refresh', '1')
    const data = await getJson(`/api/skill-market?${params.toString()}`)
    if (seq !== skillMarketState.seq) return
    const nextItems = Array.isArray(data?.items) ? data.items : []
    skillMarketState.marketItems = append ? [...skillMarketState.marketItems, ...nextItems] : nextItems
    skillMarketState.marketLoaded = true
    skillMarketState.marketTotal = Number(data?.total) || 0
    skillMarketState.page = Number(data?.page) || 0
    skillMarketState.hasMore = Boolean(data?.hasMore)
    skillMarketState.error = data?.error || ''
  } catch (error) {
    if (seq !== skillMarketState.seq) return
    skillMarketState.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (seq === skillMarketState.seq) {
      skillMarketState.loading = false
      skillMarketState.loadingMore = false
      renderSkillMarket()
    }
  }
}

function renderSkillList() {
  if (skillTotalCountEl) skillTotalCountEl.textContent = String(skillItems.length)
  syncSkillSubtabs()
  const isInstalled = skillSubTab === 'installed'
  if (skillListEl) skillListEl.hidden = !isInstalled
  if (skillMarketPaneEl) skillMarketPaneEl.hidden = isInstalled
  if (!isInstalled) {
    renderSkillMarket()
    return
  }
  skillRefreshEl?.classList.remove('is-loading')
  skillListEl.textContent = ''
  const terms = skillSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = skillItems.filter((skill) => {
    if (!terms.length) return true
    const hay = `${skill.name || ''}\n${skill.dirName || ''}\n${skill.description || ''}\n${skill.relPath || ''}`.toLowerCase()
    return terms.every((term) => hay.includes(term))
  })
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'plugin-empty'
    empty.textContent = skillItems.length ? t('没有匹配的技能。') : t('这两个目录里还没有本地技能。')
    skillListEl.append(empty)
  } else {
    for (const skill of filtered) skillListEl.append(skillRow(skill))
  }
}

function renderSkills(data) {
  skillItems = data.skills || []
  renderSkillList()
  if (data.roots) {
    skillSubEl.textContent = data.roots.map((root) => root.dir).join(' · ')
  }
}
skillSubtabsEl?.addEventListener('click', (event) => {
  const btn = event.target.closest?.('[data-skill-subtab]')
  if (!btn) return
  const next = btn.dataset.skillSubtab === 'market' ? 'market' : 'installed'
  if (next === skillSubTab) return
  skillSubTab = next
  if (skillMarketErrorEl) skillMarketErrorEl.hidden = true
  renderSkillList()
  animateSubPane(next === 'installed' ? skillListEl : skillMarketPaneEl)
  if (next === 'market' && (!skillMarketState.marketLoaded || skillSearch.trim())) void loadSkillMarket()
})
if (skillSearchEl) {
  skillSearchEl.oninput = () => {
    skillSearch = skillSearchEl.value
    if (skillSubTab === 'installed') {
      renderSkillList()
      return
    }
    renderSkillMarket()
    if (skillSubTab === 'market') {
      clearTimeout(skillMarketState.searchTimer)
      skillMarketState.searchTimer = setTimeout(() => {
        void loadSkillMarket({ page: 0 })
      }, 250)
    }
  }
}

let skillsLoadSeq = 0
async function loadSkills() {
  const seq = ++skillsLoadSeq
  try {
    const query = instanceToolScope.profile ? `?profile=${encodeURIComponent(instanceToolScope.profile)}` : ''
    const data = await getJson(`/api/skills${query}`, toolScopeOptions())
    if (seq !== skillsLoadSeq) return
    renderSkills(data)
    requestAnimationFrame(() => globalThis.syncSubtabPill?.(skillSubtabsEl))
  } catch (error) {
    if (seq === skillsLoadSeq) skillHintEl.textContent = error.message
  }
}

document.getElementById('skillRefresh').onclick = () => {
  if (skillSubTab === 'installed') void loadSkills()
  else void loadSkillMarket({ refresh: true })
}
for (const [id, root] of [['skillOpenDsh', 'dsh'], ['skillOpenAgents', 'agents']]) {
  document.getElementById(id).onclick = async () => {
    const button = document.getElementById(id)
    button.disabled = true
    try {
      const data = await post('/api/skills/open-folder', withToolProfile({ root }), toolScopeOptions())
      skillHintEl.textContent = t('已打开 {dir}', { dir: data.dir || '' })
    } catch (error) { skillHintEl.textContent = error.message } finally { button.disabled = false }
  }
}

globalThis.openEnvironmentDetail = async (target, entry = null) => {
  if (!target) return
  const requestId = ++pluginDialogRequest
  pluginDialogOrigin = document.activeElement
  const envPanel = document.getElementById('environmentPanel')
  const host = document.getElementById('launchPluginsHost')
  if (!envPanel || !host || !launchPluginsDialogEl) return
  if (pluginPanelEl?.parentElement === host) document.getElementById('pane-plugins')?.append(pluginPanelEl)
  environmentState.closeDetail?.()
  pluginLaunchEntry = entry || null
  launchPluginScope = entry?.id || ''
  document.getElementById('launchPluginsTitle').textContent = entry?.name ? `${entry.name} · ${t('实例')}` : t('实例')
  moveKeepingFocus(launchPluginsCardEl.querySelector('.launch-plugins-head'), document.getElementById('launchPluginsClose'))
  const loadingEl = document.getElementById('launchPluginsLoading')
  launchPluginsCardEl.classList.add('is-loading')
  if (loadingEl) loadingEl.hidden = false
  host.hidden = true
  host.append(envPanel)
  environmentState.pendingOpen = target
  const opening = showDialog(launchPluginsDialogEl)
  document.getElementById('launchPluginsClose').focus()
  const reloading = environmentState.reload?.()
  if (!(await opening)) return
  await reloading
  if (launchPluginsDialogEl.hidden || launchPluginsDialogEl.dataset.dialogClosing || requestId !== pluginDialogRequest) return
  launchPluginsCardEl.classList.remove('is-loading')
  if (loadingEl) loadingEl.hidden = true
  host.hidden = false
  const top = envPanel.querySelector('#environmentView .pack-detail-top')
  if (top) moveKeepingFocus(top, document.getElementById('launchPluginsClose'))
  const subtabs = envPanel.querySelector('#environmentPluginSubtabs')
  if (subtabs) requestAnimationFrame(() => globalThis.syncSubtabPill?.(subtabs))
  const viewEl = envPanel.querySelector('#environmentView')
  if (viewEl && !isReducedMotion()) {
    viewEl.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: MOTION.duration.fast, easing: MOTION.ease.decelerate })
  }
}
globalThis.syncEnvironmentToolTab = (tab = 'plugins', env = null, pluginSubTab = 'installed') => {
  const mcpPanel = document.getElementById('mcpPanel')
  const skillsPanel = document.getElementById('skillsPanel')
  const mcpHome = document.getElementById('pane-mcp')
  const skillsHome = document.getElementById('pane-skills')
  const mcpHost = document.getElementById('environmentMcpHost')
  const skillsHost = document.getElementById('environmentSkillsHost')
  const tabActions = document.getElementById('environmentTabActions')
  const mcpTop = mcpPanel?.querySelector('.pane-top')
  const skillsTop = skillsPanel?.querySelector('.pane-top')
  const mcpActions = document.getElementById('mcpAdd')?.closest('.plugin-actions')
  const skillsActions = document.getElementById('skillAdd')?.closest('.plugin-actions')
  const nextTab = env && (tab === 'mcp' || tab === 'skills') ? tab : 'plugins'
  instanceToolScope = nextTab !== 'plugins' && env
    ? { profile: env.targetProfile || 'web', home: env.targetHome || '' }
    : { profile: '', home: '' }
  if (mcpPanel) {
    const target = nextTab === 'mcp' && mcpHost ? mcpHost : mcpHome
    if (target && mcpPanel.parentElement !== target) target.append(mcpPanel)
  }
  if (skillsPanel) {
    const target = nextTab === 'skills' && skillsHost ? skillsHost : skillsHome
    if (target && skillsPanel.parentElement !== target) target.append(skillsPanel)
  }
  // 切进 MCP / 技能页签时把对应的操作图标放到页签栏右侧，切回或退回主面板时还原到原顶栏，避免页签下多出一排空白操作栏
  if (mcpActions && mcpTop && nextTab !== 'mcp' && mcpActions.parentElement !== mcpTop) {
    mcpTop.append(mcpActions)
  }
  if (skillsActions && skillsTop && nextTab !== 'skills' && skillsActions.parentElement !== skillsTop) {
    skillsTop.append(skillsActions)
  }
  if (tabActions) {
    const pluginActions = document.getElementById('environmentPluginActions')
    const pluginCommonActions = document.getElementById('environmentPluginCommonActions')
    const marketActions = document.getElementById('environmentMarketActions')
    const isMarketSubTab = tab === 'plugins' && (pluginSubTab === 'curated' || pluginSubTab === 'market')
    if (pluginCommonActions) pluginCommonActions.hidden = !env || tab !== 'plugins'
    if (pluginActions) pluginActions.hidden = !env || tab !== 'plugins' || pluginSubTab !== 'installed'
    if (marketActions) marketActions.hidden = !env || !isMarketSubTab
    const activeActions = nextTab === 'mcp' ? mcpActions : nextTab === 'skills' ? skillsActions : null
    if (activeActions && activeActions.parentElement !== tabActions) tabActions.append(activeActions)
    tabActions.hidden = !env || tab === 'config'
  }
  if (nextTab === 'plugins') {
    instanceToolMountKey = ''
    return
  }
  const nextKey = `${nextTab}:${env.id}:${instanceToolScope.profile}:${instanceToolScope.home}`
  if (instanceToolMountKey === nextKey) {
    requestAnimationFrame(() => globalThis.syncSubtabPill?.(nextTab === 'mcp' ? mcpSubtabsEl : skillSubtabsEl))
    return
  }
  instanceToolMountKey = nextKey
  if (nextTab === 'mcp') {
    mcpSubTab = 'installed'
    mcpSearch = ''
    if (mcpSearchEl) mcpSearchEl.value = ''
    syncMcpSubtabs()
    renderMcp()
    requestAnimationFrame(() => globalThis.syncSubtabPill?.(mcpSubtabsEl))
    setMcpHint(t('检测会真的起进程或连端点，可能需要几秒。'))
    void loadMcp()
  } else {
    skillSubTab = 'installed'
    skillSearch = ''
    if (skillSearchEl) skillSearchEl.value = ''
    syncSkillSubtabs()
    renderSkillList()
    requestAnimationFrame(() => globalThis.syncSubtabPill?.(skillSubtabsEl))
    skillHintEl.textContent = ''
    void loadSkills()
  }
}


paneLoaders.mcp = loadMcp
paneLoaders.skills = loadSkills
