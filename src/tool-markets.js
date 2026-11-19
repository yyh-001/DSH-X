/**
 * MCP 与技能市场检索客户端，服务实例详情弹窗的 MCP / 技能「精选与在线市场」页签。
 *
 * 保持零第三方依赖，所有外网请求经 `netFetch`（遵循系统/手动代理，见 proxy.js）：
 * - MCP 精选：内置常用服务端预设（filesystem / fetch / context7 / playwright / github 等）
 * - MCP 市场：Official MCP Registry（registry.modelcontextprotocol.io/v0.1/servers，免鉴权）
 * - 技能市场：skills.sh 排行榜与搜索接口（all-time 分页 + /api/search）
 * - OpenAI 精选：GitHub `openai/skills` 仓库 `skills/.curated` 目录
 */
import { netFetch } from './proxy.js'
import { extractGitHubOwnerFromUrl, githubAvatarUrl } from './plugin-market.js'

const DEFAULT_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const RAW_META_TIMEOUT_MS = 2_500
const MAX_JSON_BYTES = 8 * 1024 * 1024
const DATA_ICON_RE = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
export const SKILLS_SH_BASE_URL = 'https://skills.sh'
export const OPENAI_CURATED_API_URL = 'https://api.github.com/repos/openai/skills/contents/skills/.curated'
export const OPENAI_CURATED_RAW_BASE = 'https://raw.githubusercontent.com/openai/skills/main/skills/.curated'

export const CURATED_MCP_SERVERS = [
  {
    id: 'curated/fetch',
    name: 'fetch',
    title: { zh: 'Fetch 网页抓取', en: 'Fetch Web Content' },
    description: {
      zh: '抓取网页正文并转为 Markdown 供模型阅读，免鉴权开箱即用。',
      en: 'Fetch web pages and convert HTML to clean Markdown without credentials.',
    },
    packageName: 'mcp-server-fetch',
    transport: 'stdio',
    needsConfig: false,
    installConfig: { name: 'fetch', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], env: {} },
    envHints: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    badge: { zh: '官方预设', en: 'Official' },
  },
  {
    id: 'curated/context7',
    name: 'context7',
    title: { zh: 'Context7 实时文档', en: 'Context7 Docs' },
    description: {
      zh: '按版本实时检索开源库官方文档与 API 示例，减少过时写法。',
      en: 'Pull up-to-date, version-specific library documentation and code examples.',
    },
    packageName: '@upstash/context7-mcp',
    transport: 'stdio',
    needsConfig: false,
    installConfig: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} },
    envHints: [],
    homepage: 'https://github.com/upstash/context7',
    badge: { zh: '推荐', en: 'Popular' },
  },
  {
    id: 'curated/playwright',
    name: 'playwright',
    title: { zh: 'Playwright 浏览器', en: 'Playwright MCP' },
    description: {
      zh: '基于可访问性树控制无头或有头浏览器，适合端到端页面操作与调试。',
      en: 'Automate Chromium/Firefox/WebKit through accessibility snapshots.',
    },
    packageName: '@playwright/mcp',
    transport: 'stdio',
    needsConfig: false,
    installConfig: { name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
    envHints: [],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    badge: { zh: '推荐', en: 'Popular' },
  },
  {
    id: 'curated/sequential-thinking',
    name: 'sequential-thinking',
    title: { zh: 'Sequential Thinking 推理', en: 'Sequential Thinking' },
    description: {
      zh: '提供结构化分步推理与回溯修订工具，辅助复杂架构拆解。',
      en: 'Structured step-by-step reasoning and hypothesis revision tool.',
    },
    packageName: '@modelcontextprotocol/server-sequential-thinking',
    transport: 'stdio',
    needsConfig: false,
    installConfig: {
      name: 'sequential-thinking',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: {},
    },
    envHints: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    badge: { zh: '官方预设', en: 'Official' },
  },
  {
    id: 'curated/memory',
    name: 'memory',
    title: { zh: 'Memory 知识图谱', en: 'Knowledge Graph Memory' },
    description: {
      zh: '通过本地持久化知识图谱跨会话记住实体、关系与偏好。',
      en: 'Persistent local knowledge graph memory across sessions.',
    },
    packageName: '@modelcontextprotocol/server-memory',
    transport: 'stdio',
    needsConfig: false,
    installConfig: { name: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: {} },
    envHints: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    badge: { zh: '官方预设', en: 'Official' },
  },
  {
    id: 'curated/filesystem',
    name: 'filesystem',
    title: { zh: 'Filesystem 本地目录', en: 'Local Filesystem' },
    description: {
      zh: '向智能体授权指定本地目录的读写与搜索权限（需补充目录路径）。',
      en: 'Scoped local filesystem access for allowed directories (requires target path).',
    },
    packageName: '@modelcontextprotocol/server-filesystem',
    transport: 'stdio',
    needsConfig: true,
    configHint: {
      zh: '请在参数列表末尾将路径替换为你允许访问的本地目录。',
      en: 'Replace the trailing argument with the local directory path to expose.',
    },
    installConfig: {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/Public'],
      env: {},
    },
    envHints: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    badge: { zh: '官方预设', en: 'Official' },
  },
  {
    id: 'curated/github',
    name: 'github',
    title: { zh: 'GitHub 仓库协作', en: 'GitHub MCP' },
    description: {
      zh: '读写 Issue、Pull Request、代码检索与仓库提交（需 Personal Access Token）。',
      en: 'Issues, PRs, code search, and repository operations (needs PAT).',
    },
    packageName: '@modelcontextprotocol/server-github',
    transport: 'stdio',
    needsConfig: true,
    configHint: {
      zh: '请填写 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量。',
      en: 'Fill in GITHUB_PERSONAL_ACCESS_TOKEN before saving.',
    },
    installConfig: {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
    envHints: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub Personal Access Token', isRequired: true, isSecret: true }],
    homepage: 'https://github.com/github/github-mcp-server',
    badge: { zh: '需密钥', en: 'Needs Key' },
  },
  {
    id: 'curated/brave-search',
    name: 'brave-search',
    title: { zh: 'Brave Search 搜索', en: 'Brave Search' },
    description: {
      zh: '实时网页与本地商业检索（需 Brave Search API Key）。',
      en: 'Web and local search powered by Brave Search API (needs API key).',
    },
    packageName: '@modelcontextprotocol/server-brave-search',
    transport: 'stdio',
    needsConfig: true,
    configHint: {
      zh: '请填写 BRAVE_API_KEY 环境变量。',
      en: 'Fill in BRAVE_API_KEY before saving.',
    },
    installConfig: {
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: '' },
    },
    envHints: [{ name: 'BRAVE_API_KEY', description: 'Brave Search API Key', isRequired: true, isSecret: true }],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search',
    badge: { zh: '需密钥', en: 'Needs Key' },
  },
  {
    id: 'curated/sqlite',
    name: 'sqlite',
    title: { zh: 'SQLite 数据库', en: 'SQLite MCP' },
    description: {
      zh: '查询并分析本地 SQLite 数据库表结构与数据（需指定数据库文件路径）。',
      en: 'Inspect schemas and query a local SQLite database file.',
    },
    packageName: 'mcp-server-sqlite',
    transport: 'stdio',
    needsConfig: true,
    configHint: {
      zh: '请把 `--db-path` 后的示例路径改成你的 `.db` 文件路径。',
      en: 'Replace the `--db-path` argument with your SQLite `.db` path.',
    },
    installConfig: {
      name: 'sqlite',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', './data.db'],
      env: {},
    },
    envHints: [],
    homepage: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite',
    badge: { zh: '官方预设', en: 'Official' },
  },
  {
    id: 'curated/firecrawl',
    name: 'firecrawl',
    title: { zh: 'Firecrawl 深度爬取', en: 'Firecrawl MCP' },
    description: {
      zh: '整站抓取、结构化提取与网页搜索（需 Firecrawl API Key）。',
      en: 'Web scraping, crawling, and structured extraction via Firecrawl.',
    },
    packageName: 'firecrawl-mcp',
    transport: 'stdio',
    needsConfig: true,
    configHint: {
      zh: '请填写 FIRECRAWL_API_KEY 环境变量。',
      en: 'Fill in FIRECRAWL_API_KEY before saving.',
    },
    installConfig: {
      name: 'firecrawl',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env: { FIRECRAWL_API_KEY: '' },
    },
    envHints: [{ name: 'FIRECRAWL_API_KEY', description: 'Firecrawl API Key', isRequired: true, isSecret: true }],
    homepage: 'https://github.com/mendableai/firecrawl-mcp-server',
    badge: { zh: '需密钥', en: 'Needs Key' },
  },
]

function pickLang(value, lang = 'zh') {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return (lang === 'en' ? value.en || value.zh : value.zh || value.en) || ''
}

function sanitizeIconUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (DATA_ICON_RE.test(text) && text.length <= 48 * 1024) return text
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href
  } catch {
    // 非法 URL 一律丢弃，界面走名称首字母/默认图标兜底
  }
  return ''
}

/** 将官方 Registry `namespace/name` 规范化为合法的 `cordis.patch.yml` MCP 键名（1-32 位字母数字_-）。 */
export function sanitizeMcpServerName(raw) {
  const str = String(raw || '').trim()
  const tail = str.includes('/') ? str.slice(str.lastIndexOf('/') + 1) : str
  const cleaned = tail
    .toLowerCase()
    .replace(/^mcp-server-|^server-/u, '')
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, 32)
  if (cleaned) return cleaned
  const fallback = str
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, 32)
  return fallback || 'mcp-server'
}

function buildPackageInstallTemplate(pkg, cleanName) {
  const type = String(pkg?.registryType || '').toLowerCase()
  const identifier = String(pkg?.identifier || '').trim()
  if (!identifier) return null

  let command = ''
  const args = []
  if (type === 'npm') {
    command = 'npx'
    args.push('-y', identifier)
  } else if (type === 'pypi') {
    command = 'uvx'
    args.push(identifier)
  } else if (type === 'oci') {
    command = 'docker'
    args.push('run', '-i', '--rm', identifier)
  } else {
    return null
  }

  let needsConfig = false
  if (Array.isArray(pkg.packageArguments)) {
    for (const arg of pkg.packageArguments) {
      if (!arg || typeof arg !== 'object') continue
      const def = arg.default != null ? String(arg.default) : ''
      if (arg.type === 'named' && arg.name) {
        const flag = String(arg.name)
        if (def) args.push(flag, def)
        else if (arg.isRequired) needsConfig = true
      } else if (arg.type === 'positional') {
        if (def) args.push(def)
        else if (arg.isRequired) needsConfig = true
      }
    }
  }

  const env = {}
  const envHints = []
  if (Array.isArray(pkg.environmentVariables)) {
    for (const item of pkg.environmentVariables) {
      if (!item?.name) continue
      const key = String(item.name).trim()
      if (!key) continue
      const def = item.default != null ? String(item.default) : ''
      env[key] = def
      const isRequired = Boolean(item.isRequired)
      const isSecret = Boolean(item.isSecret)
      envHints.push({
        name: key,
        description: String(item.description || '').trim(),
        isRequired,
        isSecret,
      })
      if ((isRequired || isSecret) && !def) needsConfig = true
    }
  }

  return {
    transport: 'stdio',
    packageName: identifier,
    needsConfig,
    envHints,
    installConfig: {
      name: cleanName,
      transport: 'stdio',
      command,
      args,
      env,
    },
  }
}

function buildRemoteInstallTemplate(remote, cleanName) {
  const transport = 'streamable-http'
  const url = String(remote?.url || '').trim()
  if (!url) return null

  let needsConfig = /\{[^}]+\}/u.test(url)
  const headers = {}
  const headerHints = []
  if (Array.isArray(remote.headers)) {
    for (const item of remote.headers) {
      if (!item?.name) continue
      const key = String(item.name).trim()
      if (!key) continue
      const def = item.default != null ? String(item.default) : (item.value != null ? String(item.value) : '')
      headers[key] = def
      const isRequired = Boolean(item.isRequired)
      const isSecret = Boolean(item.isSecret)
      headerHints.push({
        name: key,
        description: String(item.description || '').trim(),
        isRequired,
        isSecret,
      })
      if ((isRequired || isSecret) && !def) needsConfig = true
    }
  }

  return {
    transport,
    packageName: url,
    needsConfig,
    envHints: headerHints,
    installConfig: {
      name: cleanName,
      transport,
      url,
      headers,
    },
  }
}

/** 将 Official MCP Registry 单条响应规整为前端可直接渲染和安装的条目。 */
export function normalizeRegistryMcpServer(entry) {
  const server = entry && typeof entry === 'object' && entry.server && typeof entry.server === 'object'
    ? entry.server
    : entry
  if (!server || typeof server !== 'object' || !server.name) return null

  const id = String(server.name).trim()
  const cleanName = sanitizeMcpServerName(id)
  const title = String(server.title || '').trim() || cleanName
  const description = String(server.description || '').trim()
  const version = String(server.version || '').trim()
  const icons = Array.isArray(server.icons) ? server.icons : []
  let icon = ''
  for (const item of icons) {
    const candidate = sanitizeIconUrl(typeof item === 'string' ? item : item?.src)
    if (candidate) {
      icon = candidate
      break
    }
  }
  const repoUrl = typeof server.repository === 'string' ? server.repository : server.repository?.url
  const homepage = String(server.websiteUrl || repoUrl || '').trim()
  if (!icon) {
    icon = githubAvatarUrl(extractGitHubOwnerFromUrl(repoUrl || server.websiteUrl))
  }

  const packages = Array.isArray(server.packages) ? server.packages : []
  const priority = ['npm', 'pypi', 'oci']
  const orderedPackages = [...packages].sort((a, b) => {
    const ai = priority.indexOf(String(a?.registryType || '').toLowerCase())
    const bi = priority.indexOf(String(b?.registryType || '').toLowerCase())
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })

  let chosen = null
  for (const pkg of orderedPackages) {
    chosen = buildPackageInstallTemplate(pkg, cleanName)
    if (chosen) break
  }
  if (!chosen && Array.isArray(server.remotes)) {
    for (const remote of server.remotes) {
      chosen = buildRemoteInstallTemplate(remote, cleanName)
      if (chosen) break
    }
  }
  if (!chosen) {
    chosen = {
      transport: 'stdio',
      packageName: id,
      needsConfig: true,
      envHints: [],
      installConfig: { name: cleanName, transport: 'stdio', command: '', args: [], env: {} },
    }
  }

  return {
    id,
    name: cleanName,
    title,
    description,
    version,
    icon,
    homepage,
    transport: chosen.transport,
    packageName: chosen.packageName,
    needsConfig: chosen.needsConfig,
    envHints: chosen.envHints,
    installConfig: chosen.installConfig,
  }
}

async function fetchJson(fetch, url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const contentLength = Number(res.headers?.get?.('content-length') || 0)
    if (contentLength > MAX_JSON_BYTES) throw new Error('市场响应体积超出上限')
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error('市场响应体积超出上限')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

function localizeCuratedMcp(entry, lang) {
  return {
    id: entry.id,
    name: entry.name,
    title: pickLang(entry.title, lang) || entry.name,
    description: pickLang(entry.description, lang),
    configHint: entry.configHint ? pickLang(entry.configHint, lang) : '',
    badge: entry.badge ? pickLang(entry.badge, lang) : '',
    packageName: entry.packageName,
    transport: entry.transport,
    icon: entry.icon || githubAvatarUrl(extractGitHubOwnerFromUrl(entry.homepage)),
    homepage: entry.homepage || '',
    needsConfig: Boolean(entry.needsConfig),
    envHints: entry.envHints || [],
    installConfig: entry.installConfig,
  }
}

export function createMcpMarketClient({ fetch = netFetch, ttl = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const registryCache = new Map()

  async function query({ mode = 'curated', q = '', lang = 'zh', limit = 30, cursor = '', refresh = false } = {}) {
    const search = String(q || '').trim()
    const cleanMode = mode === 'registry' ? 'registry' : 'curated'

    if (cleanMode === 'curated') {
      const needle = search.toLowerCase()
      const items = CURATED_MCP_SERVERS
        .map((entry) => localizeCuratedMcp(entry, lang))
        .filter((item) => {
          if (!needle) return true
          return [item.name, item.title, item.description, item.packageName].some((part) =>
            String(part || '').toLowerCase().includes(needle)
          )
        })
      return {
        mode: 'curated',
        items,
        total: items.length,
        nextCursor: null,
        error: '',
      }
    }

    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 100)
    const params = new URLSearchParams({ version: 'latest', limit: String(safeLimit) })
    if (search) params.set('search', search)
    if (cursor) params.set('cursor', String(cursor))
    const url = `${MCP_REGISTRY_URL}?${params.toString()}`
    const hit = registryCache.get(url)
    if (!refresh && hit && now() - hit.fetchedAt < ttl) return hit.data

    try {
      const json = await fetchJson(fetch, url)
      const rawList = Array.isArray(json?.servers) ? json.servers : []
      const seen = new Set()
      const items = []
      for (const raw of rawList) {
        const normalized = normalizeRegistryMcpServer(raw)
        if (!normalized || seen.has(normalized.id)) continue
        seen.add(normalized.id)
        items.push(normalized)
      }
      const data = {
        mode: 'registry',
        items,
        total: items.length,
        nextCursor: json?.metadata?.nextCursor || null,
        fetchedAt: now(),
        error: '',
      }
      registryCache.set(url, { fetchedAt: data.fetchedAt, data })
      return data
    } catch (error) {
      return {
        mode: 'registry',
        items: [],
        total: 0,
        nextCursor: null,
        fetchedAt: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { query, clear: () => registryCache.clear() }
}

/** 从 OpenAI 精选 `SKILL.md` frontmatter 提取简短描述，失败或超时静默返回空串。 */
function parseSkillMarkdownSummary(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '')
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/u)
  if (!match) return { name: '', description: '' }
  let name = ''
  let description = ''
  const lines = match[1].split(/\r?\n/u)
  for (const line of lines) {
    if (!name) {
      const mName = line.match(/^name:\s*(.+)$/u)
      if (mName) name = mName[1].trim().replace(/^['"]|['"]$/gu, '')
    }
    if (!description) {
      const mDesc = line.match(/^description:\s*(.+)$/u)
      if (mDesc) description = mDesc[1].trim().replace(/^['"]|['"]$/gu, '')
    }
  }
  return { name, description }
}

async function fetchSkillSummary(fetch, skillId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RAW_META_TIMEOUT_MS)
  try {
    const res = await fetch(`${OPENAI_CURATED_RAW_BASE}/${encodeURIComponent(skillId)}/SKILL.md`, {
      signal: controller.signal,
    })
    if (!res.ok) return { name: '', description: '' }
    const text = await res.text()
    return parseSkillMarkdownSummary(text)
  } catch {
    return { name: '', description: '' }
  } finally {
    clearTimeout(timer)
  }
}

async function enrichOpenAiSkills(fetch, items) {
  const CONCURRENCY = 6
  const out = [...items]
  for (let i = 0; i < out.length; i += CONCURRENCY) {
    const slice = out.slice(i, i + CONCURRENCY)
    await Promise.all(slice.map(async (item) => {
      const meta = await fetchSkillSummary(fetch, item.skillId)
      if (meta.description) item.description = meta.description
      if (meta.name) item.title = meta.name
    }))
  }
  return out
}

function normalizeSkillsShItem(raw) {
  const source = String(raw?.source || '').trim()
  const skillId = String(raw?.skillId || '').trim()
  if (!source || !skillId) return null
  const name = String(raw?.name || skillId).trim() || skillId
  const owner = source.split('/')[0] || ''
  return {
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    title: name,
    description: '',
    icon: githubAvatarUrl(owner),
    installs: Number(raw?.installs) || 0,
    isOfficial: Boolean(raw?.isOfficial),
    sourceUrl: `https://github.com/${source}`,
    pageUrl: `${SKILLS_SH_BASE_URL}/${source}/${skillId}`,
  }
}

export function createSkillMarketClient({ fetch = netFetch, ttl = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const marketCache = new Map()
  let openaiCache = null

  async function query({ mode = 'market', q = '', page = 0, limit = 30, refresh = false } = {}) {
    const search = String(q || '').trim()
    const cleanMode = mode === 'openai' ? 'openai' : 'market'

    if (cleanMode === 'openai') {
      try {
        if (refresh || !openaiCache || now() - openaiCache.fetchedAt >= ttl) {
          const json = await fetchJson(fetch, OPENAI_CURATED_API_URL, {
            accept: 'application/vnd.github+json',
            'user-agent': 'DSH-X-Launcher',
          })
          const dirs = Array.isArray(json)
            ? json.filter((item) => item && item.type === 'dir' && item.name && !String(item.name).startsWith('.'))
            : []
          const openaiIcon = githubAvatarUrl('openai')
          const baseItems = dirs.map((entry) => ({
            id: `openai/skills/${entry.name}`,
            source: 'openai/skills',
            skillId: String(entry.name),
            name: String(entry.name),
            title: String(entry.name),
            description: '',
            icon: openaiIcon,
            installs: 0,
            isOfficial: true,
            sourceUrl: String(entry.html_url || 'https://github.com/openai/skills'),
            pageUrl: String(entry.html_url || 'https://github.com/openai/skills/tree/main/skills/.curated'),
          }))
          await enrichOpenAiSkills(fetch, baseItems)
          openaiCache = { fetchedAt: now(), items: baseItems }
        }

        const needle = search.toLowerCase()
        const filtered = needle
          ? openaiCache.items.filter((item) =>
              [item.skillId, item.name, item.description].some((part) => String(part || '').toLowerCase().includes(needle))
            )
          : openaiCache.items

        return {
          mode: 'openai',
          items: filtered,
          total: filtered.length,
          page: 0,
          hasMore: false,
          fetchedAt: openaiCache.fetchedAt,
          error: '',
        }
      } catch (error) {
        return {
          mode: 'openai',
          items: [],
          total: 0,
          page: 0,
          hasMore: false,
          fetchedAt: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const safePage = Math.max(0, Number(page) || 0)
    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 60)
    // skills.sh /api/search 要求关键词至少 2 个字符；单字符输入时走排行榜第 0 页并在内存过滤
    const useSearchApi = search.length >= 2
    const url = useSearchApi
      ? `${SKILLS_SH_BASE_URL}/api/search?q=${encodeURIComponent(search)}&limit=${safeLimit}`
      : `${SKILLS_SH_BASE_URL}/api/skills/all-time/${safePage}`

    const cacheKey = useSearchApi ? url : `${url}#q=${search}`
    const hit = marketCache.get(cacheKey)
    if (!refresh && hit && now() - hit.fetchedAt < ttl) return hit.data

    try {
      const json = await fetchJson(fetch, url)
      const rawSkills = Array.isArray(json?.skills) ? json.skills : []
      let items = rawSkills.map(normalizeSkillsShItem).filter(Boolean)
      if (!useSearchApi && search) {
        const needle = search.toLowerCase()
        items = items.filter((item) =>
          [item.name, item.skillId, item.source].some((part) => part.toLowerCase().includes(needle))
        )
      }
      const data = {
        mode: 'market',
        items,
        total: useSearchApi ? (Number(json?.count) || items.length) : (Number(json?.total) || items.length),
        page: safePage,
        hasMore: useSearchApi ? false : Boolean(json?.hasMore),
        fetchedAt: now(),
        error: '',
      }
      marketCache.set(cacheKey, { fetchedAt: data.fetchedAt, data })
      return data
    } catch (error) {
      return {
        mode: 'market',
        items: [],
        total: 0,
        page: safePage,
        hasMore: false,
        fetchedAt: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    query,
    clear: () => {
      marketCache.clear()
      openaiCache = null
    },
  }
}
