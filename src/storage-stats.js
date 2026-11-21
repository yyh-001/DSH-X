import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 有限并发地跑一组异步任务，防止宽目录/大批文件瞬间堆出海量 Promise。 */
export async function mapLimit(items, limit, task) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await task(item)
    }
  })
  await Promise.all(workers)
}

/**
 * 磁盘占用统计。三件事让它便宜：
 * 1. 每棵树只走一遍：包大小、依赖图、node_modules 总量在同一次遍历里得出；
 * 2. 全局限流：所有统计共用 FS_SLOTS 个文件系统操作名额，不把 libuv 线程池占满；
 * 3. 指纹缓存：node_modules 只在安装后才变；结果落盘（size-cache.json），同一时刻共用一次遍历。
 */
const FS_SLOTS = 16
const SIZE_PROBES = [
  'package.json', 'pnpm-lock.yaml', 'package-lock.json',
  'node_modules', 'node_modules/.modules.yaml', 'node_modules/.package-lock.json',
  'node_modules/.pnpm', 'node_modules/.pnpm/lock.yaml',
]
const SIZE_CACHE_MAX = 40

/** .pnpm 目录名 → 包名：`pkg@1.2.3`、`@scope+pkg@1.2.3(peer@x)`。 */
function pnpmPackageName(entry) {
  const raw = String(entry).replace(/\(.*$/, '')
  const at = raw.lastIndexOf('@')
  return (at > 0 ? raw.slice(0, at) : raw).replace(/\+/g, '/')
}

/** 每个直接插件能到达哪些包；共用包按引用它的插件数量均摊。 */
function attributePlugins(graph, direct, sizes) {
  const parents = new Map()
  for (const start of direct) {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      const current = queue.shift()
      for (const next of graph.get(current) || []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    for (const name of seen) {
      if (name === start) continue
      const owners = parents.get(name) || new Set()
      owners.add(start)
      parents.set(name, owners)
    }
  }
  const totals = new Map()
  for (const name of direct) totals.set(name, sizes.get(name) || 0)
  let depsBytes = 0
  for (const [name, owners] of parents) {
    if (direct.includes(name)) continue
    const size = sizes.get(name) || 0
    if (!size) continue
    depsBytes += size
    const share = size / owners.size
    for (const owner of owners) totals.set(owner, (totals.get(owner) || 0) + share)
  }
  const plugins = [...totals.entries()]
    .map(([name, bytes]) => ({ name, bytes: Math.round(bytes) }))
    .filter((plugin) => plugin.bytes >= 1)
    .sort((left, right) => right.bytes - left.bytes)
  return { plugins, depsBytes }
}

export function createStorageStats({
  appDir,
  getDataDir,
  versionDir,
  homeDir,
  safeProfile,
  profileDependencies,
  scanInstalled,
  isManaged,
}) {
  let fsActive = 0
  const fsWaiters = []
  async function withFsSlot(task) {
    if (fsActive < FS_SLOTS) fsActive += 1
    else await new Promise((resolve) => fsWaiters.push(resolve))
    try {
      return await task()
    } finally {
      const next = fsWaiters.shift()
      if (next) next()
      else fsActive -= 1
    }
  }

  /** 目录的逻辑占用。符号链接跳过，避免把 pnpm 共享 store 重复算进每个版本。 */
  async function directoryBytes(root, { skip = [] } = {}) {
    const skipped = new Set(skip)
    let total = 0
    const walk = async (dir, top) => {
      let entries
      try { entries = await withFsSlot(() => readdir(dir, { withFileTypes: true })) } catch { return }
      const files = []
      const dirs = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!(top && skipped.has(entry.name))) dirs.push(entry.name)
        } else if (entry.isFile()) {
          files.push(entry.name)
        }
      }
      await mapLimit(files, 32, async (name) => {
        let size = 0
        try { size = (await withFsSlot(() => stat(join(dir, name)))).size } catch { /* 文件刚好被删 */ }
        total += size
      })
      await mapLimit(dirs, 8, (name) => walk(join(dir, name), false))
    }
    await walk(root, true)
    return total
  }

  async function scanNodeModules(nodeModules) {
    const sizes = new Map()
    const graph = new Map()
    let bytes = 0
    const manifestOf = async (dir) => {
      try { return JSON.parse(await withFsSlot(() => readFile(join(dir, 'package.json'), 'utf8'))) } catch { return null }
    }
    const addGraph = (pkg) => {
      if (!pkg?.name) return
      graph.set(pkg.name, [...new Set([
        ...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
        ...(pkg.optionalDependencies ? Object.keys(pkg.optionalDependencies) : []),
      ])])
    }
    const addSize = (name, size) => {
      sizes.set(name, (sizes.get(name) || 0) + size)
      bytes += size
    }
    const children = async (dir) => (await withFsSlot(() => readdir(dir, { withFileTypes: true })).catch(() => []))
      .filter((entry) => !entry.isSymbolicLink())
    const hoisted = async (dir, fallback) => {
      const [pkg, size] = await Promise.all([manifestOf(dir), directoryBytes(dir)])
      addSize(pkg?.name || fallback, size)
      addGraph(pkg)
    }
    const virtual = async (dir, entry) => {
      const name = pnpmPackageName(entry)
      const [size, inner] = await Promise.all([directoryBytes(dir), children(join(dir, 'node_modules'))])
      if (name) addSize(name, size)
      else bytes += size
      const manifests = []
      for (const sub of inner) {
        if (!sub.isDirectory()) continue
        const subDir = join(dir, 'node_modules', sub.name)
        if (sub.name.startsWith('@')) {
          for (const child of await children(subDir)) if (child.isDirectory()) manifests.push(manifestOf(join(subDir, child.name)))
        } else manifests.push(manifestOf(subDir))
      }
      for (const pkg of await Promise.all(manifests)) addGraph(pkg)
    }
    const jobs = []
    const later = (job) => jobs.push(job)
    for (const entry of await children(nodeModules)) {
      const path = join(nodeModules, entry.name)
      if (entry.isFile()) {
        later(() => withFsSlot(() => stat(path)).then((info) => { bytes += info.size }, () => {}))
      } else if (!entry.isDirectory()) {
        continue
      } else if (entry.name === '.pnpm') {
        for (const item of await children(path)) {
          const itemPath = join(path, item.name)
          if (item.isDirectory()) later(() => virtual(itemPath, item.name))
          else if (item.isFile()) later(() => withFsSlot(() => stat(itemPath)).then((info) => { bytes += info.size }, () => {}))
        }
      } else if (entry.name.startsWith('.')) {
        later(() => directoryBytes(path).then((size) => { bytes += size }))
      } else if (entry.name.startsWith('@')) {
        for (const sub of await children(path)) {
          if (sub.isDirectory()) later(() => hoisted(join(path, sub.name), `${entry.name}/${sub.name}`))
        }
      } else {
        later(() => hoisted(path, entry.name))
      }
    }
    await mapLimit(jobs, 8, (job) => job())
    return { bytes, sizes, graph }
  }

  async function sizeFingerprint(root) {
    const parts = await Promise.all(SIZE_PROBES.map((name) =>
      withFsSlot(() => stat(join(root, name))).then((info) => `${Math.round(info.mtimeMs)}:${info.size}`, () => '-')))
    return parts.join('|')
  }

  const sizeCacheFile = join(appDir, 'size-cache.json')
  let sizeCache = null
  const sizeScans = new Map()
  let sizeCacheWrite = null
  const sizeGenerations = new Map()

  function loadSizeCache() {
    if (sizeCache) return sizeCache
    sizeCache = new Map()
    try {
      const parsed = JSON.parse(readFileSync(sizeCacheFile, 'utf8'))
      if (parsed?.v === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const [dir, entry] of Object.entries(parsed.entries)) {
          if (typeof entry?.fp !== 'string' || !Array.isArray(entry.sizes) || !Array.isArray(entry.graph)) continue
          sizeCache.set(dir, { fp: entry.fp, at: Number(entry.at) || 0, bytes: Number(entry.bytes) || 0, sizes: new Map(entry.sizes), graph: new Map(entry.graph) })
        }
      }
    } catch { /* 没有或坏了：重新统计一遍就有了 */ }
    return sizeCache
  }

  /** 写一条缓存，并把内存里的条目数压回 SIZE_CACHE_MAX（按最近统计时间留新的）。 */
  function rememberSizeStats(nodeModules, entry) {
    const cache = loadSizeCache()
    cache.set(nodeModules, entry)
    if (cache.size <= SIZE_CACHE_MAX) return
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - SIZE_CACHE_MAX)
    for (const [dir] of oldest) cache.delete(dir)
  }

  function scheduleSizeCacheWrite() {
    if (sizeCacheWrite) return
    sizeCacheWrite = setTimeout(async () => {
      sizeCacheWrite = null
      const kept = [...loadSizeCache().entries()].sort((a, b) => b[1].at - a[1].at).slice(0, SIZE_CACHE_MAX)
      const entries = Object.fromEntries(kept.map(([dir, entry]) => [dir, { fp: entry.fp, at: entry.at, bytes: entry.bytes, sizes: [...entry.sizes], graph: [...entry.graph] }]))
      const temp = `${sizeCacheFile}.${process.pid}.tmp`
      try {
        await mkdir(dirname(sizeCacheFile), { recursive: true })
        await writeFile(temp, JSON.stringify({ v: 1, entries }))
        renameSync(temp, sizeCacheFile)
      } catch { try { rmSync(temp, { force: true }) } catch { /* ignore */ } }
    }, 500)
    sizeCacheWrite.unref?.()
  }

  async function nodeModulesStats(root) {
    const nodeModules = join(root, 'node_modules')
    const fp = await sizeFingerprint(root)
    const hit = loadSizeCache().get(nodeModules)
    if (hit && hit.fp === fp) return hit
    const key = `${nodeModules}\0${fp}`
    if (!sizeScans.has(key)) {
      const generation = sizeGenerations.get(nodeModules) || 0
      sizeScans.set(key, scanNodeModules(nodeModules).then((result) => {
        const entry = { fp, at: Date.now(), ...result }
        if ((sizeGenerations.get(nodeModules) || 0) === generation) {
          rememberSizeStats(nodeModules, entry)
          scheduleSizeCacheWrite()
        }
        return entry
      }).finally(() => sizeScans.delete(key)))
    }
    return sizeScans.get(key)
  }

  function forgetNodeModulesStats(root) {
    const nodeModules = join(root, 'node_modules')
    sizeGenerations.set(nodeModules, (sizeGenerations.get(nodeModules) || 0) + 1)
    if (loadSizeCache().delete(nodeModules)) scheduleSizeCacheWrite()
  }

  function pruneVersionSizeStats(installed) {
    const root = join(getDataDir(), 'versions')
    const keep = new Set(installed.map((version) => join(versionDir(version), 'node_modules')))
    let changed = false
    for (const dir of [...loadSizeCache().keys()]) {
      if (dirname(dirname(dir)) === root && !keep.has(dir)) changed = loadSizeCache().delete(dir) || changed
    }
    for (const dir of [...sizeGenerations.keys()]) if (dirname(dirname(dir)) === root && !keep.has(dir)) sizeGenerations.delete(dir)
    if (changed) scheduleSizeCacheWrite()
  }

  async function storageBreakdown(version, profile) {
    const versionPath = versionDir(version)
    const profilePath = join(homeDir(), 'profiles', safeProfile(profile))
    const [versionModules, versionRest, profileModules, dataBytes] = await Promise.all([
      nodeModulesStats(versionPath),
      directoryBytes(versionPath, { skip: ['node_modules'] }),
      nodeModulesStats(profilePath),
      directoryBytes(profilePath, { skip: ['node_modules'] }),
    ])
    const versionPackages = versionModules.sizes
    const profilePackages = profileModules.sizes
    const direct = new Set(Object.keys(profileDependencies(profilePath)))
    const { plugins, depsBytes: pluginDepsBytes } = attributePlugins(profileModules.graph, [...direct], profilePackages)
    let pluginOwnBytes = 0
    for (const name of direct) pluginOwnBytes += profilePackages.get(name) || 0
    let runtimeBytes = 0
    let runtimeDepsBytes = 0
    for (const [name, bytes] of versionPackages) {
      if (name.startsWith('@deepseek-ai/')) runtimeBytes += bytes
      else runtimeDepsBytes += bytes
    }
    const total = versionModules.bytes + versionRest + profileModules.bytes + dataBytes
    const restBytes = Math.max(0, total - pluginOwnBytes - pluginDepsBytes - runtimeBytes - runtimeDepsBytes - dataBytes)
    const segments = [
      { key: 'plugin', bytes: pluginOwnBytes },
      { key: 'plugin-deps', bytes: pluginDepsBytes },
      { key: 'runtime', bytes: runtimeBytes },
      { key: 'runtime-deps', bytes: runtimeDepsBytes },
      { key: 'data', bytes: dataBytes },
      { key: 'rest', bytes: restBytes },
    ].filter((segment) => segment.bytes >= 1)
    const combined = new Map()
    for (const [name, bytes] of versionPackages) combined.set(name, { name, bytes, plugin: false })
    for (const [name, bytes] of profilePackages) {
      const item = combined.get(name) || { name, bytes: 0, plugin: false }
      item.bytes += bytes
      item.plugin = item.plugin || direct.has(name)
      combined.set(name, item)
    }
    const items = [...combined.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 5)
    return { version, profile, total, segments, plugins, items }
  }

  async function versionSizes() {
    const versions = scanInstalled().filter(isManaged)
    pruneVersionSizeStats(versions)
    const entries = []
    await mapLimit(versions, 3, async (version) => {
      const dir = versionDir(version)
      const [modules, rest] = await Promise.all([nodeModulesStats(dir), directoryBytes(dir, { skip: ['node_modules'] })])
      entries.push([version, modules.bytes + rest])
    })
    const sizes = Object.fromEntries(entries)
    const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0)
    return { versions: sizes, total }
  }

  return {
    directoryBytes,
    nodeModulesStats,
    forgetNodeModulesStats,
    storageBreakdown,
    versionSizes,
  }
}
