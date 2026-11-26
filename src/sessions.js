/**
 * 跨用户目录（DSH_HOME）的会话静态索引与离线维护引擎（方案 A）。
 *
 * 设计约束：
 * 1. 纯静态只读分析：读取过程不连实例、不碰 dsh 锁、不挂 fs.watch，不干扰运行中的实例。
 *    - `session.v4.jsonl.zstd` 只读前几 KB 解压第一个 zstd 帧拿到 header（O(1)，不重写 dsh-session-format）；
 *    - 优先读新版 `storages/session_projcache/sessions/<id>.json`（v7 per-record），兼容旧版 `storages/session_projcache.json`（v3）；
 *    - 归并 `sessions/` 磁盘目录、 `workspace.json` 与 `session_projcache`，连未挂载工作区的孤儿会话也能盘点。
 * 2. 离线安全写入：dsh 运行时会把 `workspace.json` 缓存在内存里，强行改盘会被覆盖；
 *    因此所有写/删操作先检活（目标 `DSH_HOME` 无运行中实例），再加独占锁、留 `.bak-<时间戳>` 备份、原子写并回读校验。
 * 3. 附件 `attachments/v1` 是内容寻址（CAS）且无引用计数表：删除会话默认不动附件库，避免误删其他会话共享的附件。
 */
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, open, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { writeJsonAtomicSync } from './fs-utils.js'
import { mapLimit } from './storage-stats.js'

const HEADER_PROBE_INITIAL_BYTES = 8192
const HEADER_PROBE_FALLBACK_BYTES = 65536
const HEADER_CACHE_MAX = 4000
const PROMPT_PREVIEW_MAX = 140
const STALE_INACTIVE_MS = 90 * 24 * 60 * 60 * 1000
const SCAN_DIR_CONCURRENCY = 8
const SCAN_FILE_CONCURRENCY = 16
const PROJCACHE_COMPAT_VERSIONS = new Set([3, 4, 5, 6, 7])
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.(zstd|zst))?$/i
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 不可删除范围的固定说明键（前端按 i18n 渲染），对齐 ZCode 与 dsh 实际目录边界。 */
export const DELETE_EXCLUDED_SCOPES = Object.freeze([
  'workspace_files',
  'git_worktree',
  'memory',
  'attachments',
  'checkpoints_logs',
])

// 按 `<文件路径>` 缓存首帧 header 与目录字节数，键里带 `mtimeMs:size`，文件没变就不重复解压。
const headerCache = new Map()

function cacheGet(key, fingerprint) {
  const entry = headerCache.get(key)
  if (!entry || entry.fp !== fingerprint) return undefined
  return entry.value
}

function cacheSet(key, fingerprint, value) {
  headerCache.set(key, { fp: fingerprint, value })
  if (headerCache.size <= HEADER_CACHE_MAX) return
  const drop = headerCache.size - HEADER_CACHE_MAX
  let count = 0
  for (const k of headerCache.keys()) {
    headerCache.delete(k)
    count += 1
    if (count >= drop) break
  }
}

/** 测试用：清空模块级 header 缓存，避免复用同名临时路径时读到旧结果。 */
export function clearSessionScanCache() {
  headerCache.clear()
}

/**
 * 反向解码 dsh 的 `encodeSegment`（`~XXXX` → UTF-16 码元）。
 * 与 `@deepseek-ai/dsh-session-persistence-jsonl` 的编码规则一一对应。
 */
export function decodeSessionSegment(segment) {
  return String(segment || '').replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** 与 dsh `encodeSegment` 同款编码，便于按 id 反推目录名。 */
export function encodeSessionSegment(raw) {
  const text = String(raw || '')
  if (!text) throw new Error('会话 ID 不能为空')
  if (text === '.') return '~002E'
  if (text === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function normalizePathKey(p, caseInsensitive = process.platform === 'win32') {
  const cleaned = resolve(String(p || ''))
  return caseInsensitive ? cleaned.toLowerCase() : cleaned
}

function isInsideDir(parentDir, targetPath, caseInsensitive = process.platform === 'win32') {
  const parent = normalizePathKey(parentDir, caseInsensitive)
  const target = normalizePathKey(targetPath, caseInsensitive)
  if (parent === target) return false
  const rel = relative(parent, target)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function trimPreview(text, max = PROMPT_PREVIEW_MAX) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 从日志文件名选出最高版本（优先 v4 zstd）。 */
function pickSessionLogFile(fileNames) {
  let best = null
  for (const name of fileNames) {
    if (name.endsWith('.tmp') || name.startsWith('.')) continue
    const match = SESSION_LOG_RE.exec(name)
    if (!match) continue
    const version = match[1] ? Number(match[1]) : 0
    const compressed = Boolean(match[2])
    if (!best || version > best.version || (version === best.version && compressed && !best.compressed)) {
      best = { name, version, compressed }
    }
  }
  return best
}

/**
 * 仅读取会话日志文件开头的首帧（zstd）或首行（明文 jsonl）解析 header。
 * dsh 会把 header 写成单独的第一个 zstd 帧（约 200B），`zstdDecompressSync`
 * 遇首帧结束即返回，不解压几 MB 的后续事件帧，也不触碰写锁。
 */
export async function readSessionHeaderFast(logFile, compressed, fileStat) {
  const fp = fileStat ? `${Math.round(fileStat.mtimeMs)}:${fileStat.size}` : ''
  if (fp) {
    const cached = cacheGet(logFile, fp)
    if (cached !== undefined) return cached
  }

  let parsed = null
  const sizes = [HEADER_PROBE_INITIAL_BYTES, HEADER_PROBE_FALLBACK_BYTES]
  for (const probeBytes of sizes) {
    let handle
    try {
      handle = await open(logFile, 'r')
      const maxRead = fileStat ? Math.min(fileStat.size, probeBytes) : probeBytes
      if (maxRead <= 0) break
      const buf = Buffer.allocUnsafe(maxRead)
      const { bytesRead } = await handle.read(buf, 0, maxRead, 0)
      await handle.close()
      handle = null
      if (bytesRead <= 0) break
      const slice = buf.subarray(0, bytesRead)
      let text = ''
      if (compressed) {
        try {
          text = zstdDecompressSync(slice).toString('utf8')
        } catch {
          // 如果首帧刚好超过 8KB，退回 64KB 再试一次；仍然失败则静默降级
          if (probeBytes < HEADER_PROBE_FALLBACK_BYTES && (!fileStat || fileStat.size > probeBytes)) continue
          break
        }
      } else {
        text = slice.toString('utf8')
      }
      const nl = text.indexOf('\n')
      const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim()
      if (!firstLine) break
      const obj = JSON.parse(firstLine)
      if (isObject(obj) && obj.type === 'session') {
        const hasMoreInFrame = nl >= 0 && text.slice(nl + 1).trim().length > 0
        const hasMoreFrames = compressed
          ? (slice.indexOf(ZSTD_MAGIC, 4) >= 0 || Boolean(fileStat && fileStat.size > bytesRead))
          : Boolean(fileStat && fileStat.size > bytesRead)
        parsed = {
          id: typeof obj.id === 'string' ? obj.id : '',
          version: typeof obj.version === 'number' ? obj.version : null,
          createdAt: toTimestampMs(obj.createdAt),
          cwd: typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd : '',
          isSeeded: obj.isSeeded === true,
          parentSession: typeof obj.parentSession === 'string' && obj.parentSession.trim() ? obj.parentSession.trim() : null,
          origin: typeof obj.origin === 'string' && obj.origin.trim() ? obj.origin.trim() : null,
          delegationDepth: typeof obj.delegationDepth === 'number' && Number.isFinite(obj.delegationDepth) ? obj.delegationDepth : 0,
          agentPreset: typeof obj.agentPreset === 'string' ? obj.agentPreset : null,
          hasEvents: hasMoreInFrame || hasMoreFrames,
        }
      }
      break
    } catch {
      if (handle) {
        try { await handle.close() } catch { /* ignore */ }
      }
      break
    }
  }

  if (fp) cacheSet(logFile, fp, parsed)
  return parsed
}

/** 读取 `storages/workspace.json`；缺失或损坏时降级为空结构，同时保留原始文档供安全回写。 */
export async function readWorkspaceStorage(home) {
  const file = join(home, 'storages', 'workspace.json')
  try {
    const raw = await readFile(file, 'utf8')
    const doc = JSON.parse(raw)
    if (!isObject(doc) || doc.unit?.name !== 'workspace') {
      return { exists: true, malformed: true, file, doc: null, workspaces: new Map(), workspaceOrder: [], archivedSet: new Set(), pinnedList: [] }
    }
    const globalObj = isObject(doc.global) ? doc.global : {}
    const wsTable = isObject(doc.tables?.workspaces) ? doc.tables.workspaces : {}
    const workspaceOrder = Array.isArray(globalObj.workspaceIds)
      ? globalObj.workspaceIds.filter((id) => typeof id === 'string' && Object.hasOwn(wsTable, id))
      : []
    for (const id of Object.keys(wsTable)) {
      if (!workspaceOrder.includes(id)) workspaceOrder.push(id)
    }
    const workspaces = new Map()
    for (const id of workspaceOrder) {
      const rec = wsTable[id]
      if (!isObject(rec) || typeof rec.path !== 'string') continue
      workspaces.set(id, {
        workspaceId: id,
        path: rec.path,
        title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : (basename(rec.path) || rec.path),
        sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds.filter((s) => typeof s === 'string') : [],
        createdAt: toTimestampMs(rec.createdAt),
        updatedAt: toTimestampMs(rec.updatedAt),
      })
    }
    const archivedSet = new Set(
      Array.isArray(globalObj.archivedSessionIds)
        ? globalObj.archivedSessionIds.filter((id) => typeof id === 'string')
        : [],
    )
    const pinnedList = Array.isArray(globalObj.pinnedSessionIds)
      ? globalObj.pinnedSessionIds.filter((id) => typeof id === 'string' && !archivedSet.has(id))
      : []
    return { exists: true, malformed: false, file, doc, workspaces, workspaceOrder, archivedSet, pinnedList }
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return { exists: !missing, malformed: !missing, file, doc: null, workspaces: new Map(), workspaceOrder: [], archivedSet: new Set(), pinnedList: [] }
  }
}

function extractProjCacheRecord(record) {
  if (!isObject(record)) return null
  const identity = isObject(record.identity) ? record.identity : {}
  const rows = isObject(record.rows) ? record.rows : {}

  const titleVal = rows.title?.val
  const explicitTitle = typeof titleVal === 'string' && titleVal.trim() ? titleVal.trim() : ''

  const firstPromptText = rows.titleInput?.val?.first?.text
  const firstPrompt = typeof firstPromptText === 'string' ? trimPreview(firstPromptText) : ''

  const listMeta = isObject(rows.sessionListMetadata?.val) ? rows.sessionListMetadata.val : null
  const blank = typeof listMeta?.blank === 'boolean' ? listMeta.blank : null
  const lastPromptAt = toTimestampMs(listMeta?.lastPromptAt)

  const stats = isObject(rows.sessionStats?.val) ? rows.sessionStats.val : null
  const turns = typeof stats?.turns === 'number' && Number.isFinite(stats.turns) ? stats.turns : null
  const steps = typeof stats?.steps === 'number' && Number.isFinite(stats.steps) ? stats.steps : null

  let totalTokens = null
  const totals = rows.tokenUsage?.val?.totals
  if (isObject(totals)) {
    const sum = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .reduce((acc, k) => acc + (typeof totals[k] === 'number' && Number.isFinite(totals[k]) ? totals[k] : 0), 0)
    if (sum > 0) totalTokens = sum
  }

  const subagentVal = rows.subagent?.val
  const isSubagentByCache = Boolean(isObject(subagentVal) && typeof subagentVal.mode === 'string')

  const subagentCatalog = Array.isArray(rows.subagentCatalog?.val)
    ? rows.subagentCatalog.val
      .filter((item) => isObject(item) && typeof item.id === 'string' && item.id)
      .map((item) => item.id)
    : []

  const forkVal = rows.forkLineage?.val
  const forkSource = isObject(forkVal) && typeof forkVal.sourceSessionId === 'string' ? forkVal.sourceSessionId : null

  return {
    cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
    createdAt: toTimestampMs(identity.createdAt),
    formatVersion: typeof identity.formatVersion === 'number' ? identity.formatVersion : null,
    isSeeded: identity.isSeeded === true,
    explicitTitle,
    firstPrompt,
    blank,
    lastPromptAt,
    turns,
    steps,
    totalTokens,
    isSubagentByCache,
    subagentCatalog,
    forkSource,
  }
}

/**
 * 读取投影缓存：优先读新版 `storages/session_projcache/sessions/<id>.json`（v7 per-record），
 * 再用旧版单文件 `storages/session_projcache.json`（v3）补齐新版里没有的条目。
 */
export async function readProjectionCache(home) {
  const map = new Map()

  // 1. 新版每会话单文件目录（v7）
  const sessionsDir = join(home, 'storages', 'session_projcache', 'sessions')
  let entries = []
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.tmp') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)

  await mapLimit(files, SCAN_FILE_CONCURRENCY, async (name) => {
    const file = join(sessionsDir, name)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (!isObject(parsed) || !PROJCACHE_COMPAT_VERSIONS.has(parsed.version)) return
      const id = decodeSessionSegment(name.slice(0, -'.json'.length))
      const extracted = extractProjCacheRecord(parsed.record)
      if (id && extracted) map.set(id, extracted)
    } catch {
      // 单条损坏或正在被写入：静默跳过，绝不影响其他会话
    }
  })

  // 2. 旧版单文件回退（v3）：只补齐目录版里缺的 sessionId
  const legacyFile = join(home, 'storages', 'session_projcache.json')
  try {
    const parsed = JSON.parse(await readFile(legacyFile, 'utf8'))
    const table = parsed?.unit?.name === 'session_projcache' && isObject(parsed.tables?.sessions)
      ? parsed.tables.sessions
      : null
    if (table) {
      for (const [id, record] of Object.entries(table)) {
        if (map.has(id)) continue
        const extracted = extractProjCacheRecord(record)
        if (extracted) map.set(id, extracted)
      }
    }
  } catch {
    // 没有旧文件或解析失败：忽略
  }

  return map
}

/** 扫描一个会话目录内的文件（只算直接子文件 + 轻量递归，跳过符号链接）。 */
async function inspectSessionDir(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const fileNames = []
  const subDirs = []
  let bytes = 0
  let latestMtimeMs = 0

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) {
      fileNames.push(entry.name)
    } else if (entry.isDirectory()) {
      subDirs.push(entry.name)
    }
  }

  const picked = pickSessionLogFile(fileNames)
  let logStat = null
  for (const name of fileNames) {
    try {
      const info = await stat(join(dir, name))
      bytes += info.size
      if (info.mtimeMs > latestMtimeMs) latestMtimeMs = info.mtimeMs
      if (picked && name === picked.name) logStat = info
    } catch { /* 文件刚好消失 */ }
  }

  // 会话目录通常扁平，偶尔带子目录（例如附属产物）时做有界递归统计大小
  const walkBytes = async (sub, depth) => {
    if (depth > 4) return
    let children
    try { children = await readdir(sub, { withFileTypes: true }) } catch { return }
    for (const child of children) {
      if (child.isSymbolicLink()) continue
      const p = join(sub, child.name)
      if (child.isFile()) {
        try {
          const info = await stat(p)
          bytes += info.size
          if (info.mtimeMs > latestMtimeMs) latestMtimeMs = info.mtimeMs
        } catch { /* ignore */ }
      } else if (child.isDirectory()) {
        await walkBytes(p, depth + 1)
      }
    }
  }
  for (const sub of subDirs) {
    await walkBytes(join(dir, sub), 1)
  }

  const header = picked
    ? await readSessionHeaderFast(join(dir, picked.name), picked.compressed, logStat)
    : null

  return {
    bytes,
    mtimeMs: latestMtimeMs,
    hasLog: Boolean(picked),
    header,
  }
}

/** 扫描 `<home>/sessions/` 下所有磁盘会话目录。 */
async function scanSessionFiles(home) {
  const sessionsRoot = join(home, 'sessions')
  const byId = new Map()
  let projectEntries
  try {
    projectEntries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return byId
  }

  const projectDirs = projectEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)

  await mapLimit(projectDirs, SCAN_DIR_CONCURRENCY, async (projectKey) => {
    const projPath = join(sessionsRoot, projectKey)
    let sessionEntries
    try {
      sessionEntries = await readdir(projPath, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = sessionEntries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)

    await mapLimit(dirs, SCAN_FILE_CONCURRENCY, async (encodedId) => {
      const dir = join(projPath, encodedId)
      const info = await inspectSessionDir(dir)
      if (!info) return
      const sessionId = info.header?.id || decodeSessionSegment(encodedId)
      if (!sessionId) return
      // 若同一 id 意外出现在两个项目目录下，优先留带日志或更新的那个
      const existing = byId.get(sessionId)
      if (existing && (existing.hasLog && !info.hasLog || existing.mtimeMs > info.mtimeMs)) return
      byId.set(sessionId, {
        sessionId,
        projectKey,
        encodedId,
        sessionDir: dir,
        bytes: info.bytes,
        mtimeMs: info.mtimeMs,
        hasLog: info.hasLog,
        header: info.header,
      })
    })
  })

  return byId
}

/** 异步判断目录是否存在（限流复用，避免阻塞事件循环）。 */
async function pathExistsAsDir(target) {
  if (!target) return false
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 扫描单个 `DSH_HOME`，归并 `workspace.json` + `session_projcache` + `sessions/` 磁盘文件。
 */
export async function scanHomeSessions(home, { homeLabel = '', homeRunning = false, now = Date.now() } = {}) {
  const canonicalHome = resolve(home)
  const label = homeLabel || basename(canonicalHome) || canonicalHome

  const [wsStorage, projCache, diskSessions] = await Promise.all([
    readWorkspaceStorage(canonicalHome),
    readProjectionCache(canonicalHome),
    scanSessionFiles(canonicalHome),
  ])

  // 建立 sessionId -> workspace 的反向映射
  const sessionToWorkspace = new Map()
  for (const ws of wsStorage.workspaces.values()) {
    for (const sid of ws.sessionIds) {
      if (!sessionToWorkspace.has(sid)) sessionToWorkspace.set(sid, ws)
    }
  }

  // 汇总全部出现过的 sessionId（磁盘 ∪ workspace.json）
  // 不单独把「仅存在于 projcache 但既不在磁盘也不在 workspace.json」的陈旧缓存当作会话
  const allIds = new Set([...diskSessions.keys(), ...sessionToWorkspace.keys()])

  // 先检查所有涉及的工作区路径是否在磁盘上存在（去重后批量 stat）
  const uniquePaths = new Set()
  for (const ws of wsStorage.workspaces.values()) {
    if (ws.path) uniquePaths.add(ws.path)
  }
  for (const id of allIds) {
    const disk = diskSessions.get(id)
    const cache = projCache.get(id)
    const cwd = disk?.header?.cwd || cache?.cwd || ''
    if (cwd) uniquePaths.add(cwd)
  }
  const pathExistsMap = new Map()
  await mapLimit([...uniquePaths], SCAN_FILE_CONCURRENCY, async (p) => {
    pathExistsMap.set(p, await pathExistsAsDir(p))
  })

  const pinIndex = new Map()
  wsStorage.pinnedList.forEach((id, idx) => pinIndex.set(id, idx))

  // 收集父子关系（header.parentSession + projcache.subagentCatalog + forkLineage）
  const childrenByParent = new Map()
  const linkChild = (parentId, childId) => {
    if (!parentId || !childId || parentId === childId) return
    let set = childrenByParent.get(parentId)
    if (!set) {
      set = new Set()
      childrenByParent.set(parentId, set)
    }
    set.add(childId)
  }
  for (const id of allIds) {
    const disk = diskSessions.get(id)
    const cache = projCache.get(id)
    if (disk?.header?.parentSession) linkChild(disk.header.parentSession, id)
    if (cache?.forkSource) linkChild(cache.forkSource, id)
    if (cache?.subagentCatalog?.length) {
      for (const childId of cache.subagentCatalog) {
        if (allIds.has(childId)) linkChild(id, childId)
      }
    }
  }

  const sessions = []
  for (const sessionId of allIds) {
    const disk = diskSessions.get(sessionId) || null
    const cache = projCache.get(sessionId) || null
    const ws = sessionToWorkspace.get(sessionId) || null

    const workspacePath = ws?.path || disk?.header?.cwd || cache?.cwd || ''
    const workspaceTitle = ws?.title || (workspacePath ? (basename(workspacePath) || workspacePath) : (disk?.projectKey || ''))
    const workspaceId = ws?.workspaceId || null
    const orphan = !ws

    const explicitTitle = cache?.explicitTitle || ''
    const firstPrompt = cache?.firstPrompt || ''
    const title = explicitTitle || firstPrompt || ''

    const createdAt = disk?.header?.createdAt || cache?.createdAt || disk?.mtimeMs || 0
    const lastPromptAt = cache?.lastPromptAt || 0
    const updatedAt = Math.max(lastPromptAt, disk?.mtimeMs || 0, createdAt)

    const archived = wsStorage.archivedSet.has(sessionId)
    const pinned = !archived && pinIndex.has(sessionId)
    const pinOrder = pinned ? pinIndex.get(sessionId) : -1

    const parentSession = disk?.header?.parentSession || cache?.forkSource || null
    const origin = disk?.header?.origin || (cache?.forkSource ? 'fork' : null)
    const delegationDepth = disk?.header?.delegationDepth || 0
    const isSubagent = origin === 'subagent' || delegationDepth > 0 || Boolean(cache?.isSubagentByCache)

    // 空白会话判定：优先用 dsh 自己记录的 sessionListMetadata.blank；
    // 无缓存时，依据日志文件是否只有首帧 header、没有任何后续事件帧来判定，避免误伤短对话。
    const blank = cache?.blank !== null && cache?.blank !== undefined
      ? cache.blank
      : (!isSubagent && !explicitTitle && !firstPrompt && Boolean(disk?.header) && disk.header.hasEvents === false)

    const childIds = [...(childrenByParent.get(sessionId) || [])].filter((cid) => allIds.has(cid))

    sessions.push({
      sessionId,
      home: canonicalHome,
      homeLabel: label,
      source: 'local',
      workspaceId,
      workspaceTitle,
      workspacePath,
      workspaceMissing: Boolean(workspacePath) && !pathExistsMap.get(workspacePath),
      projectKey: disk?.projectKey || '',
      title,
      explicitTitle,
      firstPrompt,
      createdAt,
      updatedAt,
      lastPromptAt: lastPromptAt || null,
      turns: cache?.turns ?? null,
      steps: cache?.steps ?? null,
      totalTokens: cache?.totalTokens ?? null,
      bytes: disk?.bytes || 0,
      archived,
      pinned,
      pinOrder,
      blank,
      orphan,
      hasFiles: Boolean(disk),
      sessionDir: disk?.sessionDir || '',
      parentSession,
      origin,
      delegationDepth,
      isSubagent,
      childIds,
      homeRunning,
    })
  }

  // 构建工作区视图（包含 workspace.json 中已登记的 + 磁盘上未挂载的孤儿分组）
  const workspaceMap = new Map()
  for (const ws of wsStorage.workspaces.values()) {
    workspaceMap.set(ws.workspaceId, {
      id: ws.workspaceId,
      home: canonicalHome,
      homeLabel: label,
      source: 'local',
      title: ws.title,
      path: ws.path,
      mounted: true,
      exists: Boolean(ws.path) && Boolean(pathExistsMap.get(ws.path)),
      sessionCount: 0,
      activeCount: 0,
      archivedCount: 0,
      blankCount: 0,
      bytes: 0,
      lastActivityAt: ws.updatedAt || ws.createdAt || 0,
      createdAt: ws.createdAt || 0,
      staleReasons: [],
      stale: false,
      homeRunning,
    })
  }

  // 统计各工作区（以及按 projectKey 归组的孤儿目录）的指标
  for (const s of sessions) {
    let groupKey = s.workspaceId
    if (!groupKey) {
      const key = s.projectKey || (s.workspacePath ? normalizePathKey(s.workspacePath) : '_unmounted')
      groupKey = `orphan:${key}`
      if (!workspaceMap.has(groupKey)) {
        workspaceMap.set(groupKey, {
          id: groupKey,
          home: canonicalHome,
          homeLabel: label,
          source: 'local',
          title: s.workspaceTitle || s.projectKey || '未挂载会话',
          path: s.workspacePath || '',
          mounted: false,
          exists: Boolean(s.workspacePath) && Boolean(pathExistsMap.get(s.workspacePath)),
          sessionCount: 0,
          activeCount: 0,
          archivedCount: 0,
          blankCount: 0,
          bytes: 0,
          lastActivityAt: 0,
          createdAt: s.createdAt || 0,
          staleReasons: [],
          stale: false,
          homeRunning,
        })
      }
    }
    const group = workspaceMap.get(groupKey)
    if (!group) continue
    group.sessionCount += 1
    if (s.archived) group.archivedCount += 1
    else if (!s.isSubagent) group.activeCount += 1
    if (s.blank && !s.archived) group.blankCount += 1
    group.bytes += s.bytes
    if (s.updatedAt > group.lastActivityAt) group.lastActivityAt = s.updatedAt
    if (s.createdAt && (!group.createdAt || s.createdAt < group.createdAt)) group.createdAt = s.createdAt
  }

  const workspaces = []
  for (const ws of workspaceMap.values()) {
    const reasons = []
    if (ws.path && !ws.exists) reasons.push('missing_dir')
    if (ws.activeCount === 0) reasons.push('empty')
    if (ws.lastActivityAt > 0 && now - ws.lastActivityAt >= STALE_INACTIVE_MS) reasons.push('inactive_90d')
    ws.staleReasons = reasons
    ws.stale = reasons.length > 0
    workspaces.push(ws)
  }

  const bytes = sessions.reduce((sum, s) => sum + s.bytes, 0)
  return {
    home: {
      home: canonicalHome,
      label,
      source: 'local',
      running: homeRunning,
      exists: existsSync(canonicalHome),
      workspaceMalformed: wsStorage.malformed,
      sessionCount: sessions.length,
      activeCount: sessions.filter((s) => !s.archived && !s.isSubagent).length,
      archivedCount: sessions.filter((s) => s.archived).length,
      blankCount: sessions.filter((s) => s.blank && !s.archived).length,
      orphanCount: sessions.filter((s) => s.orphan).length,
      bytes,
    },
    workspaces,
    sessions,
  }
}

/**
 * 扫描所有已登记的本机 `DSH_HOME`，返回统一汇总结构。
 * @param {Array<{home: string, label?: string, running?: boolean}>} homeEntries
 */
export async function indexAllSessions(homeEntries, { now = Date.now() } = {}) {
  const results = await Promise.all(
    homeEntries.map((entry) => scanHomeSessions(entry.home, {
      homeLabel: entry.label || '',
      homeRunning: Boolean(entry.running),
      now,
    })),
  )

  const homes = []
  const workspaces = []
  const sessions = []
  for (const part of results) {
    homes.push(part.home)
    workspaces.push(...part.workspaces)
    sessions.push(...part.sessions)
  }

  // 默认按最近活动倒序，同时间按 sessionId 稳定排序
  sessions.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.sessionId < b.sessionId ? -1 : 1))
  workspaces.sort((a, b) => (Number(b.mounted) - Number(a.mounted)) || (b.lastActivityAt - a.lastActivityAt))

  const summary = {
    total: sessions.length,
    active: sessions.filter((s) => !s.archived && !s.isSubagent).length,
    archived: sessions.filter((s) => s.archived).length,
    pinned: sessions.filter((s) => s.pinned).length,
    blank: sessions.filter((s) => s.blank && !s.archived).length,
    orphan: sessions.filter((s) => s.orphan).length,
    subagent: sessions.filter((s) => s.isSubagent).length,
    workspaces: workspaces.length,
    staleWorkspaces: workspaces.filter((w) => w.stale).length,
    bytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
  }

  return { homes, workspaces, sessions, summary, scannedAt: now }
}

// ============================================================================
// 离线安全写锁与 workspace.json 原子改写
// ============================================================================

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * 针对单个 `DSH_HOME` 的 `storages/` 加独占文件锁（`wx` + PID 僵死探测）。
 * 只在离线写/删路径使用；只读扫描绝不拿锁。
 */
export async function withStorageLock(home, operation, probe = pidAlive) {
  const storagesDir = join(home, 'storages')
  mkdirSync(storagesDir, { recursive: true })
  const lockPath = join(storagesDir, '.dsh-x-workspace.lock')
  let fd
  for (let attempt = 0; ; attempt += 1) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (attempt >= 1) throw new Error('另一个会话维护操作正在进行，请稍后再试')
      let holder = 0
      try {
        holder = Number(String(await readFile(lockPath, 'utf8')).trim())
      } catch {
        holder = 0
      }
      if (holder && probe(holder)) {
        throw new Error('另一个会话维护操作正在进行，请稍后再试')
      }
      try { unlinkSync(lockPath) } catch { /* 已被清理 */ }
    }
  }
  try {
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    fd = undefined
    return await operation()
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
}

async function backupWorkspaceJson(file) {
  if (!existsSync(file)) return ''
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-${stamp}`
  try {
    await copyFile(file, backup)
    return backup
  } catch {
    return ''
  }
}

function ensureWorkspaceDoc(doc) {
  const next = isObject(doc) ? structuredClone(doc) : {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: {} },
  }
  if (!isObject(next.unit)) next.unit = { name: 'workspace', version: 2 }
  if (!isObject(next.global)) next.global = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
  if (!Array.isArray(next.global.workspaceIds)) next.global.workspaceIds = []
  if (!Array.isArray(next.global.archivedSessionIds)) next.global.archivedSessionIds = []
  if (!Array.isArray(next.global.pinnedSessionIds)) next.global.pinnedSessionIds = []
  if (!isObject(next.tables)) next.tables = { workspaces: {} }
  if (!isObject(next.tables.workspaces)) next.tables.workspaces = {}
  return next
}

async function writeAndVerifyWorkspaceDoc(file, doc) {
  await backupWorkspaceJson(file)
  writeJsonAtomicSync(file, doc)
  const verified = JSON.parse(await readFile(file, 'utf8'))
  if (!isObject(verified) || verified.unit?.name !== 'workspace' || !isObject(verified.global) || !isObject(verified.tables?.workspaces)) {
    throw new Error('写后校验 workspace.json 失败')
  }
}

function groupByHome(items) {
  const groups = new Map()
  for (const item of items) {
    if (!item || typeof item.home !== 'string' || typeof item.sessionId !== 'string') continue
    const home = resolve(item.home)
    const sessionId = item.sessionId.trim()
    if (!sessionId) continue
    let list = groups.get(home)
    if (!list) {
      list = []
      groups.set(home, list)
    }
    if (!list.includes(sessionId)) list.push(sessionId)
  }
  return groups
}

function makeResultBuckets() {
  return {
    succeeded: [],
    failed: [],
    skipped: [],
    reasons: {},
  }
}

function pushFailure(buckets, entry, reason, message) {
  buckets.failed.push({ ...entry, reason, message })
  buckets.reasons[reason] = (buckets.reasons[reason] || 0) + 1
}

function pushSkipped(buckets, entry, reason, message) {
  buckets.skipped.push({ ...entry, reason, message })
  buckets.reasons[reason] = (buckets.reasons[reason] || 0) + 1
}

/**
 * 离线批量变更会话状态：archive / unarchive / pin / unpin。
 * 严格遵循 dsh 规则：归档与置顶互斥、目标 `DSH_HOME` 运行中拒绝直写。
 */
export async function mutateSessionsState({ items, action, isHomeRunning = () => false, allowedHomes = null }) {
  if (!['archive', 'unarchive', 'pin', 'unpin'].includes(action)) {
    throw new Error(`不支持的会话状态操作：${action}`)
  }
  const allowedSet = allowedHomes ? new Set(allowedHomes.map((h) => normalizePathKey(h))) : null
  const buckets = makeResultBuckets()
  const groups = groupByHome(Array.isArray(items) ? items : [])

  for (const [home, sessionIds] of groups) {
    if (allowedSet && !allowedSet.has(normalizePathKey(home))) {
      for (const sessionId of sessionIds) pushFailure(buckets, { home, sessionId }, 'unknown_home', '未登记的用户目录')
      continue
    }
    if (isHomeRunning(home)) {
      for (const sessionId of sessionIds) pushFailure(buckets, { home, sessionId }, 'running_home', '该用户目录有实例正在运行，请先停止实例后再修改')
      continue
    }

    await withStorageLock(home, async () => {
      // 拿到锁后二次检活，消除锁等待期间启动实例的窗口
      if (isHomeRunning(home)) {
        for (const sessionId of sessionIds) pushFailure(buckets, { home, sessionId }, 'running_home', '该用户目录有实例正在运行，请先停止实例后再修改')
        return
      }
      const ws = await readWorkspaceStorage(home)
      if (ws.malformed) {
        for (const sessionId of sessionIds) pushFailure(buckets, { home, sessionId }, 'malformed_storage', 'workspace.json 格式损坏，已跳过写入以防覆盖')
        return
      }
      const doc = ensureWorkspaceDoc(ws.doc)
      let dirty = false

      for (const sessionId of sessionIds) {
        const archived = doc.global.archivedSessionIds
        const pinned = doc.global.pinnedSessionIds
        if (action === 'archive') {
          const wasArchived = archived.includes(sessionId)
          const wasPinned = pinned.includes(sessionId)
          if (wasArchived && !wasPinned) {
            pushSkipped(buckets, { home, sessionId }, 'already_archived', '该会话已处于归档状态')
            continue
          }
          if (!wasArchived) archived.push(sessionId)
          // 规则对齐：归档与置顶互斥
          if (wasPinned) doc.global.pinnedSessionIds = pinned.filter((id) => id !== sessionId)
          dirty = true
          buckets.succeeded.push({ home, sessionId })
        } else if (action === 'unarchive') {
          if (!archived.includes(sessionId)) {
            pushSkipped(buckets, { home, sessionId }, 'not_archived', '该会话未归档')
            continue
          }
          doc.global.archivedSessionIds = archived.filter((id) => id !== sessionId)
          dirty = true
          buckets.succeeded.push({ home, sessionId })
        } else if (action === 'pin') {
          if (archived.includes(sessionId)) {
            pushFailure(buckets, { home, sessionId }, 'archived_cannot_pin', '已归档会话不能置顶，请先取消归档')
            continue
          }
          if (pinned[0] === sessionId) {
            pushSkipped(buckets, { home, sessionId }, 'already_pinned', '该会话已置顶')
            continue
          }
          doc.global.pinnedSessionIds = [sessionId, ...pinned.filter((id) => id !== sessionId)]
          dirty = true
          buckets.succeeded.push({ home, sessionId })
        } else if (action === 'unpin') {
          if (!pinned.includes(sessionId)) {
            pushSkipped(buckets, { home, sessionId }, 'not_pinned', '该会话未置顶')
            continue
          }
          doc.global.pinnedSessionIds = pinned.filter((id) => id !== sessionId)
          dirty = true
          buckets.succeeded.push({ home, sessionId })
        }
      }

      if (dirty) {
        await writeAndVerifyWorkspaceDoc(ws.file, doc)
      }
    })
  }

  return buckets
}

/** 收集一组目标会话的所有传递子会话（同 home 内）。 */
function expandChildrenInHome(seedIds, sessionsById) {
  const seedSet = new Set(seedIds)
  const extraChildren = []
  const visited = new Set(seedIds)
  const queue = [...seedIds]
  while (queue.length > 0) {
    const current = queue.shift()
    const record = sessionsById.get(current)
    if (!record) continue
    for (const childId of record.childIds || []) {
      if (visited.has(childId)) continue
      visited.add(childId)
      if (!seedSet.has(childId)) {
        const child = sessionsById.get(childId)
        if (child) {
          extraChildren.push(child)
          queue.push(childId)
        }
      }
    }
  }
  return extraChildren
}

/**
 * 永久删除前的范围预检：
 * - 列出待删会话、关联子会话/分叉、释放字节数；
 * - 分档标出阻塞原因（运行中实例 / 未归档 / 不存在）；
 * - 明确列出不在删除范围的目录（工作区代码、Git/worktree、记忆、去重附件库、检查点与日志）。
 */
export async function previewDeleteSessions({
  items,
  includeChildren = false,
  requireArchived = false,
  homeEntries = [],
  isHomeRunning = () => false,
}) {
  const groups = groupByHome(Array.isArray(items) ? items : [])
  const labelMap = new Map(homeEntries.map((e) => [normalizePathKey(e.home), e.label || basename(e.home)]))
  const allowedSet = homeEntries.length > 0 ? new Set(homeEntries.map((e) => normalizePathKey(e.home))) : null

  const targets = []
  const children = []
  const blocked = []
  const runningHomes = []
  const reasons = {}
  const addBlocked = (entry, reason, message) => {
    blocked.push({ ...entry, reason, message })
    reasons[reason] = (reasons[reason] || 0) + 1
  }

  for (const [home, sessionIds] of groups) {
    const homeKey = normalizePathKey(home)
    if (allowedSet && !allowedSet.has(homeKey)) {
      for (const sessionId of sessionIds) addBlocked({ home, sessionId }, 'unknown_home', '未登记的用户目录')
      continue
    }
    const running = isHomeRunning(home)
    const homeLabel = labelMap.get(homeKey) || basename(home) || home
    if (running) runningHomes.push({ home, label: homeLabel })

    const scanned = await scanHomeSessions(home, { homeLabel, homeRunning: running })
    const byId = new Map(scanned.sessions.map((s) => [s.sessionId, s]))

    const validIds = []
    for (const sessionId of sessionIds) {
      const s = byId.get(sessionId)
      if (!s) {
        addBlocked({ home, homeLabel, sessionId }, 'not_found', '会话不存在或已被删除')
        continue
      }
      if (requireArchived && !s.archived) {
        addBlocked({ home, homeLabel, sessionId, title: s.title }, 'not_archived', '该会话已取消归档，不再属于归档删除范围')
        continue
      }
      if (running) {
        addBlocked({ home, homeLabel, sessionId, title: s.title, bytes: s.bytes }, 'running_home', '该用户目录有实例正在运行，需先停止实例再永久删除')
        continue
      }
      validIds.push(sessionId)
      targets.push({
        home,
        homeLabel,
        sessionId,
        title: s.title,
        workspaceTitle: s.workspaceTitle,
        workspacePath: s.workspacePath,
        bytes: s.bytes,
        archived: s.archived,
        blank: s.blank,
        orphan: s.orphan,
      })
    }

    // 即使当前被 running_home 拦住，也把子会话影响算出来，方便用户做决策
    const seedForChildren = running ? sessionIds.filter((id) => byId.has(id)) : validIds
    const extraChildren = expandChildrenInHome(seedForChildren, byId)
    for (const child of extraChildren) {
      children.push({
        home,
        homeLabel,
        sessionId: child.sessionId,
        parentSession: child.parentSession,
        title: child.title,
        origin: child.origin,
        bytes: child.bytes,
      })
    }
  }

  const targetBytes = targets.reduce((sum, item) => sum + (item.bytes || 0), 0)
  const childrenBytes = children.reduce((sum, item) => sum + (item.bytes || 0), 0)

  return {
    targets,
    children,
    blocked,
    runningHomes,
    reasons,
    shares: [], // 预留扩展位：当前标准版 dsh 本地无 social-* 分享副本
    excluded: [...DELETE_EXCLUDED_SCOPES],
    includeChildren: Boolean(includeChildren),
    totalDeleteCount: targets.length + (includeChildren ? children.length : 0),
    estimatedFreedBytes: targetBytes + (includeChildren ? childrenBytes : 0),
    targetBytes,
    childrenBytes,
  }
}

/** 从旧版单文件 `storages/session_projcache.json` 中移除已删会话条目（若文件存在）。 */
async function pruneLegacyProjCache(home, deletedSet) {
  const file = join(home, 'storages', 'session_projcache.json')
  if (!existsSync(file)) return
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'))
    const table = doc?.unit?.name === 'session_projcache' && isObject(doc.tables?.sessions) ? doc.tables.sessions : null
    if (!table) return
    let changed = false
    for (const id of deletedSet) {
      if (Object.hasOwn(table, id)) {
        delete table[id]
        changed = true
      }
    }
    if (changed) writeJsonAtomicSync(file, doc)
  } catch {
    // 缓存清理失败不阻断删除主流程
  }
}

/** 清理删除会话后变成空目录的 `<home>/sessions/<projectKey>`。 */
async function removeIfEmptyDir(dir, sessionsRoot) {
  if (!isInsideDir(sessionsRoot, dir)) return
  try {
    const entries = await readdir(dir)
    if (entries.length === 0) await rmdir(dir)
  } catch {
    // 非空或已删：忽略
  }
}

/**
 * 执行永久删除会话（仅离线模式：目标 `DSH_HOME` 不能有运行中的实例）。
 * 删除范围严格限定于：
 * 1. `<home>/sessions/<projectKey>/<encodedSessionId>/`；
 * 2. `<home>/storages/session_projcache/sessions/<encodedSessionId>.json`（及旧单文件对应键）；
 * 3. `<home>/storages/workspace.json` 中的 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds` 引用。
 * 绝不触碰用户工作区代码目录、Git/worktree、记忆或附件去重库。
 */
export async function deleteSessions({
  items,
  includeChildren = false,
  requireArchived = false,
  allowedHomes = null,
  isHomeRunning = () => false,
}) {
  const allowedSet = allowedHomes ? new Set(allowedHomes.map((h) => normalizePathKey(h))) : null
  const groups = groupByHome(Array.isArray(items) ? items : [])
  const result = {
    ...makeResultBuckets(),
    freedBytes: 0,
  }

  for (const [home, requestedIds] of groups) {
    if (allowedSet && !allowedSet.has(normalizePathKey(home))) {
      for (const sessionId of requestedIds) pushFailure(result, { home, sessionId }, 'unknown_home', '未登记的用户目录')
      continue
    }
    if (isHomeRunning(home)) {
      for (const sessionId of requestedIds) pushFailure(result, { home, sessionId }, 'running_home', '该用户目录有实例正在运行，已跳过删除')
      continue
    }

    await withStorageLock(home, async () => {
      if (isHomeRunning(home)) {
        for (const sessionId of requestedIds) pushFailure(result, { home, sessionId }, 'running_home', '该用户目录有实例正在运行，已跳过删除')
        return
      }
      const ws = await readWorkspaceStorage(home)
      if (ws.malformed) {
        for (const sessionId of requestedIds) pushFailure(result, { home, sessionId }, 'malformed_storage', 'workspace.json 格式损坏，已中止删除以保护数据')
        return
      }

      const scanned = await scanHomeSessions(home, { homeRunning: false })
      const byId = new Map(scanned.sessions.map((s) => [s.sessionId, s]))

      const toDelete = []
      const plannedSet = new Set()
      for (const sessionId of requestedIds) {
        const s = byId.get(sessionId)
        if (!s) {
          pushSkipped(result, { home, sessionId }, 'not_found', '会话不存在或已被删除')
          continue
        }
        if (requireArchived && !ws.archivedSet.has(sessionId)) {
          pushFailure(result, { home, sessionId }, 'state_changed', '会话已取消归档，范围已变化')
          continue
        }
        if (!plannedSet.has(sessionId)) {
          plannedSet.add(sessionId)
          toDelete.push(s)
        }
      }

      if (includeChildren && toDelete.length > 0) {
        const extra = expandChildrenInHome(toDelete.map((s) => s.sessionId), byId)
        for (const child of extra) {
          if (!plannedSet.has(child.sessionId)) {
            plannedSet.add(child.sessionId)
            toDelete.push(child)
          }
        }
      }

      if (toDelete.length === 0) return

      const sessionsRoot = join(home, 'sessions')
      const projCacheDir = join(home, 'storages', 'session_projcache', 'sessions')
      const deletedSet = new Set()
      const touchedProjectDirs = new Set()

      for (const target of toDelete) {
        try {
          if (target.sessionDir) {
            // 强边界校验：只允许删 `<home>/sessions/` 之下的两层子目录，杜绝路径逃逸
            if (!isInsideDir(sessionsRoot, target.sessionDir)) {
              pushFailure(result, { home, sessionId: target.sessionId }, 'invalid_path', '会话路径不在 sessions 目录内，已拒绝删除')
              continue
            }
            await rm(target.sessionDir, { recursive: true, force: true })
            touchedProjectDirs.add(dirname(target.sessionDir))
          }
          // 顺手清理 per-record 投影缓存文件
          const cacheNames = new Set([`${target.sessionId}.json`, `${encodeSessionSegment(target.sessionId)}.json`])
          for (const cacheName of cacheNames) {
            const cacheFile = join(projCacheDir, cacheName)
            if (isInsideDir(projCacheDir, cacheFile)) {
              await rm(cacheFile, { force: true }).catch(() => {})
            }
          }
          deletedSet.add(target.sessionId)
          result.freedBytes += target.bytes || 0
          result.succeeded.push({ home, sessionId: target.sessionId, bytes: target.bytes || 0 })
        } catch (error) {
          const code = error?.code
          const reason = ['EBUSY', 'EPERM', 'EACCES'].includes(code) ? 'locked' : 'io_error'
          pushFailure(result, { home, sessionId: target.sessionId }, reason, error instanceof Error ? error.message : String(error))
        }
      }

      if (deletedSet.size > 0) {
        // 清理空项目目录
        for (const projDir of touchedProjectDirs) {
          await removeIfEmptyDir(projDir, sessionsRoot)
        }
        // 更新 workspace.json（仅当文件存在或有引用时）
        if (ws.exists && ws.doc) {
          const doc = ensureWorkspaceDoc(ws.doc)
          let changed = false
          const beforeArch = doc.global.archivedSessionIds.length
          doc.global.archivedSessionIds = doc.global.archivedSessionIds.filter((id) => !deletedSet.has(id))
          if (doc.global.archivedSessionIds.length !== beforeArch) changed = true

          const beforePin = doc.global.pinnedSessionIds.length
          doc.global.pinnedSessionIds = doc.global.pinnedSessionIds.filter((id) => !deletedSet.has(id))
          if (doc.global.pinnedSessionIds.length !== beforePin) changed = true

          for (const rec of Object.values(doc.tables.workspaces)) {
            if (!isObject(rec) || !Array.isArray(rec.sessionIds)) continue
            const beforeLen = rec.sessionIds.length
            rec.sessionIds = rec.sessionIds.filter((id) => !deletedSet.has(id))
            if (rec.sessionIds.length !== beforeLen) {
              rec.updatedAt = new Date().toISOString()
              changed = true
            }
          }
          if (changed) {
            await writeAndVerifyWorkspaceDoc(ws.file, doc)
          }
        }
        await pruneLegacyProjCache(home, deletedSet)
      }
    })
  }

  return result
}

/**
 * 离线移除工作区登记（类似 ZCode 项目管理）：
 * - `deleteData = false`：只从 `workspace.json` 移除侧栏显示，保留所有会话文件（可恢复）；
 * - `deleteData = true`：同时删除归属该工作区的全部会话数据（仍绝不触碰用户工作区代码目录本身）。
 */
export async function removeWorkspace({
  home,
  workspaceId,
  deleteData = false,
  allowedHomes = null,
  isHomeRunning = () => false,
}) {
  const canonicalHome = resolve(String(home || ''))
  const id = String(workspaceId || '').trim()
  if (!id) throw new Error('缺少工作区 ID')
  if (allowedHomes && !allowedHomes.some((h) => normalizePathKey(h) === normalizePathKey(canonicalHome))) {
    throw new Error('未登记的用户目录')
  }
  if (isHomeRunning(canonicalHome)) {
    const err = new Error('该用户目录有实例正在运行，请先停止实例后再操作')
    err.reason = 'running_home'
    throw err
  }

  // 孤儿分组（未在 workspace.json 登记，仅磁盘上有会话）：只能走 deleteData=true 清理其会话
  if (id.startsWith('orphan:')) {
    if (!deleteData) throw new Error('该分组本来就没有挂载到侧栏，可直接删除其遗留会话数据')
    const scanned = await scanHomeSessions(canonicalHome, { homeRunning: false })
    const prefix = id.slice('orphan:'.length)
    const items = scanned.sessions
      .filter((s) => s.orphan && (
        s.projectKey === prefix
        || (s.workspacePath && normalizePathKey(s.workspacePath) === prefix)
        || (!s.projectKey && !s.workspacePath && prefix === '_unmounted')
      ))
      .map((s) => ({ home: canonicalHome, sessionId: s.sessionId }))
    const deleted = await deleteSessions({ items, includeChildren: true, allowedHomes, isHomeRunning })
    return { removed: false, orphanGroup: true, deleted }
  }

  let sessionIdsToDelete = []
  await withStorageLock(canonicalHome, async () => {
    if (isHomeRunning(canonicalHome)) {
      const err = new Error('该用户目录有实例正在运行，请先停止实例后再操作')
      err.reason = 'running_home'
      throw err
    }
    const ws = await readWorkspaceStorage(canonicalHome)
    if (ws.malformed) throw new Error('workspace.json 格式损坏，已中止操作')
    if (!ws.exists || !ws.doc || !Object.hasOwn(ws.doc.tables?.workspaces || {}, id)) {
      throw new Error('工作区不存在或已被移除')
    }
    const doc = ensureWorkspaceDoc(ws.doc)
    const rec = doc.tables.workspaces[id]
    if (deleteData && Array.isArray(rec?.sessionIds)) {
      sessionIdsToDelete = rec.sessionIds.filter((s) => typeof s === 'string')
    }
    doc.global.workspaceIds = doc.global.workspaceIds.filter((wid) => wid !== id)
    delete doc.tables.workspaces[id]
    await writeAndVerifyWorkspaceDoc(ws.file, doc)
  })

  let deleted = null
  if (deleteData && sessionIdsToDelete.length > 0) {
    deleted = await deleteSessions({
      items: sessionIdsToDelete.map((sessionId) => ({ home: canonicalHome, sessionId })),
      includeChildren: true,
      allowedHomes,
      isHomeRunning,
    })
  }

  return { removed: true, workspaceId: id, deleted }
}

// ============================================================================
// 用户目录静态数据分析（用户数据层 vs 实例运行时/缓存层）
// ============================================================================

const KNOWN_USER_DIRS = new Set(['sessions', 'attachments', 'memory', 'storages', 'skills'])
const RUNTIME_CACHE_DIRS = new Set(['cache', 'bundled', 'DSH', '.review-cache'])
const RUNTIME_LOG_DIRS = new Set(['logs'])

/**
 * 静态统计目录的逻辑字节数与文件数（跳过符号链接与 .tmp，限流并发，绝不阻塞运行中的实例）。
 */
async function measureTree(root, { skipNames = null, maxDepth = 12 } = {}) {
  let bytes = 0
  let files = 0
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    const childFiles = []
    const childDirs = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (depth === 0 && skipNames && skipNames.has(entry.name)) continue
      if (entry.isFile()) {
        if (entry.name.endsWith('.tmp')) continue
        childFiles.push(entry.name)
      } else if (entry.isDirectory()) {
        childDirs.push(entry.name)
      }
    }
    await mapLimit(childFiles, SCAN_FILE_CONCURRENCY, async (name) => {
      try {
        const info = await stat(join(dir, name))
        bytes += info.size
        files += 1
      } catch { /* 刚好被替换或删掉 */ }
    })
    await mapLimit(childDirs, SCAN_DIR_CONCURRENCY, (name) => walk(join(dir, name), depth + 1))
  }
  await walk(root, 0)
  return { bytes, files }
}

/**
 * 对单个用户目录（`DSH_HOME`）做纯静态数据分析，明确拆成两层：
 * - 用户数据层：sessions / attachments / memory / storages / skills / 根目录配置凭据 / 插件私有数据；
 * - 实例运行时与缓存层：profiles（区分 node_modules 依赖 vs 配置文件）/ cache / logs。
 */
export async function analyzeHomeData(home, {
  homeLabel = '',
  homeRunning = false,
  isDefault = false,
  presets = [],
  now = Date.now(),
} = {}) {
  const canonicalHome = resolve(home)
  const label = homeLabel || basename(canonicalHome) || canonicalHome
  const homeExists = existsSync(canonicalHome)

  const scanned = await scanHomeSessions(canonicalHome, { homeLabel: label, homeRunning, now })

  // 会话细分统计
  const sessList = scanned.sessions
  const sessionsBreakdown = {
    path: join(canonicalHome, 'sessions'),
    exists: existsSync(join(canonicalHome, 'sessions')),
    bytes: sessList.reduce((s, x) => s + x.bytes, 0),
    total: sessList.length,
    active: sessList.filter((x) => !x.archived && !x.isSubagent).length,
    archived: sessList.filter((x) => x.archived).length,
    blank: sessList.filter((x) => x.blank && !x.archived).length,
    orphan: sessList.filter((x) => x.orphan).length,
    subagent: sessList.filter((x) => x.isSubagent).length,
    activeBytes: sessList.filter((x) => !x.archived && !x.isSubagent).reduce((s, x) => s + x.bytes, 0),
    archivedBytes: sessList.filter((x) => x.archived).reduce((s, x) => s + x.bytes, 0),
    blankBytes: sessList.filter((x) => x.blank && !x.archived).reduce((s, x) => s + x.bytes, 0),
    orphanBytes: sessList.filter((x) => x.orphan).reduce((s, x) => s + x.bytes, 0),
  }

  let topEntries = []
  if (homeExists) {
    try { topEntries = await readdir(canonicalHome, { withFileTypes: true }) } catch { topEntries = [] }
  }

  const measureNamed = async (name) => {
    const p = join(canonicalHome, name)
    if (!existsSync(p)) return { name, path: p, exists: false, bytes: 0, files: 0 }
    const m = await measureTree(p)
    return { name, path: p, exists: true, ...m }
  }

  // 核心用户数据子目录并发统计
  const [attachments, memory, storages, skills] = await Promise.all([
    measureNamed('attachments'),
    measureNamed('memory'),
    measureNamed('storages'),
    measureNamed('skills'),
  ])

  // 根目录散落文件（凭据、设置备份、用量账本等）
  const rootFileEntries = topEntries.filter((e) => e.isFile() && !e.isSymbolicLink() && !e.name.endsWith('.tmp'))
  let rootFilesBytes = 0
  await mapLimit(rootFileEntries, SCAN_FILE_CONCURRENCY, async (e) => {
    try { rootFilesBytes += (await stat(join(canonicalHome, e.name))).size } catch { /* ignore */ }
  })
  const rootFiles = { bytes: rootFilesBytes, files: rootFileEntries.length }

  // 插件私有数据目录（除内置用户数据、profiles、缓存与日志之外的所有顶层子目录）
  const otherDirNames = topEntries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink()
      && !KNOWN_USER_DIRS.has(e.name)
      && e.name !== 'profiles'
      && !RUNTIME_CACHE_DIRS.has(e.name)
      && !RUNTIME_LOG_DIRS.has(e.name))
    .map((e) => e.name)
  const pluginData = []
  await mapLimit(otherDirNames, 4, async (name) => {
    const p = join(canonicalHome, name)
    const m = await measureTree(p)
    if (m.bytes > 0 || m.files > 0) pluginData.push({ name, path: p, ...m })
  })
  pluginData.sort((a, b) => b.bytes - a.bytes)

  // 运行时层 1：profiles/<name>（明确拆出 node_modules 依赖体积 vs 配置文件体积）
  const profilesRoot = join(canonicalHome, 'profiles')
  let profileDirNames = []
  try {
    profileDirNames = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { profileDirNames = [] }

  const profiles = []
  await mapLimit(profileDirNames, 4, async (name) => {
    const dir = join(profilesRoot, name)
    const nmDir = join(dir, 'node_modules')
    const [configPart, depsPart] = await Promise.all([
      measureTree(dir, { skipNames: new Set(['node_modules']) }),
      existsSync(nmDir) ? measureTree(nmDir) : Promise.resolve({ bytes: 0, files: 0 }),
    ])
    const linkedPresets = presets
      .filter((p) => p.profile === name)
      .map((p) => ({ id: p.id, name: p.name, environmentName: p.environmentName || '' }))
    profiles.push({
      name,
      path: dir,
      totalBytes: configPart.bytes + depsPart.bytes,
      depsBytes: depsPart.bytes,
      configBytes: configPart.bytes,
      files: configPart.files + depsPart.files,
      linkedPresets,
    })
  })
  profiles.sort((a, b) => b.totalBytes - a.totalBytes)

  // 运行时层 2：缓存与日志目录
  const presentCacheDirs = topEntries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && RUNTIME_CACHE_DIRS.has(e.name))
    .map((e) => e.name)
  const cacheParts = await Promise.all(presentCacheDirs.map(measureNamed))
  const cache = {
    bytes: cacheParts.reduce((s, x) => s + x.bytes, 0),
    files: cacheParts.reduce((s, x) => s + x.files, 0),
    path: existsSync(join(canonicalHome, 'cache')) ? join(canonicalHome, 'cache') : (cacheParts[0]?.path || ''),
    dirs: cacheParts,
  }
  const logs = await measureNamed('logs')

  const pluginDataBytes = pluginData.reduce((s, x) => s + x.bytes, 0)
  const profilesBytes = profiles.reduce((s, x) => s + x.totalBytes, 0)
  const profilesDepsBytes = profiles.reduce((s, x) => s + x.depsBytes, 0)
  const profilesConfigBytes = profiles.reduce((s, x) => s + x.configBytes, 0)

  const userDataBytes = sessionsBreakdown.bytes + attachments.bytes + memory.bytes + storages.bytes + skills.bytes + rootFiles.bytes + pluginDataBytes
  const runtimeBytes = profilesBytes + cache.bytes + logs.bytes
  const totalBytes = userDataBytes + runtimeBytes

  // 占比条分组（固定颜色语义，前端直接按 key 渲染）
  const categories = [
    { key: 'sessions', layer: 'user', bytes: sessionsBreakdown.bytes },
    { key: 'attachments', layer: 'user', bytes: attachments.bytes },
    { key: 'memory', layer: 'user', bytes: memory.bytes },
    { key: 'pluginData', layer: 'user', bytes: pluginDataBytes + storages.bytes + skills.bytes + rootFiles.bytes },
    { key: 'profiles', layer: 'runtime', bytes: profilesBytes },
    { key: 'cacheLogs', layer: 'runtime', bytes: cache.bytes + logs.bytes },
  ].filter((c) => c.bytes > 0)

  return {
    home: canonicalHome,
    label,
    exists: homeExists,
    running: homeRunning,
    isDefault,
    totalBytes,
    userDataBytes,
    runtimeBytes,
    categories,
    userData: {
      sessions: sessionsBreakdown,
      attachments,
      memory,
      storages,
      skills,
      rootFiles,
      pluginData,
      pluginDataBytes,
    },
    runtimeData: {
      profiles,
      profilesBytes,
      profilesDepsBytes,
      profilesConfigBytes,
      cache,
      logs,
    },
    presets,
    scannedAt: now,
  }
}
