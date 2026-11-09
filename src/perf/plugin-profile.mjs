/**
 * 插件启动体检：正常启动路径上顺手采样，按包统计启动期 CPU 与内存分配。
 *
 * 为什么不用「每个 entry 的墙钟耗时」：Cordis 是并发初始化插件的，所有 entry 同时开始，
 * 逐个计时每个人都是 3–5 秒，区分不出谁真的费时。这里改用 V8 采样剖析：
 * - CPU：Profiler 采样主线程，按调用栈 URL 归到包，得到每个包的独占 CPU 时间；
 * - 内存：HeapProfiler 采样分配，按调用栈 URL 归到包，得到启动期分配量（不是常驻占用）。
 *
 * 只观测，不改变启动顺序：采样器本身开销约 1–2%，启动稳定后停掉并写一个 JSON。
 * loader 钩子锚点匹配不到时（dsh 升级改了实现）没有 entry 时间线，但采样仍然有效。
 */
import { Session } from 'node:inspector/promises'
import { registerHooks } from 'node:module'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY = Symbol.for('dsh-x/plugin-profile')
const DIR = process.env.DSH_X_PLUGIN_PROFILE_DIR || ''
const NAME = process.env.DSH_X_PLUGIN_PROFILE || ''
const VERSION = process.env.DSH_VERSION || ''
const PROFILE = process.env.DSH_PROFILE || ''
/** 启动器给的「版本@profile」才是这次实例的真实身份（DSH_PROFILE 只是管理器当前选中的那份）。 */
const [REPORT_VERSION, REPORT_PROFILE] = NAME.includes('@')
  ? [NAME.slice(0, NAME.indexOf('@')), NAME.slice(NAME.indexOf('@') + 1)]
  : [VERSION, PROFILE]
/**
 * 落盘文件名只留安全字符，报告内容仍用原始版本/profile。其余字符按 UTF-8 转成 %XX：
 * 以前一律换成 `_`，中文 profile 名读的时候对不上（管理页拿原名找），等长的两个名字还会撞到同一个文件。
 * 规则要和 server.js 的 pluginProfileFile 一致；纯 ASCII 的名字结果和以前相同。
 */
export function reportFileName(name) {
  return String(name).replace(/[^0-9A-Za-z@._-]/gu, (char) =>
    [...Buffer.from(char, 'utf8')].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''))
}
const REPORT_NAME = reportFileName(NAME || `${VERSION}@${PROFILE}`)
/** CPU 采样间隔（微秒）：1ms，开销小到启动时间上看不出来。 */
const CPU_INTERVAL_US = 1000
/** 最后一个 entry 稳定后再等这么久才收尾：给异步 apply 留出完成时间。 */
const IDLE_MS = 1500
/** 兜底：有 entry 一直不结算时也不能让采样器永远开着。 */
const MAX_MS = 120_000

const pending = new Map()
const entries = []
let session = null
let startedAt = 0
let timer = null
let cap = null
let stopped = false
/** 同步 loader 钩子：启动期解析/读取每个模块花的时间，按「谁触发」和「读的是谁」记。 */
let moduleHooks = null
const resolveCalls = []
const loadCalls = []
/** 启动期模块数不设死上限，但真有异常多的情况也不让数组无限长。 */
const MODULE_CALL_LIMIT = 100_000

function installModuleTiming() {
  if (moduleHooks) return
  try {
    moduleHooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const started = performance.now()
        const result = nextResolve(specifier, context)
        if (resolveCalls.length < MODULE_CALL_LIMIT) {
          resolveCalls.push({
            parent: context.parentURL || '',
            specifier: String(specifier),
            url: String(result?.url || ''),
            us: (performance.now() - started) * 1000,
          })
        }
        return result
      },
      load(url, context, nextLoad) {
        const started = performance.now()
        const result = nextLoad(url, context)
        if (loadCalls.length < MODULE_CALL_LIMIT) {
          loadCalls.push({ url: String(url || ''), us: (performance.now() - started) * 1000 })
        }
        return result
      },
    })
  } catch {
    moduleHooks = null
  }
}

function stopModuleTiming() {
  try { moduleHooks?.deregister() } catch { /* ignore */ }
  moduleHooks = null
}

function packageOf(url, names) {
  const normalized = String(url || '').replace(/\\/g, '/')
  if (!normalized) return '(原生/GC)'
  // 取最后一段 node_modules/<包>/：pnpm 隔离布局是 `node_modules/.pnpm/x@1/node_modules/x/...`，
  // 只看第一段会把所有包都归成 `.pnpm`、插件全是 0；嵌套依赖也是最里面那层才是文件的真正归属。
  let matched = null
  for (const match of normalized.matchAll(/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//g)) {
    if (match[1] !== '.pnpm') matched = match
  }
  if (matched) return matched[1]
  // 链接安装的插件不在 node_modules 下：用 loader 报上来的包名对路径
  for (const name of names) {
    if (normalized.includes(`/${name}/`)) return name
  }
  if (normalized.startsWith('node:')) return '(Node 内部)'
  if (normalized.includes('/perf/')) return '(启动器钩子)'
  return '(其他)'
}

export function summarize(cpuProfile, heapProfile, timing = { resolveCalls, loadCalls }, pluginNames = null) {
  const names = new Set(pluginNames ?? entries.map((row) => row.name).filter((name) => name && !name.startsWith('cordis:')))
  const nodes = new Map((cpuProfile.nodes || []).map((node) => [node.id, node]))
  // 没有 URL 的帧（open/readFileUtf8/spawn/GC…）往上找最近的 JS 调用方，
  // 才能回答「这个插件在启动时到底占了多久」；找不到调用方的才记成未归属。
  const parentOf = new Map()
  for (const node of cpuProfile.nodes || []) {
    // V8 的 children 里存的是节点 id（不是节点对象），按 id 建反向表。
    for (const child of node.children || []) parentOf.set(child, node)
  }
  const cpuUs = new Map()
  const nativeByPackage = new Map()
  const nativeUs = new Map()
  let nativeUnattributedUs = 0
  let totalUs = 0
  let idleUs = 0
  const samples = cpuProfile.samples || []
  const deltas = cpuProfile.timeDeltas || []
  for (let index = 0; index < samples.length; index += 1) {
    const delta = deltas[index] || 0
    totalUs += delta
    const node = nodes.get(samples[index])
    const fn = node?.callFrame?.functionName || ''
    if (fn === '(idle)' || fn === '(root)') { idleUs += delta; continue }
    const url = node?.callFrame?.url || ''
    if (!url) {
      // 没有 URL 的帧：GC、V8 编译/内置函数。按调用方归属，同时保留系统调用分类。
      const key = fn || '(匿名原生)'
      nativeUs.set(key, (nativeUs.get(key) || 0) + delta)
      let owner = parentOf.get(node?.id)
      let ownerPkg = ''
      while (owner) {
        const ownerUrl = owner.callFrame?.url
        if (ownerUrl) { ownerPkg = packageOf(ownerUrl, names); break }
        owner = parentOf.get(owner.id)
      }
      if (ownerPkg) nativeByPackage.set(ownerPkg, (nativeByPackage.get(ownerPkg) || 0) + delta)
      else nativeUnattributedUs += delta
      continue
    }
    const pkg = packageOf(url, names)
    cpuUs.set(pkg, (cpuUs.get(pkg) || 0) + delta)
  }

  const allocBytes = new Map()
  let totalAlloc = 0
  const walk = (node) => {
    if (!node) return
    const size = node.selfSize || 0
    if (size > 0) {
      const pkg = packageOf(node.callFrame?.url, names)
      allocBytes.set(pkg, (allocBytes.get(pkg) || 0) + size)
      totalAlloc += size
    }
    for (const child of node.children || []) walk(child)
  }
  walk(heapProfile?.head)

  // 模块加载：resolve 的耗时记在「谁触发」上，load 记在「读的是谁」上；
  // resolve 同时给出 import 边，最后沿依赖图把整棵子树的加载时间归到插件。
  const moduleUs = new Map()
  const moduleEdges = new Map()
  const moduleRow = (name) => {
    let row = moduleUs.get(name)
    if (!row) { row = { resolveUs: 0, loadUs: 0 }; moduleUs.set(name, row) }
    return row
  }
  let moduleTotalUs = 0
  for (const call of timing.resolveCalls || []) {
    moduleTotalUs += call.us
    if (!call.parent) continue
    const parent = packageOf(call.parent, names)
    if (parent === '(Node 内部)' || parent === '(原生/GC)') continue
    moduleRow(parent).resolveUs += call.us
    const target = /^node:/.test(call.specifier) ? '(Node 内部)' : packageOf(call.url, names)
    if (target === parent || target === '(Node 内部)' || target === '(原生/GC)') continue
    if (!moduleEdges.has(parent)) moduleEdges.set(parent, new Set())
    moduleEdges.get(parent).add(target)
  }
  for (const call of timing.loadCalls || []) {
    moduleTotalUs += call.us
    const pkg = packageOf(call.url, names)
    if (pkg === '(原生/GC)') continue
    moduleRow(pkg).loadUs += call.us
  }

  // 宿主（dsh 自己：官方 @deepseek-ai/* 包与归不了包的 dsh 源码）也会加载的包算框架开销，
  // 不摊给插件：比如 cordis 每个插件都 import，但它本来就是 dsh 在驱动，卸掉插件它照样在。
  // 插件只记「因为装了它才多出来」的那部分。宿主的遍历不往插件里走（loader 会 import 每个插件入口）。
  const PSEUDO = new Set(['(其他)', '(启动器钩子)', '(Node 内部)', '(原生/GC)'])
  const hostReach = new Set()
  const hostQueue = [...moduleEdges.keys()].filter((pkg) => !names.has(pkg) && (/^@deepseek-ai\//.test(pkg) || pkg === '(其他)'))
  for (const root of hostQueue) hostReach.add(root)
  while (hostQueue.length) {
    for (const next of moduleEdges.get(hostQueue.shift()) || []) {
      if (hostReach.has(next) || names.has(next)) continue
      hostReach.add(next)
      hostQueue.push(next)
    }
  }
  // 每个包从哪些插件可达；共用依赖按引用它的插件数均摊，和空间构成的口径一致。
  // 别的插件、宿主也用的包、伪分类都不往下走：它们的开销不该算到这个插件头上。
  const moduleOwners = new Map()
  for (const plugin of names) {
    const seen = new Set([plugin])
    const queue = [plugin]
    while (queue.length) {
      const pkg = queue.shift()
      for (const next of moduleEdges.get(pkg) || []) {
        if (seen.has(next) || names.has(next) || hostReach.has(next) || PSEUDO.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    for (const pkg of seen) {
      if (!moduleOwners.has(pkg)) moduleOwners.set(pkg, new Set())
      moduleOwners.get(pkg).add(plugin)
    }
  }

  const plugins = [...names].map((name) => {
    let loadUs = 0
    let runUs = 0
    for (const [pkg, owners] of moduleOwners) {
      if (!owners.has(name)) continue
      const share = 1 / owners.size
      const module = moduleUs.get(pkg)
      if (module) loadUs += (module.resolveUs + module.loadUs) * share
      runUs += ((cpuUs.get(pkg) || 0) + (nativeByPackage.get(pkg) || 0)) * share
    }
    const loadMs = Math.round(loadUs / 1000)
    const runMs = Math.round(runUs / 1000)
    return { name, loadMs, runMs, totalMs: loadMs + runMs }
  }).sort((left, right) => right.totalMs - left.totalMs || right.runMs - left.runMs)

  const packages = [...new Set([...cpuUs.keys(), ...nativeByPackage.keys(), ...allocBytes.keys(), ...moduleUs.keys()])].map((name) => {
    const cpuMs = Math.round((cpuUs.get(name) || 0) / 1000)
    const nativeMs = Math.round((nativeByPackage.get(name) || 0) / 1000)
    const module = moduleUs.get(name)
    const loadMs = Math.round((module?.loadUs || 0) / 1000)
    const resolveMs = Math.round((module?.resolveUs || 0) / 1000)
    return {
      name,
      cpuMs,
      nativeMs,
      loadMs,
      resolveMs,
      totalMs: cpuMs + nativeMs + loadMs + resolveMs,
      allocKB: Math.round((allocBytes.get(name) || 0) / 1024),
      plugin: names.has(name),
    }
  }).sort((a, b) => b.totalMs - a.totalMs || b.cpuMs - a.cpuMs)

  return {
    version: REPORT_VERSION,
    profile: REPORT_PROFILE,
    at: Date.now(),
    windowMs: Math.round(performance.now() - startedAt),
    cpuMs: Math.round(totalUs / 1000),
    idleMs: Math.round(idleUs / 1000),
    allocMB: +(totalAlloc / 1048576).toFixed(1),
    packages,
    plugins,
    moduleLoadMs: Math.round(moduleTotalUs / 1000),
    nativeUnattributedMs: Math.round(nativeUnattributedUs / 1000),
    native: [...nativeUs.entries()]
      .map(([name, us]) => ({ name, cpuMs: Math.round(us / 1000) }))
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, 12),
    entries,
  }
}

function writeReport(report) {
  try {
    mkdirSync(DIR, { recursive: true })
    const file = join(DIR, `${REPORT_NAME}.json`)
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(report))
    renameSync(temp, file)
  } catch { /* 体检写不进去不能影响启动 */ }
}

async function stop() {
  if (stopped) return
  stopped = true
  if (timer !== null) { clearTimeout(timer); timer = null }
  if (cap !== null) { clearTimeout(cap); cap = null }
  stopModuleTiming()
  try {
    if (!session) return
    try {
      const cpu = await session.post('Profiler.stop')
      // 堆分配采样已撤：账本只看 CPU；内存用启动结算时读一次 RSS。
      writeReport(summarize(cpu.profile, null, { resolveCalls, loadCalls }))
    } catch { /* 采样失败不能影响运行 */ }
    try { session.disconnect() } catch { /* ignore */ }
  } finally {
    // 报告写完这些记录就没用了；不清的话最多 2×10 万条 URL 会在 dsh 进程里留一整个会话
    resolveCalls.length = 0
    loadCalls.length = 0
    entries.length = 0
  }
}

function schedule() {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => { void stop() }, IDLE_MS)
  timer.unref?.()
}

function settle(entry, failed) {
  const row = pending.get(entry)
  if (!row || row.done) return
  row.done = true
  pending.delete(entry)
  entries.push({
    name: row.name,
    startMs: Math.round(row.started - startedAt),
    endMs: Math.round(performance.now() - startedAt),
    heapKB: Math.round(process.memoryUsage().heapUsed / 1024),
    ...(failed ? { failed: true } : {}),
  })
  schedule()
}

async function start() {
  if (!DIR) return
  try {
    session = new Session()
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: CPU_INTERVAL_US })
    await session.post('Profiler.start')
    startedAt = performance.now()
  } catch {
    session = null
  }
  // 兜底放在 try 外：采样器起不来、loader 锚点又没匹配上时，没人会调 stop，
  // 模块钩子会在 dsh 里挂一辈子。到点无论如何收掉。
  cap = setTimeout(() => { void stop() }, MAX_MS)
  cap.unref?.()
}

export function installPluginProfile() {
  if (!DIR) return
  // 模块加载计时要抢在 dsh 的入口模块之前装上（--import 阶段）。
  installModuleTiming()
  globalThis[KEY] = {
    enter(entry) {
      if (!entry || pending.has(entry)) return
      pending.set(entry, { name: nameOf(entry), started: performance.now() })
    },
    imported(entry) {
      const row = pending.get(entry)
      if (!row) return
      const fiber = entry?.fiber
      if (fiber && typeof fiber.await === 'function') {
        // fiber 进入 active（或失败）才算这个插件启动完；apply 里的异步初始化都在里面。
        fiber.await().then(() => settle(entry, false), () => settle(entry, true))
      } else settle(entry, false)
    },
  }
  void start()
}

function nameOf(entry) {
  const name = entry?.options?.name
  return typeof name === 'string' && name ? name : String(entry?.options?.id || 'unknown')
}
