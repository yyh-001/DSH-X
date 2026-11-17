/**
 * 跟随上游（第三期）的纯规则（集成测试）：environment-upstream.js 的版本判断与差别报告、
 * environments.js 的换上游层 / 重放增量、EnvironmentStore 的旧清单备份（真落盘到临时目录）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   Q1 哪个 release 算数：草稿永远不算；预发布只在装着的也是预发布时才算；semver 预发布形状的 tag
 *      （v1.2.0-rc.1）哪怕 GitHub 的标记是 false 也算预发布
 *   Q2 新版本：最新一个合格的候选比装着的新才提示；两边都是 semver 就按 semver 比（旧版永远不提示），
 *      否则「新」= 换了一个 tag
 *   Q3 装着的版本：source.release 优先，其次 source.packVersion，最后 packVersion
 *   Q4 差别报告：DSH 版本变化；生效清单里加 / 删 / 换了哪些插件；重复（增量里和新上游一模一样的条目，
 *      或删掉的东西上游也删了）；冲突 changed（本地钉了 X、上游这次也换了 X）/ removed（本地删了 X、
 *      上游这次换了 X）；unverified = 重放后还留着的本地加 / 换的插件，只在上游换了 DSH 版本时才有
 *   Q5 应用：上游层整份换成新的（清单 + DSH 版本）；增量重放——本地钉的压过上游、本地删的照删、
 *      本地加的照留，和新上游一样的条目从增量里去掉；discard 点名的插件丢掉本地改动、回到上游那份；
 *      来源记新版本、仍跟随；packVersion 更新；离线文件记成新包的
 *   Q6 备份：旧清单存到 <envs>/<id>/history/<时间戳>.json，history 新到旧列出，readHistory 读回；
 *      坏名字（路径穿越、不是 <时间戳>.json）拒绝
 *
 *
 * 第二轮需求（评审修复之后）：
 *   A1 新冲突 kind dropped：本地钉了 x 的版本、旧上游有 x、新上游整个删了 x → {name:x, kind:'dropped', local, from, to:''}，x 不算重复
 *   A2 应用这种更新：x 以本地版本留在生效依赖里；原来挂载着就继续挂载，原来只是依赖从没挂载就不挂载；
 *      上游留着 x 但不再挂载、本地只钉了版本 → 上游的「不挂载」生效
 *   A3 eligibleCandidate 在合格候选里取 semver 最高的，不是列表第一个；合格候选都不是 semver 时取第一个合格的
 *   A4 env.source.prerelease === true 时 installedUpstream 的 prerelease 为真（GitHub 上勾了 Pre-release 的 v1.3.0），
 *      版本号是预发布形状也为真；normalizeSource 只保留 prerelease: true，别的值一律去掉
 *   A5 isLocalSpec / localSpecPath 认裸路径：./x、../x、/abs/x、C:\x → {protocol:'', path:原样}；1.2.3、github:o/r、npm:a@1、https://…tgz → null
 *   A15 tarballFiles / 敏感文件检查按 pax（x 类型的 path= 记录）和 GNU 长名（L）头读出真路径：路径超过 100 个字符、
 *       深处的 .env 照样报出来；PaxHeader/… 这种名字永远不当成文件
 *
 * 设计：等价类（tag 形状：正式 / 预发布 / 非 semver）、边界值（相邻补丁号、相等版本、预发布与同号正式版）、
 * 决策表（候选「草稿 × 预发布 × 装着的是不是预发布」；装着版本的三个来源字段；增量条目种类 × 上游这次动没动它）、
 * 状态迁移（存档 → 再存档 → 新到旧排序 → 读回）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { isolateUserHome } from './isolated-home.mjs'

// 这几个模块本身不定 APP_DIR，但按仓库规矩：任何业务模块都在隔离 HOME 之后再动态导入，免得哪天依赖链变了读到真目录
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-env-upstream-'))
isolateUserHome(join(ROOT, 'user'))
const {
  ENVIRONMENT_UPSTREAM, eligibleCandidate, installedUpstream, isNewerUpstream, isPrereleaseVersion, marketCandidate,
  releaseCandidate, releaseVersion, updatedFromUpstream, upstreamUpdateReport,
} = await import('../src/environment-upstream.js')
const { EnvironmentStore, effectivePlugins, isLocalSpec, localSpecPath, normalizeEnvironment, normalizeSource, withUpstreamBase } = await import('../src/environments.js')
const { sensitiveTarballFiles, tarballFiles } = await import('../src/environment-pack.js')
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
const P = (key) => `dsh-x-${key}`
const sorted = (items) => [...new Set(items)].sort()
/** 报告里的名字集合：兼容「名字数组 / 对象数组 / 名字 → 内容的表」三种写法，契约只说了是哪些插件。 */
const namesIn = (value) => sorted(Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : item?.name)) : Object.keys(value || {}))
const changeOf = (changed, name) => (Array.isArray(changed) ? changed.find((item) => item?.name === name) : changed?.[name])

const githubSource = (fields = {}) => ({ kind: 'github', repo: 'octo/env', following: true, ...fields })
/** 一个跟随上游的环境（过 normalizeEnvironment，和磁盘上读出来的形状一样）。 */
function followingEnv({ base, delta = {}, source = githubSource({ release: 'v1.0.0', packVersion: '1.0.0' }), packVersion = '1.0.0', name = '跟随中' }) {
  return normalizeEnvironment({ id: 'up-env', name, base, delta, source, ...(packVersion ? { packVersion } : {}) })
}
const releaseOf = (tag, flags = {}) => ({ tag_name: tag, name: tag, draft: false, prerelease: false, assets: [], ...flags })

// ---------------------------------------------------------------- 常量与 tag 形状

test('Q1 常量：冲突两种 kind 是 changed / removed；每次取的 release 数是 GitHub 允许的正整数；tag 前缀是正则', () => {
  // 界面按 kind 挑文案，值写错界面就认不出
  assert.equal(ENVIRONMENT_UPSTREAM.CONFLICT.CHANGED, 'changed')
  assert.equal(ENVIRONMENT_UPSTREAM.CONFLICT.REMOVED, 'removed')
  // GitHub 的 per_page 上限是 100；0 或小数会让检查要么取不到、要么被 GitHub 忽略
  assert.ok(Number.isInteger(ENVIRONMENT_UPSTREAM.RELEASES_PER_PAGE), '要是整数')
  assert.ok(ENVIRONMENT_UPSTREAM.RELEASES_PER_PAGE >= 1 && ENVIRONMENT_UPSTREAM.RELEASES_PER_PAGE <= 100, `超出 GitHub 范围：${ENVIRONMENT_UPSTREAM.RELEASES_PER_PAGE}`)
  assert.ok(ENVIRONMENT_UPSTREAM.TAG_PREFIX_RE instanceof RegExp)
})

test('Q2 releaseVersion：v1.2.0 → 1.2.0；本来就没有 v 的原样；预发布段跟着保留', () => {
  // 等价类：带 v 前缀 / 不带前缀 / 带预发布段——比版本之前都要先去掉前缀
  assert.equal(releaseVersion('v1.2.0'), '1.2.0')
  assert.equal(releaseVersion('1.2.0'), '1.2.0')
  assert.equal(releaseVersion('v1.2.0-rc.1'), '1.2.0-rc.1')
})

test('Q1 isPrereleaseVersion：semver 预发布段（含 v 前缀）算；正式版、构建元数据、空串不算', () => {
  for (const text of ['1.2.0-rc.1', 'v1.2.0-rc.1', 'v2.0.0-alpha.3', '0.1.0-beta']) assert.equal(isPrereleaseVersion(text), true, text)
  // 边界：+build 是构建元数据，semver 里不算预发布
  for (const text of ['1.2.0', 'v1.2.0', '1.2.0+build.5', '']) assert.equal(isPrereleaseVersion(text), false, JSON.stringify(text))
})

// ---------------------------------------------------------------- 候选版本

test('Q1 releaseCandidate：tag、去前缀的版本、预发布（标记或 tag 形状任一）、草稿', () => {
  assert.deepEqual(releaseCandidate(releaseOf('v1.2.0')), { release: 'v1.2.0', version: '1.2.0', prerelease: false, draft: false })
  // 作者忘了勾预发布：tag 形状是预发布就得当预发布，不然正式版用户会被推一个 rc
  assert.equal(releaseCandidate(releaseOf('v1.2.0-rc.1', { prerelease: false })).prerelease, true)
  assert.equal(releaseCandidate(releaseOf('v1.2.0', { prerelease: true })).prerelease, true, 'GitHub 标记了预发布也算')
  assert.equal(releaseCandidate(releaseOf('v1.2.0', { draft: true })).draft, true)
})

test('Q1 marketCandidate：市场条目的版本号成为候选，版本形状是预发布就算预发布，市场条目不会是草稿', () => {
  const stable = marketCandidate({ id: 'octo.env', version: '2.0.0' })
  assert.equal(stable.version, '2.0.0')
  assert.equal(stable.prerelease, false)
  assert.equal(stable.draft, false)
  assert.equal(marketCandidate({ id: 'octo.env', version: '2.0.0-rc.1' }).prerelease, true)
})

test('Q1 决策表 eligibleCandidate：草稿永远跳过；预发布只给装着预发布的；取合格候选里版本最高的', () => {
  // GitHub 按发布时间新到旧排：最新的是草稿，其次是勾了标记的预发布、没勾标记但 tag 是 rc 的，再往后才是正式版
  const list = [
    releaseOf('v3.0.0', { draft: true }),
    releaseOf('v2.1.0', { prerelease: true }),
    releaseOf('v2.0.5-rc.1'),
    releaseOf('v2.0.0'),
    releaseOf('v1.0.0'),
  ].map(releaseCandidate)
  const stable = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } }))
  assert.equal(stable.prerelease, false, '前置条件：装着的是正式版')
  assert.equal(eligibleCandidate(list, stable)?.release, 'v2.0.0', '正式版用户：跳过草稿和两种预发布')

  const pre = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v2.0.0-rc.1', packVersion: '2.0.0-rc.1' }), packVersion: '2.0.0-rc.1' }))
  assert.equal(pre.prerelease, true, '前置条件：装着的是预发布')
  assert.equal(eligibleCandidate(list, pre)?.release, 'v2.1.0', '预发布用户：预发布也算，但草稿照样跳过')

  // 草稿即便是预发布、即便装着的是预发布也不算
  assert.equal(eligibleCandidate([releaseOf('v3.0.0-rc.1', { draft: true, prerelease: true }), releaseOf('v2.0.0')].map(releaseCandidate), pre)?.release, 'v2.0.0')
})

test('Q1 eligibleCandidate 边界：全是草稿 / 预发布（装着正式版）或者空列表 → 没有能提示的', () => {
  const stable = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } }))
  const onlyPre = [releaseOf('v1.1.0-rc.1'), releaseOf('v1.1.0', { draft: true }), releaseOf('v1.0.5', { prerelease: true })].map(releaseCandidate)
  assert.ok(!eligibleCandidate(onlyPre, stable), '没有合格的候选')
  assert.ok(!eligibleCandidate([], stable), '空列表没有候选')
})

// ---------------------------------------------------------------- 装着的版本（Q3）

test('Q3 决策表 installedUpstream：source.release → source.packVersion → packVersion，依次兜底', () => {
  const env = (source, packVersion) => followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource(source), packVersion })
  // 只有 release tag：版本从 tag 去前缀来
  assert.equal(installedUpstream(env({ release: 'v2.0.0' }, '')).version, '2.0.0')
  assert.equal(installedUpstream(env({ release: 'v2.0.0' }, '')).release, 'v2.0.0')
  // 没有 release：source.packVersion 压过顶层 packVersion（顶层那个是导出时填的，可能被改过）
  assert.equal(installedUpstream(env({ packVersion: '1.4.0' }, '1.0.0')).version, '1.4.0')
  // 只剩顶层 packVersion
  assert.equal(installedUpstream(env({}, '1.0.0')).version, '1.0.0')
  // 三个字段全一致：最常见的 GitHub 导入
  assert.equal(installedUpstream(env({ release: 'v2.0.0', packVersion: '2.0.0' }, '2.0.0')).version, '2.0.0')
})

test('Q3 installedUpstream：release tag 和包版本不一致时以 release 为准（作者打了 v2.0.0 却没改清单里的 version）', () => {
  // 需求的优先级：source.release 第一。打错清单版本号很常见，tag 才是用户在 GitHub 上看到的那个
  const installed = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v2.0.0', packVersion: '1.0.0' }), packVersion: '1.0.0' }))
  assert.equal(installed.version, '2.0.0', `装着的版本要取 release：${JSON.stringify(installed)}`)
  // 由此推出：上游后来发了 v1.5.0（比 v2.0.0 旧）不该被当成新版本
  assert.equal(isNewerUpstream(releaseCandidate(releaseOf('v1.5.0')), installed), false, '比装着的 release 旧的版本不该提示')
})

test('Q1 installedUpstream.prerelease：release 或包版本是预发布形状就算预发布', () => {
  assert.equal(installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v1.0.0-rc.2', packVersion: '1.0.0-rc.2' }), packVersion: '' })).prerelease, true)
  assert.equal(installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ packVersion: '1.0.0-beta.1' }), packVersion: '' })).prerelease, true, '没有 tag 只有包版本')
  assert.equal(installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } })).prerelease, false)
})

// ---------------------------------------------------------------- 新版本（Q2）

test('Q2 边界值 isNewerUpstream（semver）：大一个补丁号算新；相等不算；小一个补丁号（旧版）不算', () => {
  const installed = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v1.2.0', packVersion: '1.2.0' }), packVersion: '1.2.0' }))
  const newer = (tag) => isNewerUpstream(releaseCandidate(releaseOf(tag)), installed)
  assert.equal(newer('v1.2.1'), true, '1.2.1 > 1.2.0')
  assert.equal(newer('v1.2.0'), false, '同一个版本')
  assert.equal(newer('v1.1.9'), false, '旧版永远不提示，哪怕 tag 不一样')
  assert.equal(newer('v2.0.0'), true)
  assert.equal(newer('1.3.0'), true, 'tag 不带 v 也按版本比')
})

test('Q2 边界值 isNewerUpstream（预发布）：正式版比同号 rc 新；rc.2 比 rc.1 新；rc 比同号正式版旧', () => {
  const at = (tag) => installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: tag, packVersion: releaseVersion(tag) }), packVersion: releaseVersion(tag) }))
  const cand = (tag) => releaseCandidate(releaseOf(tag))
  assert.equal(isNewerUpstream(cand('v1.2.0'), at('v1.2.0-rc.1')), true)
  assert.equal(isNewerUpstream(cand('v1.2.0-rc.2'), at('v1.2.0-rc.1')), true)
  assert.equal(isNewerUpstream(cand('v1.2.0-rc.1'), at('v1.2.0')), false)
})

test('Q2 isNewerUpstream（不是 semver 的 tag）：换了一个 tag 就算新，同一个 tag 不算', () => {
  // 有的仓库按日期打 tag：比不了大小，只能看是不是换了一个
  const installed = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'nightly-20261110', packVersion: '1.0.0' }), packVersion: '1.0.0' }))
  assert.equal(isNewerUpstream(releaseCandidate(releaseOf('nightly-20261111')), installed), true)
  assert.equal(isNewerUpstream(releaseCandidate(releaseOf('nightly-20261110')), installed), false)
})

test('Q2 isNewerUpstream：没有候选（null）不算新；市场候选按版本号比', () => {
  const installed = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: { kind: 'market', repo: 'octo/env', marketId: 'octo.env', packVersion: '1.0.0', following: true } }))
  assert.equal(isNewerUpstream(null, installed), false)
  assert.equal(isNewerUpstream(marketCandidate({ version: '1.1.0' }), installed), true)
  assert.equal(isNewerUpstream(marketCandidate({ version: '1.0.0' }), installed), false)
  assert.equal(isNewerUpstream(marketCandidate({ version: '0.9.0' }), installed), false, '市场索引回退到旧版也不提示')
})

// ---------------------------------------------------------------- 差别报告（Q4）与应用（Q5）

// 决策表：增量里每一种条目 × 上游这次对它做了什么。名字后面的注释是这一行要验的格子。
const OLD_DEPS = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'k', 'l'].map((key) => [P(key), '1.0.0']))
const OLD_BASE = { dshVersion: '1.0.0', dependencies: OLD_DEPS, bundles: [BASE, WEB, ...Object.keys(OLD_DEPS)] }
const DELTA = {
  dependencies: {
    [P('a')]: '1.5.0', // 本地钉了 a，上游也换了 a → 冲突 changed，本地照留
    [P('b')]: '2.0.0', // 本地钉了 b，上游换成同一个版本 → 重复，从增量去掉
    [P('c')]: '1.5.0', // 本地钉了 c，上游没动 → 照留，不算冲突
    [P('g')]: '1.0.0', // 本地加了 g，上游没有 → 照留
    [P('h')]: '1.0.0', // 本地加了 h，上游这次也加了同一个版本 → 重复
    [P('i')]: '1.0.0', // 本地加了 i，上游这次加了另一个版本 → 上游「改了」i，冲突 changed，本地照留
  },
  removed: [P('d'), P('e'), P('f')], // d：上游换了版本 → 冲突 removed；e：上游也删了 → 重复；f：上游没动 → 照删
  bundlesAdded: [P('g'), P('h'), P('i')],
  bundlesRemoved: [P('d'), P('e'), P('f')],
}
const NEW_DEPS = {
  [P('a')]: '2.0.0', [P('b')]: '2.0.0', [P('c')]: '1.0.0', [P('d')]: '2.0.0', [P('f')]: '1.0.0',
  [P('h')]: '1.0.0', [P('i')]: '2.0.0', [P('j')]: '1.0.0', [P('l')]: '1.1.0',
} // e、k 被上游删了；j 是上游新加的；l 是上游换了版本、本地没碰
const NEW_LIST = { dependencies: NEW_DEPS, bundles: [BASE, WEB, ...Object.keys(NEW_DEPS)] }
const newSource = () => githubSource({ release: 'v1.1.0', packVersion: '1.1.0' })
const upstream = (patch = {}) => ({ dshVersion: '1.1.0', list: NEW_LIST, source: newSource(), packVersion: '1.1.0', files: {}, ...patch })
const scenario = (delta = DELTA) => followingEnv({ base: OLD_BASE, delta })

test('Q4 决策表 重复：b（钉成和新上游同一个版本）、e（上游也删了）、h（上游加了同一个版本）；其余格子都不是重复', () => {
  const before = scenario()
  const duplicates = sorted(upstreamUpdateReport(before, updatedFromUpstream(before, upstream())).duplicates)
  for (const name of [P('b'), P('e'), P('h')]) assert.ok(duplicates.includes(name), `${name} 要报成重复：${JSON.stringify(duplicates)}`)
  // a：本地钉的和上游不一样（冲突）；c：上游没动；d：上游换了版本（冲突）；f：上游没动；g：上游没有
  for (const name of [P('a'), P('c'), P('d'), P('f'), P('g')]) assert.ok(!duplicates.includes(name), `${name} 不是重复：${JSON.stringify(duplicates)}`)
})

test('Q4 重复的边界：本地加了 i@1.0.0、上游加的是 i@2.0.0——版本不同就不算「一模一样」，i 是冲突，不能同时报成重复', () => {
  // 重复 = 增量条目和新上游一模一样（会被自动去掉）；i 的本地版本和上游不同、会被照留，
  // 同时报成「重复（自动去掉）」和「冲突（本地照留）」两种互相矛盾的说法，用户没法判断
  const before = scenario()
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  assert.ok(report.conflicts.some((item) => item.name === P('i')), '前置条件：i 报成了冲突')
  assert.ok(!report.duplicates.includes(P('i')), `i 不该出现在重复里：${JSON.stringify(report.duplicates)}`)
})

test('Q4 决策表 冲突：a（本地钉、上游换）→ changed；d（本地删、上游换）→ removed；i（本地加、上游加了别的版本）→ changed；只有这三个', () => {
  const before = scenario()
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  const conflicts = Object.fromEntries(report.conflicts.map((item) => [item.name, item]))
  assert.deepEqual(Object.keys(conflicts).sort(), [P('a'), P('d'), P('i')], `冲突：${JSON.stringify(report.conflicts)}`)
  assert.equal(conflicts[P('a')].kind, 'changed')
  assert.equal(conflicts[P('a')].local, '1.5.0')
  assert.equal(conflicts[P('a')].from, '1.0.0')
  assert.equal(conflicts[P('a')].to, '2.0.0')
  assert.equal(conflicts[P('d')].kind, 'removed')
  assert.equal(conflicts[P('d')].from, '1.0.0')
  assert.equal(conflicts[P('d')].to, '2.0.0')
  assert.equal(conflicts[P('i')].kind, 'changed', '上游新加了本地也加过的插件（版本不同），也是上游改了它')
  assert.equal(conflicts[P('i')].local, '1.0.0')
  assert.ok(!conflicts[P('i')].from, '上游以前没有 i')
  assert.equal(conflicts[P('i')].to, '2.0.0')
})

test('Q4 差别报告：生效清单里加了 j、删了 k、换了 l；本地钉住的 a / i 生效值没变，不出现在「换了」里', () => {
  const before = scenario()
  const { plugins } = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  assert.deepEqual(namesIn(plugins.added), [P('j')])
  assert.deepEqual(namesIn(plugins.removed), [P('k')])
  assert.deepEqual(namesIn(plugins.changed), [P('l')], `换了：${JSON.stringify(plugins.changed)}`)
  assert.equal(changeOf(plugins.changed, P('l'))?.from, '1.0.0')
  assert.equal(changeOf(plugins.changed, P('l'))?.to, '1.1.0')
  assert.ok(namesIn(plugins.bundlesAdded).includes(P('j')), '挂载顺序里也加了 j')
  assert.ok(namesIn(plugins.bundlesRemoved).includes(P('k')), '挂载顺序里也删了 k')
})

test('Q4 差别报告 DSH：上游 1.0.0 → 1.1.0、本地没钉：from/to 与 upstreamFrom/upstreamTo 一致，local 为空', () => {
  const before = scenario()
  const { dsh } = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  assert.equal(dsh.from, '1.0.0')
  assert.equal(dsh.to, '1.1.0')
  assert.equal(dsh.upstreamFrom, '1.0.0')
  assert.equal(dsh.upstreamTo, '1.1.0')
  assert.ok(!dsh.local, `本地没钉 DSH：${JSON.stringify(dsh)}`)
})

test('Q4 差别报告 DSH：本地钉了 1.0.5、上游换到 1.1.0 → 生效版本前后都是 1.0.5，local 报出钉的版本', () => {
  const before = scenario({ ...DELTA, dshVersion: '1.0.5' })
  const { dsh } = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  assert.equal(dsh.from, '1.0.5')
  assert.equal(dsh.to, '1.0.5', '本地钉的 DSH 压过上游')
  assert.equal(dsh.upstreamFrom, '1.0.0')
  assert.equal(dsh.upstreamTo, '1.1.0')
  assert.equal(dsh.local, '1.0.5')
})

test('Q4 unverified：上游换了 DSH 版本 → 重放后还留着的本地加 / 换的插件；重复的和本地删的不算', () => {
  const before = scenario()
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, upstream()))
  // a / c 是本地换的版本，g / i 是本地加的；b / h 和新上游一样已经去掉，d / f 是删除不是加 / 换
  assert.deepEqual(sorted(report.unverified), [P('a'), P('c'), P('g'), P('i')], JSON.stringify(report.unverified))
})

test('Q4 unverified：上游没换 DSH 版本 → 空，哪怕本地加 / 换了插件', () => {
  const before = scenario()
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, upstream({ dshVersion: '1.0.0' })))
  assert.deepEqual(report.unverified, [])
})

test('Q5 应用：上游层整份换成新包的清单和 DSH 版本', () => {
  const after = updatedFromUpstream(scenario(), upstream())
  assert.equal(after.base.dshVersion, '1.1.0')
  assert.deepEqual(after.base.dependencies, NEW_DEPS)
  assert.deepEqual(after.base.bundles, NEW_LIST.bundles)
})

test('Q5 应用：增量重放——钉的压过上游、删的照删、加的照留；生效清单逐项核对', () => {
  const after = updatedFromUpstream(scenario(), upstream())
  const effective = effectivePlugins(after)
  assert.deepEqual(effective.dependencies, {
    [P('a')]: '1.5.0', [P('b')]: '2.0.0', [P('c')]: '1.5.0', [P('g')]: '1.0.0', [P('h')]: '1.0.0', [P('i')]: '1.0.0', [P('j')]: '1.0.0', [P('l')]: '1.1.0',
  }, '本地删的 d / f 不回来，上游删的 e / k 不在')
  for (const name of [P('g'), P('h'), P('i'), P('j')]) assert.ok(effective.bundles.includes(name), `${name} 要挂载`)
  for (const name of [P('d'), P('e'), P('f'), P('k')]) assert.ok(!effective.bundles.includes(name), `${name} 不该挂载`)
  assert.equal(effective.dshVersion, '1.1.0')
})

test('Q5 应用：和新上游一模一样的增量条目被去掉（b / h 的钉版本、e 的删除、h / i 的挂载）', () => {
  const { delta } = updatedFromUpstream(scenario(), upstream())
  assert.deepEqual(delta.dependencies, { [P('a')]: '1.5.0', [P('c')]: '1.5.0', [P('g')]: '1.0.0', [P('i')]: '1.0.0' })
  assert.deepEqual(sorted(delta.removed), [P('d'), P('f')], '上游也删了 e，增量里的删除没意义了')
  assert.deepEqual(sorted(delta.bundlesAdded), [P('g')], '上游已经挂载 h / i')
  assert.deepEqual(sorted(delta.bundlesRemoved), [P('d'), P('f')], '上游不再挂载 e')
})

test('Q5 discard：点名的插件丢掉本地改动回到上游——钉的回上游版本、删的回来、加的消失；没点名的不动', () => {
  const after = updatedFromUpstream(scenario(), upstream(), { discard: [P('a'), P('d'), P('g')] })
  const effective = effectivePlugins(after)
  assert.equal(effective.dependencies[P('a')], '2.0.0', '钉的版本丢掉，回到上游 2.0.0')
  assert.equal(effective.dependencies[P('d')], '2.0.0', '本地的删除丢掉，上游那份回来')
  assert.ok(effective.bundles.includes(P('d')), 'd 的挂载也回来')
  assert.equal(effective.dependencies[P('g')], undefined, '上游没有 g：本地加的丢掉就没了')
  assert.ok(!effective.bundles.includes(P('g')))
  assert.equal(effective.dependencies[P('c')], '1.5.0', '没点名的本地改动照留')
  assert.equal(effective.dependencies[P('f')], undefined, '没点名的删除照删')
  for (const name of [P('a'), P('d'), P('g')]) {
    assert.ok(!Object.hasOwn(after.delta.dependencies, name) && !after.delta.removed.includes(name), `${name} 不该还在增量里`)
  }
})

test('Q5 决策表 本地钉的 DSH 版本：和新上游不同 → 照留并生效；和新上游相同 → 从增量去掉', () => {
  const kept = updatedFromUpstream(scenario({ ...DELTA, dshVersion: '1.0.5' }), upstream())
  assert.equal(effectivePlugins(kept).dshVersion, '1.0.5')
  assert.equal(kept.delta.dshVersion, '1.0.5')
  const same = updatedFromUpstream(scenario({ ...DELTA, dshVersion: '1.1.0' }), upstream())
  assert.equal(effectivePlugins(same).dshVersion, '1.1.0')
  assert.ok(!same.delta.dshVersion, '和新上游一样的 DSH 钉版本没意义了')
  const none = updatedFromUpstream(scenario(), upstream())
  assert.ok(!none.delta.dshVersion)
})

test('Q5 应用：来源记下新的 release / 包版本、仍然跟随；packVersion 更新；离线文件记成新包的', () => {
  const files = { [P('local')]: { file: 'dsh-x-local-1.1.0.tgz', sha256: 'b'.repeat(64) } }
  const after = normalizeEnvironment(updatedFromUpstream(scenario(), upstream({ files })))
  assert.equal(after.source.release, 'v1.1.0')
  assert.equal(after.source.packVersion, '1.1.0')
  assert.equal(after.source.repo, 'octo/env')
  assert.equal(after.source.following, true, '更新之后仍跟随上游')
  assert.equal(after.packVersion, '1.1.0')
  assert.deepEqual(after.files, files)
})

test('Q5 应用是纯函数：不改传进来的环境对象（检查更新时要拿它跟新的比）', () => {
  const before = scenario()
  const snapshot = structuredClone(before)
  updatedFromUpstream(before, upstream(), { discard: [P('a')] })
  withUpstreamBase(before, { dshVersion: '1.1.0', ...NEW_LIST }, { discard: [P('c')] })
  assert.deepEqual(before, snapshot)
})

test('Q5 withUpstreamBase：直接换上游层，规则同上（钉的照留、重复的去掉、discard 回上游）', () => {
  const after = withUpstreamBase(scenario(), { dshVersion: '1.1.0', ...NEW_LIST }, { discard: [P('c')] })
  assert.equal(after.base.dshVersion, '1.1.0')
  assert.deepEqual(after.base.dependencies, NEW_DEPS)
  const effective = effectivePlugins(after)
  assert.equal(effective.dependencies[P('a')], '1.5.0', '钉的照留')
  assert.equal(effective.dependencies[P('c')], '1.0.0', 'discard 的回到上游')
  assert.ok(!Object.hasOwn(after.delta.dependencies, P('b')), '重复的去掉')
  assert.equal(after.source?.following, true, '换上游层不改来源的跟随状态')
})

// ---------------------------------------------------------------- 旧清单备份（Q6）

test('Q6 状态迁移 存档：archive 写到 <envs>/<id>/history/<时间戳>.json，内容就是那份清单；再存一份，history 新到旧', async () => {
  const store = new EnvironmentStore(join(ROOT, 'envs-archive'))
  const first = scenario()
  assert.deepEqual(store.history(first.id), [], '还没存过：空列表')
  const name1 = store.archive(first)
  assert.match(name1, /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z?|\d{10,})\.json$/, `备份名要是时间戳：${name1}`)
  const file1 = join(ROOT, 'envs-archive', first.id, 'history', name1)
  assert.ok(existsSync(file1), `备份要落在 ${file1}`)
  const saved = JSON.parse(readFileSync(file1, 'utf8'))
  assert.deepEqual(saved.base, first.base)
  assert.deepEqual(saved.delta, first.delta)
  assert.deepEqual(saved.source, first.source)
  // 时间戳到毫秒：隔一会儿再存，第二份必须是另一个名字，排在前面
  await new Promise((resolve) => setTimeout(resolve, 15))
  const second = updatedFromUpstream(first, upstream())
  const name2 = store.archive(second)
  assert.notEqual(name2, name1, '两次存档不能撞名（撞了就把前一份盖掉了）')
  assert.deepEqual(store.history(first.id), [name2, name1], '新到旧')
})

test('Q6 readHistory：按名字读回那份清单（上游层、增量、来源都在）', () => {
  const store = new EnvironmentStore(join(ROOT, 'envs-read'))
  const env = scenario()
  const name = store.archive(env)
  const back = store.readHistory(env.id, name)
  assert.deepEqual(back.base, env.base)
  assert.deepEqual(back.delta, env.delta)
  assert.deepEqual(back.source, env.source)
  assert.equal(back.name, env.name)
})

test('Q6 readHistory 坏名字：路径穿越、不是 <时间戳>.json、空串、子目录、名字合法但不存在 → 一律拒绝', () => {
  const root = join(ROOT, 'envs-bad')
  const store = new EnvironmentStore(root)
  const env = scenario()
  store.archive(env)
  // 把穿越的目标真的放上合法的清单：如果没拦住，读出来会「成功」，用例就能看出来
  const valid = `${JSON.stringify(env)}\n`
  mkdirSync(join(root, env.id), { recursive: true })
  writeFileSync(join(root, env.id, 'environment.json'), valid)
  writeFileSync(join(root, 'outside.json'), valid)
  writeFileSync(join(root, env.id, 'history', 'notes.json'), valid)
  for (const name of ['../environment.json', '../../outside.json', '..\\environment.json', 'environment.json', 'notes.json', 'notes.txt', '', 'sub/2026-11-11T00-00-00-000Z.json', '2000-01-01T00-00-00-000Z.json']) {
    assert.throws(() => store.readHistory(env.id, name), `「${name}」应被拒绝`)
  }
})

// ================================================================ 第二轮需求

// ---------------------------------------------------------------- A1 / A2：上游删掉了本地钉过的插件

// x：旧上游有、挂载着，本地钉了 1.5.0；n：旧上游只当依赖（不挂载），本地钉了 1.5.0；y：谁都没动。新上游把 x、n 都删了。
const DROP_BASE = { dshVersion: '1.0.0', dependencies: { [P('x')]: '1.0.0', [P('n')]: '1.0.0', [P('y')]: '1.0.0' }, bundles: [BASE, WEB, P('x'), P('y')] }
const DROP_DELTA = { dependencies: { [P('x')]: '1.5.0', [P('n')]: '1.5.0' } }
const DROP_UPSTREAM = { dshVersion: '1.0.0', list: { dependencies: { [P('y')]: '1.0.0' }, bundles: [BASE, WEB, P('y')] }, source: newSource(), packVersion: '1.1.0', files: {} }

test('A1 常量：新冲突 kind DROPPED = dropped', () => {
  assert.equal(ENVIRONMENT_UPSTREAM.CONFLICT.DROPPED, 'dropped')
})

test('A1 决策表 本地钉了版本、新上游整个删掉了它 → 冲突 dropped（local = 本地坐标，from = 旧上游坐标，to 为空），不算重复', () => {
  const before = followingEnv({ base: DROP_BASE, delta: DROP_DELTA })
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, DROP_UPSTREAM))
  for (const name of [P('x'), P('n')]) {
    const hits = report.conflicts.filter((item) => item.name === name)
    assert.equal(hits.length, 1, `${name} 要报一条冲突：${JSON.stringify(report.conflicts)}`)
    assert.deepEqual({ kind: hits[0].kind, local: hits[0].local, from: hits[0].from, to: hits[0].to }, { kind: 'dropped', local: '1.5.0', from: '1.0.0', to: '' }, name)
    assert.ok(!report.duplicates.includes(name), `${name} 不是重复（本地那份要留着）：${JSON.stringify(report.duplicates)}`)
  }
  assert.ok(!report.conflicts.some((item) => item.name === P('y')), '没被动过的 y 不是冲突')
})

test('A1 对照：本地删了 x、上游也删了 x → 是重复不是 dropped（dropped 只给本地钉过版本的）', () => {
  // 区分两格：「本地删 + 上游删」早就是重复（第一轮 Q4 的 e）；新加的 dropped 不能把它也吞掉
  const before = followingEnv({ base: DROP_BASE, delta: { removed: [P('x')], bundlesRemoved: [P('x')] } })
  const report = upstreamUpdateReport(before, updatedFromUpstream(before, DROP_UPSTREAM))
  assert.ok(report.duplicates.includes(P('x')), JSON.stringify(report.duplicates))
  assert.ok(!report.conflicts.some((item) => item.name === P('x')), JSON.stringify(report.conflicts))
})

test('A2 应用 dropped：x 以本地版本留在生效依赖里且继续挂载；n 留在依赖里但不挂载（原来就没挂载）', () => {
  const after = updatedFromUpstream(followingEnv({ base: DROP_BASE, delta: DROP_DELTA }), DROP_UPSTREAM)
  const effective = effectivePlugins(after)
  assert.equal(effective.dependencies[P('x')], '1.5.0', '上游删了，本地钉的那份照留')
  assert.equal(effective.dependencies[P('n')], '1.5.0')
  assert.ok(effective.bundles.includes(P('x')), `x 原来挂载着，要继续挂载：${JSON.stringify(effective.bundles)}`)
  assert.ok(!effective.bundles.includes(P('n')), `n 原来只是依赖，不能因为更新变成挂载：${JSON.stringify(effective.bundles)}`)
  assert.equal(effective.dependencies[P('y')], '1.0.0')
})

test('A2 应用：上游留着 x 但不再挂载、本地只钉了版本 → 依赖是本地版本，挂载以上游为准（不挂）', () => {
  const base = { dshVersion: '1.0.0', dependencies: { [P('x')]: '1.0.0' }, bundles: [BASE, WEB, P('x')] }
  // 两格：上游同时换了版本 / 上游版本没变，只是不挂了
  for (const upstreamSpec of ['1.1.0', '1.0.0']) {
    const after = updatedFromUpstream(followingEnv({ base, delta: { dependencies: { [P('x')]: '1.5.0' } } }), {
      dshVersion: '1.0.0', list: { dependencies: { [P('x')]: upstreamSpec }, bundles: [BASE, WEB] }, source: newSource(), packVersion: '1.1.0', files: {},
    })
    const effective = effectivePlugins(after)
    assert.equal(effective.dependencies[P('x')], '1.5.0', `上游 ${upstreamSpec}：本地钉的版本照留`)
    assert.ok(!effective.bundles.includes(P('x')), `上游 ${upstreamSpec} 不再挂载 x：本地只钉了版本，不该把挂载留下来`)
  }
})

// ---------------------------------------------------------------- A3：取版本最高的合格候选

test('A3 eligibleCandidate：合格候选里取 semver 最高的，不看列表顺序——[v1.2.5（发得最晚）, v2.0.0] → v2.0.0', () => {
  const stable = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } }))
  // 补丁线 v1.2.5 比 v2.0.0 发得晚，GitHub 把它排在最前
  assert.equal(eligibleCandidate([releaseOf('v1.2.5'), releaseOf('v2.0.0')].map(releaseCandidate), stable)?.release, 'v2.0.0')
  assert.equal(eligibleCandidate([releaseOf('v1.0.1'), releaseOf('v1.10.0'), releaseOf('v1.9.0')].map(releaseCandidate), stable)?.release, 'v1.10.0', '按 semver 比，不按字符串比')
})

test('A3 决策表 最高版本只在合格的里挑：更高的草稿 / 预发布（装着正式版）不算；装着预发布时更高的预发布算', () => {
  const list = [releaseOf('v3.0.0', { draft: true }), releaseOf('v2.5.0-rc.1', { prerelease: true }), releaseOf('v1.2.5'), releaseOf('v2.0.0')].map(releaseCandidate)
  const stable = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } }))
  assert.equal(eligibleCandidate(list, stable)?.release, 'v2.0.0')
  const pre = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v2.0.0-rc.1', packVersion: '2.0.0-rc.1' }), packVersion: '2.0.0-rc.1' }))
  assert.equal(eligibleCandidate(list, pre)?.release, 'v2.5.0-rc.1', '草稿 v3.0.0 再高也不算')
})

test('A3 合格候选都不是 semver：取第一个合格的（草稿跳过）；有 semver 的时候取 semver 最高的', () => {
  const stable = installedUpstream(followingEnv({ base: { dshVersion: '1.0.0' } }))
  assert.equal(eligibleCandidate([releaseOf('nightly-c', { draft: true }), releaseOf('nightly-b'), releaseOf('nightly-a')].map(releaseCandidate), stable)?.release, 'nightly-b')
  assert.equal(eligibleCandidate([releaseOf('nightly-x'), releaseOf('v1.0.0'), releaseOf('v0.9.0')].map(releaseCandidate), stable)?.release, 'v1.0.0')
})

// ---------------------------------------------------------------- A4：来源里记下的预发布标记

test('A4 installedUpstream：source.prerelease 为 true 时算预发布，哪怕 tag 是正式版形状（v1.3.0 在 GitHub 上勾了 Pre-release）', () => {
  const env = followingEnv({ base: { dshVersion: '1.0.0' }, source: githubSource({ release: 'v1.3.0', packVersion: '1.3.0', prerelease: true }), packVersion: '1.3.0' })
  assert.equal(env.source.prerelease, true, '前置条件：清单里留住了这个标记')
  const installed = installedUpstream(env)
  assert.equal(installed.prerelease, true)
  assert.equal(installed.version, '1.3.0')
  // 由此推出：预发布候选要提示给它
  assert.equal(eligibleCandidate([releaseOf('v1.4.0-rc.1', { prerelease: true })].map(releaseCandidate), installed)?.release, 'v1.4.0-rc.1')
})

test('A4 决策表 installedUpstream.prerelease：标记 × 版本形状——任一为预发布就是预发布，都不是才算正式版', () => {
  const at = (release, prerelease) => installedUpstream(followingEnv({
    base: { dshVersion: '1.0.0' }, source: githubSource({ release, packVersion: releaseVersion(release), ...(prerelease === undefined ? {} : { prerelease }) }), packVersion: releaseVersion(release),
  })).prerelease
  assert.equal(at('v1.3.0', true), true)
  assert.equal(at('v1.3.0-rc.1', true), true)
  assert.equal(at('v1.3.0-rc.1', undefined), true, '没有标记、版本号是预发布')
  assert.equal(at('v1.3.0', false), false)
  assert.equal(at('v1.3.0', undefined), false)
})

test('A4 normalizeSource：prerelease 只认 true；false、字符串 "true"、1、没有 → 一律去掉这个字段', () => {
  const source = (prerelease) => normalizeSource({ kind: 'github', repo: 'octo/env', release: 'v1.3.0', following: true, ...(prerelease === undefined ? {} : { prerelease }) })
  assert.equal(source(true).prerelease, true)
  for (const value of [false, 'true', 1, null, undefined]) {
    assert.equal(Object.hasOwn(source(value), 'prerelease'), false, `prerelease: ${JSON.stringify(value)} 要去掉`)
  }
})

// ---------------------------------------------------------------- A5：裸路径也是本地坐标

test('A5 等价类 localSpecPath / isLocalSpec 裸路径：./x、../x、/abs/x、C:\\x → {protocol: "", path: 原样}，算本地坐标', () => {
  for (const spec of ['./x', '../x', '/abs/x', 'C:\\x', './dir/plugin.tgz', '../../up/plugin']) {
    assert.deepEqual(localSpecPath(spec), { protocol: '', path: spec }, spec)
    assert.equal(isLocalSpec(spec), true, spec)
  }
})

test('A5 等价类 带协议的本地坐标照旧拆成协议 + 路径', () => {
  assert.deepEqual(localSpecPath('link:../x'), { protocol: 'link:', path: '../x' })
  assert.deepEqual(localSpecPath('file:/abs/x.tgz'), { protocol: 'file:', path: '/abs/x.tgz' })
  assert.equal(isLocalSpec('link:../x'), true)
})

test('A5 等价类 不是本地路径：1.2.3、github:o/r、npm:a@1、https://…tgz、范围、tag → localSpecPath 为 null，不算本地坐标', () => {
  for (const spec of ['1.2.3', 'github:o/r', 'npm:a@1', 'https://example.com/x-1.0.0.tgz', '^1.2.0', 'latest', '']) {
    assert.equal(localSpecPath(spec), null, JSON.stringify(spec))
    assert.equal(isLocalSpec(spec), false, JSON.stringify(spec))
  }
})

// ---------------------------------------------------------------- A15：tarball 里的真路径（pax / GNU 长名）

const TAR_BLOCK = 512
/** 一个 tar 头。type：'0' 普通文件、'x' pax 扩展头、'g' pax 全局头、'L' GNU 长名；gnu = true 用 GNU 的魔数。 */
function tarHeader(name, size, { type = '0', prefix = '', gnu = false } = {}) {
  const header = Buffer.alloc(TAR_BLOCK, 0)
  header.write(name.slice(0, 100), 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(gnu ? 'ustar  \0' : 'ustar\0' + '00', 257, 8, 'ascii')
  if (prefix) header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}
const padded = (data) => Buffer.concat([data, Buffer.alloc((TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK, 0)])
/** pax 记录「<总长> key=value\n」：总长把自己的位数也算进去。 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) length = String(length).length + body.length
  return `${length}${body}`
}
/** entries：{ name, data, type?, prefix?, gnu? } 依次写成 tar 再 gzip。 */
function buildTgz(entries) {
  const chunks = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''))
    chunks.push(tarHeader(entry.name, data.length, entry), padded(data))
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0))
  return gzipSync(Buffer.concat(chunks))
}
const strip = (files) => files.map((file) => String(file).replace(/^package\//, ''))
// 深处的 .env：完整路径 130 多个字符，头里 100 个字符的 name 字段放不下（截断后连 .env 都看不到）
const DEEP_ENV = `package/${'nested-directory-name/'.repeat(5)}config/.env`
const DEEP_README = `package/${'another-long-directory/'.repeat(5)}docs/readme.md`
const COMMON = [{ name: 'package/package.json', data: '{"name":"dsh-x-tar","version":"1.0.0"}\n' }, { name: 'package/index.js', data: 'export default 1\n' }]

test('A15 前置条件：深处 .env 的路径超过 100 个字符，截断到 100 个字符后看不出是 .env', () => {
  assert.ok(DEEP_ENV.length > 100, String(DEEP_ENV.length))
  assert.ok(!DEEP_ENV.slice(0, 100).includes('.env'))
})

test('A15 pax 扩展头（x，path= 记录）：列出的是真路径，深处的 .env 被敏感检查报出来；PaxHeader/… 不当成文件', () => {
  const tgz = buildTgz([
    ...COMMON,
    { name: `PaxHeader/${DEEP_ENV.slice(0, 80)}`, type: 'x', data: paxRecord('path', DEEP_ENV) + paxRecord('mtime', '1767225600') },
    { name: DEEP_ENV.slice(0, 100), data: 'TOKEN=secret\n' },
  ])
  const files = strip(tarballFiles(tgz))
  assert.ok(files.includes(DEEP_ENV.replace(/^package\//, '')), `要读出 pax 里的真路径：${JSON.stringify(files)}`)
  assert.ok(!files.some((file) => /PaxHeader/.test(file)), `PaxHeader 不是文件：${JSON.stringify(files)}`)
  assert.ok(!files.includes(DEEP_ENV.slice(0, 100).replace(/^package\//, '')), '截断的名字不能当成文件名')
  assert.deepEqual(files.filter((file) => !file.endsWith('.env')).sort(), ['index.js', 'package.json'], '普通文件照常列出、不多不少')
  assert.ok(strip(sensitiveTarballFiles(tgz)).includes(DEEP_ENV.replace(/^package\//, '')), '深处的 .env 要报成敏感文件')
})

test('A15 GNU 长名（L，././@LongLink）：列出的是真路径，深处的 .env 被报出来；@LongLink 不当成文件', () => {
  const tgz = buildTgz([
    { name: '././@LongLink', type: 'L', gnu: true, data: `${DEEP_ENV}\0` },
    { name: DEEP_ENV.slice(0, 100), gnu: true, data: 'TOKEN=secret\n' },
    ...COMMON,
  ])
  const files = strip(tarballFiles(tgz))
  assert.ok(files.includes(DEEP_ENV.replace(/^package\//, '')), `要读出长名记录里的真路径：${JSON.stringify(files)}`)
  assert.ok(!files.some((file) => /@LongLink/.test(file)), `@LongLink 不是文件：${JSON.stringify(files)}`)
  assert.equal(files.length, 3, `只有三个真文件：${JSON.stringify(files)}`)
  assert.ok(strip(sensitiveTarballFiles(tgz)).includes(DEEP_ENV.replace(/^package\//, '')))
})

test('A15 长名只管紧跟着的那一个文件：pax / GNU 长名后面的下一个普通文件用它自己的名字', () => {
  // 错误猜测：真名「粘」到后面的文件上，会把 index.js 报成 readme，或把 .env 报给别的文件
  const tgz = buildTgz([
    { name: 'PaxHeader/readme', type: 'x', data: paxRecord('path', DEEP_README) },
    { name: DEEP_README.slice(0, 100), data: '# readme\n' },
    { name: 'package/index.js', data: 'export default 1\n' },
    { name: '././@LongLink', type: 'L', gnu: true, data: `${DEEP_ENV}\0` },
    { name: DEEP_ENV.slice(0, 100), gnu: true, data: 'TOKEN=secret\n' },
    { name: 'package/package.json', data: '{}\n' },
  ])
  assert.deepEqual(strip(tarballFiles(tgz)).sort(), [DEEP_ENV, DEEP_README, 'package/index.js', 'package/package.json'].map((file) => file.replace(/^package\//, '')).sort())
  assert.deepEqual(strip(sensitiveTarballFiles(tgz)), [DEEP_ENV.replace(/^package\//, '')], '只有那一个 .env')
})

test('A15 pax 全局头（g，git archive 打的包第一条就是 pax_global_header）不当成文件', () => {
  const tgz = buildTgz([{ name: 'pax_global_header', type: 'g', data: paxRecord('comment', 'abc123') }, ...COMMON])
  assert.deepEqual(strip(tarballFiles(tgz)).sort(), ['index.js', 'package.json'])
})

test('A15 对照：短路径的 .env、ustar prefix 字段拼出来的长路径也照样报出来', () => {
  const prefix = DEEP_ENV.slice(0, DEEP_ENV.lastIndexOf('/config/'))
  const tgz = buildTgz([...COMMON, { name: 'package/.env', data: 'A=1\n' }, { name: 'config/.env', prefix, data: 'B=2\n' }])
  const sensitive = strip(sensitiveTarballFiles(tgz))
  assert.ok(sensitive.includes('.env'), JSON.stringify(sensitive))
  assert.ok(sensitive.includes(DEEP_ENV.replace(/^package\//, '')), `prefix + name 要拼成完整路径：${JSON.stringify(sensitive)}`)
})
