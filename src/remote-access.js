import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import {
  DeviceAuthStore,
  IpRateLimiter,
  PairingManager,
  WsTicketStore,
  buildClearDeviceCookie,
  buildDeviceCookie,
  cookieWriteCsrfOk,
  extractClientIP,
  extractDeviceToken,
  isLoopbackAddress,
} from './device-auth.js'
import { pickLanAddress } from './lan-proxy.js'
import { renderQrSvg } from './qrcode.js'
import {
  HEALTH_PATH,
  MOBILE_ROOT_PATH,
  PAIR_COMPLETE_PATH,
  startRemoteGateway,
} from './remote-gateway.js'
import { createSecretStore, isSecretEnvelope } from './secret-store.js'
import { safeRemoteAccess } from './settings.js'
import {
  CloudflareTunnelManager,
  getStableMachineId,
  probeCloudflareEdge,
} from './tunnel-cloudflare.js'

/**
 * 移动与远程访问总控模块（Issue #124）：
 * 将设备级鉴权（device-auth）、离线二维码（qrcode）、统一反代网关（remote-gateway）与
 * Cloudflare Tunnel 托管（tunnel-cloudflare）粘合成一套自包含生命周期控制器，供 server.js 挂载。
 *
 * 为什么采用「127.0.0.1 主监听 + 可选局域网 IPv4 伴随监听」双监听器而不是直接绑 0.0.0.0：
 * - 和 lan-proxy.js 一脉相承：cloudflared 永远连本地 127.0.0.1:<port>，即使切换 Wi-Fi 或局域网
 *   端口被占用，公网隧道与本机访问都纹丝不动；
 * - 两个监听器共享同一份鉴权存储、控制面路由和吊销钩子，踢掉一台设备会同时掐断局域网与公网 WS。
 */

const TUNNEL_TOKEN_FILE = 'cf-tunnel-token.json'
const REMOTE_SECRET_KEY_FILE = 'remote-access-key'
const MAX_JSON_BODY_BYTES = 64 * 1024
const WS_TICKET_TTL_MS = 30_000
const DEFAULT_LOGS_LIMIT = 150
const MAX_LOGS_LIMIT = 500

const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    let finished = false
    const fail = (message, statusCode) => {
      if (finished) return
      finished = true
      const err = new Error(message)
      err.statusCode = statusCode
      rejectBody(err)
    }
    req.on('data', (chunk) => {
      if (finished) return
      total += chunk.length
      if (total > maxBytes) {
        req.resume()
        fail('请求体过大', 413)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      if (!total) {
        resolveBody({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
        resolveBody(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        const err = new Error('无效的 JSON 请求体')
        err.statusCode = 400
        rejectBody(err)
      }
    })
    req.on('error', (err) => fail(err?.message || '读取请求失败', 400))
  })
}

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return ''
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

/** 原子写入敏感文件（0600 权限），避免崩溃时留下半截文件。 */
function writeJsonSecretAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows 等平台忽略 */ }
    renameSync(tmp, filePath)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    throw err
  }
}

/**
 * 将配对载荷编码为与 `src/public/mobile/app.js`（`parseUrlPairing`）完全对齐的 base64url 字符串。
 * 手机扫码后不仅拿到一次性 code，还能直接记住主机名与局域网/公网/自定义多条链路用于测速选路。
 */
export function encodePairingPayload({ code, hostId = '', hostName = '', endpoints = {} }) {
  const cleanEndpoints = {}
  const lan = normalizeOrigin(endpoints.lan)
  const tunnel = normalizeOrigin(endpoints.tunnel)
  const custom = normalizeOrigin(endpoints.custom)
  if (lan) cleanEndpoints.lan = lan
  if (tunnel) cleanEndpoints.tunnel = tunnel
  if (custom) cleanEndpoints.custom = custom

  const payload = {
    code: String(code || '').trim(),
    ...(hostId ? { hostId: String(hostId).slice(0, 64) } : {}),
    ...(hostName ? { hostName: String(hostName).slice(0, 40) } : {}),
    ...(Object.keys(cleanEndpoints).length ? { endpoints: cleanEndpoints } : {}),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** 生成与手机端 PWA 兼容的扫码 URL（`/_dshx/m/#pair=<base64url>`，fragment 不进入服务端/代理日志）。 */
export function buildPairingUrl(origin, payload) {
  const base = normalizeOrigin(origin)
  if (!base) return ''
  const encoded = encodePairingPayload(payload)
  return `${base}${MOBILE_ROOT_PATH}#pair=${encoded}`
}

function renderSafeQrSvg(url, fallbackPayload) {
  if (!url) return ''
  try {
    return renderQrSvg(url, { ecc: 'M' })
  } catch {
    try {
      return renderQrSvg(url, { ecc: 'L' })
    } catch {
      // 极端情况下（自定义域名极长）退回到最小载荷，保证二维码始终能渲染出来
      const origin = normalizeOrigin(url)
      if (!origin || !fallbackPayload?.code) return ''
      const minimal = `${origin}${MOBILE_ROOT_PATH}#pair=${encodeURIComponent(fallbackPayload.code)}`
      return renderQrSvg(minimal, { ecc: 'L' })
    }
  }
}

function isPathInside(rootDir, candidatePath) {
  const normRoot = process.platform === 'win32' ? rootDir.toLowerCase() : rootDir
  const normTarget = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath
  return normTarget.startsWith(`${normRoot}${sep}`)
}

function sanitizePublicInstance(inst, activeKey) {
  const status = String(inst?.status || (inst?.port ? 'running' : 'stopped'))
  const ready = inst?.ready !== undefined
    ? Boolean(inst.ready)
    : (status === 'running' && Number.isInteger(inst?.port) && inst.port > 0)
  return {
    key: String(inst?.key || ''),
    version: String(inst?.version || ''),
    profile: String(inst?.profile || ''),
    name: String(inst?.name || ''),
    status,
    ready,
    active: Boolean(activeKey && inst?.key === activeKey),
    startedAt: Number.isFinite(inst?.startedAt) ? inst.startedAt : null,
    target: inst?.target ?? 'local',
  }
}

function sanitizePublicLaunch(launch) {
  return {
    id: String(launch?.id || ''),
    name: String(launch?.name || ''),
    version: String(launch?.version || ''),
    profile: String(launch?.profile || ''),
    target: launch?.target ?? 'local',
    runningKey: String(launch?.runningKey || ''),
  }
}

/**
 * 创建移动与远程访问控制器。
 *
 * @param {object} options
 * @param {string} options.appDir 持久化目录（通常是 APP_DIR），存放设备凭证、盐值、机器 ID、加密隧道 token
 * @param {string} options.publicDir 静态资源目录（包含 `mobile/` 与 `icon.png`）
 * @param {() => object} options.getSettings 读取当前设置（返回包含 `remoteAccess` 的完整设置对象或直接返回 `remoteAccess`）
 * @param {(nextRemoteAccess: object) => (void | Promise<void>)} options.updateSettings 持久化更新后的 `remoteAccess` 配置
 * @param {() => { hostId?: string, hostName?: string, version?: string }} [options.getHostInfo]
 * @param {() => (Array<object> | Promise<Array<object>>)} [options.getInstances]
 * @param {() => (Array<object> | Promise<Array<object>>)} [options.getLaunches]
 * @param {(params: { launchId?: string, version?: string, profile?: string }) => Promise<object>} [options.startLaunch]
 * @param {(params: { key?: string, version?: string, profile?: string }) => Promise<void>} [options.stopInstance]
 * @param {(params: { key?: string, limit: number }) => (Array<string> | Promise<Array<string>>)} [options.getLogs]
 * @param {() => (string | string[])} [options.getMirrorPrefix]
 * @param {(message: string) => void} [options.onLog]
 * @param {() => void} [options.onChange]
 * @param {() => string} [options.pickLanAddressFn]
 * @param {(opts?: object) => Promise<object>} [options.probeEdgeFn]
 * @param {object} [options.tunnelOptions] 透传给 CloudflareTunnelManager（测试注入用）
 * @param {() => number} [options.now]
 */
export function createRemoteAccessController({
  appDir,
  publicDir,
  getSettings,
  updateSettings,
  getHostInfo = () => ({}),
  getInstances = () => [],
  getLaunches = () => [],
  startLaunch = async () => { throw new Error('当前环境未提供实例启动能力') },
  stopInstance = async () => { throw new Error('当前环境未提供实例停止能力') },
  getLogs = () => [],
  getMirrorPrefix = () => [],
  onLog = () => {},
  onChange = () => {},
  pickLanAddressFn = pickLanAddress,
  probeEdgeFn = probeCloudflareEdge,
  tunnelOptions = {},
  now = () => Date.now(),
} = {}) {
  if (!appDir) throw new Error('createRemoteAccessController 需要 appDir')
  if (!publicDir) throw new Error('createRemoteAccessController 需要 publicDir')
  if (typeof getSettings !== 'function') throw new Error('createRemoteAccessController 需要 getSettings')
  if (typeof updateSettings !== 'function') throw new Error('createRemoteAccessController 需要 updateSettings')

  mkdirSync(appDir, { recursive: true })

  // 隧道 token 使用纯 Node AES-256-GCM 独立加密存放在 <appDir>/cf-tunnel-token.json（0600），
  // 不进 settings.json，也避免 Windows 上频繁起 PowerShell DPAPI 子进程卡住事件循环。
  const tokenFile = join(appDir, TUNNEL_TOKEN_FILE)
  const tokenSecretStore = createSecretStore({
    keyFile: join(appDir, REMOTE_SECRET_KEY_FILE),
    forceFileKey: true,
  })

  function loadTunnelToken() {
    if (!existsSync(tokenFile)) return ''
    try {
      const parsed = JSON.parse(readFileSync(tokenFile, 'utf8'))
      const envVal = typeof parsed?.envelope === 'string' ? parsed.envelope : ''
      if (!isSecretEnvelope(envVal)) return ''
      return tokenSecretStore.reveal(envVal).trim()
    } catch {
      return ''
    }
  }

  function hasTunnelToken() {
    return Boolean(loadTunnelToken())
  }

  function saveTunnelToken(rawToken) {
    const clean = String(rawToken ?? '').trim()
    if (!clean) return
    const envelope = tokenSecretStore.protect(clean)
    writeJsonSecretAtomic(tokenFile, {
      version: 1,
      envelope,
      updatedAt: now(),
    })
  }

  function clearTunnelToken() {
    try { rmSync(tokenFile, { force: true }) } catch { /* 忽略 */ }
  }

  const stableHostId = getStableMachineId(appDir).slice(0, 16)
  const pairingManager = new PairingManager({ now })
  const wsTickets = new WsTicketStore({ ttlMs: WS_TICKET_TTL_MS, now })
  const pairRateLimiter = new IpRateLimiter({ windowMs: 60_000, maxRequests: 20, now })

  let loopbackGateway = null
  let lanGateway = null
  let gatewayState = {
    running: false,
    port: 0,
    lanHost: '',
    localUrl: '',
    lanUrl: '',
    error: '',
  }
  let lastEdgeProbe = null
  let pairingCache = null
  let opQueue = Promise.resolve()

  function activeGateways() {
    const list = []
    if (loopbackGateway) list.push(loopbackGateway)
    if (lanGateway) list.push(lanGateway)
    return list
  }

  const deviceStore = new DeviceAuthStore(appDir, {
    pairingManager,
    now,
    onDeviceRemoved: (deviceId) => {
      wsTickets.revokeDevice(deviceId)
      for (const gw of activeGateways()) gw.disconnectDevice(deviceId)
    },
    onClearAll: () => {
      wsTickets.clearAll()
      for (const gw of activeGateways()) gw.disconnectAll()
    },
  })

  const tunnelManager = new CloudflareTunnelManager({
    appDir,
    onStatus: () => emitChange(),
    onLog: (entry) => onLog(`[隧道] ${entry.text}`),
    ...tunnelOptions,
  })

  function emitChange() {
    try { onChange() } catch { /* 外部通知异常不影响控制器状态 */ }
  }

  function readConfig() {
    const raw = getSettings()
    const section = raw && typeof raw === 'object' && 'remoteAccess' in raw ? raw.remoteAccess : raw
    return safeRemoteAccess(section)
  }

  function resolveHostMeta() {
    const info = getHostInfo() || {}
    return {
      hostId: String(info.hostId || stableHostId),
      hostName: String(info.hostName || osHostname() || 'DSH-X'),
      version: String(info.version || ''),
    }
  }

  function resolveEndpoints() {
    const config = readConfig()
    const tunnelStatus = tunnelManager.getStatus()
    const tunnelUrl = normalizeOrigin(tunnelStatus.publicUrl || config.tunnel.publicUrl || '')
    const lanUrl = normalizeOrigin(gatewayState.lanUrl || '')
    const customUrl = normalizeOrigin(config.customPublicUrl || '')
    return {
      lan: lanUrl,
      tunnel: tunnelUrl,
      custom: customUrl,
    }
  }

  function buildHostSummary() {
    const meta = resolveHostMeta()
    return {
      hostId: meta.hostId,
      hostName: meta.hostName,
      endpoints: resolveEndpoints(),
    }
  }

  function currentAllowedOrigins() {
    const ep = resolveEndpoints()
    return [gatewayState.localUrl, ep.lan, ep.tunnel, ep.custom].filter(Boolean)
  }

  function formatPairingView(session) {
    if (!session) return null
    const meta = resolveHostMeta()
    const endpoints = resolveEndpoints()
    const primaryOrigin = endpoints.tunnel || endpoints.custom || endpoints.lan || gatewayState.localUrl
    const payload = {
      code: session.code,
      hostId: meta.hostId,
      hostName: meta.hostName,
      endpoints,
    }
    const url = buildPairingUrl(primaryOrigin, payload)
    const lanUrl = endpoints.lan ? buildPairingUrl(endpoints.lan, payload) : ''

    if (
      pairingCache
      && pairingCache.code === session.code
      && pairingCache.url === url
      && pairingCache.lanUrl === lanUrl
    ) {
      return { ...pairingCache, expiresAt: session.expiresAt }
    }

    const svg = renderSafeQrSvg(url, payload)
    const lanSvg = lanUrl ? (lanUrl === url ? svg : renderSafeQrSvg(lanUrl, payload)) : ''
    pairingCache = {
      code: session.code,
      expiresAt: session.expiresAt,
      url,
      lanUrl,
      svg,
      lanSvg,
    }
    return { ...pairingCache }
  }

  function getTunnelStatusView() {
    const st = tunnelManager.getStatus()
    return {
      state: st.state,
      mode: st.mode,
      publicUrl: st.publicUrl,
      subdomain: st.subdomain,
      locations: st.locations,
      edgeProbe: st.edgeProbe || lastEdgeProbe,
      lastError: st.lastError,
      binaryPath: st.binaryPath,
    }
  }

  function getGatewayStatusView() {
    return { ...gatewayState }
  }

  function getStatus() {
    const config = readConfig()
    const meta = resolveHostMeta()
    const latestSession = pairingManager.latestSession()
    return {
      config: {
        ...config,
        tunnel: {
          ...config.tunnel,
          hasToken: hasTunnelToken(),
        },
      },
      gateway: getGatewayStatusView(),
      tunnel: getTunnelStatusView(),
      devices: deviceStore.listDevices(),
      pairing: latestSession && gatewayState.running ? formatPairingView(latestSession) : null,
      host: {
        hostId: meta.hostId,
        hostName: meta.hostName,
      },
    }
  }

  /* ------------------------------------------------ 网关鉴权、静态壳与控制面 API */

  function authenticateRequest(req) {
    const extracted = extractDeviceToken(req)
    if (!extracted) return null
    const device = deviceStore.validateToken(extracted.token)
    if (!device) return null
    const isLoopbackPeer = isLoopbackAddress(req.socket?.remoteAddress || '')
    const clientIP = extractClientIP(req, { trustProxy: isLoopbackPeer })
    deviceStore.updateLastSeen(device.deviceId, clientIP)
    return { ...device, source: extracted.source }
  }

  function authenticateWs(req, url) {
    const ticket = url.searchParams.get('ws_ticket')
    if (!ticket) return null
    const validated = wsTickets.validate(ticket)
    if (!validated) return null
    const device = deviceStore.getDevice(validated.deviceId)
    if (!device) return null
    const isLoopbackPeer = isLoopbackAddress(req.socket?.remoteAddress || '')
    const clientIP = extractClientIP(req, { trustProxy: isLoopbackPeer })
    deviceStore.updateLastSeen(device.deviceId, clientIP)
    return { ...device, source: 'ws-ticket' }
  }

  async function resolveRunningInstances() {
    const list = await Promise.resolve(getInstances())
    if (!Array.isArray(list)) return []
    return list.filter((inst) => inst && inst.status === 'running' && Number.isInteger(inst.port) && inst.port > 0)
  }

  async function resolveInstanceByKey(key) {
    const running = await resolveRunningInstances()
    return running.find((inst) => inst.key === key) || null
  }

  async function serveMobileStatic(req, res, ctx) {
    const { pathname, url } = ctx
    if (pathname === '/_dshx/m') {
      const target = url.search ? `${MOBILE_ROOT_PATH}${url.search}` : MOBILE_ROOT_PATH
      res.writeHead(302, { location: target, 'cache-control': 'no-store' })
      res.end()
      return true
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return true
    }

    let rel = pathname.slice(MOBILE_ROOT_PATH.length)
    if (!rel) rel = 'index.html'
    try {
      rel = decodeURIComponent(rel)
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_path' })
      return true
    }
    if (!rel || rel.includes('\0') || rel.includes('\\')) {
      sendJson(res, 400, { ok: false, error: 'invalid_path' })
      return true
    }

    const mobileRoot = resolve(publicDir, 'mobile')
    let filePath = ''

    // PWA 图标 `/_dshx/m/icon.png` 优先复用 mobile 内图标，缺失时直接映射到桌面端已有 512x512 图标
    if (rel === 'icon.png') {
      const candidates = [
        join(mobileRoot, 'icon.png'),
        resolve(publicDir, 'icon.png'),
        resolve(publicDir, '..', 'assets', 'icon.png'),
      ]
      filePath = candidates.find((p) => existsSync(p)) || ''
    } else {
      const candidate = resolve(mobileRoot, rel)
      if (!isPathInside(mobileRoot, candidate)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return true
      }
      filePath = candidate
    }

    if (!filePath || !existsSync(filePath)) {
      sendJson(res, 404, { ok: false, error: 'not_found' })
      return true
    }

    let info
    try {
      info = statSync(filePath)
    } catch {
      sendJson(res, 404, { ok: false, error: 'not_found' })
      return true
    }
    if (!info.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not_found' })
      return true
    }

    if (rel !== 'icon.png') {
      try {
        const realRoot = realpathSync(mobileRoot)
        const realTarget = realpathSync(filePath)
        if (!isPathInside(realRoot, realTarget)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return true
        }
      } catch {
        sendJson(res, 404, { ok: false, error: 'not_found' })
        return true
      }
    }

    const ext = extname(filePath).toLowerCase()
    const contentType = rel === 'manifest.json'
      ? 'application/manifest+json; charset=utf-8'
      : (STATIC_MIME_TYPES[ext] || 'application/octet-stream')

    const headers = {
      'content-type': contentType,
      'cache-control': rel === 'index.html' ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    }
    // Service Worker 脚本显式放开根作用域声明头，配合前端按 `/_dshx/m/` 注册
    if (rel === 'sw.js') {
      headers['service-worker-allowed'] = '/'
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      res.end()
      return true
    }
    const content = await readFile(filePath)
    headers['content-length'] = String(content.byteLength)
    res.writeHead(200, headers)
    res.end(content)
    return true
  }

  async function handleControlRequest(req, res, ctx) {
    const { pathname, url, auth, clientIP, isSecure, activeInstanceKey } = ctx

    // 1. 手机 PWA 静态壳（公开）
    if (pathname === '/_dshx/m' || pathname.startsWith(MOBILE_ROOT_PATH)) {
      return serveMobileStatic(req, res, ctx)
    }

    // 2. 公开健康检查与多链路测速端点（CORS 头已由 remote-gateway 写入）
    if (pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return true
      }
      const meta = resolveHostMeta()
      const tunnel = tunnelManager.getStatus()
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return true
      }
      sendJson(res, 200, {
        ok: true,
        version: meta.version,
        hostId: meta.hostId,
        hostName: meta.hostName,
        tunnel: {
          state: tunnel.state,
          publicUrl: tunnel.publicUrl || readConfig().tunnel.publicUrl || '',
        },
      })
      return true
    }

    // 3. 一次性配对提交（公开，IP 限流已由 remote-gateway 拦截）
    if (pathname === PAIR_COMPLETE_PATH) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return true
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, err.statusCode || 400, { ok: false, error: err.message })
        return true
      }
      const code = typeof body.code === 'string' ? body.code : ''
      if (!code.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少配对码' })
        return true
      }
      const paired = deviceStore.pairDevice({
        code,
        deviceName: body.deviceName,
        platform: body.platform,
        deviceKey: body.deviceKey,
        remoteIP: clientIP,
        pairingManager,
      })
      if (!paired) {
        sendJson(res, 401, { ok: false, error: '配对码无效或已过期' })
        return true
      }
      pairingCache = null
      onLog(`新设备已配对：${paired.device.deviceName}（${paired.device.platform}，${clientIP || 'unknown'}）`)
      emitChange()
      sendJson(res, 200, {
        ok: true,
        device: paired.device,
        token: paired.deviceToken,
        host: buildHostSummary(),
      }, {
        'set-cookie': buildDeviceCookie(paired.deviceToken, { secure: isSecure }),
      })
      return true
    }

    // 4. 以下全部为已鉴权控制面 API
    if (pathname === '/_dshx/api/me' && req.method === 'GET') {
      const device = deviceStore.getDevice(auth.deviceId) || auth
      sendJson(res, 200, {
        ok: true,
        device,
        host: buildHostSummary(),
      })
      return true
    }

    if (pathname === '/_dshx/api/instances' && req.method === 'GET') {
      const [rawInstances, rawLaunches] = await Promise.all([
        Promise.resolve(getInstances()),
        Promise.resolve(getLaunches()),
      ])
      const list = Array.isArray(rawInstances) ? rawInstances : []
      const running = list.filter((inst) => inst && inst.status === 'running' && Number.isInteger(inst.port) && inst.port > 0)
      const effectiveActiveKey = (activeInstanceKey && running.some((inst) => inst.key === activeInstanceKey))
        ? activeInstanceKey
        : (running.length === 1 ? running[0].key : '')

      sendJson(res, 200, {
        ok: true,
        instances: list.map((inst) => sanitizePublicInstance(inst, effectiveActiveKey)),
        launches: (Array.isArray(rawLaunches) ? rawLaunches : []).map(sanitizePublicLaunch),
        activeInstanceKey: effectiveActiveKey,
      })
      return true
    }

    if (pathname === '/_dshx/api/instances/start' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, err.statusCode || 400, { ok: false, error: err.message })
        return true
      }
      try {
        const result = await startLaunch({
          launchId: typeof body.launchId === 'string' ? body.launchId : '',
          version: typeof body.version === 'string' ? body.version : '',
          profile: typeof body.profile === 'string' ? body.profile : '',
        })
        sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return true
    }

    if (pathname === '/_dshx/api/instances/stop' && req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, err.statusCode || 400, { ok: false, error: err.message })
        return true
      }
      try {
        await stopInstance({
          key: typeof body.key === 'string' ? body.key : '',
          version: typeof body.version === 'string' ? body.version : '',
          profile: typeof body.profile === 'string' ? body.profile : '',
        })
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return true
    }

    if (pathname === '/_dshx/api/logs' && req.method === 'GET') {
      const key = String(url.searchParams.get('key') || '')
      const rawLimit = Number(url.searchParams.get('limit') || DEFAULT_LOGS_LIMIT)
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(MAX_LOGS_LIMIT, Math.round(rawLimit)))
        : DEFAULT_LOGS_LIMIT
      try {
        const lines = await Promise.resolve(getLogs({ key, limit }))
        sendJson(res, 200, { ok: true, key, lines: Array.isArray(lines) ? lines : [] })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return true
    }

    if (pathname === '/_dshx/api/devices' && req.method === 'GET') {
      const devices = deviceStore.listDevices().map((dev) => ({
        ...dev,
        current: dev.deviceId === auth.deviceId,
      }))
      sendJson(res, 200, { ok: true, devices })
      return true
    }

    if (pathname.startsWith('/_dshx/api/devices/') && req.method === 'DELETE') {
      let targetId = ''
      try {
        targetId = decodeURIComponent(pathname.slice('/_dshx/api/devices/'.length))
      } catch {
        sendJson(res, 400, { ok: false, error: '无效的设备 ID' })
        return true
      }
      if (!targetId) {
        sendJson(res, 400, { ok: false, error: '缺少设备 ID' })
        return true
      }
      const removed = deviceStore.removeDevice(targetId)
      if (!removed) {
        sendJson(res, 404, { ok: false, error: '设备不存在' })
        return true
      }
      emitChange()
      const extraHeaders = targetId === auth.deviceId
        ? { 'set-cookie': buildClearDeviceCookie({ secure: isSecure }) }
        : {}
      sendJson(res, 200, { ok: true }, extraHeaders)
      return true
    }

    if (pathname === '/_dshx/api/ws-ticket' && req.method === 'POST') {
      const ticket = wsTickets.issue(auth.deviceId)
      if (!ticket) {
        sendJson(res, 429, { ok: false, error: 'too_many_tickets' })
        return true
      }
      sendJson(res, 200, { ok: true, ticket, expiresInMs: WS_TICKET_TTL_MS })
      return true
    }

    // 原生 App 壳持有持久化 Bearer Token 时，可在任意可用链路（LAN/Tunnel/自定义）静默换取 HttpOnly 会话 Cookie 以打开 WebView
    if (pathname === '/_dshx/api/session/bootstrap' && req.method === 'POST') {
      if (auth.source !== 'bearer') {
        sendJson(res, 403, { ok: false, error: 'bearer_required' })
        return true
      }
      const extracted = extractDeviceToken(req)
      if (!extracted || extracted.source !== 'bearer' || !extracted.token) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' })
        return true
      }
      const device = deviceStore.getDevice(auth.deviceId) || auth
      sendJson(res, 200, {
        ok: true,
        device,
        host: buildHostSummary(),
      }, {
        'set-cookie': buildDeviceCookie(extracted.token, { secure: isSecure }),
      })
      return true
    }

    return false
  }

  /* ------------------------------------------------ 网关启停与双监听协调 */

  function buildSharedGatewayOptions() {
    return {
      authenticateRequest,
      authenticateWs,
      csrfCheck: (req) => cookieWriteCsrfOk(req, { allowedOrigins: currentAllowedOrigins() }),
      checkPairRateLimit: (clientIP) => pairRateLimiter.check(clientIP),
      handleControlRequest,
      resolveInstance: resolveInstanceByKey,
      listRunningInstances: resolveRunningInstances,
      injectReturnPill: true,
      onError: (msg) => onLog(`网关异常：${msg}`),
    }
  }

  async function stopGateway() {
    const prevLoopback = loopbackGateway
    const prevLan = lanGateway
    loopbackGateway = null
    lanGateway = null
    await Promise.allSettled([
      prevLan?.close?.(),
      prevLoopback?.close?.(),
    ])
    gatewayState = {
      running: false,
      port: 0,
      lanHost: '',
      localUrl: '',
      lanUrl: '',
      error: '',
    }
    pairingCache = null
  }

  async function startGateway(config) {
    await stopGateway()
    const desiredPort = config.gatewayPort || 0
    const shared = buildSharedGatewayOptions()

    try {
      loopbackGateway = await startRemoteGateway({
        ...shared,
        host: '127.0.0.1',
        port: desiredPort,
      })
    } catch (err) {
      const message = err?.code === 'EADDRINUSE'
        ? `远程网关端口 ${desiredPort} 已被占用`
        : (err?.message || String(err))
      gatewayState = {
        running: false,
        port: 0,
        lanHost: '',
        localUrl: '',
        lanUrl: '',
        error: message,
      }
      onLog(`远程网关启动失败：${message}`)
      throw err
    }

    const boundPort = loopbackGateway.port
    let lanHost = ''
    let lanUrl = ''
    let lanError = ''

    if (config.bindLan) {
      const candidateLan = pickLanAddressFn()
      if (!candidateLan) {
        lanError = '未检测到可用的局域网 IPv4 地址，当前仅支持本机/隧道接入'
        onLog(lanError)
      } else {
        try {
          lanGateway = await startRemoteGateway({
            ...shared,
            host: candidateLan,
            port: boundPort,
          })
          lanHost = candidateLan
          lanUrl = `http://${candidateLan}:${boundPort}`
          onLog(`局域网远程网关已监听 ${lanUrl}`)
        } catch (err) {
          lanError = err?.code === 'EADDRINUSE'
            ? `局域网地址 ${candidateLan}:${boundPort} 已被占用，当前仅保留本机/隧道入口`
            : `局域网网关监听失败（${candidateLan}:${boundPort}）：${err?.message || err}`
          onLog(lanError)
        }
      }
    }

    gatewayState = {
      running: true,
      port: boundPort,
      lanHost,
      localUrl: `http://127.0.0.1:${boundPort}`,
      lanUrl,
      error: lanError,
    }
    pairingCache = null
    onLog(`远程访问网关已就绪：${gatewayState.localUrl}${lanUrl ? `（局域网 ${lanUrl}）` : ''}`)
    emitChange()
    return getGatewayStatusView()
  }

  /* ------------------------------------------------ 串行队列与外部控制 API */

  function enqueue(task) {
    const run = opQueue.then(task)
    opQueue = run.catch(() => {})
    return run
  }

  async function startTunnelUnlocked({ persistEnabled = true } = {}) {
    const config = readConfig()
    if (!gatewayState.running) {
      if (!config.enabled) {
        throw new Error('请先启用移动与远程网关后再启动公网隧道')
      }
      await startGateway(config)
    }

    const tCfg = config.tunnel
    const token = tCfg.mode === 'token' ? loadTunnelToken() : ''
    if (tCfg.mode === 'token' && !token) {
      throw new Error('Token 模式需要先配置 Cloudflare Tunnel Token')
    }
    if (tCfg.mode === 'worker' && !tCfg.workerUrl) {
      throw new Error('Worker 模式需要先填写 Dispatcher Worker 地址')
    }

    const mirrorPrefix = typeof getMirrorPrefix === 'function' ? getMirrorPrefix() : []
    await tunnelManager.start({
      mode: tCfg.mode,
      targetPort: gatewayState.port,
      token,
      workerUrl: tCfg.workerUrl,
      inviteCode: tCfg.inviteCode,
      publicUrl: tCfg.publicUrl,
      edgeIPVersion: tCfg.edgeIPVersion,
      protocol: tCfg.protocol || 'http2',
      region: tCfg.region,
      dnsResolverAddrs: tCfg.dnsResolvers,
      mirrorPrefix,
    })

    if (persistEnabled && !config.tunnel.enabled) {
      const updated = safeRemoteAccess({
        ...config,
        tunnel: { ...config.tunnel, enabled: true },
      })
      await updateSettings(updated)
    }

    emitChange()
    return {
      ok: true,
      tunnel: getTunnelStatusView(),
      gateway: getGatewayStatusView(),
    }
  }

  async function stopTunnelUnlocked({ persistDisabled = true } = {}) {
    await tunnelManager.stop()
    if (persistDisabled) {
      const config = readConfig()
      if (config.tunnel.enabled) {
        const updated = safeRemoteAccess({
          ...config,
          tunnel: { ...config.tunnel, enabled: false },
        })
        await updateSettings(updated)
      }
    }
    emitChange()
    return {
      ok: true,
      tunnel: getTunnelStatusView(),
    }
  }

  async function start() {
    return enqueue(async () => {
      const config = readConfig()
      if (!config.enabled) return getStatus()
      try {
        await startGateway(config)
      } catch {
        return getStatus()
      }
      if (config.tunnel.enabled) {
        // 隧道启动可能涉及按需下载 cloudflared 或网络探测，不阻塞主服务启动完成
        void enqueue(() => startTunnelUnlocked({ persistEnabled: false })).catch((err) => {
          onLog(`自动启动隧道失败：${err?.message || err}`)
        })
      }
      return getStatus()
    })
  }

  async function applyConfig(patch = {}) {
    return enqueue(async () => {
      const current = readConfig()
      const patchObj = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
      const patchTunnel = patchObj.tunnel && typeof patchObj.tunnel === 'object' && !Array.isArray(patchObj.tunnel)
        ? patchObj.tunnel
        : null

      // 先校验并合并非敏感字段，校验失败时不动已有加密 token
      const mergedDraft = {
        ...current,
        ...patchObj,
        tunnel: {
          ...current.tunnel,
          ...(patchTunnel || {}),
        },
      }
      // 显式剥离仅用于提交的凭据控制字段，绝不透传进 settings.json
      delete mergedDraft.tunnel.token
      delete mergedDraft.tunnel.clearToken
      delete mergedDraft.tunnel.hasToken

      const validated = safeRemoteAccess(mergedDraft, { strict: true })

      if (patchTunnel?.clearToken === true) {
        clearTunnelToken()
      } else if (typeof patchTunnel?.token === 'string' && patchTunnel.token.trim()) {
        saveTunnelToken(patchTunnel.token)
      }

      await updateSettings(validated)

      if (!validated.enabled) {
        await tunnelManager.stop()
        await stopGateway()
        emitChange()
        return getStatus()
      }

      const needRestartGateway = !gatewayState.running
        || current.gatewayPort !== validated.gatewayPort
        || current.bindLan !== validated.bindLan

      const prevPort = gatewayState.port
      if (needRestartGateway) {
        await startGateway(validated)
      }

      const tunnelWasActive = tunnelManager.getStatus().state !== 'stopped'
      if (!validated.tunnel.enabled) {
        if (tunnelWasActive) await tunnelManager.stop()
      } else {
        const tunnelChanged = current.tunnel.mode !== validated.tunnel.mode
          || current.tunnel.workerUrl !== validated.tunnel.workerUrl
          || current.tunnel.inviteCode !== validated.tunnel.inviteCode
          || current.tunnel.publicUrl !== validated.tunnel.publicUrl
          || current.tunnel.edgeIPVersion !== validated.tunnel.edgeIPVersion
          || current.tunnel.protocol !== validated.tunnel.protocol
          || current.tunnel.region !== validated.tunnel.region
          || current.tunnel.dnsResolvers !== validated.tunnel.dnsResolvers
          || Boolean(patchTunnel?.token)
          || prevPort !== gatewayState.port
        if (!tunnelWasActive || tunnelChanged) {
          void enqueue(() => startTunnelUnlocked({ persistEnabled: false })).catch((err) => {
            onLog(`应用配置后启动隧道失败：${err?.message || err}`)
          })
        }
      }

      pairingCache = null
      emitChange()
      return getStatus()
    })
  }

  function createPairing() {
    if (!gatewayState.running) {
      throw new Error('请先启用并启动移动与远程网关')
    }
    const session = pairingManager.generateSession()
    const pairing = formatPairingView(session)
    emitChange()
    return pairing
  }

  function listDevices() {
    return deviceStore.listDevices()
  }

  function renameDevice(deviceId, name) {
    const clean = String(name ?? '').trim()
    if (!clean) {
      const err = new Error('设备名称不能为空')
      err.statusCode = 400
      throw err
    }
    const updated = deviceStore.renameDevice(deviceId, clean)
    if (!updated) {
      const err = new Error('设备不存在')
      err.statusCode = 404
      throw err
    }
    emitChange()
    return updated
  }

  function revokeDevice(deviceId) {
    const ok = deviceStore.removeDevice(deviceId)
    if (!ok) {
      const err = new Error('设备不存在')
      err.statusCode = 404
      throw err
    }
    emitChange()
    return { ok: true }
  }

  function revokeAllDevices() {
    const removed = deviceStore.clearAll()
    emitChange()
    return { ok: true, removed }
  }

  function startTunnel() {
    return enqueue(() => startTunnelUnlocked({ persistEnabled: true }))
  }

  function stopTunnel() {
    return enqueue(() => stopTunnelUnlocked({ persistDisabled: true }))
  }

  async function probeEdge() {
    const edgeProbe = await probeEdgeFn()
    lastEdgeProbe = edgeProbe
    emitChange()
    return { ok: true, edgeProbe }
  }

  function clearInstanceCookies(instanceKey) {
    for (const gw of activeGateways()) {
      gw.clearInstanceCookies(instanceKey)
    }
  }

  async function stop() {
    return enqueue(async () => {
      await tunnelManager.stop()
      await stopGateway()
      deviceStore.flush()
      wsTickets.close()
    })
  }

  return {
    start,
    stop,
    getStatus,
    applyConfig,
    createPairing,
    listDevices,
    renameDevice,
    revokeDevice,
    revokeAllDevices,
    startTunnel,
    stopTunnel,
    probeEdge,
    clearInstanceCookies,
    // 仅供离线集成测试检查内部状态
    _getActiveSocketCount: (deviceId) => activeGateways().reduce((sum, gw) => sum + gw.getActiveSocketCount(deviceId), 0),
    _hasTunnelToken: hasTunnelToken,
  }
}
