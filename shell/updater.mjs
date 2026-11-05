// 外壳/Electron 的自更新：electron-updater（NSIS / dmg）。
//
// 核心（用户目录的 core/current）由 npm 通道更新；这里只管安装包本身——
// Electron 版本、外壳窗口/托盘/更新器代码。状态通过 host 暴露给管理页，进度走 SSE shellUpdate 事件。

import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
/** npm 版（CLI 拉起的外壳）：更新由 npm 负责，这里不启用。 */
const NPM_MODE = process.env.DSH_NPM === '1'
/**
 * mac 包是临时签名，electron-updater 换不上去；发布页也不再放 zip / latest-mac.yml，
 * 干脆当不支持，免得每次启动都报查不到更新清单。DSH_UPDATE_FEED 留给本地演练。
 *
 * Linux 只有 AppImage 能自更新：electron-updater 靠 APPIMAGE 环境变量找到要替换的那个文件。
 * deb 装出来的是 /opt 下的普通目录，没有这个变量，硬查会抛 "APPIMAGE env is not defined"，
 * 所以这里先当不支持——用户从发布页换包，核心那层照旧走 npm。DSH_UPDATE_FEED 同样留给演练。
 */
const SHELL_UPDATE_SUPPORTED =
  (process.platform !== 'darwin' || Boolean(process.env.DSH_UPDATE_FEED)) &&
  (process.platform !== 'linux' || Boolean(process.env.APPIMAGE) || Boolean(process.env.DSH_UPDATE_FEED))

/** electron-updater 的报错带一大段 HTTP 头/堆栈；页面只留第一句，缺 latest.yml 时给人话。 */
function friendlyError(error) {
  const raw = error?.message || String(error)
  if (/Cannot find latest.yml/i.test(raw)) return '发布页还没有外壳更新资产（latest.yml）'
  return String(raw).split('\n')[0]
}

/**
 * @param {object} options
 * @param {() => Promise<void>} [options.onBeforeInstall] 安装前收尾（停 dsh、关服务）
 * @param {string} [options.version] 外壳版本（源码运行时 app.getVersion() 可能是 Electron 的版本）
 */
export function createUpdater({ onBeforeInstall, version } = {}) {
  const enabled = SHELL_UPDATE_SUPPORTED && !NPM_MODE && (app.isPackaged || Boolean(process.env.DSH_UPDATE_FEED))
  const state = {
    status: enabled ? 'idle' : 'disabled',
    current: String(version || app.getVersion()),
    latest: '',
    progress: null,
    error: '',
  }
  const listeners = new Set()
  const snapshot = () => ({ ...state, progress: state.progress ? { ...state.progress } : null })
  const emit = () => {
    const value = snapshot()
    for (const listener of listeners) {
      try { listener(value) } catch { /* 页面不在也不影响更新 */ }
    }
  }
  if (enabled) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    // 当前外壳自己就是预发布版时必须继续收预发布，否则等于把自己的通道降级了
    // （和 electron-updater 对 currentVersion 的默认判断一致）
    const currentIsPrerelease = String(version || app.getVersion()).includes('-')
    autoUpdater.allowPrerelease = currentIsPrerelease
    if (process.env.DSH_UPDATE_FEED) {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DSH_UPDATE_FEED })
    }
    autoUpdater.on('checking-for-update', () => { state.status = 'checking'; state.error = ''; emit() })
    autoUpdater.on('update-available', (info) => { state.status = 'available'; state.latest = String(info?.version || ''); emit() })
    autoUpdater.on('update-not-available', () => { state.status = 'current'; state.latest = ''; emit() })
    autoUpdater.on('download-progress', (progress) => {
      state.status = 'downloading'
      state.progress = {
        percent: Number(progress?.percent) || 0,
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
      }
      emit()
    })
    autoUpdater.on('update-downloaded', (info) => {
      state.status = 'ready'
      state.latest = String(info?.version || state.latest)
      state.progress = { percent: 100, transferred: state.progress?.total || 0, total: state.progress?.total || 0 }
      emit()
    })
    autoUpdater.on('error', (error) => {
      state.status = 'error'
      state.error = friendlyError(error)
      emit()
    })
  }

  return {
    state: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async check() {
      if (!enabled) return snapshot()
      state.status = 'checking'
      state.error = ''
      emit()
      try {
        await autoUpdater.checkForUpdates()
      } catch (error) {
        state.status = 'error'
        state.error = friendlyError(error)
        emit()
      }
      return snapshot()
    },
    async download() {
      if (!enabled) return snapshot()
      if (state.status === 'ready') return snapshot()
      try {
        await autoUpdater.downloadUpdate()
      } catch (error) {
        state.status = 'error'
        state.error = friendlyError(error)
        emit()
      }
      return snapshot()
    },
    async install() {
      if (!enabled || state.status !== 'ready') return false
      if (onBeforeInstall) await onBeforeInstall()
      // 静默安装并自动拉起新版；before-quit 里已经放行（调用方负责置 quitting）
      autoUpdater.quitAndInstall(true, true)
      return true
    },
  }
}
