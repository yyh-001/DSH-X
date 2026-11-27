// 核心的 npm 分发：查 registry 的 dist-tags → 下载 tarball → 校验 → 解压。
//
// 安装包只负责外壳和 Electron；核心作为一个 npm 包独立发版，启动器在运行时从 registry
// 取新版本，解到暂存目录后仍走 apply-update.mjs 换核心目录。
// 核心包跨平台（三套 filemanager 和 node 包装都在里面），Windows / mac / Linux 用同一个
// dsh-x-core；只有外壳/Electron 按平台分开。
// 完整性用 npm 的 dist.integrity（sha512）校验；registry 走设置里的下载源（官方/镜像）。

import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { netFetch } from './proxy.js'
import { cmpVer, parseVer, VERSION_CHANNEL } from './version.js'

/** 核心包跨平台：Windows / mac / Linux 共用同一个 dsh-x-core。 */
export const CORE_PACKAGE = String(process.env.DSH_CORE_PACKAGE || 'dsh-x-core').trim()

export const CORE_REGISTRIES = {
  official: 'https://registry.npmjs.org',
  mirror: 'https://registry.npmmirror.com',
}

/** 核心包上限：app 层约 15 MB，超过这个数八成是错误页或别的文件。 */
export const CORE_MAX_BYTES = 128 * 1024 * 1024

const CHANNEL_TAG = {
  [VERSION_CHANNEL.OFFICIAL]: 'latest',
  [VERSION_CHANNEL.RC]: 'rc',
  [VERSION_CHANNEL.ALPHA]: 'alpha',
}

/** 测试通道可以显式指定 registry；否则按下载源在官方/镜像之间选。 */
export function coreRegistry(source = 'official') {
  const override = String(process.env.DSH_CORE_REGISTRY || '').trim().replace(/\/+$/, '')
  if (override) return override
  return CORE_REGISTRIES[source] || CORE_REGISTRIES.official
}

/**
 * 显式指定了 registry（本地演练、自建源）：那上面的包不是 npm 官方签的，签名和 https 两条都不强求。
 * 默认的镜像 / 官方两条路一律校验。
 */
export function customRegistry() {
  return Boolean(String(process.env.DSH_CORE_REGISTRY || '').trim())
}

/**
 * npm 官方 registry 的签名公钥（https://registry.npmjs.org/-/npm/v1/keys，ECDSA P-256）。
 *
 * integrity 和 tarball 地址来自同一份元数据，下载源又默认是镜像：只校验 sha512 的话，
 * 镜像被攻破就能发一份哈希对得上的假核心。npm 对每个版本的 `包名@版本:integrity` 签过名，
 * 镜像原样转发却伪造不了；拿钉死的公钥验它，信任根就回到 npm 官方，跟走哪个源无关。
 * 和 shell/core-fetch.mjs 里那份保持一致（外壳与核心互不 import，只能各放一份）。
 */
export const NPM_SIGNING_KEYS = Object.freeze([
  {
    keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
  },
])
/** npm 轮换密钥后的出路：只从官方域名取新公钥，绝不问镜像。 */
const NPM_KEYS_URL = `${CORE_REGISTRIES.official}/-/npm/v1/keys`

function signedBy(release, name, keys) {
  const message = Buffer.from(`${name}@${release.version}:${release.integrity}`)
  for (const signature of Array.isArray(release.signatures) ? release.signatures : []) {
    const pinned = keys.find((item) => item.keyid === signature?.keyid)
    if (!pinned) continue
    try {
      const key = createPublicKey({ key: Buffer.from(pinned.key, 'base64'), format: 'der', type: 'spki' })
      if (verifySignature('sha256', message, key, Buffer.from(String(signature.sig || ''), 'base64'))) return true
    } catch { /* 公钥或签名格式不对就当没验过 */ }
  }
  return false
}

/**
 * 确认这个版本是 npm 官方签过的；不是就抛错。
 * 先用钉死的公钥；签名用的是没见过的 keyid（npm 换了密钥）时去官方域名取一次当前公钥再验，
 * 否则一次密钥轮换就会让核心再也更新不了。`fetchImpl` 只给测试注入。
 */
export async function verifyCoreRelease(release, { name = CORE_PACKAGE, fetchImpl = netFetch, signal } = {}) {
  if (customRegistry()) return
  if (!/^sha512-/.test(String(release?.integrity || ''))) throw new Error(`${name}@${release?.version} 的元数据里没有 sha512 校验值`)
  if (signedBy(release, name, NPM_SIGNING_KEYS)) return
  const known = new Set(NPM_SIGNING_KEYS.map((item) => item.keyid))
  const unknown = (Array.isArray(release.signatures) ? release.signatures : []).some((item) => item?.keyid && !known.has(item.keyid))
  if (unknown) {
    let fresh = []
    try {
      const res = await fetchImpl(NPM_KEYS_URL, { headers: { accept: 'application/json' }, signal: signal || AbortSignal.timeout(15_000) })
      if (res.ok) {
        fresh = ((await res.json())?.keys || []).filter((item) => item?.keyid && item?.key && (!item.expires || Date.parse(item.expires) > Date.now()))
      }
    } catch { /* 取不到就按验不过处理 */ }
    if (signedBy(release, name, fresh)) return
  }
  throw new Error(`${name}@${release?.version} 没有通过 npm 官方签名校验，已拒绝安装`)
}

export function coreMetadataUrl(registry, name = CORE_PACKAGE) {
  return `${String(registry).replace(/\/+$/, '')}/${name.startsWith('@') ? name.replace('/', '%2F') : name}`
}

export function coreDistTag(channel = VERSION_CHANNEL.OFFICIAL) {
  return CHANNEL_TAG[channel] || 'latest'
}

/**
 * 每个通道看哪几个 dist-tag：越不稳定的通道，越稳定的 tag 也照收（和 version.js 的 channelIncludes、
 * 外壳 core-fetch.mjs 的 acceptsChannel 同一口径）。只看自己那个 tag 不够——rc 发完转正以后
 * `rc` 往往停在旧的 0.1.26-rc.6，而 `latest` 已经是 0.1.27，rc 外壳就永远收不到更新；
 * mac / deb 没有外壳自更新，会一直卡在旧核心上，而首启（pickCoreRelease）早就会挑 0.1.27。
 */
const CHANNEL_REACH = {
  [VERSION_CHANNEL.OFFICIAL]: ['latest'],
  [VERSION_CHANNEL.RC]: ['rc', 'latest'],
  [VERSION_CHANNEL.ALPHA]: ['alpha', 'rc', 'latest'],
}

function releaseOf(version, info) {
  const dist = info.dist || {}
  return {
    version,
    tarball: String(dist.tarball || ''),
    integrity: String(dist.integrity || ''),
    shasum: String(dist.shasum || ''),
    // npm 官方对「包名@版本:integrity」的签名，verifyCoreRelease 用它确认元数据没被镜像改过
    signatures: Array.isArray(dist.signatures) ? dist.signatures : [],
    unpackedSize: Number(dist.unpackedSize) || 0,
    // 发布脚本写进核心 package.json：这份核心是按哪个 Electron 版本构建/验证的
    electron: String(info.dshX?.electron || ''),
  }
}

/**
 * 从 npm 元数据里挑当前通道能收的最高版本；挑不到返回 null。
 * - 候选是本通道能收的几个 dist-tag 的头部（见 CHANNEL_REACH），取最新的那个；
 *   deprecated 的跳过，和首启的 pickCoreRelease 一致。
 * - `current`：只看比它新的候选（查更新用）。
 * - `electron`：优先挑和当前外壳 Electron 兼容的（没声明 dshX.electron 也算兼容，同 pickCoreRelease）；
 *   一个兼容的都没有时仍返回最新那个，调用方据此提示「先更新外壳」，而不是装不上又不说原因。
 */
export function resolveCoreRelease(metadata, channel = VERSION_CHANNEL.OFFICIAL, { current = '', electron = '' } = {}) {
  const tags = metadata?.['dist-tags'] || {}
  const versions = metadata?.versions || {}
  const floor = current ? parseVer(current) : null
  const seen = new Set()
  const candidates = []
  for (const tag of CHANNEL_REACH[channel] || CHANNEL_REACH[VERSION_CHANNEL.OFFICIAL]) {
    const version = String(tags[tag] || '')
    const info = version ? versions[version] : null
    const parsed = info ? parseVer(version) : null
    if (!parsed || seen.has(version) || info.deprecated) continue
    seen.add(version)
    if (floor && cmpVer(parsed, floor) <= 0) continue
    candidates.push({ parsed, release: releaseOf(version, info) })
  }
  candidates.sort((a, b) => cmpVer(b.parsed, a.parsed))
  const fits = ({ release }) => !electron || !release.electron || release.electron === String(electron)
  return (candidates.find(fits) || candidates[0])?.release || null
}

export async function fetchCoreMetadata({ registry = coreRegistry(), name = CORE_PACKAGE, signal } = {}) {
  const url = coreMetadataUrl(registry, name)
  const res = await netFetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/json', 'user-agent': 'dsh-x' },
    signal,
  })
  if (!res.ok) throw new Error(`读取 ${name} 的 npm 元数据失败：HTTP ${res.status}`)
  return res.json()
}

/**
 * 查核心更新：返回 { available, current, latest, release }。
 * 传了 `electron` 时优先给兼容当前外壳的版本；只有不兼容的更新时照样返回，
 * 由调用方按 release.electron 提示更新外壳。挑法和首启的 pickCoreRelease 对齐，两条路给的版本不打架。
 */
export async function checkCoreUpdate({ current, source = 'official', channel = VERSION_CHANNEL.OFFICIAL, electron = '', signal } = {}) {
  const metadata = await fetchCoreMetadata({ registry: coreRegistry(source), signal })
  const cur = parseVer(current)
  const release = cur ? resolveCoreRelease(metadata, channel, { current, electron }) : null
  if (release) return { available: true, current, latest: release.version, release }
  // 没有更新时 latest 仍报通道里的最高版本，页面拿它显示「已是最新」
  const head = resolveCoreRelease(metadata, channel, { electron })
  return { available: false, current, latest: head?.version || '' }
}

/**
 * 一次元数据查询里看多个通道，取高于当前版本里最高的那个（「接受预览版」开关用）。
 * 只查一次 registry：三个 dist-tag 在同一份文档里，分三次查纯属浪费。
 */
export async function checkCoreUpdateAny({ current, source = 'official', channels = [], signal } = {}) {
  const metadata = await fetchCoreMetadata({ registry: coreRegistry(source), signal })
  const cur = parseVer(current)
  let best = null
  for (const channel of channels) {
    const release = resolveCoreRelease(metadata, channel)
    const next = release ? parseVer(release.version) : null
    if (!next || !cur || cmpVer(next, cur) <= 0) continue
    if (!best || cmpVer(next, parseVer(best.version)) > 0) best = release
  }
  if (!best) return { available: false, current, latest: '' }
  return { available: true, current, latest: best.version, release: best }
}

/**
 * 下载 tarball，边下边算 sha512，按 npm 的 SRI（integrity）校验。
 * 没有 sha512 就不下：以前会退回 sha1、两样都没有时干脆不校验，元数据里少一项就等于放行。
 * 地址只认 https（自己指定 registry 的演练除外）——元数据可以把 tarball 指到任何地方。
 */
export async function downloadCoreTarball(url, dest, { integrity = '', signal, onProgress, limit = CORE_MAX_BYTES } = {}) {
  if (!url) throw new Error('核心包没有下载地址')
  if (!/^sha512-.+/.test(String(integrity || ''))) throw new Error('核心包没有 sha512 校验值，已拒绝下载')
  if (!customRegistry() && !/^https:\/\//i.test(String(url))) throw new Error(`核心包的下载地址不是 https：${url}`)
  const res = await netFetch(url, { redirect: 'follow', signal })
  if (!res.ok) throw new Error(`下载核心包失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (total > limit) throw new Error(`核心包太大（${Math.round(total / 1048576)} MB，上限 ${Math.round(limit / 1048576)} MB）`)
  const hash = createHash('sha512')
  const out = createWriteStream(dest, { flags: 'w' })
  let done = 0
  const closed = new Promise((resolve, reject) => {
    out.once('close', resolve)
    out.once('error', reject)
  })
  try {
    for await (const chunk of res.body) {
      signal?.throwIfAborted()
      done += chunk.length
      if (done > limit) throw new Error('核心包太大，已停下')
      hash.update(chunk)
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          out.once('drain', resolve)
          out.once('error', reject)
        })
      }
      onProgress?.({ done, total })
    }
    out.end()
    await closed
  } catch (error) {
    out.destroy()
    await closed.catch(() => {})
    throw error
  }
  const digest = hash.digest('base64')
  if (digest !== String(integrity).replace(/^sha512-/, '')) {
    // 校验不过的文件别留在临时目录里
    rmSync(dest, { force: true })
    throw new Error('核心包的 sha512 校验失败')
  }
  return { bytes: done, sha512: digest }
}

/** 解压用的 tar：Windows 上用系统自带的 bsdtar（Git 的 GNU tar 会把 C: 当远程主机）。 */
export function tarCommand() {
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    return existsSync(system) ? system : 'tar'
  }
  if (existsSync('/usr/bin/tar')) return '/usr/bin/tar'
  if (existsSync('/bin/tar')) return '/bin/tar'
  return 'tar'
}

/** 在 Windows 上打的 tarball 里 POSIX 包装可能没有可执行位；解到 mac 后补上。 */
function ensurePosixShims(dest) {
  if (process.platform === 'win32') return
  for (const name of ['node', 'npm', 'npx', 'pnpm', 'pnpx']) {
    try { chmodSync(join(dest, 'node', name), 0o755) } catch { /* 没有就跳过 */ }
  }
}

/** npm tarball 里所有文件都在 package/ 下；解包时剥掉这一层。 */
export function extractCoreTarball(tarball, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const result = spawnSync(tarCommand(), ['-xzf', tarball, '-C', dest, '--strip-components=1'], { windowsHide: true, encoding: 'utf8' })
  if (result.error) throw new Error(`无法启动 tar 解压核心包：${result.error.message}`)
  if (result.status !== 0) throw new Error(`解压核心包失败：${String(result.stderr || result.status).trim()}`)
  if (!existsSync(join(dest, 'server.js')) || !existsSync(join(dest, 'package.json'))) {
    throw new Error('核心包里缺少 server.js 或 package.json')
  }
  ensurePosixShims(dest)
  return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
}

export function stagingExists(dir, marker = 'server.js') {
  return Boolean(dir) && existsSync(join(dir, marker))
}

export function stagingStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}
