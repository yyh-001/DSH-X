/**
 * 导入环境文件（系统测试）：进程内真服务 + 隔离用户目录 + 离线假服务（npm registry 带真 tarball、直链站、市场索引、
 * 走代理的假 GitHub）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   R1 来源：本地 .dspack、本地目录、http(s) 直链、GitHub owner/repo（最新 release 里的 .dspack）、市场条目、内置配方都能导成环境
 *   R2 检查（inspect）只读：不存环境、不写任何 Profile；确认导入才建环境；token 只能用一次
 *   R3 DSH 版本：精确照用；范围取本机已装里满足的最高版本；本机没有就取已发布里满足的最高版本、导入时自动装
 *      （检查时 dshInstalled: false）；都不满足 → 检查报错、导入被拒；没写 → 跟随最新并给提醒；环境里记精确版本或跟随最新
 *   R4 离线文件：offline 字段声明 file + sha256，坐标 file:offline/<名>.tgz；导入时解到 <APP_DIR>/envs/<id>/files/<名>.tgz，
 *      坐标换成那里的绝对路径；检查时单独列出（name / file / sha256 / bytes）；摘要不对、文件缺、声明不全、坐标没核对过 → 拒绝
 *   R5 整机快照拒收；老包 bundles 只列插件 → 补官方骨架；指向作者本机路径（link:/file:，非离线）的依赖给提醒
 *   R6 配置（补丁层、overrides/、home/）默认跳过并在 profileData 里列出；带 profile 时走现有的备份 / 回滚写进去；
 *      不写 package.json / pnpm-lock.yaml / pnpm-workspace.yaml；没配置却要导配置 → 报错；Profile 有实例在跑 → 装任何东西之前拒绝；
 *      配置写失败时环境留着、config.error 说明原因
 *   R7 来源：GitHub / 带仓库的市场条目记下仓库并跟随；否则用清单里的 environment.repo；都没有就不跟随；
 *      记下 packId / packVersion；市场条目记 source.marketId，包版本成为环境的 packVersion
 *
 * 第二轮需求（代码评审之后）：
 *   R4（变更）离线文件解到 files/<sha256 前 8 位>/<名>.tgz；R5（变更）本机路径依赖导入时连挂载一起去掉、点名提醒
 *   N1 导入把 npm 范围 / tag 钉成已发布里满足的最高精确版本，检查预览里就是钉好的；查不到原样留并点名提醒
 *   N2 确认导入用的就是检查时看到的（DSH 版本、钉好的坐标）；包在检查之后变了 → 拒绝、提示重新检查、什么都不建；
 *      成功导入吃掉 token；失败（DSH 装不上、Profile 忙）同一个 token 可以重试
 *   N3 认不出的依赖（坏包名、坐标超过 512 个字符）点名提醒、不进环境；N4 依赖写 bundled / bundled:<名> → 报错
 *   N5 复制环境连离线文件一起拷到新环境自己的 files/，删了原环境副本照样能用
 *   N8 /api/environments/* 的 POST 失败一律 400 + { error }
 *   N9 配置导入记成 configOnly 记录、能按它撤销；重导只替换那条 configOnly 记录，不动同名的旧整包记录；
 *      Profile 没有 package.json 而包里有补丁层 / overrides → config.error、环境照存；x-dsh-home 决定配置写到哪个用户目录
 *   N11 GET /api/environments 带 defaults: { packVersion: "1.0.0" }
 *
 * 设计：等价类（六种来源；DSH 版本写法：精确已装 / 精确未装 / 范围本机满足 / 范围远端满足 / 无人满足 / 没写）、
 * 边界值（范围端点含不含）、决策表（离线文件「声明完整 × 文件在 × 摘要对」；配置导入「包有没有配置 × 给没给 profile ×
 * Profile 忙不忙」）、状态迁移（检查 → 导入 → token 作废）。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import { BASE, WEB, profileDir, profileManifest, recordingBin, seedProfile, snapshotDir, waitFor } from './environments-fixture.mjs'
import {
  REPO_ROOT, baseManifest, dshTarball, extractedOfflinePath, makeTgz, npmUnavailableReason, packBuffer, sha256, startFakeGithub, startNpmRegistry,
  startStaticSite, writePackDir, writePackFile,
} from './environment-pack-fixture.mjs'

// 假 GitHub 是自签证书的 https 源站（经代理隧道过去），只能这么连；只影响这个测试进程
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const NO_NPM = npmUnavailableReason()

// 已发布 1.0.0–2.0.0，本机只装了 1.0.0–1.2.0：「本机满足」与「只有远端满足」两条路都走得到
const PUBLISHED = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0']
const INSTALLED = ['1.0.0', '1.1.0', '1.2.0']
// 注意：src/settings.js（以及 server.js）在导入时就按 HOME 定下设置目录，绝不能在夹具隔离 HOME 之前静态导入
const env = await startChannelServer({
  prefix: 'dsh-env-import-',
  packument: packumentOf({ latest: '2.0.0' }, PUBLISHED),
  installed: INSTALLED,
  bin: recordingBin,
})
const registry = await startNpmRegistry({
  '@deepseek-ai/dsh': {
    tags: { latest: '2.0.0' },
    versions: PUBLISHED,
    // 能被 npm 真装上的两个版本：自动安装的用例要它
    tarballs: { '1.3.0': dshTarball('1.3.0', recordingBin('1.3.0')), '2.0.0': dshTarball('2.0.0', recordingBin('2.0.0')) },
  },
  'dsh-x-foo': { tags: { latest: '2.0.0' }, versions: ['1.0.0', '1.5.0', '2.0.0'] },
  '@acme/dsh-bar': { tags: { latest: '2.3.0' }, versions: ['2.1.0', '2.3.0'] },
  'dsh-x-tagged': { tags: { latest: '0.8.0', next: '0.9.0-beta.2' }, versions: ['0.8.0', '0.9.0-beta.2'] },
  // 检查之后会「发新版」的包：确认导入要用检查时钉的那个
  'dsh-x-moving': { tags: { latest: '1.1.0' }, versions: ['1.0.0', '1.1.0'] },
})
process.env.npm_config_registry = registry.url
const site = await startStaticSite()
test.after(async () => {
  await env.cleanup()
  await registry.close()
  await site.close()
})

// ---------------------------------------------------------------- 驱动件

async function okPost(path, body, headers) {
  const result = await env.call(path, body, headers)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
// 装完新版会顺手清旧版本：关掉，免得自动安装的用例把夹具里的已装版本删了；下载源用官方，GitHub 不套镜像前缀
await okPost('/api/settings', { autoCleanVersions: false, downloadSource: 'official', proxyMode: 'off' })

/** 期望被拒：非 2xx 且带 error 文案。 */
async function rejected(path, body, why) {
  const result = await env.call(path, body)
  assert.equal(result.ok, false, `${why}：应被拒绝，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.ok(result.status >= 400, `${why}：要回错误状态码`)
  assert.equal(typeof result.data?.error, 'string', `${why}：要带 error 文案`)
  return result
}
const listEnvs = async () => (await env.getJson('/api/environments')).environments
const envById = async (id) => (await listEnvs()).find((item) => item.id === id)
const envDir = (id) => join(env.app, 'envs', id)
/** 环境目录下现有的子目录（还没有 envs 目录时是空表）。 */
const envDirs = () => (existsSync(join(env.app, 'envs')) ? readdirSync(join(env.app, 'envs')).sort() : [])
const specOf = (view, name) => (view?.plugins || []).find((item) => item.name === name)?.spec
const namesOf = (view) => (view?.plugins || []).filter((item) => !item.official).map((item) => item.name).sort()

async function inspect(body, headers) {
  return env.call('/api/environments/import/inspect', body, headers)
}
/** 检查要通过：HTTP 2xx、ok 为真、没有 errors。 */
async function okInspect(body, headers) {
  const result = await inspect(body, headers)
  assert.ok(result.ok, `检查失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(result.data.ok, true, `检查应通过：${JSON.stringify(result.data.errors)}`)
  assert.equal(typeof result.data.token, 'string', '要回 token')
  assert.ok(result.data.token.length > 0)
  return result.data
}
/** 检查要报出问题：要么 HTTP 报错，要么 ok 为假且 errors 非空（两种都算「检查报了错」）。返回 token（有的话）。 */
async function problemInspect(body, why) {
  const result = await inspect(body)
  if (!result.ok) {
    assert.equal(typeof result.data?.error, 'string', `${why}：HTTP 报错要带 error 文案`)
    return ''
  }
  assert.equal(result.data.ok, false, `${why}：检查应报出问题，实际 ${JSON.stringify(result.data).slice(0, 400)}`)
  assert.ok(Array.isArray(result.data.errors) && result.data.errors.length > 0, `${why}：errors 要列出原因`)
  return result.data.token || ''
}
async function confirmImport(token, extra = {}, headers) {
  const data = await okPost('/api/environments/import', { token, ...extra }, headers)
  assert.equal(data.ok, true)
  assert.ok(data.environment?.id, `导入要回 environment：${JSON.stringify(data).slice(0, 300)}`)
  return data
}
/** 检查 + 导入，回导入结果与列表里的视图。 */
async function importSource(body, extra, headers) {
  const inspected = await okInspect(body, headers)
  const result = await confirmImport(inspected.token, extra, headers)
  return { inspected, result, view: await envById(result.environment.id) }
}
/** 有问题的包：检查报错，并且确认导入（有 token 的话）被拒，环境数量不变。 */
async function refusedSource(body, why) {
  const before = (await listEnvs()).length
  const token = await problemInspect(body, why)
  if (token) await rejected('/api/environments/import', { token }, `${why}：确认导入`)
  assert.equal((await listEnvs()).length, before, `${why}：不能留下环境`)
}

const PACKS = join(env.root, 'packs')
let seq = 0
/** 每个用例一份独立的包文件（名字带序号，环境 id 不会撞）。 */
function packFile(patch = {}, files = {}, options) {
  seq += 1
  const manifest = baseManifest({ name: `pack-${seq}`, displayName: `包 ${seq}`, ...patch })
  return writePackFile(join(PACKS, `pack-${seq}.dspack`), manifest, files, options)
}
const TGZ = makeTgz({ 'package/package.json': '{"name":"dsh-x-local","version":"1.0.0"}\n', 'package/index.js': 'export default 1\n' })
const OFFLINE_FILE = 'dsh-x-local-1.0.0.tgz'
const offlineManifest = (offline) => ({
  bundles: [BASE, WEB, 'dsh-x-local'],
  dependencies: { 'dsh-x-local': `file:offline/${OFFLINE_FILE}` },
  ...(offline === undefined ? { offline: { 'dsh-x-local': { file: `offline/${OFFLINE_FILE}`, sha256: sha256(TGZ) } } } : offline ? { offline } : {}),
})
const homeHeader = (dir) => ({ 'x-dsh-home': encodeURIComponent(dir) })
const packsCard = async (profile, headers) => {
  const result = await env.call('/api/packs', undefined, headers)
  assert.ok(result.ok, `GET /api/packs：HTTP ${result.status}`)
  return (Array.isArray(result.data.packs) ? result.data.packs : []).find((item) => item.profile === profile)
}
const versionBin = (version) => join(env.data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// ---------------------------------------------------------------- R1：来源

test('R1 本地 .dspack 文件：检查通过，导入后列表里有这个环境，插件和挂载顺序来自包', async () => {
  const file = packFile({ bundles: [BASE, WEB, 'dsh-x-foo', 'dsh-x-bar'], dependencies: { 'dsh-x-foo': '1.0.0', 'dsh-x-bar': '2.0.0' } })
  const { inspected, view } = await importSource({ source: file })
  assert.ok(inspected.bytes > 0, '要回包的大小')
  assert.deepEqual(inspected.environment.plugins.map((item) => item.name).sort(), ['dsh-x-bar', 'dsh-x-foo'])
  assert.ok(view, '导入的环境要出现在列表里')
  assert.equal(specOf(view, 'dsh-x-foo'), '1.0.0')
  assert.equal(specOf(view, 'dsh-x-bar'), '2.0.0')
  assert.deepEqual(view.bundles, [BASE, WEB, 'dsh-x-foo', 'dsh-x-bar'])
})

test('R1 本地目录形态的包：一样能导成环境', async () => {
  const dir = writePackDir(join(PACKS, 'dir-pack'), baseManifest({ name: 'dir-pack', dependencies: { 'dsh-x-dir': '0.1.0' }, bundles: [BASE, WEB, 'dsh-x-dir'] }))
  const { view } = await importSource({ source: dir })
  assert.equal(specOf(view, 'dsh-x-dir'), '0.1.0')
  assert.deepEqual(view.bundles, [BASE, WEB, 'dsh-x-dir'])
})

test('R1 http 直链：下载后导成环境', async () => {
  site.routes['/direct/linked.dspack'] = { body: packBuffer(baseManifest({ name: 'linked', dependencies: { 'dsh-x-linked-pack': '3.0.0' }, bundles: [BASE, WEB, 'dsh-x-linked-pack'] })) }
  const { view } = await importSource({ source: `${site.url}/direct/linked.dspack` })
  assert.ok(site.hits.includes('/direct/linked.dspack'), '真的去直链下载了')
  assert.equal(specOf(view, 'dsh-x-linked-pack'), '3.0.0')
})

test('R1 + R7 GitHub owner/repo：取最新 release 里的 .dspack；记下仓库、算跟随，仓库以来源为准', async (t) => {
  const pack = packBuffer(baseManifest({
    name: 'gh-pack', version: '2.1.0', dependencies: { 'dsh-x-gh-pack': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-gh-pack'],
    // 清单里另写了一个仓库：来源本身是 GitHub 时以来源为准
    environment: { repo: 'octo/declared-elsewhere' },
  }))
  const github = await startFakeGithub({ 'octo/env-pack': { tag: 'v2.1.0', assets: [{ name: 'notes.txt', data: Buffer.from('x') }, { name: 'gh-pack-2.1.0.dspack', data: pack }] } })
  await okPost('/api/settings', { proxyMode: 'manual', proxyUrl: github.proxyUrl })
  t.after(async () => {
    await okPost('/api/settings', { proxyMode: 'off' })
    await github.close()
  })
  const { inspected, view } = await importSource({ source: 'octo/env-pack' })
  assert.ok(github.connects.some((target) => target.startsWith('api.github.com')), '要去 GitHub 接口查 release')
  assert.equal(inspected.environment.source?.repo, 'octo/env-pack', '检查时就能看到来源仓库')
  assert.equal(specOf(view, 'dsh-x-gh-pack'), '1.0.0')
  assert.equal(view.following, true, 'GitHub 来的环境跟随上游')
  assert.equal(view.source?.repo, 'octo/env-pack', '记下的是来源仓库，不是清单里另写的那个')
  assert.equal(view.source?.packId, 'gh-pack')
  assert.equal(view.source?.packVersion, '2.1.0')
})

test('R1 + R7 市场条目：按条目下载；带 GitHub 仓库 → 跟随，记下 marketId，包版本成为环境的 packVersion', async (t) => {
  const pack = packBuffer(baseManifest({ name: 'market-pack', version: '4.2.0', dependencies: { 'dsh-x-market': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-market'] }))
  site.routes['/market/market-pack-4.2.0.dspack'] = { body: pack }
  site.routes['/market/index.json'] = {
    type: 'application/json',
    body: {
      schemaVersion: 2,
      generatedAt: '2026-11-01T00:00:00Z',
      modpacks: [{
        manifestVersion: 5, type: 'profile', id: 'octo.market-pack', name: 'market-pack', version: '4.2.0',
        displayName: { 'zh-CN': '市场环境', 'en-US': 'Market env' }, description: '来自市场',
        owner: 'octo', repo: 'market-pack',
        downloadUrl: `${site.url}/market/market-pack-4.2.0.dspack`, sha256: sha256(pack), size: pack.length,
      }],
    },
  }
  process.env.DSH_PACK_MARKET = `${site.url}/market/index.json`
  t.after(() => { delete process.env.DSH_PACK_MARKET })
  const market = await env.getJson('/api/packs/market?refresh=1')
  const entry = (market.entries || []).find((item) => item.id === 'octo.market-pack')
  assert.ok(entry, `市场里要有这个条目：${JSON.stringify(market).slice(0, 300)}`)

  const { inspected, view } = await importSource({ market: entry })
  assert.equal(inspected.environment.source?.marketId, 'octo.market-pack')
  assert.equal(specOf(view, 'dsh-x-market'), '1.0.0')
  assert.equal(view.following, true)
  assert.equal(view.source?.repo, 'octo/market-pack')
  assert.equal(view.source?.marketId, 'octo.market-pack')
  assert.equal(view.packVersion, '4.2.0', '包版本成为环境的 packVersion')
  assert.equal(view.source?.packVersion, '4.2.0')
})

const recipes = readdirSync(join(REPO_ROOT, 'src', 'packs'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, 'src', 'packs', entry.name, 'manifest.json')))
  .map((entry) => JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'packs', entry.name, 'manifest.json'), 'utf8')))

test('R1 内置配方：GET /api/environments 列出 src/packs 下每份配方（name / displayName / description / version / imported）', async () => {
  const { builtin } = await env.getJson('/api/environments')
  assert.ok(Array.isArray(builtin), '要有 builtin 数组')
  assert.deepEqual(builtin.map((item) => item.name).sort(), recipes.map((item) => item.name).sort())
  for (const recipe of recipes) {
    const row = builtin.find((item) => item.name === recipe.name)
    assert.equal(row.version, recipe.version)
    assert.equal(typeof row.displayName, 'string')
    assert.ok(row.displayName.length > 0)
    assert.equal(typeof row.description, 'string')
    assert.equal(row.imported, false, '还没导入过')
  }
})

test('R1 + R5 内置配方：导入 dsh-x-recommended，插件来自配方，挂载顺序前面补上官方骨架；之后 imported 为真', async () => {
  const recipe = recipes.find((item) => item.name === 'dsh-x-recommended')
  assert.ok(recipe, '仓库里要有这份配方')
  const { view } = await importSource({ builtin: 'dsh-x-recommended' })
  assert.deepEqual(namesOf(view), Object.keys(recipe.dependencies).sort())
  assert.deepEqual(view.bundles.filter((name) => !name.startsWith('@deepseek-ai/')), recipe.bundles, '插件挂载顺序同配方')
  assert.ok(view.bundles.includes(BASE) && view.bundles.includes(WEB), '配方只列插件，导成环境要补官方骨架')
  const { builtin } = await env.getJson('/api/environments')
  assert.equal(builtin.find((item) => item.name === 'dsh-x-recommended').imported, true)
})

test('R1 内置配方 dsh-x-workbench：带的两份技能列成可选的 Profile 数据（home 下 skills/）', async () => {
  const result = await inspect({ builtin: 'dsh-x-workbench' })
  assert.ok(result.ok, `HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.ok(result.data.profileData?.home?.some((path) => /skills\//.test(path)), JSON.stringify(result.data.profileData))
  assert.equal(result.data.profileData.available, true)
})

test('R1 来源认不出 / 不存在：不存在的内置配方、不存在的本地路径都报错', async () => {
  await rejected('/api/environments/import/inspect', { builtin: 'no-such-recipe' }, '不存在的内置配方')
  await rejected('/api/environments/import/inspect', { source: join(env.root, 'no-such-dir', 'nope.dspack') }, '不存在的本地文件')
  await rejected('/api/environments/import/inspect', { source: '' }, '空来源')
})

// ---------------------------------------------------------------- R2：检查只读、token 一次性

test('R2 检查只读：不存环境、不建环境目录、不写任何 Profile、不写 DSH_HOME', async () => {
  const profile = 'ro-target'
  seedProfile(env.home, profile, profileManifest(profile))
  writeFileSync(join(profileDir(env.home, profile), 'cordis.patch.yml'), '- id: original\n')
  const before = { envs: (await listEnvs()).length, dirs: envDirs(), profile: snapshotDir(profileDir(env.home, profile)), home: snapshotDir(env.home) }
  const file = packFile({}, {
    'overrides/cordis.patch.yml': '- id: from-pack\n',
    'overrides/notes/readme.txt': 'hi\n',
    'home/skills/ro-skill/SKILL.md': '# ro\n',
    'offline/dsh-x-local-1.0.0.tgz': TGZ,
  })
  const data = await okInspect({ source: file })
  assert.ok(data.profiles.includes(profile), '检查结果要列出可选的 Profile')
  assert.equal((await listEnvs()).length, before.envs, '检查不能存环境')
  assert.deepEqual(envDirs(), before.dirs, '检查不能建环境目录')
  assert.deepEqual(snapshotDir(profileDir(env.home, profile)), before.profile, '检查不能写 Profile')
  assert.deepEqual(snapshotDir(env.home), before.home, '检查不能往 DSH_HOME 写任何东西（技能、配置）')
})

test('R2 状态迁移：检查 → 确认导入建一个环境 → 同一个 token 再用被拒，不再多建', async () => {
  const file = packFile({ dependencies: { 'dsh-x-once': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-once'] })
  const before = (await listEnvs()).length
  const data = await okInspect({ source: file })
  assert.equal((await listEnvs()).length, before, '只检查不建')
  const first = await confirmImport(data.token)
  assert.equal((await listEnvs()).length, before + 1, '确认导入建一个')
  assert.ok(await envById(first.environment.id))
  await rejected('/api/environments/import', { token: data.token }, '用过的 token')
  assert.equal((await listEnvs()).length, before + 1, 'token 只能用一次')
})

test('R2 不认识的 token、空 token、缺 token 都被拒', async () => {
  const before = (await listEnvs()).length
  await rejected('/api/environments/import', { token: 'no-such-token' }, '不认识的 token')
  await rejected('/api/environments/import', { token: '' }, '空 token')
  await rejected('/api/environments/import', {}, '没有 token')
  assert.equal((await listEnvs()).length, before)
})

// ---------------------------------------------------------------- R3：DSH 版本

async function dshCase(dshVersion) {
  const patch = dshVersion === undefined ? {} : { dshVersion }
  const file = packFile(patch)
  if (dshVersion === undefined) {
    // baseManifest 自带 dshVersion，「没写」要真的删掉
    const manifest = baseManifest({ name: `pack-${seq}`, displayName: `包 ${seq}` })
    delete manifest.dshVersion
    writePackFile(file, manifest)
  }
  return file
}

test('R3 精确版本、本机已装：照用，dshInstalled 为真；环境记这个版本', async () => {
  const { inspected, view } = await importSource({ source: await dshCase('1.1.0') })
  assert.equal(inspected.environment.dshVersion, '1.1.0')
  assert.equal(inspected.environment.dshInstalled, true)
  assert.equal(view.dshVersion, '1.1.0')
})

test('R3 精确版本、本机没装：照用（不换成别的版本），dshInstalled 为假', async () => {
  const data = await okInspect({ source: await dshCase('1.3.0') })
  assert.equal(data.environment.dshVersion, '1.3.0')
  assert.equal(data.environment.dshInstalled, false)
})

test('R3 范围、本机有满足的：取本机满足的最高版本（远端更高的不算），环境记精确版本', async () => {
  const { inspected, view } = await importSource({ source: await dshCase('>=1.0.0 <2.0.0') })
  assert.equal(inspected.environment.dshVersion, '1.2.0', '1.3.0 只在远端，不该选它')
  assert.equal(inspected.environment.dshInstalled, true)
  assert.equal(inspected.environment.dshWanted, '>=1.0.0 <2.0.0', '包里写的范围原样回显')
  assert.equal(view.dshVersion, '1.2.0', '环境里记精确版本，不记范围')
})

test('R3 范围端点：>=1.2.0 → 1.2.0；<1.2.0 → 1.1.0；^1.0.0 → 1.2.0；>1.2.0 → 远端的 2.0.0', async () => {
  const cases = [['>=1.2.0', '1.2.0', true], ['<1.2.0', '1.1.0', true], ['^1.0.0', '1.2.0', true], ['>1.2.0', '2.0.0', false]]
  for (const [range, version, installed] of cases) {
    const data = await okInspect({ source: await dshCase(range) })
    assert.equal(data.environment.dshVersion, version, range)
    assert.equal(data.environment.dshInstalled, installed, `${range} 的 dshInstalled`)
  }
})

test('R3 范围、本机没有满足的：取已发布里满足的最高版本，检查时 dshInstalled 为假', async () => {
  const data = await okInspect({ source: await dshCase('>=1.3.0') })
  assert.equal(data.environment.dshVersion, '2.0.0')
  assert.equal(data.environment.dshInstalled, false)
})

test('R3 范围只有远端满足：确认导入时自动装上那个版本，环境记精确版本', { skip: NO_NPM }, async () => {
  assert.equal(existsSync(versionBin('2.0.0')), false, '前置条件：2.0.0 还没装')
  const { result, view } = await importSource({ source: await dshCase('>=1.3.0') })
  assert.equal(view.dshVersion, '2.0.0')
  assert.ok(existsSync(versionBin('2.0.0')), '导入时要把 DSH 2.0.0 装上')
  assert.ok(result.environment.id)
  // 再检查一个要 2.0.0 的包：这次应当是「本机已装」
  const again = await okInspect({ source: await dshCase('2.0.0') })
  assert.equal(again.environment.dshInstalled, true, '装完之后服务端认它是已装版本')
})

test('R3 没有任何版本满足：检查报错，确认导入被拒，不建环境', async () => {
  await refusedSource({ source: await dshCase('>=5.0.0') }, '没有版本满足 >=5.0.0')
})

test('R3 包里没写 dshVersion：检查通过但多一条提醒；环境跟随最新（auto）', async () => {
  const pinned = await okInspect({ source: await dshCase('1.1.0') })
  const { inspected, view } = await importSource({ source: await dshCase(undefined) })
  assert.ok(inspected.warnings.length > pinned.warnings.length, `没写版本要多一条提醒：${JSON.stringify(inspected.warnings)}`)
  assert.equal(view.dshVersion, 'auto', '没写版本 = 跟随最新')
})

// ---------------------------------------------------------------- R4：离线文件

test('R4 离线文件：检查时单独列出（name / file / sha256 / bytes），插件行标成 offline', async () => {
  const data = await okInspect({ source: packFile(offlineManifest(), { [`offline/${OFFLINE_FILE}`]: TGZ }) })
  const offline = data.environment.offline
  assert.equal(offline.length, 1, '有一个离线文件')
  assert.equal(offline[0].name, 'dsh-x-local')
  assert.ok(offline[0].file.endsWith(OFFLINE_FILE), offline[0].file)
  assert.equal(offline[0].sha256, sha256(TGZ))
  assert.equal(offline[0].bytes, TGZ.length)
  const row = data.environment.plugins.find((item) => item.name === 'dsh-x-local')
  assert.equal(row.offline, true)
  assert.ok(!row.local, '离线插件不算「作者本机路径」')
})

test('R4 离线文件：导入后解到 <APP_DIR>/envs/<id>/files/<sha256 前 8 位>/<名>.tgz，内容摘要一致，坐标换成那里的绝对路径', async () => {
  const { result, view } = await importSource({ source: packFile(offlineManifest(), { [`offline/${OFFLINE_FILE}`]: TGZ }) })
  const id = result.environment.id
  const extracted = extractedOfflinePath(env.app, id, OFFLINE_FILE, sha256(TGZ))
  assert.ok(existsSync(extracted), `离线文件要落在 ${extracted}`)
  assert.equal(sha256(readFileSync(extracted)), sha256(TGZ))
  assert.equal(specOf(view, 'dsh-x-local'), `file:${extracted}`)
  assert.ok(view.bundles.includes('dsh-x-local'))
})

test('R4 离线文件决策表：摘要不对 / 文件缺 / 声明不全 / 坐标没有核对过的声明 → 检查报错、导入被拒、不留文件', async () => {
  const wrong = { 'dsh-x-local': { file: `offline/${OFFLINE_FILE}`, sha256: sha256('别的内容') } }
  const cases = [
    ['sha256 对不上', offlineManifest(wrong), { [`offline/${OFFLINE_FILE}`]: TGZ }],
    ['声明了但文件缺失', offlineManifest(), {}],
    ['声明缺 sha256', offlineManifest({ 'dsh-x-local': { file: `offline/${OFFLINE_FILE}` } }), { [`offline/${OFFLINE_FILE}`]: TGZ }],
    ['声明缺 file', offlineManifest({ 'dsh-x-local': { sha256: sha256(TGZ) } }), { [`offline/${OFFLINE_FILE}`]: TGZ }],
    ['sha256 只有 63 位', offlineManifest({ 'dsh-x-local': { file: `offline/${OFFLINE_FILE}`, sha256: sha256(TGZ).slice(0, 63) } }), { [`offline/${OFFLINE_FILE}`]: TGZ }],
    ['坐标是 file:offline/… 却没有声明', offlineManifest(null), { [`offline/${OFFLINE_FILE}`]: TGZ }],
  ]
  for (const [why, patch, files] of cases) {
    const dirs = envDirs()
    await refusedSource({ source: packFile(patch, files) }, why)
    assert.deepEqual(envDirs(), dirs, `${why}：不能留下环境目录或解出来的文件`)
  }
})

// ---------------------------------------------------------------- R5：包的形态

test('R5 整机快照（type: dshhome）：检查报错，导入被拒', async () => {
  await refusedSource({ source: packFile({ type: 'dshhome' }) }, 'dshhome 形态')
})

test('R5 老包 bundles 只列插件：环境的挂载顺序补上官方骨架（在前），插件顺序不变', async () => {
  const { view } = await importSource({ source: packFile({ bundles: ['dsh-x-old-a', 'dsh-x-old-b'], dependencies: { 'dsh-x-old-a': '1.0.0', 'dsh-x-old-b': '1.0.0' } }) })
  assert.ok(view.bundles.includes(BASE) && view.bundles.includes(WEB), `要补官方骨架：${view.bundles}`)
  const at = (name) => view.bundles.indexOf(name)
  assert.ok(at(BASE) < at('dsh-x-old-a') && at(WEB) < at('dsh-x-old-a'), '官方骨架在插件前面')
  assert.ok(at('dsh-x-old-a') < at('dsh-x-old-b'), '插件原有顺序不变')
})

test('R5（变更）依赖指向作者本机路径（link: / file: 目录 / file: tarball，非离线）：依赖和挂载一起去掉，每个一条点名提醒，仍可导入', async () => {
  const deps = { 'dsh-x-foo': '1.0.0', 'dsh-x-linked': 'link:/Users/author/dev/dsh-x-linked', 'dsh-x-filed': 'file:/Users/author/dev/dsh-x-filed.tgz', 'dsh-x-reldir': 'file:../dev/dsh-x-reldir' }
  const { inspected, view } = await importSource({ source: packFile({ dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)] }) })
  for (const name of ['dsh-x-linked', 'dsh-x-filed', 'dsh-x-reldir']) {
    assert.ok(inspected.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(inspected.warnings)}`)
    assert.ok(!inspected.environment.plugins.some((item) => item.name === name), `${name} 检查预览里就不该有`)
    assert.equal(specOf(view, name), undefined, `${name} 不能进环境的依赖`)
    assert.ok(!view.bundles.includes(name), `${name} 的挂载也要去掉`)
  }
  assert.equal(specOf(view, 'dsh-x-foo'), '1.0.0', '普通依赖照留')
  assert.ok(!inspected.warnings.some((line) => line.includes('dsh-x-foo')), '普通 npm 依赖不提醒')
  assert.deepEqual(view.bundles, [BASE, WEB, 'dsh-x-foo'])
})

// ---------------------------------------------------------------- R6：配置（决策 10）

const PATCH = '- id: from-pack\n  config:\n    token: sk-from-pack\n'
const CONFIG = {
  'overrides/cordis.patch.yml': PATCH,
  'overrides/notes/readme.txt': 'from pack\n',
  // 插件清单类文件：配置导入绝不能写它们（插件清单归环境）
  'overrides/package.json': '{"name":"from-pack","dependencies":{"dsh-x-evil":"6.6.6"}}\n',
  'overrides/pnpm-lock.yaml': "lockfileVersion: '9.0'\n# from pack\n",
  'overrides/pnpm-workspace.yaml': '# from pack\npackages: []\n',
  'package.json': '{"name":"snapshot","dependencies":{"dsh-x-evil":"6.6.6"},"dsh":{"profile":{"bundles":["dsh-x-evil"]}}}\n',
  'home/skills/pack-skill/SKILL.md': '# pack skill\n',
}
/** 一个已存在的 Profile：package.json 用怪格式写（按字节比对才看得出被重写过），带锁文件、工作区文件、原补丁层。 */
function seedConfigProfile(name, { lock = true, workspace = true } = {}) {
  const dir = seedProfile(env.home, name, profileManifest(name, { dependencies: { 'dsh-x-mine': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-mine'] }))
  if (lock) writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# mine\n")
  if (workspace) writeFileSync(join(dir, 'pnpm-workspace.yaml'), '# mine\npackages: []\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: mine\n')
  return dir
}

test('R6 默认不导配置：profileData 列出补丁层 / overrides / home，导入后 config 为 null，Profile 与 DSH_HOME 不动', async () => {
  const profile = 'cfg-skip'
  const dir = seedConfigProfile(profile)
  const before = { profile: snapshotDir(dir), skill: existsSync(join(env.home, 'skills', 'pack-skill')) }
  const file = packFile({}, CONFIG)
  const data = await okInspect({ source: file })
  assert.equal(data.profileData.patch, true)
  assert.ok(data.profileData.overrides.some((path) => path.endsWith('notes/readme.txt')), JSON.stringify(data.profileData.overrides))
  assert.ok(data.profileData.home.some((path) => path.endsWith('skills/pack-skill/SKILL.md')), JSON.stringify(data.profileData.home))
  assert.equal(data.profileData.available, true)
  const result = await confirmImport(data.token)
  assert.equal(result.config, null, '没给 profile 就不导配置')
  assert.deepEqual(snapshotDir(dir), before.profile, 'Profile 不能被写')
  assert.equal(existsSync(join(env.home, 'skills', 'pack-skill')), before.skill, '技能不能被写进 DSH_HOME')
})

test('R6 给了 profile：补丁层、overrides、home 写进去；package.json / pnpm-lock.yaml / pnpm-workspace.yaml 按字节不变', async () => {
  const profile = 'cfg-into'
  const dir = seedConfigProfile(profile)
  const keep = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map((name) => [name, readFileSync(join(dir, name))]))
  const { result, view } = await importSource({ source: packFile({ name: 'cfg-into-pack' }, CONFIG) }, { profile })
  assert.ok(view, '环境照常建')
  assert.equal(result.config?.profile, profile)
  assert.ok(!result.config?.error, `配置导入不该失败：${result.config?.error}`)
  assert.ok(Number(result.config.files) >= 1, '要回写了几个文件')
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), PATCH, '补丁层写进 Profile')
  assert.equal(readFileSync(join(dir, 'notes', 'readme.txt'), 'utf8'), 'from pack\n', 'overrides 写进 Profile')
  assert.equal(readFileSync(join(env.home, 'skills', 'pack-skill', 'SKILL.md'), 'utf8'), '# pack skill\n', 'home 写进 DSH_HOME')
  // 三个文件一起看再断言：一次报全哪几个被写了、写成了什么
  const written = Object.entries(keep).filter(([name, bytes]) => !readFileSync(join(dir, name)).equals(bytes))
    .map(([name]) => `${name} → ${JSON.stringify(readFileSync(join(dir, name), 'utf8')).slice(0, 300)}`)
  assert.deepEqual(written, [], '这几个是插件清单，配置导入不能写它们')
})

test('R6 给了 profile：Profile 原本没有 pnpm-lock.yaml / pnpm-workspace.yaml 时也不替它新建', async () => {
  const profile = 'cfg-bare'
  const dir = seedConfigProfile(profile, { lock: false, workspace: false })
  const manifest = readFileSync(join(dir, 'package.json'))
  const { result } = await importSource({ source: packFile({ name: 'cfg-bare-pack' }, CONFIG) }, { profile })
  assert.ok(!result.config?.error, result.config?.error)
  const touched = [
    ...(readFileSync(join(dir, 'package.json')).equals(manifest) ? [] : [`package.json 被改写 → ${JSON.stringify(readFileSync(join(dir, 'package.json'), 'utf8')).slice(0, 300)}`]),
    ...['pnpm-lock.yaml', 'pnpm-workspace.yaml'].filter((name) => existsSync(join(dir, name))).map((name) => `新建了 ${name}`),
  ]
  assert.deepEqual(touched, [], '配置导入不能写 package.json，也不能替 Profile 新建锁文件 / 工作区文件')
})

test('R6 配置导入走现有的备份 / 回滚：撤销那次导入后 Profile 回到原样', async () => {
  const profile = 'cfg-undo'
  const dir = seedConfigProfile(profile)
  const before = snapshotDir(dir)
  await importSource({ source: packFile({ name: 'cfg-undo-pack' }, CONFIG) }, { profile })
  assert.notDeepEqual(snapshotDir(dir), before, '前置条件：配置确实写进去了')
  // 配置导入记成「只导配置」的记录（configOnly），撤销按这条记录还原备份
  const record = (await packsCard(profile))?.records?.find((item) => item.name === 'cfg-undo-pack')
  assert.ok(record, '这次配置导入要留下一条能撤销的记录')
  assert.equal(record.configOnly, true, '记录要标成 configOnly')
  await okPost('/api/packs/uninstall', { name: 'cfg-undo-pack', profile, configOnly: true })
  assert.deepEqual(snapshotDir(dir), before, '撤销后 Profile 按备份还原')
})

test('R6 包里没有配置却要导配置：报错，不建环境', async () => {
  const profile = 'cfg-none'
  seedConfigProfile(profile)
  const data = await okInspect({ source: packFile() })
  assert.equal(data.profileData.available, false, '这个包没有可导的配置')
  const before = (await listEnvs()).length
  await rejected('/api/environments/import', { token: data.token, profile }, '没有配置可导')
  assert.equal((await listEnvs()).length, before, '请求被拒，不能留下环境')
})

test('R6 目标 Profile 有实例在跑：在装任何东西（包括缺的 DSH）之前拒绝，不建环境、不动 Profile', async () => {
  const profile = 'cfg-busy'
  const dir = seedConfigProfile(profile)
  await env.startIn(env.home, '1.0.0', profile)
  try {
    await waitFor(async () => (await env.state()).instances.some((item) => item.profile === profile && item.status === 'running'), '实例跑起来')
    const before = { envs: (await listEnvs()).length, profile: snapshotDir(dir) }
    // 包要的 1.3.0 本机没装：拒绝必须发生在装 DSH 之前
    const data = await okInspect({ source: packFile({ name: 'cfg-busy-pack', dshVersion: '1.3.0' }, CONFIG) })
    assert.equal(data.environment.dshInstalled, false, '前置条件：要的 DSH 本机没有')
    await rejected('/api/environments/import', { token: data.token, profile }, 'Profile 有实例在跑')
    assert.equal(existsSync(versionBin('1.3.0')), false, '被拒之前不能先装 DSH')
    assert.equal((await listEnvs()).length, before.envs, '不能建环境')
    assert.deepEqual(snapshotDir(dir), before.profile, '不能动 Profile')
  } finally {
    await env.stopIn(env.home, '1.0.0', profile)
  }
})

test('R6 环境存好之后配置写失败：环境留着，config.error 说明原因', async (t) => {
  const profile = 'cfg-fail'
  const dir = seedConfigProfile(profile)
  // 包要写 notes/readme.txt，而 Profile 里 notes 是个普通文件：建不了目录，配置写入必然失败
  writeFileSync(join(dir, 'notes'), 'i am a file\n')
  // 再加一道：Profile 目录只读（以 root 跑时这一道不生效，靠上面那一道）
  chmodSync(dir, 0o555)
  t.after(() => chmodSync(dir, 0o755))
  const result = await env.call('/api/environments/import', { token: (await okInspect({ source: packFile({ name: 'cfg-fail-pack' }, CONFIG) })).token, profile })
  assert.ok(result.ok, `环境本身没问题，导入应成功：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.ok(result.data.environment?.id)
  assert.ok(await envById(result.data.environment.id), '配置写失败不撤环境')
  assert.equal(result.data.config?.profile, profile)
  assert.equal(typeof result.data.config?.error, 'string', `config.error 要说明原因：${JSON.stringify(result.data.config)}`)
  assert.ok(result.data.config.error.length > 0)
})

// ---------------------------------------------------------------- R7：来源 / 跟随

test('R7 本地文件 + 清单里有 environment.repo：用它，算跟随；packId / packVersion 记下', async () => {
  const { view } = await importSource({ source: packFile({ name: 'declared-repo', version: '0.9.1', environment: { repo: 'octo/declared' } }) })
  assert.equal(view.source?.repo, 'octo/declared')
  assert.equal(view.following, true)
  assert.equal(view.source?.packId, 'declared-repo')
  assert.equal(view.source?.packVersion, '0.9.1')
})

test('R7 本地文件、清单没写仓库：不跟随，但 packId / packVersion 照记', async () => {
  const { view } = await importSource({ source: packFile({ name: 'no-repo', version: '0.2.0' }) })
  assert.equal(view.following, false)
  assert.ok(!view.source?.repo, '没有仓库可记')
  assert.equal(view.source?.packId, 'no-repo')
  assert.equal(view.source?.packVersion, '0.2.0')
})

test('R7 清单里的 environment.repo 写法不对（只有 owner、多一级、带空格）：不跟随', async () => {
  for (const repo of ['octo', 'a/b/c', 'octo/re po']) {
    const { view } = await importSource({ source: packFile({ environment: { repo } }) })
    assert.equal(view.following, false, repo)
    assert.ok(!view.source?.repo, `${repo} 不该被记成仓库`)
  }
})

test('R7 市场条目没有 GitHub 仓库：不跟随，但 marketId 照记', async (t) => {
  const pack = packBuffer(baseManifest({ name: 'market-norepo', version: '1.0.1' }))
  site.routes['/market2/p.dspack'] = { body: pack }
  site.routes['/market2/index.json'] = {
    type: 'application/json',
    body: { modpacks: [{ manifestVersion: 5, id: 'someone.norepo', name: 'market-norepo', version: '1.0.1', downloadUrl: `${site.url}/market2/p.dspack`, sha256: sha256(pack), size: pack.length }] },
  }
  process.env.DSH_PACK_MARKET = `${site.url}/market2/index.json`
  t.after(() => { delete process.env.DSH_PACK_MARKET })
  const entry = ((await env.getJson('/api/packs/market?refresh=1')).entries || []).find((item) => item.id === 'someone.norepo')
  assert.ok(entry, '前置条件：市场里有这个条目')
  const { view } = await importSource({ market: entry })
  assert.equal(view.following, false)
  assert.equal(view.source?.marketId, 'someone.norepo')
  assert.equal(view.packVersion, '1.0.1')
})

// ================================================================ 第二轮需求（代码评审之后）

/** 视图（检查预览或列表）里的依赖表：有 spec 的插件行。 */
const depsOfView = (plugins) => Object.fromEntries((plugins || []).filter((item) => item.spec).map((item) => [item.name, item.spec]))
let named = 0
/** 指定插件清单的包（文件），名字唯一。 */
function packWith(dependencies, patch = {}, files = {}) {
  named += 1
  return packFile({ name: `n-pack-${named}`, dependencies, bundles: [BASE, WEB, ...Object.keys(dependencies)], ...patch }, files)
}

// ---------------------------------------------------------------- N11：默认值

test('N11 GET /api/environments 带 defaults.packVersion = 1.0.0', async () => {
  const data = await env.getJson('/api/environments')
  assert.deepEqual(data.defaults, { packVersion: '1.0.0' })
})

// ---------------------------------------------------------------- N1：导入钉 npm 范围 / tag

test('N1 导入钉 npm 范围 / tag：检查预览里就是已发布里满足的最高精确版本；精确版本、github 原样；导入后的环境与预览一致', async () => {
  const deps = { 'dsh-x-foo': '^1.0.0', '@acme/dsh-bar': 'latest', 'dsh-x-tagged': 'next', 'dsh-x-exact': '1.2.3', 'dsh-x-gh': 'github:octo/dsh-x-gh' }
  const want = { 'dsh-x-foo': '1.5.0', '@acme/dsh-bar': '2.3.0', 'dsh-x-tagged': '0.9.0-beta.2', 'dsh-x-exact': '1.2.3', 'dsh-x-gh': 'github:octo/dsh-x-gh' }
  const { inspected, view } = await importSource({ source: packWith(deps) })
  assert.deepEqual(depsOfView(inspected.environment.plugins), want, '检查预览里就是钉好的版本')
  assert.deepEqual(depsOfView(view.plugins), want, '导入后的环境和预览一致')
})

test('N1 查不到的包、没有满足范围的版本：坐标原样留着，各一条点名提醒', async () => {
  const deps = { 'dsh-x-unknown': '^1.0.0', 'dsh-x-foo': '^9.0.0', 'dsh-x-exact': '1.2.3' }
  const { inspected, view } = await importSource({ source: packWith(deps) })
  for (const name of ['dsh-x-unknown', 'dsh-x-foo']) {
    assert.equal(specOf(view, name), deps[name], `${name} 原样留着`)
    assert.ok(inspected.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(inspected.warnings)}`)
  }
  assert.ok(!inspected.warnings.some((line) => line.includes('dsh-x-exact')), '精确版本不提醒')
})

// ---------------------------------------------------------------- N3 / N4：认不出的依赖、bundled

test('N3 认不出的依赖（坏包名、坐标 513 个字符）：检查点名提醒，预览和环境里都没有它（依赖与挂载）；512 个字符的照收', async () => {
  const ok512 = `github:octo/dsh-x-ok#${'a'.repeat(512 - 'github:octo/dsh-x-ok#'.length)}`
  const long513 = `${ok512}b`
  const deps = { 'Bad Name!': '1.0.0', '../evil': '1.0.0', 'dsh-x-long': long513, 'dsh-x-ok512': ok512, 'dsh-x-fine': '1.0.0' }
  const { inspected, view } = await importSource({ source: packWith(deps) })
  for (const name of ['Bad Name!', '../evil', 'dsh-x-long']) {
    assert.ok(inspected.warnings.some((line) => line.includes(name)), `${name} 要点名提醒：${JSON.stringify(inspected.warnings)}`)
    assert.ok(!inspected.environment.plugins.some((item) => item.name === name), `${name} 不能出现在预览里`)
    assert.equal(specOf(view, name), undefined, `${name} 不能进环境的依赖`)
    assert.ok(!view.bundles.includes(name), `${name} 不能进环境的挂载顺序`)
  }
  assert.equal(specOf(view, 'dsh-x-ok512'), ok512, '512 个字符是合法边界')
  assert.equal(specOf(view, 'dsh-x-fine'), '1.0.0')
})

test('N4 依赖写 bundled / bundled:<名>：检查报错，导入被拒', async () => {
  await refusedSource({ source: packWith({ 'dsh-x-b': 'bundled' }) }, 'bundled')
  await refusedSource({ source: packWith({ 'dsh-x-c': 'bundled:dsh-x-c' }) }, 'bundled:<名>')
})

// ---------------------------------------------------------------- N2：确认导入 = 检查时看到的

test('N2 本地文件在检查之后改了插件清单：确认导入被拒、提示重新检查、不建环境', async () => {
  const file = join(PACKS, 'changing-file.dspack')
  const manifest = (dependencies) => baseManifest({ name: 'changing-file', dependencies, bundles: [BASE, WEB, ...Object.keys(dependencies)] })
  writePackFile(file, manifest({ 'dsh-x-a': '1.0.0' }))
  const data = await okInspect({ source: file })
  writePackFile(file, manifest({ 'dsh-x-a': '1.0.0', 'dsh-x-b': '1.0.0' }))
  const before = { envs: (await listEnvs()).length, dirs: envDirs() }
  const refused = await rejected('/api/environments/import', { token: data.token }, '检查之后包变了')
  assert.equal(refused.status, 400)
  assert.match(refused.data.error, /重新检查/, '要提示重新检查')
  assert.equal((await listEnvs()).length, before.envs, '不能建环境')
  assert.deepEqual(envDirs(), before.dirs, '不能留下环境目录')
})

test('N2 目录形态的包在检查之后换了离线文件（声明的 sha256 也跟着换，包本身合法）：确认导入被拒、提示重新检查', async () => {
  const dir = join(PACKS, 'changing-dir')
  const other = makeTgz({ 'package/package.json': '{"name":"dsh-x-local","version":"1.0.0"}\n', 'package/index.js': 'export default 2\n' })
  const write = (data) => writePackDir(dir, baseManifest({
    name: 'changing-dir',
    ...offlineManifest({ 'dsh-x-local': { file: `offline/${OFFLINE_FILE}`, sha256: sha256(data) } }),
  }), { [`offline/${OFFLINE_FILE}`]: data })
  write(TGZ)
  const data = await okInspect({ source: dir })
  write(other)
  const before = (await listEnvs()).length
  const refused = await rejected('/api/environments/import', { token: data.token }, '检查之后离线文件变了')
  assert.match(refused.data.error, /重新检查/)
  assert.equal((await listEnvs()).length, before)
})

test('N2 Profile 正忙导致确认导入失败：停掉实例后用同一个 token 重试成功，配置也写进去', async () => {
  const profile = 'cfg-retry'
  const dir = seedConfigProfile(profile)
  const data = await okInspect({ source: packFile({ name: 'cfg-retry-pack', dshVersion: '1.1.0' }, CONFIG) })
  await env.startIn(env.home, '1.0.0', profile)
  try {
    await waitFor(async () => (await env.state()).instances.some((item) => item.profile === profile && item.status === 'running'), '实例跑起来')
    await rejected('/api/environments/import', { token: data.token, profile }, 'Profile 正忙')
  } finally {
    await env.stopIn(env.home, '1.0.0', profile)
  }
  await waitFor(async () => !(await env.state()).instances.some((item) => item.profile === profile && ['starting', 'running'].includes(item.status)), '实例停下')
  const result = await confirmImport(data.token, { profile })
  assert.ok(await envById(result.environment.id), '重试要建出环境')
  assert.ok(!result.config?.error, result.config?.error)
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), PATCH, '重试时配置照写')
  await rejected('/api/environments/import', { token: data.token }, '成功导入后 token 作废')
})

// ---------------------------------------------------------------- N5：复制环境带离线文件

test('N5 复制带离线文件的环境：文件拷到副本自己的 files/<摘要>/ 下、坐标指过去；删了原环境副本照样能用', async () => {
  const { result } = await importSource({ source: packFile(offlineManifest(), { [`offline/${OFFLINE_FILE}`]: TGZ }) })
  const original = result.environment.id
  const { environment: copy } = await okPost('/api/environments/create', { name: '带离线的副本', from: original })
  assert.notEqual(copy.id, original)
  const copied = extractedOfflinePath(env.app, copy.id, OFFLINE_FILE, sha256(TGZ))
  assert.ok(existsSync(copied), `副本的离线文件要在 ${copied}`)
  assert.equal(sha256(readFileSync(copied)), sha256(TGZ))
  assert.equal(specOf(await envById(copy.id), 'dsh-x-local'), `file:${copied}`, '副本的坐标指向自己的文件')

  await okPost('/api/environments/remove', { id: original })
  assert.equal(await envById(original), undefined, '前置条件：原环境删掉了')
  assert.ok(existsSync(copied), '删了原环境，副本的离线文件还在')
  const spec = specOf(await envById(copy.id), 'dsh-x-local')
  assert.equal(spec, `file:${copied}`)
  assert.ok(existsSync(spec.slice('file:'.length)), '副本的坐标仍然指向存在的文件')
})

// ---------------------------------------------------------------- N8：失败一律 400

test('N8 /api/environments/* 的 POST 失败一律 HTTP 400 + { error }（坏包、认不出的来源、过期 token、不存在的 id、不合法的版本号）', async () => {
  const created = await okPost('/api/environments/create', { name: '400 用', dshVersion: '1.1.0' })
  const notZip = join(PACKS, 'not-a-pack.dspack')
  writeFileSync(notZip, '这不是 zip')
  const cases = [
    ['/api/environments/create', { name: '' }, '空名字'],
    ['/api/environments/create', { name: '坏版本', dshVersion: 'not-a-version!' }, '不合法的版本号'],
    ['/api/environments/update', { id: 'no-such-env', name: 'x' }, '不存在的 id'],
    ['/api/environments/remove', { id: 'no-such-env' }, '不存在的 id'],
    ['/api/environments/plugins/add', { id: 'no-such-env', spec: 'dsh-x-foo@1.0.0' }, '不存在的 id'],
    ['/api/environments/plugins/remove', { id: created.environment.id, name: 'dsh-x-not-here' }, '不认识的插件'],
    ['/api/environments/plugins/upgrade', { id: 'no-such-env' }, '不存在的 id'],
    ['/api/environments/import/inspect', { source: notZip }, '坏包'],
    ['/api/environments/import/inspect', { source: 'not a source at all' }, '认不出的来源'],
    ['/api/environments/import/inspect', { builtin: 'no-such-recipe' }, '不存在的内置配方'],
    ['/api/environments/import', { token: 'expired-or-unknown' }, '过期 / 不认识的 token'],
    ['/api/environments/export', { id: 'no-such-env', target: 'file', path: join(env.root, 'n8-a.dspack') }, '不存在的 id'],
    ['/api/environments/export', { id: created.environment.id, target: 'file', version: 'x'.repeat(25), path: join(env.root, 'n8-b.dspack') }, '不合法的版本号'],
  ]
  const wrong = []
  for (const [path, body, why] of cases) {
    const result = await env.call(path, body)
    if (result.status !== 400 || typeof result.data?.error !== 'string') wrong.push(`${path}（${why}）→ HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 120)}`)
  }
  assert.deepEqual(wrong, [], '这些失败都要回 400 + error')
})

// ---------------------------------------------------------------- N9：配置导入（R6 的延伸）

test('N9 同一个包的配置再导一次：只替换那条 configOnly 记录，同名的旧整包记录原样保留', async () => {
  const profile = 'cfg-legacy'
  seedConfigProfile(profile)
  // 旧版启动器留下的整包安装记录（同名、不是 configOnly）：升级上来的用户磁盘上就有这种数据
  const stateFile = join(env.data, 'packs', 'installed.json')
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { packs: [] }
  const legacy = { name: 'legacy-pack', displayName: '旧整包', version: '0.9.0', profile, installedAt: '2026-09-30T00:00:00.000Z', bundles: [], dependencies: {} }
  mkdirSync(join(env.data, 'packs'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ packs: [...(state.packs || []), legacy] }, null, 2))

  for (const round of [1, 2]) {
    const { result } = await importSource({ source: packFile({ name: 'legacy-pack', version: `1.0.${round}` }, CONFIG) }, { profile })
    assert.ok(!result.config?.error, `第 ${round} 次配置导入不该失败：${result.config?.error}`)
  }
  const records = ((await packsCard(profile))?.records || []).filter((item) => item.name === 'legacy-pack')
  const configOnly = records.filter((item) => item.configOnly === true)
  const full = records.filter((item) => !item.configOnly)
  assert.equal(configOnly.length, 1, `configOnly 记录只留一条：${JSON.stringify(records)}`)
  assert.equal(full.length, 1, '旧整包记录还在')
  assert.equal(full[0].version, '0.9.0', '旧整包记录没被改')
})

test('N9 目标 Profile 没有 package.json（目录在但没清单 / 根本没这个目录），包里有补丁层：config.error，环境照存', async () => {
  const bare = 'cfg-nomanifest'
  mkdirSync(profileDir(env.home, bare), { recursive: true })
  for (const profile of [bare, 'cfg-ghost']) {
    const result = await env.call('/api/environments/import', { token: (await okInspect({ source: packFile({}, CONFIG) })).token, profile })
    assert.ok(result.ok, `${profile}：环境本身没问题，导入应成功：HTTP ${result.status} ${JSON.stringify(result.data)}`)
    assert.ok(await envById(result.data.environment.id), `${profile}：环境照存`)
    assert.equal(result.data.config?.profile, profile)
    assert.equal(typeof result.data.config?.error, 'string', `${profile}：config.error 要说明原因：${JSON.stringify(result.data.config)}`)
    assert.ok(result.data.config.error.length > 0)
  }
})

test('N9 x-dsh-home：检查预览的 profiles 和配置写入都按请求头里的用户目录', async () => {
  const altHome = join(env.root, 'alt-home')
  const profile = 'alt-prof'
  seedProfile(altHome, profile, profileManifest(profile))
  writeFileSync(join(profileDir(altHome, profile), 'cordis.patch.yml'), '- id: alt-original\n')
  // 默认目录里放一个同名的诱饵：配置不能写到它身上
  seedConfigProfile(profile)
  const decoy = snapshotDir(profileDir(env.home, profile))
  const headers = homeHeader(altHome)

  const data = await okInspect({ source: packFile({ name: 'alt-home-pack' }, CONFIG) }, headers)
  assert.ok(data.profiles.includes(profile), `预览要列出那个目录里的 Profile：${data.profiles}`)
  assert.ok(!data.profiles.includes('cfg-into'), `默认目录里才有的 Profile 不该列出来：${data.profiles}`)
  const result = await confirmImport(data.token, { profile }, headers)
  assert.ok(!result.config?.error, result.config?.error)
  assert.equal(readFileSync(join(profileDir(altHome, profile), 'cordis.patch.yml'), 'utf8'), PATCH, '配置写进请求头指定的目录')
  assert.ok(existsSync(join(altHome, 'skills', 'pack-skill', 'SKILL.md')), 'home/ 下的文件也写进那个用户目录')
  assert.deepEqual(snapshotDir(profileDir(env.home, profile)), decoy, '默认目录里的同名 Profile 不动')
})

// ---------------------------------------------------------------- N2（会改全局状态，放最后）

test('N2 确认导入用检查时的结果：检查之后 registry 发了新版、本机多装了满足范围的 DSH，环境仍记检查时看到的', async () => {
  const data = await okInspect({ source: packWith({ 'dsh-x-moving': '^1.0.0' }, { dshVersion: '>=1.2.0 <1.9.0' }) })
  assert.equal(depsOfView(data.environment.plugins)['dsh-x-moving'], '1.1.0', '前置条件：检查时钉到 1.1.0')
  assert.equal(data.environment.dshVersion, '1.2.0', '前置条件：检查时选本机的 1.2.0')
  registry.publish('dsh-x-moving', { tags: { latest: '1.9.0' }, versions: ['1.0.0', '1.1.0', '1.9.0'] })
  env.addVersions(['1.5.5'])
  const result = await confirmImport(data.token)
  const view = await envById(result.environment.id)
  assert.equal(specOf(view, 'dsh-x-moving'), '1.1.0', '用检查时钉的版本，不重新解析')
  assert.equal(view.dshVersion, '1.2.0', '用检查时选的 DSH 版本')
})

test('N2 DSH 装不上导致确认导入失败：不建环境；修好之后同一个 token 重试成功', { skip: NO_NPM }, async () => {
  assert.equal(existsSync(versionBin('1.3.0')), false, '前置条件：1.3.0 还没装')
  const data = await okInspect({ source: packWith({ 'dsh-x-foo': '1.0.0' }, { dshVersion: '1.3.0' }) })
  assert.equal(data.environment.dshInstalled, false)
  registry.setTarballsDown(true)
  const before = (await listEnvs()).length
  try {
    await rejected('/api/environments/import', { token: data.token }, 'DSH 下载失败')
    assert.equal((await listEnvs()).length, before, '装不上 DSH 就不建环境')
  } finally {
    registry.setTarballsDown(false)
  }
  const result = await confirmImport(data.token)
  assert.equal((await envById(result.environment.id)).dshVersion, '1.3.0')
  assert.ok(existsSync(versionBin('1.3.0')), '重试时把 DSH 装上')
})
