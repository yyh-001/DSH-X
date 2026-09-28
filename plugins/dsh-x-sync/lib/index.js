/**
 * dsh-x-sync 主机侧：把 DSH-X 启动器那套同步引擎接进 dsh。
 *
 * 三件事：
 * 1. 配置（远端 + 范围 + 冲突策略）存在**当前 profile 目录**下的 `dsh-x-sync.json`，
 *    和启动器的那份互不干扰（但桶、目录结构完全一样，所以两边能共用同一只桶）；
 * 2. 给 agent 两个工具：`sync_status`（看配置和差异）与 `sync_now`（真跑一次）——
 *    对话里说「同步一下」就能用。**不接受密钥参数**：凭据只从配置文件读，
 *    免得把 S3/WebDAV 密码写进会话日志；
 * 3. 给浏览器面板一组本机路由（`/api/x-sync/*`）：读写配置、连接自检、跑同步、看进度，
 *    设置页那块面板（lib/client.js）就是调它们。
 *
 * 与启动器的关系：同一只桶、同一套 `dsh-x/v1/...` 布局、同一套合并语义。插件跑在 dsh
 * 进程里，管日常；dsh 起不来时用启动器那条路（那是它不可替代的地方）。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  runSync,
  safeFolderConfig,
  safePolicy,
  safeS3Config,
  safeScopeIds,
  safeStoreType,
  safeWebdavConfig,
  safeZipConfig,
  storeClient,
  storeConfigured,
  storeDisplayUrl,
  storeLabel,
  storeMissing,
} from './engine/sync.js'

/** 服务：工具注册表 + 本机 web 路由。（必须导出，cordis 是从模块上读 inject 的） */
export const inject = ['tools', 'webServer']

const CONFIG_NAME = 'dsh-x-sync.json'
const DEFAULT_CONFIG = {
  store: 's3',
  s3: {},
  webdav: {},
  folder: {},
  zip: {},
  scopes: ['sessions', 'attachments', 'plugins'],
  policy: 'skip',
}

/** dsh 用户目录：环境变量优先（和 dsh 自己的口径一致）。 */
function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 当前 profile 目录：找 packages.json 里装了本插件的那个 profile；
 * 找不到（比如手工拷进来的）就退回 profiles/web，再退回唯一的那个 profile。
 */
export function resolveProfileDir(home = homeDir(), packageName = 'dsh-x-sync') {
  const profiles = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(profiles, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').map((entry) => entry.name)
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

/** 技能根：dsh 自己的 + .agents 的（和启动器那边的 skillRoots 一个口径）。 */
export function skillRoots(home = homeDir()) {
  return [
    { key: 'dsh', dir: join(home, 'skills') },
    { key: 'agents', dir: join(process.env.DSH_AGENTS_HOME || join(homedir(), '.agents'), 'skills') },
  ]
}

/** 归一化一份配置：脏值回默认，显式填错（桶名/端口那类）会抛。 */
export function normalizeConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    store: safeStoreType(source.store),
    s3: safeS3Config(source.s3),
    webdav: safeWebdavConfig(source.webdav),
    folder: safeFolderConfig(source.folder),
    zip: safeZipConfig(source.zip),
    scopes: safeScopeIds(source.scopes),
    policy: safePolicy(source.policy),
  }
}

export function configPath(profileDir = resolveProfileDir()) {
  return join(profileDir, CONFIG_NAME)
}

export function loadConfig(profileDir = resolveProfileDir()) {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(profileDir), 'utf8')))
  } catch {
    return normalizeConfig(DEFAULT_CONFIG)
  }
}

/** 原子写：先写临时文件再改名，dsh 正在跑的时候读到的永远是完整文件。 */
export function saveConfig(patch, profileDir = resolveProfileDir()) {
  const next = normalizeConfig({ ...loadConfig(profileDir), ...patch })
  const file = configPath(profileDir)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(temp, file)
  return next
}

/** 引擎那份「远端」配置。 */
export function storeConfig(config) {
  return { store: config.store, s3: config.s3, webdav: config.webdav, folder: config.folder, zip: config.zip }
}

/** 一次同步的上下文（引擎只认这几个目录）。 */
export function syncContext(profileDir = resolveProfileDir(), home = homeDir()) {
  return {
    home,
    profile: profileDir.split(/[\\/]/).pop(),
    profileDir,
    roots: skillRoots(home),
  }
}

/**
 * 跑一次同步。onProgress 用来看进度（面板轮询 state 时读它）。
 * 不走引擎的 log 回调：插件的日志交给 dsh 的 logger，免得刷屏。
 */
export async function runOnce({ direction = 'up', scopes, policy, force = false, profileDir, home = homeDir(), onProgress, shouldStop } = {}) {
  const config = loadConfig(profileDir)
  const store = storeConfig(config)
  if (!storeConfigured(store)) {
    throw new Error(`${storeLabel(store)} 还没配好（缺 ${storeMissing(store).join('、')}）：到设置页的「同步」里填一下`)
  }
  const summary = await runSync({
    mode: direction === 'down' ? 'down' : 'up',
    scopes: scopes ?? config.scopes,
    config: store,
    context: syncContext(profileDir, home),
    policy: policy ?? config.policy,
    force,
    onProgress: onProgress || (() => {}),
    shouldStop: shouldStop || (() => false),
  })
  return { summary, config }
}

/** 把摘要压成一句人话（工具返回、面板提示都用它）。 */
export function describeSummary(summary, { store } = {}) {
  const moved = summary.mode === 'up' ? summary.uploaded : summary.downloaded
  const verb = store === 'folder' || store === 'zip'
    ? (summary.mode === 'up' ? '导出' : '导入')
    : (summary.mode === 'up' ? '上传' : '下载')
  const bytes = (summary.bytesUp || 0) + (summary.bytesDown || 0)
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
  const parts = [`${verb} ${moved} 个文件`]
  if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`)
  if (summary.merged) parts.push('插件清单已合并')
  if (summary.installed) parts.push('依赖已重装')
  const tail = summary.stopped ? '（中途停下了）' : ''
  const notes = summary.notes?.length ? `\n${summary.notes.join('\n')}` : ''
  return `${parts.join('、')}（${size}）${tail}${notes}`
}

/** 配置摘要（工具与面板都用这一个口径，不泄露密钥）。 */
export function describeConfig(config) {
  const store = storeConfig(config)
  const lines = [
    `存储类型：${storeLabel(store)}`,
    `位置：${storeConfigured(store) ? storeDisplayUrl(store) : '（还没配好）'}`,
    `同步范围：${config.scopes.join('、') || '（没选）'}`,
    `冲突策略：${{ skip: '保留本机', overwrite: '用远端的覆盖本机', duplicate: '两份都留' }[config.policy] || config.policy}`,
  ]
  return lines.join('\n')
}

/** 工具输出声明：一个 ok + 一段文本，够 agent 读懂。 */
const textOut = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      text: { type: 'string' },
      uploaded: { type: 'integer' },
      downloaded: { type: 'integer' },
      skipped: { type: 'integer' },
      conflicts: { type: 'integer' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text || (value.ok ? 'ok' : 'failed') }],
}

/** 工具注册（导出出来，单测可以直接调它们）。 */
export function buildTools({ defineTool, profileDirOf = resolveProfileDir, stateOf = () => null, home = homeDir() } = {}) {
  if (typeof defineTool !== 'function') throw new Error('buildTools 需要 defineTool（dsh 里传 @deepseek-ai/dsh-tools 的那个）')
  return [
    defineTool({
      name: 'sync_status',
      description: 'Show the DSH-X sync configuration (remote storage, scopes, conflict policy) and, with check=true, what a sync would transfer right now. Use this before sync_now when unsure what is configured.',
      parameters: {
        check: { type: 'boolean', description: 'Also list what would change (reads the remote listing; can be slow on WebDAV).' },
      },
      output: textOut,
      async execute(args) {
        const config = loadConfig(profileDirOf())
        const store = storeConfig(config)
        const head = `${describeConfig(config)}`
        if (!args?.check) return { ok: true, text: head }
        if (!storeConfigured(store)) return { ok: false, text: `${head}\n远端还没配好：${storeMissing(store).join('、')}` }
        const progress = stateOf()
        if (progress && progress.phase && !['done', 'error', 'idle'].includes(progress.phase)) {
          return { ok: true, text: `${head}\n（正在同步：${progress.phase} ${progress.done || 0}/${progress.total || 0}）` }
        }
        // 只看不动：数出有多少要传，绝不写远端（状态工具不该有副作用）
        try {
          return { ok: true, text: `${head}\n要传的：\n${await peekPlan({ profileDir: profileDirOf(), config })}` }
        } catch (error) {
          return { ok: false, text: `${head}\n查不了差异：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }),
    defineTool({
      name: 'sync_now',
      description: 'Run one DSH-X sync: direction="up" backs up this machine to the configured remote, direction="down" pulls it back and merges. Sessions, attachments, plugin config, skills and memory follow the scopes saved in the plugin settings; the plugin manifest is merged in both directions so no plugin is lost.',
      parameters: {
        direction: { type: 'string', description: '"up" (backup) or "down" (pull/merge). Defaults to "up".' },
        force: { type: 'boolean', description: 'Re-transfer every file even when size and time match.' },
      },
      output: textOut,
      async execute(args) {
        const direction = args?.direction === 'down' ? 'down' : 'up'
        let result
        try {
          result = await runOnce({ direction, profileDir: profileDirOf(), home, force: args?.force === true })
        } catch (error) {
          // 没配好、认证失败、网络不通：都当「这次没成功」回报，让模型把原因讲给用户
          return { ok: false, text: `同步失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const { summary, config } = result
        return {
          ok: !summary.installError,
          text: describeSummary(summary, { store: config.store }),
          uploaded: summary.uploaded,
          downloaded: summary.downloaded,
          skipped: summary.skipped,
          conflicts: summary.conflicts?.length || 0,
        }
      },
    }),
  ]
}

// ─────────────────────────────────────────── 本机路由（给设置页那块面板用）

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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

/** 原生目录/文件选择（导出到目录或 zip 时用；Windows/macOS 才有）。 */
function pickPath({ mode = 'dir' } = {}) {
  const platform = process.platform
  if (platform === 'win32') {
    const dialog = mode === 'dir' ? 'FolderBrowserDialog' : mode === 'save' ? 'SaveFileDialog' : 'OpenFileDialog'
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `$d = New-Object System.Windows.Forms.${dialog}`,
      mode === 'dir' ? '$d.ShowNewFolderButton = $true' : "$d.Filter = 'ZIP 文件 (*.zip)|*.zip|所有文件 (*.*)|*.*'",
      "$d.Title = '选择同步用的目录/文件'",
      mode === 'dir'
        ? 'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
        : 'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    ].join('; ')
    return new Promise((resolve, reject) => {
      execFile('powershell', ['-STA', '-NoProfile', '-Command', script], { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout || '').trim())
      })
    })
  }
  if (platform === 'darwin') {
    const what = mode === 'dir' ? 'choose folder' : 'choose file'
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-e', 'activate', '-e', `POSIX path of (${what} with prompt "选择同步用的目录/文件")`], { timeout: 5 * 60 * 1000, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          if (String(stderr || '').includes('(-128)')) resolve('')
          else reject(error)
          return
        }
        resolve(String(stdout || '').trim().replace(/(.)\/+$/, '$1'))
      })
    })
  }
  throw new Error('这个系统上请手填路径')
}

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  // dsh 内部包：跑在 dsh 里一定有（和别的插件一样的 peer 依赖）
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const home = homeDir()
  const profileDir = resolveProfileDir(home)
  let state = null
  let running = false
  let stopRequested = false

  logger.info?.(`[dsh-x-sync] profile: ${profileDir}`)

  // agent 工具
  ctx.effect(() => {
    const disposers = buildTools({ defineTool, home, profileDirOf: () => profileDir, stateOf: () => state })
      .map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-x-sync: tools')

  const runJob = async (mode, options = {}) => {
    if (running) throw new Error('上一次同步还没结束')
    running = true
    stopRequested = false
    const startedAt = Date.now()
    state = { phase: 'start', mode, done: 0, total: 0, at: startedAt }
    try {
      const { summary, config: saved } = await runOnce({
        direction: mode,
        profileDir,
        home,
        force: options.force === true,
        policy: options.policy,
        scopes: Array.isArray(options.scopes) ? options.scopes : undefined,
        onProgress: (progress) => { state = { ...progress, mode, at: Date.now() } },
        shouldStop: () => stopRequested,
      })
      summary.seconds = Math.round((Date.now() - (startedAt || Date.now())) / 1000)
      state = { phase: 'done', mode, at: Date.now(), summary, text: describeSummary(summary, { store: saved.store }) }
      logger.info?.(`[dsh-x-sync] ${state.text.split('\n')[0]}`)
      return state
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state = { phase: 'error', mode, at: Date.now(), error: message }
      logger.warn?.(`[dsh-x-sync] 同步失败：${message}`)
      throw error
    } finally {
      running = false
    }
  }

  const routes = [
    {
      path: '/api/x-sync/config',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { config: loadConfig(profileDir), profileDir, state, running })
          return
        }
        const body = await readBody(req)
        try {
          const saved = saveConfig(body, profileDir)
          sendJson(res, 200, { ok: true, config: saved, profileDir, state, running })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-sync/test',
      handler: async (_req, res) => {
        const config = loadConfig(profileDir)
        const store = storeConfig(config)
        if (!storeConfigured(store)) {
          sendJson(res, 400, { error: `${storeLabel(store)} 还没配好：${storeMissing(store).join('、')}` })
          return
        }
        try {
          const client = storeClient(store)
          const info = await client.test()
          sendJson(res, 200, { ok: true, ...info })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-sync/run',
      handler: async (req, res) => {
        const body = await readBody(req)
        const mode = body.mode === 'down' ? 'down' : 'up'
        try {
          const result = await runJob(mode, body)
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/x-sync/stop',
      handler: async (_req, res) => {
        if (!running) {
          sendJson(res, 200, { ok: true, stopped: false })
          return
        }
        stopRequested = true
        sendJson(res, 200, { ok: true, stopped: true })
      },
    },
    {
      path: '/api/x-sync/state',
      handler: async (_req, res) => {
        sendJson(res, 200, { state, running })
      },
    },
    {
      path: '/api/x-sync/pick',
      handler: async (req, res) => {
        const body = await readBody(req)
        try {
          const path = await pickPath({ mode: body.mode === 'dir' ? 'dir' : body.mode === 'open' ? 'open' : 'save' })
          sendJson(res, 200, { path })
        } catch (error) {
          sendJson(res, 200, { path: '', error: error instanceof Error ? error.message : String(error) })
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
  }, 'dsh-x-sync: api routes')
}

export { DEFAULT_CONFIG, CONFIG_NAME, homeDir }
