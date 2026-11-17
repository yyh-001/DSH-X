/**
 * 环境文件的纯规则（集成测试）：environment-pack.js 的规则函数 + packs.js 的解析，真 ZIP 来回走一遍。
 *
 * 需求（只按需求写预期，不读实现）：
 *   - 清单只带 name / version / displayName / description / dshVersion / bundles / dependencies，
 *     可选 offline 与 environment.repo；manifestVersion 仍是 5；没有补丁层、overrides、home、package.json 快照
 *   - 离线文件：offline: { "<插件>": { file: "offline/<名>.tgz", sha256: "<64 位十六进制>" } }，坐标写 file:offline/<名>.tgz；
 *     sha256 对不上、文件缺失、声明不完整、坐标指向没有核对过的文件 → 报错
 *   - 导出钉法：精确版本原样；npm 范围 / tag 要钉；github: 钉到锁文件里的提交（找不到就返回空、由调用方警告）；
 *     本地目录 / 本地 tarball 进 offline/
 *   - DSH 版本：精确照用；范围先挑本机已装里满足的最高版本，再挑远端满足的最高版本，都没有 → 无结果
 *   - 整机快照（dshhome）拒收；老包 bundles 只列插件时补上官方骨架；补丁层 / overrides / home 是 Profile 数据，单列
 *   - 配置导入只写配置：不碰 package.json / pnpm-lock.yaml / pnpm-workspace.yaml
 *   - 来源：GitHub / 市场来源自带的仓库优先，其次清单里的 environment.repo，都没有就不跟随；记下 packId / packVersion / marketId
 *   - 导入后离线坐标换成环境 files/ 目录里那份的绝对路径
 *
 * 设计：等价类（坐标的六类写法、来源的三种仓库出处）、边界值（sha256 63/64/65 位、范围端点含不含）、
 * 决策表（离线文件「声明完整 × 文件在 × 摘要对」、DSH 版本「精确/范围 × 本机有 × 远端有」）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'
import { baseManifest, makeTgz, packBuffer, readPack, sha256 as digest, tamperPack } from './environment-pack-fixture.mjs'

// packs.js / environments.js 不读 APP_DIR，但同一进程里别的模块可能间接拉到 settings：先隔离 HOME 再动态导入
isolateUserHome(mkdtempSync(join(tmpdir(), 'dsh-env-pack-')))
const P = await import('../src/environment-pack.js')
const { parsePackArchive } = await import('../src/packs.js')
const { writeZip } = await import('../src/zip.js')

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
const HEX64 = /^[0-9a-f]{64}$/
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const TGZ = makeTgz({ 'package/package.json': '{"name":"dsh-x-local","version":"1.0.0"}\n', 'package/index.js': 'export default 1\n' })

/** 一个带离线插件的合法包（声明、文件、摘要全对上）。 */
function offlinePack({ declare, files, deps } = {}) {
  const manifest = baseManifest({
    bundles: [BASE, WEB, 'dsh-x-local'],
    dependencies: deps || { 'dsh-x-local': 'file:offline/dsh-x-local-1.0.0.tgz' },
    offline: declare === undefined ? { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: digest(TGZ) } } : declare,
  })
  if (declare === null) delete manifest.offline
  return parsePackArchive(packBuffer(manifest, files === undefined ? { 'offline/dsh-x-local-1.0.0.tgz': TGZ } : files))
}

// ---------------------------------------------------------------- 常量与小工具

test('导出钉法的六类：EXPORT_KIND 有 exact / npm / github / directory / tarball / other 且冻结', () => {
  for (const key of ['EXACT', 'NPM', 'GITHUB', 'DIRECTORY', 'TARBALL', 'OTHER']) assert.equal(typeof P.EXPORT_KIND[key], 'string', key)
  assert.ok(Object.isFrozen(P.EXPORT_KIND))
  assert.ok(Object.isFrozen(P.ENVIRONMENT_PACK))
})

test('sha256：标准测试向量，字符串与 Buffer 同值', () => {
  assert.equal(P.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(P.sha256(Buffer.from('abc')), P.sha256('abc'))
})

test('离线文件名：<包名>-<版本>.tgz；包名去掉开头的 @，[A-Za-z0-9._+-] 以外的字符换成 -', () => {
  assert.equal(P.offlineFileName('@acme/dsh-bar', '1.2.3'), 'acme-dsh-bar-1.2.3.tgz')
  assert.equal(P.offlineFileName('dsh-x-local', '0.3.0'), 'dsh-x-local-0.3.0.tgz')
  assert.equal(P.offlineFileName('dsh~x', '1.0.0'), 'dsh-x-1.0.0.tgz', '~ 不在允许的字符里')
  assert.equal(P.offlineFileName('dsh-x', '1.0.0+build.7'), 'dsh-x-1.0.0+build.7.tgz', '版本里的 + 照留')
})

test('离线文件名：没有版本时用内容摘要的前 8 位', () => {
  const digest = P.sha256(TGZ)
  assert.equal(P.offlineFileName('dsh-x-local', '', digest), `dsh-x-local-${digest.slice(0, 8)}.tgz`)
})

test('离线文件名：撞名（@foo/bar 与 foo-bar 同版本）时第二个带上摘要：<stem>-<版本>-<摘要 8 位>.tgz', () => {
  const digest = 'abcdef0123456789'.repeat(4)
  const first = P.offlineFileName('foo-bar', '1.0.0', digest)
  assert.equal(first, 'foo-bar-1.0.0.tgz')
  const second = P.offlineFileName('@foo/bar', '1.0.0', digest, new Set([first]))
  assert.equal(second, `foo-bar-1.0.0-${digest.slice(0, 8)}.tgz`)
  assert.notEqual(second, first)
})

test('离线文件名：版本和摘要都没有、或者带上摘要也还撞名 → 抛错', () => {
  assert.throws(() => P.offlineFileName('dsh-x-local', ''))
  assert.throws(() => P.offlineFileName('dsh-x-local', '', ''))
  const digest = 'a'.repeat(64)
  const taken = new Set(['foo-bar-1.0.0.tgz', `foo-bar-1.0.0-${digest.slice(0, 8)}.tgz`])
  assert.throws(() => P.offlineFileName('@foo/bar', '1.0.0', digest, taken))
})

// ---------------------------------------------------------------- R9：坐标分类（等价类）

test('R9 坐标分类：精确版本 / npm 范围与 tag / github / 本地目录 / 本地 tarball 各归各类', () => {
  const { EXACT, NPM, GITHUB, DIRECTORY, TARBALL } = P.EXPORT_KIND
  const cases = [
    ['1.2.3', EXACT], ['0.0.1-rc.1', EXACT],
    ['^1.0.0', NPM], ['~1.2.0', NPM], ['>=1.0.0 <2.0.0', NPM], ['latest', NPM], ['next', NPM],
    ['github:octo/dsh-x-gh', GITHUB], ['github:octo/dsh-x-gh#main', GITHUB], [`github:octo/dsh-x-gh#${COMMIT}`, GITHUB],
    ['link:/abs/plugin', DIRECTORY], ['file:/abs/plugin', DIRECTORY],
    ['file:/abs/plugin.tgz', TARBALL], ['file:/abs/plugin.tar.gz', TARBALL],
  ]
  for (const [spec, kind] of cases) assert.equal(P.exportKind(spec).kind, kind, spec)
  assert.equal(P.exportKind('link:/abs/plugin').path, '/abs/plugin', '本地坐标要带出路径')
  assert.equal(P.exportKind('file:/abs/plugin.tgz').path, '/abs/plugin.tgz')
})

// ---------------------------------------------------------------- R9：github 钉提交

const lockFor = (spec, commit, repo = 'octo/dsh-x-gh') => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      dsh-x-gh:
        specifier: ${spec}
        version: https://codeload.github.com/${repo}/tar.gz/${commit}
`

test('R9 github：按 pnpm-lock.yaml 里 importer 记下的提交钉死；分支名也被提交替掉', () => {
  for (const spec of ['github:octo/dsh-x-gh', 'github:octo/dsh-x-gh#main']) {
    const pinned = P.pinnedGithubSpec(spec, lockFor(spec, COMMIT))
    assert.equal(pinned, `github:octo/dsh-x-gh#${COMMIT}`, spec)
  }
})

test('R9 github：已经钉了 40 位提交的原样返回', () => {
  const spec = `github:octo/dsh-x-gh#${COMMIT}`
  assert.equal(P.pinnedGithubSpec(spec, ''), spec)
})

test('R9 github：没有锁文件、锁文件里没有这一条时不编提交（返回空，由调用方警告）', () => {
  assert.equal(P.pinnedGithubSpec('github:octo/dsh-x-gh', ''), '')
  assert.equal(P.pinnedGithubSpec('github:octo/dsh-x-gh', lockFor('github:octo/other', COMMIT, 'octo/other')), '', '别的仓库的提交不能拿来用')
  assert.equal(P.pinnedGithubSpec('1.2.3', lockFor('1.2.3', COMMIT)), '', '不是 github 坐标')
})

// ---------------------------------------------------------------- R3：DSH 版本（决策表 + 边界值）

test('R3 DSH 版本：精确版本照用，本机有没有都如实报', () => {
  assert.deepEqual(P.pickDshVersion('1.1.0', { installed: ['1.1.0'], published: ['1.1.0', '2.0.0'] }), { version: '1.1.0', installed: true })
  assert.deepEqual(P.pickDshVersion('1.3.0', { installed: ['1.1.0'], published: ['1.3.0'] }), { version: '1.3.0', installed: false })
})

test('R3 DSH 版本：范围先挑本机已装里满足的最高版本（哪怕远端有更高的）', () => {
  const sets = { installed: ['1.0.0', '1.2.0', '1.1.0'], published: ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0'] }
  assert.deepEqual(P.pickDshVersion('>=1.0.0 <2.0.0', sets), { version: '1.2.0', installed: true })
  assert.deepEqual(P.pickDshVersion('^1.0.0', sets), { version: '1.2.0', installed: true })
})

test('R3 DSH 版本：范围端点（>= 含、> 不含、< 不含）', () => {
  const sets = { installed: ['1.0.0', '1.1.0', '1.2.0'], published: ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0'] }
  assert.deepEqual(P.pickDshVersion('>=1.2.0', sets), { version: '1.2.0', installed: true }, '>= 端点本身满足')
  assert.deepEqual(P.pickDshVersion('<1.2.0', sets), { version: '1.1.0', installed: true }, '< 端点本身不满足')
  assert.deepEqual(P.pickDshVersion('>1.2.0', sets), { version: '2.0.0', installed: false }, '> 端点本身不满足，本机没有就挑远端最高')
})

test('R3 DSH 版本：本机没有满足的 → 远端满足的最高版本，标成没装', () => {
  assert.deepEqual(P.pickDshVersion('>=1.3.0', { installed: ['1.0.0', '1.2.0'], published: ['1.2.0', '1.3.0', '2.0.0'] }), { version: '2.0.0', installed: false })
})

test('R3 DSH 版本：老包常见的预发布范围认预发布版本', () => {
  const range = '>=0.2.1-rc.1 <0.3.0-0'
  assert.deepEqual(P.pickDshVersion(range, { installed: ['0.2.1-rc.2'], published: [] }), { version: '0.2.1-rc.2', installed: true })
  assert.deepEqual(P.pickDshVersion(range, { installed: ['0.1.9'], published: ['0.2.1-rc.2', '0.2.2', '0.3.0'] }), { version: '0.2.2', installed: false })
})

test('R3 DSH 版本：本机和远端都不满足 → 没有结果', () => {
  assert.equal(P.pickDshVersion('>=5.0.0', { installed: ['1.0.0'], published: ['1.0.0', '2.0.0'] }), null)
  assert.equal(P.pickDshVersion('>=5.0.0', {}), null, '两个列表都缺省')
})

// ---------------------------------------------------------------- R8：导出的清单与条目

const LIST = { dependencies: { 'dsh-x-foo': '1.0.0', 'dsh-x-local': 'file:offline/dsh-x-local-1.0.0.tgz' }, bundles: [BASE, WEB, 'dsh-x-foo', 'dsh-x-local'] }

test('R8 导出清单：v5，必备字段齐全，没有补丁层与快照类字段', () => {
  const manifest = P.environmentManifest({ name: '我的环境', version: '2.0.1', description: '说明', dshVersion: '1.1.0', list: LIST })
  assert.equal(manifest.manifestVersion, 5)
  assert.equal(typeof manifest.name, 'string')
  assert.ok(manifest.name.length > 0)
  assert.equal(manifest.version, '2.0.1')
  assert.equal(manifest.displayName, '我的环境')
  assert.equal(manifest.description, '说明')
  assert.equal(manifest.dshVersion, '1.1.0')
  assert.deepEqual(manifest.bundles, LIST.bundles, '挂载顺序原样')
  assert.deepEqual(manifest.dependencies, LIST.dependencies)
  for (const key of ['patch', 'overrides', 'files', 'presets', 'skills', 'profiles']) assert.ok(!(key in manifest), `不能有 ${key}`)
  assert.ok(!('offline' in manifest), '没有离线文件就不写 offline')
  assert.ok(!('environment' in manifest), '没有仓库就不写 environment')
})

test('R8 导出清单：可选的 offline 与 environment.repo 按给的写', () => {
  const offline = { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: digest(TGZ) } }
  const manifest = P.environmentManifest({ name: 'x', version: '1.0.0', dshVersion: '1.1.0', list: LIST, offline, repo: 'octo/env-pack' })
  assert.deepEqual(manifest.offline, offline)
  assert.deepEqual(manifest.environment, { repo: 'octo/env-pack' })
})

test('R8 导出条目：只有 dspack.json、manifest.json 和 offline/<文件>', () => {
  const manifest = P.environmentManifest({ name: 'x', version: '1.0.0', dshVersion: '1.1.0', list: LIST })
  const entries = P.environmentEntries(manifest, [{ name: 'dsh-x-local', file: 'dsh-x-local-1.0.0.tgz', sha256: digest(TGZ), data: TGZ }])
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['dspack.json', 'manifest.json', 'offline/dsh-x-local-1.0.0.tgz'])
  const marker = JSON.parse(String(entries.find((entry) => entry.name === 'dspack.json').data))
  assert.equal(marker.format, 'dspack')
  assert.deepEqual(JSON.parse(String(entries.find((entry) => entry.name === 'manifest.json').data)), manifest)
})

test('R12 仓库目录的 release 工作流：推 tag 触发、产物是 .dspack', () => {
  const text = P.releaseWorkflow('我的环境')
  assert.match(text, /tags/)
  assert.match(text, /\.dspack/)
})

// ---------------------------------------------------------------- R15：纯规则层的来回

test('R15 来回：导出的条目打成 ZIP 再解析，环境的版本、插件、挂载顺序、离线文件都对得上', () => {
  const offline = [{ name: 'dsh-x-local', file: 'dsh-x-local-1.0.0.tgz', sha256: digest(TGZ), data: TGZ }]
  const manifest = P.environmentManifest({
    name: '来回', version: '1.0.0', dshVersion: '1.1.0', list: LIST,
    offline: { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: digest(TGZ) } },
  })
  const zip = writeZip(P.environmentEntries(manifest, offline))
  const imported = P.environmentFromPack(parsePackArchive(zip))
  assert.equal(imported.ok, true, `应能导入：${imported.errors.join('；')}`)
  assert.equal(imported.dshVersion, '1.1.0')
  assert.deepEqual(imported.list.bundles, LIST.bundles)
  assert.deepEqual(Object.keys(imported.list.dependencies).sort(), Object.keys(LIST.dependencies).sort())
  assert.equal(imported.offline.length, 1)
  assert.equal(imported.offline[0].sha256, digest(TGZ))
  assert.ok(Buffer.from(imported.offline[0].data).equals(TGZ), '离线文件原样')

  const tampered = tamperPack(zip, 'offline/dsh-x-local-1.0.0.tgz', Buffer.concat([TGZ, Buffer.from('x')]))
  assert.equal(P.environmentFromPack(parsePackArchive(tampered)).ok, false, '改过的离线文件不能导入')
})

// ---------------------------------------------------------------- R4：离线文件（决策表）

test('R4 离线文件：声明、文件、摘要全对上 → 通过，单独列出名字 / 文件 / 摘要', () => {
  const imported = P.environmentFromPack(offlinePack())
  assert.equal(imported.ok, true, imported.errors.join('；'))
  assert.equal(imported.offline.length, 1)
  assert.equal(imported.offline[0].name, 'dsh-x-local')
  assert.match(imported.offline[0].file, /dsh-x-local-1\.0\.0\.tgz$/)
  assert.match(imported.offline[0].sha256, HEX64)
})

test('R4 离线文件：sha256 对不上 → 报错', () => {
  const imported = P.environmentFromPack(offlinePack({ declare: { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: digest('别的内容') } } }))
  assert.equal(imported.ok, false)
  assert.ok(imported.errors.length > 0)
})

test('R4 离线文件：声明了但包里没有这个文件 → 报错', () => {
  const imported = P.environmentFromPack(offlinePack({ files: {} }))
  assert.equal(imported.ok, false)
  assert.ok(imported.errors.length > 0)
})

test('R4 离线文件：声明不完整（缺 file、缺 sha256、sha256 63 / 65 位）→ 报错；64 位通过', () => {
  const good = digest(TGZ)
  const incomplete = [
    { sha256: good },
    { file: 'offline/dsh-x-local-1.0.0.tgz' },
    { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: good.slice(0, 63) },
    { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: `${good}0` },
    { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: '' },
  ]
  for (const item of incomplete) {
    const imported = P.environmentFromPack(offlinePack({ declare: { 'dsh-x-local': item } }))
    assert.equal(imported.ok, false, `不完整的声明要报错：${JSON.stringify(item)}`)
  }
  assert.equal(P.environmentFromPack(offlinePack({ declare: { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: good } } })).ok, true, '64 位是合法边界')
})

test('R4 离线文件：坐标写 file:offline/… 但没有声明（文件在包里也不算核对过）→ 报错', () => {
  const imported = P.environmentFromPack(offlinePack({ declare: null }))
  assert.equal(imported.ok, false)
  assert.ok(imported.errors.length > 0)
})

test('R4 离线文件：坐标指向的文件和声明的不是同一个 → 报错', () => {
  const imported = P.environmentFromPack(offlinePack({ deps: { 'dsh-x-local': 'file:offline/other-9.9.9.tgz' } }))
  assert.equal(imported.ok, false)
})

test('R4 导入后坐标：file:offline/<名> 换成 files/<摘要前 8 位>/<名> 的绝对路径，其余坐标不动', () => {
  const filesDir = join(tmpdir(), 'envs', 'demo', 'files')
  const list = { dependencies: { 'dsh-x-local': 'file:offline/dsh-x-local-1.0.0.tgz', 'dsh-x-foo': '1.0.0' }, bundles: [BASE, 'dsh-x-local', 'dsh-x-foo'] }
  const item = { name: 'dsh-x-local', file: 'dsh-x-local-1.0.0.tgz', sha256: digest(TGZ), data: TGZ }
  const out = P.withOfflinePaths(list, [item], filesDir)
  const where = join(filesDir, digest(TGZ).slice(0, 8), 'dsh-x-local-1.0.0.tgz')
  assert.equal(P.offlineFilePath(filesDir, item), where, '同名不同内容各放各的子目录')
  assert.equal(out.dependencies['dsh-x-local'], `file:${where}`)
  assert.equal(out.dependencies['dsh-x-foo'], '1.0.0')
  assert.deepEqual(out.bundles, list.bundles, '挂载顺序不动')
})

// ---------------------------------------------------------------- R5：包的形态

test('R5 整机快照（type: dshhome）→ 报错', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ type: 'dshhome' }))))
  assert.equal(imported.ok, false)
  assert.ok(imported.errors.length > 0)
})

test('R5 老包的 bundles 只列插件 → 补上官方骨架，插件顺序不变', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({
    bundles: ['dsh-x-foo', 'dsh-x-bar'],
    dependencies: { 'dsh-x-foo': '1.0.0', 'dsh-x-bar': '2.0.0' },
  }))))
  assert.equal(imported.ok, true, imported.errors.join('；'))
  const { bundles } = imported.list
  assert.ok(bundles.includes(BASE) && bundles.includes(WEB), `要补上官方骨架：${bundles}`)
  assert.ok(bundles.indexOf(WEB) < bundles.indexOf('dsh-x-foo') && bundles.indexOf(BASE) < bundles.indexOf('dsh-x-foo'), '官方骨架在插件前面')
  assert.ok(bundles.indexOf('dsh-x-foo') < bundles.indexOf('dsh-x-bar'), '插件原来的顺序不变')
})

test('R5 已经带官方组件的完整层栈 → 原样保留顺序，不重复补', () => {
  const bundles = [BASE, 'dsh-x-foo', WEB]
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ bundles }))))
  assert.deepEqual(imported.list.bundles, bundles)
})

// ---------------------------------------------------------------- R6：配置是 Profile 的数据

const CONFIG_FILES = {
  'overrides/cordis.patch.yml': '- id: x\n  config: { token: sk-pack-secret }\n',
  'overrides/notes/readme.txt': 'hello\n',
  'overrides/package.json': '{"name":"from-pack","dependencies":{"evil":"1.0.0"}}\n',
  'overrides/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'overrides/pnpm-workspace.yaml': 'packages: []\n',
  'home/skills/demo/SKILL.md': '# demo\n',
}

test('R6 配置单列：补丁层、overrides、home 都列进 profileData，hasProfileData 为真', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest(), CONFIG_FILES)))
  assert.equal(imported.profileData.patch, true)
  assert.ok(imported.profileData.overrides.some((path) => path.endsWith('notes/readme.txt')), JSON.stringify(imported.profileData.overrides))
  assert.ok(imported.profileData.home.some((path) => path.endsWith('skills/demo/SKILL.md')), JSON.stringify(imported.profileData.home))
  assert.equal(P.hasProfileData(imported.profileData), true)
})

test('R6 没有任何配置的包：hasProfileData 为假', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest())))
  assert.equal(P.hasProfileData(imported.profileData), false)
  assert.equal(P.hasProfileData({ patch: false, overrides: [], home: [] }), false)
  assert.equal(P.hasProfileData({ patch: false, overrides: [], home: ['AGENTS.md'] }), true, '只有 home 也算有配置')
})

test('R6 配置导入用的包：去掉插件清单和 package.json / pnpm-lock.yaml / pnpm-workspace.yaml，留下其余配置', () => {
  const pack = parsePackArchive(packBuffer(baseManifest(), CONFIG_FILES))
  const config = P.configOnlyPack(pack)
  assert.deepEqual(config.fields.dependencies, {}, '依赖归环境')
  assert.deepEqual(config.fields.bundles, [], '挂载顺序归环境')
  assert.deepEqual(config.installSpecs || {}, {})
  const paths = config.overrides.map((item) => item.path)
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) assert.ok(!paths.includes(name), `${name} 是插件清单，不能当配置写`)
  assert.ok(paths.some((path) => path.endsWith('notes/readme.txt')), '普通配置文件留着')
  assert.ok(config.patch?.text?.includes('sk-pack-secret'), '补丁层留着')
  assert.equal(config.home.length, pack.home.length, 'home 里的文件留着')
})

// ---------------------------------------------------------------- R7：来源（决策表）

test('R7 来源：GitHub 来源自带的仓库优先于清单声明，算跟随；packId / packVersion 记下', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ name: 'pid', version: '3.1.4', environment: { repo: 'octo/declared' } }))))
  const source = P.environmentSource({ kind: 'github', repo: 'octo/from-github', release: 'v3.1.4', label: 'x' }, imported)
  assert.equal(source.repo, 'octo/from-github')
  assert.equal(source.following, true)
  assert.equal(source.packId, 'pid')
  assert.equal(source.packVersion, '3.1.4')
})

test('R7 来源：市场条目带仓库 → 跟随，并记下 marketId', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest())))
  const source = P.environmentSource({ kind: 'market', repo: 'octo/market-pack', marketId: 'octo.market-pack', label: 'x' }, imported)
  assert.equal(source.repo, 'octo/market-pack')
  assert.equal(source.marketId, 'octo.market-pack')
  assert.equal(source.following, true)
})

test('R7 来源：来源没有仓库时用清单里的 environment.repo', () => {
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ environment: { repo: 'octo/declared' } }))))
  const source = P.environmentSource({ kind: 'file', label: '文件' }, imported)
  assert.equal(source.repo, 'octo/declared')
  assert.equal(source.following, true)
})

test('R7 来源：两处都没有仓库、或清单里的仓库写法不对 → 不跟随', () => {
  for (const environment of [undefined, { repo: 'octo' }, { repo: 'a/b/c' }, { repo: 'octo/re po' }, { repo: 42 }]) {
    const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest(environment ? { environment } : {}))))
    const source = P.environmentSource({ kind: 'file', label: '文件' }, imported)
    assert.equal(source.following, false, JSON.stringify(environment))
    assert.ok(!source.repo, `不该记下仓库：${JSON.stringify(environment)}`)
  }
})

// ---------------------------------------------------------------- 第二轮需求：github 锁文件的三种写法（需求 6）

/** 锁文件 importer 里一条依赖：version 那一行按给的写（pnpm 9+ / pnpm 8 lockfile v6 / git 地址）。 */
const lockWith = (version, lockfileVersion = '9.0') => `lockfileVersion: '${lockfileVersion}'

importers:

  .:
    dependencies:
      dsh-x-gh:
        specifier: github:octo/dsh-x-gh
        version: ${version}
`

test('需求 6 github 钉提交：pnpm 9+（codeload）、pnpm 8 / lockfile v6（github.com/o/r/<提交>）、git 地址（#<提交>）三种都认', () => {
  const cases = [
    ['pnpm 9+', lockWith(`https://codeload.github.com/octo/dsh-x-gh/tar.gz/${COMMIT}`)],
    ['pnpm 8 / v6', lockWith(`github.com/octo/dsh-x-gh/${COMMIT}`, '6.0')],
    ['git 地址', lockWith(`git+https://github.com/octo/dsh-x-gh.git#${COMMIT}`)],
  ]
  for (const [why, lock] of cases) assert.equal(P.pinnedGithubSpec('github:octo/dsh-x-gh', lock), `github:octo/dsh-x-gh#${COMMIT}`, why)
})

test('需求 6 github 钉提交：只认 40 位十六进制，短提交 / 39 位 / 大写混进来的不算', () => {
  for (const commit of ['abc1234', COMMIT.slice(0, 39), `${COMMIT.slice(0, 39)}g`]) {
    assert.equal(P.pinnedGithubSpec('github:octo/dsh-x-gh', lockWith(`github.com/octo/dsh-x-gh/${commit}`, '6.0')), '', commit)
  }
})

// ---------------------------------------------------------------- 第二轮需求：会漂的坐标（需求 6）

test('需求 6 会漂的坐标：npm: 别名带范围 / tag、git 地址没钉 40 位提交 → 算会漂', () => {
  for (const spec of [
    'npm:dsh-x-foo@^1.0.0', 'npm:@acme/dsh-bar@~2.1.0', 'npm:dsh-x-foo@latest',
    'git+https://github.com/octo/plain.git', 'git+ssh://git@github.com/octo/ssh.git#main', 'git://github.com/octo/proto.git#v1.0.0',
    'git@github.com:octo/scp.git', `git+https://github.com/octo/short.git#${COMMIT.slice(0, 7)}`,
  ]) assert.equal(P.isFloatingSpec(spec), true, spec)
})

test('需求 6 不会漂的坐标：精确别名、钉了提交的 git、直链 tarball、普通精确版本', () => {
  for (const spec of [
    'npm:dsh-x-foo@1.2.3', 'npm:@acme/dsh-bar@2.1.0', `git+https://github.com/octo/pinned.git#${COMMIT}`,
    'https://example.com/dsh-x-url-1.0.0.tgz', '1.2.3',
  ]) assert.equal(P.isFloatingSpec(spec), false, spec)
})

// ---------------------------------------------------------------- 第二轮需求：仓库目录的识别（R12 变更）

const MARKER = JSON.stringify({ format: 'dspack', version: 3 })
test('R12 之前导出过的环境仓库：dspack.json 的 format 是 dspack，且 manifest.json 能解析、manifestVersion 是 1–5', () => {
  for (const version of [1, 5]) assert.equal(P.isEnvironmentRepository(MARKER, JSON.stringify({ manifestVersion: version, name: 'x' })), true, `v${version}`)
})

test('R12 不是环境仓库：没有标记、标记不对、标记坏了、清单坏了、清单版本 0 / 6 / 缺失', () => {
  const manifest = JSON.stringify({ manifestVersion: 5, name: 'x' })
  const cases = [
    ['没有标记', '', manifest],
    ['format 不是 dspack', JSON.stringify({ format: 'zip' }), manifest],
    ['标记不是 JSON', '{nope', manifest],
    ['清单不是 JSON', MARKER, '{nope'],
    ['manifestVersion 0', MARKER, JSON.stringify({ manifestVersion: 0 })],
    ['manifestVersion 6', MARKER, JSON.stringify({ manifestVersion: 6 })],
    ['没有 manifestVersion', MARKER, JSON.stringify({ name: 'x' })],
  ]
  for (const [why, marker, text] of cases) assert.equal(P.isEnvironmentRepository(marker, text), false, why)
})

// ---------------------------------------------------------------- 第二轮需求：本地插件里的敏感文件（需求 6）

test('需求 6 敏感文件：.env / .npmrc / *.pem / *.key / id_rsa* / credentials* / .netrc / settings.yaml 都认出来，普通文件不误报', () => {
  const sensitive = ['.env', '.npmrc', 'certs/server.pem', 'keys/deploy.key', 'id_rsa', 'id_rsa.pub', 'credentials.json', '.netrc', 'config/settings.yaml']
  const benign = ['index.js', 'keyboard.js', 'monkey.md', 'docs/env.md', 'pem-notes.txt']
  const tgz = makeTgz(Object.fromEntries([...sensitive, ...benign].map((name) => [`package/${name}`, 'x\n'])))
  const found = JSON.stringify(P.sensitiveTarballFiles(tgz))
  for (const name of sensitive) assert.ok(found.includes(name.split('/').pop()), `${name} 要认出来：${found}`)
  for (const name of benign) assert.ok(!found.includes(name.split('/').pop()), `${name} 不该报：${found}`)
})

// ---------------------------------------------------------------- 第二轮需求：导入时清单里的问题条目（需求 3 / 4、R5 变更）

test('需求 3 认不出的依赖（坏包名、坐标超过 512 个字符）：每条一个点名提醒，不进环境；512 个字符整的照收', () => {
  const ok512 = `github:octo/dsh-x-ok#${'a'.repeat(512 - 'github:octo/dsh-x-ok#'.length)}`
  const long513 = `github:octo/dsh-x-ok#${'a'.repeat(513 - 'github:octo/dsh-x-ok#'.length)}`
  assert.equal(ok512.length, 512)
  assert.equal(long513.length, 513)
  const deps = { 'Bad Name!': '1.0.0', '../evil': '1.0.0', 'dsh-x-long': long513, 'dsh-x-ok512': ok512, 'dsh-x-fine': '1.0.0' }
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }))))
  assert.equal(imported.ok, true, imported.errors.join('；'))
  for (const name of ['Bad Name!', '../evil', 'dsh-x-long']) {
    assert.ok(imported.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(imported.warnings)}`)
    assert.ok(!(name in imported.list.dependencies), `${name} 不能进依赖表`)
    assert.ok(!imported.list.bundles.includes(name), `${name} 不能进挂载顺序`)
  }
  assert.equal(imported.list.dependencies['dsh-x-ok512'], ok512, '512 个字符是合法边界')
  assert.equal(imported.list.dependencies['dsh-x-fine'], '1.0.0')
})

test('需求 4 依赖写 bundled / bundled:<名>：报错', () => {
  for (const spec of ['bundled', 'bundled:dsh-x-b']) {
    const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ dependencies: { 'dsh-x-b': spec }, bundles: [BASE, WEB, 'dsh-x-b'] }))))
    assert.equal(imported.ok, false, spec)
    assert.ok(imported.errors.length > 0, spec)
  }
})

test('R5（变更）指向作者本机路径的依赖（link: / file: 目录 / file: tarball，不是离线文件）：依赖和挂载一起去掉，每个一条点名提醒，仍可导入', () => {
  const deps = { 'dsh-x-foo': '1.0.0', 'dsh-x-linked': 'link:/Users/author/dev/linked', 'dsh-x-filed': 'file:/Users/author/dev/filed.tgz', 'dsh-x-dir': 'file:../dev/dir' }
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(baseManifest({ dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }))))
  assert.equal(imported.ok, true, imported.errors.join('；'))
  for (const name of ['dsh-x-linked', 'dsh-x-filed', 'dsh-x-dir']) {
    assert.ok(!(name in imported.list.dependencies), `${name} 要去掉`)
    assert.ok(!imported.list.bundles.includes(name), `${name} 的挂载也要去掉`)
    assert.ok(imported.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(imported.warnings)}`)
  }
  assert.deepEqual(imported.list.bundles, [BASE, WEB, 'dsh-x-foo'])
})

test('导入提醒不带噪音：没有快照、没有补丁层不再提醒；清单里的 offline / environment 字段不算「不认识的字段」', () => {
  const manifest = baseManifest({
    bundles: [BASE, WEB, 'dsh-x-local'],
    dependencies: { 'dsh-x-local': 'file:offline/dsh-x-local-1.0.0.tgz' },
    offline: { 'dsh-x-local': { file: 'offline/dsh-x-local-1.0.0.tgz', sha256: digest(TGZ) } },
    environment: { repo: 'octo/env-pack' },
  })
  const imported = P.environmentFromPack(parsePackArchive(packBuffer(manifest, { 'offline/dsh-x-local-1.0.0.tgz': TGZ })))
  assert.equal(imported.ok, true, imported.errors.join('；'))
  const noisy = imported.warnings.filter((line) => /package\.json 快照|补丁层|offline|environment/.test(line))
  assert.deepEqual(noisy, [], '这几类提醒都不该再出现')
})

// ---------------------------------------------------------------- 读回：包本身

test('R8 读回辅助自检：packBuffer 写的包 parsePackArchive 认得', () => {
  const entries = readPack(packBuffer(baseManifest()))
  assert.ok(entries.has('manifest.json') && entries.has('dspack.json'))
  assert.equal(parsePackArchive(packBuffer(baseManifest())).ok, true)
})
