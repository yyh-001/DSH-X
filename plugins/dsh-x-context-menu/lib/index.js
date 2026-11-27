/**
 * dsh-x-context-menu 主机侧：右键菜单里那两件只有主机能做的事。
 *
 * 1. `POST /api/x-context-menu/reveal` —— 在系统文件管理器里打开一个目录（或选中一个文件）。
 * 2. `POST /api/x-context-menu/open-url` —— 用系统默认浏览器打开外链。
 *
 * 其余菜单动作（重命名、归档、置顶、分叉、新建会话、复制）全在客户端调 dsh 自己的服务，
 * 不经过这里。两条路由都只认环回来源，并且走 dsh 的连接鉴权（同源 + 登录态），局域网和别的网页都调不到。
 *
 * 不依赖 DSH-X 外壳：浏览器里跑 dsh 时这两个动作照样能用；外壳在场时也只是多一条路。
 */
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Diagnostic name of this Host plugin. */
export const name = 'dsh-x-context-menu'

/** 挂路由的 webServer，加上给路由鉴权的 connection（Host/Origin 检查 + 登录态）。 */
export const inject = ['webServer', 'connection']

const MAX_URL_LENGTH = 2048
const MAX_PATH_LENGTH = 4096
const ROUTE_PREFIX = '/api/x-context-menu'

/**
 * 只放行 http/https：`javascript:`、`file:`、`data:` 一律拒掉。
 * @param {unknown} value - 页面传来的地址。
 * @returns {string} 规范化后的地址，不合规时为空串。
 */
export function allowedUrl(value) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (raw === '' || raw.length > MAX_URL_LENGTH) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  return url.toString()
}

/**
 * 只接受存在的绝对路径；返回它的类型，别的一律拒掉。
 * @param {unknown} value - 页面传来的路径。
 * @returns {{ path: string, kind: 'file' | 'directory' } | null}
 */
export function resolveTarget(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.length > MAX_PATH_LENGTH || !isAbsolute(raw)) return null
  // UNC / 网络路径不碰：statSync 会去连那台机器，Windows 上等于把登录凭据哈希送出去。
  if (/^[\\/]{2}/.test(raw)) return null
  try {
    const stat = statSync(raw)
    if (stat.isDirectory()) return { path: raw, kind: 'directory' }
    if (stat.isFile()) return { path: raw, kind: 'file' }
  } catch {
    // 路径不存在：当作没有目标，别把错误抛给页面。
  }
  return null
}

/**
 * 平台 → 启动命令。纯函数，方便测试。
 * @param {'reveal' | 'url'} action - 要做什么。
 * @param {{ path?: string, kind?: 'file' | 'directory', url?: string }} target
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[], fireAndForget: boolean } | null}
 */
export function openerCommand(action, target, platform = process.platform) {
  if (action === 'url') {
    const url = target?.url ?? ''
    if (url === '') return null
    if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], fireAndForget: true }
    if (platform === 'darwin') return { command: 'open', args: [url], fireAndForget: false }
    return { command: 'xdg-open', args: [url], fireAndForget: false }
  }

  const path = target?.path ?? ''
  if (path === '') return null
  if (platform === 'win32') {
    // explorer 成功时也返回 1，只能当发射后不管；文件要 /select 才会在文件夹里选中。
    const args = target?.kind === 'file' ? [`/select,${path}`] : [path]
    return { command: 'explorer.exe', args, fireAndForget: true }
  }
  if (platform === 'darwin') return { command: 'open', args: ['-R', path], fireAndForget: false }
  return { command: 'xdg-open', args: [target?.kind === 'file' ? path : path], fireAndForget: false }
}

/**
 * DSH-X 外壳借出来的桌面能力（`dsh-x-desktop-notify` 提供的 `dshDesktop` 服务）。
 *
 * 在有外壳的环境里必须优先用它：外壳的 reveal/open 由 Electron 主进程执行，
 * 窗口能正常到前台；插件自己 spawn 的 `explorer.exe` 属于后台进程，Windows 的前台锁
 * 会让窗口停在浏览器后面——用户看到的现象就是「提示打开了，但什么都没弹」。
 *
 * 浏览器模式 / 用户自己起的 dsh 里没有这个服务，返回 null，退回本机 spawn。
 */
function desktopBridge(ctx) {
  try {
    return ctx.get?.('dshDesktop') ?? null
  } catch {
    return null
  }
}

/**
 * 起一个分离的 GUI 进程；不阻塞请求。
 * @param {{ command: string, args: string[], fireAndForget: boolean }} spec
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
function launch(spec) {
  // 测试用：不真的拉窗口。
  if (process.env.DSH_X_CONTEXT_MENU_DRY_RUN === '1') return Promise.resolve({ ok: true, dryRun: true })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      // 不用 detached：Windows 上 detached 的 console 子进程会被直接收掉（见项目记忆）。
      child = spawn(spec.command, spec.args, { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    if (spec.fireAndForget) {
      // 发射成功就算成功（explorer 的退出码不可信）。
      child.unref?.()
      finish({ ok: true })
      return
    }
    child.on('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}` }))
    child.unref?.()
  })
}

/**
 * 只有环回来源能调这两条路由。
 *
 * 带 `X-Forwarded-For` 的不算：DSH-X 的局域网代理从回环连进来、Host 也改写成回环，
 * 只看地址和 Host 会把局域网设备当成本机；代理给每个请求都加了这个头。
 */
export function isLoopbackRequest(req) {
  if (req.headers?.['x-forwarded-for']) return false
  const address = req.socket?.remoteAddress || ''
  const host = String(req.headers?.host || '')
  const localAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
  return localAddress && localHost
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({})
      }
    })
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 */
export function apply(ctx) {
  const routes = [
    {
      path: `${ROUTE_PREFIX}/open-url`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const url = allowedUrl(body?.url)
        if (url === '') {
          sendJson(res, 400, { ok: false, error: 'invalid url' })
          return
        }
        // 外壳在场就走 Electron（窗口能到前台）；失败再退回本机。
        const bridge = desktopBridge(ctx)
        if (typeof bridge?.open === 'function') {
          try {
            const result = await bridge.open(url)
            if (result?.ok !== false) {
              sendJson(res, 200, { ok: true, via: 'desktop' })
              return
            }
          } catch {
            // 外壳调用抛错：当作没有外壳，走本机。
          }
        }
        const outcome = await launch(openerCommand('url', { url }))
        sendJson(res, outcome.ok ? 200 : 500, outcome)
      },
    },
    {
      path: `${ROUTE_PREFIX}/reveal`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const target = resolveTarget(body?.path)
        if (!target) {
          sendJson(res, 400, { ok: false, error: 'invalid path' })
          return
        }
        const bridge = desktopBridge(ctx)
        if (typeof bridge?.reveal === 'function') {
          try {
            const result = await bridge.reveal(target.path)
            if (result?.ok !== false) {
              sendJson(res, 200, { ok: true, via: 'desktop' })
              return
            }
          } catch {
            // 外壳调用抛错：当作没有外壳，走本机。
          }
        }
        const outcome = await launch(openerCommand('reveal', target))
        sendJson(res, outcome.ok ? 200 : 500, outcome)
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden: loopback only' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        // webServer 自己不鉴权也不查 Origin：不过这一关，任意网页都能跨站 POST 过来。
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        Promise.resolve(route.handler(req, res)).catch((error) => {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      },
    }))
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-x-context-menu: routes')
}
