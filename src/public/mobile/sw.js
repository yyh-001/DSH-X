// DSH-X 手机版 PWA Service Worker
// 只负责缓存 /_dshx/m/ 移动端静态壳资源与对 /_dshx/api/* 做网络优先兜底；
// 严禁拦截或缓存 / 及上游 dsh 实例路径，避免影响 dsh 实时会话、SSE 与 WebSocket。

const SHELL_CACHE = 'dshx-mobile-shell-v2'
const API_CACHE = 'dshx-mobile-api-v1'

const SHELL_CORE_URLS = [
  '/_dshx/m/',
  '/_dshx/m/index.html',
  '/_dshx/m/style.css',
  '/_dshx/m/app.js',
  '/_dshx/m/manifest.json',
]

// 图标属于可选静态资源：部分环境尚未映射 icon.png 时不能拖垮整个 SW 安装
const SHELL_OPTIONAL_URLS = [
  '/_dshx/m/icon.png',
]

// 只对无敏感凭证且适合离线只读展示的 API 路径允许写离线兜底缓存；
// health（用于测速选路）、pair/*、logs、devices 始终直连不落缓存。
function isCacheableApiPath(pathname) {
  return pathname === '/_dshx/api/instances' || pathname === '/_dshx/api/me'
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    await cache.addAll(SHELL_CORE_URLS)
    await Promise.all(
      SHELL_OPTIONAL_URLS.map(async (url) => {
        try {
          const res = await fetch(url)
          if (res.ok) await cache.put(url, res)
        } catch {
          // 忽略可选图标拉取失败
        }
      })
    )
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
        .map((key) => caches.delete(key))
    )
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // 非同源请求（例如跨链路测速探测其他端点的 /_dshx/api/health）直接放行，避免 SW 吞掉超时信号
  if (url.origin !== self.location.origin) return

  const { pathname } = url

  // 上游 dsh 路径与 /_dshx/open/* 彻底透传，绝不介入也不缓存
  if (!pathname.startsWith('/_dshx/m/') && !pathname.startsWith('/_dshx/api/')) {
    return
  }

  // API 路径：网络优先，避免读到陈旧状态；断网时仅对白名单只读接口回退缓存，其余返回离线 JSON
  if (pathname.startsWith('/_dshx/api/')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request)
        if (res.ok && isCacheableApiPath(pathname)) {
          const cache = await caches.open(API_CACHE)
          cache.put(request, res.clone()).catch(() => {})
        }
        return res
      } catch {
        if (isCacheableApiPath(pathname)) {
          const cached = await caches.match(request)
          if (cached) return cached
        }
        return new Response(
          JSON.stringify({ ok: false, offline: true, error: 'Network unavailable' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }
        )
      }
    })())
    return
  }

  // /_dshx/m/* 移动端静态壳：网络优先 + 缓存兜底，既保证核心升级后尽快生效，又支持弱网/离线秒开壳页
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE)
    try {
      const res = await fetch(request)
      if (res.ok && res.type === 'basic') {
        cache.put(request, res.clone()).catch(() => {})
      }
      return res
    } catch {
      const cached = await cache.match(request)
      if (cached) return cached
      // 带查询参数的入口页（如 /_dshx/m/?pair=...）断网时回退到无参壳页
      if (request.mode === 'navigate' || pathname === '/_dshx/m/') {
        const fallback = await cache.match('/_dshx/m/index.html') || await cache.match('/_dshx/m/')
        if (fallback) return fallback
      }
      throw new Error('Offline and no cached asset available')
    }
  })())
})
