/**
 * 版本号解析与比较（semver 的一个够用子集）。
 *
 * 单独一个文件是为了让**同步引擎**能用它而不牵连启动器：`sync.js` 要比较插件清单里的
 * 版本号，但没道理为此 import registry.js —— 那会连带拖进 settings.js / platform.js
 * 和启动器自己的目录。以后做 dsh 插件时，sync.js + zipfile.js + 这个文件就是完整的一套。
 */

/**
 * 版本号的字符集（registry 里的 tag 名、`data/versions/<版本>` 的目录名都按它收）。
 * 导出是给 `instancePorts` 的键用——那张表的键是「版本@profile」，两边都不能含 @，
 * 拼接才不会有歧义（见 server.js 的 instanceKey）。
 */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/

export function parseVer(version) {
  const match = String(version).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    pre: match[4] || '',
    parts: 1 + Number(match[2] != null) + Number(match[3] != null),
    raw: String(version),
  }
}

/**
 * 预发布段比较，按 semver 的规则逐段比：
 * 段按 `.` 拆开，纯数字段按数值比，其余按字典序比，数字段小于字母数字段；
 * 前缀全相同时段数多的更大（`alpha` < `alpha.1`）。
 * 整段当字符串比会踩 `alpha.10` < `alpha.2` 这种坑，dsh 预发布版发到两位数就会认错更新。
 */
function cmpPre(a, b) {
  const left = a.split('.')
  const right = b.split('.')
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const leftNumeric = /^\d+$/.test(l)
    const rightNumeric = /^\d+$/.test(r)
    if (leftNumeric && rightNumeric) return Number(l) < Number(r) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

export function cmpVer(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre && b.pre) return cmpPre(a.pre, b.pre)
  if (a.pre) return -1
  if (b.pre) return 1
  return 0
}

// 「比这个主次补版本的所有预发布都低」的预发布段：^1.2.3 的上界是 2.0.0-0，2.0.0-rc.1 才不会混进来。
const LOWEST_PRE = '0'
const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const ANY_RANGE = new Set(['', '*', 'x', 'X', 'latest'])

const versionOf = (major, minor = 0, patch = 0, pre = '') => ({ major, minor, patch, pre })
const isWildcard = (part) => part === undefined || /^[xX*]$/.test(part)

/** 一个比较式展开成上下界；认不出的写法返回 null（整组都不算满足，不猜）。 */
function expandComparator(token) {
  const match = COMPARATOR_RE.exec(token)
  if (!match) return null
  const [, op = '', rawMajor, rawMinor, rawPatch, pre = ''] = match
  if (isWildcard(rawMajor)) return []
  const major = Number(rawMajor)
  const minor = isWildcard(rawMinor) ? undefined : Number(rawMinor)
  const patch = isWildcard(rawPatch) ? undefined : Number(rawPatch)
  const base = versionOf(major, minor ?? 0, patch ?? 0, pre)
  const below = (next) => ({ op: '<', ver: { ...next, pre: LOWEST_PRE } })
  if (op === '^') {
    const upper = major > 0 || minor === undefined ? versionOf(major + 1)
      : minor > 0 || patch === undefined ? versionOf(0, minor + 1) : versionOf(0, 0, patch + 1)
    return [{ op: '>=', ver: base }, below(upper)]
  }
  if (op === '~') {
    return [{ op: '>=', ver: base }, below(minor === undefined ? versionOf(major + 1) : versionOf(major, minor + 1))]
  }
  const partial = minor === undefined || patch === undefined
  // 缺段的版本（1.2 / 1）代表一整段版本：比它大 = 比这一段都大，<= 它 = 低于下一段
  const nextBlock = minor === undefined ? versionOf(major + 1) : versionOf(major, minor + 1)
  if (op === '' || op === '=') {
    if (!partial) return [{ op: '=', ver: base }]
    return [{ op: '>=', ver: base }, below(nextBlock)]
  }
  if (partial && op === '>') return [{ op: '>=', ver: { ...nextBlock, pre: LOWEST_PRE } }]
  if (partial && op === '<=') return [below(nextBlock)]
  if (partial && op === '<') return [{ op: '<', ver: { ...base, pre: LOWEST_PRE } }]
  return [{ op, ver: base }]
}

/**
 * npm 默认规则：预发布版只在组里有一个比较式带着同一个「主.次.补」的预发布段时才算数
 * （`>=1.3.0-rc.1` 收 1.3.0-rc.2，但 `^1.2.0` 不收 1.3.0-alpha.1）。
 */
function prereleaseAllowed(target, comparators) {
  if (!target.pre) return true
  return comparators.some(({ ver }) => ver.pre && ver.pre !== LOWEST_PRE && ver.major === target.major && ver.minor === target.minor && ver.patch === target.patch)
}

const COMPARE = {
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0,
  '=': (order) => order === 0,
}

/**
 * 版本范围判断（semver 范围写法的够用子集）：`||` 分组，组内空格分隔的比较式全部满足即可；
 * 认 `^` `~` `x`/`*` 通配、`>=` `>` `<=` `<` `=` 和裸版本号（缺的段算通配）。
 *
 * includePrerelease（默认开）时预发布版照常按大小比较：dsh 大部分版本都是预发布，整合包作者写
 * `>=0.2.1-rc.1 <0.3.0-0` 就是想要 0.2.2-rc.1 这类版本，按 npm 的默认规则它会被排除，环境就永远
 * 挑不到 DSH 版本。挑插件版本时要关掉它，和 pnpm 解析范围的结果一致（`^1.2.0` 不该落到 1.3.0-alpha）。
 */
export function satisfiesRange(version, range, { includePrerelease = true } = {}) {
  const target = parseVer(version)
  if (!target) return false
  const text = String(range ?? '').trim()
  if (ANY_RANGE.has(text)) return includePrerelease || !target.pre
  return text.split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean).map(expandComparator)
    if (comparators.some((item) => item === null)) return false
    const flat = comparators.flat()
    return flat.every(({ op, ver }) => COMPARE[op](cmpVer(target, ver))) && (includePrerelease || prereleaseAllowed(target, flat))
  })
}

/** 能不能当版本范围解析（^1.2.0、>=1 <2、1.x、*）；npm 的 dist-tag（next、beta）不行。 */
export function isVersionRange(text) {
  const value = String(text ?? '').trim()
  if (ANY_RANGE.has(value)) return true
  return value.split('||').every((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((token) => expandComparator(token) !== null)
  })
}

/** 是不是一个精确版本号（不是范围、不是 tag）：parseVer 只认数字开头，带运算符的进不来。 */
export function isExactVersion(text) {
  const parsed = parseVer(text)
  return Boolean(parsed) && parsed.parts === 3
}

/**
 * 版本类别（启动项的版本类型），按稳定程度从高到低排：下标越大越不稳定，编辑启动项里三档开关的值就是这个下标。
 * 正式版 = 没有预发布段；RC = 预发布段第一节是 `rc`（`-rc`、`-rc.2`）；其余预发布
 * （`-alpha.5`，以及 `-beta`、`-next` 这类没约定过的）一律算 Alpha——认不出的预发布
 * 当成最不稳定的，只选正式版的人才不会被它选中或打扰。
 */
export const VERSION_CHANNEL = Object.freeze({ OFFICIAL: 'official', RC: 'rc', ALPHA: 'alpha' })
export const VERSION_CHANNELS = Object.freeze([VERSION_CHANNEL.OFFICIAL, VERSION_CHANNEL.RC, VERSION_CHANNEL.ALPHA])
const RC_IDENTIFIER = 'rc'

/** 版本号属于哪个类别；解析不了的版本号返回空串（不属于任何通道，也就不会被提醒）。 */
export function versionChannel(version) {
  const parsed = parseVer(version)
  if (!parsed) return ''
  if (!parsed.pre) return VERSION_CHANNEL.OFFICIAL
  return parsed.pre.split('.')[0] === RC_IDENTIFIER ? VERSION_CHANNEL.RC : VERSION_CHANNEL.ALPHA
}

/**
 * 一组版本里最不稳定的通道：rc 外壳配着正式版核心时也要继续看 rc，
 * 否则外壳升到 rc、核心却沿用旧的正式版，就永远收不到 rc 核心更新。
 * 认不出的版本跳过；一个都认不出时按正式版。
 */
export function leastStableChannel(versions = []) {
  let picked = ''
  for (const version of versions) {
    const channel = versionChannel(version)
    if (!channel) continue
    if (!picked || VERSION_CHANNELS.indexOf(channel) > VERSION_CHANNELS.indexOf(picked)) picked = channel
  }
  return picked || VERSION_CHANNEL.OFFICIAL
}

/**
 * 选了 `selected` 类型的启动项收不收 `channel` 类别的版本（自动选版本和更新提醒同一口径）：
 * 越不稳定的选择，越稳定的版本也照收（Alpha 全收、RC 不收 Alpha、正式版只收正式版）。
 * 认不出的通道一律不收，脏设置不会变成「什么都收」。
 */
export function channelIncludes(selected, channel) {
  const reach = VERSION_CHANNELS.indexOf(selected)
  const rank = VERSION_CHANNELS.indexOf(channel)
  return reach >= 0 && rank >= 0 && rank <= reach
}

/** `version` 是否在 `selected` 类型能收的范围内。 */
export function versionInChannel(selected, version) {
  return channelIncludes(selected, versionChannel(version))
}

/**
 * 实际生效的类型：选的类型在 `known`（已发布 ∪ 已安装）里一个版本都没有时，退到下一个更不稳定的。
 * 用户要的取舍：dsh 至今没发过正式版，默认的「正式版」严格执行的话，所有自动项都无版本可用；
 * 退一档还能用，等正式版一出现自然收回到只用正式版。一个已知版本都没有（还没联网、也没装）
 * 时没什么可比，原样返回，别凭空退到 Alpha。认不出的选择原样返回，由调用方当作什么都不收。
 */
export function effectiveChannel(selected, known) {
  const start = VERSION_CHANNELS.indexOf(selected)
  if (start < 0) return selected
  const classes = new Set([...known].map(versionChannel).filter(Boolean))
  if (!classes.size) return selected
  for (const channel of VERSION_CHANNELS.slice(start)) {
    if ([...classes].some((found) => channelIncludes(channel, found))) return channel
  }
  return selected
}
