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
/** 落盘文件名只留安全字符，报告内容仍用原始版本/profile。 */
const REPORT_NAME = (NAME || `${VERSION}@${PROFILE}`).replace(/[^0-9A-Za-z@._-]/g, '_')
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

function packageOf(url, names) {
  const normalized = String(url || '').replace(/\\/g, '/')
  if (!normalized) return '(原生/GC)'
  const matched = /node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(normalized)
  if (matched) return matched[1]
  // 链接安装的插件不在 node_modules 下：用 loader 报上来的包名对路径
  for (const name of names) {
    if (normalized.includes(`/${name}/`)) return name
  }
  if (normalized.startsWith('node:')) return '(Node 内部)'
  if (normalized.includes('/perf/')) return '(启动器钩子)'
  return '(其他)'
}

export function summarize(cpuProfile, heapProfile) {
  const names = new Set(entries.map((row) => row.name).filter((name) => name && !name.startsWith('cordis:')))
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

  const packages = [...new Set([...cpuUs.keys(), ...nativeByPackage.keys(), ...allocBytes.keys()])].map((name) => {
    const cpuMs = Math.round((cpuUs.get(name) || 0) / 1000)
    const nativeMs = Math.round((nativeByPackage.get(name) || 0) / 1000)
    return {
      name,
      cpuMs,
      nativeMs,
      totalMs: cpuMs + nativeMs,
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
  if (!session) return
  try {
    const cpu = await session.post('Profiler.stop')
    // 堆分配采样已撤：账本只看 CPU；内存用启动结算时读一次 RSS。
    writeReport(summarize(cpu.profile, null))
  } catch { /* 采样失败不能影响运行 */ }
  try { session.disconnect() } catch { /* ignore */ }
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
    cap = setTimeout(() => { void stop() }, MAX_MS)
    cap.unref?.()
  } catch {
    session = null
  }
}

export function installPluginProfile() {
  if (!DIR) return
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
