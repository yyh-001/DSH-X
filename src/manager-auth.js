import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 管理页的访问令牌：一次性 launch token 换长期签名 cookie，模型对齐 dsh 自己的
 * BrowserAuth（@deepseek-ai/dsh-client-connection/src/browser-auth.ts）。
 *
 * 为什么不是账号体系：管理器是单用户控制台，没有「谁做的」要归属；web 模式下真正要挡的
 * 是「拿到 3780 就能装插件、起进程」这件事，一个共享令牌就够了。多用户/角色等真有远端
 * 共用需求再叠，见 issue #101。
 *
 * 两个文件都放在 APP_DIR（settings.json 旁边）：
 * - manager-auth.json   签名密钥，跨重启保留 —— 重启后老 cookie 还有效；
 * - manager-token.json  本次进程的 launch token + 端口，给「另一个 start.js 被唤醒」和
 *                       外部脚本用；每次启动重写。
 *
 * 令牌不是用来挡本机进程的：同一个 OS 用户本来就能读这两个文件。它的边界是
 * 「浏览器里的另一个页面」和「以后真开放到局域网时的远端访客」。
 */

const SECRET_BYTES = 32
const SECRET_VERSION = 1
const COOKIE_VERSION = 1
const COOKIE_PREFIX = 'dsh-x-manager-'
const COOKIE_DAYS = 30
const TOKEN_PARAM = 'token'
const AUTH_FILE = 'manager-auth.json'
const TOKEN_FILE = 'manager-token.json'
const BASE64URL = /^[A-Za-z0-9_-]*$/

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/** 定长比较：长度不同直接 false，别让 timingSafeEqual 抛。 */
function sameSecret(actual, expected) {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function canonicalSecret(value) {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  return decoded?.byteLength === SECRET_BYTES ? decoded : undefined
}

/**
 * 读签名密钥；没有就生成一份。用同步 IO：load 在 startServer 里只跑一次，
 * 而 windows 上并发的 readFile/writeFile 会把「文件不存在」和「刚被别的实例创建」混在一起。
 */
function loadSecret(dir) {
  const file = join(dir, AUTH_FILE)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const secret = canonicalSecret(parsed?.secret)
    if (parsed?.version === SECRET_VERSION && secret) return secret
  } catch { /* 没有 / 坏了都重建 */ }
  const secret = randomBytes(SECRET_BYTES)
  try {
    writeFileSync(file, `${JSON.stringify({ version: SECRET_VERSION, secret: encodeBase64Url(secret) }, null, 2)}\n`, { mode: 0o600 })
  } catch { /* 写不了就只在本进程内有效，重启后需要重新登录 */ }
  return secret
}

/** cookie 名绑 authority：同一个 127.0.0.1 上不同端口的管理页互不串用。 */
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

function cookieValue(headerValue, name) {
  for (const segment of String(headerValue || '').split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function requestAuthority(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || !host) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest()
}

export class ManagerAuth {
  /**
   * @param {Buffer} secret 持久化的签名密钥
   * @param {object} [options]
   * @param {number} [options.maxAgeDays] cookie 生命周期
   */
  constructor(secret, { maxAgeDays = COOKIE_DAYS } = {}) {
    this.secret = secret
    this.maxAge = maxAgeDays * 24 * 60 * 60 * 1000
    /** 本次进程的 launch token：每次启动重新生成，旧 token 立即失效。 */
    this.launchToken = encodeBase64Url(randomBytes(SECRET_BYTES))
  }

  static load(dir, options) {
    return new ManagerAuth(loadSecret(dir), options)
  }

  /**
   * 给地址挂上 launch token，其他查询参数原样保留（外壳要带 `?window=`）。
   * @param {string} baseUrl 形如 http://127.0.0.1:3780/
   * @param {Record<string, string>} [params]
   */
  authenticatedUrl(baseUrl, params = {}) {
    const url = new URL(baseUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    url.searchParams.set(TOKEN_PARAM, this.launchToken)
    return url.href
  }

  /**
   * `GET /?token=...` → 303 到去掉 token 的同一地址并种 cookie。
   * @returns {boolean} 已经自行应答时为 true
   */
  exchange(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/') return false
    const tokens = url.searchParams.getAll(TOKEN_PARAM)
    if (!tokens.length) return false
    if (tokens.length !== 1 || !sameSecret(tokens[0], this.launchToken)) {
      this.unauthorized(res)
      return true
    }
    const authority = requestAuthority(req)
    if (!authority) {
      this.unauthorized(res)
      return true
    }
    const now = Date.now()
    const expiresAt = now + this.maxAge
    const body = encodeBase64Url(Buffer.from(JSON.stringify({
      version: COOKIE_VERSION, authority, issuedAt: now, expiresAt,
    })))
    const value = `v${COOKIE_VERSION}.${body}.${encodeBase64Url(sign(this.secret, body))}`
    // 跳回干净地址：token 留在历史记录 / 地址栏里没有任何好处。
    const rest = new URLSearchParams(url.searchParams)
    rest.delete(TOKEN_PARAM)
    const query = rest.toString()
    res.writeHead(303, {
      'cache-control': 'no-store',
      connection: 'close',
      'location': query ? `/?${query}` : '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${cookieName(authority)}=${value}; Max-Age=${Math.floor(this.maxAge / 1000)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
    })
    res.end()
    return true
  }

  /** 请求是否带着有效 cookie（绑定 Host、未过期、签名正确）。 */
  isAuthenticated(req) {
    const authority = requestAuthority(req)
    if (!authority) return false
    const value = cookieValue(req.headers?.cookie, cookieName(authority))
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 3) return false
    const [version, body, signature] = parts
    if (version !== `v${COOKIE_VERSION}`) return false
    const actual = decodeBase64Url(signature)
    const expected = sign(this.secret, body)
    if (!actual || actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return false
    let payload
    try {
      payload = JSON.parse(decodeBase64Url(body)?.toString('utf8') || '')
    } catch {
      return false
    }
    if (payload?.version !== COOKIE_VERSION || payload.authority !== authority) return false
    const now = Date.now()
    return Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt)
      && payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAge
  }

  /** 没有令牌的页面导航：纯文本 401，和 dsh web 一致，不给登录页。 */
  unauthorized(res) {
    res.writeHead(401, {
      'cache-control': 'no-store',
      connection: 'close',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end('需要访问令牌：打开启动时打印的地址（带 ?token=），或用带令牌的链接重新进入。\n')
  }

  /**
   * 把本次的 launch token 与端口写到数据目录，供另一个进程（被唤醒的 start.js、
   * 外部脚本）拿到可用地址。写不了不影响服务。
   */
  writeSession(dir, { port, url }) {
    try {
      writeFileSync(join(dir, TOKEN_FILE), `${JSON.stringify({ version: 1, token: this.launchToken, port, url, at: Date.now() }, null, 2)}\n`, { mode: 0o600 })
    } catch { /* 只是方便调试，不是必需 */ }
  }
}

/**
 * 读正在跑的那个管理器的地址。第二个 start.js 被 EALREADY 挡下来时靠它拿到
 * 对方的 launch token —— 自己手里这份是空的，直接开 3780 在没 cookie 的浏览器里会被 401。
 * @returns {{ port?: number, url?: string } | null}
 */
export function readManagerSession(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TOKEN_FILE), 'utf8'))
    return typeof parsed?.url === 'string' ? parsed : null
  } catch {
    return null
  }
}
