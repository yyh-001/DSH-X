/**
 * 整合包：把一批插件 + 一套配置一次装进一个 profile。
 *
 * 格式用的是生态里的既成事实标准 DSH-PackForge（`.dspack` = ZIP，根目录 `dspack.json`
 * 标记格式、`manifest.json` 描述组成，manifest v5），另外宽容地接受同一族的旧版本和
 * 目录形态（作者本地调试时就是一堆文件）。装出来的东西必须是 dsh 原生认得的：
 * profile 的 `package.json`（dependencies + dsh.profile.bundles）+ 补丁层 + overrides 文件，
 * 装完交给 `dsh plugin install` 把依赖装齐——也就是插件页装单个插件走的那条路。
 *
 * 三条安全线：
 * - 包里的相对路径必须落在目标目录内（`..`、绝对路径、Windows 设备名一律拒收）；
 * - 敏感文件（.env / 私钥 / 凭据 / settings.yaml / .npmrc）不落盘，只报告；
 * - 每次安装前备份被覆盖的文件，失败就回滚，卸载也靠这份备份还原。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative, sep } from 'node:path'

import { readZip, writeZip } from './zip.js'

export const PACK_SUFFIX = '.dspack'
export const PACK_FORMAT = { format: 'dspack', version: 3 }
/** 认得的清单版本：v5 是现行，旧的照字段尽力读，更新的直接拒（宁可说不认识）。 */
export const MANIFEST_VERSIONS = [5, 4, 3, 2, 1]
/** 包体积上限：整合包只装清单与配置，几 MB 就够了，几十 MB 的多半是塞了别的东西。 */
export const MAX_PACK_BYTES = 32 * 1024 * 1024
export const MAX_PACK_ENTRIES = 4000
/** 打包时的默认市场索引（PackForge 的公开索引，采集的是打了 dsh-pack topic 的仓库）。 */
export const MARKET_INDEX_URL = 'https://raw.githubusercontent.com/DSH-PackForge/dsh-pack-market/main/index/index.json'

/** dsh 自带的 profile 模板：新建 profile 时用它当骨架，整合包再往上面加。 */
export const PROFILE_SKELETON_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** home 根下允许整合包写入的位置（其余一律跳过：settings.yaml、sessions、凭据都在那边）。 */
const HOME_ALLOWED = ['skills/', '.agent-presets/', 'presets/', 'AGENTS.md', 'cordis.patch.yml']

/**
 * 不理会的文件：凭据与密钥不该跟着整合包走，`.npmrc` 会改 registry（等于把包源换掉），
 * settings.yaml 是整机设置、不属于某个整合包。
 */
const BLOCKED_RE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)settings\.ya?ml$/i,
  /(^|\/)credentials[^/]*$/i,
  /(^|\/)[^/]*\.(?:key|pem|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /(^|\/)\.netrc$/i,
]

/** 打包时漏出来的东西：不该进包，也不该落盘。 */
const JUNK_RE = [
  [/(^|\/)\.git(?:\/|$)/, '版本库元数据'],
  [/(^|\/)node_modules(?:\/|$)/, '依赖目录（装的时候会重新装）'],
  [/(^|\/)pnpm-lock\.ya?ml$/, '锁文件（和本机已有插件对不上，会顶掉别人的安装）'],
  [/(^|\/)\.dshpkcfg$/, '导出工具的参数文件'],
]

/** Windows 上这些名字永远不是普通文件（老工具写出来的包可能带）。 */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/**
 * 把包里的条目名归一成安全的相对路径，不安全就返回空串。
 * 归一后的分隔符固定是 `/`（ZIP 规范如此），Windows 老工具写的反斜杠也照收。
 */
export function safeRelPath(name) {
  const raw = String(name ?? '').replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return ''
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (!segments.length) return ''
  for (const segment of segments) {
    if (segment === '..') return ''
    if (WINDOWS_RESERVED.test(segment)) return ''
    if (/[\0-\x1f]/.test(segment)) return ''
    // Windows 会把结尾的点和空格吃掉，写出来的文件和包里的名字对不上
    if (/[ .]$/.test(segment)) return ''
    if (segment.length > 120) return ''
  }
  return posix.join(...segments)
}

/** 这个路径要不要跳过；返回原因，不用跳过就是空串。 */
export function blockedReason(relPath) {
  const value = String(relPath ?? '')
  for (const pattern of BLOCKED_RE) {
    if (pattern.test(value)) return '敏感文件，整合包不带它走'
  }
  for (const [pattern, reason] of JUNK_RE) {
    if (pattern.test(value)) return reason
  }
  return ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 清单里的 displayName / description 既可能是字符串，也可能是 { 'zh-CN': …, 'en-US': … }。 */
export function localized(value, lang = 'zh') {
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) return ''
    const order = lang === 'en' ? ['en-US', 'en', 'zh-CN', 'zh'] : ['zh-CN', 'zh', 'en-US', 'en']
    for (const key of order) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    const first = keys.find((key) => typeof value[key] === 'string' && value[key].trim())
    return first ? value[first].trim() : ''
  }
  return normalizeText(value)
}

/** 包名 → profile 名：只留目录安全字符（dsh 的 profile 名限制比这更严，调用方再兜一层）。 */
export function slugName(value, fallback = 'pack') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 32)
  return slug || fallback
}

/**
 * 生态里的依赖坐标翻译成 pnpm 认的「别名 → spec」。
 *
 * PackForge 清单里 git 依赖写成「坐标 → 版本」，例如
 * `"github:swaylq/dsh-wildmon": "a2c7df0…"`。这一对不能直接塞进 profile 的
 * package.json：pnpm 会拿 `github:swaylq/dsh-wildmon` 当包名去建目录。
 * 别名优先取层栈里已经用的那个名字（整合包自己声明了它叫什么），否则退回购名。
 */
export function installSpecs(bundles, dependencies) {
  const warnings = []
  const aliases = {}
  const byBasename = new Map()
  for (const name of bundles) {
    const base = String(name).split('/').pop().toLowerCase()
    if (base) byBasename.set(base, name)
  }
  const specs = {}
  for (const [key, version] of Object.entries(dependencies)) {
    const coordinate = /^(github|gitlab|bitbucket):(?:\/\/)?([^#\s]+?)(?:#(\S+))?$/.exec(key)
    if (coordinate) {
      const [, host, repo, hash] = coordinate
      const ref = hash || (version && version !== 'latest' ? version : '')
      const base = repo.split('/').pop()
      const alias = byBasename.get(base.toLowerCase()) || base
      specs[alias] = `${host}:${repo}${ref ? `#${ref}` : ''}`
      aliases[key] = { name: alias, spec: specs[alias] }
      continue
    }
    if (/^(?:git\+|https?:|file:|link:|workspace:|portal:)/.test(key)) {
      // 少见形状：坐标整条写在键上。别猜它的包名，原样传下去，让 pnpm 自己说报什么
      specs[key] = String(version)
      warnings.push(`依赖 ${key} 是协议型坐标，原样交给 pnpm（认不出来会装失败）`)
      continue
    }
    specs[key] = String(version)
  }
  return { specs, aliases, warnings }
}

/**
 * 解析清单：返回 `{ ok, errors, warnings, manifest, … }`。
 *
 * 未知字段只警告不拒绝——生态里已经有实现往清单里塞私有键（EAC 的 `x-eac` 就是），
 * 见到不认识的东西就整包拒收，等于把现在能用的包全挡在外面。
 */
export function parseManifest(input, { file = 'manifest.json' } = {}) {
  const errors = []
  const warnings = []
  let manifest = input
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    try {
      manifest = JSON.parse(input.toString('utf8'))
    } catch (error) {
      return { ok: false, errors: [`${file} 不是合法 JSON：${error.message}`], warnings, manifest: null }
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [`${file} 应该是一个 JSON 对象`], warnings, manifest: null }
  }
  const version = Number(manifest.manifestVersion)
  if (!Number.isFinite(version)) {
    errors.push(`${file} 里没有 manifestVersion，认不出是哪个版本的整合包清单`)
  } else if (!MANIFEST_VERSIONS.includes(version)) {
    errors.push(`清单版本 ${version} 比这个启动器认识的（最高 ${MANIFEST_VERSIONS[0]}）更新，请先升级启动器`)
  } else if (version < MANIFEST_VERSIONS[0]) {
    warnings.push(`清单是 v${version} 的旧格式，按现行字段尽力读取`)
  }
  const name = normalizeText(manifest.name)
  if (!name) errors.push(`${file} 里没有 name`)
  const type = normalizeText(manifest.type) || 'profile'
  if (type === 'collection') errors.push('整合包清单里的 collection 形态已被上游废弃，装不了')
  else if (type !== 'profile' && type !== 'dshhome') errors.push(`不认识的整合包形态：${type}`)

  const dependencies = {}
  if (manifest.dependencies !== undefined) {
    if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      errors.push('dependencies 应该是一个「包名 → 版本」的对象')
    } else {
      for (const [dep, spec] of Object.entries(manifest.dependencies)) {
        if (!normalizeText(dep)) continue
        if (typeof spec !== 'string' || !spec.trim()) {
          warnings.push(`依赖 ${dep} 没有版本，跳过`)
          continue
        }
        dependencies[dep] = spec.trim()
      }
    }
  }
  const bundles = []
  if (manifest.bundles !== undefined) {
    if (!Array.isArray(manifest.bundles)) errors.push('bundles 应该是一个数组')
    else {
      for (const item of manifest.bundles) {
        const value = normalizeText(item)
        if (!value) continue
        if (!bundles.includes(value)) bundles.push(value)
        else warnings.push(`bundles 里的 ${value} 重复了，已去重`)
      }
    }
  }
  if (type === 'profile' && !bundles.length) {
    warnings.push('清单没写 bundles（层栈），装完的插件不会被 dsh 加载；以本地 package.json 快照为准')
  }
  const known = new Set([
    'manifestVersion', 'type', 'name', 'version', 'displayName', 'description', 'author', 'license',
    'icon', 'homepage', 'category', 'dshVersion', 'profileName', 'bundles', 'dependencies', 'patch',
    'files', 'presets', 'skills', 'instructions', 'defaultProfile', 'profiles', 'conflicts', 'overrides',
    'changelog', 'keywords', 'createdAt', 'updatedAt',
  ])
  const extra = Object.keys(manifest).filter((key) => !known.has(key))
  if (extra.length) warnings.push(`清单里有本启动器不处理的字段：${extra.join('、')}（忽略）`)
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    fields: {
      name,
      version: normalizeText(manifest.version) || '0.0.0',
      type,
      dshVersion: normalizeText(manifest.dshVersion),
      profileName: normalizeText(manifest.profileName),
      bundles,
      dependencies,
      conflicts: Array.isArray(manifest.conflicts) ? manifest.conflicts.map(normalizeText).filter(Boolean) : [],
    },
  }
}

/** 从一堆 `路径 → 内容` 里把整合包的各个部分挑出来（包与目录两条路共用）。 */
function classify(entries) {
  const files = new Map()
  const overrides = []
  const home = []
  const skipped = []
  const profiles = new Map()
  const snapshots = { package: null, workspace: null, lock: null }
  const patchCandidates = []
  const problems = []

  for (const entry of entries) {
    const original = String(entry.name ?? '')
    if (original.endsWith('/')) continue
    const rel = safeRelPath(original)
    if (!rel) {
      problems.push(`包里的路径不安全，整包拒收：${original}`)
      continue
    }
    const data = entry.data
    files.set(rel, data)

    // 目录形态的包会带自己的定义文件，装的时候用不上
    if (rel === 'dspack.json' || rel === 'manifest.json' || rel === 'README.md' || rel === 'icon.png') continue
    if (rel === 'package.json') { snapshots.package = data; continue }
    if (rel === 'pnpm-workspace.yaml') { snapshots.workspace = data; continue }
    if (rel === 'pnpm-lock.yaml') { snapshots.lock = data; continue }
    if (rel === 'cordis.patch.yml') { patchCandidates.push({ path: rel, data }); continue }
    if (rel.startsWith('patch/')) { if (rel.endsWith('cordis.patch.yml')) patchCandidates.push({ path: rel, data }); continue }
    if (rel.startsWith('overrides/')) {
      const inner = rel.slice('overrides/'.length)
      if (!inner) continue
      // 补丁层在 overrides 下是约定位置（PackForge：文件优先于清单里的 patch 字段）
      if (inner === 'cordis.patch.yml') { patchCandidates.push({ path: rel, data }); continue }
      const reason = blockedReason(inner)
      if (reason) skipped.push({ path: rel, reason })
      else overrides.push({ path: inner, source: rel, size: data.length })
      continue
    }
    if (rel.startsWith('home/')) {
      const inner = rel.slice('home/'.length)
      if (!inner) continue
      const reason = blockedReason(inner) || (HOME_ALLOWED.some((prefix) => inner === prefix || inner.startsWith(prefix)) ? '' : '不在允许写入的范围内（只收 skills/、.agent-presets/、presets/、AGENTS.md、cordis.patch.yml）')
      if (reason) skipped.push({ path: rel, reason })
      else home.push({ path: inner, source: rel, size: data.length })
      continue
    }
    const profileMatch = /^profiles\/([^/]+)\/(.+)$/.exec(rel)
    if (profileMatch) {
      const [, profile, inner] = profileMatch
      if (!safeRelPath(inner) || !/^[A-Za-z0-9._-]{1,32}$/.test(profile)) {
        skipped.push({ path: rel, reason: 'profile 名或内部路径不合法' })
        continue
      }
      if (!profiles.has(profile)) profiles.set(profile, new Map())
      profiles.get(profile).set(inner, data)
      continue
    }
    skipped.push({ path: rel, reason: '不属于整合包的任何一部分（只认 overrides/、home/、profiles/ 与几个根文件）' })
  }
  return { files, overrides, home, skipped, profiles, snapshots, patchCandidates, problems }
}

/**
 * 解析一个 `.dspack`（或任何 ZIP）归档。
 * @param {Buffer} buffer 归档内容
 */
export function parsePackArchive(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (!buffer.length) throw new Error('整合包是空的')
  if (buffer.length > MAX_PACK_BYTES) throw new Error(`整合包太大了（${Math.round(buffer.length / 1048576)} MB，上限 ${MAX_PACK_BYTES / 1048576} MB）`)
  const { entries } = readZip(buffer)
  if (entries.length > MAX_PACK_ENTRIES) throw new Error(`整合包里的文件太多（${entries.length} 个，上限 ${MAX_PACK_ENTRIES}）`)
  const dspackEntry = entries.find((entry) => entry.name === 'dspack.json')
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new Error('这不是整合包：里面没有 manifest.json')
  const parsed = parseManifest(manifestEntry.data, { file: 'manifest.json' })
  const marker = (() => {
    if (!dspackEntry) return { ok: false, reason: '没有 dspack.json 标记（可能是别的 ZIP）' }
    try {
      const value = JSON.parse(dspackEntry.data.toString('utf8'))
      if (value?.format !== 'dspack') return { ok: false, reason: `dspack.json 里的 format 不是 dspack（是 ${value?.format}）` }
      if (Number(value?.version) > PACK_FORMAT.version) return { ok: false, reason: `包格式版本 ${value.version} 比启动器认识的新` }
      return { ok: true, value }
    } catch {
      return { ok: false, reason: 'dspack.json 不是合法 JSON' }
    }
  })()
  if (!marker.ok) parsed.warnings.push(`${marker.reason}，按 manifest.json 尝试读取`)
  const parts = classify(entries)
  return finishPack(parsed, parts, { bytes: buffer.length, formatVersion: marker.value?.version || 0 })
}

/** 解析一个目录形态的整合包（作者本地调试用；不递归进 node_modules）。 */
export function parsePackDir(dir) {
  const entries = []
  const walk = (current, depth) => {
    if (depth > 8) return
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === '.git') continue
      const full = join(current, item.name)
      if (item.isDirectory()) { walk(full, depth + 1); continue }
      if (!item.isFile()) continue
      const rel = relative(dir, full).split(sep).join('/')
      entries.push({ name: rel, data: readFileSync(full) })
    }
  }
  walk(dir, 0)
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error('这个目录里没有 manifest.json，不是整合包')
  const parsed = parseManifest(readFileSync(manifestFile, 'utf8'))
  const dspackFile = join(dir, 'dspack.json')
  if (!existsSync(dspackFile)) parsed.warnings.push('目录里没有 dspack.json 标记，按 manifest.json 读取')
  const parts = classify(entries)
  const bytes = entries.reduce((total, entry) => total + entry.data.length, 0)
  return finishPack(parsed, parts, { bytes, formatVersion: PACK_FORMAT.version })
}

function finishPack(parsed, parts, meta) {
  const errors = [...parsed.errors, ...parts.problems]
  const warnings = [...parsed.warnings]
  if (!parts.snapshots.package) warnings.push('包里没有 package.json 快照，完全按清单里的依赖与层栈重建')
  if (parts.snapshots.lock) warnings.push('包里有 pnpm-lock.yaml，安装时忽略它（本机 profile 里可能已有别的插件，旧锁文件会让安装硬失败）')
  if (!parts.patchCandidates.length && !parsed.manifest?.patch) warnings.push('包里没有补丁层，装完只用默认配置')
  const patch = parts.patchCandidates[0]
    ? { source: parts.patchCandidates[0].path, text: parts.patchCandidates[0].data.toString('utf8') }
    : (typeof parsed.manifest?.patch === 'string' && parsed.manifest.patch.trim()
      ? { source: 'manifest.json 里的 patch 字段', text: parsed.manifest.patch }
      : null)
  if (parts.patchCandidates.length > 1) {
    warnings.push(`包里有 ${parts.patchCandidates.length} 份补丁层，只用 ${parts.patchCandidates[0].path} 那份`)
  }
  const fields = parsed.fields || {}
  const { specs, aliases, warnings: specWarnings } = installSpecs(fields.bundles, fields.dependencies)
  warnings.push(...specWarnings)
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest: parsed.manifest,
    fields,
    installSpecs: specs,
    installAliases: aliases,
    displayName: localized(parsed.manifest?.displayName, 'zh') || fields.name || '',
    description: localized(parsed.manifest?.description, 'zh'),
    author: normalizeText(parsed.manifest?.author),
    icon: normalizeText(parsed.manifest?.icon),
    patch,
    overrides: parts.overrides,
    home: parts.home,
    skipped: parts.skipped,
    profiles: parts.profiles,
    snapshots: parts.snapshots,
    files: parts.files,
    bytes: meta.bytes,
    formatVersion: meta.formatVersion,
  }
}

/** 整合包的组成清单：页面上的「装什么」就是它。 */
export function packSummary(pack, { lang = 'zh' } = {}) {
  const fields = pack.fields
  const bundles = fields.bundles.slice()
  const dependencies = Object.entries(fields.dependencies).map(([name, spec]) => {
    const alias = pack.installAliases?.[name]
    return {
      name,
      spec,
      // 坐标型的依赖（github:owner/repo + 版本）会换成别名 + pnpm spec 再写进 profile
      installAs: alias && alias.name !== name ? alias : null,
      bundle: bundles.includes(name) || (alias ? bundles.includes(alias.name) : false),
    }
  })
  const profileNames = pack.profiles.size ? [...pack.profiles.keys()] : []
  return {
    manifestVersion: Number(pack.manifest?.manifestVersion) || 0,
    name: fields.name,
    version: fields.version,
    type: fields.type,
    displayName: pack.displayName,
    description: pack.description,
    author: pack.author,
    icon: pack.icon,
    dshVersion: fields.dshVersion,
    profileName: fields.profileName,
    defaultProfile: normalizeText(pack.manifest?.defaultProfile),
    bundles: bundles.map((name) => ({ name, dependency: Boolean(fields.dependencies[name]) })),
    dependencies,
    profiles: profileNames,
    conflicts: fields.conflicts,
    patch: pack.patch ? { source: pack.patch.source, lines: pack.patch.text.split(/\r?\n/).length } : null,
    overrides: pack.overrides.map((item) => ({ path: item.path, size: item.size })),
    home: pack.home.map((item) => ({ path: item.path, size: item.size })),
    skipped: pack.skipped.map((item) => ({ path: item.path, reason: item.reason })),
    snapshots: { package: Boolean(pack.snapshots.package), workspace: Boolean(pack.snapshots.workspace), lock: Boolean(pack.snapshots.lock) },
    warnings: pack.warnings,
    errors: pack.errors,
    ok: pack.ok,
    bytes: pack.bytes,
    lang,
  }
}

/** 目标 profile 名：清单里的 profileName > defaultProfile > 包名（都过一遍目录安全字符）。 */
export function defaultProfileFor(pack) {
  return slugName(pack.fields.profileName || pack.manifest?.defaultProfile || pack.fields.name)
}

/** profile 的 package.json 骨架（新建 profile 时用，和 dsh 模板同形）。 */
export function profileSkeleton(profile) {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: PROFILE_SKELETON_BUNDLES.slice(), patchReload: 'live' } },
  }
}

const WORKSPACE_TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/**
 * 生成安装计划：要写哪些文件、内容是什么、会覆盖什么。
 *
 * 计划是纯函数产物（除了读现有 package.json），安装与回滚都照着它走——这样页面能先把
 * 「将发生什么」摆给用户看，也方便单测。
 */
export function planInstall(pack, { home, profile, hostProfile = '' }) {
  const notes = []
  const warnings = pack.warnings.slice()
  const errors = pack.errors.slice()
  const fields = pack.fields
  const profileDir = join(home, 'profiles', profile)
  const existed = existsSync(join(profileDir, 'package.json'))
  const writes = []

  if (fields.type === 'dshhome') {
    warnings.push('这是整机快照形态（dshhome）：只安装它声明的 profile 与允许的用户级文件，其余内容跳过')
    const declared = pack.manifest?.profiles && typeof pack.manifest.profiles === 'object' && !Array.isArray(pack.manifest.profiles)
      ? Object.entries(pack.manifest.profiles)
      : []
    const names = declared.length ? declared.map(([name]) => name) : [...pack.profiles.keys()]
    if (!names.length) errors.push('dshhome 整合包里没有可安装的 profile')
    const seen = new Set()
    for (const name of names) {
      const target = slugName(name)
      if (seen.has(target)) continue
      seen.add(target)
      const spec = declared.length ? declared.find(([key]) => key === name)?.[1] : null
      const bundles = Array.isArray(spec?.bundles) && spec.bundles.length ? spec.bundles.map(String) : []
      const dependencies = spec?.dependencies && typeof spec.dependencies === 'object' ? spec.dependencies : {}
      if (!bundles.length && !Object.keys(dependencies).length) {
        warnings.push(`dshhome 里的 profile ${name} 没有声明组成，跳过`)
        continue
      }
      writes.push(...profileWrites({ home, profile: target, bundles, specs: installSpecs(bundles, dependencies).specs, patch: null, overrides: [], notes, warnings, hostProfile }))
      // 该 profile 自己带的补丁层：包里的 profiles/<名字>/cordis.patch.yml
      const own = pack.profiles.get(name)?.get('cordis.patch.yml')
      if (own) {
        writes.push({ rel: posix.join('profiles', target, 'cordis.patch.yml'), kind: 'patch', data: own, note: `profile ${target} 的补丁层` })
      }
    }
  } else {
    if (!profile) {
      errors.push('没有目标 profile 名')
      return { ok: false, errors, warnings, notes, writes, profile: '', profileDir, existed, createsProfile: false }
    }
    writes.push(...profileWrites({
      home,
      profile,
      bundles: fields.bundles,
      specs: pack.installSpecs || fields.dependencies,
      patch: pack.patch,
      overrides: pack.overrides,
      notes,
      warnings,
      existed,
      hostProfile,
    }))
  }

  for (const item of pack.home) {
    writes.push({ rel: item.path, kind: 'home', data: pack.files.get(`home/${item.path}`), note: '用户级文件' })
  }
  const createsProfile = !existed
  notes.push({ kind: createsProfile ? 'create-profile' : 'existing-profile', profile })
  return { ok: errors.length === 0, errors, warnings, notes, writes, profile, profileDir, existed, createsProfile }
}

/** 一个 profile 要写的那几样：清单、补丁层、overrides 文件。 */
function profileWrites({ home, profile, bundles, specs, patch, overrides, notes, warnings, hostProfile = '' }) {
  const relProfile = posix.join('profiles', profile)
  const manifestPath = join(home, relProfile, 'package.json')
  let manifest = {}
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`profile「${profile}」的 package.json 读不动（${error.message}），先修好它再装整合包`)
    }
  } else {
    manifest = profileSkeleton(profile)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = profileSkeleton(profile)
  const beforeDeps = { ...(manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}) }
  const beforeBundles = (() => {
    const list = manifest?.dsh?.profile?.bundles
    return Array.isArray(list) ? list.map(String) : []
  })()
  const nextBundles = beforeBundles.slice()
  const addedBundles = []
  for (const name of bundles) {
    if (nextBundles.includes(name)) continue
    nextBundles.push(name)
    addedBundles.push(name)
  }
  const replaced = []
  for (const [name, spec] of Object.entries(specs)) {
    if (beforeDeps[name] !== undefined && beforeDeps[name] !== spec) replaced.push({ name, from: beforeDeps[name], to: spec })
  }
  const next = {
    ...manifest,
    name: manifest.name || `dsh-profile-${profile}`,
    private: true,
    dependencies: { ...beforeDeps, ...specs },
    dsh: {
      ...(manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}),
      profile: {
        ...(manifest?.dsh?.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}),
        bundles: nextBundles,
      },
    },
  }
  const writes = [{ rel: posix.join(relProfile, 'package.json'), kind: 'manifest', data: `${JSON.stringify(next, null, 2)}\n`, note: `+${addedBundles.length} 层，${Object.keys(specs).length} 个依赖` }]
  if (!existsSync(join(home, relProfile, 'pnpm-workspace.yaml'))) {
    writes.push({ rel: posix.join(relProfile, 'pnpm-workspace.yaml'), kind: 'workspace', data: WORKSPACE_TEMPLATE, note: '新 profile 的工作区模板（不自动装 peer）' })
  }
  if (!existsSync(join(home, relProfile, 'cordis.yml'))) {
    writes.push({ rel: posix.join(relProfile, 'cordis.yml'), kind: 'root', data: '# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml.\n[]\n', note: '空条目根' })
  }
  if (patch?.text) {
    writes.push({ rel: posix.join(relProfile, 'cordis.patch.yml'), kind: 'patch', data: patch.text, note: `补丁层（${patch.source}）`, overwrite: true })
  }
  for (const item of overrides) {
    writes.push({ rel: posix.join(relProfile, item.path), kind: 'override', source: `overrides/${item.path}`, note: '覆盖文件' })
  }
  if (hostProfile && hostProfile === profile) {
    warnings.push(`装的正是 dsh 当前在用的 profile「${profile}」：装完要重启 dsh 才生效`)
  }
  if (replaced.length) notes.push({ kind: 'replaced-deps', count: replaced.length, sample: replaced.slice(0, 6) })
  if (addedBundles.length) notes.push({ kind: 'added-bundles', bundles: addedBundles })
  return writes
}

/** 备份目录名：时间戳 + 包名，一眼能看出是哪次安装留下的。 */
export function backupDirFor(dataDir, name, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return join(dataDir, 'packs', 'backups', `${stamp}-${slugName(name)}`)
}

function copyInto(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, from)
}

/**
 * 执行安装计划：备份 → 写文件 → 装依赖（由调用方注入）→ 失败回滚。
 *
 * `runInstall(profile)` 是 `dsh plugin install` 那条路（server.js 注入，带 junction 退路），
 * 回滚只撤文件，不动 node_modules——写坏的清单已经还原，用户重跑一次安装就好。
 */
export async function applyInstall(plan, {
  home,
  dataDir,
  pack,
  source = '',
  now = new Date(),
  runInstall,
  log = () => {},
}) {
  const backupDir = backupDirFor(dataDir, plan.profile || pack.fields.name, now)
  const filesDir = join(backupDir, 'files')
  const records = []
  // 备份目录先建出来：新建 profile 时一个文件都不必备份，但记录里指向的目录得真的在
  mkdirSync(filesDir, { recursive: true })
  log(`备份目录：${backupDir}`)
  try {
    for (const write of plan.writes) {
      const target = join(home, write.rel)
      const existed = existsSync(target)
      let previous = null
      if (existed) {
        previous = readFileSync(target)
        copyInto(previous, join(filesDir, write.rel))
      }
      const data = write.data !== undefined
        ? write.data
        : write.source
          ? pack.files.get(write.source)
          : null
      if (data === undefined || data === null) throw new Error(`安装计划里的 ${write.rel} 没有内容`)
      copyInto(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'), target)
      records.push({ rel: write.rel, existed, kind: write.kind || '', note: write.note || '' })
      log(`${existed ? '覆盖' : '新建'} ${write.rel}${write.note ? `（${write.note}）` : ''}`)
    }
    if (typeof runInstall === 'function') {
      log(`安装依赖（dsh plugin install，profile ${plan.profile}）…`)
      await runInstall(plan.profile)
      log('依赖安装完成')
    }
    const record = {
      id: `${pack.fields.name}@${pack.fields.version}`,
      name: pack.fields.name,
      displayName: pack.displayName,
      version: pack.fields.version,
      type: pack.fields.type,
      profile: plan.profile,
      source,
      installedAt: now.toISOString(),
      createdProfile: plan.createsProfile === true,
      backupDir,
      files: records,
      bundles: pack.fields.bundles,
      dependencies: pack.fields.dependencies,
      specs: pack.installSpecs || {},
      dshVersion: pack.fields.dshVersion,
      manifestVersion: Number(pack.manifest?.manifestVersion) || 0,
    }
    return { ok: true, record, backupDir, log: records.map((item) => `${item.existed ? '覆盖' : '新建'} ${item.rel}`) }
  } catch (error) {
    const rolledBack = rollbackFiles({ files: records, backupDir }, home, log)
    const failure = error instanceof Error ? error : new Error(String(error))
    failure.rolledBack = rolledBack
    failure.message = `${failure.message}（已回滚${rolledBack ? '' : '，但有文件没能还原，备份在 ' + backupDir}）`
    throw failure
  }
}

/** 按安装记录还原文件：原来有的从备份拷回，原来没有的删掉。 */
export function rollbackFiles(record, home, log = () => {}) {
  let ok = true
  for (const item of [...record.files].reverse()) {
    const target = join(home, item.rel)
    try {
      if (item.existed) copyInto(readFileSync(join(record.backupDir, 'files', item.rel)), target)
      else if (existsSync(target)) rmSync(target, { force: true })
      log(`还原 ${item.rel}`)
    } catch (error) {
      ok = false
      log(`还原 ${item.rel} 失败：${error.message}`)
    }
  }
  return ok
}

/** 卸载：把安装时备份的文件还原回去。 */
export function uninstallPack(record, { home, log = () => {} }) {
  const ok = rollbackFiles(record, home, log)
  return { ok, restored: record.files.length }
}

/** 已装的整合包清单（存在启动器数据目录里，和 dsh 自己无关）。 */
export function readPackState(dataDir) {
  const file = join(dataDir, 'packs', 'installed.json')
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    const packs = Array.isArray(value?.packs) ? value.packs : []
    return { packs: packs.filter((item) => item && typeof item === 'object' && item.profile) }
  } catch {
    return { packs: [] }
  }
}

export function writePackState(dataDir, state) {
  const file = join(dataDir, 'packs', 'installed.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ packs: state.packs || [] }, null, 2)}\n`)
  return file
}

/** 把一次安装记进清单（同一个包同一 profile 只留最新一条）。 */
export function rememberPack(dataDir, record) {
  const state = readPackState(dataDir)
  const packs = state.packs.filter((item) => !(item.name === record.name && item.profile === record.profile))
  packs.push(record)
  writePackState(dataDir, { packs })
  return packs
}

export function forgetPack(dataDir, name, profile) {
  const state = readPackState(dataDir)
  const packs = state.packs.filter((item) => !(item.name === name && item.profile === profile))
  writePackState(dataDir, { packs })
  return packs
}

// ---- 导出：把当前 profile 打包成 .dspack ----

/** 导出时的钉版：范围（^1.2.3）读 node_modules 里的实测版本，其它坐标原样带。 */
function pinSpec(profileDir, name, spec) {
  const value = String(spec ?? '').trim()
  if (!value) return ''
  if (!/^[\^~]|^\d/.test(value)) return value
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    const installed = String(manifest.version || '').trim()
    if (installed) return installed
  } catch {
    // 没装成或读不到：原样带上，别编一个版本出来
  }
  return value
}

const EXPORT_BLOCKED = /(^|\/)(?:node_modules|\.git|sessions|attachments|storages|memory|data)(?:\/|$)/i

function collectHomeFiles(home) {
  const files = []
  for (const prefix of ['skills', '.agent-presets', 'presets']) {
    const root = join(home, prefix)
    const walk = (dir, depth) => {
      if (depth > 6) return
      let items = []
      try {
        items = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = join(dir, item.name)
        const rel = relative(home, full).split(sep).join('/')
        if (EXPORT_BLOCKED.test(rel) || blockedReason(rel)) continue
        if (item.isDirectory()) { walk(full, depth + 1); continue }
        if (!item.isFile()) continue
        try {
          if (statSync(full).size > 4 * 1024 * 1024) continue
          files.push({ path: rel, data: readFileSync(full) })
        } catch {
          // 读不动的单个文件就跳过
        }
      }
    }
    walk(root, 0)
  }
  const agentsFile = join(home, 'AGENTS.md')
  if (existsSync(agentsFile)) {
    try {
      files.push({ path: 'AGENTS.md', data: readFileSync(agentsFile) })
    } catch { /* 读不到就算了 */ }
  }
  return files
}

/**
 * 把当前 profile 打包成 `.dspack`。
 *
 * 只带「组成」不带「数据」：清单（钉版依赖 + 层栈）、补丁层、以及作者额外放进 profile 根
 * 的文件（overrides/ 的语义就是文件级替换）。node_modules、会话、附件、凭据一律不进包。
 */
export function exportPack({
  profileDir,
  home,
  name,
  version = '1.0.0',
  displayName = '',
  description = '',
  author = '',
  includeHome = false,
  now = new Date(),
}) {
  const manifestFile = join(profileDir, 'package.json')
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    throw new Error('这个 profile 里没有可读的 package.json，没有可导出的东西')
  }
  const dependencies = {}
  for (const [dep, spec] of Object.entries(manifest?.dependencies ?? {})) {
    const pinned = pinSpec(profileDir, dep, spec)
    if (pinned) dependencies[dep] = pinned
  }
  const declared = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.map(String) : []
  const bundles = declared.length ? declared : Object.keys(dependencies)
  const profile = basename(profileDir)
  const packName = slugName(name || profile)
  const entries = [
    { name: 'dspack.json', data: `${JSON.stringify(PACK_FORMAT, null, 2)}\n` },
    {
      name: 'manifest.json',
      data: `${JSON.stringify({
        manifestVersion: MANIFEST_VERSIONS[0],
        type: 'profile',
        name: packName,
        version,
        displayName: displayName || packName,
        description: description || `从 DSH-X 导出：${profile} profile 的插件与配置`,
        ...(author ? { author } : {}),
        profileName: profile,
        bundles,
        dependencies,
      }, null, 2)}\n`,
    },
  ]
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    if (text.replace(/^[ \t]*#.*$/gmu, '').trim() && text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '[]') {
      entries.push({ name: 'overrides/cordis.patch.yml', data: text })
    }
  }
  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')
  if (existsSync(workspaceFile)) entries.push({ name: 'pnpm-workspace.yaml', data: readFileSync(workspaceFile) })
  entries.push({ name: 'package.json', data: `${JSON.stringify(manifest, null, 2)}\n` })
  const skipped = []
  for (const item of readdirSync(profileDir, { withFileTypes: true })) {
    if (!item.isFile()) continue
    if (['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'cordis.yml', 'pnpm-lock.yaml', '.npmrc'].includes(item.name)) continue
    if (blockedReason(item.name)) continue
    const full = join(profileDir, item.name)
    if (statSync(full).size > 2 * 1024 * 1024) { skipped.push(item.name); continue }
    entries.push({ name: `overrides/${item.name}`, data: readFileSync(full) })
  }
  const homeFiles = includeHome ? collectHomeFiles(home) : []
  for (const file of homeFiles) entries.push({ name: `home/${file.path}`, data: file.data })
  const buffer = writeZip(entries, { date: now })
  return {
    buffer,
    entries: entries.map((entry) => entry.name),
    name: packName,
    version,
    profile,
    dependencies,
    bundles,
    homeFiles: homeFiles.map((file) => file.path),
    skipped,
  }
}

/** 源描述 → 字符串（记在安装记录里，也用于页面回显）。 */
export function describeSource(source) {
  if (!source) return ''
  if (typeof source === 'string') return source
  if (source.kind === 'market') return `市场：${source.id || source.url || ''}`
  if (source.kind === 'github') return `GitHub：${source.repo}${source.ref ? `@${source.ref}` : ''}`
  if (source.kind === 'file') return `文件：${source.path || ''}`
  if (source.kind === 'dir') return `目录：${source.path || ''}`
  if (source.kind === 'url') return `链接：${source.url || ''}`
  return String(source.value || '')
}

/**
 * 用户输入 → 源描述。
 *
 * 认四种写法：本地路径（含目录）、http(s) 直链、`owner/repo`（取它最新 Release 里的包）、
 * 以及页面从市场列表里选的条目（那条走 downloadUrl + sha256）。
 */
export function parsePackSource(input) {
  const text = String(input ?? '').trim()
  if (!text) throw new Error('先给一个整合包：本地文件、链接，或者 owner/repo')
  const cleaned = text.replace(/^["']|["']$/g, '')
  if (existsSync(cleaned)) {
    const info = statSync(cleaned)
    if (info.isDirectory()) return { kind: 'dir', path: cleaned, value: cleaned }
    return { kind: 'file', path: cleaned, value: cleaned }
  }
  if (/^https?:\/\//i.test(cleaned)) {
    const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:releases|archive|tree)\/[^#?]*)?(?:#(\S+))?$/i.exec(cleaned)
    // 直接给仓库页（不是 releases/download 的直链）时按仓库处理：能挑 release 里的包
    if (github && !/\/releases\/download\//i.test(cleaned)) {
      return { kind: 'github', repo: `${github[1]}/${github[2].replace(/\.git$/, '')}`, ref: github[3] || '', value: cleaned }
    }
    return { kind: 'url', url: cleaned, value: cleaned }
  }
  const repo = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@([\S]+))?$/.exec(cleaned)
  if (repo) return { kind: 'github', repo: `${repo[1]}/${repo[2].replace(/\.git$/, '')}`, ref: repo[3] || '', value: cleaned }
  throw new Error('认不出这个来源：给本地文件路径、http(s) 链接，或者 GitHub 的 owner/repo')
}
