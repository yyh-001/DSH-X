/**
 * 官方插件市场索引（format 1）解析、缓存与检索，服务管理页「加入插件」弹窗。
 *
 * 与 `@deepseek-ai/dsh-plugin-market-index` 对齐核心数据结构，但保持零第三方依赖，
 * 外网拉取走 `netFetch`（自动继承系统/手动代理，见 proxy.js），版本号排序复用 `version.js`。
 */
import { netFetch } from './proxy.js'
import { cmpVer, parseVer } from './version.js'

const DEFAULT_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MAX_INDEX_BYTES = 16 * 1024 * 1024
const DATA_ICON_RE = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const OWNER_REPO_TITLE_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/[A-Za-z0-9._-]+(?:#.*)?$/u

export function pickLocalizedText(value, lang = 'zh') {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const order = lang === 'en'
    ? ['en', 'en-US', 'zh', 'zh-CN']
    : ['zh', 'zh-CN', 'zh-Hans', 'en', 'en-US']
  for (const key of order) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
  }
  for (const item of Object.values(value)) {
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return ''
}

function allLocalizedVariants(value) {
  if (typeof value === 'string') return [value.trim()]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.values(value).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
}

export function resolveMarketIcon(rawIcon, indexUrl) {
  const text = String(rawIcon || '').trim()
  if (!text) return ''
  if (DATA_ICON_RE.test(text) && text.length <= 48 * 1024) return text
  try {
    const resolved = new URL(text, indexUrl)
    if (resolved.protocol === 'https:' || resolved.protocol === 'http:') return resolved.href
  } catch {
    // 非法或不可解析的图标地址按无图标兜底
  }
  return ''
}

/** 从 GitHub 仓库/主页或 awesome-dsh-plugin 详情链接中提取 GitHub 用户名或组织名。 */
export function extractGitHubOwnerFromUrl(rawUrl) {
  const text = String(rawUrl || '').trim()
  if (!text) return ''
  const sshMatch = text.match(/^git@github\.com:([^/\s]+)\//iu)
  if (sshMatch && GITHUB_OWNER_RE.test(sshMatch[1])) return sshMatch[1]
  const cleanUrl = text.startsWith('git+') ? text.slice(4) : text
  try {
    const parsed = new URL(cleanUrl)
    const host = parsed.hostname.toLowerCase()
    const parts = parsed.pathname.split('/').filter(Boolean)
    if ((host === 'github.com' || host === 'www.github.com') && parts[0] && GITHUB_OWNER_RE.test(parts[0])) {
      return parts[0]
    }
    if (host === 'awesome-dsh-plugin.com' && parts[0] === 'p' && parts[1] && GITHUB_OWNER_RE.test(parts[1])) {
      return parts[1]
    }
  } catch {
    // 非法 URL 返回空串，交由后续字段继续匹配
  }
  return ''
}

/** 按仓库地址 → 版本源码地址 → 主页 → `<owner>/<repo>` 标题顺序推断作者 GitHub 账号。 */
export function extractGitHubOwner(item, preferredVersion = null) {
  const candidates = [
    typeof item?.repository === 'string' ? item.repository : item?.repository?.url,
    preferredVersion?.source?.url,
    item?.homepage,
  ]
  for (const url of candidates) {
    const owner = extractGitHubOwnerFromUrl(url)
    if (owner) return owner
  }
  const titles = [
    typeof item?.title === 'string' ? item.title : '',
    ...allLocalizedVariants(item?.title),
  ]
  for (const rawTitle of titles) {
    const match = String(rawTitle || '').trim().match(OWNER_REPO_TITLE_RE)
    if (match && GITHUB_OWNER_RE.test(match[1])) return match[1]
  }
  return ''
}

export function githubAvatarUrl(owner) {
  const clean = String(owner || '').trim()
  return GITHUB_OWNER_RE.test(clean)
    ? `https://avatars.githubusercontent.com/${encodeURIComponent(clean)}?s=96`
    : ''
}

export function marketInstallSpec(name, versionEntry) {
  const pkgName = String(name || '').trim()
  if (!pkgName || !versionEntry) return pkgName
  const src = versionEntry.source
  if (src && src.type === 'git' && typeof src.url === 'string' && /^[0-9a-f]{40}$/u.test(String(src.commit || ''))) {
    const repo = src.url.endsWith('.git') ? src.url : `${src.url}.git`
    const pathPart = typeof src.path === 'string' && src.path ? `&path:/${src.path.replace(/^\/+/, '')}` : ''
    return `${pkgName}@git+${repo}#${src.commit}${pathPart}`
  }
  return versionEntry.version ? `${pkgName}@${versionEntry.version}` : pkgName
}

function compareMarketVersionsDesc(left, right) {
  const a = parseVer(left?.version || '')
  const b = parseVer(right?.version || '')
  if (a && b) return cmpVer(b, a)
  if (b) return 1
  if (a) return -1
  return String(right?.version || '').localeCompare(String(left?.version || ''))
}

function pickDefaultVersion(versions) {
  if (!versions.length) return null
  const stable = versions.find((item) => {
    const parsed = parseVer(item?.version || '')
    return parsed && !parsed.pre
  })
  return stable || versions[0]
}

export function parsePluginMarketIndex(raw, indexUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('插件市场索引不是有效的 JSON 对象')
  }
  if (raw.format !== 1) {
    throw new Error(`不支持的插件市场索引格式：${String(raw.format ?? '')}`)
  }
  if (!Array.isArray(raw.plugins)) {
    throw new Error('插件市场索引缺少 plugins 数组')
  }

  const rawCategories = raw.metadata?.categories && typeof raw.metadata.categories === 'object'
    ? raw.metadata.categories
    : {}
  const categories = {}
  for (const [id, item] of Object.entries(rawCategories)) {
    if (!id || !item || typeof item !== 'object') continue
    categories[id] = {
      id,
      title: item.title || id,
    }
  }

  const plugins = []
  for (const item of raw.plugins) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim()
    if (!name) continue
    const versions = Array.isArray(item.versions)
      ? item.versions.filter((v) => v && typeof v === 'object' && typeof v.version === 'string' && v.version.trim()).slice().sort(compareMarketVersionsDesc)
      : []
    const preferred = pickDefaultVersion(versions)
    const categoryId = typeof item.metadata?.category === 'string' && Object.hasOwn(categories, item.metadata.category)
      ? item.metadata.category
      : ''
    const keywords = Array.isArray(item.metadata?.keywords)
      ? item.metadata.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
      : []
    const githubOwner = extractGitHubOwner(item, preferred)
    const author = (typeof item.author === 'string' && item.author.trim()) ? item.author.trim() : githubOwner
    const icon = resolveMarketIcon(item.icon, indexUrl) || githubAvatarUrl(githubOwner)
    const catTitleVariants = categoryId ? allLocalizedVariants(categories[categoryId].title) : []
    const searchBlob = [
      name,
      ...allLocalizedVariants(item.title),
      ...allLocalizedVariants(item.description),
      author,
      ...keywords,
      ...catTitleVariants,
    ].join('\n').toLowerCase()

    plugins.push({
      name,
      title: item.title,
      description: item.description,
      icon,
      author,
      homepage: typeof item.homepage === 'string' ? item.homepage.trim() : '',
      category: categoryId,
      keywords,
      version: preferred?.version || '',
      installSpec: marketInstallSpec(name, preferred),
      sourceType: preferred?.source?.type || 'npm',
      publishTimestamp: Number(preferred?.publishTimestamp) || 0,
      searchBlob,
    })
  }

  return {
    url: indexUrl,
    format: 1,
    title: raw.title || indexUrl,
    description: raw.description,
    categories,
    plugins,
  }
}

export function searchPluginMarketIndex(parsed, { category = 'all', q = '', lang = 'zh', offset = 0, limit = 60 } = {}) {
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
  const safeLimit = Math.min(120, Math.max(1, Math.floor(Number(limit) || 60)))
  const terms = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const selectedCategory = String(category || 'all').trim() || 'all'

  const textMatched = terms.length
    ? parsed.plugins.filter((entry) => terms.every((term) => entry.searchBlob.includes(term)))
    : parsed.plugins

  const categoryCounts = new Map()
  for (const entry of textMatched) {
    if (!entry.category) continue
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1)
  }

  const filtered = selectedCategory === 'all'
    ? textMatched
    : textMatched.filter((entry) => entry.category === selectedCategory)

  const page = filtered.slice(safeOffset, safeOffset + safeLimit).map((entry) => ({
    name: entry.name,
    title: pickLocalizedText(entry.title, lang) || entry.name,
    description: pickLocalizedText(entry.description, lang),
    icon: entry.icon,
    author: entry.author,
    homepage: entry.homepage,
    category: entry.category,
    categoryTitle: entry.category && parsed.categories[entry.category]
      ? pickLocalizedText(parsed.categories[entry.category].title, lang) || entry.category
      : '',
    version: entry.version,
    installSpec: entry.installSpec,
    sourceType: entry.sourceType,
    publishTimestamp: entry.publishTimestamp,
  }))

  const categories = Object.values(parsed.categories)
    .map((cat) => ({
      id: cat.id,
      title: pickLocalizedText(cat.title, lang) || cat.id,
      count: categoryCounts.get(cat.id) || 0,
    }))
    .filter((cat) => cat.count > 0 || cat.id === selectedCategory)

  const nextOffset = safeOffset + page.length < filtered.length ? safeOffset + page.length : null
  return {
    title: pickLocalizedText(parsed.title, lang) || parsed.url,
    description: pickLocalizedText(parsed.description, lang),
    categories,
    entries: page,
    total: filtered.length,
    allCount: textMatched.length,
    nextOffset,
  }
}

export function createPluginMarketClient({ fetch = netFetch, now = Date.now, ttl = DEFAULT_TTL_MS } = {}) {
  const cache = new Map()

  function collectIcons(parsed) {
    const icons = {}
    for (const entry of parsed?.plugins || []) {
      if (entry?.name && entry.icon && !Object.hasOwn(icons, entry.name)) {
        icons[entry.name] = entry.icon
      }
    }
    return icons
  }

  /** 不触发外网请求，从已缓存的索引里汇总插件包名 → 真实图标地址。 */
  function cachedIcons(sources = []) {
    const icons = {}
    const list = Array.isArray(sources) && sources.length ? sources : [...cache.keys()]
    for (const rawUrl of list) {
      const hit = cache.get(String(rawUrl || '').trim())
      if (!hit?.parsed) continue
      for (const [name, icon] of Object.entries(collectIcons(hit.parsed))) {
        if (!Object.hasOwn(icons, name)) icons[name] = icon
      }
    }
    return icons
  }

  async function readIndex(url, { force = false } = {}) {
    const cleanUrl = String(url || '').trim()
    if (!cleanUrl) throw new Error('插件市场索引地址为空')
    const hit = cache.get(cleanUrl)
    if (!force && hit && now() - hit.fetchedAt < ttl) return hit

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(cleanUrl, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const contentLength = Number(res.headers?.get?.('content-length') || 0)
      if (contentLength > MAX_INDEX_BYTES) throw new Error('插件市场索引体积超出上限')
      const text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) throw new Error('插件市场索引体积超出上限')
      const json = JSON.parse(text)
      const parsed = parsePluginMarketIndex(json, cleanUrl)
      const record = { fetchedAt: now(), parsed }
      cache.set(cleanUrl, record)
      return record
    } finally {
      clearTimeout(timer)
    }
  }

  async function query(sources, { activeUrl = '', category = 'all', q = '', lang = 'zh', offset = 0, limit = 60, refresh = false } = {}) {
    const list = Array.isArray(sources) ? sources.filter(Boolean) : []
    if (!list.length) {
      return {
        sources: [],
        activeUrl: '',
        error: '没有配置插件市场索引源，可在设置页「插件市场索引源」里添加。',
        categories: [],
        entries: [],
        marketIcons: {},
        total: 0,
        allCount: 0,
        nextOffset: null,
        fetchedAt: 0,
      }
    }
    const targetUrl = activeUrl && list.includes(activeUrl) ? activeUrl : list[0]
    let activeRecord = null
    let activeError = ''
    try {
      activeRecord = await readIndex(targetUrl, { force: refresh })
    } catch (error) {
      activeError = error instanceof Error ? error.message : String(error)
    }

    const sourceSummaries = list.map((url) => {
      if (url === targetUrl) {
        return {
          url,
          title: activeRecord ? (pickLocalizedText(activeRecord.parsed.title, lang) || url) : url,
          error: activeError,
        }
      }
      const cached = cache.get(url)
      return {
        url,
        title: cached ? (pickLocalizedText(cached.parsed.title, lang) || url) : url,
        error: '',
      }
    })

    if (!activeRecord) {
      return {
        sources: sourceSummaries,
        activeUrl: targetUrl,
        error: activeError,
        categories: [],
        entries: [],
        marketIcons: {},
        total: 0,
        allCount: 0,
        nextOffset: null,
        fetchedAt: 0,
      }
    }

    const result = searchPluginMarketIndex(activeRecord.parsed, { category, q, lang, offset, limit })
    return {
      sources: sourceSummaries,
      activeUrl: targetUrl,
      error: '',
      fetchedAt: activeRecord.fetchedAt,
      marketIcons: collectIcons(activeRecord.parsed),
      ...result,
    }
  }

  return { readIndex, query, cachedIcons, clear: () => cache.clear() }
}
