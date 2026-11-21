/**
 * DSH-X 精选插件清单客户端：从 GitHub 仓库读取 `docs/curated-plugins.json`，不在代码里写死列表。
 *
 * 拉取顺序：内存缓存（TTL 内）→ GitHub / 多镜像候选链（gh-proxy / ghfast / jsDelivr 按下载源排序逐个回退）
 * → 磁盘缓存（上次成功结果）→ 开发工作区兜底（仅源码跑且尚未合入 main 时）。
 * 保持零第三方依赖，网络请求走 `netFetch` 自动继承系统/手动代理。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safePluginName } from './environments.js'
import { netFetch } from './proxy.js'
import { DEFAULT_UPDATE_SOURCE, UPDATE_SOURCES, safeUpdateSource } from './settings.js'

// 分支必须是仓库里真实存在的：默认分支是 Staging（没有 main），指错分支 raw 会一直 404
export const CURATED_PLUGINS_URL = 'https://raw.githubusercontent.com/yyh-001/DSH-X/Staging/docs/curated-plugins.json'

const DEFAULT_TTL_MS = 15 * 60 * 1000
// 单源超时收紧到 8 秒，避免某一个镜像挂死时把整条候选链拖太久。
const FETCH_TIMEOUT_MS = 8_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const VALID_TONES = new Set(['blue', 'indigo', 'cyan', 'purple', 'emerald', 'amber', 'pink'])
const LOCAL_DEV_MANIFEST = fileURLToPath(new URL('../docs/curated-plugins.json', import.meta.url))
// 兼容旧版远端清单或本地缓存：以下插件已下架，拉取解析时一并过滤
const EXCLUDED_PLUGIN_NAMES = new Set([
  'dsh-ego-browser',
  'dsh-computer-use-pro',
  'dsh-skill-mcp-panel',
])

function cleanText(value, maxLen = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

function cleanIcon(value) {
  const text = cleanText(value, 200)
  return /^lucide-[a-z0-9-]+$/i.test(text) ? text : ''
}

export function parseCuratedPluginsManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('精选插件清单格式无效')
  }
  const rawCategories = Array.isArray(raw.categories) ? raw.categories : []
  const categories = []
  const categoryIds = new Set()
  for (const item of rawCategories) {
    if (!item || typeof item !== 'object') continue
    const id = cleanText(item.id, 40)
    if (!id || categoryIds.has(id)) continue
    const zh = cleanText(item.zh || item.title || id, 60)
    const en = cleanText(item.en || zh, 60)
    const tone = VALID_TONES.has(item.tone) ? item.tone : 'blue'
    const icon = cleanIcon(item.icon)
    categoryIds.add(id)
    categories.push({ id, zh, en, tone, ...(icon ? { icon } : {}) })
  }

  const rawPlugins = Array.isArray(raw.plugins) ? raw.plugins : []
  const plugins = []
  const seen = new Set()
  for (const item of rawPlugins) {
    if (!item || typeof item !== 'object') continue
    let name = ''
    try {
      name = safePluginName(String(item.name || '').trim())
    } catch {
      continue
    }
    if (!name || seen.has(name) || EXCLUDED_PLUGIN_NAMES.has(name)) continue
    const category = cleanText(item.category, 40)
    if (!category || (categoryIds.size && !categoryIds.has(category))) continue
    const installSpec = cleanText(item.installSpec || name, 240)
    if (!installSpec) continue
    seen.add(name)
    const stars = Number.isFinite(Number(item.stars)) ? Math.max(0, Math.min(5, Math.round(Number(item.stars)))) : 0
    const icon = cleanIcon(item.icon)
    const sourceTag = cleanText(item.sourceTag, 24)
    // 清单里的标题、简介原本只有中文，英文界面照搬就是整片中文；可选的英文字段缺了页面再回退中文
    const titleEn = cleanText(item.titleEn, 120)
    const descriptionEn = cleanText(item.descriptionEn, 320)
    plugins.push({
      name,
      title: cleanText(item.title || name, 120),
      description: cleanText(item.description, 320),
      ...(titleEn ? { titleEn } : {}),
      ...(descriptionEn ? { descriptionEn } : {}),
      category,
      installSpec,
      ...(stars ? { stars } : {}),
      ...(icon ? { icon } : {}),
      ...(sourceTag ? { sourceTag } : {}),
    })
  }
  return {
    version: Number(raw.version) || 1,
    updatedAt: cleanText(raw.updatedAt, 40),
    categories,
    plugins,
  }
}

function readJsonManifest(file) {
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return parseCuratedPluginsManifest(raw)
  } catch {
    return null
  }
}

function writeJsonCache(file, parsed) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: parsed.version,
      updatedAt: parsed.updatedAt,
      categories: parsed.categories,
      plugins: parsed.plugins,
    }, null, 2))
  } catch {
    // 磁盘缓存写失败不影响本次返回
  }
}

/**
 * 按「下载源」展开精选清单候选地址：
 * - 选了镜像加速时优先试 gh-proxy / ghfast / jsDelivr，直连 raw.githubusercontent.com 兜底；
 * - 选了仅直连时先试原地址，直连失败仍保留镜像列表作兜底，避免国内网络下清单整块打不开。
 */
export function curatedUrlCandidates(rawUrl, updateSource = DEFAULT_UPDATE_SOURCE) {
  const direct = String(rawUrl ?? '').trim()
  if (!direct) return []
  const orderFor = (mirrors) => (
    safeUpdateSource(updateSource) === 'direct' ? [direct, ...mirrors] : [...mirrors, direct]
  )
  const rawMatch = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i.exec(direct)
  if (rawMatch) {
    const mirrors = (UPDATE_SOURCES.mirror || []).map((prefix) => `${prefix}${direct}`)
    // jsDelivr 的 @ref 语法不支持带 refs/ 前缀的全引用路径，只对普通分支/tag 拼 CDN 地址。
    if (!rawMatch[3].startsWith('refs/')) {
      mirrors.push(`https://fastly.jsdelivr.net/gh/${rawMatch[1]}/${rawMatch[2]}@${rawMatch[3]}/${rawMatch[4]}`)
      mirrors.push(`https://cdn.jsdelivr.net/gh/${rawMatch[1]}/${rawMatch[2]}@${rawMatch[3]}/${rawMatch[4]}`)
    }
    return [...new Set(orderFor(mirrors))]
  }
  if (/^https:\/\/github\.com\//i.test(direct)) {
    const mirrors = (UPDATE_SOURCES.mirror || []).map((prefix) => `${prefix}${direct}`)
    return [...new Set(orderFor(mirrors))]
  }
  return [direct]
}

export function createCuratedPluginsClient({
  url = process.env.DSH_X_CURATED_PLUGINS_URL || CURATED_PLUGINS_URL,
  fetchFn = netFetch,
  getUpdateSource = () => DEFAULT_UPDATE_SOURCE,
  cacheFile = '',
  fallbackFile = LOCAL_DEV_MANIFEST,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  let cached = null
  let cachedSource = 'github'
  let cachedUrl = url
  let fetchedAt = null
  let inflight = null

  async function fetchRemote() {
    const targetUrl = String(url || '').trim()
    if (!targetUrl) throw new Error('未配置精选清单地址')
    const sourceMode = typeof getUpdateSource === 'function' ? getUpdateSource() : DEFAULT_UPDATE_SOURCE
    const candidates = curatedUrlCandidates(targetUrl, sourceMode)
    let lastError = null
    for (const candidate of candidates) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('精选清单拉取超时')), timeoutMs)
      try {
        const response = await fetchFn(candidate, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
        const declaredLen = Number(response.headers?.get?.('content-length') || 0)
        if (declaredLen > MAX_MANIFEST_BYTES) throw new Error('精选清单体积超出限制')
        const text = await response.text()
        if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('精选清单体积超出限制')
        const parsed = parseCuratedPluginsManifest(JSON.parse(text))
        const source = candidate === targetUrl ? 'github' : 'mirror'
        cached = parsed
        cachedSource = source
        cachedUrl = candidate
        fetchedAt = now()
        writeJsonCache(cacheFile, parsed)
        return { manifest: parsed, source, url: candidate, error: '' }
      } catch (error) {
        lastError = error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error('精选清单拉取失败')
  }

  async function load({ refresh = false } = {}) {
    if (!refresh && cached && fetchedAt !== null && (now() - fetchedAt) < ttlMs) {
      return {
        curatedCategories: cached.categories,
        curated: cached.plugins,
        curatedUpdatedAt: cached.updatedAt,
        curatedUrl: cachedUrl || url,
        curatedSource: cachedSource || 'github',
        curatedError: '',
      }
    }
    if (!inflight || refresh) {
      const pending = fetchRemote().finally(() => {
        if (inflight === pending) inflight = null
      })
      inflight = pending
    }
    try {
      const { manifest, source, url: fetchedUrl, error } = await inflight
      return {
        curatedCategories: manifest.categories,
        curated: manifest.plugins,
        curatedUpdatedAt: manifest.updatedAt,
        curatedUrl: fetchedUrl || url,
        curatedSource: source,
        curatedError: error,
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (cached) {
        return {
          curatedCategories: cached.categories,
          curated: cached.plugins,
          curatedUpdatedAt: cached.updatedAt,
          curatedUrl: url,
          curatedSource: 'cache',
          curatedError: errMsg,
        }
      }
      const disk = readJsonManifest(cacheFile)
      if (disk) {
        cached = disk
        cachedSource = 'cache'
        cachedUrl = url
        fetchedAt = null
        return {
          curatedCategories: disk.categories,
          curated: disk.plugins,
          curatedUpdatedAt: disk.updatedAt,
          curatedUrl: url,
          curatedSource: 'cache',
          curatedError: errMsg,
        }
      }
      const devFallback = readJsonManifest(fallbackFile)
      if (devFallback) {
        return {
          curatedCategories: devFallback.categories,
          curated: devFallback.plugins,
          curatedUpdatedAt: devFallback.updatedAt,
          curatedUrl: url,
          curatedSource: 'local',
          curatedError: errMsg,
        }
      }
      return {
        curatedCategories: [],
        curated: [],
        curatedUpdatedAt: '',
        curatedUrl: url,
        curatedSource: 'error',
        curatedError: errMsg,
      }
    }
  }

  return { load }
}
