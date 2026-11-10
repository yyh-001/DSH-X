// 跟随上游（设计稿「跟随上游」，第三期）：上游 = 环境所在 GitHub 仓库的 release。
//
// 这里只放纯规则：哪个 release 算「有新版本」、换上游层之后要给用户看哪些差别。
// 取 release / 市场索引、下载、装 DSH、存清单都在 server.js；上游层怎么换、增量怎么重放
// 归 environments.js（增量的规则只有那一份）。
import { diffPluginLists, effectiveList, effectivePlugins, withUpstreamBase } from './environments.js'
import { cmpVer, parseVer } from './version.js'

export const ENVIRONMENT_UPSTREAM = Object.freeze({
  // release 的 tag 常写成 v1.2.0；比版本时去掉这个前缀
  TAG_PREFIX_RE: /^v(?=\d)/i,
  // 检查更新时取最近几个 release：够跳过几个预发布 / 草稿找到正式版，又只占一次 GitHub 请求
  RELEASES_PER_PAGE: 10,
  // 本地增量和上游这次改动撞在同一个插件上的几种情形（界面按它挑文案）
  CONFLICT: Object.freeze({
    CHANGED: 'changed', // 本地钉了一个版本，上游这次也换了它的版本：本地那份照留
    REMOVED: 'removed', // 本地删掉了它，上游这次又换了它的版本：照样删着
    DROPPED: 'dropped', // 本地钉了一个版本，上游这次把它删了：本地那份照留，挂载也照留
  }),
})

/** release 的 tag → 版本号（v1.2.0 → 1.2.0；不是版本号形状的原样返回）。 */
export function releaseVersion(tag) {
  return String(tag ?? '').trim().replace(ENVIRONMENT_UPSTREAM.TAG_PREFIX_RE, '')
}

export function isPrereleaseVersion(text) {
  return Boolean(parseVer(releaseVersion(text))?.pre)
}

/**
 * 环境现在装的是上游的哪一版：release 的 tag 优先（上游就是按 release 发的，候选也是 tag），
 * 没有 tag 才看包里的版本号；外加它是不是预发布（设计稿「默认」：装的是预发布才提示预发布）。
 * 预发布看两处：装的时候 GitHub 给的 prerelease 标记（记在来源里），或者版本号本身是预发布形状。
 */
export function installedUpstream(env) {
  const release = env.source?.release || ''
  const version = releaseVersion(release) || env.source?.packVersion || env.packVersion || ''
  return { release, version, prerelease: env.source?.prerelease === true || isPrereleaseVersion(version) }
}

/** GitHub releases 接口的一条 → 候选版本。tag 是预发布形状的也算预发布，作者忘了勾标记也不会推给正式版用户。 */
export function releaseCandidate(release) {
  const tag = String(release?.tag_name || '')
  return {
    release: tag,
    version: releaseVersion(tag),
    prerelease: release?.prerelease === true || isPrereleaseVersion(tag),
    draft: release?.draft === true,
  }
}

/** 市场条目 → 候选版本：市场索引只给最新那一版，没有 tag。 */
export function marketCandidate(entry) {
  const version = String(entry?.version || '')
  return { release: '', version, prerelease: isPrereleaseVersion(version), draft: false }
}

/**
 * 候选里能提示的那个：草稿不算；预发布只给装着预发布的环境。能比版本的挑版本最高的
 * （GitHub 按发布时间排，作者给旧版本补发一个修复版时，最新发布的不一定是最高版本）；
 * 都不是版本号形状时取最近发布的那个。
 */
export function eligibleCandidate(candidates, installed) {
  const eligible = candidates.filter((item) => !item.draft && (!item.prerelease || installed.prerelease))
  const versioned = eligible.filter((item) => parseVer(item.version))
  if (!versioned.length) return eligible[0] || null
  return versioned.reduce((best, item) => (cmpVer(parseVer(item.version), parseVer(best.version)) > 0 ? item : best))
}

/**
 * 候选是不是比装着的新。两边都是版本号就按版本比（不会把旧版当更新推出来）；
 * 不是版本号形状的 tag 只能看是不是换了一个。
 */
export function isNewerUpstream(candidate, installed) {
  if (!candidate) return false
  if (candidate.release && candidate.release === installed.release) return false
  const next = parseVer(candidate.version)
  const current = parseVer(installed.version)
  if (next && current) return cmpVer(next, current) > 0
  const label = candidate.release || candidate.version
  return Boolean(label) && label !== (installed.release || installed.version)
}

const unique = (items) => [...new Set(items)]

/**
 * 应用上游更新前给用户看的差别（设计稿「应用更新的步骤」）：DSH 版本、生效清单里加 / 删 / 换了
 * 哪些插件、本地增量里哪些和新上游重复（自动去掉）、哪些和上游这次的改动撞了（本地照留）、
 * 上游换了 DSH 版本时哪些本地插件没经过上游作者验证。
 * @param before 更新前的环境
 * @param after  换好上游层、重放过增量的环境
 */
export function upstreamUpdateReport(before, after) {
  const { delta } = before
  const oldBase = before.base
  const newBase = after.base
  const duplicates = []
  const conflicts = []
  for (const [name, spec] of Object.entries(delta.dependencies)) {
    const upstream = newBase.dependencies[name]
    const before = oldBase.dependencies[name]
    if (upstream === spec) duplicates.push(name)
    else if (upstream === undefined && before !== undefined) {
      conflicts.push({ name, kind: ENVIRONMENT_UPSTREAM.CONFLICT.DROPPED, local: spec, from: before, to: '' })
    } else if (upstream !== undefined && upstream !== before) {
      conflicts.push({ name, kind: ENVIRONMENT_UPSTREAM.CONFLICT.CHANGED, local: spec, from: before || '', to: upstream })
    }
  }
  for (const name of delta.removed) {
    const upstream = newBase.dependencies[name]
    if (upstream === undefined) duplicates.push(name)
    else if (upstream !== oldBase.dependencies[name]) {
      conflicts.push({ name, kind: ENVIRONMENT_UPSTREAM.CONFLICT.REMOVED, local: '', from: oldBase.dependencies[name] || '', to: upstream })
    }
  }
  // 挂载那一半只在整条改动都和新上游一样时才算重复：本地加的插件上游也加了、版本却不同，
  // 那是冲突（本地版本照留），不能同时说它「和上游一样会去掉」
  const conflicting = new Set(conflicts.map((item) => item.name))
  duplicates.push(...delta.bundlesAdded.filter((name) => newBase.bundles.includes(name) && !conflicting.has(name)))
  duplicates.push(...delta.bundlesRemoved.filter((name) => !newBase.bundles.includes(name) && !conflicting.has(name)))
  const upstreamDshChanged = oldBase.dshVersion !== newBase.dshVersion
  // 本地加的 / 换了版本的插件：上游作者只在他那份清单上验证过新 DSH 版本，这些没人验证过
  const localPlugins = unique([...Object.keys(after.delta.dependencies), ...after.delta.bundlesAdded])
  const was = effectivePlugins(before)
  const now = effectivePlugins(after)
  return {
    dsh: {
      from: was.dshVersion,
      to: now.dshVersion,
      upstreamFrom: oldBase.dshVersion,
      upstreamTo: newBase.dshVersion,
      // 本地钉过 DSH 版本：上游换版本也照用本地那个
      local: after.delta.dshVersion,
    },
    plugins: diffPluginLists(effectiveList(before), effectiveList(after)),
    duplicates: unique(duplicates),
    conflicts,
    unverified: upstreamDshChanged ? localPlugins : [],
  }
}

/**
 * 应用一次上游更新后的环境：上游层换成新包的（withUpstreamBase 重放本地增量），来源记下这次的
 * release / 包版本，离线文件记成新包的那几份——旧版本的文件还留在磁盘上，切回旧清单时用得上。
 * @param upstream {dshVersion, list（离线坐标已换成本地路径）, source, packVersion, files}
 */
export function updatedFromUpstream(env, upstream, { discard = [], now } = {}) {
  const next = withUpstreamBase(env, { dshVersion: upstream.dshVersion, ...upstream.list }, { discard, now })
  return {
    ...next,
    source: upstream.source,
    ...(upstream.packVersion ? { packVersion: upstream.packVersion } : {}),
    files: upstream.files,
  }
}
