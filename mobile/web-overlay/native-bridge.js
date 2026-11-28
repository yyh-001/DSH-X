// DSH-X 原生 App 壳桥接层（仅在 Capacitor 原生容器内激活，浏览器 PWA 完全不加载）
// 职责：
// 1. 绕过浏览器跨域与 HTTPS→HTTP 混合内容限制，并发探测局域网/隧道/自定义链路；
// 2. 自动附加持久化 Bearer Token 发起控制面 API 请求；
// 3. 对接原生扫码（ZXing）、Android Keystore / 系统钥匙串、以及 DSH 原版全屏 WebView（经 /_dshx/api/session/bootstrap 静默注入 HttpOnly Cookie）。
(() => {
  const cap = window.Capacitor
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
    return
  }

  const plugins = cap.Plugins || {}
  const httpPlugin = plugins.CapacitorHttp
  const nativePlugin = plugins.DshxNative
  const appPlugin = plugins.App
  const statusBarPlugin = plugins.StatusBar

  function parseJsonResponse(rawData) {
    if (rawData === null || rawData === undefined || rawData === '') return {}
    if (typeof rawData === 'object') return rawData
    if (typeof rawData === 'string') {
      try {
        const parsed = JSON.parse(rawData)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return null
      }
    }
    return null
  }

  function readRetryAfterSec(headers, data) {
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'retry-after') {
          const n = Number(v)
          if (Number.isFinite(n) && n > 0) return Math.ceil(n)
        }
      }
    }
    if (data && Number(data.retryAfterMs) > 0) {
      return Math.ceil(Number(data.retryAfterMs) / 1000)
    }
    return 0
  }

  async function nativeHttpRequest(origin, path, { method = 'GET', body, token = '', timeoutMs = 10000 } = {}) {
    if (!httpPlugin || typeof httpPlugin.request !== 'function') {
      throw new Error('CapacitorHttp plugin unavailable')
    }
    const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`
    const headers = {
      Accept: 'application/json',
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    const reqOpts = {
      url,
      method: String(method || 'GET').toUpperCase(),
      headers,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      responseType: 'text',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      reqOpts.data = body
    }
    const res = await httpPlugin.request(reqOpts)
    const status = Number(res?.status || 0)
    const data = parseJsonResponse(res?.data)
    const retryAfterSec = readRetryAfterSec(res?.headers, data)
    return { status, data, retryAfterSec }
  }

  window.DSHXNative = {
    isNative: true,
    platform: typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'android',

    async request(origin, path, options = {}) {
      return nativeHttpRequest(origin, path, options)
    },

    async probeHealth(origin, timeoutMs = 2500) {
      const startedAt = performance.now()
      try {
        const res = await nativeHttpRequest(origin, '/_dshx/api/health', {
          method: 'GET',
          timeoutMs,
        })
        const rttMs = Math.max(1, Math.round(performance.now() - startedAt))
        if (res.status < 200 || res.status >= 300 || !res.data || res.data.ok !== true) {
          return { ok: false, status: 'error', rttMs: null, data: null }
        }
        return { ok: true, status: 'ok', rttMs, data: res.data }
      } catch (err) {
        const msg = String(err?.message || err || '').toLowerCase()
        const isTimeout = msg.includes('timeout') || msg.includes('timed out')
        return { ok: false, status: isTimeout ? 'timeout' : 'error', rttMs: null, data: null }
      }
    },

    async scanQr() {
      if (!nativePlugin || typeof nativePlugin.scanQr !== 'function') {
        throw new Error('Native QR scanner unavailable')
      }
      return nativePlugin.scanQr()
    },

    async getHostToken(hostId) {
      if (!nativePlugin || typeof nativePlugin.getHostToken !== 'function' || !hostId) return ''
      const res = await nativePlugin.getHostToken({ hostId: String(hostId) })
      return String(res?.token || '')
    },

    async setHostToken(hostId, token) {
      if (!nativePlugin || typeof nativePlugin.saveHostToken !== 'function' || !hostId || !token) return
      await nativePlugin.saveHostToken({ hostId: String(hostId), token: String(token) })
    },

    async deleteHostToken(hostId) {
      if (!nativePlugin || typeof nativePlugin.deleteHostToken !== 'function' || !hostId) return
      await nativePlugin.deleteHostToken({ hostId: String(hostId) })
    },

    async openDshInstance({ origin, instanceKey, token, hostName = '', instanceTitle = '' }) {
      if (!nativePlugin || typeof nativePlugin.openDshInstance !== 'function') {
        throw new Error('Native WebView launcher unavailable')
      }
      return nativePlugin.openDshInstance({
        origin: String(origin || ''),
        instanceKey: String(instanceKey || ''),
        token: String(token || ''),
        hostName: String(hostName || ''),
        instanceTitle: String(instanceTitle || ''),
      })
    },

    onDeepLink(handler) {
      if (!appPlugin || typeof appPlugin.addListener !== 'function' || typeof handler !== 'function') {
        return () => {}
      }
      const handlePromise = appPlugin.addListener('appUrlOpen', (event) => {
        if (event?.url) handler(event.url)
      })
      return () => {
        Promise.resolve(handlePromise).then((h) => h?.remove?.()).catch(() => {})
      }
    },

    setStatusBarTheme(dark) {
      if (!statusBarPlugin || typeof statusBarPlugin.setStyle !== 'function') return
      // Capacitor StatusBar: Style.Dark = light text on dark background; Style.Light = dark text on light background
      statusBarPlugin.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {})
    },

    async getNotificationState() {
      if (!nativePlugin || typeof nativePlugin.getNotificationState !== 'function') {
        return { enabled: false, granted: false }
      }
      return nativePlugin.getNotificationState()
    },

    async configureNotifications({ enabled, hostId = '', hostName = '', origins = [] } = {}) {
      if (!nativePlugin || typeof nativePlugin.configureNotifications !== 'function') {
        return { enabled: false, granted: false }
      }
      return nativePlugin.configureNotifications({
        enabled: Boolean(enabled),
        hostId: String(hostId || ''),
        hostName: String(hostName || ''),
        origins: Array.isArray(origins) ? origins.filter(Boolean) : [],
      })
    },
  }
})()
