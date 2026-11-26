// 「数据」（用户目录 / 数据卷）页交互模块：
// - 一级：所有已登记用户目录（DSH_HOME）的卡片网格（与「实例」页 1:1 同款卡片与菜单语言）；
// - 二级：点击目录卡片钻入详情，包含「会话」Tab（全部会话 / 归档中心 / 工作区 / 空白清理 / 离线永久删除）
//   和「数据分析」Tab（纯静态只读扫描，明确拆分「用户数据层」与「实例运行时与缓存层」，并列出挂载的启动项与实例）。
// 跑在 index.html 主脚本之后，复用主脚本全局：t、post、appConfirm、formatBytes、escapeHtml、
// packTileHtml、pickDirectoryPath、pickWslDirectory、createUiSelect、syncUiSelect；「添加目录」弹窗的设备选择器
// 直接复用首页「创建项目」那一套（connectionsList、connectionById、projectDevice*、startConnectionPrepare、
// openConnectionDialog、alignFloatingPanel），免得两处的设备列表长得不一样。
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const tr = (zh, vars) => (typeof t === 'function' ? t(zh, vars) : zh)
  const byId = (id) => document.getElementById(id)

  const paneEl = byId('pane-sessions')
  if (!paneEl) return

  const dom = {
    // 一级：用户目录总览
    top: byId('sessTop'),
    refreshBtn: byId('sessRefresh'),
    addHomeBtn: byId('sessAddHome'),
    overview: byId('sessOverview'),
    deviceFilterBar: byId('sessDeviceFilterBar'),
    devCountAll: byId('sessDevCountAll'),
    devCountLocal: byId('sessDevCountLocal'),
    devCountWsl: byId('sessDevCountWsl'),
    devCountSsh: byId('sessDevCountSsh'),
    overviewNotice: byId('sessOverviewNotice'),
    homeGrid: byId('sessHomeGrid'),
    overviewHint: byId('sessOverviewHint'),
    // 二级：目录详情头与双 Tab
    detailView: byId('sessDetailView'),
    detailBack: byId('sessDetailBack'),
    detailName: byId('sessDetailName'),
    detailPath: byId('sessDetailPath'),
    detailOpen: byId('sessDetailOpen'),
    detailRename: byId('sessDetailRename'),
    detailRefresh: byId('sessDetailRefresh'),
    detailStop: byId('sessDetailStop'),
    detailTabs: byId('sessDetailTabs'),
    cleanBlankBtn: byId('sessCleanBlank'),
    cleanBlankCount: byId('sessCleanBlankCount'),
    runningBanner: byId('sessRunningBanner'),
    runningText: byId('sessRunningText'),
    runningStopBtn: byId('sessRunningStopBtn'),
    notice: byId('sessNotice'),
    // 详情 Tab 1：会话
    tabSessions: byId('sessTabSessions'),
    tabs: byId('sessTabs'),
    tabAllCount: byId('sessTabAllCount'),
    tabArchivedCount: byId('sessTabArchivedCount'),
    tabWorkspacesCount: byId('sessTabWorkspacesCount'),
    search: byId('sessSearch'),
    workspaceSelect: byId('sessWorkspaceFilter'),
    statusSelect: byId('sessStatusFilter'),
    sortSelect: byId('sessSortSelect'),
    staleOnlyWrap: byId('sessStaleOnlyWrap'),
    staleOnly: byId('sessStaleOnly'),
    archiveToolbar: byId('sessArchiveToolbar'),
    archiveSelectAll: byId('sessArchiveSelectAll'),
    archiveUnarchiveAll: byId('sessArchiveUnarchiveAll'),
    archiveDeleteFiltered: byId('sessArchiveDeleteFiltered'),
    bulkBar: byId('sessBulkBar'),
    bulkCount: byId('sessBulkCount'),
    bulkArchive: byId('sessBulkArchive'),
    bulkUnarchive: byId('sessBulkUnarchive'),
    bulkUnpin: byId('sessBulkUnpin'),
    bulkDelete: byId('sessBulkDelete'),
    bulkClear: byId('sessBulkClear'),
    listHost: byId('sessListHost'),
    // 详情 Tab 2：数据分析
    tabAnalytics: byId('sessTabAnalytics'),
    analyticsHost: byId('sessAnalyticsHost'),
    // 添加目录弹窗（与首页「创建项目」同款设备选择器）
    addHomeDialog: byId('sessionAddHomeDialog'),
    addHomeForm: byId('sessAddHomeForm'),
    addHomeClose: byId('sessAddHomeClose'),
    addHomeCancel: byId('sessAddHomeCancel'),
    addHomeName: byId('sessAddHomeName'),
    addDeviceTrigger: byId('sessAddDeviceTrigger'),
    addDeviceIcon: byId('sessAddDeviceIcon'),
    addDeviceLabel: byId('sessAddDeviceLabel'),
    addDeviceStatus: byId('sessAddDeviceStatus'),
    addHomePath: byId('sessAddHomePath'),
    addHomeBrowse: byId('sessAddHomeBrowse'),
    addHomeHint: byId('sessAddHomeHint'),
    addHomeError: byId('sessAddHomeError'),
    addHomeSubmit: byId('sessAddHomeSubmit'),
    // 目录重命名弹窗
    renameDialog: byId('sessionHomeRenameDialog'),
    renameForm: byId('sessHomeRenameForm'),
    renameClose: byId('sessHomeRenameClose'),
    renameCancel: byId('sessHomeRenameCancel'),
    renamePath: byId('sessHomeRenamePath'),
    renameInput: byId('sessHomeRenameInput'),
    renameError: byId('sessHomeRenameError'),
    renameSave: byId('sessHomeRenameSave'),
    // 永久删除预检弹窗
    deleteDialog: byId('sessionDeleteDialog'),
    deleteClose: byId('sessDeleteClose'),
    deleteTitle: byId('sessDeleteTitle'),
    deleteBody: byId('sessDeleteBody'),
    deleteCancel: byId('sessDeleteCancel'),
    deleteConfirm: byId('sessDeleteConfirm'),
  }

  // 悬浮设备选择面板（与 #projectDevicePanel 同款结构，挂在 body 避免被弹窗裁切）
  const addDevicePanel = document.createElement('div')
  addDevicePanel.className = 'project-device-panel'
  addDevicePanel.id = 'sessAddDevicePanel'
  addDevicePanel.hidden = true
  const addDeviceList = document.createElement('div')
  addDeviceList.className = 'project-device-list'
  addDeviceList.id = 'sessAddDeviceList'
  addDeviceList.setAttribute('role', 'listbox')
  addDeviceList.setAttribute('aria-label', tr('设备'))
  addDevicePanel.appendChild(addDeviceList)
  document.body.appendChild(addDevicePanel)

  const ADD_REMOTE_DEVICE_VAL = '__add_remote_device__'
  const MANAGE_REMOTE_DEVICE_VAL = '__manage_remote_device__'

  const state = {
    loading: false,
    loaded: false,
    data: null, // { homes, workspaces, sessions, summary, scannedAt }
    deviceFilter: 'all', // 'all' | 'local' | 'wsl' | 'ssh'
    activeHome: '', // '' = 一级卡片总览；非空 = 钻入该用户目录详情
    detailTab: 'sessions', // 'sessions' | 'analytics'
    view: 'all', // 'all' | 'archived' | 'workspaces'
    search: '',
    workspace: '',
    status: 'active', // 'active' | 'all' | 'blank' | 'orphan' | 'subagent'
    sort: 'updated', // 'updated' | 'created' | 'bytes' | 'title'
    staleOnly: false,
    selected: new Set(),
    overviewNoticeText: '',
    overviewNoticeKind: 'info',
    noticeText: '',
    noticeKind: 'info',
    busy: false,
    // 远端（WSL / SSH）目录按需连接拉取的会话与工作区缓存
    remoteDataByHome: new Map(),
    // 每个用户目录的静态数据分析缓存（手动刷新或删完会话后失效）
    statsByHome: new Map(),
    statsLoadingHome: '',
    statsError: '',
    // 添加目录弹窗状态
    addDeviceValue: 'local',
    // 重命名弹窗状态
    renamingHome: '',
    // 删除弹窗状态
    del: null,
  }

  const keyOf = (home, sessionId) => `${home}\0${sessionId}`

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(SVG_NS, 'use')
    use.setAttribute('href', `/icons.svg#lucide-${name}`)
    svg.appendChild(use)
    return svg
  }

  function bytesLabel(n) {
    if (!n || n <= 0) return '0 B'
    if (typeof formatBytes === 'function') return formatBytes(n)
    const units = ['B', 'KB', 'MB', 'GB']
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
  }

  function pctLabel(part, total) {
    if (!total || total <= 0 || !part || part <= 0) return '0%'
    const p = (part / total) * 100
    return p < 0.1 ? '<0.1%' : `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`
  }

  function formatTokens(n) {
    if (!n || n <= 0) return ''
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  function formatTime(ms) {
    if (!ms || !Number.isFinite(ms)) return tr('未知时间')
    const diff = Date.now() - ms
    if (diff >= 0 && diff < 60_000) return tr('刚刚')
    if (diff >= 0 && diff < 3_600_000) return tr('{n} 分钟前', { n: Math.floor(diff / 60_000) })
    if (diff >= 0 && diff < 86_400_000) return tr('{n} 小时前', { n: Math.floor(diff / 3_600_000) })
    if (diff >= 0 && diff < 30 * 86_400_000) return tr('{n} 天前', { n: Math.floor(diff / 86_400_000) })
    const d = new Date(ms)
    const pad = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function reasonLabel(code) {
    const map = {
      running_home: tr('实例运行中'),
      active_session: tr('会话运行中'),
      not_archived: tr('已取消归档'),
      state_changed: tr('状态已变化'),
      archived_cannot_pin: tr('已归档不能置顶'),
      already_archived: tr('已是归档状态'),
      already_pinned: tr('已置顶'),
      not_pinned: tr('未置顶'),
      not_found: tr('不存在或已删除'),
      locked: tr('文件被占用'),
      malformed_storage: tr('存储文件损坏'),
      unknown_home: tr('未登记的用户目录'),
      invalid_path: tr('路径超出范围'),
      io_error: tr('磁盘写入失败'),
    }
    return map[code] || code
  }

  function excludedLabel(code) {
    const map = {
      workspace_files: tr('工作区目录与项目代码文件'),
      git_worktree: tr('Git 仓库与 worktree'),
      memory: tr('目录级记忆（memory/）'),
      attachments: tr('内容去重附件库（attachments/，避免误删其他会话引用）'),
      checkpoints_logs: tr('检查点、导出副本、备份与运行日志'),
    }
    return map[code] || code
  }

  function staleReasonLabel(code) {
    const map = {
      missing_dir: tr('目录不存在'),
      empty: tr('无活跃会话'),
      inactive_90d: tr('超过 90 天未活动'),
    }
    return map[code] || code
  }

  function categoryMeta(key) {
    const map = {
      sessions: { label: tr('会话日志'), color: 'is-sessions' },
      attachments: { label: tr('附件库'), color: 'is-attachments' },
      memory: { label: tr('记忆'), color: 'is-memory' },
      pluginData: { label: tr('存储与插件数据'), color: 'is-plugin-data' },
      profiles: { label: tr('Profile 运行时'), color: 'is-profiles' },
      cacheLogs: { label: tr('缓存与日志'), color: 'is-cache' },
    }
    return map[key] || { label: key, color: 'is-cache' }
  }

  function showOverviewNotice(text, kind = 'info') {
    state.overviewNoticeText = text || ''
    state.overviewNoticeKind = kind
    paintNotice()
  }

  function showNotice(text, kind = 'info') {
    state.noticeText = text || ''
    state.noticeKind = kind
    paintNotice()
  }

  function paintNotice() {
    if (dom.overviewNotice) {
      dom.overviewNotice.hidden = !state.overviewNoticeText
      dom.overviewNotice.className = `sess-notice is-${state.overviewNoticeKind}`
      dom.overviewNotice.textContent = state.overviewNoticeText
    }
    if (dom.notice) {
      dom.notice.hidden = !state.noticeText
      dom.notice.className = `sess-notice is-${state.noticeKind}`
      dom.notice.textContent = state.noticeText
    }
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch { /* fallback */ }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  // 接管筛选下拉框为 DSH-X 原生自定义下拉菜单
  const managedSelects = [dom.workspaceSelect, dom.statusSelect, dom.sortSelect].filter(Boolean)
  function initUiSelects() {
    if (typeof createUiSelect !== 'function') return
    for (const select of managedSelects) {
      createUiSelect(select)
      const wrap = select.closest('.ui-select')
      if (wrap) wrap.classList.add('sess-ui-select')
    }
  }
  function syncSelectUi(select) {
    if (select && typeof syncUiSelect === 'function') syncUiSelect(select)
  }
  function setSelectHidden(select, hidden) {
    if (!select) return
    const host = select.closest('.ui-select') || select
    host.hidden = Boolean(hidden)
  }

  function homeKind(h) {
    const k = h?.deviceKind || h?.source || 'local'
    return k === 'wsl' || k === 'ssh' ? k : 'local'
  }

  function isRemoteHome(h) {
    return homeKind(h) !== 'local'
  }

  function homeDisplayPath(h) {
    if (!h) return ''
    return h.resolvedPath || h.displayPath || h.remoteHome || h.home || ''
  }

  function mergeRemoteHomeMeta(h) {
    if (!h || !isRemoteHome(h)) return h
    const cached = state.remoteDataByHome.get(h.home)
    if (!cached?.home) return h
    return {
      ...h,
      resolvedPath: cached.home.resolvedPath || h.resolvedPath || '',
      sessionCount: cached.home.sessionCount,
      activeCount: cached.home.activeCount,
      archivedCount: cached.home.archivedCount,
      blankCount: cached.home.blankCount,
      orphanCount: cached.home.orphanCount,
      bytes: cached.home.bytes,
    }
  }

  function sessionItemRef(s) {
    return {
      home: s.home,
      sessionId: s.sessionId,
      ...(s.remoteRawHome ? { remoteRawHome: s.remoteRawHome } : {}),
    }
  }

  function currentHomeObj() {
    if (!state.activeHome || !state.data) return null
    const base = (state.data.homes || []).find((h) => h.home === state.activeHome) || null
    return base ? mergeRemoteHomeMeta(base) : null
  }

  function homeSessions(home = state.activeHome) {
    const h = (state.data?.homes || []).find((x) => x.home === home)
    if (h && isRemoteHome(h)) {
      return state.remoteDataByHome.get(home)?.sessions || []
    }
    return (state.data?.sessions || []).filter((s) => s.home === home)
  }

  function homeWorkspaces(home = state.activeHome) {
    const h = (state.data?.homes || []).find((x) => x.home === home)
    if (h && isRemoteHome(h)) {
      return state.remoteDataByHome.get(home)?.workspaces || []
    }
    return (state.data?.workspaces || []).filter((w) => w.home === home)
  }

  async function loadRemoteHome(home, { force = false } = {}) {
    if (!home) return
    const prev = state.remoteDataByHome.get(home)
    if (prev?.loading) return
    if (!force && prev?.loaded && !prev?.error) return
    state.remoteDataByHome.set(home, {
      loading: true,
      loaded: Boolean(prev?.loaded),
      unsupported: false,
      error: '',
      home: prev?.home || null,
      sessions: prev?.sessions || [],
      workspaces: prev?.workspaces || [],
    })
    paint()
    try {
      const res = await apiGet(`/api/sessions/remote?home=${encodeURIComponent(home)}`)
      state.remoteDataByHome.set(home, {
        loading: false,
        loaded: true,
        unsupported: Boolean(res.unsupported),
        error: '',
        home: res.home || null,
        sessions: Array.isArray(res.sessions) ? res.sessions : [],
        workspaces: Array.isArray(res.workspaces) ? res.workspaces : [],
      })
      syncFilterOptions()
    } catch (error) {
      state.remoteDataByHome.set(home, {
        loading: false,
        loaded: false,
        unsupported: false,
        error: error.message || String(error),
        home: null,
        sessions: [],
        workspaces: [],
      })
    } finally {
      paint()
    }
  }

  async function load({ silent = false, invalidateStats = false } = {}) {
    if (state.loading) return
    state.loading = true
    if (invalidateStats) {
      state.statsByHome.clear()
      state.remoteDataByHome.clear()
    }
    if (!silent) paint()
    try {
      const data = await apiGet('/api/sessions')
      state.data = data
      state.loaded = true
      const liveKeys = new Set((data.sessions || []).map((s) => keyOf(s.home, s.sessionId)))
      for (const entry of state.remoteDataByHome.values()) {
        for (const s of entry.sessions || []) liveKeys.add(keyOf(s.home, s.sessionId))
      }
      for (const k of [...state.selected]) {
        if (!liveKeys.has(k)) state.selected.delete(k)
      }
      if (state.activeHome && !(data.homes || []).some((h) => h.home === state.activeHome)) {
        state.activeHome = ''
      }
      syncFilterOptions()
      const activeObj = currentHomeObj()
      if (activeObj && isRemoteHome(activeObj) && (!state.remoteDataByHome.has(activeObj.home) || invalidateStats)) {
        void loadRemoteHome(activeObj.home, { force: invalidateStats })
      }
      if (state.activeHome && state.detailTab === 'analytics' && !state.statsByHome.has(state.activeHome)) {
        void loadHomeStats(state.activeHome)
      }
    } catch (error) {
      const msg = tr('读取用户目录失败：{msg}', { msg: error.message || String(error) })
      if (state.activeHome) showNotice(msg, 'error')
      else showOverviewNotice(msg, 'error')
    } finally {
      state.loading = false
      paint()
    }
  }

  async function loadHomeStats(home, { force = false } = {}) {
    if (!home) return
    if (!force && state.statsByHome.has(home)) {
      paintAnalytics()
      return
    }
    state.statsLoadingHome = home
    state.statsError = ''
    paintAnalytics()
    try {
      const stats = await apiGet(`/api/sessions/home-stats?home=${encodeURIComponent(home)}`)
      state.statsByHome.set(home, stats)
    } catch (error) {
      state.statsError = error.message || String(error)
    } finally {
      if (state.statsLoadingHome === home) state.statsLoadingHome = ''
      paintDetailHeader()
      paintAnalytics()
    }
  }

  function openHome(home, tab = 'sessions') {
    if (!home) return
    state.activeHome = home
    state.detailTab = tab === 'analytics' ? 'analytics' : 'sessions'
    state.view = 'all'
    state.search = ''
    if (dom.search) dom.search.value = ''
    state.workspace = ''
    state.status = 'active'
    if (dom.statusSelect) dom.statusSelect.value = 'active'
    state.selected.clear()
    showNotice('')
    syncFilterOptions()
    paint()
    const h = currentHomeObj()
    if (h && isRemoteHome(h)) {
      const cached = state.remoteDataByHome.get(home)
      if (!cached || (!cached.loaded && !cached.loading)) void loadRemoteHome(home)
    }
    if (state.detailTab === 'analytics') void loadHomeStats(home)
  }

  function closeHome() {
    state.activeHome = ''
    state.selected.clear()
    showNotice('')
    paint()
  }

  function setDetailTab(tab) {
    const next = tab === 'analytics' ? 'analytics' : 'sessions'
    state.detailTab = next
    if (dom.detailTabs) {
      dom.detailTabs.dataset.active = next
      for (const btn of dom.detailTabs.querySelectorAll('[data-detail-tab]')) {
        btn.setAttribute('aria-selected', String(btn.dataset.detailTab === next))
      }
    }
    paint()
    if (next === 'analytics' && state.activeHome) {
      void loadHomeStats(state.activeHome)
    }
  }

  function syncFilterOptions() {
    if (!dom.workspaceSelect) return
    const prev = state.workspace
    dom.workspaceSelect.textContent = ''
    const allOpt = el('option', '', tr('全部工作区'))
    allOpt.value = ''
    dom.workspaceSelect.appendChild(allOpt)
    const list = state.activeHome ? homeWorkspaces(state.activeHome) : []
    for (const w of list) {
      const tag = w.mounted ? '' : ` [${tr('未挂载')}]`
      const opt = el('option', '', `${w.title}${tag} (${w.sessionCount})`)
      opt.value = `${w.home}\0${w.id}`
      dom.workspaceSelect.appendChild(opt)
    }
    dom.workspaceSelect.value = prev
    if (dom.workspaceSelect.value !== prev) state.workspace = ''
    syncSelectUi(dom.workspaceSelect)
    syncSelectUi(dom.statusSelect)
    syncSelectUi(dom.sortSelect)
  }

  function matchesSearch(s, q) {
    if (!q) return true
    const hay = `${s.title || ''} ${s.firstPrompt || ''} ${s.workspaceTitle || ''} ${s.workspacePath || ''} ${s.sessionId || ''}`.toLowerCase()
    return hay.includes(q)
  }

  function filteredSessions() {
    const all = homeSessions(state.activeHome)
    const q = state.search.trim().toLowerCase()
    let list = all.filter((s) => {
      if (state.workspace) {
        const [, wId] = state.workspace.split('\0')
        if (wId.startsWith('orphan:')) {
          const prefix = wId.slice('orphan:'.length)
          if (!s.orphan) return false
          const matchKey = s.projectKey === prefix || (!s.projectKey && !s.workspacePath && prefix === '_unmounted')
          const matchPath = s.workspacePath && s.workspacePath.toLowerCase() === prefix.toLowerCase()
          if (!matchKey && !matchPath) return false
        } else if (s.workspaceId !== wId) {
          return false
        }
      }
      if (state.view === 'archived') {
        if (!s.archived) return false
      } else if (state.status === 'active') {
        if (s.archived || s.isSubagent) return false
      } else if (state.status === 'all') {
        if (s.isSubagent) return false
      } else if (state.status === 'blank') {
        if (!s.blank || s.archived) return false
      } else if (state.status === 'orphan') {
        if (!s.orphan) return false
      } else if (state.status === 'subagent') {
        if (!s.isSubagent) return false
      }
      return matchesSearch(s, q)
    })

    const cmp = {
      updated: (a, b) => (b.updatedAt - a.updatedAt) || (a.sessionId < b.sessionId ? -1 : 1),
      created: (a, b) => (b.createdAt - a.createdAt) || (a.sessionId < b.sessionId ? -1 : 1),
      bytes: (a, b) => (b.bytes - a.bytes) || (b.updatedAt - a.updatedAt),
      title: (a, b) => (a.title || tr('新会话')).localeCompare(b.title || tr('新会话')),
    }[state.sort] || ((a, b) => b.updatedAt - a.updatedAt)
    return [...list].sort(cmp)
  }

  function filteredWorkspaces() {
    const all = homeWorkspaces(state.activeHome)
    const q = state.search.trim().toLowerCase()
    const list = all.filter((w) => {
      if (state.staleOnly && !w.stale) return false
      if (!q) return true
      return `${w.title || ''} ${w.path || ''}`.toLowerCase().includes(q)
    })
    const cmp = {
      updated: (a, b) => (b.lastActivityAt - a.lastActivityAt),
      created: (a, b) => (b.createdAt - a.createdAt),
      bytes: (a, b) => (b.bytes - a.bytes),
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
    }[state.sort] || ((a, b) => b.lastActivityAt - a.lastActivityAt)
    return [...list].sort(cmp)
  }

  function blankCandidates() {
    return homeSessions(state.activeHome).filter((s) => s.blank && !s.archived)
  }

  function setView(next) {
    if (!['all', 'archived', 'workspaces'].includes(next)) return
    state.view = next
    state.selected.clear()
    if (dom.tabs) {
      dom.tabs.dataset.active = next
      for (const btn of dom.tabs.querySelectorAll('[data-sess-tab]')) {
        btn.setAttribute('aria-selected', String(btn.dataset.sessTab === next))
      }
    }
    paint()
  }

  function paint() {
    paintNotice()
    const inDetail = Boolean(state.activeHome && currentHomeObj())
    if (dom.top) dom.top.hidden = inDetail
    if (dom.overview) dom.overview.hidden = inDetail
    if (dom.detailView) dom.detailView.hidden = !inDetail

    if (!inDetail) {
      paintOverview()
      return
    }
    paintDetailHeader()
    paintDetailBody()
  }

  // ---- 一级：用户目录（数据卷）卡片网格（区分本机 / WSL / SSH，按设备筛选与分组） ----
  function deviceBadgeOf(h) {
    const kind = homeKind(h)
    if (kind === 'wsl') {
      return { text: h.deviceName ? `WSL · ${h.deviceName}` : 'WSL', cls: 'is-wsl' }
    }
    if (kind === 'ssh') {
      return { text: h.deviceName ? `SSH · ${h.deviceName}` : 'SSH', cls: 'is-ssh' }
    }
    return { text: tr('本机'), cls: 'is-local' }
  }

  function homeCardTags(h) {
    const tags = [deviceBadgeOf(h)]
    if (h.running) tags.push({ text: tr('运行中'), cls: 'is-running' })
    if (h.presetCount > 0) tags.push({ text: tr('{n} 个启动项在用', { n: h.presetCount }), cls: '' })
    // 只有用户改了显示名（与「默认目录」不同）时才补「默认目录」标记，避免标题和徽章重复出现两次
    if (h.isDefault && h.label !== tr('默认目录') && h.label !== '默认目录') {
      tags.push({ text: tr('默认目录'), cls: '' })
    }
    if ((h.blankCount || 0) > 0) tags.push({ text: tr('{n} 空白', { n: h.blankCount }), cls: 'is-warn' })
    return tags
  }

  function homeCardMenuHtml(h) {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (v) => String(v ?? '')
    const remote = isRemoteHome(h)
    const canRemove = remote
      ? (Boolean(h.registered) && h.presetCount === 0 && !h.running)
      : (!h.isDefault && h.presetCount === 0 && !h.running)
    const items = []
    if (!remote) {
      items.push(`<button class="ghost" type="button" data-home-open="${esc(h.home)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-folder"/></svg><span>${esc(tr('打开目录'))}</span></button>`)
    }
    items.push(`<button class="ghost" type="button" data-home-rename="${esc(h.home)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-pencil"/></svg><span>${esc(tr('重命名'))}</span></button>`)
    items.push(`<button class="ghost" type="button" data-home-analytics="${esc(h.home)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-sliders-horizontal"/></svg><span>${esc(tr('数据分析'))}</span></button>`)
    if (!remote) {
      items.push(`<button class="ghost" type="button" data-home-env="${esc(h.home)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-terminal"/></svg><span>${esc(tr('设为全局 DSH_HOME'))}</span></button>`)
    }
    if (canRemove) {
      items.push(`<button class="ghost danger" type="button" data-home-remove="${esc(h.home)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-trash-2"/></svg><span>${esc(tr('移除目录'))}</span></button>`)
    }
    return items.join('')
  }

  function homeCardHtml(raw) {
    const h = mergeRemoteHomeMeta(raw)
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (v) => String(v ?? '')
    const tile = typeof packTileHtml === 'function'
      ? packTileHtml({ name: h.home, displayName: h.label })
      : `<span class="pack-tile">${esc((h.label || 'D').slice(0, 1))}</span>`
    const statsCached = state.statsByHome.get(h.home)
    const remote = isRemoteHome(h)
    let summaryLine = ''
    if (typeof h.sessionCount === 'number') {
      const sizeText = bytesLabel(statsCached && !statsCached.unsupported ? statsCached.totalBytes : (h.bytes || 0))
      summaryLine = `${tr('{n} 条会话', { n: h.sessionCount })} · ${sizeText}`
    } else if (remote) {
      summaryLine = h.connectionStatus === 'online'
        ? tr('在线 · 点击查看会话')
        : h.connectionStatus === 'preparing'
          ? tr('连接中…')
          : tr('点击连接查看会话')
    }
    const displayPath = homeDisplayPath(h)
    const tagsHtml = homeCardTags(h)
      .map((tag) => `<span class="sess-card-tag${tag.cls ? ` ${tag.cls}` : ''}">${esc(tag.text)}</span>`)
      .join('')
    const menu = homeCardMenuHtml(h)
    return `<div class="profile-card sess-home-card">
      <button class="pack-card sess-home-card-btn" type="button" data-home="${esc(h.home)}" aria-label="${esc(tr('查看用户目录 {name}', { name: h.label }))}" title="${esc(displayPath)}">
        ${tile}
        <div class="pack-card-body sess-home-card-body">
          <div class="pack-card-head">
            <span class="pack-card-name">${esc(h.label)}</span>
          </div>
          <div class="sess-home-card-summary">${esc(summaryLine)}</div>
          <div class="sess-home-card-path">${esc(displayPath)}</div>
          ${tagsHtml ? `<div class="sess-home-card-tags">${tagsHtml}</div>` : ''}
        </div>
      </button>
      <details class="pack-more profile-menu">
        <summary title="${esc(tr('更多操作'))}" aria-label="${esc(tr('更多操作'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-ellipsis"/></svg></summary>
        <div class="pack-more-actions">${menu}</div>
      </details>
    </div>`
  }

  function updateDeviceFilterBar(homes) {
    const counts = { all: homes.length, local: 0, wsl: 0, ssh: 0 }
    for (const h of homes) counts[homeKind(h)] += 1
    if (dom.devCountAll) dom.devCountAll.textContent = String(counts.all)
    if (dom.devCountLocal) dom.devCountLocal.textContent = String(counts.local)
    if (dom.devCountWsl) dom.devCountWsl.textContent = String(counts.wsl)
    if (dom.devCountSsh) dom.devCountSsh.textContent = String(counts.ssh)
    if (dom.deviceFilterBar) {
      dom.deviceFilterBar.querySelectorAll('[data-device-filter]').forEach((btn) => {
        const active = btn.dataset.deviceFilter === state.deviceFilter
        btn.classList.toggle('is-active', active)
        btn.setAttribute('aria-selected', String(active))
      })
    }
  }

  function paintOverview() {
    if (dom.refreshBtn) dom.refreshBtn.disabled = state.loading
    if (dom.addHomeBtn) dom.addHomeBtn.disabled = state.loading || state.busy
    if (!dom.homeGrid) return

    const homes = state.data?.homes || []
    updateDeviceFilterBar(homes)

    if (state.loading && !state.loaded) {
      dom.homeGrid.textContent = ''
      if (dom.overviewHint) dom.overviewHint.textContent = tr('正在静态扫描已登记的用户目录…')
      return
    }

    const visible = state.deviceFilter === 'all'
      ? homes
      : homes.filter((h) => homeKind(h) === state.deviceFilter)

    if (!visible.length) {
      dom.homeGrid.textContent = ''
      if (dom.overviewHint) {
        dom.overviewHint.textContent = state.deviceFilter === 'wsl'
          ? tr('还没有登记 WSL 用户目录，点右上角「添加目录」并选择 WSL 设备。')
          : state.deviceFilter === 'ssh'
            ? tr('还没有登记 SSH 远端用户目录，点右上角「添加目录」并选择 SSH 设备。')
            : tr('还没有已登记的用户目录，点右上角「添加目录」登记一个数据卷。')
      }
      return
    }

    if (dom.overviewHint) dom.overviewHint.textContent = ''
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (v) => String(v ?? '')
    const groups = [
      { key: 'local', title: tr('本机（此电脑）'), iconName: 'app-window', items: visible.filter((h) => homeKind(h) === 'local') },
      { key: 'wsl', title: 'WSL', iconName: 'box', items: visible.filter((h) => homeKind(h) === 'wsl') },
      { key: 'ssh', title: tr('SSH 远端'), iconName: 'globe', items: visible.filter((h) => homeKind(h) === 'ssh') },
    ].filter((g) => g.items.length > 0)

    if (state.deviceFilter === 'all' && groups.length > 1) {
      dom.homeGrid.innerHTML = groups.map((g) => `<section class="sess-device-section">
        <div class="sess-device-section-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-${g.iconName}"/></svg>
          <span>${esc(g.title)}</span>
          <span class="sess-device-section-count">${g.items.length}</span>
        </div>
        <div class="pack-grid">${g.items.map(homeCardHtml).join('')}</div>
      </section>`).join('')
    } else {
      dom.homeGrid.innerHTML = `<div class="pack-grid">${visible.map(homeCardHtml).join('')}</div>`
    }

    // 绑定卡片点击与菜单动作（注意 HTML 属性全小写，使用 data-home 避免驼峰匹配失效）
    const homeOf = (dir) => homes.find((x) => x.home === dir) || null
    const fromMenu = (btn, fn) => {
      const details = btn.closest('details')
      if (details) details.open = false
      fn()
    }
    dom.homeGrid.querySelectorAll('[data-home]').forEach((btn) => {
      btn.onclick = () => openHome(btn.dataset.home, 'sessions')
    })
    dom.homeGrid.querySelectorAll('[data-home-open]').forEach((btn) => {
      btn.onclick = () => fromMenu(btn, () => openHomeFolder(btn.dataset.homeOpen))
    })
    dom.homeGrid.querySelectorAll('[data-home-rename]').forEach((btn) => {
      btn.onclick = () => fromMenu(btn, () => openRenameDialog(homeOf(btn.dataset.homeRename)))
    })
    dom.homeGrid.querySelectorAll('[data-home-analytics]').forEach((btn) => {
      btn.onclick = () => fromMenu(btn, () => openHome(btn.dataset.homeAnalytics, 'analytics'))
    })
    dom.homeGrid.querySelectorAll('[data-home-env]').forEach((btn) => {
      btn.onclick = () => fromMenu(btn, () => setGlobalHomeEnv(homeOf(btn.dataset.homeEnv)))
    })
    dom.homeGrid.querySelectorAll('[data-home-remove]').forEach((btn) => {
      btn.onclick = () => fromMenu(btn, () => removeRegisteredHome(homeOf(btn.dataset.homeRemove)))
    })
  }

  // ---- 二级：单个用户目录详情 ----
  function paintDetailHeader() {
    const h = currentHomeObj()
    if (!h) return
    const remote = isRemoteHome(h)
    const remoteState = remote ? state.remoteDataByHome.get(h.home) : null
    const displayPath = homeDisplayPath(h)
    const badge = deviceBadgeOf(h)
    if (dom.detailName) dom.detailName.textContent = h.label
    if (dom.detailPath) {
      const subText = remote ? `${badge.text} · ${displayPath}` : displayPath
      dom.detailPath.textContent = subText
      dom.detailPath.title = subText
    }
    if (dom.detailOpen) dom.detailOpen.hidden = remote
    if (dom.detailRefresh) dom.detailRefresh.disabled = state.loading || Boolean(remoteState?.loading) || state.statsLoadingHome === h.home
    if (dom.detailStop) {
      dom.detailStop.hidden = !h.running
      dom.detailStop.disabled = state.busy
    }
    if (dom.detailTabs) {
      dom.detailTabs.dataset.active = state.detailTab
      for (const btn of dom.detailTabs.querySelectorAll('[data-detail-tab]')) {
        btn.setAttribute('aria-selected', String(btn.dataset.detailTab === state.detailTab))
      }
    }
    const blanks = blankCandidates()
    if (dom.cleanBlankCount) {
      dom.cleanBlankCount.textContent = blanks.length > 0 ? String(blanks.length) : ''
      dom.cleanBlankCount.hidden = blanks.length === 0
    }
    if (dom.cleanBlankBtn) {
      dom.cleanBlankBtn.hidden = state.detailTab !== 'sessions'
      dom.cleanBlankBtn.disabled = state.loading || state.busy || Boolean(remoteState?.loading) || Boolean(remoteState?.unsupported) || blanks.length === 0
    }
    if (dom.runningBanner) {
      dom.runningBanner.hidden = !h.running
      if (h.running) {
        dom.runningText.textContent = tr('该用户目录当前有实例运行中：浏览会话与数据分析为纯静态只读，不影响实例；归档、置顶、移除工作区或永久删除前需先停止对应实例。')
        dom.runningStopBtn.disabled = state.busy
      }
    }
  }

  function renderRemoteStateBox({ iconName = 'server', title = '', desc = '', isError = false, retryFn = null } = {}) {
    const box = el('div', `sess-remote-state${isError ? ' is-error' : ''}`)
    box.appendChild(icon(iconName))
    if (title) box.appendChild(el('div', 'sess-remote-state-title', title))
    if (desc) box.appendChild(el('div', 'sess-remote-state-desc', desc))
    if (retryFn) {
      const btn = el('button', 'ghost sess-action-btn', tr('重新连接'))
      btn.type = 'button'
      btn.onclick = retryFn
      box.appendChild(btn)
    }
    return box
  }

  function paintDetailBody() {
    if (dom.tabSessions) dom.tabSessions.hidden = state.detailTab !== 'sessions'
    if (dom.tabAnalytics) dom.tabAnalytics.hidden = state.detailTab !== 'analytics'

    if (state.detailTab === 'analytics') {
      paintAnalytics()
      return
    }

    const h = currentHomeObj()
    const remote = isRemoteHome(h)
    const remoteState = remote ? state.remoteDataByHome.get(h.home) : null
    if (remote && (!remoteState || remoteState.loading || remoteState.error || remoteState.unsupported)) {
      if (dom.tabAllCount) dom.tabAllCount.textContent = '0'
      if (dom.tabArchivedCount) dom.tabArchivedCount.textContent = '0'
      if (dom.tabWorkspacesCount) dom.tabWorkspacesCount.textContent = '0'
      if (dom.archiveToolbar) dom.archiveToolbar.hidden = true
      if (dom.bulkBar) dom.bulkBar.hidden = true
      dom.listHost.textContent = ''
      if (!remoteState || remoteState.loading) {
        dom.listHost.appendChild(renderRemoteStateBox({
          iconName: homeKind(h) === 'wsl' ? 'box' : 'globe',
          title: tr('正在连接远端设备并读取会话目录…'),
          desc: `${deviceBadgeOf(h).text} · ${homeDisplayPath(h)}`,
        }))
      } else if (remoteState.unsupported) {
        dom.listHost.appendChild(renderRemoteStateBox({
          iconName: 'info',
          title: tr('远端核心版本暂不支持会话管理'),
          desc: tr('请先在「远程」页更新该设备上的 dsh-x-core，再回来查看会话与数据分析。'),
          retryFn: () => void loadRemoteHome(h.home, { force: true }),
        }))
      } else {
        dom.listHost.appendChild(renderRemoteStateBox({
          iconName: 'triangle-alert',
          title: tr('连接远端目录失败'),
          desc: remoteState.error,
          isError: true,
          retryFn: () => void loadRemoteHome(h.home, { force: true }),
        }))
      }
      return
    }

    const sessions = homeSessions(state.activeHome)
    const workspaces = homeWorkspaces(state.activeHome)
    const activeCount = sessions.filter((s) => !s.archived && !s.isSubagent).length
    const archivedCount = sessions.filter((s) => s.archived).length

    if (dom.tabAllCount) dom.tabAllCount.textContent = String(activeCount)
    if (dom.tabArchivedCount) dom.tabArchivedCount.textContent = String(archivedCount)
    if (dom.tabWorkspacesCount) dom.tabWorkspacesCount.textContent = String(workspaces.length)

    setSelectHidden(dom.workspaceSelect, state.view === 'workspaces')
    setSelectHidden(dom.statusSelect, state.view !== 'all')
    if (dom.staleOnlyWrap) dom.staleOnlyWrap.hidden = state.view !== 'workspaces'
    if (dom.archiveToolbar) dom.archiveToolbar.hidden = state.view !== 'archived'

    if (state.view === 'workspaces') {
      paintBulkBar([])
      paintWorkspaces()
      return
    }
    const list = filteredSessions()
    paintArchiveToolbar(list)
    paintBulkBar(list)
    paintSessionList(list)
  }

  // ---- 详情 Tab 2：纯静态目录数据分析 ----
  function paintAnalytics() {
    if (!dom.analyticsHost || state.detailTab !== 'analytics') return
    const h = currentHomeObj()
    if (!h) return
    dom.analyticsHost.textContent = ''

    if (state.statsLoadingHome === h.home && !state.statsByHome.has(h.home)) {
      dom.analyticsHost.appendChild(el('div', 'sess-empty', tr('正在静态分析该用户目录的数据与空间占用…')))
      return
    }
    if (state.statsError && !state.statsByHome.has(h.home)) {
      dom.analyticsHost.appendChild(renderRemoteStateBox({
        iconName: 'triangle-alert',
        title: tr('数据分析失败：{msg}', { msg: state.statsError }),
        isError: true,
        retryFn: () => void loadHomeStats(h.home, { force: true }),
      }))
      return
    }
    const st = state.statsByHome.get(h.home)
    if (!st) return
    if (st.unsupported) {
      dom.analyticsHost.appendChild(renderRemoteStateBox({
        iconName: 'info',
        title: tr('远端核心版本暂不支持数据分析'),
        desc: tr('请先在「远程」页更新该设备上的 dsh-x-core，再回来查看会话与数据分析。'),
        retryFn: () => void loadHomeStats(h.home, { force: true }),
      }))
      return
    }
    const remote = isRemoteHome(h)

    // 1. 顶部总览与「用户数据 vs 实例运行时」对比条
    const hero = el('div', 'sess-ana-hero')
    const heroTop = el('div', 'sess-ana-hero-top')
    const totalBox = el('div', 'sess-ana-total')
    totalBox.appendChild(el('div', 'sess-ana-total-label', tr('目录总占用')))
    totalBox.appendChild(el('div', 'sess-ana-total-val', bytesLabel(st.totalBytes)))
    heroTop.appendChild(totalBox)

    const split = el('div', 'sess-ana-split')
    const userPill = el('div', 'sess-ana-pill is-user')
    userPill.appendChild(el('span', 'sess-ana-pill-k', tr('用户数据')))
    userPill.appendChild(el('strong', 'sess-ana-pill-v', `${bytesLabel(st.userDataBytes)} (${pctLabel(st.userDataBytes, st.totalBytes)})`))
    const rtPill = el('div', 'sess-ana-pill is-runtime')
    rtPill.appendChild(el('span', 'sess-ana-pill-k', tr('实例运行时与缓存')))
    rtPill.appendChild(el('strong', 'sess-ana-pill-v', `${bytesLabel(st.runtimeBytes)} (${pctLabel(st.runtimeBytes, st.totalBytes)})`))
    split.append(userPill, rtPill)
    heroTop.appendChild(split)
    hero.appendChild(heroTop)

    // 分段占比条
    const bar = el('div', 'sess-ana-bar')
    if (st.totalBytes > 0 && st.categories.length > 0) {
      for (const cat of st.categories) {
        const pct = Math.max(1.2, (cat.bytes / st.totalBytes) * 100)
        const meta = categoryMeta(cat.key)
        const seg = el('div', `sess-ana-seg ${meta.color}`)
        seg.style.width = `${pct}%`
        seg.title = `${meta.label}: ${bytesLabel(cat.bytes)} (${pctLabel(cat.bytes, st.totalBytes)})`
        bar.appendChild(seg)
      }
    }
    hero.appendChild(bar)

    const legend = el('div', 'sess-ana-legend')
    for (const cat of st.categories) {
      const meta = categoryMeta(cat.key)
      const item = el('span', 'sess-ana-legend-item')
      item.appendChild(el('span', `sess-ana-dot ${meta.color}`))
      item.appendChild(el('span', '', `${meta.label} ${bytesLabel(cat.bytes)}`))
      legend.appendChild(item)
    }
    hero.appendChild(legend)
    dom.analyticsHost.appendChild(hero)

    const makeAnaRow = ({ title, sub, bytes, ratioTotal, tone = 'is-sessions', actionLabel = '', onAction = null, revealDir = '' }) => {
      const row = el('div', 'sess-ana-row')
      const left = el('div', 'sess-ana-row-main')
      const head = el('div', 'sess-ana-row-head')
      head.appendChild(el('span', 'sess-ana-row-title', title))
      head.appendChild(el('span', 'sess-ana-row-size', `${bytesLabel(bytes)} · ${pctLabel(bytes, ratioTotal)}`))
      left.appendChild(head)
      if (sub) left.appendChild(el('div', 'sess-ana-row-sub', sub))
      const track = el('div', 'sess-ana-mini-track')
      const fill = el('div', `sess-ana-mini-fill ${tone}`)
      const w = ratioTotal > 0 ? Math.min(100, Math.max(bytes > 0 ? 1.5 : 0, (bytes / ratioTotal) * 100)) : 0
      fill.style.width = `${w}%`
      track.appendChild(fill)
      left.appendChild(track)
      row.appendChild(left)

      const right = el('div', 'sess-ana-row-actions')
      if (actionLabel && onAction) {
        const btn = el('button', 'ghost sess-action-btn', actionLabel)
        btn.type = 'button'
        btn.onclick = onAction
        right.appendChild(btn)
      }
      if (revealDir && !remote) {
        const btn = el('button', 'sess-icon-btn')
        btn.type = 'button'
        btn.title = tr('在文件管理器中显示')
        btn.setAttribute('aria-label', tr('在文件管理器中显示'))
        btn.appendChild(icon('folder'))
        btn.onclick = () => revealSessionPath(st.home, revealDir)
        right.appendChild(btn)
      }
      if (right.childNodes.length) row.appendChild(right)
      return row
    }

    // 2. 用户数据层卡片
    const userCard = el('section', 'sess-ana-card')
    const userHead = el('div', 'sess-ana-card-head')
    userHead.appendChild(el('h2', 'sess-ana-card-title', tr('用户数据（与实例环境分离）')))
    userHead.appendChild(el('span', 'sess-ana-card-total', bytesLabel(st.userDataBytes)))
    userCard.appendChild(userHead)
    const userList = el('div', 'sess-ana-list')

    const sb = st.userData.sessions
    userList.appendChild(makeAnaRow({
      title: tr('会话日志（sessions/）'),
      sub: tr('共 {total} 条：活跃 {active}（{ab}）· 归档 {arch}（{arb}）· 空白 {blank} · 未挂载 {orphan}', {
        total: sb.total,
        active: sb.active,
        ab: bytesLabel(sb.activeBytes),
        arch: sb.archived,
        arb: bytesLabel(sb.archivedBytes),
        blank: sb.blank,
        orphan: sb.orphan,
      }),
      bytes: sb.bytes,
      ratioTotal: st.totalBytes,
      tone: 'is-sessions',
      actionLabel: tr('管理会话'),
      onAction: () => setDetailTab('sessions'),
      revealDir: sb.exists ? sb.path : '',
    }))

    const att = st.userData.attachments
    userList.appendChild(makeAnaRow({
      title: tr('附件库（attachments/）'),
      sub: tr('{n} 个内容去重对象（跨会话共享，删除单条会话时默认保留）', { n: att.files }),
      bytes: att.bytes,
      ratioTotal: st.totalBytes,
      tone: 'is-attachments',
      revealDir: att.exists ? att.path : '',
    }))

    const mem = st.userData.memory
    userList.appendChild(makeAnaRow({
      title: tr('记忆（memory/）'),
      sub: tr('{n} 个文件', { n: mem.files }),
      bytes: mem.bytes,
      ratioTotal: st.totalBytes,
      tone: 'is-memory',
      revealDir: mem.exists ? mem.path : '',
    }))

    const stor = st.userData.storages
    userList.appendChild(makeAnaRow({
      title: tr('工作区与索引状态（storages/）'),
      sub: tr('{n} 个文件（workspace.json、projcache、定时任务等）', { n: stor.files }),
      bytes: stor.bytes,
      ratioTotal: st.totalBytes,
      tone: 'is-plugin-data',
      revealDir: stor.exists ? stor.path : '',
    }))

    const sk = st.userData.skills
    if (sk.exists || sk.bytes > 0) {
      userList.appendChild(makeAnaRow({
        title: tr('用户技能（skills/）'),
        sub: tr('{n} 个文件', { n: sk.files }),
        bytes: sk.bytes,
        ratioTotal: st.totalBytes,
        tone: 'is-plugin-data',
        revealDir: sk.exists ? sk.path : '',
      }))
    }

    if (st.userData.rootFiles.files > 0) {
      userList.appendChild(makeAnaRow({
        title: tr('根目录配置与凭据'),
        sub: tr('{n} 个文件（.credentials.yaml、用量账本与设置备份等）', { n: st.userData.rootFiles.files }),
        bytes: st.userData.rootFiles.bytes,
        ratioTotal: st.totalBytes,
        tone: 'is-plugin-data',
      }))
    }

    for (const pd of st.userData.pluginData || []) {
      userList.appendChild(makeAnaRow({
        title: tr('插件数据：{name}/', { name: pd.name }),
        sub: tr('{n} 个文件', { n: pd.files }),
        bytes: pd.bytes,
        ratioTotal: st.totalBytes,
        tone: 'is-plugin-data',
        revealDir: pd.path,
      }))
    }
    userCard.appendChild(userList)
    dom.analyticsHost.appendChild(userCard)

    // 3. 实例运行时与缓存层卡片（清晰区分可重建的 node_modules / 缓存）
    const rtCard = el('section', 'sess-ana-card')
    const rtHead = el('div', 'sess-ana-card-head')
    rtHead.appendChild(el('h2', 'sess-ana-card-title', tr('实例运行时与缓存（可重建）')))
    rtHead.appendChild(el('span', 'sess-ana-card-total', bytesLabel(st.runtimeBytes)))
    rtCard.appendChild(rtHead)
    rtCard.appendChild(el('p', 'sess-ana-card-desc', tr('启动时「实例」会把插件依赖投影到 profiles/ 下，这些体积与缓存均可重建，不属于你的聊天或记忆数据。')))
    const rtList = el('div', 'sess-ana-list')

    for (const pf of st.runtimeData.profiles || []) {
      const bound = pf.linkedPresets.length
        ? pf.linkedPresets.map((p) => p.environmentName ? `${p.name}（${p.environmentName}）` : p.name).join('、')
        : tr('无关联启动项')
      rtList.appendChild(makeAnaRow({
        title: `profiles/${pf.name}/`,
        sub: tr('插件依赖 {deps} · 配置文件 {cfg} · 关联：{bound}', {
          deps: bytesLabel(pf.depsBytes),
          cfg: bytesLabel(pf.configBytes),
          bound,
        }),
        bytes: pf.totalBytes,
        ratioTotal: st.totalBytes,
        tone: 'is-profiles',
        revealDir: pf.path,
      }))
    }
    if (st.runtimeData.cache.bytes > 0 || st.runtimeData.cache.files > 0) {
      rtList.appendChild(makeAnaRow({
        title: tr('运行缓存（cache/ 等）'),
        sub: tr('{n} 个文件', { n: st.runtimeData.cache.files }),
        bytes: st.runtimeData.cache.bytes,
        ratioTotal: st.totalBytes,
        tone: 'is-cache',
        revealDir: st.runtimeData.cache.path || '',
      }))
    }
    if (st.runtimeData.logs.exists || st.runtimeData.logs.bytes > 0) {
      rtList.appendChild(makeAnaRow({
        title: tr('运行日志（logs/）'),
        sub: tr('{n} 个文件', { n: st.runtimeData.logs.files }),
        bytes: st.runtimeData.logs.bytes,
        ratioTotal: st.totalBytes,
        tone: 'is-cache',
        revealDir: st.runtimeData.logs.path,
      }))
    }
    if (!rtList.childNodes.length) {
      rtList.appendChild(el('div', 'sess-ana-empty-row', tr('该目录尚未产生 Profile 运行时或缓存文件。')))
    }
    rtCard.appendChild(rtList)
    dom.analyticsHost.appendChild(rtCard)

    // 4. 挂载到此目录的启动项与实例
    const mountCard = el('section', 'sess-ana-card')
    const mountHead = el('div', 'sess-ana-card-head')
    mountHead.appendChild(el('h2', 'sess-ana-card-title', tr('挂载到此目录的启动项与实例')))
    mountHead.appendChild(el('span', 'sess-ana-card-total', tr('{n} 个启动项', { n: (st.presets || []).length })))
    mountCard.appendChild(mountHead)
    if (!st.presets?.length) {
      mountCard.appendChild(el('p', 'sess-ana-card-desc', tr('当前没有启动项挂载到此用户目录。可在首页新建或编辑启动项，将任意「实例」挂载到这里。')))
    } else {
      const mountList = el('div', 'sess-ana-list')
      for (const preset of st.presets) {
        const row = el('div', 'sess-ana-mount-row')
        const left = el('div', 'sess-ana-mount-main')
        left.appendChild(el('span', 'sess-ana-row-title', preset.name))
        const meta = el('div', 'sess-ana-row-sub')
        meta.textContent = tr('实例：{env} · Profile：{profile}', {
          env: preset.environmentName || tr('未绑定'),
          profile: preset.profile,
        })
        left.appendChild(meta)
        row.appendChild(left)
        if (preset.running) row.appendChild(el('span', 'sess-badge is-running', tr('运行中')))
        mountList.appendChild(row)
      }
      mountCard.appendChild(mountList)
    }
    dom.analyticsHost.appendChild(mountCard)
  }

  function paintArchiveToolbar(list) {
    if (!dom.archiveToolbar || state.view !== 'archived') return
    const hasItems = list.length > 0
    if (dom.archiveSelectAll) {
      const allSelected = hasItems && list.every((s) => state.selected.has(keyOf(s.home, s.sessionId)))
      dom.archiveSelectAll.textContent = allSelected ? tr('取消全选') : tr('全选当前筛选 ({n})', { n: list.length })
      dom.archiveSelectAll.disabled = !hasItems || state.busy
    }
    if (dom.archiveUnarchiveAll) dom.archiveUnarchiveAll.disabled = !hasItems || state.busy
    if (dom.archiveDeleteFiltered) dom.archiveDeleteFiltered.disabled = !hasItems || state.busy
  }

  function paintBulkBar(list) {
    if (!dom.bulkBar) return
    const visibleMap = new Map(list.map((s) => [keyOf(s.home, s.sessionId), s]))
    const selectedItems = [...state.selected].map((k) => visibleMap.get(k)).filter(Boolean)
    dom.bulkBar.hidden = selectedItems.length === 0 || state.view === 'workspaces'
    if (selectedItems.length === 0) return
    dom.bulkCount.textContent = tr('已选 {n} 项', { n: selectedItems.length })
    const hasUnarchived = selectedItems.some((s) => !s.archived)
    const hasArchived = selectedItems.some((s) => s.archived)
    const hasPinned = selectedItems.some((s) => s.pinned)
    dom.bulkArchive.hidden = state.view === 'archived' || !hasUnarchived
    dom.bulkUnarchive.hidden = !hasArchived
    dom.bulkUnpin.hidden = state.view === 'archived' || !hasPinned
    dom.bulkArchive.disabled = state.busy
    dom.bulkUnarchive.disabled = state.busy
    dom.bulkUnpin.disabled = state.busy
    dom.bulkDelete.disabled = state.busy
  }

  function buildSessionRow(s) {
    const k = keyOf(s.home, s.sessionId)
    const row = el('div', `sess-row${s.archived ? ' is-archived' : ''}${s.pinned ? ' is-pinned' : ''}`)

    const check = el('input', 'sess-check')
    check.type = 'checkbox'
    check.checked = state.selected.has(k)
    check.setAttribute('aria-label', tr('选择会话 {title}', { title: s.title || tr('新会话') }))
    check.onchange = () => {
      if (check.checked) state.selected.add(k)
      else state.selected.delete(k)
      paint()
    }
    row.appendChild(check)

    const main = el('div', 'sess-main')
    const head = el('div', 'sess-head')
    const displayTitle = s.title || tr('新会话')
    const titleEl = el('div', `sess-title${s.title ? '' : ' is-untitled'}`, displayTitle)
    titleEl.title = displayTitle
    head.appendChild(titleEl)

    const badges = el('div', 'sess-badges')
    if (s.pinned) badges.appendChild(el('span', 'sess-badge is-pin', tr('已置顶')))
    if (s.archived) badges.appendChild(el('span', 'sess-badge is-arch', tr('已归档')))
    if (s.blank) badges.appendChild(el('span', 'sess-badge is-blank', tr('空白会话')))
    if (s.isSubagent) badges.appendChild(el('span', 'sess-badge is-sub', tr('子会话')))
    if (s.orphan) badges.appendChild(el('span', 'sess-badge is-orphan', tr('未挂载')))
    if (s.workspaceMissing) badges.appendChild(el('span', 'sess-badge is-warn', tr('目录缺失')))
    if (s.childIds?.length) badges.appendChild(el('span', 'sess-badge', tr('{n} 个子会话', { n: s.childIds.length })))
    if (badges.childNodes.length) head.appendChild(badges)
    main.appendChild(head)

    const meta = el('div', 'sess-meta')
    if (s.workspaceTitle) meta.appendChild(el('span', 'sess-ws-name', s.workspaceTitle))
    if (s.workspacePath) {
      if (s.workspaceTitle) meta.appendChild(el('span', 'sess-dot', '·'))
      const pathEl = el('span', 'sess-path', s.workspacePath)
      pathEl.title = s.workspacePath
      meta.appendChild(pathEl)
    }
    if (meta.childNodes.length) main.appendChild(meta)

    const stats = el('div', 'sess-submeta')
    stats.appendChild(el('span', '', tr('最近活动 {time}', { time: formatTime(s.updatedAt) })))
    if (typeof s.turns === 'number' && s.turns > 0) {
      stats.appendChild(el('span', 'sess-dot', '·'))
      stats.appendChild(el('span', '', tr('{n} 轮', { n: s.turns })))
    }
    if (s.totalTokens) {
      stats.appendChild(el('span', 'sess-dot', '·'))
      stats.appendChild(el('span', '', `${formatTokens(s.totalTokens)} tokens`))
    }
    if (s.bytes > 0) {
      stats.appendChild(el('span', 'sess-dot', '·'))
      stats.appendChild(el('span', '', bytesLabel(s.bytes)))
    }
    const idChip = el('span', 'sess-id-chip', s.sessionId.slice(0, 18))
    idChip.title = s.sessionId
    stats.appendChild(el('span', 'sess-dot', '·'))
    stats.appendChild(idChip)
    main.appendChild(stats)

    row.appendChild(main)

    const actions = el('div', 'sess-actions')
    const makeBtn = (iconName, label, onClick, { danger = false, active = false, disabled = false, titleText = label } = {}) => {
      const btn = el('button', `sess-icon-btn${danger ? ' is-danger' : ''}${active ? ' is-active' : ''}`)
      btn.type = 'button'
      btn.title = titleText
      btn.setAttribute('aria-label', titleText)
      btn.disabled = disabled || state.busy
      btn.appendChild(icon(iconName))
      btn.onclick = onClick
      return btn
    }

    const remote = Boolean(s.source && s.source !== 'local') || isRemoteHome(currentHomeObj())
    actions.appendChild(makeBtn(
      'external-link',
      tr('打开实例'),
      () => openSessionInstance(s),
      {
        disabled: s.archived || remote,
        titleText: remote
          ? tr('远端会话请在首页对应启动项打开')
          : (s.archived ? tr('已归档会话不能直接打开，请先取消归档') : tr('聚焦或启动对应实例并复制 Session ID')),
      },
    ))

    if (!s.archived) {
      actions.appendChild(makeBtn(
        'star',
        s.pinned ? tr('取消置顶') : tr('置顶'),
        () => runStateMutation(s.pinned ? 'unpin' : 'pin', [sessionItemRef(s)]),
        { active: s.pinned, titleText: s.pinned ? tr('取消置顶') : tr('置顶') },
      ))
    }

    actions.appendChild(makeBtn(
      s.archived ? 'rotate-ccw' : 'file-archive',
      s.archived ? tr('取消归档') : tr('归档'),
      () => runStateMutation(s.archived ? 'unarchive' : 'archive', [sessionItemRef(s)]),
      { titleText: s.archived ? tr('取消归档') : tr('归档') },
    ))

    actions.appendChild(makeBtn(
      'copy',
      tr('复制 Session ID'),
      async () => {
        const ok = await copyToClipboard(s.sessionId)
        showNotice(ok ? tr('已复制 Session ID：{id}', { id: s.sessionId }) : tr('复制失败'), ok ? 'ok' : 'error')
      },
    ))

    if (!remote && (s.sessionDir || (s.workspacePath && !s.workspaceMissing))) {
      actions.appendChild(makeBtn(
        'folder',
        tr('在文件管理器中显示'),
        () => revealSessionPath(s.home, s.sessionDir || s.workspacePath),
      ))
    }

    actions.appendChild(makeBtn(
      'trash-2',
      tr('永久删除'),
      () => openDeleteDialog([sessionItemRef(s)], { requireArchived: state.view === 'archived' }),
      { danger: true },
    ))

    row.appendChild(actions)
    return row
  }

  function paintSessionList(list) {
    dom.listHost.textContent = ''
    if (!list.length) {
      const msg = state.view === 'archived'
        ? tr('没有符合条件的已归档会话。')
        : tr('没有符合条件的会话。')
      dom.listHost.appendChild(el('div', 'sess-empty', msg))
      return
    }
    if (state.view === 'all') {
      const pinned = list.filter((s) => s.pinned).sort((a, b) => a.pinOrder - b.pinOrder)
      const rest = list.filter((s) => !s.pinned)
      if (pinned.length > 0) {
        dom.listHost.appendChild(el('div', 'sess-group-title', tr('已置顶 ({n})', { n: pinned.length })))
        const box = el('div', 'sess-list')
        for (const s of pinned) box.appendChild(buildSessionRow(s))
        dom.listHost.appendChild(box)
      }
      if (rest.length > 0) {
        if (pinned.length > 0) dom.listHost.appendChild(el('div', 'sess-group-title', tr('最近 ({n})', { n: rest.length })))
        const box = el('div', 'sess-list')
        for (const s of rest) box.appendChild(buildSessionRow(s))
        dom.listHost.appendChild(box)
      }
      return
    }
    const box = el('div', 'sess-list')
    for (const s of list) box.appendChild(buildSessionRow(s))
    dom.listHost.appendChild(box)
  }

  function paintWorkspaces() {
    dom.listHost.textContent = ''
    const list = filteredWorkspaces()
    if (!list.length) {
      dom.listHost.appendChild(el('div', 'sess-empty', state.staleOnly ? tr('没有疑似不再使用的工作区。') : tr('没有符合条件的工作区。')))
      return
    }
    const box = el('div', 'sess-list')
    for (const w of list) {
      const row = el('div', `sess-row sess-ws-row${w.stale ? ' is-stale' : ''}`)
      const main = el('div', 'sess-main')
      const head = el('div', 'sess-head')
      head.appendChild(el('div', 'sess-title', w.title || w.path || tr('未命名工作区')))
      const badges = el('div', 'sess-badges')
      if (!w.mounted) badges.appendChild(el('span', 'sess-badge is-orphan', tr('未挂载遗留')))
      for (const reason of w.staleReasons || []) {
        badges.appendChild(el('span', `sess-badge ${reason === 'missing_dir' ? 'is-warn' : 'is-blank'}`, staleReasonLabel(reason)))
      }
      if (badges.childNodes.length) head.appendChild(badges)
      main.appendChild(head)

      if (w.path) {
        const meta = el('div', 'sess-meta')
        const pathEl = el('span', 'sess-path', w.path)
        pathEl.title = w.path
        meta.appendChild(pathEl)
        main.appendChild(meta)
      }

      const stats = el('div', 'sess-submeta')
      stats.appendChild(el('span', '', tr('会话 {total}（活跃 {active} / 归档 {archived}）', {
        total: w.sessionCount,
        active: w.activeCount,
        archived: w.archivedCount,
      })))
      if (w.blankCount > 0) {
        stats.appendChild(el('span', 'sess-dot', '·'))
        stats.appendChild(el('span', '', tr('空白 {n}', { n: w.blankCount })))
      }
      stats.appendChild(el('span', 'sess-dot', '·'))
      stats.appendChild(el('span', '', bytesLabel(w.bytes)))
      if (w.lastActivityAt) {
        stats.appendChild(el('span', 'sess-dot', '·'))
        stats.appendChild(el('span', '', tr('最近活动 {time}', { time: formatTime(w.lastActivityAt) })))
      }
      main.appendChild(stats)
      row.appendChild(main)

      const actions = el('div', 'sess-actions')
      const viewBtn = el('button', 'ghost sess-action-btn', tr('查看会话'))
      viewBtn.type = 'button'
      viewBtn.onclick = () => {
        state.workspace = `${w.home}\0${w.id}`
        if (dom.workspaceSelect) {
          dom.workspaceSelect.value = state.workspace
          syncSelectUi(dom.workspaceSelect)
        }
        state.status = 'all'
        if (dom.statusSelect) {
          dom.statusSelect.value = 'all'
          syncSelectUi(dom.statusSelect)
        }
        setView('all')
      }
      actions.appendChild(viewBtn)

      if (!isRemoteHome(currentHomeObj()) && w.path && w.exists) {
        const revealBtn = el('button', 'sess-icon-btn')
        revealBtn.type = 'button'
        revealBtn.title = tr('在文件管理器中显示')
        revealBtn.setAttribute('aria-label', tr('在文件管理器中显示'))
        revealBtn.appendChild(icon('folder'))
        revealBtn.onclick = () => revealSessionPath(w.home, w.path)
        actions.appendChild(revealBtn)
      }

      if (w.mounted) {
        const unlinkBtn = el('button', 'ghost sess-action-btn', tr('从侧栏移除'))
        unlinkBtn.type = 'button'
        unlinkBtn.disabled = state.busy
        unlinkBtn.onclick = () => handleRemoveWorkspace(w, false)
        actions.appendChild(unlinkBtn)
      }

      const purgeBtn = el('button', 'ghost sess-action-btn is-danger', w.mounted ? tr('移除并删会话') : tr('删除遗留会话'))
      purgeBtn.type = 'button'
      purgeBtn.disabled = state.busy
      purgeBtn.onclick = () => handleRemoveWorkspace(w, true)
      actions.appendChild(purgeBtn)

      row.appendChild(actions)
      box.appendChild(row)
    }
    dom.listHost.appendChild(box)
  }

  // ---- 添加目录弹窗（与首页「创建项目」同款，支持本机 / WSL / SSH） ----
  function addSelectedConnection() {
    const val = state.addDeviceValue || 'local'
    if (!val.startsWith('conn:')) return null
    const id = val.slice(5)
    if (typeof connectionById === 'function') return connectionById(id)
    const list = typeof connectionsList === 'function' ? connectionsList() : []
    return list.find((c) => c.id === id) || null
  }

  function deviceIconHref(kind) {
    if (kind === 'wsl') return '/icons.svg#lucide-box'
    if (kind === 'ssh') return '/icons.svg#lucide-globe'
    return '/icons.svg#lucide-app-window'
  }

  function paintAddDeviceOptions(selected = state.addDeviceValue || 'local') {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : (v) => String(v ?? '')
    const connections = typeof connectionsList === 'function' ? connectionsList() : []
    const valid = selected === 'local' || connections.some((item) => `conn:${item.id}` === selected)
    state.addDeviceValue = valid ? selected : 'local'
    const pickedConn = addSelectedConnection()

    const localIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-app-window"/></svg>'
    const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg>'
    const rows = [
      `<button class="project-device-option${!pickedConn ? ' is-selected' : ''}" type="button" role="option" aria-selected="${!pickedConn}" data-sess-device-value="local"><span class="project-device-option-icon">${localIcon}</span><span class="project-device-option-text"><strong>${esc(tr('此电脑'))}</strong></span>${!pickedConn ? `<span class="project-device-check">${check}</span>` : ''}</button>`,
    ]
    for (const connection of connections) {
      const value = `conn:${connection.id}`
      const selectedRow = state.addDeviceValue === value
      const runtime = typeof projectDeviceRuntime === 'function' ? projectDeviceRuntime(connection) : {}
      const status = runtime.status || 'offline'
      const label = typeof projectDeviceLabel === 'function'
        ? projectDeviceLabel(connection)
        : (connection.name || connection.wslDistro || connection.host || connection.id)
      const pathText = typeof projectDevicePath === 'function' ? projectDevicePath(connection) : '~/.dsh'
      const mark = typeof projectDeviceStatusMark === 'function' ? projectDeviceStatusMark(status) : ''
      const connIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="${deviceIconHref(connection.kind)}"/></svg>`
      const kindTag = connection.kind === 'wsl' ? 'WSL' : 'SSH'
      rows.push(`<button class="project-device-option${selectedRow ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selectedRow}" data-sess-device-value="${esc(value)}"><span class="project-device-option-icon">${connIcon}</span><span class="project-device-option-text"><strong>${esc(label)}</strong><small>${esc(`${kindTag} · ${pathText}`)}</small></span><span class="project-device-option-state">${mark}${selectedRow ? `<span class="project-device-check">${check}</span>` : ''}</span></button>`)
    }
    rows.push(`<button class="project-device-option is-add" type="button" role="option" data-sess-device-value="${ADD_REMOTE_DEVICE_VAL}"><span class="project-device-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-plus"/></svg></span><span class="project-device-option-text"><strong>${esc(tr('添加远程设备…'))}</strong></span></button>`)
    rows.push(`<button class="project-device-option is-manage" type="button" role="option" data-sess-device-value="${MANAGE_REMOTE_DEVICE_VAL}"><span class="project-device-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-settings"/></svg></span><span class="project-device-option-text"><strong>${esc(tr('管理连接…'))}</strong></span></button>`)
    addDeviceList.innerHTML = rows.join('')

    if (dom.addDeviceLabel) {
      dom.addDeviceLabel.textContent = pickedConn
        ? (typeof projectDeviceLabel === 'function' ? projectDeviceLabel(pickedConn) : (pickedConn.name || pickedConn.id))
        : tr('此电脑')
    }
    dom.addDeviceIcon?.querySelector('use')?.setAttribute('href', deviceIconHref(pickedConn?.kind || 'local'))
    const status = pickedConn && typeof projectDeviceRuntime === 'function' ? (projectDeviceRuntime(pickedConn).status || '') : ''
    if (dom.addDeviceStatus) {
      dom.addDeviceStatus.hidden = !status || status === 'offline'
      dom.addDeviceStatus.className = `project-device-status project-device-dot${status === 'online' ? ' is-online' : status === 'preparing' ? ' is-preparing' : status === 'error' ? ' is-error' : ''}`
    }
    if (dom.addHomeBrowse) dom.addHomeBrowse.hidden = pickedConn?.kind === 'ssh'
    if (dom.addHomePath) {
      dom.addHomePath.placeholder = pickedConn
        ? tr('例如 ~/.dsh 或 /home/user/.dsh')
        : tr('选择文件夹；留空使用默认目录')
    }
    if (dom.addHomeHint) {
      dom.addHomeHint.textContent = !pickedConn
        ? tr('填本机 dsh 用户目录；留空使用默认目录。')
        : pickedConn.kind === 'wsl'
          ? tr('填 WSL 内的 dsh 用户目录；留空默认使用 ~/.dsh。')
          : tr('填 SSH 远端主机上的 dsh 用户目录；留空默认使用 ~/.dsh。')
    }
  }

  function positionAddDevicePanel() {
    if (!addDevicePanel || !dom.addDeviceTrigger) return
    if (typeof alignFloatingPanel === 'function') {
      alignFloatingPanel(addDevicePanel, dom.addDeviceTrigger)
      return
    }
    const rect = dom.addDeviceTrigger.getBoundingClientRect()
    addDevicePanel.style.width = `${rect.width}px`
    addDevicePanel.style.left = `${rect.left}px`
    addDevicePanel.style.top = `${rect.bottom + 6}px`
  }

  function openAddDevicePanel() {
    if (!addDevicePanel || !addDevicePanel.hidden) return
    paintAddDeviceOptions(state.addDeviceValue)
    addDevicePanel.hidden = false
    dom.addDeviceTrigger?.setAttribute('aria-expanded', 'true')
    positionAddDevicePanel()
  }

  function closeAddDevicePanel() {
    if (!addDevicePanel || addDevicePanel.hidden) return
    addDevicePanel.hidden = true
    dom.addDeviceTrigger?.setAttribute('aria-expanded', 'false')
  }

  function openAddHomeDialog() {
    if (!dom.addHomeDialog) return
    if (dom.addHomeName) dom.addHomeName.value = ''
    if (dom.addHomePath) dom.addHomePath.value = ''
    if (dom.addHomeError) {
      dom.addHomeError.hidden = true
      dom.addHomeError.textContent = ''
    }
    // 按当前筛选标签预选合理设备：在 WSL / SSH 标签下有对应连接时默认选中第一个
    const connections = typeof connectionsList === 'function' ? connectionsList() : []
    let initialDevice = 'local'
    if (state.deviceFilter === 'wsl' || state.deviceFilter === 'ssh') {
      const firstMatch = connections.find((c) => c.kind === state.deviceFilter)
      if (firstMatch) initialDevice = `conn:${firstMatch.id}`
    }
    paintAddDeviceOptions(initialDevice)
    closeAddDevicePanel()
    if (typeof showPackDialog === 'function') {
      showPackDialog(dom.addHomeDialog, dom.addHomeName)
    } else {
      dom.addHomeDialog.hidden = false
    }
    setTimeout(() => dom.addHomeName?.focus(), 0)
  }

  function closeAddHomeDialog() {
    closeAddDevicePanel()
    if (!dom.addHomeDialog) return
    if (typeof forceHidePackDialog === 'function') {
      void forceHidePackDialog(dom.addHomeDialog)
    } else {
      dom.addHomeDialog.hidden = true
    }
  }

  async function browseAddHomePath() {
    const conn = addSelectedConnection()
    if (conn?.kind === 'ssh') {
      dom.addHomePath?.focus()
      return
    }
    try {
      if (conn?.kind === 'wsl' && typeof pickWslDirectory === 'function') {
        const picked = await pickWslDirectory(conn.wslDistro, dom.addHomePath?.value || '~/.dsh', conn.wslUser || '')
        if (!picked.canceled && picked.path && dom.addHomePath) dom.addHomePath.value = picked.path
        else if (picked.error && dom.addHomeError) {
          dom.addHomeError.textContent = picked.error
          dom.addHomeError.hidden = false
        }
        return
      }
      if (typeof pickDirectoryPath !== 'function') return
      const picked = await pickDirectoryPath(dom.addHomePath?.value || '', tr('选择 DSH 用户目录'))
      if (!picked.canceled && picked.path && dom.addHomePath) dom.addHomePath.value = picked.path
      else if (picked.error && dom.addHomeError) {
        dom.addHomeError.textContent = picked.error
        dom.addHomeError.hidden = false
      }
    } catch (error) {
      if (dom.addHomeError) {
        dom.addHomeError.textContent = error.message || String(error)
        dom.addHomeError.hidden = false
      }
    }
  }

  async function submitAddHome(event) {
    event.preventDefault()
    if (dom.addHomeError) {
      dom.addHomeError.hidden = true
      dom.addHomeError.textContent = ''
    }
    const name = (dom.addHomeName?.value || '').trim()
    const rawPath = (dom.addHomePath?.value || '').trim()
    const conn = addSelectedConnection()
    const payload = conn
      ? { kind: conn.kind, connectionId: conn.id, remoteHome: rawPath || '~/.dsh', ...(name ? { name } : {}) }
      : { kind: 'local', home: rawPath, ...(name ? { name } : {}) }

    if (dom.addHomeSubmit) dom.addHomeSubmit.disabled = true
    state.busy = true
    try {
      const res = await post('/api/dsh-homes/add', payload)
      closeAddHomeDialog()
      const addedKind = conn ? conn.kind : 'local'
      if (state.deviceFilter !== 'all' && state.deviceFilter !== addedKind) {
        state.deviceFilter = addedKind
      }
      showOverviewNotice(
        conn
          ? tr('已添加远端目录：{name}', { name: name || `${conn.name || conn.wslDistro || conn.id} · ${rawPath || '~/.dsh'}` })
          : tr('已登记用户目录：{path}', { path: res.home || rawPath }),
        'ok',
      )
      await load({ silent: true, invalidateStats: true })
    } catch (error) {
      if (dom.addHomeError) {
        dom.addHomeError.textContent = error.message || String(error)
        dom.addHomeError.hidden = false
      }
    } finally {
      if (dom.addHomeSubmit) dom.addHomeSubmit.disabled = false
      state.busy = false
      paint()
    }
  }

  async function openHomeFolder(home) {
    try {
      await post('/api/dsh-homes/open', { home })
    } catch (error) {
      const msg = error.message || String(error)
      if (state.activeHome) showNotice(msg, 'error')
      else showOverviewNotice(msg, 'error')
    }
  }

  function openRenameDialog(h) {
    if (!h || !dom.renameDialog) return
    state.renamingHome = h.home
    dom.renamePath.textContent = isRemoteHome(h) ? `${deviceBadgeOf(h).text} · ${homeDisplayPath(h)}` : homeDisplayPath(h)
    dom.renameInput.value = h.label || ''
    dom.renameError.hidden = true
    dom.renameError.textContent = ''
    dom.renameDialog.hidden = false
    setTimeout(() => { dom.renameInput.focus(); dom.renameInput.select() }, 0)
  }

  function closeRenameDialog() {
    state.renamingHome = ''
    if (dom.renameDialog) dom.renameDialog.hidden = true
  }

  async function submitRenameHome(event) {
    event.preventDefault()
    const home = state.renamingHome
    const name = dom.renameInput.value.trim()
    if (!home || !name) {
      dom.renameError.textContent = tr('目录名称不能为空')
      dom.renameError.hidden = false
      return
    }
    dom.renameSave.disabled = true
    try {
      await post('/api/dsh-homes/rename', { home, name })
      closeRenameDialog()
      state.statsByHome.delete(home)
      await load({ silent: true })
      if (state.activeHome) showNotice(tr('已将目录显示名更新为「{name}」', { name }), 'ok')
      else showOverviewNotice(tr('已将目录显示名更新为「{name}」', { name }), 'ok')
    } catch (error) {
      dom.renameError.textContent = error.message || String(error)
      dom.renameError.hidden = false
    } finally {
      dom.renameSave.disabled = false
    }
  }

  async function setGlobalHomeEnv(h) {
    if (!h) return
    const ok = await appConfirm(
      tr('将系统用户环境变量 DSH_HOME 指向「{name}」（{path}）？设置后，命令行直接运行 dsh 也会默认使用这个数据目录。', { name: h.label, path: h.home }),
      { title: tr('设为全局 DSH_HOME'), okText: tr('设置') },
    )
    if (!ok) return
    try {
      const res = await post('/api/dsh-homes/env', { home: h.home })
      showOverviewNotice(res.message || tr('已更新 DSH_HOME 环境变量'), 'ok')
    } catch (error) {
      showOverviewNotice(error.message || String(error), 'error')
    }
  }

  async function removeRegisteredHome(h) {
    if (!h) return
    const ok = await appConfirm(
      tr('仅将「{name}」（{path}）从 DSH-X 用户目录列表中移除，不会删除磁盘上的任何文件。确定移除吗？', { name: h.label, path: homeDisplayPath(h) }),
      { title: tr('移除目录登记'), okText: tr('移除') },
    )
    if (!ok) return
    try {
      await post('/api/dsh-homes/remove', { home: h.home })
      state.statsByHome.delete(h.home)
      state.remoteDataByHome.delete(h.home)
      showOverviewNotice(tr('已移除目录登记「{name}」', { name: h.label }), 'ok')
      await load({ silent: true })
    } catch (error) {
      showOverviewNotice(error.message || String(error), 'error')
    }
  }

  // ---- 会话与工作区动作 ----
  async function revealSessionPath(home, targetPath) {
    try {
      await post('/api/sessions/reveal', { home, path: targetPath })
    } catch (error) {
      showNotice(error.message || String(error), 'error')
    }
  }

  async function openSessionInstance(s) {
    if (s.archived) {
      showNotice(tr('已归档会话不能直接打开，请先取消归档'), 'error')
      return
    }
    state.busy = true
    paint()
    try {
      const copied = await copyToClipboard(s.sessionId)
      const res = await post('/api/sessions/open', { home: s.home, sessionId: s.sessionId })
      const baseMsg = res.mode === 'started'
        ? tr('已启动并打开对应实例')
        : tr('已聚焦对应运行中的实例')
      showNotice(copied ? tr('{base}，Session ID 已复制便于快速定位。', { base: baseMsg }) : baseMsg, 'ok')
    } catch (error) {
      showNotice(error.message || String(error), 'error')
    } finally {
      state.busy = false
      paint()
    }
  }

  async function stopHomes(homes) {
    if (!homes.length) return false
    const labels = homes.map((h) => (state.data?.homes || []).find((x) => x.home === h)?.label || h).join('、')
    const ok = await appConfirm(
      tr('即将停止用户目录「{homes}」下所有正在运行的 dsh 实例。停止后才能安全执行离线归档、置顶或永久删除。', { homes: labels }),
      { title: tr('停止运行中的实例'), okText: tr('停止实例') },
    )
    if (!ok) return false
    state.busy = true
    paint()
    try {
      await post('/api/sessions/stop-home', { homes })
      showNotice(tr('已停止对应实例，正在刷新会话状态…'), 'ok')
      await load({ silent: true, invalidateStats: true })
      return true
    } catch (error) {
      showNotice(tr('停止实例失败：{msg}', { msg: error.message || String(error) }), 'error')
      return false
    } finally {
      state.busy = false
      paint()
    }
  }

  async function runStateMutation(action, items) {
    if (!items.length) return
    state.busy = true
    paint()
    try {
      const res = await post('/api/sessions/state', { action, items })
      const okCount = res.succeeded?.length || 0
      const failCount = res.failed?.length || 0
      const skipCount = res.skipped?.length || 0
      if (failCount > 0 && res.reasons?.running_home) {
        const runningHomes = [...new Set(res.failed.filter((f) => f.reason === 'running_home').map((f) => f.home))]
        showNotice(tr('操作未完成：{n} 条所属用户目录正在运行实例，请先停止对应实例后再试。', { n: res.reasons.running_home }), 'error')
        state.busy = false
        paint()
        const stopped = await stopHomes(runningHomes)
        if (stopped) return runStateMutation(action, items)
        return
      }
      const parts = [
        okCount ? tr('成功 {n}', { n: okCount }) : '',
        skipCount ? tr('跳过 {n}', { n: skipCount }) : '',
        failCount ? tr('失败 {n}', { n: failCount }) : '',
      ].filter(Boolean)
      showNotice(parts.join(' · ') || tr('操作完成'), failCount > 0 ? 'error' : 'ok')
      state.selected.clear()
      await load({ silent: true, invalidateStats: true })
    } catch (error) {
      showNotice(error.message || String(error), 'error')
    } finally {
      state.busy = false
      paint()
    }
  }

  async function handleRemoveWorkspace(w, deleteData) {
    if (w.homeRunning) {
      const stopped = await stopHomes([w.home])
      if (!stopped) return
    }
    const msg = deleteData
      ? tr('将永久删除工作区「{title}」下的全部 {n} 条会话数据（预计释放 {size}）。工作区本身的代码目录、Git、记忆与去重附件库不会被删除。此操作不可恢复，确定继续吗？', {
        title: w.title,
        n: w.sessionCount,
        size: bytesLabel(w.bytes),
      })
      : tr('仅将工作区「{title}」从 dsh 侧栏移除，不会删除其目录或任何会话文件（重新添加目录即可恢复）。确定移除吗？', { title: w.title })
    const ok = await appConfirm(msg, {
      title: deleteData ? tr('删除工作区会话数据') : tr('从侧栏移除工作区'),
      okText: deleteData ? tr('确认删除') : tr('移除'),
    })
    if (!ok) return
    state.busy = true
    paint()
    try {
      const res = await post('/api/sessions/workspace/remove', {
        home: w.home,
        ...(w.remoteRawHome ? { remoteRawHome: w.remoteRawHome } : {}),
        workspaceId: w.id,
        deleteData,
      })
      const freed = res.deleted?.freedBytes ? `（${tr('释放 {size}', { size: bytesLabel(res.deleted.freedBytes) })}）` : ''
      showNotice(deleteData ? tr('已清理工作区会话数据{freed}', { freed }) : tr('已从侧栏移除工作区「{title}」', { title: w.title }), 'ok')
      await load({ silent: true, invalidateStats: true })
    } catch (error) {
      showNotice(error.message || String(error), 'error')
    } finally {
      state.busy = false
      paint()
    }
  }

  // ---- 永久删除预检与二次确认弹窗 ----
  async function openDeleteDialog(items, { requireArchived = false, title = '' } = {}) {
    if (!items.length) return
    state.del = {
      items,
      requireArchived,
      includeChildren: false,
      title: title || tr('永久删除会话'),
      stage: 'loading',
      preview: null,
      ack: false,
      typed: '',
      result: null,
      error: '',
    }
    dom.deleteDialog.hidden = false
    paintDeleteDialog()
    await refreshDeletePreview()
  }

  async function refreshDeletePreview() {
    const d = state.del
    if (!d) return
    d.stage = 'loading'
    d.error = ''
    paintDeleteDialog()
    try {
      const preview = await post('/api/sessions/delete-preview', {
        items: d.items,
        includeChildren: d.includeChildren,
        requireArchived: d.requireArchived,
      })
      d.preview = preview
      d.stage = 'preview'
    } catch (error) {
      d.error = error.message || String(error)
      d.stage = 'preview'
    }
    paintDeleteDialog()
  }

  function closeDeleteDialog() {
    if (state.del?.stage === 'running') return
    const shouldReload = state.del?.stage === 'done'
    state.del = null
    dom.deleteDialog.hidden = true
    if (shouldReload) void load({ silent: true, invalidateStats: true })
  }

  function deleteNeedsTypedCount(d) {
    const count = d?.preview ? (d.preview.targets.length + (d.includeChildren ? d.preview.children.length : 0)) : 0
    return count >= 5
  }

  function canConfirmDelete(d) {
    if (!d || d.stage !== 'preview' || !d.preview) return false
    const total = d.preview.targets.length + (d.includeChildren ? d.preview.children.length : 0)
    if (total <= 0) return false
    if (!d.ack) return false
    if (deleteNeedsTypedCount(d) && d.typed.trim() !== String(total)) return false
    return true
  }

  function paintDeleteDialog() {
    const d = state.del
    if (!d || !dom.deleteDialog) return
    dom.deleteTitle.textContent = d.title
    dom.deleteBody.textContent = ''
    dom.deleteClose.disabled = d.stage === 'running'
    dom.deleteCancel.disabled = d.stage === 'running'

    if (d.stage === 'loading') {
      dom.deleteBody.appendChild(el('p', 'sess-del-note', tr('正在检查影响范围、关联子会话与实例运行状态…')))
      dom.deleteConfirm.hidden = false
      dom.deleteConfirm.disabled = true
      dom.deleteConfirm.textContent = tr('永久删除')
      dom.deleteCancel.textContent = tr('取消')
      return
    }
    if (d.stage === 'running') {
      dom.deleteBody.appendChild(el('p', 'sess-del-note', tr('正在安全执行离线删除并校验 workspace.json…')))
      dom.deleteConfirm.hidden = false
      dom.deleteConfirm.disabled = true
      dom.deleteConfirm.textContent = tr('删除中…')
      return
    }
    if (d.stage === 'done') {
      const r = d.result || { succeeded: [], failed: [], skipped: [], freedBytes: 0, reasons: {} }
      const box = el('div', 'sess-del-summary')
      box.appendChild(el('div', 'sess-del-metric', tr('已删除：{n} 条（释放 {size}）', { n: r.succeeded.length, size: bytesLabel(r.freedBytes) })))
      if (r.skipped.length) box.appendChild(el('div', 'sess-del-metric is-muted', tr('已跳过：{n} 条', { n: r.skipped.length })))
      if (r.failed.length) box.appendChild(el('div', 'sess-del-metric is-danger', tr('失败：{n} 条', { n: r.failed.length })))
      dom.deleteBody.appendChild(box)
      const reasonEntries = Object.entries(r.reasons || {})
      if (reasonEntries.length) {
        const list = el('ul', 'sess-del-list')
        for (const [code, count] of reasonEntries) list.appendChild(el('li', '', `${reasonLabel(code)}：${count}`))
        dom.deleteBody.appendChild(list)
      }
      dom.deleteConfirm.hidden = true
      dom.deleteConfirm.textContent = tr('永久删除')
      dom.deleteCancel.textContent = tr('完成')
      return
    }
    if (d.error) {
      dom.deleteBody.appendChild(el('p', 'sess-del-error', d.error))
      dom.deleteConfirm.hidden = false
      dom.deleteConfirm.disabled = true
      return
    }

    const p = d.preview
    const totalCount = p.targets.length + (d.includeChildren ? p.children.length : 0)
    const totalBytes = p.targetBytes + (d.includeChildren ? p.childrenBytes : 0)

    const summary = el('div', 'sess-del-summary')
    summary.appendChild(el('div', 'sess-del-metric', tr('将永久删除 {n} 条会话，预计释放 {size}', { n: totalCount, size: bytesLabel(totalBytes) })))
    if (p.blocked.length > 0) summary.appendChild(el('div', 'sess-del-metric is-warn', tr('已拦下 {n} 条无法立即删除的会话', { n: p.blocked.length })))
    dom.deleteBody.appendChild(summary)

    if (p.runningHomes?.length > 0) {
      const warn = el('div', 'sess-del-banner is-warn')
      const names = p.runningHomes.map((h) => h.label).join('、')
      warn.appendChild(el('span', '', tr('用户目录「{homes}」正在运行实例，对应会话无法直接删除。', { homes: names })))
      const stopBtn = el('button', 'ghost sess-action-btn', tr('停止实例并重新检查'))
      stopBtn.type = 'button'
      stopBtn.onclick = async () => {
        const stopped = await stopHomes(p.runningHomes.map((h) => h.home))
        if (stopped) await refreshDeletePreview()
      }
      warn.appendChild(stopBtn)
      dom.deleteBody.appendChild(warn)
    }

    if (p.children.length > 0) {
      const childBox = el('div', 'sess-del-section')
      const lbl = el('label', 'sess-del-check')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = d.includeChildren
      cb.onchange = () => { d.includeChildren = cb.checked; paintDeleteDialog() }
      lbl.appendChild(cb)
      lbl.appendChild(el('span', '', tr('连同 {n} 个关联子会话 / 分叉一并删除（额外释放 {size}）', { n: p.children.length, size: bytesLabel(p.childrenBytes) })))
      childBox.appendChild(lbl)
      dom.deleteBody.appendChild(childBox)
    }

    const blockedReasons = Object.entries(p.reasons || {})
    if (blockedReasons.length > 0) {
      const sec = el('div', 'sess-del-section')
      sec.appendChild(el('div', 'sess-del-sec-title', tr('未纳入本次删除的条目')))
      const ul = el('ul', 'sess-del-list')
      for (const [code, cnt] of blockedReasons) ul.appendChild(el('li', '', `${reasonLabel(code)}：${cnt}`))
      sec.appendChild(ul)
      dom.deleteBody.appendChild(sec)
    }

    const excl = el('div', 'sess-del-section')
    excl.appendChild(el('div', 'sess-del-sec-title', tr('以下内容不在删除范围，将完整保留')))
    const ul = el('ul', 'sess-del-list')
    for (const code of p.excluded || []) ul.appendChild(el('li', '', excludedLabel(code)))
    excl.appendChild(ul)
    dom.deleteBody.appendChild(excl)

    if (totalCount > 0) {
      const confirmSec = el('div', 'sess-del-confirm-box')
      const ackLabel = el('label', 'sess-del-check')
      const ackCb = el('input')
      ackCb.type = 'checkbox'
      ackCb.checked = d.ack
      ackCb.onchange = () => { d.ack = ackCb.checked; dom.deleteConfirm.disabled = !canConfirmDelete(d) }
      ackLabel.appendChild(ackCb)
      ackLabel.appendChild(el('span', '', tr('我已知晓删除后无法恢复')))
      confirmSec.appendChild(ackLabel)

      if (deleteNeedsTypedCount(d)) {
        const typeRow = el('div', 'sess-del-type-row')
        typeRow.appendChild(el('span', 'sess-del-type-label', tr('批量删除请输入待删条数「{n}」以确认：', { n: totalCount })))
        const input = el('input', 'sess-del-type-input')
        input.type = 'text'
        input.autocomplete = 'off'
        input.spellcheck = false
        input.placeholder = String(totalCount)
        input.value = d.typed
        input.oninput = () => { d.typed = input.value; dom.deleteConfirm.disabled = !canConfirmDelete(d) }
        typeRow.appendChild(input)
        confirmSec.appendChild(typeRow)
      }
      dom.deleteBody.appendChild(confirmSec)
    }

    dom.deleteConfirm.hidden = false
    dom.deleteConfirm.textContent = tr('永久删除 ({n})', { n: totalCount })
    dom.deleteConfirm.disabled = !canConfirmDelete(d)
    dom.deleteCancel.textContent = tr('取消')
  }

  async function executeDelete() {
    const d = state.del
    if (!canConfirmDelete(d)) return
    d.stage = 'running'
    paintDeleteDialog()
    try {
      const res = await post('/api/sessions/delete', {
        items: d.items,
        includeChildren: d.includeChildren,
        requireArchived: d.requireArchived,
      })
      d.result = res
      d.stage = 'done'
      state.selected.clear()
      paintDeleteDialog()
    } catch (error) {
      d.error = error.message || String(error)
      d.stage = 'preview'
      paintDeleteDialog()
    }
  }

  // ---- 事件绑定 ----
  dom.refreshBtn?.addEventListener('click', () => { showOverviewNotice(''); void load({ invalidateStats: true }) })
  dom.addHomeBtn?.addEventListener('click', () => openAddHomeDialog())
  dom.deviceFilterBar?.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-device-filter]')
    if (!btn) return
    const next = btn.dataset.deviceFilter
    if (!['all', 'local', 'wsl', 'ssh'].includes(next)) return
    state.deviceFilter = next
    paintOverview()
  })

  // 添加目录弹窗与设备选择面板事件
  dom.addHomeForm?.addEventListener('submit', (e) => void submitAddHome(e))
  dom.addHomeClose?.addEventListener('click', closeAddHomeDialog)
  dom.addHomeCancel?.addEventListener('click', closeAddHomeDialog)
  dom.addHomeDialog?.addEventListener('click', (event) => {
    if (event.target === dom.addHomeDialog) closeAddHomeDialog()
  })
  if (dom.addHomeDialog && typeof trapPackDialog === 'function') {
    trapPackDialog(dom.addHomeDialog, () => {
      if (!addDevicePanel.hidden) { closeAddDevicePanel(); return }
      closeAddHomeDialog()
    })
  }
  dom.addHomeBrowse?.addEventListener('click', () => void browseAddHomePath())
  dom.addDeviceTrigger?.addEventListener('click', (event) => {
    event.stopPropagation()
    if (addDevicePanel.hidden) openAddDevicePanel()
    else closeAddDevicePanel()
  })
  addDeviceList.addEventListener('click', (event) => {
    const option = event.target.closest?.('[data-sess-device-value]')
    if (!option) return
    const value = option.dataset.sessDeviceValue
    if (value === ADD_REMOTE_DEVICE_VAL) {
      closeAddDevicePanel()
      if (typeof openConnectionDialog === 'function') void openConnectionDialog()
      return
    }
    if (value === MANAGE_REMOTE_DEVICE_VAL) {
      closeAddHomeDialog()
      if (typeof openRemoteSettingsPage === 'function') openRemoteSettingsPage()
      return
    }
    state.addDeviceValue = value
    paintAddDeviceOptions(value)
    closeAddDevicePanel()
    if (value.startsWith('conn:')) {
      const conn = addSelectedConnection()
      const runtime = conn && typeof projectDeviceRuntime === 'function' ? projectDeviceRuntime(conn) : {}
      if (conn && runtime.status !== 'online' && typeof startConnectionPrepare === 'function') {
        void startConnectionPrepare(conn.id)
      }
    }
  })
  document.addEventListener('click', (event) => {
    if (addDevicePanel.hidden) return
    if (addDevicePanel.contains(event.target) || dom.addDeviceTrigger?.contains(event.target)) return
    closeAddDevicePanel()
  })
  window.addEventListener('resize', () => {
    if (!addDevicePanel.hidden) positionAddDevicePanel()
  })

  dom.detailBack?.addEventListener('click', closeHome)
  dom.detailOpen?.addEventListener('click', () => { if (state.activeHome) void openHomeFolder(state.activeHome) })
  dom.detailRename?.addEventListener('click', () => { const h = currentHomeObj(); if (h) openRenameDialog(h) })
  dom.detailRefresh?.addEventListener('click', async () => {
    showNotice('')
    await load({ invalidateStats: true })
    const h = currentHomeObj()
    if (h && isRemoteHome(h)) await loadRemoteHome(h.home, { force: true })
    if (state.activeHome && state.detailTab === 'analytics') await loadHomeStats(state.activeHome, { force: true })
  })
  dom.detailStop?.addEventListener('click', () => { if (state.activeHome) void stopHomes([state.activeHome]) })
  dom.runningStopBtn?.addEventListener('click', () => { if (state.activeHome) void stopHomes([state.activeHome]) })

  dom.detailTabs?.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-detail-tab]')
    if (btn) setDetailTab(btn.dataset.detailTab)
  })
  dom.cleanBlankBtn?.addEventListener('click', () => {
    const blanks = blankCandidates().map(sessionItemRef)
    if (!blanks.length) return
    void openDeleteDialog(blanks, { requireArchived: false, title: tr('批量清理空白会话') })
  })

  dom.tabs?.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-sess-tab]')
    if (btn) setView(btn.dataset.sessTab)
  })
  dom.search?.addEventListener('input', () => { state.search = dom.search.value; paint() })
  dom.workspaceSelect?.addEventListener('change', () => { state.workspace = dom.workspaceSelect.value; paint() })
  dom.statusSelect?.addEventListener('change', () => { state.status = dom.statusSelect.value; state.selected.clear(); paint() })
  dom.sortSelect?.addEventListener('change', () => { state.sort = dom.sortSelect.value; paint() })
  dom.staleOnly?.addEventListener('change', () => { state.staleOnly = dom.staleOnly.checked; paint() })

  dom.archiveSelectAll?.addEventListener('click', () => {
    const list = filteredSessions()
    const allSelected = list.length > 0 && list.every((s) => state.selected.has(keyOf(s.home, s.sessionId)))
    if (allSelected) {
      for (const s of list) state.selected.delete(keyOf(s.home, s.sessionId))
    } else {
      for (const s of list) state.selected.add(keyOf(s.home, s.sessionId))
    }
    paint()
  })
  dom.archiveUnarchiveAll?.addEventListener('click', () => {
    const items = filteredSessions().map(sessionItemRef)
    void runStateMutation('unarchive', items)
  })
  dom.archiveDeleteFiltered?.addEventListener('click', () => {
    const items = filteredSessions().map(sessionItemRef)
    if (!items.length) return
    void openDeleteDialog(items, { requireArchived: true, title: tr('永久删除筛选的归档会话') })
  })

  function selectedListItems() {
    const visible = filteredSessions()
    return visible
      .filter((s) => state.selected.has(keyOf(s.home, s.sessionId)))
      .map(sessionItemRef)
  }
  dom.bulkArchive?.addEventListener('click', () => void runStateMutation('archive', selectedListItems()))
  dom.bulkUnarchive?.addEventListener('click', () => void runStateMutation('unarchive', selectedListItems()))
  dom.bulkUnpin?.addEventListener('click', () => void runStateMutation('unpin', selectedListItems()))
  dom.bulkDelete?.addEventListener('click', () => {
    const items = selectedListItems()
    if (!items.length) return
    void openDeleteDialog(items, { requireArchived: state.view === 'archived' })
  })
  dom.bulkClear?.addEventListener('click', () => { state.selected.clear(); paint() })

  dom.renameForm?.addEventListener('submit', (e) => void submitRenameHome(e))
  dom.renameClose?.addEventListener('click', closeRenameDialog)
  dom.renameCancel?.addEventListener('click', closeRenameDialog)
  dom.renameDialog?.addEventListener('click', (event) => {
    if (event.target === dom.renameDialog) closeRenameDialog()
  })

  dom.deleteClose?.addEventListener('click', closeDeleteDialog)
  dom.deleteCancel?.addEventListener('click', closeDeleteDialog)
  dom.deleteConfirm?.addEventListener('click', () => void executeDelete())
  dom.deleteDialog?.addEventListener('click', (event) => {
    if (event.target === dom.deleteDialog) closeDeleteDialog()
  })

  initUiSelects()
  syncFilterOptions()

  globalThis.sessionsUi = {
    load,
    syncDevices() {
      if (dom.addHomeDialog && !dom.addHomeDialog.hidden) {
        paintAddDeviceOptions(state.addDeviceValue)
      }
    },
    repaint() {
      syncFilterOptions()
      paint()
      if (dom.addHomeDialog && !dom.addHomeDialog.hidden) paintAddDeviceOptions(state.addDeviceValue)
      if (state.del) paintDeleteDialog()
    },
  }
})()
