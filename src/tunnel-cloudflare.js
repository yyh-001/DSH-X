import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync as fsExistsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { connect as tlsConnect } from 'node:tls'
import { lookup as dnsLookup } from 'node:dns/promises'
import { promisify } from 'node:util'
import { errorMessage, writeJsonAtomicSync } from './fs-utils.js'
import { netFetch } from './proxy.js'

const execFileAsync = promisify(execFile)

/**
 * Cloudflare Tunnel 公网穿透托管与国内网络适配（Issue #124）。
 *
 * 边缘探测、DNS 污染识别、TUN Fake-IP 豁免及日志解析思路移植自开源项目
 * GHSaiMo/antigravity-mobile（MIT License），并按 DSH-X 零第三方运行时依赖的约束
 * 用纯 Node.js 内置模块实现。
 *
 * 三个关键设计约束：
 * 1. TUNNEL_TOKEN 只能通过子进程环境变量传入，绝不放进 argv，避免在任务管理器 / ps 中暴露；
 * 2. 所有外网 HTTP(S) 请求默认走 netFetch（proxy.js），自动兼容系统代理与手动代理；
 * 3. 国内网络常见的 UDP/QUIC 限速、DNS 污染、IPv6 TLS 握手 EOF 均在启动前探测与运行期自愈中处理。
 */

const CLOUDFLARED_RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download'
const DEFAULT_EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']
const CLOUDFLARE_EDGE_PORT = 7844
const DEFAULT_PROBE_TIMEOUT_MS = 4000
const MAX_PROBE_IPS_PER_FAMILY = 4
const EDGE_PREFER_THRESHOLD = 0.85 // 至少快 15% 才锁定单一地址族，否则保留双栈 auto
const MACHINE_ID_FILE = 'machine-id'
const WORKER_CACHE_FILE = 'cf-tunnel.json'

/* ---------------------------------------------------------- IP 分类与 CIDR 匹配 */

/**
 * 归一化 IP 字符串：剥掉方括号、IPv6 区域后缀（%eth0）及 IPv4-mapped IPv6（::ffff:a.b.c.d）。
 * 为什么剥掉 ::ffff:：Node / 双栈套接字经常把 IPv4 映射成 ::ffff:198.41.192.7，
 * 不解包会导致所有 IPv4 CIDR 判断误判为非 Cloudflare 地址。
 */
function normalizeIpString(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return ''
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zoneIndex = text.indexOf('%')
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex)
  const lower = text.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const mapped = text.slice(7)
    if (isIP(mapped) === 4) return mapped
  }
  return text
}

/** 解析 IPv4 为 32 位无符号整数；非法返回 null。 */
function parseIPv4(ip) {
  if (isIP(ip) !== 4) return null
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const num = Number(part)
    if (!Number.isInteger(num) || num < 0 || num > 255) return null
    value = (value * 256) + num
  }
  return value >>> 0
}

/** 解析 IPv6 为 128 位 BigInt（支持 :: 压缩与尾部嵌入 IPv4）；非法返回 null。 */
function parseIPv6(ip) {
  if (isIP(ip) !== 6) return null
  let text = ip.toLowerCase()
  // 处理嵌入 IPv4 尾部（例如 ::ffff:198.41.192.1 或 64:ff9b::198.41.192.1）
  const lastColon = text.lastIndexOf(':')
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  if (halves.length === 1 && missing !== 0) return null
  if (halves.length === 2 && missing < 0) return null

  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left
  if (groups.length !== 8) return null

  let result = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    result = (result << 16n) | BigInt(parseInt(group, 16))
  }
  return result
}

function makeV4Cidr(baseIp, prefixLen) {
  const base = parseIPv4(baseIp)
  const mask = prefixLen === 0 ? 0 : ((0xffffffff << (32 - prefixLen)) >>> 0)
  return { base: (base & mask) >>> 0, mask }
}

function makeV6Cidr(baseIp, prefixLen) {
  const base = parseIPv6(baseIp)
  const shift = BigInt(128 - prefixLen)
  const mask = prefixLen === 0 ? 0n : (((1n << BigInt(prefixLen)) - 1n) << shift)
  return { base: base & mask, mask }
}

/** Cloudflare Tunnel 边缘节点官方段（对应 region1/2.v2.argotunnel.com）。 */
const CF_EDGE_V4_CIDRS = [
  makeV4Cidr('198.41.128.0', 17),
  makeV4Cidr('162.159.0.0', 16),
]
const CF_EDGE_V6_CIDRS = [
  makeV6Cidr('2606:4700::', 32),
  makeV6Cidr('2803:f800::', 32),
]

/** Clash / Mihomo / Sing-box TUN 模式常用的 Fake-IP 网段，豁免于 DNS 污染判定。 */
const FAKE_IP_V4_CIDRS = [
  makeV4Cidr('198.18.0.0', 15),
]
const FAKE_IP_V6_CIDRS = [
  makeV6Cidr('fc00::', 7),
]

function matchesCidrs(rawIp, v4Cidrs, v6Cidrs) {
  const ip = normalizeIpString(rawIp)
  const family = isIP(ip)
  if (family === 4) {
    const num = parseIPv4(ip)
    if (num === null) return false
    return v4Cidrs.some((cidr) => ((num & cidr.mask) >>> 0) === cidr.base)
  }
  if (family === 6) {
    const num = parseIPv6(ip)
    if (num === null) return false
    return v6Cidrs.some((cidr) => (num & cidr.mask) === cidr.base)
  }
  return false
}

/** 判断 IP 是否属于 Cloudflare Tunnel 边缘节点官方段。 */
export function isCloudflareEdgeIP(ip) {
  return matchesCidrs(ip, CF_EDGE_V4_CIDRS, CF_EDGE_V6_CIDRS)
}

/**
 * 判断 IP 是否属于代理工具 TUN Fake-IP 段（198.18.0.0/15 或 fc00::/7）。
 * 为什么必须豁免：用户开启 Clash/Mihomo/Sing-box TUN Fake-IP 时，系统 DNS 对所有域名
 * 都返回 Fake-IP 再由代理接管转发；若把 Fake-IP 当成 DNS 污染拦截，隧道反而会被自己堵死。
 */
export function isProxyFakeIP(ip) {
  return matchesCidrs(ip, FAKE_IP_V4_CIDRS, FAKE_IP_V6_CIDRS)
}

/**
 * 根据 IPv4 / IPv6 实测握手延迟挑选 `--edge-ip-version`：
 * - 单栈可达直接锁定该栈；
 * - 双栈均可达但差距超过 15% 时锁定更快的一侧；
 * - 差距在 15% 以内或均不可达时返回 'auto'，保留 cloudflared 自身双栈容灾能力。
 */
export function chooseEdgeIPVersion(v4RttMs, v6RttMs) {
  const v4Ok = typeof v4RttMs === 'number' && Number.isFinite(v4RttMs) && v4RttMs > 0
  const v6Ok = typeof v6RttMs === 'number' && Number.isFinite(v6RttMs) && v6RttMs > 0
  if (v4Ok && !v6Ok) return '4'
  if (!v4Ok && v6Ok) return '6'
  if (!v4Ok && !v6Ok) return 'auto'
  if (v4RttMs <= v6RttMs * EDGE_PREFER_THRESHOLD) return '4'
  if (v6RttMs <= v4RttMs * EDGE_PREFER_THRESHOLD) return '6'
  return 'auto'
}

/** 默认系统 DNS 解析：走 dns.lookup 而非 dns.resolve，才能与 OS/TUN Fake-IP 行为保持一致。 */
async function defaultResolveEdgeHost(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((item) => item.address)
}

/** 默认边缘探活：向 7844 端口执行真实 TCP + TLS 握手并返回耗时（ms）。 */
function defaultDialEdge({ ip, host, port = CLOUDFLARE_EDGE_PORT, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let settled = false
    const finish = (err, rttMs) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve(rttMs)
    }

    const socket = tlsConnect({
      host: ip,
      port,
      servername: host,
      // 探测仅测链路可达性与 TLS 握手延迟；部分代理/边缘证书链由 cloudflared 自己严格校验
      rejectUnauthorized: false,
    })

    const timer = setTimeout(() => {
      finish(new Error(`边缘探测超时（${ip}:${port}）`))
    }, timeoutMs)
    timer.unref?.()

    socket.once('secureConnect', () => {
      const elapsed = performance.now() - start
      finish(null, Math.max(1, Math.round(elapsed)))
    })
    socket.once('error', (err) => finish(err))
  })
}

/**
 * 启动前边缘探测：解析 region1/2.v2.argotunnel.com，识别并排除被污染 IP，
 * 对合法的 Cloudflare 边缘 IP（或 TUN Fake-IP）并发执行 7844 端口 TLS 测速。
 */
export async function probeCloudflareEdge({
  resolve = defaultResolveEdgeHost,
  dial = defaultDialEdge,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  hosts = DEFAULT_EDGE_HOSTS,
} = {}) {
  const v4Candidates = []
  const v6Candidates = []
  const seenCandidates = new Set()
  const pollutedSet = new Set()
  let fakeIPDetected = false

  // 并发解析 region1 / region2，避免单域名解析慢拖长启动时间
  await Promise.all(hosts.map(async (host) => {
    let entries = []
    try {
      entries = await resolve(host)
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const rawIp = typeof entry === 'string' ? entry : entry?.address
      const ip = normalizeIpString(rawIp)
      const family = isIP(ip)
      if (!family) continue

      const isCf = isCloudflareEdgeIP(ip)
      const isFake = !isCf && isProxyFakeIP(ip)
      if (!isCf && !isFake) {
        pollutedSet.add(ip)
        continue
      }
      if (isFake) fakeIPDetected = true
      if (seenCandidates.has(ip)) continue
      seenCandidates.add(ip)

      if (family === 4) v4Candidates.push({ ip, host, family: 4 })
      else v6Candidates.push({ ip, host, family: 6 })
    }
  }))

  const probeFamily = async (candidates) => {
    const slice = candidates.slice(0, MAX_PROBE_IPS_PER_FAMILY)
    if (!slice.length) return null
    const results = await Promise.all(slice.map(async (target) => {
      const startedAt = performance.now()
      try {
        const res = await withTimeout(
          Promise.resolve(dial({
            ip: target.ip,
            host: target.host,
            port: CLOUDFLARE_EDGE_PORT,
            family: target.family,
            timeoutMs,
          })),
          timeoutMs,
        )
        if (typeof res === 'number' && Number.isFinite(res) && res > 0) return res
        const elapsed = performance.now() - startedAt
        return Math.max(1, Math.round(elapsed))
      } catch {
        return null
      }
    }))
    const valid = results.filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
    return valid.length ? Math.min(...valid) : null
  }

  const [v4RttMs, v6RttMs] = await Promise.all([
    probeFamily(v4Candidates),
    probeFamily(v6Candidates),
  ])

  const polluted = [...pollutedSet]
  const chosen = chooseEdgeIPVersion(v4RttMs, v6RttMs)
  return { v4RttMs, v6RttMs, polluted, chosen, fakeIPDetected }
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('操作超时')), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/* ---------------------------------------------------------- 日志解析器 */

/** 解析 cloudflared 注册成功日志，提取连接序号与边缘机房代码（如 hkg05），兼容 logfmt 与 JSON 输出。 */
export function parseRegisteredLine(line) {
  const text = String(line ?? '')
  if (!text.includes('Registered tunnel connection')) return null
  const connMatch = /"?connIndex"?\s*[:=]\s*(\d+)/.exec(text)
  const locMatch = /"?location"?\s*[:=]\s*"?([A-Za-z0-9_-]+)"?/.exec(text)
  if (!connMatch && !locMatch) return null
  return {
    connIndex: connMatch ? Number(connMatch[1]) : 0,
    location: locMatch ? locMatch[1] : '',
  }
}

const FAILURE_LINE_RE = /\b(failed|error|err|unable|timeout|timed out|eof|refused|reset|unregistered|handshake|retry|retrying|dial)\b/i

/**
 * 从 cloudflared 连接失败日志中提取边缘节点 IP（支持 IPv4 与带方括号的 IPv6）。
 * 用于运行期发现 DNS 污染 IP 或 IPv6 建连异常，仅对包含失败语义的日志生效。
 */
export function parseFailedEdgeIP(line) {
  const text = String(line ?? '')
  if (!text || !FAILURE_LINE_RE.test(text)) return null

  // 1. 优先匹配显式 ip= 字段（cloudflared 结构化字段最准确）
  const ipField = /\bip=(\[?[0-9a-fA-F:.]+\]?)\b/.exec(text)
  if (ipField) {
    const candidate = normalizeIpString(ipField[1])
    if (isIP(candidate)) return candidate
  }

  // 2. 匹配方括号 IPv6:port，例如 dial tcp [2606:4700::1]:7844
  const bracketV6 = /\[([0-9a-fA-F:]+)\](?::\d+)?/.exec(text)
  if (bracketV6) {
    const candidate = normalizeIpString(bracketV6[1])
    if (isIP(candidate) === 6) return candidate
  }

  // 3. 匹配 IPv4:port，例如 dial tcp 198.41.192.7:7844
  const v4Port = /\b(\d{1,3}(?:\.\d{1,3}){3}):\d+\b/.exec(text)
  if (v4Port) {
    const candidate = normalizeIpString(v4Port[1])
    if (isIP(candidate) === 4) return candidate
  }

  // 4. 兜底匹配常见边缘连接报错里的裸 IPv4
  const bareV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text)
  if (bareV4) {
    const candidate = normalizeIpString(bareV4[1])
    if (isIP(candidate) === 4) return candidate
  }

  return null
}

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** 从 Quick Tunnel 输出框中提取临时公网域名。 */
export function parseQuickTunnelUrl(line) {
  const match = QUICK_TUNNEL_URL_RE.exec(String(line ?? ''))
  return match ? match[0].toLowerCase() : null
}

/** 已知的 cloudflared 无害提示日志，不应被当成错误展示给用户。 */
const BENIGN_LOG_PATTERNS = [
  /cannot determine default origin certificate path/i,
  /no file cert\.pem/i,
  /thank you for trying cloudflare tunnel/i,
  /your quick tunnel has been created/i,
  /failed to sufficiently increase receive buffer size/i,
  /icmp proxy/i,
  /starting metrics server/i,
  /generated connector id/i,
  /initial protocol/i,
  /updated to new configuration/i,
  /graceful shutdown/i,
  /quitting\.\.\./i,
  /context canceled/i,
  /cloudflared has not been updated/i,
  /a new version of cloudflared/i,
  /settings:\s*map\[/i,
]

/** 判断一行 cloudflared 日志是否属于可忽略的常见提示/噪音。 */
export function isBenignCloudflareLog(line) {
  const text = String(line ?? '').trim()
  if (!text) return true
  if (BENIGN_LOG_PATTERNS.some((pattern) => pattern.test(text))) return true
  // 正常的 INF 级别日志且不含错误关键词也属于无害输出
  if (/\bINF\b/.test(text) && !/\b(ERR|FTL|failed|error|unauthorized|invalid)\b/i.test(text)) return true
  return false
}

/**
 * 判断日志是否指示 IPv6 TLS 握手 EOF / 异常断开。
 * 国内部分宽带 IPv6 存在 MTU 黑洞或出口丢包，TCP 能连上但 TLS 握手直接 EOF，
 * 需要立刻自动回落到 `--edge-ip-version 4`。
 */
export function isIpv6TlsEofLine(line) {
  const text = String(line ?? '')
  if (!text) return false
  const hasTlsOrEof = /\b(eof|unexpected eof|tls|handshake|connection reset by peer)\b/i.test(text)
  if (!hasTlsOrEof) return false
  const failedIp = parseFailedEdgeIP(text)
  if (failedIp && isIP(failedIp) === 6) return true
  return /\bipv6\b/i.test(text)
}

/* ------------------------------------------------ 稳定机器 ID 与 Worker 分发客户端 */

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/**
 * 读取或生成并持久化 64 位 SHA-256 hex 稳定机器 ID（<appDir>/machine-id，权限 0600）。
 * 为什么必须持久化：网卡变动（插拔 USB 网卡、开关 VPN 虚拟网卡）会让动态指纹变化，
 * 一旦变化 Worker 就会分配新子域名，导致手机端已保存的公网地址失效。
 */
export function getStableMachineId(appDir, {
  hostname = osHostname(),
  interfaces = osNetworkInterfaces(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const filePath = join(appDir, MACHINE_ID_FILE)
  try {
    const existing = readFileSync(filePath, 'utf8').trim()
    if (SHA256_HEX_RE.test(existing)) return existing.toLowerCase()
  } catch { /* 首次生成或文件损坏则重建 */ }

  const macs = new Set()
  for (const list of Object.values(interfaces || {})) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || item.internal) continue
      const mac = String(item.mac || '').trim().toLowerCase()
      if (mac && mac !== '00:00:00:00:00:00') macs.add(mac)
    }
  }

  const seedParts = [
    String(platform || ''),
    String(arch || ''),
    String(hostname || ''),
    ...[...macs].sort(),
  ]
  // 若受限容器/沙箱拿不到任何有效网卡 MAC，混入随机熵避免多台匿名机器撞子域名
  if (macs.size === 0) seedParts.push(randomBytes(16).toString('hex'))

  const id = createHash('sha256').update(seedParts.join('|')).digest('hex')

  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${id}\n`, { mode: 0o600 })
    renameSync(temp, filePath)
    if (process.platform !== 'win32') {
      try { chmodSync(filePath, 0o600) } catch { /* ignore */ }
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
  return id
}

function normalizeWorkerUrl(workerUrl) {
  const raw = String(workerUrl ?? '').trim()
  if (!raw) throw new Error('请先配置 Dispatcher Worker 地址')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`无效的 Worker 地址：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Worker 地址必须是 http 或 https：${raw}`)
  }
  return parsed.href.replace(/\/+$/, '')
}

function extractSubdomainFromUrl(publicUrl, fallbackSubdomain = '') {
  if (fallbackSubdomain) return String(fallbackSubdomain)
  try {
    const host = new URL(publicUrl).hostname
    return host.split('.')[0] || ''
  } catch {
    return ''
  }
}

/**
 * 向自建 Cloudflare Dispatcher Worker 幂等注册/获取专属隧道凭证，并缓存到 <appDir>/cf-tunnel.json（0600）。
 * 当 workerUrl、machineId 或本地网关 targetPort 变化时自动刷新注册，确保云端 Ingress 端口与本机同步。
 */
export async function registerOrFetchWorkerTunnel({
  appDir,
  workerUrl,
  inviteCode = '',
  targetPort,
  fetchFn = netFetch,
  forceRefresh = false,
  platform = process.platform,
  arch = process.arch,
  machineId,
  signal,
} = {}) {
  const normalizedUrl = normalizeWorkerUrl(workerUrl)
  const resolvedMachineId = machineId || getStableMachineId(appDir, { platform, arch })
  const cachePath = join(appDir, WORKER_CACHE_FILE)

  if (!forceRefresh) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      const sameWorker = cached?.workerUrl === normalizedUrl
      const sameMachine = cached?.machineId === resolvedMachineId
      const samePort = targetPort === undefined || cached?.targetPort === targetPort
      if (sameWorker && sameMachine && samePort && cached?.token && cached?.publicUrl) {
        return { ...cached, cached: true }
      }
    } catch { /* 缓存缺失或损坏时重新向 Worker 注册 */ }
  }

  const endpoint = `${normalizedUrl}/api/tunnel/register`
  const headers = { 'content-type': 'application/json' }
  const code = String(inviteCode || '').trim()
  if (code) headers['x-invite-code'] = code

  const payload = {
    machine_id: resolvedMachineId,
    platform,
    invite_code: code,
    ...(targetPort !== undefined ? { target_port: Number(targetPort) } : {}),
  }

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  const rawText = await response.text()
  let data = null
  try {
    data = rawText ? JSON.parse(rawText) : null
  } catch {
    data = null
  }

  if (!response.ok) {
    const detail = data?.error || data?.message || rawText.trim() || `HTTP ${response.status}`
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Worker 鉴权失败（邀请码无效或无权限）：${detail}`)
    }
    throw new Error(`Worker 注册隧道失败（HTTP ${response.status}）：${detail}`)
  }

  const token = String(data?.token || data?.tunnel_token || '').trim()
  const hostname = String(data?.hostname || data?.domain || '').trim()
  const publicUrl = String(
    data?.public_url || data?.publicUrl || data?.url || (hostname ? `https://${hostname}` : ''),
  ).trim().replace(/\/+$/, '')

  if (!token || !publicUrl) {
    throw new Error('Worker 返回的隧道凭证不完整（缺少 token 或 public_url）')
  }

  const record = {
    tunnelId: String(data?.tunnel_id || data?.tunnelId || ''),
    token,
    subdomain: extractSubdomainFromUrl(publicUrl, data?.subdomain),
    hostname: hostname || new URL(publicUrl).hostname,
    publicUrl,
    workerUrl: normalizedUrl,
    targetPort: targetPort !== undefined ? Number(targetPort) : (data?.target_port ?? null),
    machineId: resolvedMachineId,
    updatedAt: Date.now(),
  }

  writeJsonAtomicSync(cachePath, record, { mode: 0o600 })
  if (process.platform !== 'win32') {
    try { chmodSync(cachePath, 0o600) } catch { /* ignore */ }
  }
  return { ...record, cached: false }
}

/* ------------------------------------------- cloudflared 二进制发现与按需下载 */

/**
 * 映射官方 cloudflare/cloudflared GitHub Releases 资产名。
 * 为什么 win32-arm64 也用 amd64.exe：Cloudflare 官方未发布原生 Windows ARM64 二进制，
 * Windows 11 ARM64 通过系统模拟层运行 amd64.exe 兼容性最好。
 */
export function cloudflaredAssetForPlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  const table = {
    'win32-x64': { asset: 'cloudflared-windows-amd64.exe', binaryName: 'cloudflared.exe', archive: null },
    'win32-arm64': { asset: 'cloudflared-windows-amd64.exe', binaryName: 'cloudflared.exe', archive: null },
    'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', binaryName: 'cloudflared', archive: 'tgz' },
    'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', binaryName: 'cloudflared', archive: 'tgz' },
    'linux-x64': { asset: 'cloudflared-linux-amd64', binaryName: 'cloudflared', archive: null },
    'linux-arm64': { asset: 'cloudflared-linux-arm64', binaryName: 'cloudflared', archive: null },
  }
  const entry = table[key]
  if (!entry) {
    throw new Error(`暂不支持自动下载当前平台（${key}）的 cloudflared 二进制`)
  }
  return {
    ...entry,
    url: `${CLOUDFLARED_RELEASE_BASE}/${entry.asset}`,
  }
}

/** 优先查找 <appDir>/bin/cloudflared(.exe)，其次扫描系统 PATH。 */
export function findCloudflaredBinary(appDir, {
  envPath = process.env.PATH || '',
  existsSync = fsExistsSync,
  platform = process.platform,
} = {}) {
  const binaryName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  if (appDir) {
    const managed = join(appDir, 'bin', binaryName)
    if (existsSync(managed)) return managed
  }

  const sep = platform === 'win32' ? ';' : ':'
  for (const rawDir of String(envPath || '').split(sep)) {
    const dir = rawDir.trim().replace(/^"+|"+$/g, '')
    if (!dir) continue
    const candidate = join(dir, binaryName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function defaultVerifyBinary(binaryPath, execFileFn) {
  await execFileFn(binaryPath, ['--version'], {
    timeout: 10_000,
    windowsHide: true,
  })
}

async function defaultExtractTgz(archivePath, destDir, execFileFn) {
  await execFileFn('tar', ['-xzf', archivePath, '-C', destDir], {
    timeout: 30_000,
    windowsHide: true,
  })
}

function buildDownloadUrls(baseUrl, mirrorPrefix) {
  const prefixes = Array.isArray(mirrorPrefix)
    ? mirrorPrefix
    : (mirrorPrefix ? [mirrorPrefix] : [])
  const urls = []
  for (const rawPrefix of prefixes) {
    const prefix = String(rawPrefix || '').trim()
    if (!prefix) continue
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
    urls.push(`${normalized}${baseUrl}`)
  }
  urls.push(baseUrl)
  return urls
}

async function downloadToFile(url, filePath, { fetchFn, onProgress, signal }) {
  const response = await fetchFn(url, { signal })
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`)
  }
  const total = Number(response.headers?.get?.('content-length') || 0) || 0
  let downloaded = 0
  const chunks = []

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      chunks.push(buf)
      downloaded += buf.byteLength
      onProgress?.({
        downloaded,
        total,
        percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
      })
    }
  } else {
    const buf = Buffer.from(await response.arrayBuffer())
    chunks.push(buf)
    downloaded = buf.byteLength
    onProgress?.({ downloaded, total: total || downloaded, percent: 100 })
  }

  const content = Buffer.concat(chunks)
  if (content.byteLength === 0) {
    throw new Error(`下载到的文件为空：${url}`)
  }
  await writeFile(filePath, content)
}

/**
 * 确保可用的 cloudflared 可执行文件存在：
 * 1. 先查已有（<appDir>/bin 或 PATH）并跑 --version 验证；
 * 2. 缺失或损坏时按需下载到 <appDir>/bin/（支持镜像前缀并自动回退直连），原子替换；
 * 3. POSIX 上赋 0o755 权限，最终再以 --version 验活，确保不是 HTML 错误页或半截文件。
 */
export async function ensureCloudflaredBinary(appDir, {
  fetchFn = netFetch,
  onProgress,
  mirrorPrefix = '',
  platform = process.platform,
  arch = process.arch,
  envPath = process.env.PATH || '',
  existsSync = fsExistsSync,
  execFileFn = execFileAsync,
  extractTgzFn,
  forceDownload = false,
  signal,
} = {}) {
  if (!forceDownload) {
    const existing = findCloudflaredBinary(appDir, { envPath, existsSync, platform })
    if (existing) {
      try {
        await defaultVerifyBinary(existing, execFileFn)
        return existing
      } catch {
        // 已发现的二进制损坏或无法执行时继续走按需重下
      }
    }
  }

  const asset = cloudflaredAssetForPlatform(platform, arch)
  const binDir = join(appDir, 'bin')
  await mkdir(binDir, { recursive: true })
  const finalPath = join(binDir, asset.binaryName)
  const tempDownload = join(binDir, `.${asset.asset}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const urls = buildDownloadUrls(asset.url, mirrorPrefix)

  let lastError = null
  let downloadedOk = false
  try {
    for (const url of urls) {
      try {
        await downloadToFile(url, tempDownload, { fetchFn, onProgress, signal })
        downloadedOk = true
        break
      } catch (err) {
        lastError = err
        if (signal?.aborted) throw err
      }
    }
    if (!downloadedOk) {
      throw lastError || new Error('下载 cloudflared 失败')
    }

    if (asset.archive === 'tgz') {
      const extractDir = await mkdtemp(join(binDir, '.cf-extract-'))
      try {
        const extractor = extractTgzFn || ((archivePath, destDir) => defaultExtractTgz(archivePath, destDir, execFileFn))
        await extractor(tempDownload, extractDir)
        const extractedBin = join(extractDir, asset.binaryName)
        if (!existsSync(extractedBin)) {
          throw new Error(`解压后未找到 ${asset.binaryName}`)
        }
        await rename(extractedBin, finalPath)
      } finally {
        await rm(extractDir, { recursive: true, force: true }).catch(() => {})
      }
    } else {
      await rename(tempDownload, finalPath)
    }

    if (platform !== 'win32') {
      await chmod(finalPath, 0o755)
    }

    try {
      await defaultVerifyBinary(finalPath, execFileFn)
    } catch (err) {
      await rm(finalPath, { force: true }).catch(() => {})
      throw new Error(`cloudflared 二进制校验失败（--version 异常）：${errorMessage(err)}`)
    }

    return finalPath
  } finally {
    await rm(tempDownload, { force: true }).catch(() => {})
  }
}

/* ----------------------------------------------------------- 参数拼装 */

const VALID_EDGE_IP_VERSIONS = new Set(['4', '6', 'auto'])
const VALID_PROTOCOLS = new Set(['http2', 'quic', 'auto'])

/**
 * 拼装 cloudflared 命令行参数。
 *
 * 安全红线：无论 options 里是否带了 token，本函数都绝不输出 `--token` 或任何密钥值，
 * token / worker 模式的凭据只能通过子进程环境变量 `TUNNEL_TOKEN` 传递。
 */
export function buildTunnelArgs(options = {}) {
  const mode = String(options.mode || 'quick').toLowerCase()
  const preRunFlags = []
  const postRunFlags = []

  const edgeIPVersion = String(options.edgeIPVersion ?? '').trim().toLowerCase()
  if (VALID_EDGE_IP_VERSIONS.has(edgeIPVersion)) {
    preRunFlags.push('--edge-ip-version', edgeIPVersion)
  }

  const region = String(options.region ?? '').trim()
  if (region) {
    preRunFlags.push('--region', region)
  }

  const protocol = String(options.protocol ?? '').trim().toLowerCase()
  if (VALID_PROTOCOLS.has(protocol)) {
    postRunFlags.push('--protocol', protocol)
  }

  const resolvers = Array.isArray(options.dnsResolverAddrs)
    ? options.dnsResolverAddrs.map((item) => String(item).trim()).filter(Boolean).join(',')
    : String(options.dnsResolverAddrs ?? '').trim()
  if (resolvers) {
    postRunFlags.push('--dns-resolver-addrs', resolvers)
  }

  if (mode === 'quick') {
    const port = Number(options.targetPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Quick Tunnel 需要有效的本地端口（targetPort），收到：${options.targetPort}`)
    }
    return ['tunnel', ...preRunFlags, '--url', `http://127.0.0.1:${port}`, ...postRunFlags]
  }

  if (mode === 'token' || mode === 'worker') {
    return ['tunnel', ...preRunFlags, 'run', ...postRunFlags]
  }

  throw new Error(`不支持的隧道模式：${mode}`)
}

/* ------------------------------------------------ CloudflareTunnelManager */

/**
 * Cloudflare Tunnel 子进程生命周期管理器：
 * - 支持 worker / token / quick 三种模式；
 * - 启动前按需下载 cloudflared、可选边缘测速与抗污染；
 * - 实时解析 stderr 获取就绪状态、机房位置、Quick URL、DNS 污染与 IPv6 TLS EOF 自动回落 IPv4；
 * - 意外退出带指数退避重拉；stop() 干净清理进程与定时器，绝不留孤儿进程。
 */
export class CloudflareTunnelManager {
  constructor({
    appDir,
    onStatus = null,
    onLog = null,
    spawnFn = spawn,
    fetchFn = netFetch,
    probeFn = probeCloudflareEdge,
    ensureBinaryFn = ensureCloudflaredBinary,
    registerWorkerFn = registerOrFetchWorkerTunnel,
    killGraceMs = 3000,
    baseBackoffMs = 1500,
    maxBackoffMs = 30_000,
    maxLogs = 200,
    platform = process.platform,
  } = {}) {
    this.appDir = appDir
    this.onStatus = typeof onStatus === 'function' ? onStatus : null
    this.onLog = typeof onLog === 'function' ? onLog : null
    this._spawnFn = spawnFn
    this._fetchFn = fetchFn
    this._probeFn = probeFn
    this._ensureBinaryFn = ensureBinaryFn
    this._registerWorkerFn = registerWorkerFn
    this._killGraceMs = killGraceMs
    this._baseBackoffMs = baseBackoffMs
    this._maxBackoffMs = maxBackoffMs
    this._maxLogs = maxLogs
    this._platform = platform

    this._runId = 0
    this._child = null
    this._abortController = null
    this._restartTimer = null
    this._token = ''
    this._activeConfig = null
    this._effectiveEdgeIPVersion = 'auto'
    this._forcedIpv4Fallback = false
    this._restartingForFallback = false
    this._consecutiveFailures = 0
    this._connLocations = new Map()
    this._logs = []

    this._status = {
      state: 'stopped',
      mode: null,
      publicUrl: '',
      subdomain: '',
      locations: [],
      edgeProbe: null,
      lastError: '',
      binaryPath: '',
      pid: null,
      startedAt: null,
    }
  }

  /** 返回当前状态的只读快照（绝不暴露 TUNNEL_TOKEN）。 */
  getStatus() {
    return {
      ...this._status,
      locations: [...this._status.locations],
      edgeProbe: this._status.edgeProbe
        ? { ...this._status.edgeProbe, polluted: [...(this._status.edgeProbe.polluted || [])] }
        : null,
    }
  }

  /** 返回最近的隧道运行日志（已做敏感 token 脱敏）。 */
  getLogs(limit = 100) {
    const count = Math.max(0, Number(limit) || 0)
    return count ? this._logs.slice(-count) : []
  }

  _emitStatus(patch = {}) {
    Object.assign(this._status, patch)
    if (this.onStatus) {
      try {
        this.onStatus(this.getStatus())
      } catch { /* 外部回调异常不影响状态机 */ }
    }
  }

  _appendLog(level, rawText) {
    let text = String(rawText ?? '').trimEnd()
    if (!text) return
    if (this._token) text = text.replaceAll(this._token, '[REDACTED]')
    const entry = { level, text, ts: Date.now() }
    this._logs.push(entry)
    if (this._logs.length > this._maxLogs) {
      this._logs.splice(0, this._logs.length - this._maxLogs)
    }
    if (this.onLog) {
      try {
        this.onLog(entry)
      } catch { /* ignore */ }
    }
  }

  /**
   * 启动隧道。若已有运行中的隧道，先干净停止再重新启动。
   */
  async start(config = {}) {
    await this.stop()

    const mode = String(config.mode || 'quick').toLowerCase()
    if (mode !== 'worker' && mode !== 'token' && mode !== 'quick') {
      throw new Error(`不支持的隧道模式：${mode}`)
    }
    if (mode === 'token' && !String(config.token || '').trim()) {
      throw new Error('Token 模式需要提供 TUNNEL_TOKEN')
    }
    if (mode === 'worker' && !String(config.workerUrl || '').trim()) {
      throw new Error('Worker 模式需要提供 Worker 地址')
    }
    if (mode === 'quick') {
      const port = Number(config.targetPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Quick 模式需要有效的本地端口（targetPort）`)
      }
    }

    const runId = ++this._runId
    const controller = new AbortController()
    this._abortController = controller
    this._activeConfig = {
      ...config,
      mode,
      edgeIPVersion: String(config.edgeIPVersion || 'auto').toLowerCase(),
      // 国内运营商对 UDP/QUIC 限速严重，未显式指定协议时默认用 http2
      protocol: config.protocol || 'http2',
    }
    this._token = mode === 'token' ? String(config.token).trim() : ''
    this._effectiveEdgeIPVersion = this._activeConfig.edgeIPVersion
    this._forcedIpv4Fallback = false
    this._restartingForFallback = false
    this._consecutiveFailures = 0
    this._connLocations.clear()

    const initialPublicUrl = String(config.publicUrl || '').trim().replace(/\/+$/, '')
    this._emitStatus({
      state: 'downloading',
      mode,
      publicUrl: initialPublicUrl,
      subdomain: extractSubdomainFromUrl(initialPublicUrl, config.subdomain),
      locations: [],
      edgeProbe: null,
      lastError: '',
      binaryPath: config.binaryPath || '',
      pid: null,
      startedAt: null,
    })

    try {
      // 1. 准备 cloudflared 二进制
      let binaryPath = String(config.binaryPath || '').trim()
      if (!binaryPath) {
        binaryPath = await this._ensureBinaryFn(this.appDir, {
          fetchFn: this._fetchFn,
          mirrorPrefix: config.mirrorPrefix,
          onProgress: (progress) => {
            if (this._runId !== runId) return
            this._appendLog('info', `正在下载 cloudflared：${progress.percent !== null ? `${progress.percent}%` : `${progress.downloaded} bytes`}`)
          },
          signal: controller.signal,
        })
      }
      if (this._runId !== runId) return this.getStatus()
      this._emitStatus({ binaryPath })

      // 2. Worker 模式注册/读取缓存凭证
      if (mode === 'worker') {
        this._emitStatus({ state: 'starting' })
        const reg = await this._registerWorkerFn({
          appDir: this.appDir,
          workerUrl: config.workerUrl,
          inviteCode: config.inviteCode,
          targetPort: config.targetPort,
          fetchFn: this._fetchFn,
          forceRefresh: Boolean(config.forceRefresh),
          signal: controller.signal,
        })
        if (this._runId !== runId) return this.getStatus()
        this._token = reg.token
        this._emitStatus({
          publicUrl: reg.publicUrl,
          subdomain: reg.subdomain,
        })
        this._appendLog('info', `Worker 隧道已就绪（${reg.cached ? '使用本地缓存' : '新注册'}）：${reg.publicUrl}`)
      }

      // 3. 边缘测速与抗污染（仅在 edgeProbe !== false 且 edgeIPVersion === 'auto' 时执行）
      if (config.edgeProbe !== false && this._activeConfig.edgeIPVersion === 'auto') {
        this._emitStatus({ state: 'probing' })
        const probeResult = await this._probeFn({ timeoutMs: config.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS })
        if (this._runId !== runId) return this.getStatus()
        this._effectiveEdgeIPVersion = probeResult?.chosen || 'auto'
        this._emitStatus({ edgeProbe: probeResult })
        if (probeResult?.polluted?.length) {
          this._appendLog('warn', `检测到疑似 DNS 污染地址已过滤：${probeResult.polluted.join(', ')}`)
        }
        this._appendLog(
          'info',
          `边缘测速完成：IPv4=${probeResult?.v4RttMs ?? '不可达'}ms, IPv6=${probeResult?.v6RttMs ?? '不可达'}ms, 选择=${this._effectiveEdgeIPVersion}`,
        )
      }

      // 4. 启动 cloudflared 子进程
      if (this._runId !== runId) return this.getStatus()
      this._spawnChild(runId)
      return this.getStatus()
    } catch (err) {
      if (this._runId !== runId) return this.getStatus()
      const msg = errorMessage(err)
      this._appendLog('error', `隧道启动失败：${msg}`)
      this._emitStatus({ state: 'error', lastError: msg, pid: null })
      throw err
    }
  }

  _spawnChild(runId) {
    if (this._runId !== runId || !this._activeConfig) return

    const cfg = this._activeConfig
    const args = buildTunnelArgs({
      mode: cfg.mode,
      targetPort: cfg.targetPort,
      edgeIPVersion: this._effectiveEdgeIPVersion,
      region: cfg.region,
      protocol: cfg.protocol,
      dnsResolverAddrs: cfg.dnsResolverAddrs,
    })

    // 凭据仅走环境变量，不落 argv；Quick 模式主动清掉可能残留的 TUNNEL_TOKEN
    const env = { ...process.env }
    if (cfg.mode === 'token' || cfg.mode === 'worker') {
      env.TUNNEL_TOKEN = this._token
    } else {
      delete env.TUNNEL_TOKEN
    }

    this._connLocations.clear()
    this._emitStatus({
      state: 'starting',
      locations: [],
      startedAt: Date.now(),
    })
    this._appendLog('info', `拉起 ${basename(this._status.binaryPath)} ${args.join(' ')}`)

    const child = this._spawnFn(this._status.binaryPath, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this._child = child
    this._emitStatus({ pid: child.pid ?? null })

    const wireStream = (stream) => {
      if (!stream || typeof stream.on !== 'function') return
      let buffer = ''
      stream.on('data', (chunk) => {
        if (this._runId !== runId || this._child !== child) return
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          this._handleProcessLine(runId, child, line)
        }
      })
      stream.on('end', () => {
        if (this._runId !== runId || this._child !== child) return
        if (buffer) {
          this._handleProcessLine(runId, child, buffer)
          buffer = ''
        }
      })
    }

    wireStream(child.stderr)
    wireStream(child.stdout)

    child.on('error', (err) => {
      if (this._runId !== runId || this._child !== child) return
      const msg = `无法启动 cloudflared：${errorMessage(err)}`
      this._appendLog('error', msg)
      this._handleChildExit(runId, child, null, null, msg)
    })

    child.on('exit', (code, signal) => {
      if (this._runId !== runId || this._child !== child) return
      this._handleChildExit(runId, child, code, signal)
    })
  }

  _handleProcessLine(runId, child, rawLine) {
    const line = String(rawLine ?? '').trim()
    if (!line) return

    const benign = isBenignCloudflareLog(line)
    this._appendLog(benign ? 'info' : 'warn', line)

    // 1. Quick Tunnel 临时公网地址
    if (this._activeConfig?.mode === 'quick') {
      const quickUrl = parseQuickTunnelUrl(line)
      if (quickUrl && quickUrl !== this._status.publicUrl) {
        this._emitStatus({
          publicUrl: quickUrl,
          subdomain: extractSubdomainFromUrl(quickUrl),
        })
      }
    }

    // 2. 隧道建连注册成功
    const registered = parseRegisteredLine(line)
    if (registered) {
      if (registered.location) {
        this._connLocations.set(registered.connIndex, registered.location)
      }
      this._consecutiveFailures = 0
      const locations = [...new Set(this._connLocations.values())]
      this._emitStatus({
        state: 'running',
        locations,
        lastError: '',
      })
      return
    }

    // 3. IPv6 TLS 握手 EOF 自动回落到 IPv4
    if (!this._forcedIpv4Fallback && this._effectiveEdgeIPVersion !== '4' && isIpv6TlsEofLine(line)) {
      this._forcedIpv4Fallback = true
      this._effectiveEdgeIPVersion = '4'
      this._restartingForFallback = true
      this._appendLog('warn', '检测到 IPv6 TLS 握手异常（EOF），自动回落到 IPv4 边缘节点重连')
      this._terminateChild(child)
      return
    }

    // 4. 运行期 DNS 污染告警（失败边缘 IP 既非 Cloudflare 官方段也非 TUN Fake-IP）
    const failedIp = parseFailedEdgeIP(line)
    if (failedIp && !isCloudflareEdgeIP(failedIp) && !isProxyFakeIP(failedIp)) {
      const prev = this._status.edgeProbe || { v4RttMs: null, v6RttMs: null, polluted: [], chosen: this._effectiveEdgeIPVersion }
      if (!prev.polluted.includes(failedIp)) {
        this._emitStatus({
          edgeProbe: { ...prev, polluted: [...prev.polluted, failedIp] },
        })
      }
      this._appendLog('warn', `运行期发现疑似被污染的边缘地址：${failedIp}`)
    }

    // 5. 记录最近一条非无害错误，供异常退出时呈现给用户
    if (!benign && /\b(ERR|FTL|unauthorized|invalid|failed|error)\b/i.test(line)) {
      this._status.lastError = line
    }
  }

  _handleChildExit(runId, child, code, signal, explicitError = '') {
    if (this._runId !== runId || this._child !== child) return
    this._child = null

    // IPv6 自动回落触发的主动重启：跳过退避立即拉起 IPv4
    if (this._restartingForFallback) {
      this._restartingForFallback = false
      this._spawnChild(runId)
      return
    }

    this._consecutiveFailures += 1
    const reason = explicitError
      || this._status.lastError
      || `cloudflared 异常退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`
    const delayMs = Math.min(
      this._maxBackoffMs,
      this._baseBackoffMs * (2 ** Math.max(0, this._consecutiveFailures - 1)),
    )

    this._connLocations.clear()
    this._emitStatus({
      state: 'error',
      pid: null,
      locations: [],
      lastError: reason,
    })
    this._appendLog('warn', `隧道断开，${Math.round(delayMs / 1000)} 秒后第 ${this._consecutiveFailures} 次重连：${reason}`)

    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      if (this._runId !== runId) return
      this._spawnChild(runId)
    }, delayMs)
    this._restartTimer.unref?.()
  }

  _terminateChild(child) {
    if (!child) return
    try {
      child.kill(this._platform === 'win32' ? undefined : 'SIGTERM')
    } catch { /* 进程可能已退出 */ }
  }

  /**
   * 干净停止隧道：取消下载/重连定时器，温和结束子进程，超时强杀防止孤儿残留。
   */
  async stop() {
    this._runId += 1
    this._restartingForFallback = false
    if (this._abortController) {
      try { this._abortController.abort(new Error('隧道已停止')) } catch { /* ignore */ }
      this._abortController = null
    }
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }

    const child = this._child
    this._child = null
    if (child && child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(forceTimer)
          resolve()
        }
        child.once('exit', done)
        child.once('close', done)

        this._terminateChild(child)
        const forceTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          // 给事件循环一次机会派发 exit；若假进程不派发也绝不卡死 stop()
          setTimeout(done, 20).unref?.()
        }, this._killGraceMs)
        forceTimer.unref?.()
      })
    }

    this._token = ''
    this._activeConfig = null
    this._connLocations.clear()
    this._emitStatus({
      state: 'stopped',
      pid: null,
      locations: [],
      startedAt: null,
    })
  }
}
