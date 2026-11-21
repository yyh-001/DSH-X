import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { corePackageName, channelOf, coreRegistries, fetchCoreMetadata, installCore, pickCoreRelease, tarballFor } from './core-fetch.mjs'
import { coreSetupPage, coreSetupPaintScript, dataUrl } from './pages.mjs'

function registryHost(registry) {
  try { return new URL(registry).host } catch { return String(registry) }
}

/**
 * 首次启动取核心（dsh-x-core）：安装包里不再带核心，第一次启动（或核心与当前 Electron 对不上）
 * 时从 npm 取一份装进用户目录的 core/current，期间展示带节流进度的独立下载窗。
 */
export function createCoreBootstrap({
  app,
  BrowserWindow,
  net,
  isMac,
  appDir,
  activeCore,
  previousCore,
  version,
  getLang,
  failedCoreVersions,
  showStartupError,
}) {
  let paintAt = 0
  let paintTimer = null
  let paintPending = null

  function showCoreSetupWindow() {
    const window = new BrowserWindow({
      width: 480,
      height: 280,
      resizable: false,
      title: 'DSH-X',
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
      backgroundColor: '#15171c',
      webPreferences: { sandbox: true, contextIsolation: true },
    })
    const close = { byUser: false }
    window.on('closed', () => { if (!close.byUser) app.exit(1) })
    window.loadURL(dataUrl(coreSetupPage(getLang())))
    return {
      window,
      finish() {
        close.byUser = true
        if (!window.isDestroyed()) window.destroy()
      },
    }
  }

  function flushCoreSetupPaint() {
    paintTimer = null
    const job = paintPending
    paintPending = null
    if (!job || !job.window || job.window.isDestroyed()) return Promise.resolve()
    paintAt = Date.now()
    const en = getLang() === 'en'
    const { phase, done = 0, total = 0, version: coreVer = '', source = '' } = job.state
    const extracting = phase === 'extract'
    const known = total > 0
    const percent = extracting ? 100 : known ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0
    const mb = (value) => (value / 1048576).toFixed(1)
    const hint = extracting
      ? (en ? 'Installing the runtime core…' : '正在安装运行核心…')
      : phase === 'download'
        ? (en ? `Downloading the runtime core${coreVer ? ` ${coreVer}` : ''}…` : `正在下载运行核心${coreVer ? ` ${coreVer}` : ''}…`)
        : (en ? 'Contacting the download source…' : '正在连接下载源…')
    const detail = phase === 'download'
      ? (known
        ? `${mb(done)} MB / ${mb(total)} MB · ${percent}%`
        : (en ? `Downloaded ${mb(done)} MB` : `已下载 ${mb(done)} MB`))
      : extracting
        ? (en ? 'Download complete, unpacking (a few seconds)…' : '下载完成，正在解压（通常几秒）…')
        : ''
    const sourceText = source ? (en ? `Source: ${source}` : `下载源：${source}`) : ''
    return job.window.webContents.executeJavaScript(coreSetupPaintScript({
      percent,
      indeterminate: !extracting && !known,
      hint,
      detail,
      source: sourceText,
    })).catch(() => { /* 窗口已经关了 */ })
  }

  /** 首启窗口的进度绘制：按 ~8fps 节流，避免高频 executeJavaScript 堵住渲染。 */
  function paintCoreSetup(window, next, { immediate = false } = {}) {
    if (!window || window.isDestroyed()) return Promise.resolve()
    paintPending = { window, state: next }
    if (immediate) return flushCoreSetupPaint()
    const wait = Math.max(0, 120 - (Date.now() - paintAt))
    if (wait === 0) return flushCoreSetupPaint()
    if (!paintTimer) paintTimer = setTimeout(flushCoreSetupPaint, wait)
    return Promise.resolve()
  }

  /** 按「镜像 → 官方」逐个问；慢镜像最多等 6 秒，别让首启窗口干等。 */
  async function chooseCoreRelease(fetchImpl) {
    const registries = coreRegistries()
    let last = null
    for (const [index, registry] of registries.entries()) {
      try {
        const metadata = await fetchCoreMetadata(corePackageName(), {
          fetchImpl,
          registry,
          timeoutMs: index === 0 ? 6_000 : 30_000,
        })
        const release = pickCoreRelease(metadata, {
          electron: process.versions.electron,
          channel: channelOf(version),
          skip: failedCoreVersions(),
        })
        if (release) return { release, registry }
        last = new Error(`npm 上没有和当前外壳（Electron ${process.versions.electron}）兼容的核心版本`)
      } catch (error) {
        last = error
      }
    }
    throw last || new Error('没有可用的核心下载源')
  }

  /** 从 npm 取一份和当前 Electron 兼容的核心装进 core/current；返回核心目录，失败返回空。 */
  async function setupCore() {
    const setup = showCoreSetupWindow()
    const shownAt = Date.now()
    const fetchImpl = (url, init) => net.fetch(url, init)
    paintCoreSetup(setup.window, { phase: 'connect' })
    try {
      const { release, registry } = await chooseCoreRelease(fetchImpl)
      let currentRegistry = registry
      const paint = (next, options) => paintCoreSetup(setup.window, {
        ...next,
        version: release.version,
        source: registryHost(currentRegistry),
      }, options)
      console.log(`下载核心 ${release.version}（${corePackageName()}，${registryHost(registry)}）`)
      const install = (targetRelease) => installCore({
        release: targetRelease,
        target: activeCore,
        previous: previousCore,
        fetchImpl,
        onPhase: async (phase) => {
          await paint({ phase }, { immediate: true })
          if (phase === 'extract') await new Promise((resolve) => setTimeout(resolve, 80))
        },
        onProgress: ({ done, total }) => paint({ phase: 'download', done, total }),
      })
      try {
        await install(release)
      } catch (error) {
        const alternate = coreRegistries().find((item) => item !== currentRegistry)
        const tarball = alternate && tarballFor(alternate, corePackageName(), release.version)
        if (!tarball) throw error
        console.warn(`从 ${registryHost(currentRegistry)} 下载核心失败，换 ${registryHost(alternate)} 重试：${error?.message || error}`)
        currentRegistry = alternate
        paint({ phase: 'connect' })
        await install({ ...release, tarball })
      }
      try { writeFileSync(join(appDir, 'core', 'pending'), JSON.stringify({ version: release.version, at: Date.now() })) } catch { /* 写不进去只是少了回退保护 */ }
      console.log(`核心已就绪：${activeCore}（${release.version}，${registryHost(currentRegistry)}）`)
      const remain = 1_200 - (Date.now() - shownAt)
      if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain))
      return activeCore
    } catch (error) {
      setup.finish()
      showStartupError('核心下载失败', '第一次启动需要从 npm 下载运行核心。', `${error?.message || error}\n\n检查网络后重新打开 DSH-X。`)
      return ''
    } finally {
      setup.finish()
    }
  }

  return { setupCore }
}
