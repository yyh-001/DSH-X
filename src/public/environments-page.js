// 环境页（导航「实例」）：列出环境，新建 / 复制 / 删除，改名改版本，加入 / 移除 / 升级插件、检查兼容性，
// 导入（实例文件、GitHub 仓库、内置配方）和导出，跟随上游的检查更新 / 应用更新 / 切回旧版本。
// 这里只改环境清单（服务端的 environment.json），不碰任何 profile 目录：下次用这个环境启动时，
// 服务端才把清单写进 Profile 并装依赖（见 server.js 的 applyLaunchEnvironment）。
//
// 单独一个文件，跑在主脚本之后，用主脚本的全局：t、post、getJson、escapeHtml、notify、appConfirm、
// installedList、UPDATE_CHANNEL_NAMES、UPDATE_CHANNELS、paneLoaders、createUiSelect、syncUiSelect、
// showPackDialog、hidePackDialog、trapPackDialog、packNotes，卡片和配置页共用 gridCardHtml、packMoreIcons，
// 版本那行和启动项编辑框共用 switchChannel、paintChannelSwitch、openVersionManager、recommendedVersion、
// paintCompatibilityResult，编辑框的版本组显隐交给 paintLaunchVersionGroup，
// 导入导出复用主脚本的弹窗（openImportDialog、inspectPack、openExportDialog、environmentState、AUTO_VERSION）。
(() => {
  const byId = (id) => document.getElementById(id)
  const el = {
    top: byId('environmentTop'),
    grid: byId('environmentGrid'),
    hint: byId('environmentHint'),
    overview: byId('environmentOverview'),
    view: byId('environmentView'),
    create: byId('environmentCreate'),
    createDialog: byId('environmentCreateDialog'),
    createForm: byId('environmentCreateForm'),
    newName: byId('environmentNewName'),
    createError: byId('environmentCreateError'),
    createSave: byId('environmentCreateSave'),
    createCancel: byId('environmentCreateCancel'),
    createClose: byId('environmentCreateClose'),
    importButton: byId('environmentImport'),
    back: byId('environmentBack'),
    detailName: byId('environmentDetailName'),
    detailSub: byId('environmentDetailSub'),
    upgrade: byId('environmentUpgrade'),
    exportButton: byId('environmentExport'),
    backups: byId('environmentBackups'),
    duplicate: byId('environmentDuplicate'),
    remove: byId('environmentDelete'),
    tabs: byId('environmentTabs'),
    pluginsBox: byId('environmentPluginsBox'),
    mcpHost: byId('environmentMcpHost'),
    skillsHost: byId('environmentSkillsHost'),
    editForm: byId('environmentEditForm'),
    saveStatus: byId('environmentSaveStatus'),
    name: byId('environmentName'),
    version: byId('environmentVersion'),
    channel: byId('environmentChannel'),
    channelName: byId('environmentChannelName'),
    manageVersions: byId('environmentManageVersions'),
    checkCompatibility: byId('environmentCheckCompatibility'),
    checkPluginUpdates: byId('environmentCheckPluginUpdates'),
    compat: byId('environmentCompatibility'),
    compatStatus: byId('environmentCompatibilityStatus'),
    compatIssues: byId('environmentCompatibilityIssues'),
    configBox: byId('environmentConfigBox'),
    pluginSubtabs: byId('environmentPluginSubtabs'),
    installedCount: byId('environmentInstalledCount'),
    installedPane: byId('environmentInstalledPane'),
    marketPane: byId('environmentMarketPane'),
    marketTools: byId('environmentMarketTools'),
    addForm: byId('environmentAddForm'),
    addOpen: byId('environmentAddOpen'),
    addDialog: byId('environmentAddDialog'),
    addClose: byId('environmentAddClose'),
    addCancel: byId('environmentAddCancel'),
    addDialogError: byId('environmentAddDialogError'),
    addError: byId('environmentAddError'),
    addSource: byId('environmentAddSource'),
    addSearch: byId('environmentAddSearch'),
    addRefresh: byId('environmentAddRefresh'),
    addCategories: byId('environmentAddCategories'),
    addMarket: byId('environmentAddMarket'),
    spec: byId('environmentSpec'),
    addSubmit: byId('environmentAdd'),
    plugins: byId('environmentPluginList'),
    usage: byId('environmentUsage'),
    checkUpdates: byId('environmentCheckUpdates'),
    upstream: byId('environmentUpstream'),
    upstreamText: byId('environmentUpstreamText'),
    applyUpdate: byId('environmentApplyUpdate'),
    historyRow: byId('environmentHistoryRow'),
    history: byId('environmentHistory'),
    restore: byId('environmentRestore'),
    updateDialog: byId('environmentUpdateDialog'),
    updateBody: byId('environmentUpdateBody'),
    updateHint: byId('environmentUpdateHint'),
    updateGo: byId('environmentUpdateGo'),
    updateCancel: byId('environmentUpdateCancel'),
  }
  let environments = []
  let builtin = []
  // 名字上限由服务端给（ENVIRONMENT.NAME_MAX），页面不再自己写一份
  let nameMax = 0
  let openedId = ''
  let activeTab = 'plugins'
  let pluginSubTab = 'installed'
  let busy = false
  // 跟随上游的检查结果：环境 id → {available, installed, latest, error}（服务端缓存 10 分钟）
  let updates = {}
  let checking = false
  // 实例内各 npm 插件的更新检查结果：环境 id → { [插件名]: { current, latest, available } }
  let pluginUpdates = {}
  let checkingPlugins = false
  // 正在确认的那次更新检查（服务端给的 token + 差别）；每次打开更新框加一，晚到的结果不画
  let updateCheck = null
  let updateRevision = 0
  // 兼容性检查：每次发起或作废加一，晚到的结果不画；busy 时检查钮置灰
  const compat = { request: 0, busy: false }

  const opened = () => environments.find((env) => env.id === openedId) || null
  const versionText = (env) => (env.dshVersion === AUTO_VERSION ? t('自动（{channel}）', { channel: t(UPDATE_CHANNEL_NAMES[env.updateChannel] || env.updateChannel) }) : env.dshVersion)
  const thirdParty = (env) => env.plugins.filter((plugin) => !plugin.official)

  // 上游的哪一版：release 的 tag，其次版本号（检查结果给 version，环境来源里记的是 packVersion）
  const releaseLabel = (item) => item?.release || item?.version || item?.packVersion || ''
  // 服务端 ENVIRONMENT.PLUGIN_ORIGIN.LOCAL：这条插件是本地增量里的
  const LOCAL_ORIGIN = 'local'
  // 和本地改动撞上的几种情形（服务端 ENVIRONMENT_UPSTREAM.CONFLICT）→ 更新框里的说法
  const CONFLICT_TEXT = Object.freeze({
    changed: '{name}：上游换成了 {to}，你本地钉的 {local} 照留',
    removed: '{name}：你删掉了它，上游这次换成了 {to}，照样删着',
    dropped: '{name}：上游这次删掉了它，你本地钉的 {local} 照留',
  })

  function tagsOf(env) {
    const tags = []
    if (updates[env.id]?.available) tags.push(t('有新版本 {version}', { version: releaseLabel(updates[env.id].latest) }))
    if (env.following) tags.push(t('跟随 {repo}', { repo: env.source.repo }))
    else if (env.source?.label) tags.push(t('来源：{source}', { source: env.source.label }))
    const local = env.delta ? env.delta.added.length + env.delta.changed.length + env.delta.removed.length : 0
    if (local) tags.push(t('本地改动 {count}', { count: local }))
    if (env.usedBy.length) tags.push(t('{count} 个启动项在用', { count: env.usedBy.length }))
    return tags
  }

  // 卡片右边的「更多操作」：和详情页那排按钮是同一组动作（复制 / 导出 / 删除），不另起一套
  function menuOf(env) {
    const inUse = env.usedBy.length > 0
    return `
      <button class="ghost" type="button" data-environment-copy="${escapeHtml(env.id)}" ${busy ? 'disabled' : ''}>${packMoreIcons.copy}${escapeHtml(t('复制实例'))}</button>
      <button class="ghost" type="button" data-environment-export="${escapeHtml(env.id)}">${packMoreIcons.export}${escapeHtml(t('导出镜像'))}</button>
      <button class="ghost danger" type="button" data-environment-delete="${escapeHtml(env.id)}" ${busy || inUse ? 'disabled' : ''} ${inUse ? `title="${escapeHtml(t('还有启动项在用，先给它们换一个实例'))}"` : ''}>${packMoreIcons.trash}${escapeHtml(t('删除实例'))}</button>`
  }

  function renderGrid() {
    el.grid.innerHTML = environments.map((env) => gridCardHtml({
      data: { environment: env.id },
      label: t('查看实例 {name} 的插件', { name: env.name }),
      // 色相按 id 定：改名不换色
      tile: { name: env.id, displayName: env.name },
      name: env.name,
      meta: t('DSH {version} · {count} 个插件', { version: versionText(env), count: thirdParty(env).length }),
      tags: tagsOf(env),
      menu: menuOf(env),
    })).join('')
    el.hint.textContent = environments.length ? '' : t('还没有实例。新建、导入一个，或者先保存一个启动项，启动器会按它的配置自动生成。')
    const envOf = (id) => environments.find((env) => env.id === id) || null
    const fromMenu = (button, action) => { button.closest('details').open = false; action() }
    el.grid.querySelectorAll('[data-environment]').forEach((button) => {
      button.onclick = () => open(button.dataset.environment)
    })
    el.grid.querySelectorAll('[data-environment-copy]').forEach((button) => {
      button.onclick = () => fromMenu(button, () => duplicateEnvironment(envOf(button.dataset.environmentCopy)))
    })
    el.grid.querySelectorAll('[data-environment-export]').forEach((button) => {
      button.onclick = () => fromMenu(button, () => exportEnvironment(envOf(button.dataset.environmentExport)))
    })
    el.grid.querySelectorAll('[data-environment-delete]').forEach((button) => {
      button.onclick = () => fromMenu(button, () => { void removeEnvironment(envOf(button.dataset.environmentDelete)) })
    })
  }

  /**
   * 版本下拉：自动 + 已装版本 + 实例现在钉的那个。已装版本会变（实例页也能打开版本管理装 / 删），
   * 所以每次重画都对一遍，选项变了才重建，并保住正在选的那个值。
   */
  function paintVersionOptions(env) {
    const keep = el.editForm.dataset.environment === env.id ? el.version.value : env.dshVersion
    const versions = [...new Set([AUTO_VERSION, ...installedList(), env.dshVersion, keep].filter(Boolean))]
    const key = versions.join('\n')
    if (el.version.dataset.options !== key) {
      el.version.dataset.options = key
      el.version.innerHTML = versions.map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(version === AUTO_VERSION ? t('自动最新版本') : version)}</option>`).join('')
    }
    el.version.value = keep
  }

  /**
   * 兼容性检查查谁：实例本身只是一份清单，插件装在用它启动过的配置里，所以查第一份装着它的配置
   * （装的是上次用这个实例启动时的那份）。版本按表单上正在选的算，改版本前就能先查。
   * 还没有配置装过它、或自动版本一个都解析不出来时返回 null。
   */
  function compatibilityTarget(env) {
    const where = env.applied[0]
    if (!where) return null
    const version = el.version.value === AUTO_VERSION ? recommendedVersion(where.profile, where.home, switchChannel(el.channel)) : el.version.value
    return version ? { ...where, version } : null
  }

  function resetCompatibility() {
    compat.request += 1
    compat.busy = false
    el.compat.hidden = true
    el.compat.classList.remove('is-compatible', 'is-incompatible')
  }

  async function checkCompatibility() {
    const env = opened()
    const target = env && compatibilityTarget(env)
    if (!target || compat.busy) return
    resetCompatibility()
    const request = compat.request
    compat.busy = true
    el.compat.hidden = false
    el.compatIssues.hidden = true
    el.compatStatus.textContent = t('正在检查配置「{profile}」里装好的插件…', { profile: target.profile })
    renderView()
    try {
      const result = await post('/api/plugins/check-compatibility', { version: target.version, profile: target.profile }, { launchId: '', home: target.home })
      if (request === compat.request) paintCompatibilityResult(el.compat, el.compatStatus, el.compatIssues, result, target.version)
    } catch (error) {
      if (request !== compat.request) return
      el.compat.classList.add('is-incompatible')
      el.compatStatus.textContent = t('兼容性检查未完成') + ': ' + t(error.message)
    } finally {
      if (request === compat.request) {
        compat.busy = false
        renderView()
      }
    }
  }

  const exactVersionSpec = (spec) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(spec || '').trim())
  const ICON_TONES = ['blue', 'indigo', 'cyan', 'purple', 'emerald', 'amber', 'pink']

  function toneForPluginName(name) {
    let hash = 0
    for (const ch of String(name || '')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0
    return ICON_TONES[hash % ICON_TONES.length]
  }

  function pluginVisualMeta(name) {
    if (typeof marketState !== 'undefined') {
      const desktop = marketState.desktopEnhance?.find((item) => item.name === name)
      if (desktop) {
        return {
          icon: desktop.icon || 'lucide-package',
          tone: desktop.tone || toneForPluginName(name),
          title: desktop.title || '',
        }
      }
      const curated = marketState.curated?.find((item) => item.name === name)
      if (curated) {
        const group = marketState.curatedCategories?.find((cat) => cat.id === curated.category)
        return {
          icon: curated.icon || group?.icon || 'lucide-package',
          tone: group?.tone || toneForPluginName(name),
          title: curated.title || '',
        }
      }
    }
    return { icon: 'lucide-package', tone: toneForPluginName(name), title: '' }
  }

  const isAvatarIconUrl = (value) => /^https:\/\/(?:avatars\.githubusercontent\.com|github\.com)\//i.test(String(value || '').trim())

  function renderPluginIconHtml({ realIcon = '', fallbackIcon = 'lucide-package', tone = 'blue' } = {}) {
    const cleanFallback = typeof fallbackIcon === 'string' && fallbackIcon.startsWith('lucide-') ? fallbackIcon : 'lucide-package'
    const cleanTone = ICON_TONES.includes(tone) ? tone : 'blue'
    if (realIcon) {
      const avatarClass = isAvatarIconUrl(realIcon) ? ' has-avatar' : ''
      return `<div class="plugin-market-icon has-image${avatarClass}"><img src="${escapeHtml(realIcon)}" alt="" loading="lazy" referrerPolicy="no-referrer" data-fallback-icon="${escapeHtml(cleanFallback)}" data-fallback-tone="${escapeHtml(cleanTone)}" /></div>`
    }
    return `<div class="plugin-market-icon tone-${escapeHtml(cleanTone)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${escapeHtml(cleanFallback)}"/></svg></div>`
  }

  // 图片真实图标加载失败（断链或离线）时，无缝退回对应色调的矢量图标
  function handleIconImageError(event) {
    const img = event.target
    if (!img || img.tagName !== 'IMG') return
    const box = img.parentElement
    if (!box?.classList?.contains('plugin-market-icon')) return
    const iconId = img.dataset?.fallbackIcon || 'lucide-package'
    const tone = ICON_TONES.includes(img.dataset?.fallbackTone) ? img.dataset.fallbackTone : 'blue'
    box.classList.remove('has-image', 'has-avatar')
    box.classList.add(`tone-${tone}`)
    box.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${escapeHtml(iconId)}"/></svg>`
  }
  el.plugins?.addEventListener?.('error', handleIconImageError, true)
  el.addMarket?.addEventListener?.('error', handleIconImageError, true)

  function pluginRow(plugin, envId = openedId) {
    const disabled = !plugin.official && plugin.enabled === false
    const upgradable = plugin.upgradable ?? (!plugin.official && !plugin.local && exactVersionSpec(plugin.spec))
    const updateInfo = (typeof pluginUpdates !== 'undefined' && envId ? pluginUpdates[envId]?.[plugin.name] : null) || null
    const hasUpdate = Boolean(upgradable && updateInfo?.available && updateInfo.latest)
    const visual = typeof pluginVisualMeta === 'function' ? pluginVisualMeta(plugin.name) : { icon: 'lucide-package', tone: 'blue' }
    const realIcon = plugin.icon || (typeof marketState !== 'undefined' ? marketState.marketIcons?.[plugin.name] : '') || ''
    const iconHtml = typeof renderPluginIconHtml === 'function'
      ? renderPluginIconHtml({ realIcon, fallbackIcon: visual.icon, tone: visual.tone })
      : `<div class="plugin-market-icon tone-blue">${realIcon ? `<img src="${escapeHtml(realIcon)}" alt="" loading="lazy" referrerPolicy="no-referrer" />` : '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-package"/></svg>'}</div>`
    const versionBadge = !plugin.local && plugin.spec
      ? `<span class="plugin-version plugin-market-sub">${escapeHtml(plugin.spec)}</span>`
      : ''
    const tags = [
      plugin.official ? t('官方组件') : '',
      plugin.local ? t('本地路径') : '',
      plugin.offline ? t('离线文件') : '',
      plugin.origin === LOCAL_ORIGIN ? t('本地改动') : '',
      plugin.bundle ? '' : t('不挂载'),
      disabled ? t('已禁用') : '',
    ].filter(Boolean)
    const updateButton = hasUpdate ? `<button class="plugin-update" type="button" data-upgrade-plugin="${escapeHtml(plugin.name)}" aria-label="${escapeHtml(`${plugin.name} ${t('更新到 {latest}', { latest: updateInfo.latest })}`)}" ${busy ? 'disabled' : ''}><span class="update-label">${escapeHtml(t('更新到 {latest}', { latest: updateInfo.latest }))}</span></button>` : ''
    const subMeta = `${versionBadge}${updateButton}${tags.map((tag) => `<span class="plugin-status plugin-market-tag${tag === t('官方组件') ? ' is-official' : ''}">${escapeHtml(tag)}</span>`).join('')}`
    // 双列卡片排版：上区放图标、名称/版本标签与开关/移除，下区展示插件简介，有更新时把升级胶囊并入版本行
    return `<div class="plugin-item"><div class="toggle plugin-row pack-row plugin-market-card plugin-installed-card${disabled ? ' off' : ''}" title="${escapeHtml(`${plugin.name}${plugin.description ? `\n${plugin.description}` : ''}`)}">
      <div class="plugin-installed-head">
        ${iconHtml}
        <div class="plugin-market-meta">
          <div class="plugin-market-name"><span class="plugin-name">${escapeHtml(plugin.name)}</span></div>
          ${subMeta ? `<div class="plugin-installed-sub">${subMeta}</div>` : ''}
        </div>
        <div class="plugin-installed-actions">
          ${plugin.official ? '' : `<input type="checkbox" data-toggle-plugin="${escapeHtml(plugin.name)}" ${disabled ? '' : 'checked'} ${busy ? 'disabled' : ''} aria-label="${escapeHtml(t(disabled ? '启用 {name}' : '禁用 {name}', { name: plugin.name }))}" />`}
          ${plugin.official ? '' : `<button class="ghost icon-btn" type="button" data-remove-plugin="${escapeHtml(plugin.name)}" title="${escapeHtml(t('移除'))}" aria-label="${escapeHtml(t('移除'))}" ${busy ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-trash-2"/></svg></button>`}
        </div>
      </div>
      ${plugin.description ? `<div class="plugin-desc plugin-market-desc plugin-installed-desc">${escapeHtml(plugin.description)}</div>` : ''}
    </div></div>`
  }

  /** 跟随上游那一行：有新版本、已是最新、检查失败、还没检查；顶上的「更新实例」只给跟随上游的实例。 */
  function paintUpstream(env) {
    el.upstream.hidden = el.applyUpdate.hidden = !env.following
    if (!env.following) return
    const update = updates[env.id]
    const current = releaseLabel(env.source)
    el.upstreamText.textContent = checking && !update
      ? t('正在检查上游 {repo}…', { repo: env.source.repo })
      : update?.error
        ? t('检查上游 {repo} 失败：{error}', { repo: env.source.repo, error: update.error })
        : update?.available
          ? t('上游 {repo} 有新版本 {version}（现在是 {current}）', { repo: env.source.repo, version: releaseLabel(update.latest), current: current || t('未知') })
          : update ? t('已是上游 {repo} 的最新版本 {current}', { repo: env.source.repo, current }) : t('跟随上游 {repo}', { repo: env.source.repo })
    // 没有新版本也能点：更新框会直接说「上游没有比现在更新的版本」，不用先等检查结果
    const title = update?.available ? t('更新实例（有新版本 {version}）', { version: releaseLabel(update.latest) }) : t('更新实例')
    el.applyUpdate.title = title
    el.applyUpdate.setAttribute('aria-label', title)
    el.applyUpdate.classList.toggle('has-update', Boolean(update?.available))
    el.applyUpdate.disabled = busy
  }

  /** 备份文件名（时间戳，冒号和点换成了 -）→ 本地时间。 */
  function historyTime(name) {
    const iso = String(name).replace(/\.json$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
    const date = new Date(iso)
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : name
  }

  function paintHistory(env) {
    el.historyRow.hidden = !env.history.length
    if (!env.history.length) return
    if (el.history.dataset.environment !== env.id || el.history.options.length !== env.history.length) {
      el.history.dataset.environment = env.id
      el.history.innerHTML = env.history.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(t('{time} 之前的那份', { time: historyTime(name) }))}</option>`).join('')
    }
    el.history.disabled = el.restore.disabled = busy
    syncUiSelect(el.history)
  }

  function renderView() {
    const env = opened()
    el.top && (el.top.hidden = Boolean(env))
    el.overview.hidden = Boolean(env)
    el.view.hidden = !env
    const popupClose = byId('launchPluginsClose')
    const popupDialog = byId('launchPluginsDialog')
    // 加载态时 #launchPluginsHost 处于隐藏状态：保持关闭按钮留在外层头部，防止加载瞬间右上角“×”跟着消失
    if (popupClose && popupDialog && !popupDialog.hidden && !byId('launchPluginsCard')?.classList?.contains?.('is-loading') && popupDialog.contains?.(el.view)) {
      const topBar = el.view.querySelector?.('.pack-detail-top')
      if (topBar && popupClose.parentElement !== topBar) topBar.append?.(popupClose)
    }
    el.checkUpdates.disabled = busy || checking
    // 检查更新只剩一个图标：查的时候让它转起来，不然点了看不出有没有在查
    el.checkUpdates.classList.toggle('is-checking', checking)
    el.createSave.disabled = busy
    if (!env) {
      globalThis.syncEnvLaunchConfig?.(null)
      globalThis.syncEnvironmentToolTab?.('plugins', null, 'installed')
      return
    }
    paintUpstream(env)
    paintHistory(env)
    el.detailName.textContent = env.name
    el.detailSub.textContent = t('DSH {version} · {count} 个插件', { version: versionText(env), count: thirdParty(env).length })
    // 正在输入时别把用户敲了一半的名字冲掉：只在切换环境或刚保存后重填表单
    paintVersionOptions(env)
    if (el.editForm.dataset.environment !== env.id) {
      el.editForm.dataset.environment = env.id
      el.name.value = env.name
      el.version.value = env.dshVersion
      el.channel.value = String(Math.max(0, UPDATE_CHANNELS.indexOf(env.updateChannel)))
      resetCompatibility()
      if (typeof paintEnvSaveStatus === 'function') paintEnvSaveStatus('idle')
    }
    paintChannelSwitch(el.channel, el.channelName)
    if (el.installedCount) el.installedCount.textContent = String(env.plugins.length)
    el.plugins.innerHTML = env.plugins.map((plugin) => pluginRow(plugin, env.id)).join('') || `<div class="plugin-empty">${escapeHtml(t('这个实例还没有插件。'))}</div>`
    const hasPluginUpdate = (plugin) => {
      const upgradable = plugin.upgradable ?? (!plugin.official && !plugin.local && typeof exactVersionSpec === 'function' && exactVersionSpec(plugin.spec))
      const updateInfo = (typeof pluginUpdates !== 'undefined' && env.id ? pluginUpdates[env.id]?.[plugin.name] : null) || null
      return Boolean(upgradable && updateInfo?.available && updateInfo.latest)
    }
    const updatableCount = env.plugins.filter(hasPluginUpdate).length
    if (el.upgrade) {
      el.upgrade.hidden = updatableCount === 0
      el.upgrade.disabled = busy
      el.upgrade.classList?.toggle('is-update', updatableCount > 0)
    }
    el.plugins.querySelectorAll('[data-upgrade-plugin]').forEach((button) => {
      button.onclick = () => {
        const name = button.dataset.upgradePlugin
        void run(() => post('/api/environments/plugins/upgrade', { id: env.id, name }), {
          after: (result) => {
            if (typeof pluginUpdates !== 'undefined' && pluginUpdates[env.id]) {
              for (const item of result?.upgraded || []) {
                pluginUpdates[env.id][item.name] = { current: item.to, latest: item.to, available: false }
              }
              if (!(result?.upgraded?.length) && !(result?.failed?.length) && pluginUpdates[env.id][name]) {
                pluginUpdates[env.id][name] = { ...pluginUpdates[env.id][name], available: false }
              }
            }
            const failed = (result?.failed || []).map((item) => `${item.name}：${item.error}`).join('\n')
            if (failed) notify('', t('升级结果'), failed)
          },
        })
      }
    })
    el.plugins.querySelectorAll('input[data-toggle-plugin]').forEach((input) => {
      input.onchange = () => run(() => post('/api/environments/plugins/toggle', {
        id: env.id,
        name: input.dataset.togglePlugin,
        enabled: input.checked,
      }))
    })
    el.plugins.querySelectorAll('[data-remove-plugin]').forEach((button) => {
      button.onclick = () => run(() => post('/api/environments/plugins/remove', { id: env.id, name: button.dataset.removePlugin }))
    })
    const users = env.usedBy.map((entry) => entry.name).join('、')
    const written = env.applied.map((item) => item.profile).join('、')
    el.usage.textContent = [
      users ? t('在用的启动项：{names}', { names: users }) : t('还没有启动项用这个实例。'),
      written ? t('现在装在配置：{names}。', { names: written }) : '',
      env.following ? t('跟随上游 {repo}：这里的改动记成本地改动，上游更新后会重放。', { repo: env.source.repo }) : '',
      t('改动在下次用这个实例启动时生效。'),
    ].filter(Boolean).join(' ')
    for (const control of [el.exportButton, el.duplicate, el.name, el.version, el.spec, el.addSubmit, el.addOpen]) {
      if (control) control.disabled = busy
    }
    // 版本类型只对「自动最新版本」有意义；钉了具体版本时它不影响选哪个版本
    el.channel.disabled = busy || el.version.value !== AUTO_VERSION
    syncUiSelect(el.version)
    const target = compatibilityTarget(env)
    el.checkCompatibility.disabled = busy || compat.busy || !target
    el.checkCompatibility.setAttribute('aria-busy', String(compat.busy))
    const checkTitle = !env.applied.length ? t('还没有配置装过这个实例：用它启动一次后才能检查兼容性')
      : target ? t('检查兼容性（查配置「{profile}」里装好的插件）', { profile: target.profile }) : t('检查兼容性')
    el.checkCompatibility.title = checkTitle
    el.checkCompatibility.setAttribute('aria-label', checkTitle)
    if (el.checkPluginUpdates) {
      const checkingNow = typeof checkingPlugins !== 'undefined' && checkingPlugins
      el.checkPluginUpdates.disabled = busy || checkingNow
      el.checkPluginUpdates.classList.toggle('is-checking', checkingNow)
      el.checkPluginUpdates.setAttribute('aria-busy', String(checkingNow))
    }
    el.remove.disabled = busy || env.usedBy.length > 0
    // 图标按钮没字：不能删时说为什么，能删时就是它的名字
    el.remove.title = env.usedBy.length ? t('还有启动项在用，先给它们换一个实例') : t('删除实例')
    if (el.backups) el.backups.disabled = busy
    const tab = typeof activeTab === 'string' ? activeTab : 'plugins'
    const subTab = typeof pluginSubTab === 'string' ? pluginSubTab : 'installed'
    if (el.tabs?.dataset) {
      el.tabs.dataset.active = tab
      el.tabs.querySelectorAll?.('[data-env-tab]')?.forEach((button) => {
        button.setAttribute('aria-selected', String(button.dataset.envTab === tab))
        button.disabled = busy
      })
    }
    if (el.pluginSubtabs) {
      el.pluginSubtabs.querySelectorAll?.('[data-plugin-subtab]')?.forEach((button) => {
        const active = button.dataset.pluginSubtab === subTab
        button.classList?.toggle('is-active', active)
        button.setAttribute('aria-selected', String(active))
        button.disabled = busy
      })
      globalThis.syncSubtabPill?.(el.pluginSubtabs)
      if (tab === 'plugins') {
        globalThis.requestAnimationFrame?.(() => globalThis.syncSubtabPill?.(el.pluginSubtabs))
      }
    }
    const isMarketView = subTab === 'curated' || subTab === 'market'
    if (el.pluginsBox) el.pluginsBox.hidden = tab !== 'plugins'
    if (el.installedPane) el.installedPane.hidden = subTab !== 'installed'
    if (el.marketPane) el.marketPane.hidden = !isMarketView
    if (el.marketTools) el.marketTools.hidden = !isMarketView
    if (el.mcpHost) el.mcpHost.hidden = tab !== 'mcp'
    if (el.skillsHost) el.skillsHost.hidden = tab !== 'skills'
    if (el.configBox) el.configBox.hidden = tab !== 'config'
    if (tab === 'plugins' && isMarketView && typeof paintMarket === 'function') paintMarket(env)
    if (tab === 'config') globalThis.syncEnvLaunchConfig?.(env)
    globalThis.syncEnvironmentToolTab?.(tab, env, subTab)
  }

  /**
   * 分类芯片一行横滑、滚动条藏起来了；两头还有没露出来的芯片时给对应一侧加渐隐，
   * 否则被裁成「Identity & C…」的半个芯片看起来像排版坏了，也看不出还能往右滑。
   */
  function syncCategoryFade() {
    const row = el.addCategories
    if (!row?.classList) return
    const max = (row.scrollWidth || 0) - (row.clientWidth || 0)
    row.classList.toggle('fade-start', max > 1 && row.scrollLeft > 1)
    row.classList.toggle('fade-end', max > 1 && row.scrollLeft < max - 1)
  }

  function paint() {
    renderGrid()
    renderView()
  }

  /** 拿一次最新列表：环境页和启动项编辑框共用；导出框的默认版本号同步给主脚本。 */
  async function fetchEnvironments() {
    const data = await getJson('/api/environments')
    environments = data.environments || []
    builtin = data.builtin || []
    nameMax = data.limits?.nameMax || nameMax
    if (nameMax) el.newName.maxLength = el.name.maxLength = nameMax
    if (typeof environmentState !== 'undefined') environmentState.list = environments
    environmentState.defaults = data.defaults || {}
  }

  /** 问服务端跟随上游的环境有没有新版本（只提示，不自动应用）。force：「检查更新」按钮，跳过 10 分钟缓存。 */
  async function checkUpdates({ force = false } = {}) {
    if (checking || !environments.some((env) => env.following)) return
    checking = true
    paint()
    try {
      updates = (await post('/api/environments/updates', { force })).updates || {}
    } catch (error) {
      if (force) notify(error.message, t('检查更新失败'))
    } finally {
      checking = false
      paint()
    }
  }

  async function load() {
    try {
      await fetchEnvironments()
      // 刚导入完或从主页点管理跳过来的：直接打开对应实例
      if (environmentState.pendingOpen) {
        const pending = environmentState.pendingOpen
        environmentState.pendingOpen = ''
        activeTab = 'plugins'
        pluginSubTab = 'installed'
        if (typeof pending === 'string') {
          openedId = pending
        } else if (pending && typeof pending === 'object') {
          const normHome = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
          const wantHome = normHome(pending.home || state.dshHome || '')
          const found = environments.find((env) => env.targetProfile === pending.profile && normHome(env.targetHome || state.dshHome || '') === wantHome)
            || environments.find((env) => env.targetProfile === pending.profile)
            || environments[0]
          openedId = found?.id || ''
        }
        el.editForm.dataset.environment = ''
      }
      if (openedId && !opened()) openedId = ''
      paint()
      if (openedId && !pluginUpdates[openedId]) void checkPluginUpdates({ silent: true, targetId: openedId })
      if (openedId && !marketState.loadedOnce && el.addMarket) void loadPluginMarket({ silent: true })
    } catch (error) {
      el.hint.textContent = error.message
    }
  }

  /** 一次只做一件事：按钮在请求期间全部禁用，结束后按服务端返回的最新列表重画。 */
  async function run(action, { after, onError = (error) => notify(error.message) } = {}) {
    if (busy) return
    busy = true
    if (typeof environmentState !== 'undefined') environmentState.busy = true
    renderView()
    try {
      const result = await action()
      after?.(result)
    } catch (error) {
      onError(error)
    } finally {
      busy = false
      if (typeof environmentState !== 'undefined') environmentState.busy = false
      await load()
    }
  }

  function open(id) {
    openedId = id
    activeTab = 'plugins'
    pluginSubTab = 'installed'
    el.editForm.dataset.environment = ''
    renderView()
    if (openedId && !pluginUpdates[openedId]) void checkPluginUpdates({ silent: true, targetId: openedId })
    if (openedId && !marketState.loadedOnce && el.addMarket) void loadPluginMarket({ silent: true })
    byId('pane-environments')?.scrollTo({ top: 0 })
  }

  // 和页面上其他下拉一样换成自绘菜单（原生 select 仍存值、仍触发 change）
  for (const select of [el.version, el.history, byId('launchEnvironment')]) createUiSelect(select)
  el.back.onclick = () => { void flushEnvAutoSave(); openedId = ''; activeTab = 'plugins'; pluginSubTab = 'installed'; paint() }
  el.importButton.onclick = () => openImportDialog()
  el.exportButton.onclick = () => exportEnvironment(opened())
  if (el.backups) {
    el.backups.onclick = () => {
      const env = opened()
      globalThis.openProfileBackupsForInstance?.(env?.targetProfile || 'web', env?.targetHome || '', env?.name || '')
    }
  }
  el.tabs?.querySelectorAll?.('[data-env-tab]')?.forEach((button) => {
    button.onclick = () => {
      const next = button.dataset.envTab || 'plugins'
      if (next === activeTab) return
      if (activeTab === 'config') void flushEnvAutoSave()
      activeTab = next
      renderView()
    }
  })
  el.pluginSubtabs?.querySelectorAll?.('[data-plugin-subtab]')?.forEach((button) => {
    button.onclick = () => {
      const next = button.dataset.pluginSubtab || 'installed'
      if (next === pluginSubTab) return
      pluginSubTab = next
      if (next === 'curated' || next === 'market') {
        marketState.category = next === 'market' ? 'market-index' : 'curated'
        marketState.animate = true
        if (el.addMarket) el.addMarket.scrollTop = 0
        if (el.addError) el.addError.hidden = true
      }
      renderView()
      globalThis.animateSubPane?.(next === 'installed' ? el.installedPane : el.marketPane)
      if (next === 'curated' || next === 'market') {
        if (!marketState.loadedOnce) void loadPluginMarket()
        else if (next === 'market' && !marketState.indexLoaded && !marketState.indexLoading) void loadMarketIndex()
      }
    }
  })
  // 改版本 / 版本类型：上一次的兼容性结果是按旧版本查的，作废；同时自动落盘配置
  el.version.onchange = () => {
    resetCompatibility()
    renderView()
    void flushEnvAutoSave()
  }
  el.channel.oninput = () => {
    resetCompatibility()
    renderView()
    scheduleEnvAutoSave(180)
  }
  el.channel.onchange = () => {
    void flushEnvAutoSave()
  }
  el.manageVersions.onclick = () => openVersionManager()
  el.checkCompatibility.onclick = () => { void checkCompatibility() }
  async function checkPluginUpdates({ silent = false, targetId = '' } = {}) {
    const env = targetId ? environments.find((item) => item.id === targetId) : opened()
    if (!env || (!silent && (busy || checkingPlugins))) return
    const hasUpgradable = env.plugins.some((plugin) => (plugin.upgradable ?? (!plugin.official && !plugin.local && exactVersionSpec(plugin.spec))))
    if (!hasUpgradable) {
      pluginUpdates[env.id] = {}
      if (!silent) notify(t('都已经是最新版本'), t('检查更新'))
      else if (openedId === env.id) renderView()
      return
    }
    if (!silent) {
      checkingPlugins = true
      renderView()
    }
    try {
      const result = await post('/api/environments/plugins/updates', { id: env.id })
      pluginUpdates[env.id] = result?.updates || {}
      const count = Object.values(pluginUpdates[env.id]).filter((item) => item?.available).length
      const failed = (result?.failed || []).map((item) => `${item.name}：${item.error}`).join('\n')
      if (!silent) {
        if (!count && !failed) notify(t('都已经是最新版本'), t('检查更新'))
        else if (failed) notify('', t('检查更新失败'), failed)
      }
    } catch (error) {
      if (!silent) notify(error.message, t('检查更新失败'))
    } finally {
      if (!silent) checkingPlugins = false
      if (openedId === env.id || !silent) renderView()
    }
  }
  if (el.checkPluginUpdates) el.checkPluginUpdates.onclick = () => { void checkPluginUpdates() }
  if (el.upgrade) {
    el.upgrade.onclick = () => {
      const env = opened()
      if (!env) return
      void run(() => post('/api/environments/plugins/upgrade', { id: env.id }), {
        after: (result) => {
          if (pluginUpdates[env.id]) {
            for (const item of result?.upgraded || []) {
              pluginUpdates[env.id][item.name] = { current: item.to, latest: item.to, available: false }
            }
          }
          const failed = (result?.failed || []).map((item) => `${item.name}：${item.error}`).join('\n')
          if (failed) notify('', t('升级结果'), failed)
        },
      })
    }
  }
  function openAddDialog() {
    if (!opened() || !el.addDialog) return
    if (el.spec) el.spec.value = ''
    if (el.addDialogError) el.addDialogError.hidden = true
    if (typeof showPackDialog === 'function') showPackDialog(el.addDialog, el.spec)
    else {
      el.addDialog.hidden = false
      el.spec?.focus?.()
    }
  }
  function closeAddDialog(force = false) {
    if (!el.addDialog || (!force && busy)) return
    if (typeof hidePackDialog === 'function') void hidePackDialog(el.addDialog)
    else el.addDialog.hidden = true
  }
  if (el.addDialog && typeof trapPackDialog === 'function') trapPackDialog(el.addDialog, () => closeAddDialog(false))
  if (el.addOpen) el.addOpen.onclick = openAddDialog
  if (el.addCancel) el.addCancel.onclick = () => closeAddDialog(false)
  if (el.addClose) el.addClose.onclick = () => closeAddDialog(false)

  function openCreateDialog() {
    // 每次打开都是空白的一张：上一次没建成的名字和报错不带过来
    el.newName.value = ''
    el.createError.hidden = true
    showPackDialog(el.createDialog, el.newName)
  }
  /** 取消 / 关闭 / Esc：请求还在路上时不关，失败原因要留在框里给人看。 */
  function closeCreateDialog() {
    if (!busy) void hidePackDialog(el.createDialog)
  }
  trapPackDialog(el.createDialog, closeCreateDialog)
  el.create.onclick = openCreateDialog
  el.createCancel.onclick = el.createClose.onclick = closeCreateDialog
  el.createForm.onsubmit = (event) => {
    event.preventDefault()
    const name = el.newName.value.trim()
    if (!name) { el.newName.focus(); return }
    el.createError.hidden = true
    // 重名、名字太长这类错误跟着输入框走，不弹全局通知：人还在框里，改完直接再点创建
    void run(() => post('/api/environments/create', { name }), {
      after: (result) => { openedId = result.environment.id; void hidePackDialog(el.createDialog) },
      onError: (error) => { el.createError.textContent = error.message; el.createError.hidden = false; el.newName.focus() },
    })
  }
  el.editForm.onsubmit = (event) => {
    event.preventDefault()
    void flushEnvAutoSave({ force: true })
  }
  const envAutoSave = { timer: null, inFlight: null, queued: false, forceQueued: false }
  function paintEnvSaveStatus(kind = 'idle', detail = '') {
    const badge = el.saveStatus || byId('environmentSaveStatus')
    if (!badge) return
    if (kind === 'error') {
      badge.textContent = detail || t('保存失败：{error}', { error: '' })
      badge.hidden = false
    } else {
      badge.textContent = ''
      badge.hidden = true
    }
  }
  function scheduleEnvAutoSave(delay = 500) {
    if (envAutoSave.timer && typeof clearTimeout === 'function') {
      clearTimeout(envAutoSave.timer)
      envAutoSave.timer = null
    }
    const env = opened()
    if (!env) return
    if (typeof setTimeout === 'function') {
      envAutoSave.timer = setTimeout(() => {
        envAutoSave.timer = null
        void saveEnvironmentConfigNow()
      }, delay)
    } else {
      void saveEnvironmentConfigNow()
    }
  }
  async function flushEnvAutoSave({ force = false } = {}) {
    if (envAutoSave.timer && typeof clearTimeout === 'function') {
      clearTimeout(envAutoSave.timer)
      envAutoSave.timer = null
    }
    if (envAutoSave.inFlight) {
      envAutoSave.queued = true
      if (force) envAutoSave.forceQueued = true
      return envAutoSave.inFlight
    }
    return saveEnvironmentConfigNow({ force })
  }
  async function saveEnvironmentConfigNow({ force = false } = {}) {
    if (envAutoSave.inFlight) {
      envAutoSave.queued = true
      if (force) envAutoSave.forceQueued = true
      return envAutoSave.inFlight
    }
    const env = opened()
    if (!env || busy) return
    const nextName = String(el.name.value ?? '').trim()
    if (!nextName) {
      paintEnvSaveStatus('error', t('实例名称不能为空'))
      return
    }
    const nextVersion = el.version.value || env.dshVersion
    const nextChannel = switchChannel(el.channel)
    if (!force && nextName === env.name && nextVersion === env.dshVersion && nextChannel === env.updateChannel) {
      paintEnvSaveStatus('idle')
      return
    }
    paintEnvSaveStatus('saving')
    const runSave = (async () => {
      try {
        const res = await post('/api/environments/update', {
          id: env.id,
          name: nextName,
          dshVersion: nextVersion,
          updateChannel: nextChannel,
        })
        const savedEnv = res?.environment
        if (savedEnv && typeof environments !== 'undefined' && Array.isArray(environments)) {
          environments = environments.map((item) => (item.id === savedEnv.id ? savedEnv : item))
          if (typeof environmentState !== 'undefined') environmentState.list = environments
          const stillSameEnv = opened()?.id === savedEnv.id
          if (stillSameEnv) {
            el.detailName.textContent = savedEnv.name
            el.detailSub.textContent = t('DSH {version} · {count} 个插件', { version: versionText(savedEnv), count: thirdParty(savedEnv).length })
            const inputsMatchSaved = String(el.name.value ?? '').trim() === savedEnv.name
              && el.version.value === savedEnv.dshVersion
              && switchChannel(el.channel) === savedEnv.updateChannel
            if (inputsMatchSaved) {
              el.name.value = savedEnv.name
              el.editForm.dataset.environment = ''
            }
          }
          if (typeof renderGrid === 'function') renderGrid()
          if (stillSameEnv) {
            paintUpstream(savedEnv)
            paintHistory(savedEnv)
            if (typeof paintVersionOptions === 'function') paintVersionOptions(savedEnv)
            paintChannelSwitch(el.channel, el.channelName)
            el.channel.disabled = busy || el.version.value !== AUTO_VERSION
            syncUiSelect(el.version)
            const users = (savedEnv.usedBy || []).map((entry) => entry.name).join('、')
            const written = (savedEnv.applied || []).map((item) => item.profile).join('、')
            el.usage.textContent = [
              users ? t('在用的启动项：{names}', { names: users }) : t('还没有启动项用这个实例。'),
              written ? t('现在装在配置：{names}。', { names: written }) : '',
              savedEnv.following ? t('跟随上游 {repo}：这里的改动记成本地改动，上游更新后会重放。', { repo: savedEnv.source.repo }) : '',
              t('改动在下次用这个实例启动时生效。'),
            ].filter(Boolean).join(' ')
          }
          globalThis.onEnvironmentConfigSaved?.(savedEnv)
        } else {
          el.editForm.dataset.environment = ''
          await load()
        }
        paintEnvSaveStatus('saved')
      } catch (error) {
        paintEnvSaveStatus('error', t('保存失败：{error}', { error: error.message }))
      } finally {
        envAutoSave.inFlight = null
        if (envAutoSave.queued) {
          const queuedForce = envAutoSave.forceQueued
          envAutoSave.queued = false
          envAutoSave.forceQueued = false
          void saveEnvironmentConfigNow({ force: queuedForce })
        }
      }
    })()
    envAutoSave.inFlight = runSave
    return runSave
  }
  el.name.oninput = () => scheduleEnvAutoSave(500)
  el.name.onblur = () => { void flushEnvAutoSave() }
  el.name.onchange = () => { void flushEnvAutoSave() }
  const DEFAULT_DESKTOP_ENHANCE = [
    { name: 'dsh-x-desktop-notify', spec: '0.1.1', installSpec: 'dsh-x-desktop-notify@0.1.1', title: '原生通知', description: '调用系统原生通知', icon: 'lucide-info', tone: 'blue', officialTag: true },
    { name: 'dsh-x-sidebar-browser', spec: '0.1.1', installSpec: 'dsh-x-sidebar-browser@0.1.1', title: '侧栏浏览器', description: '让智能体查看并操作侧栏网页', icon: 'lucide-globe', tone: 'cyan', officialTag: true },
    { name: 'dsh-x-computer-use', spec: '0.1.0', installSpec: 'dsh-x-computer-use@0.1.0', title: '电脑操作', description: '让智能体查看并操作桌面应用', icon: 'lucide-app-window', tone: 'purple', officialTag: true },
  ]
  const marketState = {
    category: 'curated',
    q: '',
    loading: false,
    loadedOnce: false,
    installingSpec: '',
    animate: false,
    curatedError: '',
    desktopEnhance: DEFAULT_DESKTOP_ENHANCE,
    curatedCategories: [],
    curated: [],
    sources: [],
    activeUrl: '',
    indexLoading: false,
    indexLoaded: false,
    indexError: '',
    indexCategory: 'all',
    indexCategories: [],
    indexEntries: [],
    indexTotal: 0,
    indexNextOffset: null,
    marketIcons: {},
    seq: 0,
    indexSeq: 0,
    searchTimer: 0,
  }
  function installedPluginMap(env) {
    const map = new Map()
    for (const item of Array.isArray(env?.plugins) ? env.plugins : []) {
      map.set(item.name, item)
    }
    const bundle = map.get('dsh-x-desktop-bundle')
    if (bundle) {
      for (const item of DEFAULT_DESKTOP_ENHANCE) {
        if (!map.has(item.name)) map.set(item.name, { name: item.name, enabled: bundle.enabled, official: false })
      }
    }
    return map
  }
  function marketCardHtml(item, installedMap, { localizeDesktop = false, tone = '', index = 0 } = {}) {
    const name = String(item.name || '')
    // 精选清单带了英文字段（titleEn / descriptionEn）就在英文界面用它，没带才退回中文原文
    const english = document.documentElement.lang === 'en'
    const title = localizeDesktop ? t(item.title || name) : ((english && item.titleEn) || item.title || name)
    const desc = localizeDesktop ? t(item.description || '') : ((english && item.descriptionEn) || item.description || '')
    const existing = installedMap.get(name)
    const realIcon = (typeof item.icon === 'string' && !item.icon.startsWith('lucide-') ? item.icon : '')
      || marketState.marketIcons[name]
      || ''
    const fallbackIcon = (typeof item.icon === 'string' && item.icon.startsWith('lucide-') ? item.icon : '')
      || pluginVisualMeta(name).icon
      || 'lucide-package'
    const iconHtml = renderPluginIconHtml({
      realIcon,
      fallbackIcon,
      tone: tone || item.tone || toneForPluginName(name),
    })
    const badge = item.officialTag
      ? `<span class="plugin-market-tag is-official">${escapeHtml(t('官方'))}</span>`
      : item.stars === 5
        ? `<span class="plugin-market-tag is-star">${escapeHtml(t('推荐'))}</span>`
        : item.sourceTag
          ? `<span class="plugin-market-tag">${escapeHtml(item.sourceTag)}</span>`
          : ''
    const version = item.version || item.spec || ''
    const subText = item.officialTag || item.stars ? '' : (version ? `v${version}` : (item.author || ''))
    const installSpec = String(item.installSpec || (version ? `${name}@${version}` : name))
    const isInstalling = busy && marketState.installingSpec === installSpec
    // 市场页签聚焦浏览与安装：已装插件展示状态标识，开关/卸载在「已安装」子页签操作。
    const rightControl = existing
      ? `<span class="plugin-market-installed"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg><span>${escapeHtml(t('已安装'))}</span></span>`
      : `<button class="ghost plugin-market-install${isInstalling ? ' is-installing' : ''}" type="button" data-market-install="${escapeHtml(installSpec)}" ${busy ? 'disabled' : ''}>${escapeHtml(t(isInstalling ? '安装中…' : '安装'))}</button>`
    const delayIdx = Math.min(index, 12)
    return `<div class="plugin-market-card${existing ? ' is-installed' : ''}" style="--i:${delayIdx}" title="${escapeHtml(`${name}${desc ? `\n${desc}` : ''}`)}">${iconHtml}<div class="plugin-market-meta"><div class="plugin-market-name"><span>${escapeHtml(title)}</span>${badge}${subText ? `<span class="plugin-market-sub">${escapeHtml(subText)}</span>` : ''}</div>${desc ? `<div class="plugin-market-desc">${escapeHtml(desc)}</div>` : ''}</div>${rightControl}</div>`
  }
  function filterLocalCards(items, q, localize = false) {
    const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return items
    return items.filter((item) => {
      const hay = `${item.name}\n${item.title}\n${item.titleEn || ''}\n${localize ? t(item.title) : ''}\n${item.description}\n${item.descriptionEn || ''}\n${localize ? t(item.description) : ''}`.toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
  }
  function mergeMarketIcons(nextIcons) {
    if (!nextIcons || typeof nextIcons !== 'object') return false
    let changed = false
    for (const [name, icon] of Object.entries(nextIcons)) {
      if (!icon || marketState.marketIcons[name] === icon) continue
      marketState.marketIcons[name] = icon
      changed = true
    }
    return changed
  }
  function refreshInstalledIconsIfVisible() {
    const env = opened()
    if (!env || activeTab !== 'plugins' || pluginSubTab !== 'installed') return
    renderView()
  }
  function paintMarket(env = opened()) {
    if (!el.addMarket) return
    const cat = pluginSubTab === 'market' ? 'market-index' : 'curated'
    marketState.category = cat
    if (el.addSource) {
      const showSources = cat === 'market-index' && marketState.sources.length > 1
      el.addSource.hidden = !showSources
      if (showSources) {
        const key = marketState.sources.map((src) => `${src.url}\0${src.title}`).join('\n')
        if (el.addSource.dataset.sources !== key) {
          el.addSource.dataset.sources = key
          el.addSource.innerHTML = marketState.sources.map((src) => `<option value="${escapeHtml(src.url)}">${escapeHtml(src.title || src.url)}</option>`).join('')
        }
        el.addSource.value = marketState.activeUrl || marketState.sources[0].url
      }
    }
    const isBusyLoading = marketState.loading || (cat === 'market-index' && marketState.indexLoading)
    if (el.addRefresh) {
      el.addRefresh.disabled = busy || isBusyLoading
      el.addRefresh.classList.toggle('is-loading', isBusyLoading)
    }
    if (el.addCategories) {
      const hasIndexCats = cat === 'market-index' && marketState.indexCategories.length > 0
      const prevScrollLeft = el.addCategories.scrollLeft || 0
      el.addCategories.hidden = !hasIndexCats
      if (hasIndexCats) {
        const allBtn = `<button type="button" class="plugin-market-tab${marketState.indexCategory === 'all' ? ' is-active' : ''}" data-index-cat="all">${escapeHtml(t('全部'))}</button>`
        const subBtns = marketState.indexCategories.map((item) => `<button type="button" class="plugin-market-tab${marketState.indexCategory === item.id ? ' is-active' : ''}" data-index-cat="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join('')
        el.addCategories.innerHTML = allBtn + subBtns
        el.addCategories.scrollLeft = prevScrollLeft
        syncCategoryFade()
        // 刚从 hidden 放出来那一帧还量不到宽度，下一帧再量一次
        globalThis.requestAnimationFrame?.(syncCategoryFade)
      } else {
        el.addCategories.innerHTML = ''
      }
    }

    const installedMap = installedPluginMap(env)
    const sections = []
    let cardIdx = 0

    if (cat === 'curated' || cat === 'desktop-enhance') {
      const desktopItems = filterLocalCards(marketState.desktopEnhance, marketState.q, true)
      if (desktopItems.length) {
        sections.push(`<div><div class="plugin-market-group-title"><span>${escapeHtml(t('桌面增强'))}</span><span class="plugin-market-group-count">${desktopItems.length}</span></div><div class="plugin-market-grid">${desktopItems.map((item) => marketCardHtml(item, installedMap, { localizeDesktop: true, index: cardIdx++ })).join('')}</div></div>`)
      }
    }

    if (cat === 'curated') {
      if (marketState.curated.length) {
        const curatedMatches = filterLocalCards(marketState.curated, marketState.q)
        for (const group of marketState.curatedCategories) {
          const items = curatedMatches.filter((item) => item.category === group.id)
          if (!items.length) continue
          sections.push(`<div><div class="plugin-market-group-title"><span>${escapeHtml(t(group.zh) || group.zh)}</span><span class="plugin-market-group-count">${items.length}</span></div><div class="plugin-market-grid">${items.map((item) => marketCardHtml(item, installedMap, { tone: group.tone, index: cardIdx++ })).join('')}</div></div>`)
        }
      } else if (marketState.loading) {
        sections.push(globalThis.marketLoadingHtml
          ? globalThis.marketLoadingHtml(t('正在从 GitHub 获取精选插件…'))
          : `<div class="market-loading" role="status"><div class="market-loading-head"><span class="plugin-empty-spinner" aria-hidden="true"></span><span>${escapeHtml(t('正在从 GitHub 获取精选插件…'))}</span></div></div>`)
      } else if (marketState.curatedError) {
        sections.push(`<p class="hint profile-error">${escapeHtml(t('精选清单加载失败：{error}', { error: marketState.curatedError }))}</p>`)
      }
    }

    if (cat === 'market-index') {
      if (marketState.indexLoading && !marketState.indexEntries.length) {
        sections.push(globalThis.marketLoadingHtml
          ? globalThis.marketLoadingHtml(t('正在读取插件市场…'))
          : `<div class="market-loading" role="status"><div class="market-loading-head"><span class="plugin-empty-spinner" aria-hidden="true"></span><span>${escapeHtml(t('正在读取插件市场…'))}</span></div></div>`)
      } else if (marketState.indexError) {
        sections.push(`<p class="hint profile-error">${escapeHtml(t('索引加载失败：{error}', { error: marketState.indexError }))}</p>`)
      } else {
        const matches = filterLocalCards(marketState.indexEntries, marketState.q)
        if (matches.length) {
          sections.push(`<div class="plugin-market-grid">${matches.map((item) => marketCardHtml(item, installedMap, { index: cardIdx++ })).join('')}</div>`)
          if (marketState.indexNextOffset !== null) {
            sections.push(`<button type="button" class="ghost plugin-market-more" data-market-more="1" ${marketState.indexLoading ? 'disabled' : ''}>${escapeHtml(t('加载更多'))}</button>`)
          }
        }
      }
    }

    if (!sections.length) {
      sections.push(`<p class="hint">${escapeHtml(t('没有找到匹配的插件。'))}</p>`)
    }
    const shouldAnimate = marketState.animate
    marketState.animate = false
    el.addMarket.classList.remove('is-entering')
    el.addMarket.innerHTML = sections.join('')
    if (shouldAnimate) {
      // 重排一帧让新挂载卡片触发阶梯入场，搜索/切状态时保持静止避免闪烁。
      void el.addMarket.offsetWidth
      el.addMarket.classList.add('is-entering')
    }
  }
  async function loadMarketIndex({ refresh = false, offset = 0, append = false, silent = false } = {}) {
    if (!el.addMarket) return
    const seq = ++marketState.indexSeq
    marketState.indexLoading = true
    if (!append) marketState.indexError = ''
    if (!silent) paintMarket()
    try {
      const params = new URLSearchParams({
        limit: '120',
        offset: String(offset),
        ...(marketState.activeUrl ? { source: marketState.activeUrl } : {}),
        ...(marketState.indexCategory && marketState.indexCategory !== 'all' ? { category: marketState.indexCategory } : {}),
        ...(marketState.category === 'market-index' && marketState.q.trim() ? { q: marketState.q.trim() } : {}),
        ...(refresh ? { refresh: '1' } : {}),
      })
      const data = await getJson(`/api/plugin-market?${params}`)
      if (seq !== marketState.indexSeq) return
      if (Array.isArray(data?.sources)) marketState.sources = data.sources
      if (typeof data?.activeUrl === 'string') marketState.activeUrl = data.activeUrl
      if (Array.isArray(data?.categories)) marketState.indexCategories = data.categories
      if (Array.isArray(data?.entries)) {
        marketState.indexEntries = append ? [...marketState.indexEntries, ...data.entries] : data.entries
      }
      marketState.indexTotal = Number(data?.total) || 0
      marketState.indexNextOffset = data?.nextOffset ?? null
      const errText = data?.error || ''
      // 后台静默预取失败不污染市场错误状态，也不标记 indexLoaded，等用户切进「插件市场」时自动重试
      marketState.indexError = (silent && pluginSubTab !== 'market' && errText) ? '' : errText
      marketState.indexLoaded = !errText
      if (mergeMarketIcons(data?.marketIcons)) refreshInstalledIconsIfVisible()
    } catch (error) {
      if (seq !== marketState.indexSeq) return
      marketState.indexLoaded = false
      if (!silent || pluginSubTab === 'market') marketState.indexError = error instanceof Error ? error.message : String(error)
    } finally {
      if (seq === marketState.indexSeq) {
        marketState.indexLoading = false
        if (!silent || pluginSubTab === 'market') paintMarket()
      }
    }
  }
  async function loadPluginMarket({ refresh = false, silent = false } = {}) {
    if (!el.addMarket) return
    marketState.loadedOnce = true
    const seq = ++marketState.seq
    marketState.loading = true
    if (!silent) marketState.curatedError = ''
    if (!silent) paintMarket()
    // 精选列表走快速路径先渲染，同时异步拉取官方 DSH 市场索引拿到各插件真实图标
    const indexPromise = (refresh || !marketState.indexLoaded)
      ? loadMarketIndex({ refresh, silent: silent || pluginSubTab !== 'market' })
      : Promise.resolve()
    try {
      const params = new URLSearchParams({
        scope: 'curated',
        ...(refresh ? { refresh: '1' } : {}),
      })
      const data = await getJson(`/api/plugin-market?${params}`)
      if (seq !== marketState.seq) return
      if (Array.isArray(data?.desktopEnhance) && data.desktopEnhance.length) {
        marketState.desktopEnhance = data.desktopEnhance.map((item) => {
          const base = DEFAULT_DESKTOP_ENHANCE.find((d) => d.name === item.name)
          return {
            ...base,
            ...item,
            title: item.label || base?.title || item.name,
            description: base?.description || '',
            officialTag: true,
          }
        })
      }
      let metaChanged = false
      if (Array.isArray(data?.curatedCategories)) marketState.curatedCategories = data.curatedCategories
      if (Array.isArray(data?.curated) && data.curated.length) {
        marketState.curated = data.curated
        metaChanged = true
      }
      if (mergeMarketIcons(data?.marketIcons)) metaChanged = true
      if (metaChanged) refreshInstalledIconsIfVisible()
      marketState.curatedError = data?.curatedError || ''
    } catch (error) {
      if (seq !== marketState.seq) return
      if (!silent) marketState.curatedError = error instanceof Error ? error.message : String(error)
    } finally {
      if (seq === marketState.seq) {
        marketState.loading = false
        if (!silent || pluginSubTab === 'curated' || pluginSubTab === 'market') paintMarket()
      }
    }
    await indexPromise
  }
  function submitAddPlugin(spec, { fromMarketCard = false } = {}) {
    const env = opened()
    const clean = String(spec || '').trim()
    if (!env || !clean) { el.spec?.focus?.(); return }
    const targetError = fromMarketCard ? el.addError : (el.addDialogError || el.addError)
    if (fromMarketCard && el.addError) el.addError.hidden = true
    if (!fromMarketCard && el.addDialogError) el.addDialogError.hidden = true
    marketState.installingSpec = fromMarketCard ? clean : ''
    void run(() => post('/api/environments/plugins/add', { id: env.id, spec: clean }), {
      after: () => {
        marketState.installingSpec = ''
        if (!fromMarketCard) {
          if (el.spec) el.spec.value = ''
          pluginSubTab = 'installed'
          closeAddDialog(true)
        } else {
          paintMarket()
        }
      },
      onError: (error) => {
        marketState.installingSpec = ''
        if (fromMarketCard) paintMarket()
        if (targetError) {
          targetError.textContent = error.message
          targetError.hidden = false
          if (!fromMarketCard) el.spec?.focus?.()
        } else {
          notify(error.message)
        }
      },
    })
  }
  if (el.addRefresh) {
    el.addRefresh.onclick = () => {
      marketState.animate = true
      void loadPluginMarket({ refresh: true })
    }
  }
  if (el.addSource) {
    el.addSource.onchange = () => {
      marketState.activeUrl = el.addSource.value
      marketState.indexCategory = 'all'
      marketState.animate = true
      void loadMarketIndex({ offset: 0 })
    }
  }
  if (el.addSearch) {
    el.addSearch.oninput = () => {
      marketState.q = el.addSearch.value
      if (el.addError) el.addError.hidden = true
      paintMarket()
      if (marketState.category === 'market-index') {
        clearTimeout(marketState.searchTimer)
        marketState.searchTimer = setTimeout(() => {
          void loadMarketIndex({ offset: 0 })
        }, 180)
      }
    }
  }
  if (el.addCategories) {
    el.addCategories.onclick = (event) => {
      const indexCatBtn = event.target.closest?.('[data-index-cat]')
      if (!indexCatBtn) return
      const nextCat = indexCatBtn.dataset.indexCat || 'all'
      if (nextCat === marketState.indexCategory) return
      indexCatBtn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      marketState.indexCategory = nextCat
      marketState.animate = true
      void loadMarketIndex({ offset: 0 })
    }
    el.addCategories.addEventListener?.('scroll', syncCategoryFade, { passive: true })
    globalThis.addEventListener?.('resize', syncCategoryFade)
    el.addCategories.addEventListener?.('wheel', (event) => {
      if (!event || el.addCategories.scrollWidth <= el.addCategories.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault?.()
      el.addCategories.scrollLeft += delta
    }, { passive: false })
  }
  if (el.addMarket) {
    el.addMarket.onclick = (event) => {
      const moreBtn = event.target.closest?.('[data-market-more]')
      if (moreBtn && marketState.indexNextOffset !== null && !marketState.indexLoading) {
        void loadMarketIndex({ offset: marketState.indexNextOffset, append: true })
        return
      }
      const installBtn = event.target.closest?.('[data-market-install]')
      if (installBtn && !installBtn.disabled) {
        submitAddPlugin(installBtn.dataset.marketInstall, { fromMarketCard: true })
      }
    }
  }
  el.addForm.onsubmit = (event) => {
    event.preventDefault()
    submitAddPlugin(el.spec.value)
  }
  // 复制 / 导出 / 删除：详情页的按钮和卡片的「更多操作」都走这三个，复制完都进新实例的详情
  function duplicateEnvironment(env) {
    if (!env) return
    const name = t('{name} 副本', { name: env.name })
    void run(() => post('/api/environments/create', { name: nameMax ? name.slice(0, nameMax) : name, from: env.id }), { after: (result) => { openedId = result.environment.id } })
  }
  function exportEnvironment(env) {
    if (env) openExportDialog(env)
  }
  async function removeEnvironment(env) {
    if (!env || !(await appConfirm(t('删除实例「{name}」？实例清单和对应配置目录都会被彻底删除，不可恢复。', { name: env.name }), { title: t('删除实例') }))) return
    void run(() => post('/api/environments/remove', { id: env.id, removeProfile: true }), {
      after: () => {
        if (typeof pluginUpdates !== 'undefined') delete pluginUpdates[env.id]
        openedId = ''
        if (!byId('launchPluginsDialog')?.hidden) void globalThis.closeLaunchPlugins?.({ afterDelete: true })
      },
    })
  }
  el.duplicate.onclick = () => duplicateEnvironment(opened())
  el.remove.onclick = () => { void removeEnvironment(opened()) }

  // 进环境页时查一次上游（设计稿「默认」）；列表先画出来，检查结果回来再补上标记
  paneLoaders.environments = async () => {
    await load()
    void checkUpdates()
  }
  environmentState.reload = load
  // 切语言时主脚本叫这个重画：列表和详情的文案都是 paint 里 t() 拼的
  environmentState.repaint = () => paint()
  environmentState.closeDetail = () => { openedId = ''; activeTab = 'plugins'; pluginSubTab = 'installed'; paint() }
  environmentState.flushConfigSave = () => flushEnvAutoSave()
  environmentState.openId = (id, { keepTab = '' } = {}) => {
    const nextId = String(id || '').trim()
    if (!nextId) return
    void flushEnvAutoSave()
    openedId = nextId
    activeTab = keepTab || 'plugins'
    pluginSubTab = 'installed'
    el.editForm.dataset.environment = ''
    paint()
    if (openedId && !pluginUpdates[openedId]) void checkPluginUpdates({ silent: true, targetId: openedId })
    if (openedId && !marketState.loadedOnce && el.addMarket) void loadPluginMarket({ silent: true })
  }

  // ---- 跟随上游：应用更新 ----
  /** 更新框正文：DSH 版本、插件加删改、和本地改动的重复 / 冲突、没经过上游验证的本地插件（勾着 = 留着）。 */
  function updateReportHtml(data) {
    const { report } = data
    const rows = []
    if (report.dsh.from !== report.dsh.to) rows.push(t('DSH {from} → {to}', { from: report.dsh.from, to: report.dsh.to }))
    else if (report.dsh.upstreamFrom !== report.dsh.upstreamTo && report.dsh.local) rows.push(t('上游换成 DSH {version}，这里本地钉了 {local}，照用本地的', { version: report.dsh.upstreamTo, local: report.dsh.local }))
    if (data.dsh && !data.dsh.installed) rows.push(t('更新时先安装 DSH {version}', { version: data.dsh.version }))
    const { added, changed, removed, bundlesAdded, bundlesRemoved } = report.plugins
    for (const [name, spec] of Object.entries(added)) rows.push(t('新增 {name} {spec}', { name, spec }))
    for (const [name, item] of Object.entries(changed)) rows.push(t('{name} {from} → {to}', { name, from: item.from, to: item.to }))
    for (const name of removed) rows.push(t('移除 {name}', { name }))
    // 只换挂载、不加删依赖的那些单独列：装着却不再加载（或反过来）也是会改掉的东西
    for (const name of bundlesAdded.filter((item) => !Object.hasOwn(added, item))) rows.push(t('开始加载 {name}', { name }))
    for (const name of bundlesRemoved.filter((item) => !removed.includes(item))) rows.push(t('不再加载 {name}', { name }))
    if (!rows.length) rows.push(t('插件清单没有变化'))
    const conflicts = report.conflicts.map((item) => t(CONFLICT_TEXT[item.kind] || CONFLICT_TEXT.changed, item))
    const offline = (data.offline || []).map((item) => `${item.name} · ${item.file} · sha256 ${item.sha256.slice(0, 12)}…`)
    const unverified = report.unverified.length
      ? `<div class="pack-block"><span class="pack-block-title">${escapeHtml(t('上游换了 DSH 版本，这些本地插件没经过上游作者验证：勾着的照留，不勾的回到上游那份'))}</span>${report.unverified.map((name) => `<label class="pack-check"><input type="checkbox" data-keep="${escapeHtml(name)}" checked /><span>${escapeHtml(name)}</span></label>`).join('')}</div>`
      : ''
    return `<p class="hint">${escapeHtml(t('{name}：{from} → {to}', { name: data.environment.name, from: releaseLabel(data.installed) || t('未知'), to: releaseLabel(data.latest) }))}</p>
      ${packNotes(t('问题（先解决这些）'), data.errors || [], 'warn')}
      ${packNotes(t('会改掉'), rows)}
      ${packNotes(t('和你的本地改动撞了'), conflicts, 'warn')}
      ${packNotes(t('这些本地改动和新上游一样，会去掉'), report.duplicates)}
      ${unverified}
      ${packNotes(t('新版本带了 {n} 个离线文件：它们是可执行代码，确认是信得过的作者再更新', { n: offline.length }), offline, 'warn')}
      ${packNotes(t('要注意'), data.warnings || [], 'warn')}
      <p class="hint">${escapeHtml(t('现在这份会先存起来，更新后不满意可以在这里切回去。'))}</p>`
  }

  function hideUpdateDialog() {
    updateRevision += 1
    updateCheck = null
    void hidePackDialog(el.updateDialog)
  }

  /** 取消 / Esc：正在更新时不让关（关了就看不到更新失败的原因）。 */
  function closeUpdateDialog() {
    if (!busy) hideUpdateDialog()
  }

  async function openUpdateDialog(env) {
    const revision = ++updateRevision
    updateCheck = null
    el.updateBody.innerHTML = ''
    el.updateHint.textContent = t('正在下载上游的新版本…')
    el.updateGo.disabled = true
    showPackDialog(el.updateDialog, el.updateCancel)
    try {
      const data = await post('/api/environments/update/inspect', { id: env.id })
      if (revision !== updateRevision) return
      updateCheck = data
      el.updateBody.innerHTML = updateReportHtml(data)
      el.updateHint.textContent = ''
      el.updateGo.disabled = !data.ok
    } catch (error) {
      if (revision !== updateRevision) return
      el.updateHint.textContent = t(error.message)
    }
  }

  async function applyUpdate() {
    const check = updateCheck
    if (!check?.ok) return
    if (busy) {
      el.updateHint.textContent = t('还有一个操作没做完，等它结束再更新')
      return
    }
    const discard = [...el.updateBody.querySelectorAll('input[data-keep]')].filter((input) => !input.checked).map((input) => input.dataset.keep)
    el.updateGo.disabled = el.updateCancel.disabled = true
    el.updateHint.textContent = check.dsh && !check.dsh.installed ? t('正在安装 DSH {version}，装好后更新…', { version: check.dsh.version }) : t('正在更新…')
    // 忙碌标记归 run 管；失败的原因留在更新框里，不另弹通知
    await run(() => post('/api/environments/update/apply', { token: check.token, discard }), {
      after: () => {
        delete updates[check.environment.id]
        // 上游可能换了版本和通道：成功后重填这份表单，免得稍后只改名却把旧版本写回。
        // 更新期间若已切到另一实例，不冲掉那边尚未保存的输入；失败也照留原稿。
        if (el.editForm.dataset.environment === check.environment.id) {
          el.editForm.dataset.environment = ''
          resetCompatibility()
        }
        hideUpdateDialog()
        notify(t('实例「{name}」已更新到 {version}，下次用它启动时生效。', { name: check.environment.name, version: releaseLabel(check.latest) }))
      },
      onError: (error) => { el.updateHint.textContent = error.message },
    })
    el.updateCancel.disabled = false
    el.updateGo.disabled = !updateCheck?.ok
  }

  trapPackDialog(el.updateDialog, closeUpdateDialog)
  el.updateCancel.onclick = closeUpdateDialog
  el.updateGo.onclick = () => { void applyUpdate() }
  el.applyUpdate.onclick = () => {
    const env = opened()
    if (env) void openUpdateDialog(env)
  }
  el.checkUpdates.onclick = () => { void checkUpdates({ force: true }) }
  el.restore.onclick = async () => {
    const env = opened()
    const name = el.history.value
    if (!env || !name || !(await appConfirm(t('切回 {time} 之前的那份清单？现在这份会先存起来，之后还能切回来。', { time: historyTime(name) }), { title: t('切回之前的版本') }))) return
    // 切回的多半是旧版本：切完重算一次有没有新版本（服务端有缓存，不会多问 GitHub）
    await run(() => post('/api/environments/history/restore', { id: env.id, name }), {
      after: () => { delete updates[env.id]; el.editForm.dataset.environment = '' },
    })
    void checkUpdates()
  }

  // ---- 启动项编辑框里的「实例」下拉 ----
  // 编辑框在主脚本里；它打开时调 onLaunchEditorOpen，换实例时这里调 setLaunchVersion
  // 让版本选择跟上（主脚本的变量只由主脚本自己改），再调 paintLaunchVersionGroup：
  // 选了实例，版本那一组整个藏起来；「自定义」（值为空）才露出来自己挑版本。
  const launchDialog = byId('launchDialog')
  const launchSelect = byId('launchEnvironment')
  const launchHint = byId('launchEnvironmentHint')
  // 每次打开编辑框加一：晚到的列表请求不能填进后来那次打开的编辑框
  let launchRevision = 0
  // 编辑框打开时启动项自己的版本与配置：换走再换回原来的实例时要还原成它
  let launchOriginal = { version: AUTO_VERSION, channel: UPDATE_CHANNELS[0], profile: 'web' }

  function paintLaunchHint() {
    const env = environments.find((item) => item.id === launchSelect.value)
    launchHint.textContent = env
      ? t('DSH {version} · {count} 个插件。版本和插件跟着实例走，要改去「实例」页。', { version: versionText(env), count: thirdParty(env).length })
      : ''
    launchHint.hidden = !launchHint.textContent
    paintLaunchVersionGroup()
    globalThis.paintLaunchEnvironmentPick?.()
    globalThis.paintLaunchCopyPick?.()
  }

  // 「自定义」排在实例后面：值为空，和老启动项迁移、新建时没选实例是同一条路
  const customOption = () => `<option value="">${escapeHtml(t('自定义'))}</option>`

  async function fillLaunchEnvironments(entry) {
    const revision = ++launchRevision
    const current = entry?.environment || ''
    launchOriginal = { version: entry?.version || AUTO_VERSION, channel: launchChannel(entry), profile: entry?.profile || 'web' }
    // 先同步复位：上一次打开留下的选项和值，不能在列表回来之前被这次保存带上
    launchSelect.innerHTML = `${current ? `<option value="${escapeHtml(current)}">${escapeHtml(t('读取中…'))}</option>` : ''}${customOption()}`
    launchSelect.value = current
    launchSelect.dataset.saved = current
    syncUiSelect(launchSelect)
    paintLaunchHint()
    try {
      await fetchEnvironments()
    } catch {
      // 读不到就只留「自定义」和原来的实例：保存时服务端按 Profile 接回原来的实例，不会丢
    }
    if (revision !== launchRevision || launchDialog.hidden) return
    launchSelect.innerHTML = [
      ...environments.map((env) => `<option value="${escapeHtml(env.id)}">${escapeHtml(`${env.name} · ${versionText(env)}`)}</option>`),
      customOption(),
    ].join('')
    const targetProfile = entry?.profile || 'web'
    const exact = environments.find((env) => env.id === current)
    const byProfile = environments.find((env) => (env.targetProfile || env.name) === targetProfile)
    const pickedEnv = exact || byProfile || (!entry ? environments[0] : null)
    launchSelect.value = pickedEnv?.id || ''
    launchSelect.dataset.saved = launchSelect.value
    syncUiSelect(launchSelect)
    paintLaunchHint()
  }

  launchSelect.onchange = () => {
    const env = environments.find((item) => item.id === launchSelect.value)
    if (launchSelect.value === launchSelect.dataset.saved) {
      setLaunchVersion(launchOriginal.version, launchOriginal.channel)
      if (typeof setLaunchProfile === 'function') setLaunchProfile(launchOriginal.profile)
    } else if (env) {
      setLaunchVersion(env.dshVersion, env.updateChannel)
      if (env.targetProfile && typeof setLaunchProfile === 'function') setLaunchProfile(env.targetProfile)
    } else if (typeof setLaunchProfile === 'function') {
      setLaunchProfile(launchOriginal.profile)
    }
    paintLaunchHint()
  }
  globalThis.onLaunchEditorOpen = (entry) => { void fillLaunchEnvironments(entry) }
})()
