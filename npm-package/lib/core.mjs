// dsh-x npm 版的运行核心：从 npm 拉 dsh-x-core-<平台>，解到用户缓存目录。
//
// 和桌面安装版共用同一份核心包（dsh-x-core-win / dsh-x-core-mac），但这里不碰
// resources/app，也不做 45 秒回滚——npm 版的生命周期就是：装包/更新核心 → 启动 Electron。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

export function corePackageName() {
  return process.env.DSH_CORE_PACKAGE || (IS_WINDOWS ? 'dsh-x-core-win' : IS_MAC ? 'dsh-x-core-mac' : 'dsh-x-core')
}

export function cacheRoot() {
  if (process.env.DSH_NPM_CACHE) return process.env.DSH_NPM_CACHE
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'dsh-x')
  if (IS_MAC) return join(homedir(), 'Library', 'Caches', 'dsh-x')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-x')
}

function registries() {
  const override = String(process.env.DSH_CORE_REGISTRY || '').trim().replace(/\/+$/, '')
  if (override) return [override]
  return ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
}

function metadataUrl(registry, name) {
  return `${registry}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

async function fetchMetadata(name) {
  let last = null
  for (const registry of registries()) {
    try {
      const res = await fetch(metadataUrl(registry, name), {
        headers: { accept: 'application/json', 'user-agent': 'dsh-x-npm' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (error) {
      last = error
    }
  }
  throw new Error(`读取 ${name} 的 npm 元数据失败：${last?.message || '没有可用的 registry'}`)
}

export function resolveLatest(metadata) {
  const channel = String(process.env.DSH_CORE_CHANNEL || 'latest').trim()
  const version = String(metadata?.['dist-tags']?.[channel] || metadata?.['dist-tags']?.latest || '')
  const info = version ? metadata?.versions?.[version] : null
  if (!info) return null
  const dist = info.dist || {}
  return {
    version,
    tarball: String(dist.tarball || ''),
    integrity: String(dist.integrity || ''),
    shasum: String(dist.shasum || ''),
    electron: String(info.dshX?.electron || ''),
  }
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

function tarCommand() {
  if (IS_WINDOWS) {
    const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(system) ? system : 'tar'
  }
  return '/usr/bin/tar'
}

function extract(tarball, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const result = spawnSync(tarCommand(), ['-xzf', tarball, '-C', dest, '--strip-components=1'], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`解压核心包失败：${String(result.stderr || result.status).trim()}`)
  if (!existsSync(join(dest, 'server.js')) || !existsSync(join(dest, 'package.json'))) throw new Error('核心包里缺少 server.js 或 package.json')
  return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
}

async function download(url, dest, integrity) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok) throw new Error(`下载核心包失败：HTTP ${res.status}`)
  const chunks = []
  const hash = createHash('sha512')
  for await (const chunk of res.body) {
    chunks.push(chunk)
    hash.update(chunk)
  }
  const bytes = Buffer.concat(chunks)
  const digest = hash.digest('base64')
  const expected = String(integrity || '').replace(/^sha512-/, '')
  if (expected && digest !== expected) throw new Error('核心包的 sha512 校验失败')
  await writeFile(dest, bytes)
  return bytes.length
}

/** 确保缓存里有一份核心；返回 { version, dir, downloaded }。 */
export async function ensureCore({ force = false, electronVersion = '' } = {}) {
  const name = corePackageName()
  const metadata = await fetchMetadata(name)
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
    await download(release.tarball, tarball, release.integrity)
    const pkg = extract(tarball, dir)
    if (String(pkg.version) !== release.version) throw new Error(`核心包版本不一致：${pkg.version} != ${release.version}`)
  } finally {
    await rm(tarball, { force: true }).catch(() => {})
  }
  await writeFile(join(cacheRoot(), 'current.json'), `${JSON.stringify({ version: release.version }, null, 2)}\n`)
  return { version: release.version, dir, downloaded: true }
}

/** 列出缓存里的核心版本（给 --version / 清理用）。 */
export async function cachedVersions() {
  try {
    return (await readdir(join(cacheRoot(), 'core'))).filter((name) => existsSync(join(cacheRoot(), 'core', name, 'server.js'))).sort()
  } catch {
    return []
  }
}
