// 核心包（dsh-x-core）的获取：查 npm 元数据 → 挑版本 → 下 tarball → 校验 sha512 → 解压。
//
// 两处用它：
// - 安装版外壳：安装包里不再带核心，第一次启动就靠它从 npm 取到 core/current（见 shell/main.mjs）
// - npm CLI（npm-package/lib/core.mjs）：取到自己的缓存目录
// 解压用系统自带的 tar（Windows 10+ 的 System32\tar.exe、其他平台的 /usr/bin/tar），不引依赖。
// 核心包跨平台：Windows / mac / Linux 用同一个 dsh-x-core。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

/** 核心包上限：app 层约 15 MB，超过这个数八成是错误页或别的文件。 */
export const CORE_MAX_BYTES = 128 * 1024 * 1024

export function corePackageName() {
  return process.env.DSH_CORE_PACKAGE || 'dsh-x-core'
}

/**
 * registry 顺序：镜像优先（国内直连 npmjs 常常超时），DSH_CORE_REGISTRY 可以覆盖。
 * 只在请求失败时换下一个；镜像旧一点也算正常。
 */
export function coreRegistries() {
  const override = String(process.env.DSH_CORE_REGISTRY || '').trim().replace(/\/+$/, '')
  if (override) return [override]
  return ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
}

function metadataUrl(registry, name) {
  return `${String(registry).replace(/\/+$/, '')}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

/**
 * 指定版本在某个 registry 上的 tarball 地址。
 * 镜像偶尔元数据同步了、tarball 却拉不动（或反过来），下载失败时可以换另一个源重试。
 */
export function tarballFor(registry, name, version) {
  const base = String(registry).replace(/\/+$/, '')
  if (!base || !name || !version) return ''
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return `${base}/${name}/-/${bare}-${version}.tgz`
}

function doFetch(fetchImpl) {
  return typeof fetchImpl === 'function' ? fetchImpl : fetch
}

/**
 * 读 npm 元数据。`registry` 指定单个源（首启按镜像 → 官方逐个试）；
 * `timeoutMs` 让慢镜像尽快失败，别让首启窗口干等。
 */
export async function fetchCoreMetadata(name = corePackageName(), { fetchImpl, registry = '', timeoutMs = 30_000 } = {}) {
  let last = null
  for (const base of registry ? [String(registry).replace(/\/+$/, '')] : coreRegistries()) {
    try {
      const res = await doFetch(fetchImpl)(metadataUrl(base, name), {
        redirect: 'follow',
        headers: { accept: 'application/json', 'user-agent': 'dsh-x' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (error) {
      last = error
    }
  }
  throw new Error(`读取 ${name} 的 npm 元数据失败：${last?.message || '没有可用的 registry'}`)
}

/** 版本比较：正式版 > 预发布；数字段按数值比，预发布段逐段比（rc.10 > rc.9）。 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^v/, '')
    const dash = text.indexOf('-')
    const core = dash >= 0 ? text.slice(0, dash) : text
    const pre = dash >= 0 ? text.slice(dash + 1) : ''
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  if (!left.pre && !right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  const l = left.pre.split('.')
  const r = right.pre.split('.')
  const parts = Math.max(l.length, r.length)
  for (let i = 0; i < parts; i += 1) {
    if (l[i] === undefined) return -1
    if (r[i] === undefined) return 1
    const lnum = /^\d+$/.test(l[i]) ? Number(l[i]) : NaN
    const rnum = /^\d+$/.test(r[i]) ? Number(r[i]) : NaN
    if (!Number.isNaN(lnum) && !Number.isNaN(rnum)) {
      if (lnum !== rnum) return lnum > rnum ? 1 : -1
      continue
    }
    // 数字标识符优先级低于字母标识符（semver）；这里只要一个稳定顺序
    if (!Number.isNaN(lnum)) return -1
    if (!Number.isNaN(rnum)) return 1
    if (l[i] !== r[i]) return l[i] > r[i] ? 1 : -1
  }
  return 0
}

/** 版本所在的发布通道：0.1.26-rc.1 → rc；正式版 → latest。 */
export function channelOf(version) {
  const match = /-([0-9A-Za-z]+)/.exec(String(version || ''))
  return match ? match[1] : 'latest'
}

function acceptsChannel(version, channel) {
  const pre = /-([0-9A-Za-z]+)/.exec(String(version || ''))?.[1] || ''
  if (channel === 'alpha') return true
  if (channel === 'latest') return pre === ''
  return pre === '' || pre === channel
}

function releaseOf(version, info) {
  const dist = info?.dist || {}
  return {
    version,
    tarball: String(dist.tarball || ''),
    integrity: String(dist.integrity || ''),
    shasum: String(dist.shasum || ''),
    // 发布脚本写进核心 package.json：这份核心是按哪个 Electron 版本构建/验证的
    electron: String(info?.dshX?.electron || ''),
  }
}

/** 按 dist-tag 挑当前通道的版本（npm CLI 用，跟着 DSH_CORE_CHANNEL）。 */
export function resolveLatest(metadata) {
  const channel = String(process.env.DSH_CORE_CHANNEL || 'latest').trim()
  const version = String(metadata?.['dist-tags']?.[channel] || metadata?.['dist-tags']?.latest || '')
  const info = version ? metadata?.versions?.[version] : null
  return info ? releaseOf(version, info) : null
}

/**
 * 挑一个和当前外壳的 Electron 兼容的最新版本。
 * 外壳可以很久不更新，核心会先一步按新 Electron 构建：这时 dist-tag 头部不可用，
 * 得往下找最近一个还能跑在本外壳上的版本，而不是直接报错。
 */
export function pickCoreRelease(metadata, { electron = '', channel = 'latest', skip = [] } = {}) {
  const versions = metadata?.versions || {}
  const skipped = new Set(skip.filter(Boolean))
  // dist-tag 是发布方「撤回」坏版本的开关：把 latest（或 rc）指回旧版后，首启也不能再装到比它新的版本。
  // 正式版按 latest 封顶，预发布按它自己通道的 tag 封顶；tag 不存在或指向不存在的版本（自建源）就不封顶。
  const tags = metadata?.['dist-tags'] || {}
  const ceilingOf = (version) => {
    const pre = /-([0-9A-Za-z]+)/.exec(version)?.[1] || ''
    const tag = String(tags[pre || 'latest'] || '')
    return versions[tag] ? tag : ''
  }
  const candidates = Object.keys(versions).filter((version) => {
    if (skipped.has(version)) return false
    if (versions[version]?.deprecated) return false
    const ceiling = ceilingOf(version)
    if (ceiling && compareVersions(version, ceiling) > 0) return false
    if (!acceptsChannel(version, channel)) return false
    const declared = String(versions[version]?.dshX?.electron || '')
    return !electron || !declared || declared === String(electron)
  })
  candidates.sort((a, b) => compareVersions(b, a))
  return candidates.length ? releaseOf(candidates[0], versions[candidates[0]]) : null
}

/** 解压用的 tar：Windows 上用系统自带的 bsdtar（Git 的 GNU tar 会把 C: 当远程主机）。 */
export function tarCommand() {
  if (IS_WINDOWS) {
    const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(system) ? system : 'tar'
  }
  return '/usr/bin/tar'
}

/** 在 Windows 上打的 tarball 里 POSIX 包装可能没有可执行位；解到 mac 后补上。 */
function ensurePosixShims(dest) {
  if (IS_WINDOWS) return
  for (const name of ['node', 'npm', 'npx', 'pnpm', 'pnpx']) {
    try { chmodSync(join(dest, 'node', name), 0o755) } catch { /* 没有就跳过 */ }
  }
}

/** npm tarball 里所有文件都在 package/ 下；解包时剥掉这一层。 */
export function extractCoreTarball(tarball, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const result = spawnSync(tarCommand(), ['-xzf', tarball, '-C', dest, '--strip-components=1'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`解压核心包失败：${String(result.stderr || result.status).trim()}`)
  if (!existsSync(join(dest, 'server.js')) || !existsSync(join(dest, 'package.json'))) {
    throw new Error('核心包里缺少 server.js 或 package.json')
  }
  ensurePosixShims(dest)
  return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
}

/** 下载 tarball，边下边算 sha512；有 integrity（npm 的 SRI）就按它校验。 */
export async function downloadCoreTarball(url, dest, { integrity = '', onProgress, limit = CORE_MAX_BYTES, fetchImpl } = {}) {
  if (!url) throw new Error('核心包没有下载地址')
  const res = await doFetch(fetchImpl)(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok) throw new Error(`下载核心包失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (total > limit) throw new Error(`核心包太大（${Math.round(total / 1048576)} MB，上限 ${Math.round(limit / 1048576)} MB）`)
  const hash = createHash('sha512')
  const chunks = []
  let done = 0
  for await (const chunk of res.body) {
    chunks.push(chunk)
    hash.update(chunk)
    done += chunk.length
    if (typeof onProgress === 'function') onProgress({ done, total: total || done })
  }
  const bytes = Buffer.concat(chunks)
  const expected = String(integrity || '').replace(/^sha512-/, '')
  if (expected && hash.digest('base64') !== expected) throw new Error('核心包的 sha512 校验失败')
  await writeFile(dest, bytes)
  return bytes.length
}

/**
 * 把核心装进指定目录（安装版的 core/current）。
 * 旧目录先挪到 previous：新核心起不来时外壳的 recoverCore 会把它换回来。
 */
export async function installCore({ release, target, previous = '', onProgress, onPhase, fetchImpl } = {}) {
  if (!release?.tarball) throw new Error('核心包没有下载地址')
  const tarball = `${target}.download-${process.pid}.tgz`
  const staging = `${target}.staging-${process.pid}`
  await mkdir(dirname(target), { recursive: true })
  try {
    await onPhase?.('download')
    await downloadCoreTarball(release.tarball, tarball, { integrity: release.integrity, onProgress, fetchImpl })
    // 解压用的是 spawnSync 的 tar，主进程会短暂停住；先把窗口切到「安装中」，别让进度条停在 100%。
    await onPhase?.('extract')
    const pkg = extractCoreTarball(tarball, staging)
    if (release.version && String(pkg.version) !== String(release.version)) {
      throw new Error(`核心包版本不一致：${pkg.version} != ${release.version}`)
    }
    if (existsSync(target)) {
      if (previous) {
        rmSync(previous, { recursive: true, force: true })
        mkdirSync(dirname(previous), { recursive: true })
        renameSync(target, previous)
      } else {
        rmSync(target, { recursive: true, force: true })
      }
    }
    renameSync(staging, target)
    return release.version
  } finally {
    rmSync(tarball, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

// ---- npm CLI 的缓存（安装版外壳不用这些） ----

export function cacheRoot() {
  if (process.env.DSH_NPM_CACHE) return process.env.DSH_NPM_CACHE
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'dsh-x')
  if (IS_MAC) return join(homedir(), 'Library', 'Caches', 'dsh-x')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-x')
}

export function installedCore() {
  try {
    const current = JSON.parse(readFileSync(join(cacheRoot(), 'current.json'), 'utf8'))
    const dir = join(cacheRoot(), 'core', String(current.version))
    if (existsSync(join(dir, 'server.js')) && existsSync(join(dir, 'package.json'))) {
      return { version: String(current.version), dir }
    }
  } catch { /* 没装或坏了 */ }
  return null
}

/** 确保 CLI 的缓存里有一份核心；返回 { version, dir, downloaded }。 */
export async function ensureCore({ force = false, electronVersion = '' } = {}) {
  const name = corePackageName()
  const metadata = await fetchCoreMetadata(name)
  const release = resolveLatest(metadata)
  if (!release) throw new Error(`npm 上没有 ${name} 的可用版本`)
  if (release.electron && electronVersion && release.electron !== electronVersion) {
    throw new Error(`核心包需要 Electron ${release.electron}，当前 CLI 带的是 ${electronVersion}；先 npm update -g dsh-x`)
  }
  const dir = join(cacheRoot(), 'core', release.version)
  const installed = installedCore()
  if (!force && installed?.version === release.version) return { ...installed, downloaded: false }
  const tarball = join(cacheRoot(), `.core-${release.version}-${process.pid}.tgz`)
  await mkdir(cacheRoot(), { recursive: true })
  try {
    await downloadCoreTarball(release.tarball, tarball, { integrity: release.integrity })
    const pkg = extractCoreTarball(tarball, dir)
    if (String(pkg.version) !== release.version) throw new Error(`核心包版本不一致：${pkg.version} != ${release.version}`)
  } finally {
    await rm(tarball, { force: true }).catch(() => {})
  }
  await writeFile(join(cacheRoot(), 'current.json'), `${JSON.stringify({ version: release.version }, null, 2)}\n`)
  return { version: release.version, dir, downloaded: true }
}

/** 列出 CLI 缓存里的核心版本（给 --version / 清理用）。 */
export async function cachedVersions() {
  try {
    return (await readdir(join(cacheRoot(), 'core'))).filter((name) => existsSync(join(cacheRoot(), 'core', name, 'server.js'))).sort()
  } catch {
    return []
  }
}
