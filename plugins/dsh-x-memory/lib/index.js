/**
 * dsh-x-memory 主机侧：把 ZCode 那套「文件即记忆」接进 dsh。
 *
 * 四件事：
 * 1. 提示词：注册一条静态 system 段（写记忆的纪律，照 ZCode 的 Memory 段改写）+ 一条动态
 *    context（本工作区的 MEMORY.md 索引，每会话渲染一次后冻结，中途写记忆不改已注入的内容）；
 * 2. 工具：六个 memory_* 工具（见 lib/tools.js），按调用者所在工作区取库；
 * 3. 设置页数据面：/api/x-memory/* 一组仅限环回的本机路由，面板（lib/client.js）用它浏览、
 *    编辑、删除记忆；
 * 4. 配置：默认值 ← profile 的 cordis.patch.yml 里那一行 config ← 面板写入的
 *    `<profileDir>/dsh-x-memory.json`（后者优先，面板改完立即生效，不用重启 dsh）。
 *
 * 记忆落在 <DSH_HOME>/memories/<工作区>/：一条事实一个 .md，加一份 MEMORY.md 索引。
 * 纯文件，随时能看能改能进 git；插件卸载了它们也还在。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, MEMORY_TYPES, MemoryStore, workspaceKey } from './store.js'
import { createTools } from './tools.js'

/** 需要的服务：工具注册表 + 系统提示装配 + 本机 web 路由。（必须导出，cordis 从模块上读 inject。） */
export const inject = ['tools', 'systemPrompt', 'webServer']

const CONFIG_NAME = 'dsh-x-memory.json'
const DEFAULT_CONFIG = {
  /** 是否把记忆索引注入上下文；关掉=只留工具，模型想用时自己去查。 */
  autoInject: true,
  /** 索引每会话只渲染一次：中途写记忆不改已经注入的内容，避免上下文抖动。 */
  freezeIndexPerSession: true,
  /** 按工作区分目录；false=所有工作区共用一份（放 <home>/memories/shared）。 */
  perWorkspace: true,
  /** 自定义记忆根目录；留空走 <DSH_HOME>/memories。 */
  rootDir: '',
  indexMaxLines: INDEX_MAX_LINES,
  indexMaxBytes: INDEX_MAX_BYTES,
}
/** 每会话冻结索引的缓存上限（防长时间跑的服务内存慢慢涨）。 */
const SESSION_CACHE_MAX = 200

/**
 * 写记忆的纪律 —— 照 ZCode 的 Memory 段改写，工具名换成我们的。
 * 静态文本（interpolate: false），进前缀缓存；工作区路径不在这里，在注入的索引块里。
 */
export const GUIDANCE = `# 记忆

你有一份跨会话的长期记忆：一条事实一个 Markdown 文件，按工作区分开存放；本工作区的目录路径写在下面注入的「记忆索引」块里。用这些工具读写，不要直接改那些文件：
memory_save / memory_search / memory_list / memory_read / memory_update / memory_delete。

什么时候写（memory_save）：
- 用户明确说「记住」；
- 用户给出偏好或工作方式（type=feedback，正文里跟 **Why:** 与 **How to apply:** 两行）；
- 项目里非显而易见的事实、决定或约束（type=project，相对日期换成绝对日期）；
- 外部资源的指针（type=reference）；关于用户本人的事实（type=user）。

不记：仓库里已经有的东西（代码结构、历史修复、git 记录、AGENTS.md）、只跟当前这次对话有关的事。用户要求记这类内容时，先问清「哪一点不是显而易见」再记。

一条记忆 = 一条事实，几行写完；description 要一句话说清它讲什么（召回时靠它判断相关性）。相关记忆之间用 [[name]] 互链——链到还不存在的名字也算合法，它标记的是「以后值得写的东西」。

保存前先用 memory_search / memory_list 查重：已经有覆盖同一事实的，用 memory_update 改它，别新建重复文件；发现记错了就 memory_delete。

MEMORY.md 是索引（一行一条指针），每次会话自动载入；它由工具自动维护，不要手动改。`

/** dsh 用户目录：环境变量优先（和 dsh 自己的口径一致）。 */
export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 当前 profile 目录：找 package.json 里装了本插件的那个；找不到退回 web。 */
export function resolveProfileDir(home = homeDir(), packageName = 'dsh-x-memory') {
  const profiles = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
  } catch {
    return join(profiles, 'web')
  }
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(profiles, name, 'package.json'), 'utf8'))
      const deps = Object.keys(manifest?.dependencies ?? {})
      const bundles = manifest?.dsh?.profile?.bundles ?? []
      if (deps.includes(packageName) || bundles.includes(packageName)) return join(profiles, name)
    } catch {
      // 这个 profile 还没有 package.json，跳过
    }
  }
  if (names.includes('web')) return join(profiles, 'web')
  return names.length ? join(profiles, names[0]) : join(profiles, 'web')
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

/** 归一化配置：脏值回默认。 */
export function normalizeConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    autoInject: source.autoInject !== false,
    freezeIndexPerSession: source.freezeIndexPerSession !== false,
    perWorkspace: source.perWorkspace !== false,
    rootDir: typeof source.rootDir === 'string' ? source.rootDir.trim() : '',
    indexMaxLines: positiveInt(source.indexMaxLines, INDEX_MAX_LINES),
    indexMaxBytes: positiveInt(source.indexMaxBytes, INDEX_MAX_BYTES),
  }
}

export function overridesPath(profileDir = resolveProfileDir()) {
  return join(profileDir, CONFIG_NAME)
}

export function loadOverrides(profileDir = resolveProfileDir()) {
  try {
    return JSON.parse(readFileSync(overridesPath(profileDir), 'utf8'))
  } catch {
    return {}
  }
}

/** 原子写面板配置。 */
export function saveOverrides(patch, profileDir = resolveProfileDir()) {
  const current = loadOverrides(profileDir)
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  const file = overridesPath(profileDir)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(temp, file)
  return next
}

/** 生效配置：默认 ← patch 行 config ← 面板覆盖。 */
export function effectiveConfig(patchConfig, profileDir = resolveProfileDir()) {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...(patchConfig && typeof patchConfig === 'object' ? patchConfig : {}), ...loadOverrides(profileDir) })
}

/** 工作区（会话 cwd）→ 记忆根目录。 */
export function rootFor(config, workspacePath, home = homeDir()) {
  const key = workspaceKey(workspacePath)
  if (config.rootDir) return config.perWorkspace ? join(config.rootDir, key) : config.rootDir
  return join(home, 'memories', config.perWorkspace ? key : 'shared')
}

/** 从 agent 里拿工作区（会话头的 cwd）；拿不到退回进程 cwd。 */
export function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : process.cwd()
}

export function sessionKeyOf(agent) {
  return agent?.session?.id ?? agent?.session?.header?.id ?? workspaceOf(agent)
}

/** agent → 它的工作区记忆库（工具与测试共用这一条解析路径）。 */
export function storeForAgent(agent, config = normalizeConfig(), home = homeDir()) {
  return new MemoryStore({ rootDir: rootFor(config, workspaceOf(agent), home) })
}

// ---- 环回与 HTTP 小工具（和 dsh-x-sync 同一套，验过） ----

function isLoopbackRequest(req) {
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

export async function apply(ctx, patchConfig) {
  const logger = ctx.logger ?? console
  const profileDir = resolveProfileDir()
  logger.info?.(`[dsh-x-memory] profile: ${profileDir}`)

  const config = () => effectiveConfig(patchConfig, profileDir)
  const stores = new Map()
  const storeForRoot = (root) => {
    let store = stores.get(root)
    if (!store) {
      store = new MemoryStore({ rootDir: root })
      stores.set(root, store)
    }
    return store
  }
  const storeForWorkspace = (workspacePath) => storeForRoot(rootFor(config(), workspacePath))
  const storeForCaller = (agent) => storeForWorkspace(workspaceOf(agent))

  // 每会话冻结的索引：key=会话 → 渲染好的文本
  const sessionIndex = new Map()
  function rememberSession(key, text) {
    sessionIndex.set(key, text)
    if (sessionIndex.size > SESSION_CACHE_MAX) sessionIndex.delete(sessionIndex.keys().next().value)
  }

  // ---- 1) 提示词：静态纪律 + 动态索引 ----

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'x-memory:guidance',
    order: 700,
    interpolate: false,
    text: GUIDANCE,
  }), 'dsh-x-memory: guidance')

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'x-memory:index',
    order: 95,
    text: (assemble) => {
      // 渲染必须是同步且绝不抛：装配失败会带走整个回合。任何异常都降级成「不注入」。
      try {
        const cfg = config()
        if (!cfg.autoInject) return ''
        const agent = assemble?.agent
        const workspace = workspaceOf(agent)
        const key = sessionKeyOf(agent)
        if (cfg.freezeIndexPerSession && sessionIndex.has(key)) return sessionIndex.get(key)
        const store = storeForWorkspace(workspace)
        const body = store.indexForInjection({ maxLines: cfg.indexMaxLines, maxBytes: cfg.indexMaxBytes })
        const text = body ? `# 记忆索引\n\n工作区记忆目录：${store.rootDir}\n\n${body}` : ''
        if (cfg.freezeIndexPerSession) rememberSession(key, text)
        return text
      } catch (error) {
        logger.warn?.(`[dsh-x-memory] 索引注入失败：${error instanceof Error ? error.message : error}`)
        return ''
      }
    },
  }), 'dsh-x-memory: index')

  // ---- 2) 模型工具 ----

  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  ctx.effect(() => {
    const disposers = createTools({ defineTool, storeFor: (exec) => storeForCaller(exec?.agent) }).map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-x-memory: tools')

  // ---- 3) 设置页数据面 ----

  /** 列出 <home>/memories 下的工作区目录（面板的工作区选择器）。 */
  function listWorkspaces() {
    const cfg = config()
    const baseRoot = cfg.rootDir || join(homeDir(), 'memories')
    if (!cfg.perWorkspace) {
      const store = storeForRoot(cfg.rootDir || join(homeDir(), 'memories', 'shared'))
      return [{ key: 'shared', root: store.rootDir, ...workspaceStats(store) }]
    }
    let names = []
    try {
      names = readdirSync(baseRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
    const rows = names.map((name) => {
      const root = join(baseRoot, name)
      return { key: name, root, ...workspaceStats(storeForRoot(root)) }
    })
    return rows.sort((left, right) => right.mtimeMs - left.mtimeMs)
  }

  function workspaceStats(store) {
    let entries = []
    let mtimeMs = 0
    try {
      entries = store.scan()
      const index = store.readIndex()
      mtimeMs = entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0)
      if (index) mtimeMs = Math.max(mtimeMs, statSync(join(store.rootDir, 'MEMORY.md')).mtimeMs)
    } catch {
      // 目录还不存在：算空
    }
    return { count: entries.length, mtimeMs }
  }

  /** 面板传进来的工作区 key：只认目录名，路径关在 baseRoot 里。 */
  function storeForPanel(workspaceKey_) {
    const cfg = config()
    if (!cfg.perWorkspace) return storeForRoot(cfg.rootDir || join(homeDir(), 'memories', 'shared'))
    const key = String(workspaceKey_ ?? '').trim()
    if (!key) {
      const first = listWorkspaces()[0]
      if (first) return storeForRoot(first.root)
      throw new Error('还没有任何工作区记忆目录')
    }
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(key)) throw new Error(`工作区 key 不合法：${key}`)
    const baseRoot = cfg.rootDir || join(homeDir(), 'memories')
    return storeForRoot(join(baseRoot, key))
  }

  const routes = [
    {
      path: '/api/x-memory/state',
      handler: async (_req, res) => {
        sendJson(res, 200, { config: config(), profileDir, home: homeDir(), workspaces: listWorkspaces() })
      },
    },
    {
      path: '/api/x-memory/config',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const saved = saveOverrides({
            ...('autoInject' in body ? { autoInject: body.autoInject !== false } : {}),
            ...('freezeIndexPerSession' in body ? { freezeIndexPerSession: body.freezeIndexPerSession !== false } : {}),
            ...('perWorkspace' in body ? { perWorkspace: body.perWorkspace !== false } : {}),
            ...('rootDir' in body ? { rootDir: String(body.rootDir ?? '') } : {}),
          }, profileDir)
          sessionIndex.clear()
          sendJson(res, 200, { ok: true, overrides: saved, config: config() })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/list',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          const store = storeForPanel(url.searchParams.get('workspace'))
          const type = url.searchParams.get('type') ?? undefined
          const entries = store.list({ type }).map(({ name, title, description, type: entryType, size, mtimeMs }) => ({ name, title, description, type: entryType, size, mtimeMs }))
          sendJson(res, 200, { ok: true, workspace: store.rootDir, entries, stats: store.stats() })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/read',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          const store = storeForPanel(url.searchParams.get('workspace'))
          const name = url.searchParams.get('name') ?? ''
          const entry = store.read(name)
          if (!entry) {
            sendJson(res, 404, { error: `没有这条记忆：${name}` })
            return
          }
          sendJson(res, 200, { ok: true, workspace: store.rootDir, entry })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/save',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const store = storeForPanel(body.workspace)
          const result = store.save({
            name: body.name,
            title: body.title,
            description: body.description,
            type: MEMORY_TYPES.includes(body.type) ? body.type : 'project',
            body: body.content,
            overwrite: body.overwrite === true,
          })
          if (result.action === 'exists') {
            sendJson(res, 409, { error: `同名记忆已存在：${result.name}.md（改名或用「更新」）` })
            return
          }
          sendJson(res, 200, { ok: true, action: result.action, name: result.name, workspace: store.rootDir })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/update',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const store = storeForPanel(body.workspace)
          const updated = store.update(String(body.name ?? ''), {
            title: body.title,
            description: body.description,
            type: MEMORY_TYPES.includes(body.type) ? body.type : undefined,
            body: body.content,
          })
          if (!updated) {
            sendJson(res, 404, { error: `没有这条记忆：${body.name}` })
            return
          }
          sendJson(res, 200, { ok: true, name: updated.name, workspace: store.rootDir })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/delete',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const store = storeForPanel(body.workspace)
          const deleted = store.remove(String(body.name ?? ''))
          if (!deleted) {
            sendJson(res, 404, { error: `没有这条记忆：${body.name}` })
            return
          }
          sendJson(res, 200, { ok: true, workspace: store.rootDir })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-memory/index',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        try {
          const store = storeForPanel(url.searchParams.get('workspace'))
          const rebuilt = store.rebuildIndex()
          sendJson(res, 200, { ok: true, workspace: store.rootDir, text: rebuilt.text, count: rebuilt.entries.length, truncated: rebuilt.truncated })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { error: 'forbidden: loopback only' })
          return
        }
        Promise.resolve(route.handler(req, res)).catch((error) => {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        })
      },
    }))
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-x-memory: routes')

  ctx.effect(() => () => sessionIndex.clear(), 'dsh-x-memory: session cache')
}
