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
