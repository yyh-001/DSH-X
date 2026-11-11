// 环境（Environment）= 一个 DSH 版本 + 一份带版本的插件清单。Profile 只留配置和数据。
// 设计见 docs/plans/2026-11-11-environment-profile-split.md。
//
// 这个文件只放纯规则和清单读写：插件清单的比较 / 合并、上游 + 本地增量的折算、迁移规划、
// 环境清单的落盘。装依赖、起实例这些副作用都在 server.js，那边按这里的结果去动 profile 目录。
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { PROFILE_SKELETON_BUNDLES } from './packs.js'
import { VERSION_CHANNELS, VERSION_RE } from './version.js'

// 环境的来源种类：和 server.js 的 openPackSource 认的来源同名（来源原样记进环境）
const SOURCE_KIND = Object.freeze({ GITHUB: 'github', MARKET: 'market', FILE: 'file', DIR: 'dir', URL: 'url', BUILTIN: 'builtin', PACK: 'pack' })

export const ENVIRONMENT = Object.freeze({
  SCHEMA: 1,
  // 不能叫 environments：packDataDir() 早就把「每个用户目录的整合包安装记录」放在
  // <数据目录>/environments/<hash>/ 下了，混进去会被旧版当成安装记录目录去读。
  DIR: 'envs',
  FILE: 'environment.json',
  STATE_FILE: 'state.json',
  HISTORY_DIR: 'history',
  FILES_DIR: 'files',
  AUTO_VERSION: 'auto',
  NAME_MAX: 48,
  DESCRIPTION_MAX: 2000,
  SPEC_MAX: 512,
  ID_RE: /^[a-z0-9][a-z0-9-]{0,47}$/,
  // 迁移生成的环境用确定的 id：同一目录同一 profile 同一版本永远落到同一个环境，重跑不会出重复。
  ADOPTED_PREFIX: 'p-',
  ADOPTED_HASH_LENGTH: 12,
  // 收养 id 被别的环境占了（profile 改名后旧名又被重建）时，版本键后面加这个再带个编号重算
  ADOPTED_RETRY_MARK: '#',
  // 读不了的清单 / 收养记录改名留底（文件名 + 这个后缀 + 时间戳），不直接覆盖掉
  UNREADABLE_SUFFIX: '.unreadable-',
  RANDOM_SUFFIX_BYTES: 3,
  SLUG_MAX: 24,
  // 迁移给自动生成的名字加区分后缀时最多试这么多个编号，超过就说明数据异常，直接报错。
  NAME_ATTEMPTS: 100,
  // 名字后面要留出「 99」这样的编号位
  NAME_SUFFIX_ROOM: 4,
  // 项目环境的用户目录是 <项目>/.dsh：拿它当后缀没有区分度，改用项目目录名。
  PROJECT_HOME_NAME: '.dsh',
  // Profile 的「角色」组件：起不起网页由它决定（server.js 的 profileBootsWebIn），这是 Profile 的属性，
  // 不跟环境走——不然一个从 headless 收养来的环境写进 web Profile，那个 Profile 就再也起不来网页了。
  PROFILE_ROLE_BUNDLES: ['@deepseek-ai/dsh-web-app'],
  // 启动项 id（settings.js 生成的 16 位十六进制）
  PRESET_ID_RE: /^[a-f0-9]{16}$/,
  // 第一次迁移改写 settings.json 之前留的原样备份（settings.json + 这个后缀）。
  SETTINGS_BACKUP_SUFFIX: '.bak-environments',
  // 上游仓库（GitHub 的 owner/repo）：跟随上游就是跟它的 release
  REPO_RE: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
  // 离线文件（环境自己 files/ 下的 tarball）：文件名只收这些字符，内容按 sha256 核对
  OFFLINE_FILE_RE: /^[A-Za-z0-9._@+-]+\.tgz$/,
  SHA256_RE: /^[a-f0-9]{64}$/,
  PACK_VERSION_MAX: 64,
  SOURCE_TEXT_MAX: 512,
  SOURCE_KIND,
  SOURCE_KINDS: Object.values(SOURCE_KIND),
  // 跑在 WSL 里的启动项（settings.js 的 WSL_BACKENDS）：不接环境
  WSL_BACKEND: 'wsl',
  // 环境页上一条插件来自哪一层：上游层，还是本地增量（只有跟随上游的环境才分）
  PLUGIN_ORIGIN: Object.freeze({ UPSTREAM: 'upstream', LOCAL: 'local' }),
  // 落盘字段：读到不认识的字段原样留着（新版启动器写的字段，回滚到这一版再保存也不丢）
  FIELDS: ['schema', 'id', 'name', 'description', 'packVersion', 'updateChannel', 'base', 'delta', 'source', 'files', 'adoptedFrom', 'createdAt', 'updatedAt'],
})

const NPM_NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i
// 本地路径类坐标：换一台机器就装不上，导出时要么打成离线文件要么报出来（第二期）。
// 带协议的：pnpm 按 link:/file:/portal: 后面那段路径去找
const LOCAL_PATH_PROTOCOL_RE = /^(link:|file:|portal:)(.+)$/
// 不带协议、直接写路径的（./x、../x、/abs/x、C:\x）：pnpm 一样当本地路径装
const BARE_LOCAL_PATH_RE = /^(?:\.{0,2}\/|[A-Za-z]:[\\/])/

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString()

/** 环境 id 只收小写字母、数字、连字符：它会变成数据目录下的文件夹名，也会出现在启动项里。 */
export function safeEnvironmentId(value) {
  const id = String(value ?? '').trim()
  if (!ENVIRONMENT.ID_RE.test(id)) throw new Error('实例 id 不合法')
  return id
}

export function safeEnvironmentName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > ENVIRONMENT.NAME_MAX || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`实例名称请填 1-${ENVIRONMENT.NAME_MAX} 个字符`)
  }
  return name
}

/** DSH 版本：精确版本号，或 auto（跟着版本类型里的最新已装版本走，和启动项的 auto 同义）。 */
export function safeDshVersion(value) {
  const version = String(value ?? '').trim()
  if (version === ENVIRONMENT.AUTO_VERSION || VERSION_RE.test(version)) return version
  throw new Error('DSH 版本号不合法')
}

export function safeChannel(value, fallback) {
  return VERSION_CHANNELS.includes(value) ? value : fallback
}

export function isLocalSpec(spec) {
  return localSpecPath(spec) !== null
}

/**
 * 本地路径坐标拆成协议和路径（`link:../x` → {protocol: 'link:', path: '../x'}；直接写的路径协议是空串）；
 * 不是本地路径返回 null。
 */
export function localSpecPath(spec) {
  const value = String(spec ?? '').trim()
  const match = LOCAL_PATH_PROTOCOL_RE.exec(value)
  if (match) return { protocol: match[1], path: match[2] }
  return BARE_LOCAL_PATH_RE.test(value) ? { protocol: '', path: value } : null
}

export function isOfficialPackage(name) {
  return String(name ?? '').startsWith('@deepseek-ai/')
}

/** 插件名按 npm 包名的形状收；坐标只要求是非空、有长度上限的字符串，具体写法交给 pnpm 解析。 */
export function safePluginName(value) {
  if (typeof value !== 'string') throw new Error('插件名不合法')
  const name = value.trim()
  if (!NPM_NAME_RE.test(name)) throw new Error(`插件名不合法：${name || '（空）'}`)
  return name
}

function safeSpec(value) {
  // 非字符串（数字、对象）不是合法坐标：硬转成 "2" / "[object Object]" 会让 pnpm 装出莫名其妙的东西
  if (typeof value !== 'string') throw new Error('插件版本坐标不合法')
  const spec = value.trim()
  if (!spec || spec.length > ENVIRONMENT.SPEC_MAX || /[\x00-\x1f\x7f]/.test(spec)) throw new Error('插件版本坐标不合法')
  return spec
}

/**
 * 插件清单 = 依赖表 + 挂载顺序（dsh.profile.bundles）。两者分开存：官方组件
 * （@deepseek-ai/dsh-base 这些）只出现在挂载顺序里、不在依赖表里；`@deepseek-ai/cordis`
 * 这类依赖又不挂载。
 *
 * strict = false 用来读 profile 目录这种外部数据：坏条目跳过，不让一条烂数据挡住整次迁移。
 */
export function normalizePluginList(value, { strict = true } = {}) {
  const raw = isObject(value) ? value : {}
  const dependencies = {}
  for (const [name, spec] of Object.entries(isObject(raw.dependencies) ? raw.dependencies : {})) {
    try {
      dependencies[safePluginName(name)] = safeSpec(spec)
    } catch (error) {
      if (strict) throw error
    }
  }
  const bundles = []
  for (const name of Array.isArray(raw.bundles) ? raw.bundles : []) {
    try {
      const clean = safePluginName(name)
      if (!bundles.includes(clean)) bundles.push(clean)
    } catch (error) {
      if (strict) throw error
    }
  }
  return { dependencies, bundles }
}

/**
 * 从 profile 目录的 package.json 读出插件清单（读不到挂载顺序就是空列表）。
 * 给了 dir 时，相对路径的本地坐标（`link:../x`、`file:./y.tgz`）按这个目录换成绝对路径：
 * 环境会被写进别的 profile 目录，相对路径换个目录就指错了地方。
 */
export function profilePluginList(manifest, dir = '') {
  const source = isObject(manifest) ? manifest : {}
  const list = normalizePluginList({
    dependencies: source.dependencies,
    bundles: source.dsh?.profile?.bundles,
  }, { strict: false })
  if (!dir) return list
  const absolute = Object.fromEntries(Object.entries(list.dependencies).map(([name, spec]) => {
    const local = localSpecPath(spec)
    return [name, local && !isAbsolute(local.path) ? `${local.protocol}${resolve(dir, local.path)}` : spec]
  }))
  return { ...list, dependencies: absolute }
}

/**
 * 把插件清单写进 profile 的 package.json：只换 dependencies 和 dsh.profile.bundles，
 * 其他字段（name、pnpm.overrides、patchReload……）原样保留——那些是 Profile 自己的。
 */
export function withPluginList(manifest, list) {
  const next = structuredClone(isObject(manifest) ? manifest : {})
  next.dependencies = { ...list.dependencies }
  next.dsh = isObject(next.dsh) ? next.dsh : {}
  next.dsh.profile = isObject(next.dsh.profile) ? next.dsh.profile : {}
  next.dsh.profile.bundles = [...list.bundles]
  return next
}

/**
 * 把 extras 里的条目按它们在 source 里的位置插进 result：紧跟在 source 里离它最近、又已经在
 * result 里的那个前邻居后面（找不到就放最前）。挂载顺序就是叠放次序，插回原位比追加到末尾对。
 */
function placeAfterNeighbours(result, source, extras) {
  const out = [...result]
  source.forEach((name, index) => {
    if (!extras.includes(name) || out.includes(name)) return
    const before = source.slice(0, index).reverse().find((item) => out.includes(item))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, name)
  })
  return out
}

const isRoleBundle = (name) => ENVIRONMENT.PROFILE_ROLE_BUNDLES.includes(name)

/** 要写进 profile 目录的那份：环境的清单，角色组件（起不起网页）按目录现在的来。 */
export function listForProfile(target, current) {
  const roles = current.bundles.filter(isRoleBundle)
  return { dependencies: { ...target.dependencies }, bundles: placeAfterNeighbours(target.bundles.filter((name) => !isRoleBundle(name)), current.bundles, roles) }
}

/** 去掉角色组件：目录里的角色变化（换成 headless 之类）不算插件改动，不折进环境。 */
export function withoutRoleBundles(list) {
  return { dependencies: { ...list.dependencies }, bundles: list.bundles.filter((name) => !isRoleBundle(name)) }
}

/** 清单的比较键：依赖按名字排序（顺序不影响安装），挂载顺序保持原样（顺序就是叠放次序）。 */
export function pluginListKey(list) {
  const dependencies = Object.entries(list?.dependencies || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify({ dependencies, bundles: list?.bundles || [] })
}

export function samePluginList(a, b) {
  return pluginListKey(a) === pluginListKey(b)
}

/** 两份清单之间的差别：加了什么、换了什么版本、删了什么，挂载顺序各加删了哪些。 */
export function diffPluginLists(before, after) {
  const added = {}
  const changed = {}
  const removed = []
  for (const [name, spec] of Object.entries(after.dependencies)) {
    if (!Object.hasOwn(before.dependencies, name)) added[name] = spec
    else if (before.dependencies[name] !== spec) changed[name] = { from: before.dependencies[name], to: spec }
  }
  for (const name of Object.keys(before.dependencies)) {
    if (!Object.hasOwn(after.dependencies, name)) removed.push(name)
  }
  return {
    added,
    changed,
    removed,
    bundlesAdded: after.bundles.filter((name) => !before.bundles.includes(name)),
    bundlesRemoved: before.bundles.filter((name) => !after.bundles.includes(name)),
  }
}

export function diffIsEmpty(diff) {
  return !Object.keys(diff.added).length && !Object.keys(diff.changed).length && !diff.removed.length
    && !diff.bundlesAdded.length && !diff.bundlesRemoved.length
}

/** 把一份差别直接套到清单上（新挂载的追加到末尾：dsh 按顺序叠放，后装的排后面）。 */
export function applyPluginDiff(list, diff) {
  const dependencies = { ...list.dependencies }
  for (const name of diff.removed) delete dependencies[name]
  for (const [name, spec] of Object.entries(diff.added)) dependencies[name] = spec
  for (const [name, { to }] of Object.entries(diff.changed)) dependencies[name] = to
  const bundles = list.bundles.filter((name) => !diff.bundlesRemoved.includes(name))
  for (const name of diff.bundlesAdded) if (!bundles.includes(name)) bundles.push(name)
  return { dependencies, bundles }
}

function emptyDelta() {
  return { dshVersion: '', dependencies: {}, removed: [], bundlesAdded: [], bundlesRemoved: [] }
}

function normalizeDelta(value) {
  const raw = isObject(value) ? value : {}
  const list = normalizePluginList({ dependencies: raw.dependencies, bundles: raw.bundlesAdded })
  const names = (items) => normalizePluginList({ bundles: items }).bundles
  return {
    dshVersion: raw.dshVersion ? safeDshVersion(raw.dshVersion) : '',
    dependencies: list.dependencies,
    removed: names(raw.removed),
    bundlesAdded: list.bundles,
    bundlesRemoved: names(raw.bundlesRemoved),
  }
}

/**
 * 来源：环境从哪来、要不要跟着上游更新。following 只在能认出 GitHub 仓库时为真
 * （上游 = 那个仓库的 release，见设计稿「跟随上游」）。
 */
export function normalizeSource(value) {
  if (!isObject(value)) return null
  const text = (field, max = ENVIRONMENT.SOURCE_TEXT_MAX) => {
    const result = typeof value[field] === 'string' ? value[field].trim() : ''
    return result.length <= max && !/[\x00-\x1f\x7f]/.test(result) ? result : ''
  }
  const kind = ENVIRONMENT.SOURCE_KINDS.includes(value.kind) ? value.kind : SOURCE_KIND.PACK
  const repo = ENVIRONMENT.REPO_RE.test(text('repo')) ? text('repo') : ''
  return {
    kind,
    ...(repo ? { repo } : {}),
    ...(text('release') ? { release: text('release') } : {}),
    // GitHub 上勾了 Pre-release 的那种：版本号不一定写成预发布形状，检查更新时据此决定给不给预发布
    ...(value.prerelease === true ? { prerelease: true } : {}),
    ...(text('packId') ? { packId: text('packId') } : {}),
    ...(text('packVersion') ? { packVersion: text('packVersion') } : {}),
    ...(text('marketId') ? { marketId: text('marketId') } : {}),
    ...(text('label') ? { label: text('label') } : {}),
    following: Boolean(repo) && value.following !== false,
  }
}

function normalizeAdoptedFrom(value) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!isObject(item) || typeof item.home !== 'string' || typeof item.profile !== 'string' || typeof item.version !== 'string') return []
    return [{ home: item.home, profile: item.profile, version: item.version }]
  })
}

/**
 * 读进来的环境清单一律过这里：字段补齐、坏值报错。落盘前也过一遍，磁盘上只会有合法形状。
 * @throws 字段不合法时
 */
export function normalizeEnvironment(raw, { defaultChannel = VERSION_CHANNELS[0] } = {}) {
  if (!isObject(raw)) throw new Error('实例清单不是对象')
  if (Number(raw.schema) > ENVIRONMENT.SCHEMA) throw new Error('这个实例是更新版本的启动器写的，这一版读不了')
  const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !ENVIRONMENT.FIELDS.includes(key)))
  const base = isObject(raw.base) ? raw.base : {}
  const description = typeof raw.description === 'string' ? raw.description.slice(0, ENVIRONMENT.DESCRIPTION_MAX) : ''
  const files = isObject(raw.files) ? raw.files : {}
  return {
    ...extra,
    schema: ENVIRONMENT.SCHEMA,
    id: safeEnvironmentId(raw.id),
    name: safeEnvironmentName(raw.name),
    ...(description ? { description } : {}),
    ...(typeof raw.packVersion === 'string' && raw.packVersion.trim() ? { packVersion: raw.packVersion.trim().slice(0, ENVIRONMENT.PACK_VERSION_MAX) } : {}),
    updateChannel: safeChannel(raw.updateChannel, defaultChannel),
    base: { dshVersion: safeDshVersion(base.dshVersion ?? ENVIRONMENT.AUTO_VERSION), ...normalizePluginList(base) },
    delta: normalizeDelta(raw.delta),
    source: normalizeSource(raw.source),
    // 离线文件（第二期）：插件名 → { file, sha256 }，文件放在环境自己的 files/ 下。
    files: Object.fromEntries(Object.entries(files).flatMap(([name, item]) => {
      if (!isObject(item) || !ENVIRONMENT.OFFLINE_FILE_RE.test(String(item.file)) || !ENVIRONMENT.SHA256_RE.test(String(item.sha256))) return []
      return [[safePluginName(name), { file: item.file, sha256: item.sha256 }]]
    })),
    adoptedFrom: normalizeAdoptedFrom(raw.adoptedFrom),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

/** 跟着上游的环境：本地改动记成增量，上游更新时重放；不跟上游的直接改本体。 */
export function isFollowing(env) {
  return Boolean(env?.source?.following)
}

/** 实际生效的那份：上游层 + 本地增量。启动前写进 profile 目录的就是它。 */
export function effectivePlugins(env) {
  const { base, delta } = env
  const dependencies = { ...base.dependencies }
  for (const name of delta.removed) delete dependencies[name]
  Object.assign(dependencies, delta.dependencies)
  const bundles = base.bundles.filter((name) => !delta.bundlesRemoved.includes(name))
  for (const name of delta.bundlesAdded) if (!bundles.includes(name)) bundles.push(name)
  return {
    dshVersion: delta.dshVersion || base.dshVersion,
    updateChannel: env.updateChannel,
    dependencies,
    bundles,
  }
}

/** 增量里和上游层一样的条目没有意义，去掉，免得界面上出现「本地改了但其实没改」。 */
function tidyDelta(base, delta) {
  const dependencies = Object.fromEntries(Object.entries(delta.dependencies).filter(([name, spec]) => base.dependencies[name] !== spec))
  return {
    dshVersion: delta.dshVersion && delta.dshVersion !== base.dshVersion ? delta.dshVersion : '',
    dependencies,
    removed: delta.removed.filter((name) => Object.hasOwn(base.dependencies, name) && !Object.hasOwn(dependencies, name)),
    bundlesAdded: delta.bundlesAdded.filter((name) => !base.bundles.includes(name)),
    bundlesRemoved: delta.bundlesRemoved.filter((name) => base.bundles.includes(name)),
  }
}

/** 把一份差别记进跟上游环境的本地增量。 */
function foldIntoDelta(env, diff) {
  const delta = structuredClone(env.delta)
  for (const [name, spec] of Object.entries({ ...diff.added, ...Object.fromEntries(Object.entries(diff.changed).map(([key, item]) => [key, item.to])) })) {
    delta.dependencies[name] = spec
    delta.removed = delta.removed.filter((item) => item !== name)
  }
  for (const name of diff.removed) {
    delete delta.dependencies[name]
    if (!delta.removed.includes(name)) delta.removed.push(name)
  }
  for (const name of diff.bundlesAdded) {
    delta.bundlesRemoved = delta.bundlesRemoved.filter((item) => item !== name)
    if (!delta.bundlesAdded.includes(name)) delta.bundlesAdded.push(name)
  }
  for (const name of diff.bundlesRemoved) {
    delta.bundlesAdded = delta.bundlesAdded.filter((item) => item !== name)
    if (!delta.bundlesRemoved.includes(name)) delta.bundlesRemoved.push(name)
  }
  return tidyDelta(env.base, delta)
}

/**
 * 把一处插件改动（before → after）折算进环境：跟上游的进本地增量，不跟的直接改本体。
 * 用差别而不是整份替换：环境页可能已经在清单上改过别的，整份替换会把那些改动冲掉。
 */
export function foldPluginChanges(env, before, after, { now } = {}) {
  const diff = diffPluginLists(before, after)
  // 只调了挂载顺序：不跟上游的环境照目录的顺序改；跟上游的环境顺序以上游为准（增量记不了顺序），
  // 下次启动时会按环境的顺序写回去。
  if (diffIsEmpty(diff) && (isFollowing(env) || pluginListKey(before) === pluginListKey(after))) return { env, diff, changed: false }
  const next = structuredClone(env)
  if (isFollowing(env)) next.delta = foldIntoDelta(env, diff)
  else {
    const merged = applyPluginDiff(env.base, diff)
    // 顺序跟目录走；环境里有、目录里没有的（环境页上刚加的）插回它在环境里的位置
    const bundles = placeAfterNeighbours(after.bundles.filter((name) => merged.bundles.includes(name)), merged.bundles, merged.bundles.filter((name) => !after.bundles.includes(name)))
    next.base = { ...next.base, ...merged, bundles }
  }
  next.updatedAt = nowIso(now)
  return { env: next, diff, changed: true }
}

/** 加 / 换一个插件（同名覆盖坐标）；bundle = false 时只进依赖表、不挂载。 */
export function setEnvironmentPlugin(env, name, spec, { bundle = true, now } = {}) {
  const before = effectivePlugins(env)
  const pkg = safePluginName(name)
  // 和移除同一条规则：官方组件跟着 DSH 版本走，单独加一个版本只会和 DSH 自带的那份打架
  if (isOfficialPackage(pkg)) throw new Error(`${pkg} 是官方组件，跟着 DSH 版本走，不用单独加`)
  const after = {
    dependencies: { ...before.dependencies, [pkg]: safeSpec(spec) },
    bundles: bundle && !before.bundles.includes(pkg) ? [...before.bundles, pkg] : [...before.bundles],
  }
  return foldPluginChanges(env, before, after, { now }).env
}

export function removeEnvironmentPlugin(env, name, { now } = {}) {
  const before = effectivePlugins(env)
  if (!Object.hasOwn(before.dependencies, name) && !before.bundles.includes(name)) throw new Error(`实例里没有 ${name}`)
  if (isOfficialPackage(name)) throw new Error(`${name} 是官方组件，跟着 DSH 版本走，不能从实例里移除`)
  const dependencies = { ...before.dependencies }
  delete dependencies[name]
  return foldPluginChanges(env, before, { dependencies, bundles: before.bundles.filter((item) => item !== name) }, { now }).env
}

/** 改 DSH 版本：跟上游的环境记进增量（上游换版本时只提醒，不替用户决定），否则直接改。 */
export function setEnvironmentVersion(env, version, channel, { now } = {}) {
  const next = structuredClone(env)
  const dshVersion = safeDshVersion(version)
  if (isFollowing(env)) next.delta = tidyDelta(next.base, { ...next.delta, dshVersion })
  else next.base.dshVersion = dshVersion
  next.updateChannel = safeChannel(channel, env.updateChannel)
  next.updatedAt = nowIso(now)
  return next
}

/**
 * 跟随上游的环境换上游层（设计稿「应用更新的步骤」）：上游层整份换掉，本地增量原样留着、对着新上游
 * 重放（effectivePlugins 按「上游 + 增量」算）；增量里和新上游一样的条目没意义，顺手去掉。
 * discard 里点名的插件不再保留本地改动，回到上游那份（上游换了 DSH 版本时，用户决定不留的那些）。
 */
export function withUpstreamBase(env, base, { discard = [], now } = {}) {
  const drop = new Set(discard)
  const next = structuredClone(env)
  next.base = { dshVersion: safeDshVersion(base.dshVersion), ...normalizePluginList(base) }
  const dependencies = Object.fromEntries(Object.entries(env.delta.dependencies).filter(([name]) => !drop.has(name)))
  // 本地钉了版本、上游这次整个删掉的插件：依赖照留（本地改动优先），挂载也要照留——
  // 挂载原本来自上游层，上游层里没了它，不记进增量就会装着却不加载
  const mounted = effectivePlugins(env).bundles
  const keepMounted = Object.keys(dependencies).filter((name) => mounted.includes(name) && !Object.hasOwn(next.base.dependencies, name))
  const delta = {
    ...env.delta,
    dependencies,
    removed: env.delta.removed.filter((name) => !drop.has(name)),
    bundlesAdded: [...new Set([...env.delta.bundlesAdded.filter((name) => !drop.has(name)), ...keepMounted])],
    bundlesRemoved: env.delta.bundlesRemoved.filter((name) => !drop.has(name)),
  }
  next.delta = tidyDelta(next.base, delta)
  next.updatedAt = nowIso(now)
  return next
}

/** 启动项的版本坐标：精确版本原样，auto 带上版本类型（auto 落到哪个版本取决于类型）。 */
export function versionKey(version, channel) {
  return version === ENVIRONMENT.AUTO_VERSION ? `${ENVIRONMENT.AUTO_VERSION}:${channel}` : version
}

export function environmentVersionKey(env) {
  const { dshVersion, updateChannel } = effectivePlugins(env)
  return versionKey(dshVersion, updateChannel)
}

export function adoptedId(home, profile, key) {
  const hash = createHash('sha256').update(`${home}\0${profile}\0${key}`).digest('hex').slice(0, ENVIRONMENT.ADOPTED_HASH_LENGTH)
  return `${ENVIRONMENT.ADOPTED_PREFIX}${hash}`
}

/** 新环境的 id：名字的 ASCII 部分 + 随机尾巴（中文名只剩尾巴也没关系，id 不给人看）。 */
export function newEnvironmentId(name, taken = new Set()) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ENVIRONMENT.SLUG_MAX)
  for (;;) {
    const suffix = randomBytes(ENVIRONMENT.RANDOM_SUFFIX_BYTES).toString('hex')
    const id = slug ? `${slug}-${suffix}` : `env-${suffix}`
    if (!taken.has(id)) return id
  }
}

/** 一个新环境的骨架；list 缺省是空清单，调用方要自己给官方组件（见 server.js 的默认挂载）。 */
export function createEnvironment({ id, name, dshVersion = ENVIRONMENT.AUTO_VERSION, updateChannel, list, source = null, description = '', adoptedFrom = [], now, defaultChannel } = {}) {
  const at = nowIso(now)
  return normalizeEnvironment({
    id, name, description, updateChannel, source, adoptedFrom,
    base: { dshVersion, ...(list || { dependencies: {}, bundles: [] }) },
    createdAt: at,
    updatedAt: at,
  }, { defaultChannel })
}

/** 复制一份：新 id、新名字，来源和迁移记录不跟过去（副本是用户自己的，不跟上游）。 */
export function duplicateEnvironment(env, { id, name, now }) {
  const at = nowIso(now)
  const list = effectivePlugins(env)
  return normalizeEnvironment({
    ...structuredClone(env),
    id, name,
    base: { dshVersion: list.dshVersion, dependencies: list.dependencies, bundles: list.bundles },
    delta: emptyDelta(),
    source: null,
    adoptedFrom: [],
    createdAt: at,
    updatedAt: at,
  })
}

/** 用户目录在界面和环境名里的简称：项目环境（<项目>/.dsh）用项目目录名。 */
export function homeLabel(home) {
  const name = basename(home)
  return name === ENVIRONMENT.PROJECT_HOME_NAME ? basename(dirname(home)) : name
}

function uniqueName(candidates, taken) {
  for (const name of candidates) {
    const clean = name.slice(0, ENVIRONMENT.NAME_MAX)
    if (!taken.has(clean)) return clean
  }
  const base = candidates[0].slice(0, ENVIRONMENT.NAME_MAX - ENVIRONMENT.NAME_SUFFIX_ROOM)
  for (let index = 2; index < ENVIRONMENT.NAME_ATTEMPTS; index += 1) {
    if (!taken.has(`${base} ${index}`)) return `${base} ${index}`
  }
  throw new Error('实例名称冲突太多，无法自动取名')
}

/**
 * 整合包安装记录里的来源是给人看的一句话（「GitHub：owner/repo@ref」「市场：id」……），
 * 迁移时按这几种写法认出仓库；认不出就是「不跟随」。
 */
export function sourceFromPackRecord(record) {
  const text = typeof record?.source === 'string' ? record.source : ''
  const github = /^GitHub：([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:@(\S+))?$/.exec(text)
  const market = /^市场：(\S+)$/.exec(text)
  return normalizeSource({
    kind: github ? 'github' : market ? 'market' : 'pack',
    repo: github ? github[1] : '',
    release: github?.[2] || '',
    marketId: market?.[1] || '',
    packId: typeof record?.name === 'string' ? record.name : '',
    packVersion: typeof record?.version === 'string' ? record.version : '',
    label: text,
  })
}

const appliedKey = (home, profile) => `${home}\0${profile}`
export { appliedKey }

/**
 * 迁移规划（纯函数）：把旧形态的数据收养成环境。启动时跑，同一份输入永远得到同一份结果。
 *
 * 两种旧形态，逐项发现、逐项收养（没有全局「已迁移」标记）：
 * - 没有环境字段的启动项：先看上次收养时记下的链接（旧版保存设置会删掉不认识的字段，
 *   回滚再升级后要接回原来那个环境），再按「目录 + profile + 版本」找，都没有就新建；
 *   profile 目录还没初始化（模板 profile 首次启动前）就先放着，下次再收。
 * - 有插件清单、但没有任何环境从它收养过的 profile 目录：生成一个跟随最新版本的环境。
 *
 * 旧版最后写的启动项（没有环境字段）以旧字段为准：版本跟环境记的不一样就改环境。
 * 插件清单的差别不在这里处理，由 server.js 按「上次写进目录的清单」折算进增量。
 *
 * @param {object} input
 * @param {object[]} input.presets 启动项（safeLaunchPresets 之后）
 * @param {{home: string, profile: string, list: object|null}[]} input.profiles 扫到的 profile 目录
 * @param {object[]} input.environments 已有环境
 * @param {{links: object, applied: object}} input.state 收养记录
 * @param {{home: string, profile: string, record: object}[]} [input.packs] 整合包安装记录
 * @param {string} input.defaultHome 默认用户目录（启动项没写 dshHome 时用它）
 * @param {string} input.defaultChannel 默认版本类型
 * @returns {{environments: object[], presets: object[], state: object, created: string[], changed: string[], log: string[]}}
 */
export function planAdoption({ presets, profiles, environments, state, packs = [], defaultHome, defaultChannel, now }) {
  const ctx = adoptionContext({ profiles, environments, state, defaultHome, defaultChannel, now })
  const nextPresets = linkPresets(ctx, presets)
  adoptProfiles(ctx, profiles)
  recordPackSources(ctx, packs)
  const touched = new Set([...ctx.created, ...ctx.changed])
  return {
    environments: [...ctx.envs.values()].filter((env) => touched.has(env.id)),
    presets: nextPresets,
    state: ctx.next,
    created: ctx.created,
    changed: [...ctx.changed].filter((id) => !ctx.created.includes(id)),
    log: ctx.log,
  }
}

/** 三步收养共用的工作区：环境表、新的收养记录、改动账本和几个查找函数。 */
function adoptionContext({ profiles, environments, state, defaultHome, defaultChannel, now }) {
  const envs = new Map(environments.map((env) => [env.id, env]))
  const ctx = {
    envs, defaultHome, defaultChannel, now,
    next: { links: { ...(state?.links || {}) }, applied: { ...(state?.applied || {}) }, dismissed: [...(state?.dismissed || [])] },
    created: [],
    changed: new Set(),
    log: [],
    listOf: (home, profile) => profiles.find((item) => item.home === home && item.profile === profile)?.list || null,
    names: () => new Set([...envs.values()].map((env) => env.name)),
    findAdopted: (home, profile, key) => [...envs.values()].find((env) => adoptedHere(env, home, profile, key)),
    recordApplied: (home, profile, env, list) => {
      const key = appliedKey(home, profile)
      if (!ctx.next.applied[key] && list) ctx.next.applied[key] = { environment: env.id, list }
    },
    update: (env) => {
      envs.set(env.id, env)
      ctx.changed.add(env.id)
    },
  }
  return ctx
}

function adoptedHere(env, home, profile, key = null) {
  return env.adoptedFrom.some((item) => item.home === home && item.profile === profile && (key === null || item.version === key))
}

/**
 * 收养时用的 id：同一目录、同一 profile、同一版本永远落到同一个 id。这个 id 已经被别的环境占着
 * （profile 改过名，环境跟着新名字走了，旧名字又被重建）就往后数一个，不把新目录记到老环境头上。
 */
function adoptionId(ctx, home, profile, key) {
  for (let attempt = 0; attempt < ENVIRONMENT.NAME_ATTEMPTS; attempt += 1) {
    const id = adoptedId(home, profile, attempt ? `${key}${ENVIRONMENT.ADOPTED_RETRY_MARK}${attempt}` : key)
    const env = ctx.envs.get(id)
    if (!env || adoptedHere(env, home, profile, key)) return id
  }
  throw new Error('收养用的实例 id 冲突太多，数据可能有问题')
}

/** 按「目录 + profile + 版本」生成（或拿回）一个环境；list 缺省时从 template 环境复制清单。 */
function adopt(ctx, { home, profile, version, channel, list }) {
  const key = versionKey(version, channel)
  const id = adoptionId(ctx, home, profile, key)
  if (ctx.envs.has(id)) return ctx.envs.get(id)
  const sameOrigin = Boolean(ctx.findAdopted(home, profile, null))
  const versionLabel = version === ENVIRONMENT.AUTO_VERSION ? ENVIRONMENT.AUTO_VERSION : version
  const label = homeLabel(home)
  const candidates = [profile, ...(sameOrigin ? [`${profile} · ${versionLabel}`] : []), `${profile} (${label})`, `${profile} (${label}) · ${versionLabel}`]
  const env = createEnvironment({
    id,
    name: uniqueName(candidates, ctx.names()),
    dshVersion: version,
    updateChannel: channel,
    list,
    adoptedFrom: [{ home, profile, version: key }],
    now: ctx.now,
    defaultChannel: ctx.defaultChannel,
  })
  ctx.envs.set(id, env)
  ctx.created.push(id)
  // 之前删掉过的收养环境又被需要了（有启动项要用它）：不再算「用户不要」
  ctx.next.dismissed = ctx.next.dismissed.filter((item) => item !== id)
  ctx.log.push(`从 ${home} 的配置「${profile}」生成实例「${env.name}」`)
  return env
}

/** 链接只在启动项还指着同一个目录、同一个 profile 时才算数：旧版里改过 profile 的不能接回老环境。 */
function linkedEnvironment(ctx, preset, home) {
  const link = ctx.next.links[preset.id]
  return link && link.home === home && link.profile === preset.profile ? ctx.envs.get(link.environment) || null : null
}

/**
 * 第一步：没有环境字段的启动项（旧版最后保存的）接回或生成环境。
 *
 * 旧字段为准（设计稿「最后写的人说了算」）：版本和环境记的不一样，说明用户在旧版里改了版本。
 * 只有这一个启动项用这个环境、或者用它的旧形态启动项都改成了同一个版本时，才直接改环境；
 * 还有别的启动项按原版本在用，就给改了版本的那个分出一个按版本的环境（清单一样，照样能并发），
 * 不然几个启动项会按排列顺序互相把版本改来改去。
 */
function linkPresets(ctx, presets) {
  const home = (preset) => preset.dshHome || ctx.defaultHome
  const keyOf = (preset) => versionKey(preset.version, safeChannel(preset.updateChannel, ctx.defaultChannel))
  // WSL 启动项不接环境：Profile 目录在 WSL 里，启动器写不进去也装不了依赖
  const isWsl = (preset) => preset.backend === ENVIRONMENT.WSL_BACKEND
  const legacy = presets.filter((preset) => !isWsl(preset) && !(preset.environment && ctx.envs.has(preset.environment)))
  const candidate = new Map(legacy.map((preset) => [preset.id, linkedEnvironment(ctx, preset, home(preset)) || ctx.findAdopted(home(preset), preset.profile, keyOf(preset)) || null]))
  // 每个环境：新形态绑着它的启动项都在原版本上；旧形态的看它们各自要的版本
  const keysWanted = (env) => new Set(presets.flatMap((preset) => {
    if (preset.environment === env.id && ctx.envs.has(preset.environment)) return [environmentVersionKey(env)]
    return candidate.get(preset.id)?.id === env.id ? [keyOf(preset)] : []
  }))
  return presets.map((preset) => {
    if (isWsl(preset)) return preset
    if (!legacy.includes(preset)) {
      ctx.next.links[preset.id] = { environment: preset.environment, home: home(preset), profile: preset.profile }
      return preset
    }
    const channel = safeChannel(preset.updateChannel, ctx.defaultChannel)
    const list = ctx.listOf(home(preset), preset.profile)
    const key = keyOf(preset)
    let env = candidate.get(preset.id) ? ctx.envs.get(candidate.get(preset.id).id) : null
    if (env && environmentVersionKey(env) !== key) {
      if (keysWanted(candidate.get(preset.id)).size === 1) {
        env = setEnvironmentVersion(env, preset.version, channel, { now: ctx.now })
        ctx.update(env)
        ctx.log.push(`启动项「${preset.name}」的版本在旧版里改成了 ${preset.version}，实例「${env.name}」跟着改`)
      } else {
        const shared = env
        env = adopt(ctx, { home: home(preset), profile: preset.profile, version: preset.version, channel, list: effectiveList(shared) })
        ctx.log.push(`启动项「${preset.name}」在旧版里改成了 ${preset.version}，实例「${shared.name}」还有别的启动项在用原版本，分出「${env.name}」`)
      }
    }
    if (!env) {
      if (!list) return preset
      env = adopt(ctx, { home: home(preset), profile: preset.profile, version: preset.version, channel, list })
    }
    ctx.next.links[preset.id] = { environment: env.id, home: home(preset), profile: preset.profile }
    ctx.recordApplied(home(preset), preset.profile, env, list)
    return { ...preset, environment: env.id }
  })
}

/**
 * 第二步：有插件清单、没被收养过的 profile 目录，生成一个跟随最新版本的环境。
 * 已经写着某个环境的目录（applied 里有记录）不用再收；用户删掉过的收养环境（dismissed）
 * 不再自动生成回来。
 */
function adoptProfiles(ctx, profiles) {
  const ordered = [...profiles].sort((a, b) => (a.home === b.home ? (a.profile < b.profile ? -1 : 1) : a.home < b.home ? -1 : 1))
  for (const { home, profile, list } of ordered) {
    if (!list) continue
    const existing = ctx.findAdopted(home, profile, null)
    if (existing) {
      ctx.recordApplied(home, profile, existing, list)
      continue
    }
    if (ctx.next.applied[appliedKey(home, profile)]) continue
    const autoKey = versionKey(ENVIRONMENT.AUTO_VERSION, ctx.defaultChannel)
    if (ctx.next.dismissed.includes(adoptionId(ctx, home, profile, autoKey))) continue
    const env = adopt(ctx, { home, profile, version: ENVIRONMENT.AUTO_VERSION, channel: ctx.defaultChannel, list })
    ctx.recordApplied(home, profile, env, list)
  }
}

/**
 * 老整合包的层栈只列插件，官方组件由 profile 骨架带：一个官方组件都没有的清单，前面补上骨架。
 * 我们自己导出的包本来就是完整层栈，原样返回。
 */
export function withSkeletonBundles(list) {
  if (list.bundles.some(isOfficialPackage)) return list
  const skeleton = PROFILE_SKELETON_BUNDLES
  return { ...list, bundles: [...skeleton, ...list.bundles.filter((name) => !skeleton.includes(name))] }
}

/** 整合包安装记录里的那份清单（上游层）。 */
function packRecordList(record) {
  const specs = isObject(record?.specs) && Object.keys(record.specs).length ? record.specs : record?.dependencies
  return withSkeletonBundles(normalizePluginList({ dependencies: specs, bundles: record?.bundles }, { strict: false }))
}

/**
 * 第三步：装过整合包的环境记下来源。能认出仓库、而且这个目录只装过这一个包时才跟随上游：
 * 上游层换成包自己的清单，目录里多出来的（用户自己装的）折成本地增量——否则第三期按上游更新时，
 * 会把用户自己装的插件当成上游的一部分换掉。叠装过几个包的分不清哪部分属于谁，只记来源不跟随。
 */
function recordPackSources(ctx, packs) {
  const perProfile = new Map()
  for (const item of packs) {
    // 环境导入时只写进 Profile 的配置：没有插件清单，也不是这个目录的来源
    if (item.record?.configOnly) continue
    const key = appliedKey(item.home, item.profile)
    perProfile.set(key, [...(perProfile.get(key) || []), item])
  }
  for (const [key, items] of perProfile) {
    const { home, profile } = items[0]
    const env = ctx.envs.get(ctx.next.applied[key]?.environment) || ctx.findAdopted(home, profile, null)
    if (!env || env.source) continue
    const record = items.at(-1).record
    const source = sourceFromPackRecord(record)
    let updated = { ...env, source: { ...source, following: false }, ...(record?.version ? { packVersion: String(record.version) } : {}) }
    if (source.following && items.length === 1) {
      const upstream = packRecordList(record)
      const current = effectiveList(env)
      const rebased = { ...updated, source, base: { dshVersion: env.base.dshVersion, ...upstream }, delta: emptyDelta() }
      updated = foldPluginChanges(rebased, upstream, current, { now: ctx.now }).env
    }
    const normalized = normalizeEnvironment(updated)
    ctx.update(normalized)
    ctx.log.push(`实例「${env.name}」记下整合包来源：${normalized.source.label || normalized.source.kind}${normalized.source.following ? '' : '（认不出仓库或叠装过多个包，不跟随上游）'}`)
  }
}

/** 环境实际生效的那份清单（只要依赖和挂载顺序）。 */
export function effectiveList(env) {
  const { dependencies, bundles } = effectivePlugins(env)
  return { dependencies, bundles }
}

/** 原子写：先写临时文件再改名，进程半路被杀也不会留下半截 JSON。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 已经在日志里报过的坏清单（每个进程报一次）
const reportedFiles = new Set()

function keepUnreadable(file) {
  try {
    renameSync(file, `${file}${ENVIRONMENT.UNREADABLE_SUFFIX}${nowIso().replace(/[:.]/g, '-')}`)
  } catch {
    // 改名失败就让后面的写入直接覆盖：留底是尽力而为，不能因此卡住收养
  }
}

/**
 * 环境清单的落盘位置：<启动器目录>/envs/<id>/environment.json（和 settings.json 同一处），外加一份收养记录
 * （state.json：启动项 → 环境的链接，profile 目录 → 上次写进去的那份清单）。
 * 旧版启动器从来不读这里，所以新数据放这儿不影响回滚。
 */
export class EnvironmentStore {
  constructor(root, { defaultChannel = VERSION_CHANNELS[0], log = () => {} } = {}) {
    this.root = root
    this.defaultChannel = defaultChannel
    this.log = log
  }

  dir(id) {
    return join(this.root, safeEnvironmentId(id))
  }

  /** 全部环境，按创建时间排（坏文件记一笔跳过，不挡其他环境；同一个坏文件只记一次，免得每次取列表都刷屏）。 */
  list() {
    let entries = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && ENVIRONMENT.ID_RE.test(entry.name))
    } catch {
      return []
    }
    return entries.flatMap((entry) => {
      const file = join(this.root, entry.name, ENVIRONMENT.FILE)
      const { env, error } = this.read(file)
      if (error && !reportedFiles.has(file)) {
        reportedFiles.add(file)
        this.log(`实例清单 ${entry.name} 读不了：${error}`)
      }
      return env && env.id === entry.name ? [env] : []
    }).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
  }

  /** 读一份清单：{env} 或 {error}（文件不在时两者都空）。 */
  read(file) {
    if (!existsSync(file)) return {}
    const raw = readJson(file)
    if (!raw) return { error: '不是合法的 JSON' }
    try {
      return { env: normalizeEnvironment(raw, { defaultChannel: this.defaultChannel }) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), newer: Number(raw.schema) > ENVIRONMENT.SCHEMA }
    }
  }

  get(id) {
    let dir
    try { dir = this.dir(id) } catch { return null }
    return this.read(join(dir, ENVIRONMENT.FILE)).env || null
  }

  /**
   * 存一份清单。磁盘上那份是更新版本的启动器写的：拒绝覆盖（回滚到这一版时不能把新数据冲掉）；
   * 那份读不了：先改名留底再写，别让收养悄悄盖掉用户手改坏了的文件。
   * @throws 磁盘上是更新版本写的清单时
   */
  save(env) {
    const clean = normalizeEnvironment(env, { defaultChannel: this.defaultChannel })
    const file = join(this.dir(clean.id), ENVIRONMENT.FILE)
    const existing = this.read(file)
    if (existing.newer) throw new Error(`实例 ${clean.id} 是更新版本的启动器写的，这一版不改它`)
    if (existing.error) keepUnreadable(file)
    writeJsonAtomic(file, clean)
    return clean
  }

  remove(id) {
    rmSync(this.dir(id), { recursive: true, force: true })
  }

  filesDir(id) {
    return join(this.dir(id), ENVIRONMENT.FILES_DIR)
  }

  /** 改动前把旧清单存一份（跟上游更新后能切回去）；返回备份文件名。 */
  archive(env, now = new Date()) {
    const name = `${nowIso(now).replace(/[:.]/g, '-')}.json`
    writeJsonAtomic(join(this.dir(env.id), ENVIRONMENT.HISTORY_DIR, name), env)
    return name
  }

  history(id) {
    const dir = join(this.dir(id), ENVIRONMENT.HISTORY_DIR)
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse()
    } catch {
      return []
    }
  }

  readHistory(id, name) {
    if (!/^[0-9TZ-]+\.json$/.test(String(name))) throw new Error('备份名不合法')
    const raw = readJson(join(this.dir(id), ENVIRONMENT.HISTORY_DIR, name))
    if (!raw) throw new Error('这份备份已不存在')
    return normalizeEnvironment(raw, { defaultChannel: this.defaultChannel })
  }

  /**
   * 收养记录：启动项 → {环境, 目录, profile} 的链接、profile 目录 → 上次写进去的清单、
   * 用户删掉过的收养环境。文件坏了先留底再当空记录（记录丢了最多是下次重新收养，不该卡住启动）。
   */
  readState() {
    const file = join(this.root, ENVIRONMENT.STATE_FILE)
    const raw = readJson(file)
    if (!raw && existsSync(file)) {
      keepUnreadable(file)
      this.log(`收养记录 ${ENVIRONMENT.STATE_FILE} 读不了，已改名留底，按空记录重新收养`)
    }
    const links = isObject(raw?.links) ? Object.fromEntries(Object.entries(raw.links).flatMap(([key, value]) => {
      if (!ENVIRONMENT.PRESET_ID_RE.test(key) || !isObject(value) || !ENVIRONMENT.ID_RE.test(String(value.environment))) return []
      if (typeof value.home !== 'string' || typeof value.profile !== 'string') return []
      return [[key, { environment: value.environment, home: value.home, profile: value.profile }]]
    })) : {}
    const applied = isObject(raw?.applied) ? Object.fromEntries(Object.entries(raw.applied).flatMap(([key, value]) => {
      if (!isObject(value) || !ENVIRONMENT.ID_RE.test(String(value.environment)) || !key.includes('\0')) return []
      return [[key, { environment: value.environment, list: normalizePluginList(value.list, { strict: false }) }]]
    })) : {}
    const dismissed = Array.isArray(raw?.dismissed) ? raw.dismissed.filter((id) => ENVIRONMENT.ID_RE.test(String(id))) : []
    return { links, applied, dismissed }
  }

  writeState(state) {
    writeJsonAtomic(join(this.root, ENVIRONMENT.STATE_FILE), { links: state.links || {}, applied: state.applied || {}, dismissed: state.dismissed || [] })
  }
}
