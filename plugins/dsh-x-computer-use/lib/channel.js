/**
 * 把 `@deepseek-ai/dsh-cua` 的 `NativeClient` JSONL 双工流桥接到 DSH-X 外壳 `/api/desktop/computer`。
 *
 * 为什么走内存流而不直接起子进程：
 * 真正持有 Cua Driver、桌面权限与急停开关的是 DSH-X Electron 外壳。
 * dsh 子进程只负责模型工具面与本地附件准入，不加载原生二进制。
 */
import { randomUUID } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'

export function createDshXChannel({ client, sessionPrefix = '', timeoutMs = 30_000 } = {}) {
  const sessionId = sessionPrefix ? `${sessionPrefix}:${randomUUID()}` : randomUUID()
  const stdout = new PassThrough()
  let closed = false
  let buffer = ''
  const inFlight = new Map()
  const pendingWork = new Set()
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  function writeLine(payload) {
    if (closed || stdout.destroyed) return
    stdout.write(`${JSON.stringify(payload)}\n`)
  }

  function handleFrame(line) {
    const trimmed = line.trim()
    if (!trimmed || closed) return
    let frame
    try {
      frame = JSON.parse(trimmed)
    } catch {
      return
    }
    if (frame?.type === 'cancel' && typeof frame.id === 'string') {
      const active = inFlight.get(frame.id)
      if (active) active.abort()
      void client.computer({ op: 'cancel', sessionId, id: frame.id }, { requestTimeoutMs: 5000 }).catch(() => {})
      return
    }
    if (typeof frame?.id !== 'string' || typeof frame?.method !== 'string') return

    const controller = new AbortController()
    inFlight.set(frame.id, controller)
    const task = (async () => {
      try {
        const res = await client.computer({
          op: 'rpc',
          sessionId,
          id: frame.id,
          method: frame.method,
          params: frame.params || {},
        }, { signal: controller.signal, requestTimeoutMs: timeoutMs })
        if (closed) return
        if (res?.error) {
          writeLine({
            id: frame.id,
            error: {
              code: String(res.error.code || 'NATIVE_FAILED'),
              message: String(res.error.message || '桌面操作失败'),
            },
          })
          return
        }
        if (res?.ok === false) {
          writeLine({
            id: frame.id,
            error: {
              code: 'NATIVE_FAILED',
              message: String(res.message || '桌面操作失败'),
            },
          })
          return
        }
        writeLine({ id: frame.id, result: res?.result ?? null })
      } catch (error) {
        if (!closed) {
          writeLine({
            id: frame.id,
            error: {
              code: 'NATIVE_IO',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      } finally {
        inFlight.delete(frame.id)
      }
    })()
    pendingWork.add(task)
    void task.finally(() => { pendingWork.delete(task) })
  }

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (closed) {
        callback()
        return
      }
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        handleFrame(line)
        idx = buffer.indexOf('\n')
      }
      callback()
    },
  })

  function close() {
    if (closed) return
    closed = true
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
    void client.computer({ op: 'closeSession', sessionId }, { requestTimeoutMs: 3000 }).catch(() => {})
    if (!stdout.destroyed) stdout.end()
    resolveDone?.()
  }

  async function waitForClose() {
    close()
    await Promise.allSettled(pendingWork)
  }

  return { sessionId, stdin, stdout, done, close, waitForClose }
}
