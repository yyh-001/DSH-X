/**
 * 导出环境文件（系统测试）：进程内真服务 + 隔离用户目录 + 会记账的假 dsh + 离线假 npm registry。
 *
 * 需求（只按需求写预期，不读实现）：
 *   R8  只写 dspack.json、manifest.json、offline/<文件>；清单 manifestVersion 5，带 name / version / displayName / description /
 *       dshVersion（精确）/ bundles / dependencies，可选 offline 与 environment.repo；没有补丁层、overrides/、home/、
 *       package.json 快照——哪怕环境所在 Profile 的 cordis.patch.yml 里有密钥
 *   R9  直接依赖：精确版本原样；npm 范围 / tag → 环境上次写进的那个 Profile 里实装的版本，没有就取已发布里满足的最高版本，
 *       都不行原样带并提醒；github: → 那个 Profile 的 pnpm-lock.yaml 里记的提交，找不到原样带并提醒；本地目录按 npm pack 规则
 *       打进 offline/（带 sha256），本地 tarball 直接带上；exclude 点名的插件连依赖带挂载一起去掉并提醒，路径已不存在的本地插件同样；
 *       官方 @deepseek-ai/* 组件留在 bundles 里
 *   R10 跟随最新（auto）的环境冻结成此刻会用的那个精确版本；本机没有能用的 DSH → 导出报错
 *   R11 version 要匹配 ^[0-9A-Za-z._+-]{1,24}$（24 个字符可以、25 个拒绝；空 → 环境上次的包版本，没有就 1.0.0）；repo 要是 owner/repo
 *   R12 仓库目录：文件写进选的文件夹；workflow: true 加 .github/workflows/release-environment.yml，已有的不覆盖、给提醒；
 *       重导时删掉上次清单列过、这次没有的离线文件，上次清单没列的文件一概不碰
 *   R13 导出用的 version / description 记回环境
 *   R14 Profile 里有 .dsh-market（dsh 内置市场装的插件）→ 提醒
 *   R15 来回：带本地插件的环境导出再导入，DSH 版本、插件名、挂载顺序相同，离线文件解出来摘要一致；改过包里的离线文件 → 导入失败
 *
 * 第二轮需求（代码评审之后）：
 *   R9（修正）范围 / tag 取参考 Profile 里实装的精确版本：范围要真满足（不收预发布），tag 没法离线核对就照收；否则取已发布里满足的最高版本
 *   R12（变更）文件夹里有 manifest.json 却不是之前导出的环境仓库（dspack.json 的 format 是 dspack、清单 manifestVersion 1–5）→ 400，
 *        错误提到 manifest.json，文件夹不动
 *   R15（变更）导回来的离线文件在 files/<sha256 前 8 位>/<名>.tgz
 *   N6 github 钉提交认三种锁文件写法（见纯规则测试）；会漂的坐标（npm: 别名带范围、没钉 40 位提交的 git 地址）原样带并点名提醒，
 *      精确别名、直链 tarball 不提醒；本地插件的离线 tarball 里有 .env / .npmrc / *.pem / *.key / id_rsa* / credentials* / .netrc /
 *      settings.yaml → 点名插件和文件提醒；两个本地插件离线文件名撞了 → 各用不同文件名，都能来回；单文件导出超过 32 MB → 报错不写文件，
 *      文件夹导出超过 32 MB 只提醒；文件夹导出先写新文件再删旧离线文件；相对路径的本地插件按参考 Profile 目录解析
 *   N7 plugins/add 收相对路径的本地坐标 → 400；绝对路径照收
 *
 * 设计：等价类（六类依赖坐标 × 有 / 没有参考 Profile）、边界值（version 长度 0/24/25，sha256 64 位）、
 * 决策表（npm 坐标「Profile 里有实装 × registry 能解析」）、状态迁移（导出 → 记住版本 → 空版本再导出沿用；
 * 目录导出 → 少一个离线插件再导出 → 旧文件被清）。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { expectedAuto, packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import { BASE, WEB, profileDir, profileManifest, recordingBin, seedProfile, waitFor } from './environments-fixture.mjs'
import {
  baseManifest, extractedOfflinePath, makeTgz, npmUnavailableReason, readPack, readTgz, readTree, sha256, startNpmRegistry, tamperPack,
  writePackDir, writePluginDir,
} from './environment-pack-fixture.mjs'

const NO_NPM = npmUnavailableReason()
const INSTALLED = ['1.0.0', '1.1.0', '1.2.0-rc.1']
// 注意：src/settings.js（以及 server.js）在导入时就按 HOME 定下设置目录，绝不能在夹具隔离 HOME 之前静态导入
const env = await startChannelServer({
  prefix: 'dsh-env-export-',
  packument: packumentOf({ latest: '1.1.0' }, INSTALLED),
  installed: INSTALLED,
  bin: recordingBin,
})
const registry = await startNpmRegistry({
  '@deepseek-ai/dsh': { tags: { latest: '1.1.0' }, versions: INSTALLED },
  'dsh-x-foo': { tags: { latest: '2.0.0', next: '3.0.0-beta.1' }, versions: ['1.0.0', '1.5.0', '2.0.0', '3.0.0-beta.1'] },
  '@acme/dsh-bar': { tags: { latest: '2.3.0' }, versions: ['2.1.0', '2.3.0'] },
  'dsh-x-tagged': { tags: { latest: '0.8.0', next: '0.9.0-beta.2' }, versions: ['0.8.0', '0.9.0-beta.2'] },
  'dsh-x-far': { tags: { latest: '1.0.0' }, versions: ['1.0.0'] },
  // Profile 里装的版本不在范围里（换过环境留下的旧版本）、或者是预发布：都不算「实装满足」
  'dsh-x-stale': { tags: { latest: '2.4.0' }, versions: ['1.0.0', '2.0.0', '2.4.0', '3.0.0-rc.1'] },
  'dsh-x-pre': { tags: { latest: '1.2.0' }, versions: ['1.0.0', '1.1.0-beta.1', '1.2.0'] },
})
process.env.npm_config_registry = registry.url
test.after(async () => {
  await env.cleanup()
  await registry.close()
})

// ---------------------------------------------------------------- 驱动件

async function okPost(path, body, headers) {
  const result = await env.call(path, body, headers)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
await okPost('/api/settings', { autoCleanVersions: false, downloadSource: 'official', proxyMode: 'off' })

async function rejected(path, body, why) {
  const result = await env.call(path, body)
  assert.equal(result.ok, false, `${why}：应被拒绝，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.ok(result.status >= 400, `${why}：要回错误状态码`)
  assert.equal(typeof result.data?.error, 'string', `${why}：要带 error 文案`)
  return result
}
const listEnvs = async () => (await env.getJson('/api/environments')).environments
const envById = async (id) => (await listEnvs()).find((item) => item.id === id)
const namesOf = (view) => (view?.plugins || []).filter((item) => !item.official).map((item) => item.name).sort()
async function createEnv(name, dshVersion, specs = [], extra = {}) {
  const { environment } = await okPost('/api/environments/create', { name, dshVersion, ...extra })
  for (const spec of specs) await okPost('/api/environments/plugins/add', { id: environment.id, spec })
  return environment
}

// 保存对话框给的路径总在一个已存在的文件夹里：这里先把放导出物的文件夹建好
const OUT = join(env.root, 'out')
mkdirSync(OUT, { recursive: true })
let seq = 0
const outFile = (label) => join(OUT, `${label}-${(seq += 1)}.dspack`)
const outDir = (label) => {
  const dir = join(OUT, `${label}-${(seq += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
/** 导出到文件并读回：响应、条目表、清单。 */
async function exportFile(body, label = 'env') {
  const path = body.path || outFile(label)
  const data = await okPost('/api/environments/export', { target: 'file', ...body, path })
  assert.equal(data.ok, true)
  assert.ok(existsSync(path), `要写出 ${path}`)
  const entries = readPack(readFileSync(path))
  assert.ok(entries.has('manifest.json'), '包里要有 manifest.json')
  return { data, path, entries, manifest: JSON.parse(entries.get('manifest.json').toString('utf8')) }
}
async function exportDir(body, dir) {
  const data = await okPost('/api/environments/export', { target: 'dir', ...body, path: dir })
  assert.equal(data.ok, true)
  return { data, tree: readTree(dir), manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) }
}
/** 期望导出被拒：报错，且目标位置什么都没写。 */
async function exportRejected(body, why) {
  const path = body.path || outFile('rejected')
  await rejected('/api/environments/export', { target: 'file', ...body, path }, why)
  assert.equal(existsSync(path), false, `${why}：被拒的导出不能写出文件`)
}
/** 包里只允许这三类条目。 */
const ALLOWED_ENTRY = (name) => name === 'dspack.json' || name === 'manifest.json' || /^offline\/[^/]+\.tgz$/.test(name)

// 本地插件素材
const PLUGINS = join(env.root, 'plugins')
const TGZ_PATH = join(PLUGINS, 'dsh-x-local-tgz.tgz')
mkdirSync(PLUGINS, { recursive: true })
const TGZ = makeTgz({ 'package/package.json': '{"name":"dsh-x-local-tgz","version":"0.4.0"}\n', 'package/index.js': 'export default 4\n' })
writeFileSync(TGZ_PATH, TGZ)
const LOCAL_DIR = writePluginDir(join(PLUGINS, 'local-dir'), {
  name: 'dsh-x-local-dir',
  version: '0.3.0',
  // npm pack 永远不带 node_modules 与 .git：打包规则对不对，看这两样有没有混进去
  extra: { 'node_modules/junk/index.js': 'junk\n', '.git/HEAD': 'ref: refs/heads/main\n', 'lib/util.js': 'export const x = 1\n' },
})
const GONE = join(PLUGINS, 'gone-plugin')

// ---------------------------------------------------------------- 参考 Profile（环境最近一次写进去的那个）

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98'
const SECRET = 'sk-EXPORT-SECRET-0123456789'
const REF_PROFILE = 'export-ref'
const refDir = profileDir(env.home, REF_PROFILE)
const REF_DEPS = {
  'dsh-x-foo': '^1.0.0',
  '@acme/dsh-bar': 'latest',
  'dsh-x-gh': 'github:octo/dsh-x-gh',
  'dsh-x-exact': '1.2.3',
  // Profile 里没装上的范围：参考 Profile 在，但「实装版本」没有 → 退到已发布里满足的最高版本
  'dsh-x-far': '^1.0.0',
  // 装着的 1.0.0 不满足 ^2.0.0；装着的 1.1.0-beta.1 按不收预发布的规则不满足 ^1.0.0
  'dsh-x-stale': '^2.0.0',
  'dsh-x-pre': '^1.0.0',
}
seedProfile(env.home, REF_PROFILE, profileManifest(REF_PROFILE, { dependencies: REF_DEPS, bundles: [BASE, WEB, ...Object.keys(REF_DEPS)] }))
// 实装的版本故意比 registry 里满足范围的最高版本低：钉成哪一个，一眼分得清是「读了 Profile」还是「问了 registry」
for (const [name, version] of [['dsh-x-foo', '1.0.0'], ['@acme/dsh-bar', '2.1.0'], ['dsh-x-stale', '1.0.0'], ['dsh-x-pre', '1.1.0-beta.1']]) {
  mkdirSync(join(refDir, 'node_modules', name), { recursive: true })
  writeFileSync(join(refDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
}
// pnpm 9+ 锁文件里 github 依赖的真实写法：importer 的 version 是 codeload 地址，末段就是提交
writeFileSync(join(refDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false

importers:

  .:
    dependencies:
      '@acme/dsh-bar':
        specifier: latest
        version: 2.1.0
      dsh-x-foo:
        specifier: ^1.0.0
        version: 1.0.0
      dsh-x-gh:
        specifier: github:octo/dsh-x-gh
        version: https://codeload.github.com/octo/dsh-x-gh/tar.gz/${COMMIT}
`)
writeFileSync(join(refDir, 'cordis.patch.yml'), `- id: mcp\n  config:\n    servers:\n      demo:\n        env:\n          API_KEY: ${SECRET}\n`)
writeFileSync(join(refDir, 'notes.txt'), 'profile 自己的文件\n')

/**
 * 把一个 Profile 收养成环境、加一个插件（让列表和 Profile 不同，启动时一定会写清单），起一次再停：
 * 环境就「写进过」这个 Profile，它就是导出时的参考 Profile。
 */
async function applyFromProfile(profile, name) {
  const { entry } = await okPost('/api/launch-presets', { name, version: '1.0.0', profile })
  assert.ok(entry.environment, '前置条件：有清单的 Profile 自动绑上环境')
  await okPost('/api/environments/plugins/add', { id: entry.environment, spec: 'dsh-x-extra@1.0.0' })
  const header = { 'x-dsh-launch-id': entry.id }
  await okPost('/api/start', { version: entry.version, profile }, header)
  await waitFor(async () => (await env.state()).instances.some((item) => item.profile === profile && item.status === 'running'), `${profile} 的实例跑起来`)
  await okPost('/api/stop', { version: entry.version, profile, home: env.home }, header)
  await waitFor(async () => !(await env.state()).instances.some((item) => item.profile === profile && ['starting', 'running'].includes(item.status)), `${profile} 的实例停下`)
  const view = await envById(entry.environment)
  assert.ok((view.applied || []).some((item) => item.profile === profile), `前置条件：环境要记得写进过 ${profile}：${JSON.stringify(view.applied)}`)
  return entry.environment
}
let appliedId = ''
const applied = async () => (appliedId ||= await applyFromProfile(REF_PROFILE, '导出参考'))

// ---------------------------------------------------------------- R8：写了什么

test('R8 文件目标：包里只有 dspack.json、manifest.json、offline/*；清单字段齐全、版本精确', async () => {
  const created = await createEnv('只写清单', '1.1.0', ['dsh-x-foo@1.0.0', `dsh-x-local-tgz@file:${TGZ_PATH}`])
  const { data, entries, manifest } = await exportFile({ id: created.id, version: '1.2.3', description: '导出说明' })
  assert.deepEqual([...entries.keys()].filter((name) => !ALLOWED_ENTRY(name)), [], '不能有别的条目')
  assert.equal(JSON.parse(entries.get('dspack.json').toString('utf8')).format, 'dspack')
  assert.equal(manifest.manifestVersion, 5)
  assert.equal(typeof manifest.name, 'string')
  assert.ok(manifest.name.length > 0)
  assert.equal(manifest.version, '1.2.3')
  assert.equal(manifest.displayName, '只写清单')
  assert.equal(manifest.description, '导出说明')
  assert.equal(manifest.dshVersion, '1.1.0')
  assert.ok(Array.isArray(manifest.bundles))
  assert.equal(typeof manifest.dependencies, 'object')
  assert.equal(data.dshVersion, '1.1.0', '响应里回导出用的 DSH 版本')
  assert.equal(data.plugins, 2, 'plugins 是非官方插件的个数')
  assert.equal(data.target, 'file')
  assert.ok(data.bytes > 0)
  assert.ok(!('environment' in manifest), '没填仓库就不写 environment')
})

test('R8 不带配置：参考 Profile 的补丁层里有密钥，导出的包里没有补丁层、overrides、home、package.json 快照，也找不到密钥', async () => {
  const id = await applied()
  const { entries, manifest } = await exportFile({ id })
  for (const key of ['patch', 'overrides', 'files', 'skills', 'presets', 'profiles']) assert.ok(!(key in manifest), `清单不能有 ${key}`)
  const names = [...entries.keys()]
  assert.deepEqual(names.filter((name) => !ALLOWED_ENTRY(name)), [], `只能有清单与离线文件：${names}`)
  for (const [name, data] of entries) assert.ok(!data.toString('latin1').includes(SECRET), `${name} 里不能带出 Profile 的密钥`)
  assert.ok(!names.some((name) => name.endsWith('cordis.patch.yml') || name.endsWith('notes.txt') || name.endsWith('package.json') || name.endsWith('pnpm-lock.yaml')))
})

// ---------------------------------------------------------------- R9：钉直接依赖

test('R9 有参考 Profile：npm 范围 / tag 钉成 Profile 里实装的版本，github 钉到锁文件里的提交，精确版本原样', async () => {
  const id = await applied()
  const { manifest } = await exportFile({ id })
  // 一次比对全部依赖：哪几条钉错了一眼看全
  assert.deepEqual(manifest.dependencies, {
    'dsh-x-foo': '1.0.0', // ^1.0.0 → Profile 里装的 1.0.0（registry 满足范围的最高是 1.5.0）
    '@acme/dsh-bar': '2.1.0', // tag latest → Profile 里装的 2.1.0（registry 的 latest 是 2.3.0）
    'dsh-x-gh': `github:octo/dsh-x-gh#${COMMIT}`, // github → 锁文件里的提交
    'dsh-x-exact': '1.2.3', // 精确版本原样
    'dsh-x-far': '1.0.0', // Profile 里没装 → registry 里满足 ^1.0.0 的最高版本
    'dsh-x-stale': '2.4.0', // 装着的 1.0.0 不在 ^2.0.0 里 → registry 里满足的最高版本
    'dsh-x-pre': '1.2.0', // 装着的 1.1.0-beta.1 是预发布、不算满足 ^1.0.0 → registry 里满足的最高版本
    'dsh-x-extra': '1.0.0',
  })
  assert.equal(manifest.dshVersion, '1.0.0')
})

test('R9 没有参考 Profile：范围 / tag 取已发布里满足的最高版本；解析不了的原样带并点名提醒；github 找不到提交原样带并提醒', async () => {
  // 只导入不启动：这个环境从没写进过任何 Profile
  const dir = writePackDir(join(env.root, 'packs', 'never-applied'), baseManifest({
    name: 'never-applied',
    dshVersion: '1.1.0',
    dependencies: {
      'dsh-x-foo': '^1.0.0',
      '@acme/dsh-bar': 'latest',
      'dsh-x-tagged': 'next',
      'dsh-x-unknown': '^1.0.0',
      'dsh-x-far': '^9.0.0',
      'dsh-x-gh2': 'github:octo/dsh-x-gh2',
      'dsh-x-ghpinned': `github:octo/dsh-x-ghpinned#${COMMIT}`,
    },
    bundles: [BASE, WEB, 'dsh-x-foo', '@acme/dsh-bar', 'dsh-x-tagged', 'dsh-x-unknown', 'dsh-x-far', 'dsh-x-gh2', 'dsh-x-ghpinned'],
  }))
  const inspected = await okPost('/api/environments/import/inspect', { source: dir })
  assert.equal(inspected.ok, true, JSON.stringify(inspected.errors))
  const { environment } = await okPost('/api/environments/import', { token: inspected.token })
  const { data, manifest } = await exportFile({ id: environment.id })
  const deps = manifest.dependencies
  assert.equal(deps['dsh-x-foo'], '1.5.0', '^1.0.0 → 已发布里满足的最高版本')
  assert.equal(deps['@acme/dsh-bar'], '2.3.0', 'latest → 已发布的 latest')
  assert.equal(deps['dsh-x-tagged'], '0.9.0-beta.2', 'tag → tag 指向的版本')
  assert.equal(deps['dsh-x-unknown'], '^1.0.0', 'registry 里没有：原样带')
  assert.equal(deps['dsh-x-far'], '^9.0.0', '没有满足范围的版本：原样带')
  assert.equal(deps['dsh-x-gh2'], 'github:octo/dsh-x-gh2', '找不到提交：原样带')
  assert.equal(deps['dsh-x-ghpinned'], `github:octo/dsh-x-ghpinned#${COMMIT}`, '已钉提交的原样')
  for (const name of ['dsh-x-unknown', 'dsh-x-far', 'dsh-x-gh2']) {
    assert.ok(data.warnings.some((line) => line.includes(name)), `${name} 没钉上要点名提醒：${JSON.stringify(data.warnings)}`)
  }
  for (const name of ['dsh-x-foo', '@acme/dsh-bar', 'dsh-x-tagged', 'dsh-x-ghpinned']) {
    assert.ok(!data.warnings.some((line) => line.includes(name)), `${name} 钉好了，不该提醒`)
  }
})

test('R9 本地 tarball：原样带进 offline/，清单里有 file + sha256，坐标改写成 file:offline/…', async () => {
  const created = await createEnv('本地 tarball', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`, 'dsh-x-foo@1.0.0'])
  const { data, entries, manifest } = await exportFile({ id: created.id })
  const declared = manifest.offline?.['dsh-x-local-tgz']
  assert.ok(declared, `清单要声明离线文件：${JSON.stringify(manifest.offline)}`)
  assert.match(declared.file, /^offline\/[^/]+\.tgz$/)
  assert.match(declared.sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.dependencies['dsh-x-local-tgz'], `file:${declared.file}`, '坐标指向包里的离线文件')
  const data2 = entries.get(declared.file)
  assert.ok(data2, '离线文件要在包里')
  assert.ok(data2.equals(TGZ), '现成的 tarball 原样带上')
  assert.equal(sha256(data2), declared.sha256)
  assert.deepEqual(data.offline, ['dsh-x-local-tgz'], '响应列出带了离线文件的插件')
})

test('R9 本地目录：按 npm pack 规则打成 tarball 进 offline/（不带 node_modules、.git），sha256 对得上', { skip: NO_NPM }, async () => {
  const created = await createEnv('本地目录', '1.1.0', [`dsh-x-local-dir@link:${LOCAL_DIR}`])
  const { entries, manifest } = await exportFile({ id: created.id })
  const declared = manifest.offline?.['dsh-x-local-dir']
  assert.ok(declared, `清单要声明离线文件：${JSON.stringify(manifest.offline)}`)
  assert.equal(manifest.dependencies['dsh-x-local-dir'], `file:${declared.file}`)
  const tarball = entries.get(declared.file)
  assert.ok(tarball, '离线文件要在包里')
  assert.equal(sha256(tarball), declared.sha256)
  const files = [...readTgz(tarball).keys()]
  for (const name of ['package/package.json', 'package/index.js', 'package/lib/util.js']) assert.ok(files.includes(name), `${name} 要打进去：${files}`)
  assert.ok(!files.some((name) => name.includes('node_modules/')), `npm pack 不带 node_modules：${files}`)
  assert.ok(!files.some((name) => name.includes('.git/')), `npm pack 不带 .git：${files}`)
  assert.equal(JSON.parse(readTgz(tarball).get('package/package.json')).version, '0.3.0')
})

test('R9 exclude 点名的本地插件、路径已不存在的本地插件：依赖和挂载里都去掉，各有一条点名提醒；官方组件留在 bundles', async () => {
  const created = await createEnv('去掉一些', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`, `dsh-x-gone@link:${GONE}`, 'dsh-x-foo@1.0.0'])
  rmSync(GONE, { recursive: true, force: true })
  const { data, entries, manifest } = await exportFile({ id: created.id, exclude: ['dsh-x-local-tgz'] })
  for (const name of ['dsh-x-local-tgz', 'dsh-x-gone']) {
    assert.ok(!(name in manifest.dependencies), `${name} 不能留在 dependencies`)
    assert.ok(!manifest.bundles.includes(name), `${name} 不能留在 bundles`)
    assert.ok(!(manifest.offline && name in manifest.offline), `${name} 不能有离线文件`)
    assert.ok(data.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(data.warnings)}`)
  }
  assert.deepEqual([...entries.keys()].filter((name) => name.startsWith('offline/')), [], '没有离线文件可带')
  assert.equal(manifest.dependencies['dsh-x-foo'], '1.0.0')
  assert.deepEqual(manifest.bundles, [BASE, WEB, 'dsh-x-foo'], '官方组件留着，其余顺序不变')
  assert.equal(data.plugins, 1)
})

// ---------------------------------------------------------------- R10：DSH 版本

test('R10 精确版本照写；auto 冻结成此刻会用的精确版本（正式版 / RC 两档各按自己的规则）', async () => {
  const exact = await createEnv('钉版本', '1.0.0')
  assert.equal((await exportFile({ id: exact.id })).manifest.dshVersion, '1.0.0')
  for (const channel of ['official', 'rc']) {
    const auto = await createEnv(`跟最新 ${channel}`, 'auto', [], { updateChannel: channel })
    // 预言用服务端如实报告的已装列表：本机若另有全局 npm 装的 dsh，它也算已装（见 update-channel-fixture.mjs 的说明）
    const want = expectedAuto(channel, { installed: (await env.state()).installed, published: INSTALLED })
    const { data, manifest } = await exportFile({ id: auto.id })
    assert.equal(manifest.dshVersion, want, `${channel}：冻结成 ${want}`)
    assert.equal(data.dshVersion, want)
    assert.equal((await envById(auto.id)).dshVersion, 'auto', '导出只冻结文件里的版本，环境本身仍跟随最新')
  }
})

test('R10 auto 的环境、本机一个能用的 DSH 都没有：导出报错，不写文件', async (t) => {
  const auto = await createEnv('无版本可冻', 'auto', [], { updateChannel: 'official' })
  env.installVersions([])
  t.after(() => env.installVersions(INSTALLED))
  const installed = (await env.state()).installed
  // 服务端也认全局 npm 装的 dsh；本机有的话造不出「一个都没装」，如实跳过而不是假装通过。
  if (installed.length) { t.skip(`本机另有全局安装的 dsh（${installed.join('、')}）`); return }
  await exportRejected({ id: auto.id }, '没有已装的 DSH 可冻结')
})

test('R10 auto（正式版档）的环境、本机只有 RC：没有「此刻会用的」版本，导出报错，不写文件', async (t) => {
  const auto = await createEnv('只有 RC 可冻', 'auto', [], { updateChannel: 'official' })
  env.installVersions(['1.2.0-rc.1'])
  t.after(() => env.installVersions(INSTALLED))
  // 先让服务端拉一次远端：知道远端有正式版，正式版档就不会退到 RC（版本类型的退档规则）
  await env.remote()
  const installed = (await env.state()).installed
  const want = expectedAuto('official', { installed, published: INSTALLED })
  if (want) { t.skip(`本机另有能用的 dsh（${installed.join('、')}），造不出「没有这一类」`); return }
  await exportRejected({ id: auto.id }, '本机没有正式版可冻结')
})

// ---------------------------------------------------------------- R11：校验（边界值）

test('R11 version：24 个字符可以、25 个拒绝；空格、中文拒绝；被拒不写文件', async () => {
  const created = await createEnv('版本号边界', '1.1.0')
  const ok24 = `1.0.0-${'a'.repeat(18)}`
  assert.equal(ok24.length, 24)
  assert.equal((await exportFile({ id: created.id, version: ok24 })).manifest.version, ok24)
  assert.equal((await exportFile({ id: created.id, version: '1' })).manifest.version, '1', '1 个字符可以')
  await exportRejected({ id: created.id, version: `${ok24}b` }, '25 个字符')
  await exportRejected({ id: created.id, version: '1.0 beta' }, '带空格')
  await exportRejected({ id: created.id, version: '版本一' }, '中文')
  await exportRejected({ id: created.id, version: '1.0.0/evil' }, '带斜杠')
})

test('R11 version 留空：从没导出 / 导入过的环境用 1.0.0；导入来的环境用它的包版本', async () => {
  const fresh = await createEnv('空版本', '1.1.0')
  assert.equal((await exportFile({ id: fresh.id, version: '' })).manifest.version, '1.0.0')
  const dir = writePackDir(join(env.root, 'packs', 'versioned'), baseManifest({ name: 'versioned', version: '3.1.4', dshVersion: '1.1.0' }))
  const inspected = await okPost('/api/environments/import/inspect', { source: dir })
  const { environment } = await okPost('/api/environments/import', { token: inspected.token })
  assert.equal((await exportFile({ id: environment.id, version: '' })).manifest.version, '3.1.4')
})

test('R11 repo：owner/repo 写进 environment.repo；只有 owner、多一级、带空格拒绝；留空不写', async () => {
  const created = await createEnv('仓库校验', '1.1.0')
  assert.deepEqual((await exportFile({ id: created.id, repo: 'octo/env-pack' })).manifest.environment, { repo: 'octo/env-pack' })
  for (const repo of ['octo', 'a/b/c', 'octo/re po', 'https://github.com/octo/env-pack']) {
    await exportRejected({ id: created.id, repo }, `repo = ${repo}`)
  }
  assert.ok(!('environment' in (await exportFile({ id: created.id, repo: '' })).manifest))
})

test('R11 不存在的环境：导出报错', async () => {
  await exportRejected({ id: 'no-such-env' }, '不存在的环境')
})

// ---------------------------------------------------------------- R12：仓库目录

test('R12 仓库目录：清单与离线文件直接写进选的文件夹，不加工作流时没有别的文件', async () => {
  const created = await createEnv('目录导出', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`])
  const dir = outDir('repo')
  const { data, tree, manifest } = await exportDir({ id: created.id }, dir)
  assert.equal(data.target, 'dir')
  const declared = manifest.offline['dsh-x-local-tgz']
  assert.deepEqual([...tree.keys()].sort(), ['dspack.json', declared.file, 'manifest.json'].sort())
  assert.ok(tree.get(declared.file).equals(TGZ))
  assert.equal(sha256(tree.get(declared.file)), declared.sha256)
})

test('R12 workflow: true 加 release 工作流；已有的工作流不覆盖，并给一条提醒', async () => {
  const created = await createEnv('带工作流', '1.1.0')
  const dir = outDir('workflow')
  const file = join(dir, '.github', 'workflows', 'release-environment.yml')
  await exportDir({ id: created.id, workflow: true }, dir)
  assert.ok(existsSync(file), '要写出 .github/workflows/release-environment.yml')
  assert.ok(readFileSync(file, 'utf8').trim().length > 0)

  const plain = await exportDir({ id: created.id }, dir)
  writeFileSync(file, '# 作者自己改过的工作流\n')
  const again = await exportDir({ id: created.id, workflow: true }, dir)
  assert.equal(readFileSync(file, 'utf8'), '# 作者自己改过的工作流\n', '已有的工作流不能覆盖')
  assert.ok(again.data.warnings.length > plain.data.warnings.length, `没覆盖要说一声：${JSON.stringify(again.data.warnings)}`)
})

test('R12 重导：上次清单列过、这次不要的离线文件删掉；上次清单没列的文件一概不碰', async () => {
  const second = join(PLUGINS, 'dsh-x-second.tgz')
  const secondTgz = makeTgz({ 'package/package.json': '{"name":"dsh-x-second","version":"0.0.2"}\n' })
  writeFileSync(second, secondTgz)
  const created = await createEnv('重导清理', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`, `dsh-x-second@file:${second}`])
  const dir = outDir('reexport')
  const first = await exportDir({ id: created.id }, dir)
  const kept = first.manifest.offline['dsh-x-local-tgz'].file
  const dropped = first.manifest.offline['dsh-x-second'].file
  assert.ok(first.tree.has(kept) && first.tree.has(dropped), '前置条件：两个离线文件都写出来了')
  // 作者自己放的文件：不在上次清单里
  writeFileSync(join(dir, 'offline', 'author-own.tgz'), 'mine')
  writeFileSync(join(dir, 'README.md'), '# 我的环境\n')

  const next = await exportDir({ id: created.id, exclude: ['dsh-x-second'] }, dir)
  assert.equal(next.tree.has(dropped), false, `${dropped} 上次列过、这次不要了，要删掉`)
  assert.ok(next.tree.has(kept), '这次还要的留着')
  assert.equal(next.tree.get('offline/author-own.tgz')?.toString(), 'mine', '上次清单没列的文件不碰')
  assert.equal(next.tree.get('README.md')?.toString(), '# 我的环境\n', '仓库里的其他文件不碰')
})

test('R12 重导（猜错）：旧清单里的离线文件路径跳出文件夹，也不能去删文件夹外面的文件', async () => {
  const created = await createEnv('越界清单', '1.1.0')
  const parent = outDir('escape')
  const dir = join(parent, 'repo')
  mkdirSync(join(dir, 'offline'), { recursive: true })
  const victim = join(parent, 'victim.tgz')
  writeFileSync(victim, 'do not delete')
  // 带上合法的标记文件：这样它算「之前导出过的环境仓库」，测的是清旧离线文件那一步的安全性
  writeFileSync(join(dir, 'dspack.json'), JSON.stringify({ format: 'dspack', version: 3 }))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifestVersion: 5, name: 'x', offline: { x: { file: 'offline/../../victim.tgz', sha256: 'a'.repeat(64) } } }))
  await exportDir({ id: created.id }, dir)
  assert.equal(existsSync(victim) && readFileSync(victim, 'utf8'), 'do not delete', '文件夹外面的文件不能动')
})

// ---------------------------------------------------------------- R13：记回环境

test('R13 导出用的 version / description 记回环境；下次留空就沿用', async () => {
  const created = await createEnv('记住版本', '1.1.0')
  await exportFile({ id: created.id, version: '2.5.0', description: '这一版的说明' })
  const view = await envById(created.id)
  assert.equal(view.packVersion, '2.5.0')
  assert.equal(view.description, '这一版的说明')
  const next = await exportFile({ id: created.id, version: '' })
  assert.equal(next.manifest.version, '2.5.0', '空版本沿用上次导出的')
  assert.equal(next.manifest.description, '这一版的说明', '不传 description 沿用上次的')
})

// ---------------------------------------------------------------- R14：dsh 内置市场装的插件

test('R14 参考 Profile 里有 .dsh-market：导出多一条提醒（那些插件不在 package.json 里，带不走）', async (t) => {
  const id = await applied()
  const before = await exportFile({ id })
  const market = join(refDir, '.dsh-market')
  mkdirSync(join(market, 'some-plugin'), { recursive: true })
  writeFileSync(join(market, 'some-plugin', 'package.json'), '{"name":"some-plugin","version":"1.0.0"}')
  t.after(() => rmSync(market, { recursive: true, force: true }))
  const after = await exportFile({ id })
  const extra = after.data.warnings.filter((line) => !before.data.warnings.includes(line))
  assert.equal(extra.length, 1, `有 .dsh-market 要多一条提醒：${JSON.stringify(after.data.warnings)}`)
  assert.ok(!('some-plugin' in after.manifest.dependencies), '市场插件不进依赖表')
})

// ---------------------------------------------------------------- R15：来回

async function roundTrip(specs, offlineNames) {
  const created = await createEnv(`来回 ${(seq += 1)}`, '1.1.0', specs)
  const original = await envById(created.id)
  const { path, manifest } = await exportFile({ id: created.id, version: '1.0.0' })
  const inspected = await okPost('/api/environments/import/inspect', { source: path })
  assert.equal(inspected.ok, true, `导出的包要能导回来：${JSON.stringify(inspected.errors)}`)
  const { environment } = await okPost('/api/environments/import', { token: inspected.token })
  const back = await envById(environment.id)
  assert.equal(back.dshVersion, original.dshVersion, 'DSH 版本相同')
  assert.deepEqual(namesOf(back), namesOf(original), '插件名相同')
  assert.deepEqual(back.bundles, original.bundles, '挂载顺序相同')
  for (const name of offlineNames) {
    const declared = manifest.offline[name]
    const extracted = extractedOfflinePath(env.app, environment.id, declared.file, declared.sha256)
    assert.ok(existsSync(extracted), `${name} 的离线文件要解到 ${extracted}`)
    assert.equal(sha256(readFileSync(extracted)), declared.sha256, `${name} 解出来的摘要一致`)
    assert.equal(back.plugins.find((item) => item.name === name)?.spec, `file:${extracted}`)
  }
  return { path, manifest }
}

test('R15 来回：本地 tarball 插件 + npm 插件导出再导入，版本、插件、顺序、离线文件都对得上', async () => {
  const { manifest } = await roundTrip([`dsh-x-local-tgz@file:${TGZ_PATH}`, 'dsh-x-foo@1.0.0'], ['dsh-x-local-tgz'])
  assert.equal(manifest.offline['dsh-x-local-tgz'].sha256, sha256(TGZ), '现成 tarball 的摘要就是原文件的摘要')
})

test('R15 来回：本地目录插件（npm pack 出来的离线文件）也一样', { skip: NO_NPM }, async () => {
  await roundTrip([`dsh-x-local-dir@link:${LOCAL_DIR}`, `dsh-x-local-tgz@file:${TGZ_PATH}`], ['dsh-x-local-dir', 'dsh-x-local-tgz'])
})

test('R15 改过包里的离线文件：导入失败，不建环境', async () => {
  const created = await createEnv('被篡改', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`])
  const { path, manifest } = await exportFile({ id: created.id })
  const file = manifest.offline['dsh-x-local-tgz'].file
  writeFileSync(path, tamperPack(readFileSync(path), file, Buffer.concat([TGZ, Buffer.from('tampered')])))
  const before = (await listEnvs()).length
  const result = await env.call('/api/environments/import/inspect', { source: path })
  if (result.ok) {
    assert.equal(result.data.ok, false, '检查要报出问题')
    if (result.data.token) await rejected('/api/environments/import', { token: result.data.token }, '篡改过的包')
  }
  assert.equal((await listEnvs()).length, before, '不能建环境')
})

// ================================================================ 第二轮需求（代码评审之后）

// ---------------------------------------------------------------- N7：plugins/add 不收相对路径

test('N7 plugins/add：相对路径的本地坐标（link:../x、file:./x.tgz、file:../x）→ 400 且不落盘；绝对路径照收', async () => {
  const created = await createEnv('相对路径', '1.1.0')
  for (const spec of ['dsh-x-rel@link:../x', 'dsh-x-rel@file:./x.tgz', 'dsh-x-rel@file:../x']) {
    const result = await env.call('/api/environments/plugins/add', { id: created.id, spec })
    assert.equal(result.status, 400, `${spec}：HTTP ${result.status} ${JSON.stringify(result.data)}`)
    assert.equal(typeof result.data?.error, 'string')
  }
  assert.ok(!(await envById(created.id)).plugins.some((item) => item.name === 'dsh-x-rel'), '被拒的坐标不能落盘')
  await okPost('/api/environments/plugins/add', { id: created.id, spec: `dsh-x-abs-dir@link:${LOCAL_DIR}` })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: `dsh-x-abs-tgz@file:${TGZ_PATH}` })
  const view = await envById(created.id)
  assert.equal(view.plugins.find((item) => item.name === 'dsh-x-abs-dir')?.spec, `link:${LOCAL_DIR}`)
  assert.equal(view.plugins.find((item) => item.name === 'dsh-x-abs-tgz')?.spec, `file:${TGZ_PATH}`)
})

// ---------------------------------------------------------------- R12（变更）：不是环境仓库的文件夹

test('R12（变更）文件夹里有 manifest.json 却不是之前导出的环境仓库：400、错误提到 manifest.json、文件夹原样不动', async () => {
  const marker = JSON.stringify({ format: 'dspack', version: 3 })
  const manifest = JSON.stringify({ manifestVersion: 5, name: 'x' })
  const cases = [
    ['只有 manifest.json，没有 dspack.json', { 'manifest.json': manifest }],
    ['dspack.json 的 format 不是 dspack', { 'dspack.json': JSON.stringify({ format: 'zip' }), 'manifest.json': manifest }],
    ['dspack.json 不是 JSON', { 'dspack.json': '{nope', 'manifest.json': manifest }],
    ['manifest.json 不是 JSON', { 'dspack.json': marker, 'manifest.json': '{nope' }],
    ['manifestVersion 9', { 'dspack.json': marker, 'manifest.json': JSON.stringify({ manifestVersion: 9, name: 'x' }) }],
    ['网页应用的 manifest.json（没有 manifestVersion）', { 'dspack.json': marker, 'manifest.json': JSON.stringify({ name: 'my-pwa', icons: [] }) }],
  ]
  const created = await createEnv('不覆盖别人的文件夹', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`])
  for (const [why, files] of cases) {
    const dir = outDir('foreign')
    for (const [name, data] of Object.entries({ ...files, 'README.md': '# 别人的项目\n' })) writeFileSync(join(dir, name), data)
    const before = readTree(dir)
    const result = await env.call('/api/environments/export', { id: created.id, target: 'dir', path: dir, workflow: true })
    assert.equal(result.status, 400, `${why}：HTTP ${result.status} ${JSON.stringify(result.data)}`)
    assert.match(String(result.data?.error), /manifest\.json/, `${why}：错误要提到 manifest.json`)
    assert.deepEqual(readTree(dir), before, `${why}：文件夹要原样不动`)
  }
})

test('R12（变更）没有 manifest.json 的文件夹（只放了别的文件）照常导出，别的文件不动', async () => {
  const created = await createEnv('普通文件夹', '1.1.0')
  const dir = outDir('plain-folder')
  writeFileSync(join(dir, 'README.md'), '# 我的仓库\n')
  const { tree } = await exportDir({ id: created.id }, dir)
  assert.ok(tree.has('manifest.json') && tree.has('dspack.json'))
  assert.equal(tree.get('README.md').toString(), '# 我的仓库\n')
})

// ---------------------------------------------------------------- N6：会漂的坐标

test('N6 会漂的坐标原样导出并点名提醒；精确别名、钉了提交的 git、直链 tarball 原样导出不提醒', async () => {
  const profile = 'float-ref'
  const floating = {
    'dsh-x-alias-range': 'npm:dsh-x-foo@^1.0.0',
    'dsh-x-alias-tag': 'npm:dsh-x-foo@latest',
    'dsh-x-git-plain': 'git+https://github.com/octo/plain.git',
    'dsh-x-git-ssh': 'git@github.com:octo/ssh.git',
    'dsh-x-git-proto': 'git://github.com/octo/proto.git#main',
  }
  const fixed = {
    'dsh-x-alias-exact': 'npm:dsh-x-foo@1.0.0',
    'dsh-x-git-pinned': `git+https://github.com/octo/pinned.git#${COMMIT}`,
    'dsh-x-url': 'https://example.com/dsh-x-url-1.0.0.tgz',
  }
  const deps = { ...floating, ...fixed }
  seedProfile(env.home, profile, profileManifest(profile, { dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }))
  const { entry } = await okPost('/api/launch-presets', { name: '会漂的坐标', version: '1.1.0', profile })
  assert.ok(entry.environment, '前置条件：从 Profile 收养出环境')
  const { data, manifest } = await exportFile({ id: entry.environment })
  for (const [name, spec] of Object.entries(deps)) assert.equal(manifest.dependencies[name], spec, `${name} 原样导出`)
  for (const name of Object.keys(floating)) assert.ok(data.warnings.some((line) => line.includes(name)), `${name} 会漂，要点名提醒：${JSON.stringify(data.warnings)}`)
  for (const name of Object.keys(fixed)) assert.ok(!data.warnings.some((line) => line.includes(name)), `${name} 不会漂，不该提醒`)
})

// ---------------------------------------------------------------- N6：本地插件里的敏感文件

const SENSITIVE = ['.env', '.npmrc', 'server.pem', 'deploy.key', 'id_rsa', 'credentials.json', '.netrc', 'settings.yaml']
test('N6 本地 tarball 插件里有凭据类文件：导出照常，每个文件一条点名插件和文件的提醒；普通文件不报', async () => {
  const leaky = join(PLUGINS, 'dsh-x-leaky.tgz')
  writeFileSync(leaky, makeTgz({
    'package/package.json': '{"name":"dsh-x-leaky","version":"1.0.0"}\n',
    'package/index.js': 'export default 1\n',
    'package/keyboard.js': 'export default 2\n',
    'package/.env': 'TOKEN=1\n',
    'package/.npmrc': '//registry/:_authToken=x\n',
    'package/certs/server.pem': 'pem\n',
    'package/keys/deploy.key': 'key\n',
    'package/id_rsa': 'rsa\n',
    'package/credentials.json': '{}\n',
    'package/.netrc': 'machine x\n',
    'package/config/settings.yaml': 'a: 1\n',
  }))
  const created = await createEnv('带凭据的插件', '1.1.0', [`dsh-x-leaky@file:${leaky}`])
  const { data, manifest } = await exportFile({ id: created.id })
  assert.ok(manifest.offline?.['dsh-x-leaky'], '只提醒，不拦导出')
  for (const file of SENSITIVE) {
    assert.ok(data.warnings.some((line) => line.includes('dsh-x-leaky') && line.includes(file)), `${file} 要点名提醒：${JSON.stringify(data.warnings)}`)
  }
  for (const file of ['keyboard.js', 'index.js', 'package.json']) assert.ok(!data.warnings.some((line) => line.includes(file)), `${file} 不该报`)
})

test('N6 本地目录插件：npm pack 打进去了的凭据类文件才提醒（被 npm pack 排除的不报）', { skip: NO_NPM }, async () => {
  const dir = writePluginDir(join(PLUGINS, 'leaky-dir'), {
    name: 'dsh-x-leaky-dir',
    version: '0.1.0',
    extra: { '.env': 'TOKEN=1\n', '.npmrc': '//registry/:_authToken=x\n', 'certs/server.pem': 'pem\n' },
  })
  const created = await createEnv('带凭据的目录插件', '1.1.0', [`dsh-x-leaky-dir@link:${dir}`])
  const { data, entries, manifest } = await exportFile({ id: created.id })
  const packed = [...readTgz(entries.get(manifest.offline['dsh-x-leaky-dir'].file)).keys()].map((name) => name.split('/').pop())
  const included = ['.env', '.npmrc', 'server.pem'].filter((file) => packed.includes(file))
  assert.ok(included.length > 0, `前置条件：npm pack 至少带进去一个凭据类文件：${packed}`)
  for (const file of ['.env', '.npmrc', 'server.pem']) {
    const warned = data.warnings.some((line) => line.includes('dsh-x-leaky-dir') && line.includes(file))
    assert.equal(warned, included.includes(file), `${file}：${included.includes(file) ? '打进去了要提醒' : 'npm pack 没带，不该提醒'}：${JSON.stringify(data.warnings)}`)
  }
})

// ---------------------------------------------------------------- N6：离线文件名撞车

test('N6 两个本地 tarball 插件（@foo/bar 与 foo-bar 同版本）：离线文件名不同，都能来回', async () => {
  const scoped = join(PLUGINS, 'scoped-foo-bar.tgz')
  const plain = join(PLUGINS, 'plain-foo-bar.tgz')
  writeFileSync(scoped, makeTgz({ 'package/package.json': '{"name":"@foo/bar","version":"1.0.0"}\n', 'package/index.js': 'export default "scoped"\n' }))
  writeFileSync(plain, makeTgz({ 'package/package.json': '{"name":"foo-bar","version":"1.0.0"}\n', 'package/index.js': 'export default "plain"\n' }))
  const { manifest } = await roundTrip([`@foo/bar@file:${scoped}`, `foo-bar@file:${plain}`], ['@foo/bar', 'foo-bar'])
  assert.notEqual(manifest.offline['@foo/bar'].file, manifest.offline['foo-bar'].file, '两个离线文件名不能一样')
  assert.equal(manifest.offline['@foo/bar'].sha256, sha256(readFileSync(scoped)))
  assert.equal(manifest.offline['foo-bar'].sha256, sha256(readFileSync(plain)))
})

test('N6 两个本地目录插件（@foo/bar 与 foo-bar 都是 1.0.0）：离线文件名不同，都能来回', { skip: NO_NPM }, async () => {
  const scoped = writePluginDir(join(PLUGINS, 'dir-scoped-foo-bar'), { name: '@foo/bar', version: '1.0.0' })
  const plain = writePluginDir(join(PLUGINS, 'dir-plain-foo-bar'), { name: 'foo-bar', version: '1.0.0' })
  const { manifest } = await roundTrip([`@foo/bar@link:${scoped}`, `foo-bar@link:${plain}`], ['@foo/bar', 'foo-bar'])
  assert.notEqual(manifest.offline['@foo/bar'].file, manifest.offline['foo-bar'].file, '两个离线文件名不能一样')
})

// ---------------------------------------------------------------- N6：大小上限

test('N6 大小上限：单文件导出超过 32 MB → 报错、不写文件；文件夹导出超过 32 MB → 照写，只多一条提醒', async () => {
  const huge = join(PLUGINS, 'dsh-x-huge.tgz')
  // 随机内容压不小：tarball 本身就超过 32 MB
  writeFileSync(huge, makeTgz({ 'package/package.json': '{"name":"dsh-x-huge","version":"1.0.0"}\n', 'package/blob.bin': randomBytes(33 * 1024 * 1024) }))
  assert.ok(statSync(huge).size > 32 * 1024 * 1024, '前置条件：素材超过 32 MB')
  const created = await createEnv('超大', '1.1.0', [`dsh-x-huge@file:${huge}`])
  await exportRejected({ id: created.id }, '超过 32 MB 的单文件导出')

  const small = await createEnv('不大', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`])
  const baseline = await exportDir({ id: small.id }, outDir('small-folder'))
  const dir = outDir('huge-folder')
  const { data, tree, manifest } = await exportDir({ id: created.id }, dir)
  assert.ok(tree.has(manifest.offline['dsh-x-huge'].file), '文件夹导出照样写出离线文件')
  assert.ok(data.warnings.length > baseline.data.warnings.length, `超过上限要多一条提醒：${JSON.stringify(data.warnings)}`)
})

// ---------------------------------------------------------------- N6：文件夹导出的先后

test('N6 文件夹重导：新文件写不进去时导出失败，上次的离线文件还在（先写新的、再删旧的）', async () => {
  const second = join(PLUGINS, 'dsh-x-order.tgz')
  writeFileSync(second, makeTgz({ 'package/package.json': '{"name":"dsh-x-order","version":"0.0.9"}\n' }))
  const before = await createEnv('先写后删甲', '1.1.0', [`dsh-x-local-tgz@file:${TGZ_PATH}`])
  const after = await createEnv('先写后删乙', '1.1.0', [`dsh-x-order@file:${second}`])
  const dir = outDir('order')
  const stale = (await exportDir({ id: before.id }, dir)).manifest.offline['dsh-x-local-tgz'].file
  // 先在别处导一次，知道乙的离线文件叫什么；再在目标文件夹那个位置放一个目录，让它写不进去
  const fresh = (await exportDir({ id: after.id }, outDir('order-probe'))).manifest.offline['dsh-x-order'].file
  mkdirSync(join(dir, fresh), { recursive: true })
  const result = await env.call('/api/environments/export', { id: after.id, target: 'dir', path: dir })
  assert.equal(result.ok, false, `前置条件：新离线文件写不进去，这次导出应失败：${JSON.stringify(result.data)}`)
  assert.ok(existsSync(join(dir, stale)), '新文件没写成，上次的离线文件不能先被删掉')
  assert.ok(readFileSync(join(dir, stale)).equals(TGZ), '上次的离线文件内容不变')
})

// ---------------------------------------------------------------- N6：相对路径的本地插件

test('N6 参考 Profile 里相对路径的本地 tarball（file:./vendor/x.tgz）：按那个 Profile 目录解析，带进 offline/', async () => {
  const profile = 'rel-ref'
  const relTgz = makeTgz({ 'package/package.json': '{"name":"dsh-x-rel-tgz","version":"0.2.0"}\n', 'package/index.js': 'export default "rel"\n' })
  const deps = { 'dsh-x-rel-tgz': 'file:./vendor/rel.tgz' }
  seedProfile(env.home, profile, profileManifest(profile, { dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }))
  mkdirSync(join(profileDir(env.home, profile), 'vendor'), { recursive: true })
  writeFileSync(join(profileDir(env.home, profile), 'vendor', 'rel.tgz'), relTgz)
  const id = await applyFromProfile(profile, '相对路径参考')
  const { data, entries, manifest } = await exportFile({ id })
  const declared = manifest.offline?.['dsh-x-rel-tgz']
  assert.ok(declared, `相对路径的本地插件要带进 offline/：${JSON.stringify(data.warnings)}`)
  assert.ok(entries.get(declared.file)?.equals(relTgz), '带上的就是 Profile 目录下那份')
  assert.equal(manifest.dependencies['dsh-x-rel-tgz'], `file:${declared.file}`)
})

test('N6 参考 Profile 里相对路径的本地目录（link:../../x）：按那个 Profile 目录解析，打成离线文件', { skip: NO_NPM }, async () => {
  const profile = 'rel-dir-ref'
  writePluginDir(join(env.home, 'rel-plugins', 'rel-dir'), { name: 'dsh-x-rel-dir', version: '0.5.0' })
  const deps = { 'dsh-x-rel-dir': 'link:../../rel-plugins/rel-dir' }
  seedProfile(env.home, profile, profileManifest(profile, { dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }))
  const id = await applyFromProfile(profile, '相对目录参考')
  const { data, entries, manifest } = await exportFile({ id })
  const declared = manifest.offline?.['dsh-x-rel-dir']
  assert.ok(declared, `相对路径的本地目录要打成离线文件：${JSON.stringify(data.warnings)}`)
  assert.equal(JSON.parse(readTgz(entries.get(declared.file)).get('package/package.json')).name, 'dsh-x-rel-dir')
})
