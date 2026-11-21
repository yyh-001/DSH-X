// 实例详情「配置」页签顶部的启动项配置卡（仅从首页启动卡片点进实例弹窗且非 WSL/SSH 时显示）
;(() => {
  const dialogEl = document.getElementById('envLaunchConfigDialog')
  const closeEl = document.getElementById('envLaunchConfigClose')
  const cardEl = document.getElementById('envLaunchConfigCard')
  const statusEl = document.getElementById('envLaunchSaveStatus')
  const identityEl = document.getElementById('envLaunchIdentityControl')
  const iconTriggerEl = document.getElementById('envLaunchIconTrigger')
  const iconPopoverEl = document.getElementById('envLaunchIconPopover')
  const iconPickerEl = document.getElementById('envLaunchIconPicker')
  const iconUploadEl = document.getElementById('envLaunchIconUpload')
  const iconResetEl = document.getElementById('envLaunchIconReset')
  const iconFileEl = document.getElementById('envLaunchIconFile')
  const iconHintEl = document.getElementById('envLaunchIconHint')
  const nameEl = document.getElementById('envLaunchName')
  const homeEl = document.getElementById('envLaunchHome')
  const homePickEl = document.getElementById('envLaunchHomePick')
  const homePickValueEl = document.getElementById('envLaunchHomePickValue')
  const homePanelEl = document.getElementById('envLaunchHomePanel')
  const homeListEl = document.getElementById('envLaunchHomeList')
  const portEl = document.getElementById('envLaunchPort')
  const envSelectEl = document.getElementById('envLaunchEnvironment')
  const envPickEl = document.getElementById('envLaunchEnvironmentPick')
  const envPickValueEl = document.getElementById('envLaunchEnvironmentPickValue')
  const envPanelEl = document.getElementById('envLaunchEnvPanel')
  const envListEl = document.getElementById('envLaunchEnvList')
  const autoLaunchEl = document.getElementById('envLaunchAutoLaunch')
  const dshHomeEnvEl = document.getElementById('envLaunchDshHomeEnv')
  const recoverEl = document.getElementById('envLaunchRecover')
  const deleteEl = document.getElementById('envLaunchDelete')
  const recoveryHintEl = document.getElementById('envLaunchRecoveryHint')
  if (!cardEl) return

  let iconDraft = 'terminal'
  let iconsOpen = false
  let iconMotion = null
  let homePanelResize = null
  let envPanelResize = null
  let activeLaunchEntry = null
  let currentEnvObj = null
  let syncedEntryKey = ''
  let recoveryState = null
  let recoverySeq = 0
  let envHomeBusy = false
  const autoSave = { timer: null, inFlight: null, queued: false, override: null }

  const effectiveLaunchHome = (entry = liveLaunchEntry()) => {
    const selected = homeEl ? homeEl.value : (entry?.dshHome || '')
    return String(selected || state.dshHome || '').trim()
  }

  function paintDshHomeEnv(entry = liveLaunchEntry()) {
    if (!dshHomeEnvEl) return
    const current = effectiveLaunchHome(entry)
    const envHome = state.userDshHome || ''
    dshHomeEnvEl.checked = Boolean(current && envHome && normalizeHomePath(envHome) === normalizeHomePath(current))
    dshHomeEnvEl.disabled = envHomeBusy || !current
  }
  globalThis.syncEnvLaunchDshHomeEnv = () => {
    if (canManageLaunchEntry(liveLaunchEntry())) paintDshHomeEnv()
  }

  const liveLaunchEntry = () => {
    const ref = activeLaunchEntry || pluginLaunchEntry
    if (!ref) return null
    return launchEntries().find((item) => item.id === ref.id) || ref
  }

  const canManageLaunchEntry = (entry) => Boolean(
    entry && entry.backend !== 'wsl' && entry.backend !== 'ssh'
    && ((dialogEl && !dialogEl.hidden) || (launchPluginsDialogEl && !launchPluginsDialogEl.hidden)),
  )

  const resolveEntryEnv = (entry) => {
    if (!entry) return null
    const list = Array.isArray(environmentState?.list) ? environmentState.list : []
    if (entry.environment) {
      const byId = list.find((item) => item.id === entry.environment)
      if (byId) return byId
    }
    const profile = entry.profile || 'web'
    const home = entry.dshHome || state.dshHome || ''
    return list.find((item) => (item.targetProfile || item.name) === profile && (!item.targetHome || normalizeHomePath(item.targetHome) === normalizeHomePath(home)))
      || list.find((item) => (item.targetProfile || item.name) === profile)
      || null
  }

  const envVersionLabel = (env) => {
    if (!env) return ''
    return env.dshVersion === 'auto'
      ? t('自动（{channel}）', { channel: t(UPDATE_CHANNEL_NAMES[env.updateChannel] || env.updateChannel) })
      : env.dshVersion
  }

  function paintSaveStatus(kind = 'idle', detail = '') {
    if (!statusEl) return
    if (kind === 'error') {
      statusEl.textContent = detail || t('保存失败：{error}', { error: '' })
      statusEl.hidden = false
    } else {
      statusEl.textContent = ''
      statusEl.hidden = true
    }
  }

  function setEnvLaunchIcons(open, immediate = false) {
    if (!iconPopoverEl || !iconTriggerEl) return
    if (iconsOpen === open && !immediate) return
    const wasHidden = iconPopoverEl.hidden
    const current = getComputedStyle(iconPopoverEl)
    const from = { opacity: wasHidden ? 0 : current.opacity, transform: wasHidden ? 'translateY(-6px) scale(.96)' : current.transform }
    iconMotion?.cancel()
    iconMotion = null
    iconsOpen = open
    iconTriggerEl.setAttribute('aria-expanded', String(open))
    iconPopoverEl.inert = !open
    if (immediate || isReducedMotion()) { iconPopoverEl.hidden = !open; return }
    iconPopoverEl.hidden = false
    const animation = iconPopoverEl.animate(
      [from, { opacity: open ? 1 : 0, transform: open ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(.96)' }],
      { duration: open ? MOTION.duration.base : MOTION.duration.fast, easing: MOTION.ease.standard, fill: 'both' },
    )
    iconMotion = animation
    animation.finished.then(() => {
      if (iconMotion !== animation) return
      iconPopoverEl.hidden = !open
      iconMotion = null
      animation.cancel()
    }).catch(() => {})
  }

  function closeEnvLaunchIcons(immediate = false) {
    setEnvLaunchIcons(false, immediate)
  }
  globalThis.closeEnvLaunchIcons = closeEnvLaunchIcons

  function paintIcons() {
    if (!iconTriggerEl || !iconPickerEl) return
    iconTriggerEl.innerHTML = launchIconMarkup(iconDraft)
    const choices = [...Object.keys(LAUNCH_ICON_PATHS), ...(iconDraft.startsWith('data:') ? [iconDraft] : [])]
    iconPickerEl.innerHTML = choices.map((icon) => `<button type="button" class="launch-icon-choice" aria-label="${escapeHtml(t(LAUNCH_ICON_NAMES[icon] || '自定义图片'))}" aria-pressed="${icon === iconDraft}" title="${escapeHtml(t(LAUNCH_ICON_NAMES[icon] || '自定义图片'))}">${launchIconMarkup(icon)}</button>`).join('')
    iconPickerEl.querySelectorAll('button').forEach((button, index) => {
      button.onclick = () => {
        iconDraft = choices[index]
        paintIcons()
        closeEnvLaunchIcons()
        void saveEnvLaunchConfig({ icon: iconDraft })
      }
    })
  }

  if (iconTriggerEl) iconTriggerEl.onclick = () => {
    closeEnvLaunchHomePanel()
    closeEnvLaunchEnvPanel()
    setEnvLaunchIcons(!iconsOpen)
  }
  document.addEventListener('pointerdown', (event) => {
    if (identityEl && !identityEl.contains?.(event.target)) closeEnvLaunchIcons()
    if (homePanelEl && !homePanelEl.hidden && !homePanelEl.contains?.(event.target) && !homePickEl?.contains?.(event.target)) {
      closeEnvLaunchHomePanel()
    }
    if (envPanelEl && !envPanelEl.hidden && !envPanelEl.contains?.(event.target) && !envPickEl?.contains?.(event.target)) {
      closeEnvLaunchEnvPanel()
    }
  })
  document.addEventListener('scroll', (event) => {
    if (homePanelEl && !homePanelEl.hidden && !homePanelEl.contains?.(event.target)) {
      closeEnvLaunchHomePanel()
    }
    if (envPanelEl && !envPanelEl.hidden && !envPanelEl.contains?.(event.target)) {
      closeEnvLaunchEnvPanel()
    }
  }, true)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      if (homePanelEl && !homePanelEl.hidden) alignEnvLaunchHomePanel()
      if (envPanelEl && !envPanelEl.hidden) alignEnvLaunchEnvPanel()
    })
  }
  if (identityEl) {
    identityEl.onkeydown = (event) => {
      if (event.key === 'Escape' && iconPopoverEl && !iconPopoverEl.hidden) {
        event.preventDefault()
        event.stopPropagation()
        closeEnvLaunchIcons()
        iconTriggerEl?.focus()
      }
    }
  }
  if (iconResetEl) {
    iconResetEl.onclick = () => {
      iconDraft = 'terminal'
      paintIcons()
      closeEnvLaunchIcons()
      void saveEnvLaunchConfig({ icon: 'terminal' })
    }
  }
  if (iconUploadEl) {
    iconUploadEl.onclick = () => {
      closeEnvLaunchIcons()
      iconFileEl?.click()
    }
  }
  if (iconFileEl) {
    iconFileEl.onchange = async (event) => {
      const file = event.target.files?.[0]
      if (!file) return
      try {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
          throw new Error(t('请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片'))
        }
        const bitmap = await createImageBitmap(file)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 96
        const ctx = canvas.getContext('2d')
        const scale = Math.min(96 / bitmap.width, 96 / bitmap.height)
        ctx.drawImage(bitmap, (96 - bitmap.width * scale) / 2, (96 - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale)
        bitmap.close()
        iconDraft = canvas.toDataURL('image/png')
        paintIcons()
        if (iconHintEl) iconHintEl.textContent = ''
        void saveEnvLaunchConfig({ icon: iconDraft })
      } catch (error) {
        if (iconHintEl) iconHintEl.textContent = error.message
      }
      event.target.value = ''
    }
  }

  function homeBaseName(path) {
    if (typeof folderBaseName === 'function') return folderBaseName(path)
    const trimmed = String(path || '').replace(/[\\/]+$/, '')
    return trimmed.split(/[\\/]/).filter(Boolean).pop() || ''
  }

  function isSameHome(a, b) {
    return normalizeHomePath(a || state.dshHome || '') === normalizeHomePath(b || state.dshHome || '')
  }

  function normalizeSelectedHome(raw) {
    const clean = String(raw || '').trim()
    if (!clean) return ''
    if (state.dshHome && normalizeHomePath(clean) === normalizeHomePath(state.dshHome)) return ''
    return clean
  }

  function homeTitleOf(real) {
    return (typeof pluginHomeName === 'function' ? pluginHomeName(real, '') : '') || homeBaseName(real) || t('本机')
  }

  function paintHomeTrigger(selectedHome) {
    if (!homePickEl || !homePickValueEl) return
    const real = normalizeSelectedHome(selectedHome) || state.dshHome || '~/.dsh'
    const name = homeTitleOf(real)
    const text = real && real !== name ? `${name} · ${real}` : name
    homePickEl.classList?.remove?.('is-placeholder')
    homePickValueEl.textContent = text
    homePickEl.title = text
    homePickEl.setAttribute?.('aria-label', text)
  }

  function paintHomeList(selectedHome = homeEl?.value || '') {
    if (!homeListEl) return
    const current = normalizeSelectedHome(selectedHome)
    const localHomes = ['']
    for (const [home] of homeOptions(current)) {
      if (!localHomes.some((one) => isSameHome(one, home))) localHomes.push(home)
    }
    const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-folder"/></svg>'
    const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg>'
    const rows = localHomes.map((home) => {
      const selected = isSameHome(home, current)
      const real = home || state.dshHome || '~/.dsh'
      const name = homeTitleOf(real)
      return `<button class="project-device-option${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-env-home="${escapeHtml(home)}"><span class="project-device-option-icon">${folderIcon}</span><span class="project-device-option-text"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(real)}</small></span><span class="project-device-option-state">${selected ? `<span class="project-device-check">${check}</span>` : ''}</span></button>`
    })
    rows.push(`<button class="project-device-option is-add" type="button" role="option" data-env-home-create><span class="project-device-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-folder-plus"/></svg></span><span class="project-device-option-text"><strong>${escapeHtml(t('创建项目'))}</strong></span></button>`)
    rows.push(`<button class="project-device-option is-manage" type="button" role="option" data-env-home-manage><span class="project-device-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-sliders-horizontal"/></svg></span><span class="project-device-option-text"><strong>${escapeHtml(t('管理目录'))}</strong></span></button>`)
    homeListEl.innerHTML = rows.join('')
  }

  function alignEnvLaunchHomePanel() {
    if (typeof alignFloatingPanel === 'function' && homePanelEl && homePickEl) {
      alignFloatingPanel(homePanelEl, homePickEl)
    }
  }

  function openEnvLaunchHomePanel() {
    if (!homePanelEl || !homePanelEl.hidden || !homePickEl) return
    if (typeof closeUiSelect === 'function') closeUiSelect()
    closeEnvLaunchIcons()
    closeEnvLaunchEnvPanel()
    paintHomeList(homeEl?.value || '')
    homePanelEl.hidden = false
    homePickEl.setAttribute?.('aria-expanded', 'true')
    alignEnvLaunchHomePanel()
    if (typeof ResizeObserver === 'function' && !homePanelResize) {
      homePanelResize = new ResizeObserver(() => {
        if (homePanelEl && !homePanelEl.hidden) alignEnvLaunchHomePanel()
      })
      homePanelResize.observe(homePickEl)
    }
  }

  function closeEnvLaunchHomePanel() {
    if (!homePanelEl || homePanelEl.hidden) return
    homePanelEl.hidden = true
    homePickEl?.setAttribute?.('aria-expanded', 'false')
    homePanelResize?.disconnect()
    homePanelResize = null
  }

  function selectEnvLaunchHome(rawHome) {
    const prevHome = normalizeSelectedHome(homeEl?.value || '')
    const nextHome = normalizeSelectedHome(rawHome)
    paintHomes(nextHome)
    if (nextHome !== prevHome) void flushEnvLaunchSave({ dshHome: nextHome })
  }

  function paintHomes(selectedHome) {
    const selected = normalizeSelectedHome(selectedHome)
    if (homeEl) {
      const homes = homeOptions(selected)
      const defaultLabel = homeOptionLabel(state.dshHome, pluginHomeName(state.dshHome, t('全局目录')))
      homeEl.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`
        + [...homes].map(([home, label]) => `<option value="${escapeHtml(home)}">${escapeHtml(homeOptionLabel(home, label))}</option>`).join('')
      homeEl.value = selected
    }
    paintHomeTrigger(selected)
    if (homePanelEl && !homePanelEl.hidden) paintHomeList(selected)
    paintDshHomeEnv()
  }

  function envChoices(currentEnvId = envSelectEl?.value || '', envObj = currentEnvObj) {
    const list = Array.isArray(environmentState?.list) ? environmentState.list : []
    const hasSelected = Boolean(currentEnvId) && list.some((item) => item.id === currentEnvId)
    const options = [...list]
    if (currentEnvId && !hasSelected && envObj) options.unshift(envObj)
    return options
  }

  function envOptionSubtext(item) {
    if (!item) return ''
    const ver = envVersionLabel(item)
    const home = item.targetHome || state.dshHome || ''
    return ver && home ? `${ver} · ${home}` : (ver || home)
  }

  function paintEnvTrigger(currentEnvId, envObj = null) {
    if (!envPickEl || !envPickValueEl) return
    const options = envChoices(currentEnvId, envObj)
    const selectedId = currentEnvId || (envObj?.id || options[0]?.id || '')
    const found = options.find((item) => item.id === selectedId) || null
    const text = found ? `${found.name || found.id} · ${envVersionLabel(found)}` : (selectedId || t('选择一个实例…'))
    envPickEl.classList?.toggle?.('is-placeholder', !found && !selectedId)
    envPickValueEl.textContent = text
    envPickEl.title = text
    envPickEl.setAttribute?.('aria-label', text)
  }

  function paintEnvList(currentEnvId = envSelectEl?.value || '', envObj = currentEnvObj) {
    if (!envListEl) return
    const options = envChoices(currentEnvId, envObj)
    const selectedId = currentEnvId || (envObj?.id || options[0]?.id || '')
    const packageIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-package"/></svg>'
    const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-check"/></svg>'
    const rows = options.map((item) => {
      const selected = item.id === selectedId
      const subtext = envOptionSubtext(item)
      return `<button class="project-device-option${selected ? ' is-selected' : ''}" type="button" role="option" aria-selected="${selected}" data-env-id="${escapeHtml(item.id)}"><span class="project-device-option-icon">${packageIcon}</span><span class="project-device-option-text"><strong>${escapeHtml(item.name || item.id)}</strong>${subtext ? `<small>${escapeHtml(subtext)}</small>` : ''}</span><span class="project-device-option-state">${selected ? `<span class="project-device-check">${check}</span>` : ''}</span></button>`
    })
    rows.push(`<button class="project-device-option is-add" type="button" role="option" data-env-manage="1"><span class="project-device-option-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#lucide-sliders-horizontal"/></svg></span><span class="project-device-option-text"><strong>${escapeHtml(t('管理实例'))}</strong></span></button>`)
    envListEl.innerHTML = rows.join('')
  }

  function alignEnvLaunchEnvPanel() {
    if (typeof alignFloatingPanel === 'function' && envPanelEl && envPickEl) {
      alignFloatingPanel(envPanelEl, envPickEl)
    }
  }

  function openEnvLaunchEnvPanel() {
    if (!envPanelEl || !envPanelEl.hidden || !envPickEl) return
    if (typeof closeUiSelect === 'function') closeUiSelect()
    closeEnvLaunchIcons()
    closeEnvLaunchHomePanel()
    paintEnvList(envSelectEl?.value || '', currentEnvObj)
    envPanelEl.hidden = false
    envPickEl.setAttribute?.('aria-expanded', 'true')
    alignEnvLaunchEnvPanel()
    if (typeof ResizeObserver === 'function' && !envPanelResize) {
      envPanelResize = new ResizeObserver(() => {
        if (envPanelEl && !envPanelEl.hidden) alignEnvLaunchEnvPanel()
      })
      envPanelResize.observe(envPickEl)
    }
  }

  function closeEnvLaunchEnvPanel() {
    if (!envPanelEl || envPanelEl.hidden) return
    envPanelEl.hidden = true
    envPickEl?.setAttribute?.('aria-expanded', 'false')
    envPanelResize?.disconnect()
    envPanelResize = null
  }

  function selectEnvLaunchEnvironment(nextId) {
    const clean = String(nextId || '')
    if (!clean) return
    const prevId = envSelectEl?.value || ''
    const matched = envChoices(clean, currentEnvObj).find((item) => item.id === clean) || null
    if (matched) currentEnvObj = matched
    paintEnvironments(clean, matched || currentEnvObj)
    if (clean !== prevId) void flushEnvLaunchSave({ environment: clean })
  }

  function paintEnvironments(currentEnvId, envObj = null) {
    const options = envChoices(currentEnvId, envObj)
    const selectedId = currentEnvId || (envObj?.id || options[0]?.id || '')
    if (envSelectEl) {
      envSelectEl.innerHTML = options.length
        ? options.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(`${item.name} · ${envVersionLabel(item)}`)}</option>`).join('')
        : (currentEnvId ? `<option value="${escapeHtml(currentEnvId)}">${escapeHtml(currentEnvId)}</option>` : '')
      envSelectEl.value = selectedId
    }
    paintEnvTrigger(selectedId, envObj)
    if (envPanelEl && !envPanelEl.hidden) paintEnvList(selectedId, envObj)
  }

  function paintRecovery() {
    if (!recoveryHintEl) return
    const entry = liveLaunchEntry()
    const recovery = recoveryState?.data
    const last = recovery?.last
    const backup = last?.backup ?? recovery?.backups?.[0]?.path ?? null
    const profile = entry?.profile || ''
    const home = entry?.dshHome || state.dshHome || ''
    if (!canManageLaunchEntry(entry) || !profile || recoveryState?.home !== home || recovery?.profile !== profile || (!backup && !last)) {
      recoveryHintEl.hidden = true
      recoveryHintEl.textContent = ''
      return
    }
    recoveryHintEl.hidden = false
    recoveryHintEl.innerHTML = escapeHtml(last
      ? t('已修复配置 {profile}：补丁层已备份，停用第三方插件 {count} 个，重启后生效。', { profile, count: last.dropped?.length || 0 })
      : t('配置 {profile} 有一份配置备份，可还原。', { profile }))
      + (last?.warning ? ` ${escapeHtml(last.warning)}` : '')
      + (backup ? ` <button class="link-button" type="button" id="envLaunchRecoverUndo" ${packBusy ? 'disabled' : ''}>${escapeHtml(t('还原'))}</button>` : '')
      + (installedList().length ? ` <button class="link-button" type="button" id="envLaunchRecoverRestart" ${packBusy ? 'disabled' : ''}>${escapeHtml(t('启动 / 重启这个配置'))}</button>` : '')
    document.getElementById('envLaunchRecoverUndo')?.addEventListener('click', () => void restoreEnvLaunchRecovery(entry, backup))
    document.getElementById('envLaunchRecoverRestart')?.addEventListener('click', () => void restartEnvironment(profile))
  }

  async function loadRecoveryForEntry(entry) {
    if (!canManageLaunchEntry(entry)) return
    const seq = ++recoverySeq
    const profile = entry.profile || 'web'
    const home = entry.dshHome || state.dshHome || ''
    try {
      const data = await getJson(`/api/recover?profile=${encodeURIComponent(profile)}`, { launchId: entry.id })
      if (seq !== recoverySeq || liveLaunchEntry()?.id !== entry.id) return
      recoveryState = { home, data }
      state.recovery = data
      paintRecovery()
    } catch (error) {
      if (seq === recoverySeq && recoveryHintEl && canManageLaunchEntry(entry)) {
        recoveryHintEl.hidden = false
        recoveryHintEl.textContent = error.message
      }
    }
  }

  async function restoreEnvLaunchRecovery(entry, backup) {
    if (!entry || packBusy) return
    packBusy = true
    paintRecovery()
    try {
      const profile = entry.profile || 'web'
      const data = await post('/api/recover/restore', { profile, backup }, { launchId: entry.id })
      if (data?.recovery) {
        state.recovery = data.recovery
        recoveryState = { home: entry.dshHome || state.dshHome || '', data: data.recovery }
        paintRecovery()
        render()
      }
      await loadRecoveryForEntry(entry)
      await environmentState.reload?.()
    } catch (error) {
      notify(error.message)
    } finally {
      packBusy = false
      paintRecovery()
    }
  }

  if (recoverEl) {
    recoverEl.onclick = async () => {
      const entry = liveLaunchEntry()
      if (!entry || packBusy) return
      const profile = entry.profile || 'web'
      if (!(await appConfirm(t('修复配置 {profile}：把补丁层（自定义 provider、主题等）备份后移出启动路径，并停用第三方插件；重启后生效。继续？', { profile }), { title: t('修复配置') }))) return
      packBusy = true
      if (recoveryHintEl) {
        recoveryHintEl.hidden = false
        recoveryHintEl.textContent = t('正在修复配置…')
      }
      paintRecovery()
      try {
        const data = await post('/api/recover', { profile }, { launchId: entry.id })
        if (data?.recovery) {
          state.recovery = data.recovery
          recoveryState = { home: entry.dshHome || state.dshHome || '', data: data.recovery }
        }
        render()
        await loadRecoveryForEntry(entry)
        await environmentState.reload?.()
        notify(t('配置已修复，可启动或重启这个配置。'), t('修复配置'))
      } catch (error) {
        notify(error.message, t('修复配置'))
      } finally {
        packBusy = false
        paintRecovery()
      }
    }
  }

  if (deleteEl) {
    deleteEl.onclick = async () => {
      const entry = liveLaunchEntry()
      if (!entry || entry.id === DEFAULT_LAUNCH_ID || deleteEl.disabled) return
      const ok = await appConfirm(t('删除启动项「{name}」？已装的版本和数据不受影响。', { name: entry.name || '' }))
      if (!ok) return
      deleteEl.disabled = true
      try {
        const id = entry.id
        await post('/api/launch-presets/remove', { id })
        state.launchPresets = launchEntries().filter((item) => item.id !== id)
        if (dialogEl && !dialogEl.hidden) await closeEnvLaunchConfig({ afterDelete: true })
        if (launchPluginsDialogEl && !launchPluginsDialogEl.hidden) await closeLaunchPlugins({ afterDelete: true })
        render()
      } catch (error) {
        notify(error.message)
      } finally {
        deleteEl.disabled = false
      }
    }
  }

  function scheduleEnvLaunchSave(delay = 500) {
    if (autoSave.timer) {
      clearTimeout(autoSave.timer)
      autoSave.timer = null
    }
    if (!canManageLaunchEntry(liveLaunchEntry())) return
    autoSave.timer = setTimeout(() => {
      autoSave.timer = null
      void saveEnvLaunchConfig()
    }, delay)
  }

  async function flushEnvLaunchSave(override = null) {
    if (autoSave.timer) {
      clearTimeout(autoSave.timer)
      autoSave.timer = null
    }
    if (autoSave.inFlight) {
      autoSave.queued = true
      if (override) autoSave.override = { ...(autoSave.override || {}), ...override }
      return autoSave.inFlight
    }
    return saveEnvLaunchConfig(override || {})
  }
  globalThis.flushEnvLaunchSave = flushEnvLaunchSave

  async function saveEnvLaunchConfig(override = {}) {
    if (autoSave.inFlight) {
      autoSave.queued = true
      autoSave.override = { ...(autoSave.override || {}), ...override }
      return autoSave.inFlight
    }
    const entry = liveLaunchEntry()
    if (!canManageLaunchEntry(entry)) return
    const nextName = String(nameEl?.value ?? '').trim()
    if (!nextName || nextName.length > 32) {
      paintSaveStatus('error', t('启动项名称请填 1-32 个字符'))
      return
    }
    const portRaw = String(portEl?.value ?? '').trim()
    let nextPort = 0
    if (portRaw) {
      const portNum = Number(portRaw)
      if (!/^\d+$/.test(portRaw) || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        paintSaveStatus('error', t('端口请填 1-65535，或留空自动分配'))
        return
      }
      nextPort = portNum
    }
    const prevIcon = entry.icon || 'terminal'
    const nextIcon = override.icon !== undefined ? override.icon : iconDraft
    const nextHome = String(override.dshHome !== undefined ? override.dshHome : (homeEl?.value ?? ''))
    const nextEnvId = String(override.environment !== undefined ? override.environment : (envSelectEl?.value ?? entry.environment ?? ''))
    const nextAutoLaunch = Boolean(autoLaunchEl?.checked)
    const switchingEnvironment = Boolean(nextEnvId) && nextEnvId !== (entry.environment || '')
    const envList = Array.isArray(environmentState?.list) ? environmentState.list : []
    const nextEnvObj = envList.find((item) => item.id === nextEnvId) || null
    const unchanged = override.icon === undefined
      && override.environment === undefined
      && override.dshHome === undefined
      && !switchingEnvironment
      && nextName === (entry.name || '')
      && nextIcon === prevIcon
      && nextHome === (entry.dshHome || '')
      && nextPort === (Number(entry.port) || 0)
      && nextEnvId === (entry.environment || '')
      && nextAutoLaunch === (entry.autoLaunch === true)
    if (unchanged) {
      paintSaveStatus('idle')
      return
    }

    const linkedEnv = switchingEnvironment
      ? nextEnvObj
      : (envList.find((item) => item.id === (entry.environment || nextEnvId)) || currentEnvObj || null)
    const nextProfile = switchingEnvironment
      ? (nextEnvObj?.targetProfile || entry.profile || 'web')
      : (entry.profile || 'web')
    const nextVersion = linkedEnv?.dshVersion || entry.version || 'auto'
    const nextChannel = linkedEnv?.updateChannel || launchChannel(entry)
    paintSaveStatus('saving')
    const runSave = (async () => {
      try {
        const data = await post('/api/launch-presets', {
          id: entry.id,
          name: nextName,
          icon: nextIcon,
          version: nextVersion,
          ...(nextEnvId ? { environment: nextEnvId } : {}),
          profile: nextProfile,
          port: nextPort ? String(nextPort) : '',
          dshHome: nextHome,
          autoLaunch: nextAutoLaunch,
          updateChannel: nextChannel,
        })
        const saved = data.entry
        if (saved) {
          updateLaunchEntry(saved)
          if (activeLaunchEntry?.id === saved.id) activeLaunchEntry = saved
          if (pluginLaunchEntry?.id === saved.id) {
            pluginLaunchEntry = saved
            const titleEl = document.getElementById('launchPluginsTitle')
            if (titleEl) titleEl.textContent = saved.name ? `${saved.name} · ${t('实例')}` : t('实例')
          }
          iconDraft = saved.icon || 'terminal'
          paintIcons()
          if (document.activeElement !== nameEl && nameEl) nameEl.value = saved.name || ''
          if (document.activeElement !== portEl && portEl) portEl.value = saved.port ? String(saved.port) : ''
          if (homeEl) paintHomes(saved.dshHome || '')
          if (autoLaunchEl) autoLaunchEl.checked = saved.autoLaunch === true
          if (deleteEl) deleteEl.hidden = saved.id === DEFAULT_LAUNCH_ID
          render()
          if (switchingEnvironment && nextEnvId) {
            if (nextEnvObj) currentEnvObj = nextEnvObj
            paintEnvironments(nextEnvId, nextEnvObj)
            if (launchPluginsDialogEl && !launchPluginsDialogEl.hidden && pluginLaunchEntry?.id === saved.id) {
              environmentState.openId?.(nextEnvId, { keepTab: 'config' })
            }
            void environmentState.reload?.()
            void loadRecoveryForEntry(saved)
          } else if (nextHome !== (entry.dshHome || '')) {
            void environmentState.reload?.()
            void loadRecoveryForEntry(saved)
          }
        }
        paintSaveStatus('saved')
      } catch (error) {
        paintHomes(entry.dshHome || '')
        paintEnvironments(entry.environment || '', currentEnvObj)
        paintSaveStatus('error', t('保存失败：{error}', { error: error.message }))
      } finally {
        autoSave.inFlight = null
        if (autoSave.queued) {
          const queuedOverride = autoSave.override || {}
          autoSave.queued = false
          autoSave.override = null
          void saveEnvLaunchConfig(queuedOverride)
        }
      }
    })()
    autoSave.inFlight = runSave
    return runSave
  }

  if (nameEl) {
    nameEl.oninput = () => scheduleEnvLaunchSave(500)
    nameEl.onblur = () => { void flushEnvLaunchSave() }
    nameEl.onchange = () => { void flushEnvLaunchSave() }
    nameEl.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void flushEnvLaunchSave() }
    }
  }
  if (portEl) {
    portEl.oninput = () => scheduleEnvLaunchSave(500)
    portEl.onblur = () => { void flushEnvLaunchSave() }
    portEl.onchange = () => { void flushEnvLaunchSave() }
    portEl.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void flushEnvLaunchSave() }
    }
  }
  if (homeEl) {
    homeEl.onchange = () => {
      paintHomeTrigger(homeEl.value || '')
      paintDshHomeEnv()
      void flushEnvLaunchSave()
    }
  }
  if (homePickEl) {
    homePickEl.onclick = (event) => {
      event?.stopPropagation?.()
      if (homePanelEl && !homePanelEl.hidden) closeEnvLaunchHomePanel()
      else openEnvLaunchHomePanel()
    }
    homePickEl.onkeydown = (event) => {
      if (event.key === 'Escape' && homePanelEl && !homePanelEl.hidden) {
        event.preventDefault()
        event.stopPropagation()
        closeEnvLaunchHomePanel()
        return
      }
      if (event.key === 'Tab') {
        closeEnvLaunchHomePanel()
        return
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && homePanelEl?.hidden) {
        event.preventDefault()
        openEnvLaunchHomePanel()
      }
    }
  }
  if (homePanelEl) {
    homePanelEl.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeEnvLaunchHomePanel()
        homePickEl?.focus?.()
      }
    }
  }
  if (homeListEl) {
    homeListEl.onclick = (event) => {
      const create = event.target?.closest?.('[data-env-home-create]')
      if (create) {
        closeEnvLaunchHomePanel()
        if (typeof openProjectDialog === 'function') openProjectDialog()
        return
      }
      const manage = event.target?.closest?.('[data-env-home-manage]')
      if (manage) {
        closeEnvLaunchHomePanel()
        if (typeof openPluginHomesDialog === 'function') openPluginHomesDialog()
        return
      }
      const option = event.target?.closest?.('[data-env-home]')
      if (!option) return
      closeEnvLaunchHomePanel()
      selectEnvLaunchHome(option.dataset?.envHome ?? '')
      homePickEl?.focus?.()
    }
  }
  if (envSelectEl) {
    envSelectEl.onchange = () => {
      const nextId = envSelectEl.value
      const matched = envChoices(nextId, currentEnvObj).find((item) => item.id === nextId) || null
      if (matched) currentEnvObj = matched
      paintEnvTrigger(nextId, matched || currentEnvObj)
      if (nextId) void flushEnvLaunchSave({ environment: nextId })
    }
  }
  if (envPickEl) {
    envPickEl.onclick = (event) => {
      event?.stopPropagation?.()
      if (envPanelEl && !envPanelEl.hidden) closeEnvLaunchEnvPanel()
      else openEnvLaunchEnvPanel()
    }
    envPickEl.onkeydown = (event) => {
      if (event.key === 'Escape' && envPanelEl && !envPanelEl.hidden) {
        event.preventDefault()
        event.stopPropagation()
        closeEnvLaunchEnvPanel()
        return
      }
      if (event.key === 'Tab') {
        closeEnvLaunchEnvPanel()
        return
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && envPanelEl?.hidden) {
        event.preventDefault()
        openEnvLaunchEnvPanel()
      }
    }
  }
  if (envPanelEl) {
    envPanelEl.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeEnvLaunchEnvPanel()
        envPickEl?.focus?.()
      }
    }
  }
  if (envListEl) {
    envListEl.onclick = (event) => {
      const manage = event.target?.closest?.('[data-env-manage]')
      if (manage) {
        closeEnvLaunchEnvPanel()
        void (async () => {
          if (dialogEl && !dialogEl.hidden) await closeEnvLaunchConfig()
          if (typeof launchPluginsDialogEl !== 'undefined' && launchPluginsDialogEl && !launchPluginsDialogEl.hidden && typeof closeLaunchPlugins === 'function') {
            await closeLaunchPlugins()
          }
          if (typeof environmentState !== 'undefined') environmentState?.closeDetail?.()
          if (typeof showPane === 'function') await showPane('environments')
        })()
        return
      }
      const option = event.target?.closest?.('[data-env-id]')
      if (!option) return
      closeEnvLaunchEnvPanel()
      selectEnvLaunchEnvironment(option.dataset?.envId ?? '')
      envPickEl?.focus?.()
    }
  }
  if (autoLaunchEl) {
    autoLaunchEl.onchange = () => { void flushEnvLaunchSave() }
  }
  if (dshHomeEnvEl) {
    dshHomeEnvEl.onchange = async () => {
      if (envHomeBusy) { paintDshHomeEnv(); return }
      const want = Boolean(dshHomeEnvEl.checked)
      envHomeBusy = true
      paintDshHomeEnv()
      try {
        if (autoSave.timer || autoSave.inFlight) await flushEnvLaunchSave()
        const target = effectiveLaunchHome()
        if (want && !target) {
          paintDshHomeEnv()
          return
        }
        const data = await post('/api/dsh-homes/env', { home: want ? target : '' })
        state.userDshHome = typeof data.userDshHome === 'string' ? data.userDshHome : (want ? target : '')
        if (data.mode === 'manual' && data.message) paintSaveStatus('error', t(data.message))
        else paintSaveStatus('idle')
      } catch (error) {
        paintSaveStatus('error', t(error.message))
      } finally {
        envHomeBusy = false
        paintDshHomeEnv()
      }
    }
  }

  globalThis.syncEnvLaunchHomes = () => {
    const entry = liveLaunchEntry()
    if (!canManageLaunchEntry(entry)) return
    paintHomes(homeEl?.value ?? entry.dshHome ?? '')
  }

  globalThis.syncEnvLaunchConfig = (env = null) => {
    currentEnvObj = env || null
    const entry = liveLaunchEntry()
    if (!canManageLaunchEntry(entry)) {
      cardEl.hidden = true
      syncedEntryKey = ''
      closeEnvLaunchIcons(true)
      closeEnvLaunchHomePanel()
      closeEnvLaunchEnvPanel()
      if (recoveryHintEl) recoveryHintEl.hidden = true
      return
    }
    cardEl.hidden = false
    const key = `${entry.id}:${env?.id || ''}:${entry.dshHome || ''}:${entry.environment || ''}`
    const isFresh = syncedEntryKey !== key
    syncedEntryKey = key
    iconDraft = entry.icon || 'terminal'
    paintIcons()
    if (nameEl && (isFresh || document.activeElement !== nameEl)) nameEl.value = entry.name || ''
    if (portEl && (isFresh || document.activeElement !== portEl)) portEl.value = entry.port ? String(entry.port) : ''
    paintHomes(entry.dshHome || '')
    paintEnvironments(entry.environment || env?.id || '', env)
    if (autoLaunchEl) autoLaunchEl.checked = entry.autoLaunch === true
    if (deleteEl) deleteEl.hidden = entry.id === DEFAULT_LAUNCH_ID
    if (iconHintEl) iconHintEl.textContent = ''
    if (isFresh) {
      paintSaveStatus('idle')
      void loadRecoveryForEntry(entry)
    } else {
      paintRecovery()
    }
  }

  async function closeEnvLaunchConfig({ afterDelete = false } = {}) {
    if (!dialogEl || dialogEl.hidden || dialogEl.dataset?.dialogClosing) return
    if (!afterDelete && (packBusy || envHomeBusy)) return
    if (!afterDelete) {
      await flushEnvLaunchSave()
      if (dialogEl.hidden || dialogEl.dataset?.dialogClosing) return
    }
    if (typeof closeUiSelect === 'function') closeUiSelect()
    closeEnvLaunchIcons(true)
    closeEnvLaunchHomePanel()
    closeEnvLaunchEnvPanel()
    if (typeof hidePackDialog === 'function') {
      if (!(await hidePackDialog(dialogEl))) return
    } else {
      dialogEl.hidden = true
    }
    activeLaunchEntry = null
    syncedEntryKey = ''
  }
  globalThis.closeEnvLaunchConfig = closeEnvLaunchConfig

  globalThis.openEnvLaunchConfig = async (entry) => {
    if (!entry || entry.backend === 'wsl' || entry.backend === 'ssh') return
    activeLaunchEntry = entry
    syncedEntryKey = ''
    currentEnvObj = resolveEntryEnv(entry)
    if (dialogEl) {
      if (typeof showPackDialog === 'function') showPackDialog(dialogEl, nameEl)
      else dialogEl.hidden = false
    }
    globalThis.syncEnvLaunchConfig(currentEnvObj)
    if (!Array.isArray(environmentState?.list) || !environmentState.list.length) {
      try {
        await environmentState?.reload?.()
        if (!dialogEl || !dialogEl.hidden) {
          currentEnvObj = resolveEntryEnv(liveLaunchEntry()) || currentEnvObj
          globalThis.syncEnvLaunchConfig(currentEnvObj)
        }
      } catch {}
    }
  }

  if (closeEl) closeEl.onclick = () => { void closeEnvLaunchConfig() }
  if (dialogEl && typeof trapPackDialog === 'function') {
    trapPackDialog(dialogEl, () => { void closeEnvLaunchConfig() })
  }

  globalThis.onEnvironmentConfigSaved = (savedEnv) => {
    if (!savedEnv) return
    currentEnvObj = savedEnv
    const entry = liveLaunchEntry()
    if (entry && entry.environment === savedEnv.id) {
      const synced = { ...entry, version: savedEnv.dshVersion, updateChannel: savedEnv.updateChannel }
      updateLaunchEntry(synced)
      if (activeLaunchEntry?.id === synced.id) activeLaunchEntry = synced
      if (pluginLaunchEntry?.id === synced.id) pluginLaunchEntry = synced
    }
    if (canManageLaunchEntry(liveLaunchEntry())) {
      paintEnvironments(liveLaunchEntry()?.environment || savedEnv.id, savedEnv)
    }
  }
})()
