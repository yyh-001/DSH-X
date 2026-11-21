import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'

/**
 * 远程访问与手机端的设备级鉴权层（独立于本机管理页的 ManagerAuth）。
 *
 * 为什么不复用 manager-auth.js 的单一共享令牌：
 * - manager-auth.js 面向本机桌面控制台，每次重启重置 launchToken、无法按设备区分和单独踢下线；
 * - 手机远程接入可能经由局域网或公网隧道，需要「一次性扫码配对 → 独立设备凭证 → 活跃记录 →
 *   单设备吊销立即断开 WebSocket」的完整生命周期，同时绝不在磁盘上留下明文设备 token。
 *
 * 持久化文件（放在 <APP_DIR> 下，0600 权限，原子替换写入）：
 * - auth-salt           32 字节随机盐（hex），用于对设备 token 做加盐 SHA-256
 * - paired-devices.json 已配对设备清单，只存 tokenHash（s256:<hex>）和设备元数据
 */

export const DEVICE_COOKIE_NAME = 'dsh-x-device'

const PAIRING_CODE_BYTES = 32
const DEFAULT_PAIRING_TTL_MS = 300_000
const MAX_PENDING_PAIRING_SESSIONS = 32

const SALT_BYTES = 32
const SALT_FILE = 'auth-salt'
const DEVICES_FILE = 'paired-devices.json'
const DEVICES_SCHEMA_VERSION = 1
const DEFAULT_LAST_SEEN_DEBOUNCE_MS = 30_000
const DEFAULT_LAST_SEEN_PERSIST_MS = 60_000
const MAX_DEVICE_NAME_LEN = 80
const MAX_PLATFORM_LEN = 40
const MAX_DEVICE_KEY_LEN = 128
const MAX_IP_LEN = 64

const WS_TICKET_BYTES = 20
const DEFAULT_WS_TICKET_TTL_MS = 30_000
const DEFAULT_WS_MAX_PER_DEVICE = 5
const DEFAULT_WS_MAX_GLOBAL = 1000
const DEFAULT_WS_GC_INTERVAL_MS = 30_000

const DEFAULT_RATE_WINDOW_MS = 60_000
const DEFAULT_RATE_MAX_REQUESTS = 20
const DEFAULT_RATE_MAX_ENTRIES = 4096

const DEFAULT_COOKIE_MAX_AGE_DAYS = 90
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 定长比较：长度不同直接返回 false，避免 timingSafeEqual 抛异常。 */
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** 截断并清理控制字符，避免设备名或 UA 污染日志 / JSON / HTTP 头。 */
function cleanText(value, maxLen, fallback = '') {
  const trimmed = String(value ?? '').replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLen)
}

/**
 * 原子写文件（0600 权限）：先写同目录临时文件再 rename，防止进程崩溃或断电把设备表截断为空。
 * Windows 下 chmod 是 no-op，POSIX 下显式 chmod 兜底避免进程 umask 放宽权限。
 */
function writeFileAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(tmpPath, 0o600) } catch { /* Windows 等平台忽略 */ }
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* 清理失败忽略 */ }
    throw err
  }
}

/** 读或生成持久化的 32 字节随机盐（hex）。盐跨重启保留，确保老设备凭证继续有效。 */
function loadOrCreateSalt(dir) {
  const file = join(dir, SALT_FILE)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing.toLowerCase()
  } catch { /* 不存在或损坏则重新生成 */ }
  const salt = randomBytes(SALT_BYTES).toString('hex')
  writeFileAtomic(file, `${salt}\n`)
  return salt
}

/** 生成一组新设备凭证：短可读 ID + 32 字节高熵 token。 */
export function generateDeviceCredentials() {
  return {
    deviceId: `dev_${randomBytes(6).toString('hex')}`,
    deviceToken: `tok_${randomBytes(32).toString('hex')}`,
  }
}

/**
 * 一次性配对码管理器（纯内存态）。
 * 为什么不落盘：配对码寿命只有 5 分钟，重启后旧二维码自然失效，减少磁盘攻击面。
 */
export class PairingManager {
  /**
   * @param {object} [options]
   * @param {number} [options.defaultTtlMs] 默认有效期（毫秒），默认 5 分钟
   * @param {() => number} [options.now] 时间源，便于测试注入
   */
  constructor({ defaultTtlMs = DEFAULT_PAIRING_TTL_MS, now = () => Date.now() } = {}) {
    this._defaultTtlMs = defaultTtlMs
    this._now = now
    /** @type {Map<string, { code: string, createdAt: number, expiresAt: number }>} */
    this._sessions = new Map()
  }

  /** 生成一个新的一次性配对会话（32 字节随机 hex）。 */
  generateSession(ttlMs) {
    this.cleanupExpired()
    // 防止界面被狂点生成配对码时无限占内存，超出上限淘汰最早的一条
    while (this._sessions.size >= MAX_PENDING_PAIRING_SESSIONS) {
      const oldestKey = this._sessions.keys().next().value
      this._sessions.delete(oldestKey)
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._defaultTtlMs
    const createdAt = this._now()
    const code = randomBytes(PAIRING_CODE_BYTES).toString('hex')
    const session = { code, createdAt, expiresAt: createdAt + ttl }
    this._sessions.set(code, session)
    return { ...session }
  }

  /** 返回当前最新且未过期、未消费的配对会话；没有时返回 null。 */
  latestSession() {
    this.cleanupExpired()
    let latest = null
    for (const session of this._sessions.values()) latest = session
    return latest ? { ...latest } : null
  }

  /**
   * 校验并立即消费配对码（忽略首尾空白与大小写）。
   * 即使只有几条活跃会话也全量做定长比较，避免通过响应时间探测有效码前缀。
   * @returns {boolean}
   */
  validateAndConsume(code) {
    this.cleanupExpired()
    if (typeof code !== 'string') return false
    const normalized = code.trim().toLowerCase()
    if (!normalized) return false
    let matchedKey = null
    for (const key of this._sessions.keys()) {
      if (constantTimeEqual(normalized, key)) matchedKey = key
    }
    if (!matchedKey) return false
    this._sessions.delete(matchedKey)
    return true
  }

  /** 清理所有已过期会话，返回清理条数。 */
  cleanupExpired() {
    const now = this._now()
    let removed = 0
    for (const [key, session] of this._sessions) {
      if (session.expiresAt <= now) {
        this._sessions.delete(key)
        removed++
      }
    }
    return removed
  }
}

/** 剥离 tokenHash 后返回给业务层的设备副本，避免哈希意外泄漏到接口响应或日志。 */
function sanitizeDevice(record) {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    deviceKey: record.deviceKey,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    lastSeenIP: record.lastSeenIP,
  }
}

/**
 * 已配对设备存储：负责加盐哈希校验、原子持久化、同设备重配轮换、活跃时间节流与吊销回调。
 */
export class DeviceAuthStore {
  /**
   * @param {string} dir 持久化目录（通常是 APP_DIR）
   * @param {object} [options]
   * @param {() => number} [options.now] 时间源
   * @param {number} [options.lastSeenDebounceMs] 内存防抖间隔，默认 30s
   * @param {number} [options.lastSeenPersistIntervalMs] 落盘节流间隔，默认 60s
   * @param {PairingManager} [options.pairingManager] 可选默认配对管理器
   * @param {(deviceId: string) => void} [options.onDeviceRemoved] 吊销单设备时的钩子（用来断 WS）
   * @param {() => void} [options.onClearAll] 全部吊销时的钩子
   */
  constructor(dir, {
    now = () => Date.now(),
    lastSeenDebounceMs = DEFAULT_LAST_SEEN_DEBOUNCE_MS,
    lastSeenPersistIntervalMs = DEFAULT_LAST_SEEN_PERSIST_MS,
    pairingManager = null,
    onDeviceRemoved = null,
    onClearAll = null,
  } = {}) {
    if (!dir || typeof dir !== 'string') throw new Error('DeviceAuthStore 需要有效的存储目录')
    this._dir = dir
    this._devicesFile = join(dir, DEVICES_FILE)
    this._now = now
    this._lastSeenDebounceMs = lastSeenDebounceMs
    this._lastSeenPersistIntervalMs = lastSeenPersistIntervalMs
    this._pairingManager = pairingManager
    this.onDeviceRemoved = typeof onDeviceRemoved === 'function' ? onDeviceRemoved : null
    this.onClearAll = typeof onClearAll === 'function' ? onClearAll : null

    this._salt = loadOrCreateSalt(dir)
    /** @type {Map<string, object>} deviceId -> record */
    this._byId = new Map()
    /** @type {Map<string, object>} tokenHash -> record */
    this._byHash = new Map()
    this._lastPersistAt = 0
    this._dirty = false

    this._load()
  }

  static load(dir, options) {
    return new DeviceAuthStore(dir, options)
  }

  static generateDeviceCredentials() {
    return generateDeviceCredentials()
  }

  /** 对原始设备 token 计算加盐 SHA-256 哈希，磁盘和内存索引都不留明文。 */
  hashToken(rawToken) {
    return `s256:${createHash('sha256').update(`${this._salt}:${rawToken}`).digest('hex')}`
  }

  _load() {
    let raw
    try {
      raw = readFileSync(this._devicesFile, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.devices) ? parsed.devices : [])
    for (const item of list) {
      if (!item || typeof item.deviceId !== 'string' || !item.deviceId) continue
      if (typeof item.tokenHash !== 'string' || !item.tokenHash.startsWith('s256:')) continue
      const record = {
        deviceId: item.deviceId,
        deviceName: cleanText(item.deviceName, MAX_DEVICE_NAME_LEN, '未命名设备'),
        platform: cleanText(item.platform, MAX_PLATFORM_LEN, 'unknown'),
        deviceKey: cleanText(item.deviceKey, MAX_DEVICE_KEY_LEN, ''),
        tokenHash: item.tokenHash,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
        lastSeenAt: Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : 0,
        lastSeenIP: cleanText(item.lastSeenIP, MAX_IP_LEN, ''),
      }
      this._byId.set(record.deviceId, record)
      this._byHash.set(record.tokenHash, record)
    }
  }

  _save() {
    const payload = {
      version: DEVICES_SCHEMA_VERSION,
      devices: [...this._byId.values()],
    }
    writeFileAtomic(this._devicesFile, `${JSON.stringify(payload, null, 2)}\n`)
    this._lastPersistAt = this._now()
    this._dirty = false
  }

  _notifyRemoved(deviceId) {
    if (typeof this.onDeviceRemoved !== 'function') return
    try { this.onDeviceRemoved(deviceId) } catch { /* 外部钩子异常不影响状态一致 */ }
  }

  _notifyClearAll() {
    if (typeof this.onClearAll !== 'function') return
    try { this.onClearAll() } catch { /* 外部钩子异常不影响状态一致 */ }
  }

  /** 按稳定 deviceKey 查找已有设备（返回脱敏副本），空 key 不参与去重。 */
  findByDeviceKey(deviceKey) {
    const key = cleanText(deviceKey, MAX_DEVICE_KEY_LEN, '')
    if (!key) return null
    for (const record of this._byId.values()) {
      if (record.deviceKey && record.deviceKey === key) return sanitizeDevice(record)
    }
    return null
  }

  /**
   * 写入新设备并签发凭证；若非空 deviceKey 已存在，先移除旧设备与旧 tokenHash，
   * 防止同一台手机反复扫码留下孤儿凭证或重复列表项。
   */
  addDevice({ deviceName = '', platform = '', deviceKey = '', remoteIP = '' } = {}) {
    const cleanKey = cleanText(deviceKey, MAX_DEVICE_KEY_LEN, '')
    const replacedIds = []
    if (cleanKey) {
      for (const existing of [...this._byId.values()]) {
        if (existing.deviceKey && existing.deviceKey === cleanKey) {
          this._byId.delete(existing.deviceId)
          this._byHash.delete(existing.tokenHash)
          replacedIds.push(existing.deviceId)
        }
      }
    }

    const { deviceId, deviceToken } = generateDeviceCredentials()
    const tokenHash = this.hashToken(deviceToken)
    const now = this._now()
    const record = {
      deviceId,
      deviceName: cleanText(deviceName, MAX_DEVICE_NAME_LEN, '未命名设备'),
      platform: cleanText(platform, MAX_PLATFORM_LEN, 'unknown'),
      deviceKey: cleanKey,
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      lastSeenIP: cleanText(remoteIP, MAX_IP_LEN, ''),
    }
    this._byId.set(deviceId, record)
    this._byHash.set(tokenHash, record)
    this._save()

    // 旧设备被替换后通知网关切断其原有长连接，杜绝旧凭证残留会话
    for (const oldId of replacedIds) this._notifyRemoved(oldId)

    return {
      device: sanitizeDevice(record),
      deviceToken,
      replacedDeviceId: replacedIds[0] ?? null,
    }
  }

  /**
   * 完整配对流程：先经 PairingManager 消费一次性配对码，校验通过后再签发新设备凭证。
   * 支持从构造参数、options.pairingManager 或第二个参数传入 pairingManager。
   */
  pairDevice({ code, deviceName = '', platform = '', deviceKey = '', remoteIP = '', pairingManager } = {}, fallbackPairingManager) {
    const pm = pairingManager || fallbackPairingManager || this._pairingManager
    if (!pm || typeof pm.validateAndConsume !== 'function') {
      throw new Error('pairDevice 需要 PairingManager 实例')
    }
    if (!pm.validateAndConsume(code)) return null
    return this.addDevice({ deviceName, platform, deviceKey, remoteIP })
  }

  /** 校验设备原始 token；通过时返回不含 tokenHash 的设备副本，失败返回 null。 */
  validateToken(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken) return null
    const hash = this.hashToken(rawToken)
    const record = this._byHash.get(hash)
    if (!record || !constantTimeEqual(record.tokenHash, hash)) return null
    return sanitizeDevice(record)
  }

  /**
   * 更新设备最近活跃时间与 IP：
   * - 30s 内存防抖：同一 IP 高频请求不反复改写内存；
   * - 60s 落盘节流：避免每次静态资源或 API 请求都触发磁盘 rename；
   * - IP 变化时跳过防抖和节流立刻落盘，保证审计记录及时准确。
   * @returns {boolean} 是否实际更新了活跃记录
   */
  updateLastSeen(deviceId, remoteIP = '') {
    const record = this._byId.get(deviceId)
    if (!record) return false
    const now = this._now()
    const nextIP = cleanText(remoteIP, MAX_IP_LEN, '')
    const ipChanged = Boolean(nextIP) && nextIP !== record.lastSeenIP

    if (!ipChanged && (now - record.lastSeenAt) < this._lastSeenDebounceMs) {
      return false
    }

    record.lastSeenAt = now
    if (nextIP) record.lastSeenIP = nextIP

    if (ipChanged || (now - this._lastPersistAt) >= this._lastSeenPersistIntervalMs) {
      this._save()
    } else {
      this._dirty = true
    }
    return true
  }

  /** 优雅退出时把节流缓冲区里尚未落盘的活跃记录刷盘。 */
  flush() {
    if (this._dirty) this._save()
  }

  /** 列出全部已配对设备（剥离 tokenHash，按最近活跃时间倒序）。 */
  listDevices() {
    return [...this._byId.values()]
      .sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (b.createdAt - a.createdAt))
      .map(sanitizeDevice)
  }

  /** 按 deviceId 获取单台设备的脱敏副本。 */
  getDevice(deviceId) {
    const record = this._byId.get(deviceId)
    return record ? sanitizeDevice(record) : null
  }

  /** 重命名设备；名称为空或设备不存在时返回 null。 */
  renameDevice(deviceId, name) {
    const record = this._byId.get(deviceId)
    if (!record) return null
    const nextName = cleanText(name, MAX_DEVICE_NAME_LEN, '')
    if (!nextName) return null
    record.deviceName = nextName
    this._save()
    return sanitizeDevice(record)
  }

  /** 吊销单个设备，立即落盘并触发 onDeviceRemoved 钩子。 */
  removeDevice(deviceId) {
    const record = this._byId.get(deviceId)
    if (!record) return false
    this._byId.delete(deviceId)
    this._byHash.delete(record.tokenHash)
    this._save()
    this._notifyRemoved(deviceId)
    return true
  }

  /** 一键吊销全部设备，立即落盘并触发 onClearAll 钩子。 */
  clearAll() {
    const count = this._byId.size
    this._byId.clear()
    this._byHash.clear()
    this._save()
    this._notifyClearAll()
    return count
  }

  hasDevices() {
    return this._byId.size > 0
  }
}

/**
 * WebSocket 短票据存储：30s 有效期、一次性消费、单设备与全局双重并发配额。
 * 为什么单独发短票据：WS 握手若把长期设备 token 放进 URL query，容易被反向代理和访问日志记下来。
 */
export class WsTicketStore {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] 票据有效期，默认 30s
   * @param {number} [options.maxPerDevice] 单设备最大活跃票据数，默认 5
   * @param {number} [options.maxGlobal] 全局最大活跃票据数，默认 1000
   * @param {number} [options.gcIntervalMs] 后台 GC 间隔，默认 30s（<= 0 时不启定时器）
   * @param {() => number} [options.now] 时间源
   */
  constructor({
    ttlMs = DEFAULT_WS_TICKET_TTL_MS,
    maxPerDevice = DEFAULT_WS_MAX_PER_DEVICE,
    maxGlobal = DEFAULT_WS_MAX_GLOBAL,
    gcIntervalMs = DEFAULT_WS_GC_INTERVAL_MS,
    now = () => Date.now(),
  } = {}) {
    this._ttlMs = ttlMs
    this._maxPerDevice = maxPerDevice
    this._maxGlobal = maxGlobal
    this._now = now
    /** @type {Map<string, { deviceId: string, expiresAt: number }>} */
    this._tickets = new Map()
    /** @type {Map<string, Set<string>>} deviceId -> active ticket strings */
    this._byDevice = new Map()
    this._timer = null

    if (gcIntervalMs > 0) {
      this._timer = setInterval(() => this._purgeExpired(), gcIntervalMs)
      // 后台清理定时器不能阻止 Node 进程正常退出
      this._timer.unref?.()
    }
  }

  _deleteEntry(ticket, deviceId) {
    this._tickets.delete(ticket)
    const set = this._byDevice.get(deviceId)
    if (set) {
      set.delete(ticket)
      if (set.size === 0) this._byDevice.delete(deviceId)
    }
  }

  _purgeExpired() {
    const now = this._now()
    for (const [ticket, entry] of this._tickets) {
      if (entry.expiresAt <= now) this._deleteEntry(ticket, entry.deviceId)
    }
  }

  /** 为指定设备签发 40 字符随机 hex 票据；超出单设备或全局上限返回 null。 */
  issue(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) return null
    this._purgeExpired()
    if (this._tickets.size >= this._maxGlobal) return null
    const existing = this._byDevice.get(deviceId)
    if (existing && existing.size >= this._maxPerDevice) return null

    const ticket = randomBytes(WS_TICKET_BYTES).toString('hex')
    const expiresAt = this._now() + this._ttlMs
    this._tickets.set(ticket, { deviceId, expiresAt })
    if (existing) existing.add(ticket)
    else this._byDevice.set(deviceId, new Set([ticket]))
    return ticket
  }

  /** 校验并一次性消费票据；有效返回 `{ deviceId }`，无效或已过期返回 null。 */
  validate(ticket) {
    if (typeof ticket !== 'string' || !ticket) return null
    const entry = this._tickets.get(ticket)
    if (!entry) return null
    this._deleteEntry(ticket, entry.deviceId)
    if (entry.expiresAt <= this._now()) return null
    return { deviceId: entry.deviceId }
  }

  /** 吊销某台设备尚未消费的票据，配合设备踢下线使用。 */
  revokeDevice(deviceId) {
    const set = this._byDevice.get(deviceId)
    if (!set) return
    for (const ticket of set) this._tickets.delete(ticket)
    this._byDevice.delete(deviceId)
  }

  clearAll() {
    this._tickets.clear()
    this._byDevice.clear()
  }

  /** 停止后台 GC 定时器。 */
  close() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}

/**
 * 按客户端 IP 的滑动窗口限流器，用于保护配对和鉴权接口免受暴力枚举。
 * 桶表设置上限并淘汰最久未活跃的 IP，防止公网随机源 IP 洪泛导致 OOM。
 */
export class IpRateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs] 滑动窗口时长，默认 60s
   * @param {number} [options.maxRequests] 窗口内最大允许次数（亦兼容 `limit`）
   * @param {number} [options.limit] maxRequests 别名
   * @param {number} [options.maxEntries] 最大追踪 IP 数，默认 4096
   * @param {() => number} [options.now] 时间源
   */
  constructor({
    windowMs = DEFAULT_RATE_WINDOW_MS,
    maxRequests,
    limit,
    maxEntries = DEFAULT_RATE_MAX_ENTRIES,
    now = () => Date.now(),
  } = {}) {
    this._windowMs = windowMs
    this._maxRequests = Number.isFinite(maxRequests) ? maxRequests
      : (Number.isFinite(limit) ? limit : DEFAULT_RATE_MAX_REQUESTS)
    this._maxEntries = maxEntries
    this._now = now
    /** @type {Map<string, number[]>} ip -> ascending timestamps inside window */
    this._buckets = new Map()
  }

  _pruneStale(now) {
    const cutoff = now - this._windowMs
    for (const [key, list] of this._buckets) {
      let keepFrom = 0
      while (keepFrom < list.length && list[keepFrom] <= cutoff) keepFrom++
      if (keepFrom >= list.length) this._buckets.delete(key)
      else if (keepFrom > 0) list.splice(0, keepFrom)
    }
  }

  /**
   * 检查该 IP 本次请求是否放行。
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  check(ip) {
    const now = this._now()
    const cutoff = now - this._windowMs
    const key = normalizeIP(ip) || 'unknown'

    let list = this._buckets.get(key)
    if (list) {
      let keepFrom = 0
      while (keepFrom < list.length && list[keepFrom] <= cutoff) keepFrom++
      if (keepFrom > 0) list.splice(0, keepFrom)
    }

    if (list && list.length >= this._maxRequests) {
      const retryAfterMs = Math.max(1, (list[0] + this._windowMs) - now)
      return { allowed: false, retryAfterMs }
    }

    if (!list) {
      if (this._buckets.size >= this._maxEntries) {
        this._pruneStale(now)
        while (this._buckets.size >= this._maxEntries) {
          const oldest = this._buckets.keys().next().value
          this._buckets.delete(oldest)
        }
      }
      list = []
    } else {
      // 刷新 Map 插入顺序，实现近似 LRU 淘汰
      this._buckets.delete(key)
    }
    list.push(now)
    this._buckets.set(key, list)
    return { allowed: true, retryAfterMs: 0 }
  }

  reset(ip) {
    if (ip === undefined) this._buckets.clear()
    else this._buckets.delete(normalizeIP(ip) || 'unknown')
  }

  get size() {
    return this._buckets.size
  }
}

/** 归一化 IP 字符串：去空白、去方括号与 IPv6 zone、剥离 ::ffff: IPv4 映射前缀。 */
function normalizeIP(addr) {
  if (typeof addr !== 'string') return ''
  let s = addr.trim()
  if (!s) return ''
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zoneIdx = s.indexOf('%')
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx)
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) {
    return s.slice(7)
  }
  return s.toLowerCase()
}

/**
 * 判断地址是否为本机回环 IP（127.0.0.0/8、::1、::ffff:127.0.0.0/8）。
 * 只认真实 IP 字面量，不把主机名当回环。
 */
export function isLoopbackAddress(addr) {
  const ip = normalizeIP(addr)
  if (!ip) return false
  if (net.isIPv4(ip)) {
    return ip.startsWith('127.')
  }
  if (net.isIPv6(ip)) {
    // 处理 ::1 以及展开形式 0:0:0:0:0:0:0:1；::ffff:7fxx:xxxx 也在回环段内
    if (ip === '::1') return true
    const full = expandIPv6(ip)
    if (!full) return false
    if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return true
    // IPv4-mapped 127.0.0.0/8 的十六进制形式：0000:0000:0000:0000:0000:ffff:7fxx:xxxx
    if (full.startsWith('0000:0000:0000:0000:0000:ffff:7f')) return true
  }
  return false
}

/** 将压缩或混合 IPv6 展开为 8 组 4 位十六进制，便于准确判断回环段。 */
function expandIPv6(ip) {
  const parts = ip.split('::')
  if (parts.length > 2) return ''
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const missing = 8 - (left.length + right.length)
  if (parts.length === 1 && missing !== 0) return ''
  if (parts.length === 2 && missing < 0) return ''
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right]
  if (groups.length !== 8) return ''
  return groups.map((g) => g.padStart(4, '0')).join(':')
}

/**
 * 提取客户端真实 IP：
 * 只有当 trustProxy 为 true 且直连 TCP 对端本身是回环（例如本地 cloudflared 进程）时，
 * 才信任 CF-Connecting-IP / X-Forwarded-For；非回环直连客户端伪造的转发头一律忽略。
 */
export function extractClientIP(req, { trustProxy = false } = {}) {
  const peer = normalizeIP(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
  if (trustProxy && isLoopbackAddress(peer)) {
    const headers = req?.headers || {}
    const cfRaw = Array.isArray(headers['cf-connecting-ip'])
      ? headers['cf-connecting-ip'][0]
      : headers['cf-connecting-ip']
    if (typeof cfRaw === 'string' && cfRaw.trim()) {
      const candidate = normalizeIP(cfRaw.split(',')[0])
      if (net.isIP(candidate)) return candidate
    }
    const xffRaw = Array.isArray(headers['x-forwarded-for'])
      ? headers['x-forwarded-for'].join(',')
      : headers['x-forwarded-for']
    if (typeof xffRaw === 'string' && xffRaw.trim()) {
      for (const piece of xffRaw.split(',')) {
        const candidate = normalizeIP(piece)
        if (net.isIP(candidate)) return candidate
      }
    }
  }
  return peer
}

function readCookieValue(headerValue, name) {
  const raw = Array.isArray(headerValue) ? headerValue.join('; ') : String(headerValue || '')
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) {
      return segment.slice(at + 1).trim()
    }
  }
  return ''
}

/**
 * 从 HTTP 请求中提取设备 token：优先 Authorization: Bearer，其次 dsh-x-device Cookie。
 * @returns {{ token: string, source: 'bearer' | 'cookie' } | null}
 */
export function extractDeviceToken(req) {
  const headers = req?.headers || {}
  const authRaw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization
  if (typeof authRaw === 'string') {
    const match = authRaw.trim().match(/^Bearer\s+(\S+)$/i)
    if (match && match[1]) {
      return { token: match[1], source: 'bearer' }
    }
  }
  const cookieToken = readCookieValue(headers.cookie, DEVICE_COOKIE_NAME)
  if (cookieToken) {
    return { token: cookieToken, source: 'cookie' }
  }
  return null
}

/** 构造已配对设备的 HttpOnly 会话 Cookie（不让前端 JS 读到凭证，防 XSS 直接窃取）。 */
export function buildDeviceCookie(token, { secure = false, maxAgeDays = DEFAULT_COOKIE_MAX_AGE_DAYS } = {}) {
  const safeToken = String(token ?? '').replace(/[;\r\n\s]+/g, '')
  const maxAge = Math.max(0, Math.floor(maxAgeDays * 24 * 60 * 60))
  const parts = [
    `${DEVICE_COOKIE_NAME}=${safeToken}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** 构造清除设备会话 Cookie 的 Set-Cookie 头（登出或被踢下线时使用）。 */
export function buildClearDeviceCookie({ secure = false } = {}) {
  const parts = [
    `${DEVICE_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** 归一化 Origin 为 `scheme://host`（小写），无效或非 http(s) 返回空串。 */
function parseHttpOrigin(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'null') return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { origin: u.origin.toLowerCase(), protocol: u.protocol, host: u.host.toLowerCase() }
  } catch {
    return null
  }
}

/** 把 Host 头按给定协议解析成标准 host（剥掉 http:80 / https:443 默认端口）以便与 Origin 对齐。 */
function canonicalHostForProtocol(hostHeader, protocol) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return ''
  try {
    return new URL(`${protocol}//${hostHeader.trim()}`).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 校验基于 Cookie 的写请求（非 GET/HEAD/OPTIONS）是否来自同源，防跨站请求伪造（CSRF）。
 *
 * 为什么不能只靠 SameSite=Lax：
 * - 部分同站子域或旧 WebView 仍可能携带 Lax Cookie 发起跨源写操作；
 * - 网关跑在本地 cloudflared 后面时，浏览器发来 https:// Origin 而本地 socket 是明文 HTTP，
 *   因此同源比对按 Host 对齐（并禁止 HTTPS 连接上的 http:// 降级 Origin）。
 * - Bearer 令牌与无浏览器来源头的脚本请求不受浏览器自动附带 Cookie 的 CSRF 威胁，直接放行。
 */
export function cookieWriteCsrfOk(req, { allowedOrigins = [] } = {}) {
  const method = String(req?.method || 'GET').toUpperCase()
  if (SAFE_HTTP_METHODS.has(method)) return true

  // 显式 Bearer 鉴权不是浏览器自动附带的 Cookie，不存在 CSRF 风险
  const extracted = extractDeviceToken(req)
  if (extracted?.source === 'bearer') return true

  const headers = req?.headers || {}
  const allowedSet = new Set()
  for (const item of allowedOrigins) {
    const parsed = parseHttpOrigin(item)
    if (parsed) allowedSet.add(parsed.origin)
  }

  const fetchSite = String(headers['sec-fetch-site'] || '').trim().toLowerCase()
  const originHeader = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin
  const refererHeader = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer
  const hostHeader = Array.isArray(headers.host) ? headers.host[0] : headers.host
  const isEncrypted = Boolean(req?.socket?.encrypted)

  const matchesOrigin = (parsed) => {
    if (!parsed) return false
    if (allowedSet.has(parsed.origin)) return true
    // 若浏览器明确声明 cross-site / same-site，只有白名单显式允许的 origin 才能过
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false
    if (isEncrypted && parsed.protocol !== 'https:') return false
    const expectedHost = canonicalHostForProtocol(hostHeader, parsed.protocol)
    return Boolean(expectedHost) && parsed.host === expectedHost
  }

  // 1. 优先校验 Origin（拒绝 "null" 来源，例如 sandboxed iframe / data: 页面）
  if (originHeader !== undefined && String(originHeader).trim() !== '') {
    const parsed = parseHttpOrigin(originHeader)
    return matchesOrigin(parsed)
  }

  // 2. 没有 Origin 时退回校验 Referer
  if (refererHeader !== undefined && String(refererHeader).trim() !== '') {
    const parsed = parseHttpOrigin(refererHeader)
    return matchesOrigin(parsed)
  }

  // 3. Origin 和 Referer 都缺失时看 Sec-Fetch-Site；三者都缺失说明是非浏览器客户端
  if (fetchSite) {
    return fetchSite === 'same-origin' || fetchSite === 'none'
  }
  return true
}
