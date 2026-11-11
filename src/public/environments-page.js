// 环境页（导航「环境」）：列出环境，新建 / 复制 / 删除，改名改版本，加入 / 移除 / 升级插件，
// 导入（市场、文件、链接、GitHub、内置配方）和导出，跟随上游的检查更新 / 应用更新 / 切回旧版本。
// 这里只改环境清单（服务端的 environment.json），不碰任何 profile 目录：下次用这个环境启动时，
// 服务端才把清单写进 Profile 并装依赖（见 server.js 的 applyLaunchEnvironment）。
//
// 单独一个文件，跑在主脚本之后，用主脚本的全局：t、post、getJson、escapeHtml、notify、appConfirm、
// installedList、UPDATE_CHANNEL_NAMES、UPDATE_CHANNELS、paneLoaders、createUiSelect、syncUiSelect、
// showPackDialog、hidePackDialog、trapPackDialog、packNotes，
// 导入导出复用主脚本的弹窗（openImportDialog、inspectPack、openExportDialog、environmentState、AUTO_VERSION）。
(() => {
  const byId = (id) => document.getElementById(id)
  const el = {
    grid: byId('environmentGrid'),
    hint: byId('environmentHint'),
    overview: byId('environmentOverview'),
    view: byId('environmentView'),
    createForm: byId('environmentCreateForm'),
    newName: byId('environmentNewName'),
    importButton: byId('environmentImport'),
    back: byId('environmentBack'),
    detailName: byId('environmentDetailName'),
    detailSub: byId('environmentDetailSub'),
    upgrade: byId('environmentUpgrade'),
    exportButton: byId('environmentExport'),
    duplicate: byId('environmentDuplicate'),
    remove: byId('environmentDelete'),
    editForm: byId('environmentEditForm'),
    name: byId('environmentName'),
    version: byId('environmentVersion'),
    channel: byId('environmentChannel'),
    addForm: byId('environmentAddForm'),
    spec: byId('environmentSpec'),
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
  let busy = false
  // 跟随上游的检查结果：环境 id → {available, installed, latest, error}（服务端缓存 10 分钟）
  let updates = {}
  let checking = false
  // 正在确认的那次更新检查（服务端给的 token + 差别）；每次打开更新框加一，晚到的结果不画
  let updateCheck = null
  let updateRevision = 0

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

  function card({ attr, value, label, name, meta, tags }) {
    return `<div class="profile-card"><button class="pack-card" type="button" ${attr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      <div class="pack-card-body">
        <div class="pack-card-head"><span class="pack-card-name">${escapeHtml(name)}</span></div>
        <div class="pack-card-meta">${escapeHtml(meta)}</div>
        ${tags.length ? `<div class="pack-card-tags">${tags.map((tag) => `<span class="pack-tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      </div>
      <span class="pack-card-arrow" aria-hidden="true">›</span>
    </button></div>`
  }

  function renderGrid() {
    // 内置配方还没导入过的放在后面：点开就是导入预览，导入一次后就是普通环境
    const recipes = builtin.filter((recipe) => !recipe.imported)
    el.grid.innerHTML = [
      ...environments.map((env) => card({
        attr: 'data-environment', value: env.id,
        label: t('查看实例 {name} 的插件', { name: env.name }),
        name: env.name,
        meta: t('DSH {version} · {count} 个插件', { version: versionText(env), count: thirdParty(env).length }),
        tags: tagsOf(env),
      })),
      ...recipes.map((recipe) => card({
        attr: 'data-builtin', value: recipe.name,
        label: t('导入内置实例 {name}', { name: recipe.displayName }),
        name: recipe.displayName,
        meta: recipe.description || t('随启动器发的实例配方'),
        tags: [t('内置 · 点开导入')],
      })),
    ].join('')
    el.hint.textContent = environments.length ? '' : t('还没有实例。新建、导入一个，或者先保存一个启动项，启动器会按它的配置自动生成。')
    el.grid.querySelectorAll('[data-environment]').forEach((button) => {
      button.onclick = () => open(button.dataset.environment)
    })
    el.grid.querySelectorAll('[data-builtin]').forEach((button) => {
      button.onclick = () => { void inspectPack({ builtin: button.dataset.builtin }) }
    })
  }

  function versionOptions(current) {
    const versions = [...new Set([AUTO_VERSION, ...installedList(), current].filter(Boolean))]
    return versions.map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(version === AUTO_VERSION ? t('自动最新版本') : version)}</option>`).join('')
  }

  function pluginRow(plugin) {
    const tags = [
      plugin.official ? t('官方组件') : '',
      plugin.local ? t('本地路径') : '',
      plugin.offline ? t('离线文件') : '',
      plugin.origin === LOCAL_ORIGIN ? t('本地改动') : '',
      plugin.bundle ? '' : t('不挂载'),
    ].filter(Boolean)
    return `<div class="plugin-item"><div class="plugin-row">
      <span class="plugin-main">
        <span class="plugin-head">
          <span class="plugin-name">${escapeHtml(plugin.name)}</span>
          <span class="plugin-version">${escapeHtml(plugin.spec)}</span>
          ${tags.map((tag) => `<span class="plugin-status">${escapeHtml(tag)}</span>`).join('')}
        </span>
      </span>
      ${plugin.official ? '' : `<button class="ghost" type="button" data-remove-plugin="${escapeHtml(plugin.name)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('移除'))}</button>`}
    </div></div>`
  }

  /** 跟随上游那一行：有新版本、已是最新、检查失败、还没检查。 */
  function paintUpstream(env) {
    el.upstream.hidden = !env.following
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
    el.applyUpdate.hidden = !update?.available
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
    el.overview.hidden = Boolean(env)
    el.view.hidden = !env
    el.checkUpdates.disabled = busy || checking
    if (!env) return
    paintUpstream(env)
    paintHistory(env)
    el.detailName.textContent = env.name
    el.detailSub.textContent = t('DSH {version} · {count} 个插件', { version: versionText(env), count: thirdParty(env).length })
    // 正在输入时别把用户敲了一半的名字冲掉：只在切换环境或刚保存后重填表单
    if (el.editForm.dataset.environment !== env.id) {
      el.editForm.dataset.environment = env.id
      el.name.value = env.name
      el.version.innerHTML = versionOptions(env.dshVersion)
      el.version.value = env.dshVersion
      el.channel.innerHTML = UPDATE_CHANNELS.map((channel) => `<option value="${channel}">${escapeHtml(t(UPDATE_CHANNEL_NAMES[channel]))}</option>`).join('')
      el.channel.value = env.updateChannel
    }
    el.plugins.innerHTML = env.plugins.map(pluginRow).join('') || `<p class="hint">${escapeHtml(t('这个实例还没有插件。'))}</p>`
    el.plugins.querySelectorAll('[data-remove-plugin]').forEach((button) => {
      button.onclick = () => run(() => post('/api/environments/plugins/remove', { id: env.id, name: button.dataset.removePlugin }))
    })
    const users = env.usedBy.map((entry) => entry.name).join('、')
    const written = env.applied.map((item) => item.profile).join('、')
    el.usage.textContent = [
      users ? t('在用的启动项：{names}', { names: users }) : t('还没有启动项用这个实例。'),
      written ? t('现在装在配置：{names}', { names: written }) : '',
      env.following ? t('跟随上游 {repo}：这里的改动记成本地改动，上游更新后会重放。', { repo: env.source.repo }) : '',
      t('改动在下次用这个实例启动时生效。'),
    ].filter(Boolean).join(' ')
    for (const control of [el.upgrade, el.exportButton, el.duplicate, el.name, el.version, el.spec, byId('environmentSave'), byId('environmentAdd')]) control.disabled = busy
    // 版本类型只对「自动最新版本」有意义；钉了具体版本时它不影响选哪个版本
    el.channel.disabled = busy || el.version.value !== AUTO_VERSION
    syncUiSelect(el.version)
    syncUiSelect(el.channel)
    el.remove.disabled = busy || env.usedBy.length > 0
    el.remove.title = env.usedBy.length ? t('还有启动项在用，先给它们换一个实例') : ''
  }

  function paint() {
    renderGrid()
    renderView()
  }

  /** 拿一次最新列表：环境页和启动项编辑框共用，也同步给主脚本（市场卡片判断「已导入」）。 */
  async function fetchEnvironments() {
    const data = await getJson('/api/environments')
    environments = data.environments || []
    builtin = data.builtin || []
    nameMax = data.limits?.nameMax || nameMax
    if (nameMax) el.newName.maxLength = el.name.maxLength = nameMax
    environmentState.list = environments
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
      // 刚导入完跳过来的：直接打开那个环境
      if (environmentState.pendingOpen) {
        openedId = environmentState.pendingOpen
        environmentState.pendingOpen = ''
        el.editForm.dataset.environment = ''
      }
      if (openedId && !opened()) openedId = ''
      paint()
    } catch (error) {
      el.hint.textContent = error.message
    }
  }

  /** 一次只做一件事：按钮在请求期间全部禁用，结束后按服务端返回的最新列表重画。 */
  async function run(action, { after, onError = (error) => notify(error.message) } = {}) {
    if (busy) return
    busy = true
    renderView()
    try {
      const result = await action()
      after?.(result)
    } catch (error) {
      onError(error)
    } finally {
      busy = false
      await load()
    }
  }

  function open(id) {
    openedId = id
    el.editForm.dataset.environment = ''
    renderView()
    byId('pane-environments')?.scrollTo({ top: 0 })
  }

  // 和页面上其他下拉一样换成自绘菜单（原生 select 仍存值、仍触发 change）
  for (const select of [el.version, el.channel, el.history, byId('launchEnvironment')]) createUiSelect(select)
  el.back.onclick = () => { openedId = ''; paint() }
  el.importButton.onclick = () => openImportDialog()
  el.exportButton.onclick = () => {
    const env = opened()
    if (env) openExportDialog(env)
  }
  el.version.onchange = () => {
    el.channel.disabled = el.version.value !== AUTO_VERSION
    syncUiSelect(el.channel)
  }
  el.createForm.onsubmit = (event) => {
    event.preventDefault()
    const name = el.newName.value.trim()
    if (!name) { el.newName.focus(); return }
    void run(() => post('/api/environments/create', { name }), { after: (result) => { el.newName.value = ''; openedId = result.environment.id } })
  }
  el.editForm.onsubmit = (event) => {
    event.preventDefault()
    const env = opened()
    if (!env) return
    void run(() => post('/api/environments/update', { id: env.id, name: el.name.value, dshVersion: el.version.value, updateChannel: el.channel.value }), {
      after: () => { el.editForm.dataset.environment = '' },
    })
  }
  el.addForm.onsubmit = (event) => {
    event.preventDefault()
    const env = opened()
    const spec = el.spec.value.trim()
    if (!env || !spec) { el.spec.focus(); return }
    void run(() => post('/api/environments/plugins/add', { id: env.id, spec }), { after: () => { el.spec.value = '' } })
  }
  el.upgrade.onclick = () => {
    const env = opened()
    if (!env) return
    void run(() => post('/api/environments/plugins/upgrade', { id: env.id }), {
      after: (result) => {
        const done = result.upgraded.map((item) => `${item.name} ${item.from} → ${item.to}`).join('\n')
        const failed = result.failed.map((item) => `${item.name}：${item.error}`).join('\n')
        notify(done || t('都已经是最新版本'), t('升级结果'), failed)
      },
    })
  }
  el.duplicate.onclick = () => {
    const env = opened()
    if (!env) return
    const name = t('{name} 副本', { name: env.name })
    void run(() => post('/api/environments/create', { name: nameMax ? name.slice(0, nameMax) : name, from: env.id }), { after: (result) => { openedId = result.environment.id } })
  }
  el.remove.onclick = async () => {
    const env = opened()
    if (!env || !(await appConfirm(t('删除实例「{name}」？配置和里面已经装好的插件不受影响。', { name: env.name }), { title: t('删除实例') }))) return
    void run(() => post('/api/environments/remove', { id: env.id }), { after: () => { openedId = '' } })
  }

  // 进环境页时查一次上游（设计稿「默认」）；列表先画出来，检查结果回来再补上标记
  paneLoaders.environments = async () => {
    await load()
    void checkUpdates()
  }
  environmentState.reload = load

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
      el.updateHint.textContent = error.message
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

  // ---- 启动项编辑框里的「环境」下拉 ----
  // 编辑框在主脚本里；它打开时调 onLaunchEditorOpen，换环境时这里调 setLaunchVersion
  // 让版本选择跟上（主脚本的变量只由主脚本自己改）。
  const launchDialog = byId('launchDialog')
  const launchSelect = byId('launchEnvironment')
  const launchHint = byId('launchEnvironmentHint')
  // 每次打开编辑框加一：晚到的列表请求不能填进后来那次打开的编辑框
  let launchRevision = 0
  // 编辑框打开时启动项自己的版本：换走再换回原来的环境时要还原成它
  let launchOriginal = { version: AUTO_VERSION, channel: UPDATE_CHANNELS[0] }

  function paintLaunchHint() {
    const env = environments.find((item) => item.id === launchSelect.value)
    if (!env) {
      launchHint.textContent = t('保存时按这个配置现有的插件找到或生成一个实例。')
      return
    }
    const switched = launchSelect.value !== launchSelect.dataset.saved
    launchHint.textContent = switched
      ? t('DSH {version} · {count} 个插件。换实例时版本跟着这个实例；要改版本，先保存，再改。', { version: versionText(env), count: thirdParty(env).length })
      : t('DSH {version} · {count} 个插件。版本跟着实例走，在这里改版本就是改这个实例。', { version: versionText(env), count: thirdParty(env).length })
  }

  async function fillLaunchEnvironments(entry) {
    const revision = ++launchRevision
    const current = entry?.environment || ''
    launchOriginal = { version: entry?.version || AUTO_VERSION, channel: launchChannel(entry) }
    // 先同步复位：上一次打开留下的选项和值，不能在列表回来之前被这次保存带上
    launchSelect.innerHTML = `<option value="">${escapeHtml(t('自动：按配置的插件匹配或新建'))}</option>${current ? `<option value="${escapeHtml(current)}">${escapeHtml(t('读取中…'))}</option>` : ''}`
    launchSelect.value = current
    launchSelect.dataset.saved = current
    syncUiSelect(launchSelect)
    paintLaunchHint()
    try {
      await fetchEnvironments()
    } catch {
      // 读不到就只留「自动」和原来的环境：保存时服务端按 Profile 接回原来的环境，不会丢
    }
    if (revision !== launchRevision || launchDialog.hidden) return
    launchSelect.innerHTML = [
      `<option value="">${escapeHtml(t('自动：按配置的插件匹配或新建'))}</option>`,
      ...environments.map((env) => `<option value="${escapeHtml(env.id)}">${escapeHtml(`${env.name} · ${versionText(env)}`)}</option>`),
    ].join('')
    launchSelect.value = environments.some((env) => env.id === current) ? current : ''
    launchSelect.dataset.saved = launchSelect.value
    syncUiSelect(launchSelect)
    paintLaunchHint()
  }

  launchSelect.onchange = () => {
    const env = environments.find((item) => item.id === launchSelect.value)
    if (launchSelect.value === launchSelect.dataset.saved) setLaunchVersion(launchOriginal.version, launchOriginal.channel)
    else if (env) setLaunchVersion(env.dshVersion, env.updateChannel)
    paintLaunchHint()
  }
  globalThis.onLaunchEditorOpen = (entry) => { void fillLaunchEnvironments(entry) }
})()
