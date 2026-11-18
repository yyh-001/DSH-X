/**
 * `/api/desktop` 与 `/api/desktop/computer` 的本机 HTTP 客户端。
 * 只有由 DSH-X 桌面外壳启动的实例才有 `DSH_X_DESKTOP=1` 与 `DSH_X_MANAGER_URL`。
 */

const INFO_TIMEOUT_MS = 5000

export function managerOrigin(env = process.env) {
  const raw = String(env?.DSH_X_MANAGER_URL ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

export function desktopAvailable(env = process.env) {
  return String(env?.DSH_X_DESKTOP ?? '') === '1' && managerOrigin(env) !== ''
}

export function createComputerDesktopClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = INFO_TIMEOUT_MS,
} = {}) {
  const base = managerOrigin(env)
  const enabled = desktopAvailable(env)
  const instance = String(env?.DSH_X_INSTANCE_KEY ?? '').trim()

  async function info() {
    if (!enabled) return { available: false, reason: 'no-desktop' }
    try {
      const response = await fetchImpl(`${base}/api/desktop`, { signal: AbortSignal.timeout(timeoutMs) })
      const data = await response.json().catch(() => ({}))
      return response.ok ? data : { available: false, ...data, status: response.status }
    } catch (error) {
      return {
        available: false,
        reason: 'unreachable',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function computer(payload, { signal, requestTimeoutMs = 30_000 } = {}) {
    if (!enabled) {
      return { ok: false, error: { code: 'NO_DESKTOP', message: '当前实例不是由 DSH-X 桌面外壳启动' } }
    }
    const timer = AbortSignal.timeout(requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timer]) : timer
    try {
      const response = await fetchImpl(`${base}/api/desktop/computer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instance, ...(payload || {}) }),
        signal: combined,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: response.status === 503 ? 'NO_DESKTOP' : 'HTTP_ERROR',
            message: String(data?.error || `HTTP ${response.status}`),
          },
        }
      }
      return data
    } catch (error) {
      if (signal?.aborted) {
        return { ok: false, error: { code: 'NATIVE_CANCELLED', message: '操作已取消' } }
      }
      return {
        ok: false,
        error: {
          code: 'NATIVE_UNREACHABLE',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  return { enabled, base, instance, info, computer }
}
