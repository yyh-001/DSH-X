/**
 * 版本号解析与比较（semver 的一个够用子集）。
 *
 * 单独一个文件是为了让**同步引擎**能用它而不牵连启动器：`sync.js` 要比较插件清单里的
 * 版本号，但没道理为此 import registry.js —— 那会连带拖进 settings.js / platform.js
 * 和启动器自己的目录。以后做 dsh 插件时，sync.js + zipfile.js + 这个文件就是完整的一套。
 */

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
