/**
 * 跟随上游（第三期）的 HTTP 接口（系统测试）：进程内真服务 + 隔离用户目录 + 离线假服务
 * （带 releases 列表的假 GitHub、假市场索引、假 npm registry）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   U1 检查更新 POST /api/environments/updates {force?}：只查跟随上游的环境；市场里有的（marketId 或同一个仓库）
 *      读市场索引、不调 GitHub 接口，其余读 source.repo 的 releases 列表；按仓库缓存 10 分钟，force: true 绕过缓存；
 *      市场索引读不到时市场里的环境退回问 GitHub；只提示，永远不自动应用
 *   U2 哪个 release 算数：草稿不算；预发布只在装着的是预发布时才算（semver 预发布 tag 不看 GitHub 标记）；
 *      最新的合格版本比装着的新才提示（semver 按 semver 比，旧版不提示；否则换了 tag 才算新）；
 *      装着的版本：source.release → source.packVersion → packVersion；某个环境查失败（404、403 限流）只给它报 error
 *   U3 检查一次更新 POST /api/environments/update/inspect {id}：下载新版本的包（release 资产 .dspack，其次 .zip，
 *      或市场条目的下载地址）；什么都不写；不跟随 / 没有更新的版本 → 拒绝；报告 DSH 变化、生效清单的加 / 删 / 换、
 *      重复、冲突（changed / removed）、unverified（只在上游换了 DSH 时）；要的 DSH 没装 → dsh.installed 为假
 *   U4 应用 POST /api/environments/update/apply {token, discard?}：上游层换成新的；增量重放；discard 回上游；
 *      source.release / source.packVersion 记新版本、仍跟随、packVersion 更新；旧清单存到 history/<时间戳>.json 并出现在
 *      history 里；DSH 版本同步到用它的启动项（增量钉了 DSH 的除外）；新版本的离线文件放进 files/<sha256 前 8 位>/<文件>，
 *      旧的不删；token 只能用一次，保存前失败（装 DSH 失败）可以用同一个 token 重试；检查之后包变了 → 拒绝
 *   U5 跟随中的本地改动（加 / 删 / 升级插件、改 DSH 版本）进增量，应用更新后照留，报告里看得到
 *   U6 切回 POST /api/environments/history/restore {id, name}：base / delta / source / DSH 版本回到存档；现在这份先存档；
 *      名字保持现在的；启动项版本同步；坏名字（路径穿越、不是 <时间戳>.json）拒绝
 *   U7 POST /api/packs/update 退役（404）
 *
 *
 * 第二轮需求（评审修复之后）：
 *   B6  release 里没有 .dspack / .zip 资产就不算候选：最新的没资产、更早但仍比装着新的有资产 → 提示那个更早的；都没有 → 不提示
 *   B7  从 GitHub 导入一个勾了 prerelease 的 release → source.prerelease 为真，之后预发布会提示给它
 *   B8  一次 updates 里两个环境跟同一个仓库，releases 只请求一次（force: true 也一样）；查失败（404 / 403 / 网络错误）
 *       同样缓存 10 分钟：不带 force 再查不发请求、照样报错；force: true 重试
 *   B9  市场匹配：marketId 相同，或者同一个仓库 且 条目 name === source.packId；同仓库但 name 不同的条目不能用，退回 GitHub
 *   B10 上游包的 DSH 范围解析不了：inspect 400，带真实原因（没有满足「…」的 DSH 版本），绝不是「Cannot read properties of null」
 *   B11 过期 token：检查（token A）之后又应用了更新的版本 / 切回了备份，装着的上游变了 → 用 A 应用 400（在检查之后换过上游版本），
 *       环境不动，不会悄悄降级
 *   B12 应用只装环境真正要用的 DSH：本地钉了一个已装的 DSH → 不需要上游的 DSH，没有 npm 也能离线应用成功；
 *       inspect 的 dsh 报 {version: 生效版本, installed: 生效版本装没装}
 *   B13 应用顺序：先存旧清单，再同步启动项——启动项指向新版本时一定有存档
 *   B14 切回只带回 base / delta / updateChannel / source / files / packVersion，名字、说明、adoptedFrom 保持现在的；
 *       存档的 DSH 没装就先装，装不上干净地失败（环境不动），版本目录有了之后成功
 *
 * 设计：等价类（三种来源：GitHub 导入 / 本地包声明仓库 / 市场条目；tag 形状）、边界值（缓存 9 分 59 秒 / 10 分 1 秒；
 * 相邻版本号；只有 .zip / 两种资产都有 / 都没有）、决策表（增量条目种类 × 上游这次动没动它；装着版本的三个来源字段）、
 * 状态迁移（导入 → 本地改 → 检查 → 应用 → token 作废 → 切回 → 再切回）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { join, sep } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import { BASE, WEB, profileManifest, recordingBin, seedProfile } from './environments-fixture.mjs'
import {
  REPO_ROOT, baseManifest, dshTarball, extractedOfflinePath, makeTgz, npmUnavailableReason, packBuffer, readTree, sha256,
  startNpmRegistry, startStaticSite, writePackFile,
} from './environment-pack-fixture.mjs'

// 假 GitHub 是自签证书的 https 源站（经代理隧道过去），只能这么连；只影响这个测试进程
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const NO_NPM = npmUnavailableReason()

// ---------------------------------------------------------------- 假 GitHub：releases 列表 / latest / tags + 资产下载

/**
 * 环境夹具里那只假 GitHub 只认 releases/latest；检查更新要读 releases 列表、应用要按 tag 取，所以这里另起一只。
 * 仓库表：'owner/repo' → { status?, releases: [新到旧] }，release = { tag, prerelease?, draft?, assets: [{ name, data }] }。
 * status 为 403 时所有接口回限流；仓库不在表里就 404。hits 记下每次请求（host + 路径 + 查询串），用来数请求次数。
 */
async function startReleaseGithub() {
  const pem = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'localhost-tls.pem'), 'utf8')
  const repos = new Map()
  const hits = []
  const downloadUrl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  const view = (repo, release) => ({
    tag_name: release.tag,
    name: release.tag,
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    assets: (release.assets || []).map((asset) => ({ name: asset.name, size: asset.data.length, browser_download_url: downloadUrl(repo, release.tag, asset.name) })),
  })
  const site = createHttpsServer({ cert: pem, key: pem }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0]
    const [rawPath, query = ''] = (req.url || '').split('?')
    const path = decodeURIComponent(rawPath)
    hits.push({ host, path, query })
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    const api = /^\/repos\/([^/]+\/[^/]+)\/releases(?:\/(latest|tags\/(.+)))?$/.exec(path)
    if (api) {
      const entry = repos.get(api[1])
      if (!entry) return json(404, { message: 'Not Found' })
      if (entry.status === 403) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })
      if (entry.status) return json(entry.status, { message: 'error' })
      if (!api[2]) {
        const perPage = Number(new URLSearchParams(query).get('per_page')) || 30
        return json(200, entry.releases.slice(0, perPage).map((release) => view(api[1], release)))
      }
      const release = api[2] === 'latest'
        ? entry.releases.find((item) => !item.draft && !item.prerelease)
        : entry.releases.find((item) => item.tag === api[3])
      return release ? json(200, view(api[1], release)) : json(404, { message: 'Not Found' })
    }
    const download = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(path)
    const asset = download && repos.get(download[1])?.releases.find((item) => item.tag === download[2])?.assets.find((item) => item.name === download[3])
    if (asset) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': asset.data.length })
      res.end(asset.data)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const sitePort = site.address().port
  const sockets = new Set()
  const proxy = createHttpServer((req, res) => { res.writeHead(502); res.end('只接 CONNECT') })
  proxy.on('connect', (req, socket, head) => {
    const upstream = netConnect(sitePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    for (const item of [socket, upstream]) {
      sockets.add(item)
      item.on('error', () => {})
      item.on('close', () => sockets.delete(item))
    }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    hits,
    /** 整个换掉一个仓库的 release 表（新到旧）。 */
    setRepo(repo, releases, status) { repos.set(repo, { releases: [...releases], ...(status ? { status } : {}) }) },
    /** 发一个新 release（排到最前）。 */
    publish(repo, release) { repos.get(repo).releases.unshift(release) },
    /** 这个仓库的 releases 列表接口被请求了几次（检查更新读的就是它）。 */
    listHits: (repo) => hits.filter((hit) => hit.path === `/repos/${repo}/releases`).length,
    /** 这个仓库所有 GitHub 接口（api 下 /repos/<repo>/…）被请求了几次。 */
    apiHits: (repo) => hits.filter((hit) => hit.path.startsWith(`/repos/${repo}/`) || hit.path === `/repos/${repo}/releases`).length,
    downloaded: (repo, name) => hits.some((hit) => hit.path.startsWith(`/${repo}/releases/download/`) && hit.path.endsWith(`/${name}`)),
    async close() {
      for (const socket of sockets) socket.destroy()
      for (const server of [proxy, site]) {
        server.closeAllConnections?.()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
}

// ---------------------------------------------------------------- 夹具

const INSTALLED = ['1.0.0', '1.1.0', '1.2.0']
// 1.3.0 / 1.4.0 / 1.5.0 已发布但没有 tarball：「本机没装、也装不上」（各给一个用例用，有的用例会把它摆成已装）；
// 2.0.0 带能真装的 tarball（只有本机有 npm CLI 时才用得上）
const PUBLISHED = [...INSTALLED, '1.3.0', '1.4.0', '1.5.0', '2.0.0']
const github = await startReleaseGithub()
const site = await startStaticSite()
// 市场索引：一开始是空的，用例往里加条目。先指好地址再起服务，免得服务端碰到写死的真市场地址
const MARKET = []
const writeMarket = () => { site.routes['/market/index.json'] = { type: 'application/json', body: { schemaVersion: 2, generatedAt: '2026-11-01T00:00:00Z', modpacks: MARKET } } }
writeMarket()
process.env.DSH_PACK_MARKET = `${site.url}/market/index.json`
// 注意：src/settings.js（以及 server.js）在导入时就按 HOME 定下设置目录，绝不能在夹具隔离 HOME 之前静态导入
const env = await startChannelServer({
  prefix: 'dsh-env-update-',
  packument: packumentOf({ latest: '2.0.0' }, PUBLISHED),
  installed: INSTALLED,
  bin: recordingBin,
})
const P = (key) => `dsh-x-${key}`
const PLUGIN_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j', 'k', 'l', 'w', 'x', 'y', 'z', 'm', 'local']
const PLUGIN_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '1.5.0', '2.0.0']
const registry = await startNpmRegistry({
  '@deepseek-ai/dsh': { tags: { latest: '2.0.0' }, versions: PUBLISHED, tarballs: { '2.0.0': dshTarball('2.0.0', recordingBin('2.0.0')) } },
  ...Object.fromEntries(PLUGIN_KEYS.map((key) => [P(key), { tags: { latest: '2.0.0' }, versions: PLUGIN_VERSIONS }])),
})
process.env.npm_config_registry = registry.url
test.after(async () => {
  await env.cleanup()
  await registry.close()
  await site.close()
  await github.close()
})

async function okPost(path, body, headers) {
  const result = await env.call(path, body, headers)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
// 整个文件都走假代理：api.github.com / github.com 的 CONNECT 一律接到本机假站，绝不出网；
// 装完新版不顺手清旧版本（夹具里的已装版本要留着）；下载源用官方，GitHub 地址不套镜像前缀
await okPost('/api/settings', { autoCleanVersions: false, downloadSource: 'official', proxyMode: 'manual', proxyUrl: github.proxyUrl })

/** 期望被拒：非 2xx 且带 error 文案。 */
async function rejected(path, body, why) {
  const result = await env.call(path, body)
  assert.equal(result.ok, false, `${why}：应被拒绝，实际 HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 400)}`)
  assert.equal(result.status, 400, `${why}：失败一律 400`)
  assert.equal(typeof result.data?.error, 'string', `${why}：要带 error 文案`)
  return result
}
const listEnvs = async () => (await env.getJson('/api/environments')).environments
const envById = async (id) => (await listEnvs()).find((item) => item.id === id)
const envDir = (id) => join(env.app, 'envs', id)
const envFile = (id) => join(envDir(id), 'environment.json')
const readEnvFile = (id) => JSON.parse(readFileSync(envFile(id), 'utf8'))
const historyDir = (id) => join(envDir(id), 'history')
const historyFiles = (id) => (existsSync(historyDir(id)) ? readdirSync(historyDir(id)).sort() : [])
/** 环境目录下每个文件的摘要：「什么都不写」按它判断。 */
const treeDigest = (dir) => Object.fromEntries([...readTree(dir)].map(([name, data]) => [name, sha256(data)]))
const pluginsOf = (view) => Object.fromEntries((view?.plugins || []).filter((item) => !item.official).map((item) => [item.name, item.spec]))
const sorted = (items) => [...new Set(items)].sort()
const namesIn = (value) => sorted(Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : item?.name)) : Object.keys(value || {}))
const changeOf = (changed, name) => (Array.isArray(changed) ? changed.find((item) => item?.name === name) : changed?.[name])
const storedPreset = (id) => (env.stored().launchPresets || []).find((item) => item.id === id)

/** 一份环境清单：bundles = 官方骨架 + 依赖里的每个插件。 */
function envManifest(name, version, dshVersion, deps, patch = {}) {
  return baseManifest({ name, version, displayName: `环境 ${name}`, dshVersion, dependencies: deps, bundles: [BASE, WEB, ...Object.keys(deps)], ...patch })
}
const depsOf = (spec) => Object.fromEntries(Object.entries(spec).map(([key, version]) => [P(key), version]))
/** 一个 release：默认挂一个 <名>.dspack 资产。 */
function release(tag, manifest, { prerelease, draft, files, assets } = {}) {
  return { tag, prerelease, draft, assets: assets || [{ name: `${manifest.name}.dspack`, data: packBuffer(manifest, files) }] }
}

/** 检查 + 导入，回列表里的视图。 */
async function importBody(body) {
  const inspected = await okPost('/api/environments/import/inspect', body)
  assert.equal(inspected.ok, true, `导入检查要通过：${JSON.stringify(inspected.errors)}`)
  const result = await okPost('/api/environments/import', { token: inspected.token })
  return envById(result.environment.id)
}
/** 从 GitHub 导入一个跟随上游的环境：仓库先只有 v<版本> 这一个 release。 */
async function followGithub(repo, manifest, options) {
  github.setRepo(repo, [release(`v${manifest.version}`, manifest, options)])
  const view = await importBody({ source: repo })
  assert.equal(view?.following, true, `前置条件：GitHub 导入的环境要跟随上游：${JSON.stringify(view?.source)}`)
  return view
}
let seq = 0
/** 本地包 + 清单里声明的仓库：跟随上游，来源里只有包版本、没有 release tag。 */
async function followLocal(repo, manifest) {
  seq += 1
  const file = writePackFile(join(env.root, 'packs', `${manifest.name}-${seq}.dspack`), { ...manifest, environment: { repo } })
  const view = await importBody({ source: file })
  assert.equal(view?.following, true, `前置条件：声明了仓库的本地包要跟随上游：${JSON.stringify(view?.source)}`)
  return view
}
/**
 * 直接在磁盘上摆一份环境清单（字段照第三期的 base / delta / source 形状）：
 * 用来造界面上造不出来、但迁移旧数据会出现的状态（只有顶层 packVersion、不跟随但记着仓库……）。
 */
function seedEnvironment(id, { name = id, base, delta = {}, source, packVersion, ...extra }) {
  mkdirSync(envDir(id), { recursive: true })
  writeFileSync(envFile(id), `${JSON.stringify({ schema: 1, id, name, base, delta, source, ...(packVersion ? { packVersion } : {}), ...extra, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' }, null, 2)}\n`)
}
async function checkUpdates(body = {}) {
  const data = await okPost('/api/environments/updates', body)
  assert.equal(data.ok, true)
  assert.ok(data.updates && typeof data.updates === 'object', `要回 updates 表：${JSON.stringify(data).slice(0, 300)}`)
  return data.updates
}
async function inspectUpdate(id) {
  const data = await okPost('/api/environments/update/inspect', { id })
  assert.equal(data.ok, true, `检查更新要通过：${JSON.stringify(data.errors)}`)
  assert.equal(typeof data.token, 'string')
  assert.ok(data.token.length > 0)
  return data
}
async function applyUpdate(token, discard) {
  const data = await okPost('/api/environments/update/apply', { token, ...(discard ? { discard } : {}) })
  assert.equal(data.ok, true)
  return data
}
/** 每个用例一个新 Profile + 绑这个环境的启动项（启动项要有 Profile 目录）。 */
let profileSeq = 0
async function bindPreset(environment, version) {
  profileSeq += 1
  const profile = `upd-${profileSeq}`
  seedProfile(env.home, profile, profileManifest(profile))
  const data = await okPost('/api/launch-presets', { name: `启动项 ${profileSeq}`, version, profile, environment })
  return data.entry
}
/** 在数据目录里找检查时下载下来的那个包（路径里带着这次检查的 token）。 */
function downloadedPackFor(token) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path.split(sep).includes(token) || entry.name.startsWith(token)) found.push(path)
    }
  }
  for (const dir of [env.data, env.app]) if (existsSync(dir)) walk(dir)
  return found.filter((path) => /\.(?:dspack|zip)$/i.test(path) || statSync(path).size > 0)
}

// 决策表场景（和纯规则测试同一张表，去掉了「上游新加了本地也加过的插件」那一格，那一格在纯规则测试里）：
// v1.0.0 的 a–f、k、l 都是 1.0.0；本地钉 a@1.5.0（上游换 a → 冲突 changed）、b@2.0.0（上游换成同版本 → 重复）、
// c@1.5.0（上游没动 → 照留）；本地加 g（上游没有 → 照留）、h（上游加了同版本 → 重复）；
// 本地删 d（上游换了 d → 冲突 removed）、e（上游也删了 → 重复）、f（上游没动 → 照删）。
// v1.1.0 还加了 j、删了 k、把 l 换成 1.1.0，DSH 1.0.0 → 1.1.0。
const V1_DEPS = depsOf({ a: '1.0.0', b: '1.0.0', c: '1.0.0', d: '1.0.0', e: '1.0.0', f: '1.0.0', k: '1.0.0', l: '1.0.0' })
const V2_DEPS = depsOf({ a: '2.0.0', b: '2.0.0', c: '1.0.0', d: '2.0.0', f: '1.0.0', h: '1.0.0', j: '1.0.0', l: '1.1.0' })
async function scenario(repo, name) {
  const view = await followGithub(repo, envManifest(name, '1.0.0', '1.0.0', V1_DEPS))
  for (const spec of [`${P('a')}@1.5.0`, `${P('b')}@2.0.0`, `${P('c')}@1.5.0`, `${P('g')}@1.0.0`, `${P('h')}@1.0.0`]) {
    await okPost('/api/environments/plugins/add', { id: view.id, spec })
  }
  for (const key of ['d', 'e', 'f']) await okPost('/api/environments/plugins/remove', { id: view.id, name: P(key) })
  github.publish(repo, release('v1.1.0', envManifest(name, '1.1.0', '1.1.0', V2_DEPS)))
  return view.id
}

// ---------------------------------------------------------------- U1：检查更新

test('U1 来源：GitHub 导入的环境记下仓库、release tag 和包版本，算跟随（第三期的结构化来源）', async () => {
  const view = await followGithub('octo/u-source', envManifest('u-source', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  assert.equal(view.source?.repo, 'octo/u-source')
  assert.equal(view.source?.release, 'v1.0.0', '要记下装的是哪个 release')
  assert.equal(view.source?.packVersion, '1.0.0')
  assert.equal(view.packVersion, '1.0.0')
})

test('U1 只查跟随上游的环境：本地新建的、记着仓库但不跟随的都不出现在结果里，也不去问它们的仓库', async () => {
  const local = (await okPost('/api/environments/create', { name: '本地新建', dshVersion: '1.0.0' })).environment
  seedEnvironment('u-unfollowed', {
    base: { dshVersion: '1.0.0', dependencies: {}, bundles: [BASE, WEB] },
    source: { kind: 'github', repo: 'octo/u-unfollowed', release: 'v1.0.0', packVersion: '1.0.0', following: false },
  })
  github.setRepo('octo/u-unfollowed', [release('v9.0.0', envManifest('u-unfollowed', '9.0.0', '1.0.0', {}))])
  const following = await followLocal('octo/u-follow', envManifest('u-follow', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/u-follow', [release('v1.1.0', envManifest('u-follow', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  assert.equal((await envById('u-unfollowed'))?.following, false, '前置条件：摆好的那份不跟随')

  const updates = await checkUpdates({ force: true })
  assert.ok(updates[following.id], '跟随上游的环境要有结果')
  assert.equal(updates[local.id], undefined, '本地新建的不查')
  assert.equal(updates['u-unfollowed'], undefined, '不跟随的不查')
  assert.equal(github.apiHits('octo/u-unfollowed'), 0, '不跟随的环境的仓库一次都不该问')
})

test('U1 不在市场里的环境读 source.repo 的 releases 列表：结果带 installed / latest，新版本 available 为真', async () => {
  const view = await followLocal('octo/u-list', envManifest('u-list', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/u-list', [release('v1.1.0', envManifest('u-list', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  const before = github.listHits('octo/u-list')
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.ok(github.listHits('octo/u-list') > before, '要去读这个仓库的 releases 列表')
  assert.equal(result.available, true)
  assert.equal(result.installed?.version, '1.0.0')
  assert.equal(result.latest?.release, 'v1.1.0')
  assert.equal(result.latest?.version, '1.1.0')
})

/** 市场条目：包放在静态站上，条目指着它（同 id 的旧条目换掉）。 */
function putMarketEntry(id, owner, repo, manifest) {
  const pack = packBuffer(manifest)
  const path = `/market/${id}-${manifest.version}.dspack`
  site.routes[path] = { body: pack }
  const entry = {
    manifestVersion: 5, type: 'profile', id, name: manifest.name, version: manifest.version,
    displayName: { 'zh-CN': manifest.displayName, 'en-US': manifest.name }, description: '市场里的环境', owner, repo,
    downloadUrl: `${site.url}${path}`, sha256: sha256(pack), size: pack.length,
  }
  const at = MARKET.findIndex((item) => item.id === id)
  if (at >= 0) MARKET.splice(at, 1, entry)
  else MARKET.push(entry)
  writeMarket()
  return path
}
async function importFromMarket(id) {
  const market = await env.getJson('/api/packs/market?refresh=1')
  const entry = (market.entries || []).find((item) => item.id === id)
  assert.ok(entry, `前置条件：市场里有 ${id}：${JSON.stringify(market).slice(0, 300)}`)
  return importBody({ market: entry })
}

test('U1 市场里的环境（按 marketId 对上）读市场索引，不调 GitHub 接口', async () => {
  putMarketEntry('octo.u-market', 'octo', 'u-market', envManifest('u-market', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const view = await importFromMarket('octo.u-market')
  assert.equal(view.following, true, '前置条件：带仓库的市场条目跟随上游')
  assert.equal(view.source?.marketId, 'octo.u-market')
  // GitHub 上另有一个更新的版本：如果检查走了 GitHub，latest 会是它
  github.setRepo('octo/u-market', [release('v3.0.0', envManifest('u-market', '3.0.0', '1.0.0', depsOf({ a: '2.0.0' })))])
  putMarketEntry('octo.u-market', 'octo', 'u-market', envManifest('u-market', '2.0.0', '1.0.0', depsOf({ a: '1.1.0' })))
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.available, true)
  assert.equal(result.latest?.version, '2.0.0', '新版本来自市场索引')
  assert.equal(github.apiHits('octo/u-market'), 0, '市场里的环境不占 GitHub 接口额度')
})

test('U1 市场里的环境（GitHub 导入、没有 marketId，但市场里有同一个仓库）也读市场索引', async () => {
  const view = await followGithub('octo/u-same', envManifest('u-same', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  assert.ok(!view.source?.marketId, '前置条件：从 GitHub 导入，没有 marketId')
  github.publish('octo/u-same', release('v3.0.0', envManifest('u-same', '3.0.0', '1.0.0', depsOf({ a: '2.0.0' }))))
  putMarketEntry('someone.u-same-listed', 'octo', 'u-same', envManifest('u-same', '2.0.0', '1.0.0', depsOf({ a: '1.1.0' })))
  const before = github.listHits('octo/u-same')
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.latest?.version, '2.0.0', '同一个仓库在市场里：以市场索引为准')
  assert.equal(github.listHits('octo/u-same'), before, '不该再去读这个仓库的 releases 列表')
})

test('U1 市场索引读不到：市场里的环境退回问 GitHub', async (t) => {
  putMarketEntry('octo.u-fallback', 'octo', 'u-fallback', envManifest('u-fallback', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const view = await importFromMarket('octo.u-fallback')
  github.setRepo('octo/u-fallback', [release('v1.4.0', envManifest('u-fallback', '1.4.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  const route = site.routes['/market/index.json']
  delete site.routes['/market/index.json']
  t.after(async () => {
    site.routes['/market/index.json'] = route
    // 让服务端的市场缓存回到正常索引，不影响后面的用例
    await env.getJson('/api/packs/market?refresh=1')
  })
  const before = github.listHits('octo/u-fallback')
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.ok(github.listHits('octo/u-fallback') > before, '市场读不到就去读仓库的 releases')
  assert.ok(!result.error, `退回 GitHub 之后不该报错：${result.error}`)
  assert.equal(result.available, true)
  assert.equal(result.latest?.release, 'v1.4.0')
})

test('U1 缓存：同一个仓库 10 分钟内不再请求（新发的版本也看不到），force: true 绕过缓存立刻看到', async () => {
  const view = await followLocal('octo/u-cache', envManifest('u-cache', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/u-cache', [release('v1.1.0', envManifest('u-cache', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  const first = (await checkUpdates({ force: true }))[view.id]
  assert.equal(first.latest?.release, 'v1.1.0')
  const hits = github.listHits('octo/u-cache')
  assert.ok(hits >= 1)

  github.publish('octo/u-cache', release('v1.2.0', envManifest('u-cache', '1.2.0', '1.0.0', depsOf({ a: '1.2.0' }))))
  const cached = (await checkUpdates())[view.id]
  assert.equal(github.listHits('octo/u-cache'), hits, '缓存期内不带 force：不再请求')
  assert.equal(cached.latest?.release, 'v1.1.0', '缓存期内看到的还是上次的结果')
  const cachedFalse = (await checkUpdates({ force: false }))[view.id]
  assert.equal(github.listHits('octo/u-cache'), hits, 'force: false 等于没带')
  assert.equal(cachedFalse.latest?.release, 'v1.1.0')

  const forced = (await checkUpdates({ force: true }))[view.id]
  assert.equal(github.listHits('octo/u-cache'), hits + 1, 'force: true 绕过缓存，正好再请求一次')
  assert.equal(forced.latest?.release, 'v1.2.0')
})

test('U1 缓存按仓库：两个环境跟同一个仓库，一次检查只请求一次', async () => {
  const one = await followLocal('octo/u-shared', envManifest('u-shared-1', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const two = await followLocal('octo/u-shared', envManifest('u-shared-2', '1.0.0', '1.0.0', depsOf({ b: '1.0.0' })))
  github.setRepo('octo/u-shared', [release('v1.1.0', envManifest('u-shared', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  assert.equal(github.listHits('octo/u-shared'), 0, '前置条件：还没问过这个仓库')
  const updates = await checkUpdates()
  assert.equal(updates[one.id]?.available, true)
  assert.equal(updates[two.id]?.available, true)
  assert.equal(github.listHits('octo/u-shared'), 1, '同一个仓库的结果共用一份缓存')
})

test('U1 边界值 缓存时长：9 分 59 秒时还用缓存，10 分 1 秒时重新请求', async (t) => {
  const view = await followLocal('octo/u-ttl', envManifest('u-ttl', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/u-ttl', [release('v1.1.0', envManifest('u-ttl', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  await checkUpdates({ force: true })
  const hits = github.listHits('octo/u-ttl')
  // 服务和用例在同一个进程：把 Date.now 往后拨，等价于过了这么久（定时器不受影响）
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  Date.now = () => realNow() + (10 * 60 - 1) * 1000
  assert.equal((await checkUpdates())[view.id].available, true)
  assert.equal(github.listHits('octo/u-ttl'), hits, '9 分 59 秒：还在缓存期')
  Date.now = () => realNow() + (10 * 60 + 1) * 1000
  assert.equal((await checkUpdates())[view.id].available, true)
  assert.equal(github.listHits('octo/u-ttl'), hits + 1, '10 分 1 秒：缓存过期，重新请求')
  Date.now = realNow
})

test('U1 只提示不应用：有新版本时检查 / 打开环境页都不改环境清单、不存档、不动启动项', async () => {
  const view = await followGithub('octo/u-noauto', envManifest('u-noauto', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const preset = await bindPreset(view.id, '1.0.0')
  github.publish('octo/u-noauto', release('v1.1.0', envManifest('u-noauto', '1.1.0', '1.1.0', depsOf({ a: '2.0.0' }))))
  const before = treeDigest(envDir(view.id))
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.available, true, '前置条件：确实有新版本')
  await checkUpdates()
  const again = await envById(view.id)
  assert.deepEqual(treeDigest(envDir(view.id)), before, '环境目录一个字节都不能变')
  assert.deepEqual(again.history, [], '不该存档')
  assert.equal(again.source?.release, 'v1.0.0')
  assert.equal(pluginsOf(again)[P('a')], '1.0.0')
  assert.equal(again.dshVersion, '1.0.0')
  assert.equal(storedPreset(preset.id).version, '1.0.0', '启动项的版本不动')
})

// ---------------------------------------------------------------- U2：哪个 release 算数

test('U2 决策表 装着正式版：跳过草稿、勾了预发布的、tag 是 rc 但没勾标记的，提示最新的正式版', async () => {
  const view = await followLocal('octo/u-mixed', envManifest('u-mixed', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const m = (version) => envManifest('u-mixed', version, '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/u-mixed', [
    release('v3.0.0', m('3.0.0'), { draft: true }),
    release('v2.1.0', m('2.1.0'), { prerelease: true }),
    release('v2.0.5-rc.1', m('2.0.5-rc.1')),
    release('v2.0.0', m('2.0.0')),
    release('v1.0.0', m('1.0.0')),
  ])
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.installed?.prerelease, false, '前置条件：装着的是正式版')
  assert.equal(result.latest?.release, 'v2.0.0')
  assert.equal(result.available, true)
})

test('U2 装着正式版、比它新的全是预发布 / 草稿：不提示', async () => {
  const view = await followLocal('octo/u-onlypre', envManifest('u-onlypre', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const m = (version) => envManifest('u-onlypre', version, '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/u-onlypre', [release('v1.2.0', m('1.2.0'), { draft: true }), release('v1.1.0-rc.1', m('1.1.0-rc.1')), release('v1.0.0', m('1.0.0'))])
  assert.equal((await checkUpdates({ force: true }))[view.id].available, false)
})

test('U2 装着预发布：更新的预发布也提示，草稿照样跳过', async () => {
  const view = await followLocal('octo/u-pre', envManifest('u-pre', '2.0.0-rc.1', '1.0.0', depsOf({ a: '1.0.0' })))
  const m = (version) => envManifest('u-pre', version, '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/u-pre', [
    release('v3.0.0-rc.1', m('3.0.0-rc.1'), { draft: true, prerelease: true }),
    release('v2.0.0-rc.2', m('2.0.0-rc.2'), { prerelease: true }),
    release('v2.0.0-rc.1', m('2.0.0-rc.1'), { prerelease: true }),
  ])
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.installed?.prerelease, true, '前置条件：装着的是预发布')
  assert.equal(result.available, true)
  assert.equal(result.latest?.release, 'v2.0.0-rc.2')
})

test('U2 旧版永远不提示：最新发布的 release 是更旧的版本号（比如补丁线 v1.9.0），装着 v2.0.0 → 不提示；同一个 tag 也不提示', async () => {
  const view = await followGithub('octo/u-older', envManifest('u-older', '2.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-older', release('v1.9.0', envManifest('u-older', '1.9.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  assert.equal((await checkUpdates({ force: true }))[view.id].available, false, '1.9.0 比 2.0.0 旧')
  github.setRepo('octo/u-older', [release('v2.0.0', envManifest('u-older', '2.0.0', '1.0.0', depsOf({ a: '1.0.0' })))])
  assert.equal((await checkUpdates({ force: true }))[view.id].available, false, '同一个 tag')
})

test('U2 不是 semver 的 tag：换了一个 tag 就算新，同一个 tag 不算', async () => {
  const manifest = envManifest('u-nightly', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/u-nightly', [release('nightly-20261110', manifest)])
  const view = await importBody({ source: 'octo/u-nightly' })
  assert.equal(view.source?.release, 'nightly-20261110', '前置条件：记下的是这个 tag')
  assert.equal((await checkUpdates({ force: true }))[view.id].available, false, '同一个 tag')
  github.publish('octo/u-nightly', release('nightly-20261111', envManifest('u-nightly', '1.0.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.available, true, '换了 tag')
  assert.equal(result.latest?.release, 'nightly-20261111')
})

test('U2 决策表 装着的版本：没有 release tag 时 source.packVersion 压过顶层 packVersion；两者都没有时用顶层 packVersion', async () => {
  const base = { dshVersion: '1.0.0', dependencies: {}, bundles: [BASE, WEB] }
  // source.packVersion 1.5.0、顶层 1.0.0：上游 v1.2.0 比 1.5.0 旧，不提示（若误用顶层 1.0.0 就会提示）
  seedEnvironment('u-inst-srcpack', { base, source: { kind: 'github', repo: 'octo/u-inst-srcpack', packVersion: '1.5.0', following: true }, packVersion: '1.0.0' })
  // 只有顶层 packVersion 1.0.0：上游 v1.2.0 比它新
  seedEnvironment('u-inst-toppack', { base, source: { kind: 'github', repo: 'octo/u-inst-toppack', following: true }, packVersion: '1.0.0' })
  for (const repo of ['octo/u-inst-srcpack', 'octo/u-inst-toppack']) github.setRepo(repo, [release('v1.2.0', envManifest('inst', '1.2.0', '1.0.0', {}))])
  const updates = await checkUpdates({ force: true })
  assert.equal(updates['u-inst-srcpack']?.installed?.version, '1.5.0')
  assert.equal(updates['u-inst-srcpack']?.available, false)
  assert.equal(updates['u-inst-toppack']?.installed?.version, '1.0.0')
  assert.equal(updates['u-inst-toppack']?.available, true)
})

test('U2 装着的版本：release tag 优先于包版本——记着 v2.0.0（清单里 version 写成 1.0.0），上游发 v1.5.0 不该提示', async () => {
  seedEnvironment('u-inst-release', {
    base: { dshVersion: '1.0.0', dependencies: {}, bundles: [BASE, WEB] },
    source: { kind: 'github', repo: 'octo/u-inst-release', release: 'v2.0.0', packVersion: '1.0.0', following: true },
    packVersion: '1.0.0',
  })
  github.setRepo('octo/u-inst-release', [release('v1.5.0', envManifest('inst', '1.5.0', '1.0.0', {}))])
  const result = (await checkUpdates({ force: true }))['u-inst-release']
  assert.equal(result?.installed?.version, '2.0.0', `装着的版本先取 source.release：${JSON.stringify(result?.installed)}`)
  assert.equal(result?.available, false, 'v1.5.0 比装着的 v2.0.0 旧')
})

test('U2 某个环境查失败（仓库 404、接口限流 403）：只给它报 error，别的环境照常有结果，整个请求仍是 200', async () => {
  const gone = await followLocal('octo/u-gone', envManifest('u-gone', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const limited = await followLocal('octo/u-limited', envManifest('u-limited', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const fine = await followLocal('octo/u-fine', envManifest('u-fine', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/u-limited', [], 403)
  github.setRepo('octo/u-fine', [release('v1.1.0', envManifest('u-fine', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  const updates = await checkUpdates({ force: true })
  for (const [view, why] of [[gone, '404'], [limited, '403 限流']]) {
    assert.equal(updates[view.id]?.available, false, why)
    assert.equal(typeof updates[view.id]?.error, 'string', `${why} 要带 error`)
    assert.ok(updates[view.id].error.length > 0)
  }
  assert.equal(updates[fine.id]?.available, true, '别的环境不受影响')
  assert.ok(!updates[fine.id]?.error)
})

// ---------------------------------------------------------------- U3：检查一次更新

test('U3 检查下载新版本：release 里同时有 .zip 和 .dspack 时用 .dspack', async () => {
  const view = await followGithub('octo/u-asset', envManifest('u-asset', '1.0.0', '1.0.0', depsOf({ z: '1.0.0' })))
  github.publish('octo/u-asset', release('v1.1.0', null, {
    assets: [
      { name: 'notes.txt', data: Buffer.from('说明\n') },
      { name: 'u-asset.zip', data: packBuffer(envManifest('u-asset', '1.1.0', '1.0.0', depsOf({ z: '1.1.0' }))) },
      { name: 'u-asset.dspack', data: packBuffer(envManifest('u-asset', '1.1.0', '1.0.0', depsOf({ z: '1.2.0' }))) },
    ],
  }))
  const data = await inspectUpdate(view.id)
  assert.ok(github.downloaded('octo/u-asset', 'u-asset.dspack'), '要下载 .dspack')
  assert.ok(!github.downloaded('octo/u-asset', 'u-asset.zip'), '有 .dspack 就不用 .zip')
  assert.equal(changeOf(data.report.plugins.changed, P('z'))?.to, '1.2.0', '报告来自 .dspack 里的清单')
})

test('U3 检查下载新版本：release 里只有 .zip 就用 .zip；两种都没有 → 拒绝', async () => {
  const view = await followGithub('octo/u-zip', envManifest('u-zip', '1.0.0', '1.0.0', depsOf({ z: '1.0.0' })))
  github.publish('octo/u-zip', release('v1.1.0', null, { assets: [{ name: 'u-zip.zip', data: packBuffer(envManifest('u-zip', '1.1.0', '1.0.0', depsOf({ z: '1.1.0' }))) }] }))
  const data = await inspectUpdate(view.id)
  assert.ok(github.downloaded('octo/u-zip', 'u-zip.zip'))
  assert.equal(changeOf(data.report.plugins.changed, P('z'))?.to, '1.1.0')

  const bare = await followGithub('octo/u-noasset', envManifest('u-noasset', '1.0.0', '1.0.0', depsOf({ z: '1.0.0' })))
  github.publish('octo/u-noasset', release('v1.1.0', null, { assets: [{ name: 'notes.txt', data: Buffer.from('没有包\n') }] }))
  await rejected('/api/environments/update/inspect', { id: bare.id }, 'release 里没有 .dspack / .zip')
})

test('U3 市场里的环境：检查下载市场条目的地址，不碰 GitHub', async () => {
  putMarketEntry('octo.u-mdl', 'octo', 'u-mdl', envManifest('u-mdl', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const view = await importFromMarket('octo.u-mdl')
  const path = putMarketEntry('octo.u-mdl', 'octo', 'u-mdl', envManifest('u-mdl', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))
  // 刷新服务端的市场缓存：检查更新那一步读的是缓存里的索引
  assert.equal((await checkUpdates({ force: true }))[view.id]?.latest?.version, '1.1.0', '前置条件：市场里有新版本')
  const data = await inspectUpdate(view.id)
  assert.ok(site.hits.includes(path), `要下载市场条目的地址 ${path}`)
  assert.equal(github.apiHits('octo/u-mdl'), 0, '不该调 GitHub 接口')
  assert.equal(data.latest?.version, '1.1.0')
  assert.equal(changeOf(data.report.plugins.changed, P('a'))?.to, '1.1.0')
})

test('U3 检查什么都不写：环境目录（清单、history、files）和 settings.json 按字节不变', async () => {
  const id = await scenario('octo/u-readonly', 'u-readonly')
  const before = { tree: treeDigest(envDir(id)), settings: readFileSync(env.settingsFile, 'utf8') }
  const data = await inspectUpdate(id)
  assert.equal(data.environment?.id, id)
  assert.equal(typeof data.environment?.name, 'string')
  assert.deepEqual(treeDigest(envDir(id)), before.tree, '检查不能写环境目录')
  assert.equal(readFileSync(env.settingsFile, 'utf8'), before.settings, '检查不能写设置')
  assert.deepEqual(historyFiles(id), [], '检查不能存档')
  assert.deepEqual((await envById(id)).history, [])
})

test('U3 检查拒绝：不跟随的环境、没有更新的版本、不存在的环境', async () => {
  const local = (await okPost('/api/environments/create', { name: '不跟随的', dshVersion: '1.0.0' })).environment
  await rejected('/api/environments/update/inspect', { id: local.id }, '不跟随上游')
  const current = await followGithub('octo/u-current', envManifest('u-current', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  await rejected('/api/environments/update/inspect', { id: current.id }, '已经是最新')
  await rejected('/api/environments/update/inspect', { id: 'no-such-env' }, '不存在的环境')
  await rejected('/api/environments/update/inspect', {}, '没给 id')
})

test('U3 决策表 差别报告：DSH 变化、生效清单加 j / 删 k / 换 l、重复 b / e / h、冲突 a（changed）/ d（removed）、unverified a / c / g', async () => {
  const id = await scenario('octo/u-report', 'u-report')
  const data = await inspectUpdate(id)
  assert.equal(data.installed?.release, 'v1.0.0')
  assert.equal(data.latest?.release, 'v1.1.0')
  assert.equal(data.dsh?.version, '1.1.0')
  assert.equal(data.dsh?.installed, true)
  assert.ok(Array.isArray(data.errors) && Array.isArray(data.warnings) && Array.isArray(data.offline))
  const { report } = data
  assert.equal(report.dsh.from, '1.0.0')
  assert.equal(report.dsh.to, '1.1.0')
  assert.equal(report.dsh.upstreamFrom, '1.0.0')
  assert.equal(report.dsh.upstreamTo, '1.1.0')
  assert.ok(!report.dsh.local, '本地没钉 DSH')
  assert.deepEqual(namesIn(report.plugins.added), [P('j')])
  assert.deepEqual(namesIn(report.plugins.removed), [P('k')])
  assert.deepEqual(namesIn(report.plugins.changed), [P('l')], '本地钉住的 a 生效值不变，不算「换了」')
  assert.equal(changeOf(report.plugins.changed, P('l'))?.from, '1.0.0')
  assert.equal(changeOf(report.plugins.changed, P('l'))?.to, '1.1.0')
  assert.deepEqual(sorted(report.duplicates), [P('b'), P('e'), P('h')])
  const conflicts = Object.fromEntries(report.conflicts.map((item) => [item.name, item]))
  assert.deepEqual(Object.keys(conflicts).sort(), [P('a'), P('d')], JSON.stringify(report.conflicts))
  assert.deepEqual([conflicts[P('a')].kind, conflicts[P('a')].local, conflicts[P('a')].from, conflicts[P('a')].to], ['changed', '1.5.0', '1.0.0', '2.0.0'])
  assert.deepEqual([conflicts[P('d')].kind, conflicts[P('d')].from, conflicts[P('d')].to], ['removed', '1.0.0', '2.0.0'])
  assert.deepEqual(sorted(report.unverified), [P('a'), P('c'), P('g')])
})

test('U3 unverified：上游没换 DSH 版本时为空，哪怕本地加了插件', async () => {
  const view = await followGithub('octo/u-noverify', envManifest('u-noverify', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  await okPost('/api/environments/plugins/add', { id: view.id, spec: `${P('g')}@1.0.0` })
  github.publish('octo/u-noverify', release('v1.1.0', envManifest('u-noverify', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  const { report } = await inspectUpdate(view.id)
  assert.equal(report.dsh.upstreamFrom, report.dsh.upstreamTo, '前置条件：上游没换 DSH')
  assert.deepEqual(report.unverified, [])
})

test('U3 新上游要的 DSH 本机没装：dsh.installed 为假，报出要的版本', async () => {
  const view = await followGithub('octo/u-needdsh', envManifest('u-needdsh', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-needdsh', release('v1.1.0', envManifest('u-needdsh', '1.1.0', '1.3.0', depsOf({ a: '1.1.0' }))))
  const data = await inspectUpdate(view.id)
  assert.equal(data.dsh?.version, '1.3.0')
  assert.equal(data.dsh?.installed, false)
  assert.equal(data.report.dsh.upstreamTo, '1.3.0')
})

// ---------------------------------------------------------------- U4：应用

test('U4 应用：上游层换成新的，增量重放（钉的照留、删的照删、加的照留、重复的去掉），来源 / 包版本记新版本，仍跟随', async () => {
  const id = await scenario('octo/u-apply', 'u-apply')
  const { token } = await inspectUpdate(id)
  const result = await applyUpdate(token)
  assert.equal(result.environment?.id, id)
  assert.ok(result.report, '应用也回差别报告')
  const stored = readEnvFile(id)
  assert.equal(stored.base.dshVersion, '1.1.0', '上游层的 DSH 换成新的')
  assert.deepEqual(stored.base.dependencies, V2_DEPS, '上游层的清单整份换成新的')
  assert.deepEqual(stored.delta.dependencies, depsOf({ a: '1.5.0', c: '1.5.0', g: '1.0.0' }), '和新上游一样的 b / h 从增量去掉')
  assert.deepEqual(sorted(stored.delta.removed), [P('d'), P('f')], '上游也删了的 e 从增量去掉')
  const view = await envById(id)
  assert.deepEqual(pluginsOf(view), depsOf({ a: '1.5.0', b: '2.0.0', c: '1.5.0', g: '1.0.0', h: '1.0.0', j: '1.0.0', l: '1.1.0' }))
  assert.equal(view.dshVersion, '1.1.0')
  assert.equal(view.following, true, '更新之后仍跟随上游')
  assert.equal(view.source?.release, 'v1.1.0')
  assert.equal(view.source?.packVersion, '1.1.0')
  assert.equal(view.packVersion, '1.1.0')
  assert.deepEqual(sorted(view.delta?.added), [P('g')])
  assert.deepEqual(sorted(view.delta?.changed), [P('a'), P('c')])
  assert.deepEqual(sorted(view.delta?.removed), [P('d'), P('f')])
})

test('U4 应用：旧清单存到 history/<时间戳>.json（内容就是更新前那份），列表的 history 新到旧列出它', async () => {
  const id = await scenario('octo/u-archive', 'u-archive')
  const old = readEnvFile(id)
  const { token } = await inspectUpdate(id)
  const { archived } = await applyUpdate(token)
  assert.equal(typeof archived, 'string')
  assert.match(archived, /^(\d{4}-\d{2}-\d{2}T[0-9-]+Z?|\d{10,})\.json$/, `备份名要是时间戳：${archived}`)
  const file = join(historyDir(id), archived)
  assert.ok(existsSync(file), `旧清单要落在 ${file}`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  for (const field of ['id', 'name', 'base', 'delta', 'source', 'files', 'packVersion']) assert.deepEqual(saved[field], old[field], `存档的 ${field} 要和更新前一样`)
  assert.deepEqual((await envById(id)).history, [archived])
})

test('U4 discard：点名的插件丢掉本地改动回到上游（钉的 a 回 2.0.0、删的 d 回来、加的 g 消失），其余照留', async () => {
  const id = await scenario('octo/u-discard', 'u-discard')
  const { token } = await inspectUpdate(id)
  await applyUpdate(token, [P('a'), P('d'), P('g')])
  const plugins = pluginsOf(await envById(id))
  assert.equal(plugins[P('a')], '2.0.0')
  assert.equal(plugins[P('d')], '2.0.0')
  assert.equal(plugins[P('g')], undefined)
  assert.equal(plugins[P('c')], '1.5.0', '没点名的照留')
  assert.equal(plugins[P('f')], undefined, '没点名的删除照删')
  const { delta } = readEnvFile(id)
  for (const name of [P('a'), P('d'), P('g')]) assert.ok(!Object.hasOwn(delta.dependencies, name) && !delta.removed.includes(name), `${name} 不该还在增量里`)
})

test('U4 决策表 启动项版本：增量没钉 DSH → 用这个环境的启动项跟着换成新上游的版本；钉了 → 启动项和环境都留在钉的版本', async () => {
  const free = await followGithub('octo/u-preset-free', envManifest('u-preset-free', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const pinned = await followGithub('octo/u-preset-pin', envManifest('u-preset-pin', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const freePreset = await bindPreset(free.id, '1.0.0')
  const pinnedPreset = await bindPreset(pinned.id, '1.0.0')
  await okPost('/api/environments/update', { id: pinned.id, dshVersion: '1.2.0' })
  assert.equal(storedPreset(pinnedPreset.id).version, '1.2.0', '前置条件：本地钉 DSH 已双写到启动项')
  for (const [view, repo] of [[free, 'octo/u-preset-free'], [pinned, 'octo/u-preset-pin']]) {
    github.publish(repo, release('v1.1.0', envManifest(repo.split('/')[1], '1.1.0', '1.1.0', depsOf({ a: '1.1.0' }))))
    await applyUpdate((await inspectUpdate(view.id)).token)
  }
  assert.equal(storedPreset(freePreset.id).version, '1.1.0', '没钉：启动项跟着新上游')
  assert.equal((await envById(free.id)).dshVersion, '1.1.0')
  assert.equal(storedPreset(pinnedPreset.id).version, '1.2.0', '钉了：启动项不动')
  assert.equal((await envById(pinned.id)).dshVersion, '1.2.0', '钉了：环境生效版本还是钉的')
  assert.equal(readEnvFile(pinned.id).base.dshVersion, '1.1.0', '上游层照样换成新的')
})

const TGZ_A = makeTgz({ 'package/package.json': '{"name":"dsh-x-local","version":"1.0.0"}\n', 'package/index.js': 'export default "A"\n' })
const TGZ_B = makeTgz({ 'package/package.json': '{"name":"dsh-x-local","version":"1.0.0"}\n', 'package/index.js': 'export default "B"\n' })
const OFFLINE = 'dsh-x-local-1.0.0.tgz'
/** 带一个离线插件的清单：文件名不变、内容不同（作者改了本地插件没改版本号）——按内容分子目录才放得下两份。 */
const offlineManifest = (version, tgz) => envManifest('u-offline', version, '1.0.0', { ...depsOf({ a: '1.0.0' }), [P('local')]: `file:offline/${OFFLINE}` }, {
  offline: { [P('local')]: { file: `offline/${OFFLINE}`, sha256: sha256(tgz) } },
})

test('U4 离线文件：新版本的放进 files/<sha256 前 8 位>/<文件>，旧版本的留着；检查时不落盘；切回旧清单还指着旧文件', async () => {
  const view = await followGithub('octo/u-offline', offlineManifest('1.0.0', TGZ_A), { files: { [`offline/${OFFLINE}`]: TGZ_A } })
  const pathA = extractedOfflinePath(env.app, view.id, OFFLINE, sha256(TGZ_A))
  const pathB = extractedOfflinePath(env.app, view.id, OFFLINE, sha256(TGZ_B))
  assert.ok(existsSync(pathA), `前置条件：导入时解到 ${pathA}`)
  github.publish('octo/u-offline', release('v1.1.0', offlineManifest('1.1.0', TGZ_B), { files: { [`offline/${OFFLINE}`]: TGZ_B } }))
  const inspected = await inspectUpdate(view.id)
  assert.ok(inspected.offline.some((item) => item.name === P('local') && item.sha256 === sha256(TGZ_B)), `检查要列出新包的离线文件：${JSON.stringify(inspected.offline)}`)
  assert.equal(existsSync(pathB), false, '检查不能落盘离线文件')
  const { archived } = await applyUpdate(inspected.token)
  assert.ok(existsSync(pathB), `新版本的离线文件要在 ${pathB}`)
  assert.equal(sha256(readFileSync(pathB)), sha256(TGZ_B))
  assert.ok(existsSync(pathA), '旧版本的离线文件不能删（切回旧清单要用）')
  assert.equal(pluginsOf(await envById(view.id))[P('local')], `file:${pathB}`, '坐标换成新文件')
  await okPost('/api/environments/history/restore', { id: view.id, name: archived })
  assert.equal(pluginsOf(await envById(view.id))[P('local')], `file:${pathA}`, '切回去还指着旧文件')
  assert.ok(existsSync(pathA))
})

test('U4 状态迁移 token：用过一次就作废，再用被拒，不会再存一份档', async () => {
  const view = await followGithub('octo/u-once', envManifest('u-once', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-once', release('v1.1.0', envManifest('u-once', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  const { token } = await inspectUpdate(view.id)
  await applyUpdate(token)
  const history = historyFiles(view.id)
  assert.equal(history.length, 1)
  const after = readFileSync(envFile(view.id), 'utf8')
  await rejected('/api/environments/update/apply', { token }, '用过的 token')
  assert.deepEqual(historyFiles(view.id), history, '被拒的应用不能存档')
  assert.equal(readFileSync(envFile(view.id), 'utf8'), after, '被拒的应用不能改清单')
  await rejected('/api/environments/update/apply', { token: 'no-such-token' }, '不认识的 token')
  await rejected('/api/environments/update/apply', {}, '没有 token')
})

test('U4 状态迁移 保存前失败可重试：要的 DSH 装不上 → 400、清单 / history 不动；装好之后同一个 token 再点就成功', async () => {
  const view = await followGithub('octo/u-retry', envManifest('u-retry', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  // 1.3.0 已发布但 registry 里没有 tarball：不管本机有没有 npm 都装不上
  github.publish('octo/u-retry', release('v1.1.0', envManifest('u-retry', '1.1.0', '1.3.0', depsOf({ a: '1.1.0' }))))
  const inspected = await inspectUpdate(view.id)
  assert.equal(inspected.dsh?.installed, false, '前置条件：要的 DSH 本机没有')
  const before = readFileSync(envFile(view.id), 'utf8')
  await rejected('/api/environments/update/apply', { token: inspected.token }, 'DSH 装不上')
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before, '装失败不能改清单')
  assert.deepEqual(historyFiles(view.id), [], '装失败不能存档')
  // 用户自己把 1.3.0 装上了（这里直接摆一个已装版本），再点一次确认
  env.addVersions(['1.3.0'])
  const result = await applyUpdate(inspected.token)
  assert.equal(result.environment?.id, view.id)
  assert.equal((await envById(view.id)).dshVersion, '1.3.0')
  assert.equal(historyFiles(view.id).length, 1)
})

test('U4 要的 DSH 本机没装：应用时自动装上', { skip: NO_NPM }, async () => {
  const view = await followGithub('octo/u-install', envManifest('u-install', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-install', release('v1.1.0', envManifest('u-install', '1.1.0', '2.0.0', depsOf({ a: '1.1.0' }))))
  const inspected = await inspectUpdate(view.id)
  assert.equal(inspected.dsh?.installed, false)
  await applyUpdate(inspected.token)
  assert.ok(existsSync(join(env.data, 'versions', '2.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), '应用时要把 DSH 2.0.0 装上')
  assert.equal((await envById(view.id)).dshVersion, '2.0.0')
})

test('U4 检查之后下载下来的包被换了：应用被拒，清单 / history 不动', async () => {
  const view = await followGithub('octo/u-tamper', envManifest('u-tamper', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-tamper', release('v1.1.0', envManifest('u-tamper', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  const { token } = await inspectUpdate(view.id)
  const files = downloadedPackFor(token)
  assert.equal(files.length, 1, `前置条件：找到检查时下载的那个包：${JSON.stringify(files)}`)
  writeFileSync(files[0], packBuffer(envManifest('u-tamper', '1.1.0', '1.0.0', depsOf({ a: '2.0.0', m: '1.0.0' }))))
  const before = readFileSync(envFile(view.id), 'utf8')
  await rejected('/api/environments/update/apply', { token }, '包在检查之后变了')
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before)
  assert.deepEqual(historyFiles(view.id), [])
})

// ---------------------------------------------------------------- U5：跟随中的本地改动

test('U5 状态迁移 跟随中本地加 / 删 / 升级插件、改 DSH 版本：进增量、上游层不动；应用更新后照留，报告里看得到', async () => {
  const view = await followGithub('octo/u-edits', envManifest('u-edits', '1.0.0', '1.0.0', depsOf({ x: '1.0.0', y: '1.0.0', z: '1.0.0' })))
  const base = structuredClone(readEnvFile(view.id).base)
  await okPost('/api/environments/plugins/add', { id: view.id, spec: `${P('w')}@1.0.0` })
  await okPost('/api/environments/plugins/remove', { id: view.id, name: P('y') })
  const upgraded = await okPost('/api/environments/plugins/upgrade', { id: view.id, name: P('x') })
  assert.ok(JSON.stringify(upgraded).includes('2.0.0'), `前置条件：x 升级到 registry 上的 latest 2.0.0：${JSON.stringify(upgraded)}`)
  await okPost('/api/environments/update', { id: view.id, dshVersion: '1.2.0' })

  // 本地改动阶段：上游层原样，改动全在增量里
  const edited = readEnvFile(view.id)
  assert.deepEqual(edited.base, base, '跟随中的本地改动不能写进上游层')
  const local = await envById(view.id)
  assert.deepEqual(sorted(local.delta?.added), [P('w')])
  assert.deepEqual(sorted(local.delta?.changed), [P('x')])
  assert.deepEqual(sorted(local.delta?.removed), [P('y')])
  assert.equal(local.delta?.dshVersion, '1.2.0')
  assert.equal(local.dshVersion, '1.2.0')
  assert.deepEqual(pluginsOf(local), depsOf({ w: '1.0.0', x: '2.0.0', z: '1.0.0' }))

  // 上游发新版：DSH 1.0.0 → 1.1.0，x 换到 1.1.0（和本地升级撞上），z 换到 1.1.0，y 没动
  github.publish('octo/u-edits', release('v1.1.0', envManifest('u-edits', '1.1.0', '1.1.0', depsOf({ x: '1.1.0', y: '1.0.0', z: '1.1.0' }))))
  const { token, report } = await inspectUpdate(view.id)
  assert.equal(report.dsh.local, '1.2.0', '报告要报出本地钉的 DSH')
  assert.equal(report.dsh.from, '1.2.0')
  assert.equal(report.dsh.to, '1.2.0', '本地钉的 DSH 压过上游')
  assert.equal(report.dsh.upstreamTo, '1.1.0')
  const conflicts = report.conflicts.filter((item) => item.name === P('x'))
  assert.equal(conflicts.length, 1, `x 要报成冲突：${JSON.stringify(report.conflicts)}`)
  assert.deepEqual([conflicts[0].kind, conflicts[0].local, conflicts[0].from, conflicts[0].to], ['changed', '2.0.0', '1.0.0', '1.1.0'])
  assert.ok(!report.conflicts.some((item) => item.name === P('y')), '上游没动 y，本地删 y 不算冲突')
  assert.deepEqual(namesIn(report.plugins.changed), [P('z')])
  assert.deepEqual(sorted(report.unverified), [P('w'), P('x')], '上游换了 DSH：本地加的 w、升级的 x 没经过上游验证')

  await applyUpdate(token)
  const after = await envById(view.id)
  assert.deepEqual(pluginsOf(after), depsOf({ w: '1.0.0', x: '2.0.0', z: '1.1.0' }), '本地加的 / 升级的 / 删的都照留，上游换的 z 跟上')
  assert.equal(after.dshVersion, '1.2.0')
  assert.deepEqual(sorted(after.delta?.added), [P('w')])
  assert.deepEqual(sorted(after.delta?.changed), [P('x')])
  assert.deepEqual(sorted(after.delta?.removed), [P('y')])
  assert.equal(after.delta?.dshVersion, '1.2.0')
  assert.equal(readEnvFile(view.id).base.dshVersion, '1.1.0')
})

// ---------------------------------------------------------------- U6：切回

test('U6 状态迁移 切回：base / delta / source / DSH 回到存档；现在这份先存档，可以再切回来；名字保持现在的；启动项版本跟着变', async () => {
  const view = await followGithub('octo/u-restore', envManifest('u-restore', '1.0.0', '1.0.0', depsOf({ a: '1.0.0', b: '1.0.0' })))
  await okPost('/api/environments/plugins/add', { id: view.id, spec: `${P('g')}@1.0.0` })
  const preset = await bindPreset(view.id, '1.0.0')
  github.publish('octo/u-restore', release('v1.1.0', envManifest('u-restore', '1.1.0', '1.1.0', depsOf({ a: '1.1.0', b: '1.0.0', j: '1.0.0' }))))
  const { archived } = await applyUpdate((await inspectUpdate(view.id)).token)
  assert.equal(storedPreset(preset.id).version, '1.1.0', '前置条件：应用后启动项是新版本')
  await okPost('/api/environments/update', { id: view.id, name: '改名之后' })
  const updated = readEnvFile(view.id)
  const old = JSON.parse(readFileSync(join(historyDir(view.id), archived), 'utf8'))

  const restored = await okPost('/api/environments/history/restore', { id: view.id, name: archived })
  assert.equal(restored.ok, true)
  const now = readEnvFile(view.id)
  for (const field of ['base', 'delta', 'source', 'files']) assert.deepEqual(now[field], old[field], `${field} 回到存档`)
  assert.equal(now.name, '改名之后', '名字保持现在的，不跟着存档改回去')
  const view1 = await envById(view.id)
  assert.equal(view1.dshVersion, '1.0.0')
  assert.equal(view1.source?.release, 'v1.0.0')
  assert.deepEqual(pluginsOf(view1), depsOf({ a: '1.0.0', b: '1.0.0', g: '1.0.0' }))
  assert.equal(storedPreset(preset.id).version, '1.0.0', '启动项版本跟着切回')

  // 切回之前的那份也存了档：排在最前（新到旧），内容是更新后的那份
  assert.equal(view1.history.length, 2, `history：${JSON.stringify(view1.history)}`)
  assert.ok(view1.history.includes(archived))
  const newest = view1.history[0]
  assert.notEqual(newest, archived)
  const saved = JSON.parse(readFileSync(join(historyDir(view.id), newest), 'utf8'))
  assert.deepEqual(saved.base, updated.base, '先存的是切回前的那份')
  assert.deepEqual(saved.source, updated.source)

  await okPost('/api/environments/history/restore', { id: view.id, name: newest })
  const view2 = await envById(view.id)
  assert.equal(view2.source?.release, 'v1.1.0', '可以再切回更新后的那份')
  assert.equal(view2.dshVersion, '1.1.0')
  assert.equal(view2.name, '改名之后')
  assert.equal(storedPreset(preset.id).version, '1.1.0')
  assert.equal(view2.history.length, 3)
})

test('U6 切回坏名字：路径穿越、不是 <时间戳>.json、空、缺字段、名字合法但不存在、不存在的环境 → 400，清单和 history 不动', async () => {
  const view = await followGithub('octo/u-badname', envManifest('u-badname', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/u-badname', release('v1.1.0', envManifest('u-badname', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  const { archived } = await applyUpdate((await inspectUpdate(view.id)).token)
  const before = { manifest: readFileSync(envFile(view.id), 'utf8'), history: historyFiles(view.id) }
  // ../environment.json 指向现在的清单、../../../settings.json 指向设置：没拦住的话会「切回」成功或把设置当清单读
  const names = ['../environment.json', '../../../settings.json', `../history/${archived}/../../environment.json`, 'environment.json', 'notes.txt', '', `${archived}.bak`, 'C:\\evil.json', '2000-01-01T00-00-00-000Z.json']
  for (const name of names) await rejected('/api/environments/history/restore', { id: view.id, name }, `备份名「${name}」`)
  await rejected('/api/environments/history/restore', { id: view.id }, '缺 name')
  await rejected('/api/environments/history/restore', { id: 'no-such-env', name: archived }, '不存在的环境')
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before.manifest, '被拒的切回不能改清单')
  assert.deepEqual(historyFiles(view.id), before.history, '被拒的切回不能存档')
})

// ---------------------------------------------------------------- U7：退役

test('U7 旧的「更新整合包 = 每个插件升到 npm 最新」接口 POST /api/packs/update 已退役：404', async () => {
  const result = await env.call('/api/packs/update', {})
  assert.equal(result.status, 404, `应为 404，实际 HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`)
  const named = await env.call('/api/packs/update', { name: 'dsh-x-recommended', profile: 'web' })
  assert.equal(named.status, 404)
})

// ================================================================ 第二轮需求

const versionBin = (version) => join(env.data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
/** 只有说明文件、没有包的 release（作者先发 release 再补资产，或者干脆忘了传）。 */
const bareRelease = (tag, assets = [{ name: 'notes.txt', data: Buffer.from('只有说明\n') }]) => ({ tag, assets })

// ---------------------------------------------------------------- B6：没有包资产的 release 不算候选

test('B6 边界值 最新的 release 没有包（0 个资产 / 只有 notes.txt）、更早的 v1.1.0 有 .dspack 且仍比装着的新 → 提示 v1.1.0，检查和应用都用它', async () => {
  const m = (version, a) => envManifest('n-asset-skip', version, '1.0.0', depsOf({ a }))
  const view = await followLocal('octo/n-asset-skip', m('1.0.0', '1.0.0'))
  github.setRepo('octo/n-asset-skip', [bareRelease('v1.3.0', []), bareRelease('v1.2.0'), release('v1.1.0', m('1.1.0', '1.1.0')), release('v1.0.0', m('1.0.0', '1.0.0'))])
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.available, true)
  assert.equal(result.latest?.release, 'v1.1.0', `没资产的 v1.3.0 / v1.2.0 不算候选：${JSON.stringify(result.latest)}`)
  const inspected = await inspectUpdate(view.id)
  assert.equal(inspected.latest?.release, 'v1.1.0')
  await applyUpdate(inspected.token)
  const after = await envById(view.id)
  assert.equal(after.source?.release, 'v1.1.0')
  assert.equal(pluginsOf(after)[P('a')], '1.1.0')
})

test('B6 比装着新的 release 全都没有包资产 → 不提示，检查更新被拒', async () => {
  const view = await followLocal('octo/n-asset-none', envManifest('n-asset-none', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.setRepo('octo/n-asset-none', [bareRelease('v1.2.0'), bareRelease('v1.1.0', [])])
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.available, false, JSON.stringify(result))
  assert.ok(!result.error, `没有候选不是错误：${result.error}`)
  await rejected('/api/environments/update/inspect', { id: view.id }, '没有带包的新版本')
})

// ---------------------------------------------------------------- A3（HTTP）：取版本最高的

test('A3 发布顺序 ≠ 版本顺序：[v1.2.5（最新发的补丁）, v2.0.0, v1.0.0]，装着 v1.0.0 → 提示 v2.0.0', async () => {
  const m = (version) => envManifest('n-highest', version, '1.0.0', depsOf({ a: '1.0.0' }))
  const view = await followLocal('octo/n-highest', m('1.0.0'))
  github.setRepo('octo/n-highest', [release('v1.2.5', m('1.2.5')), release('v2.0.0', m('2.0.0')), release('v1.0.0', m('1.0.0'))])
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.latest?.release, 'v2.0.0')
  assert.equal(result.available, true)
})

// ---------------------------------------------------------------- B7：导入时记下预发布标记

test('B7 从 GitHub 导入勾了 Pre-release 的 v1.3.0（owner/repo@tag）：source.prerelease 为真，之后的预发布会提示给它', async () => {
  // GitHub 的 releases/latest 永远不给预发布，导预发布只能点名 tag
  const m = (version) => envManifest('n-prerel', version, '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/n-prerel', [release('v1.3.0', m('1.3.0'), { prerelease: true })])
  const view = await importBody({ source: 'octo/n-prerel@v1.3.0' })
  assert.equal(view.source?.release, 'v1.3.0')
  assert.equal(view.source?.prerelease, true, `要记下 GitHub 的预发布标记：${JSON.stringify(view.source)}`)
  github.publish('octo/n-prerel', release('v1.4.0-rc.1', m('1.4.0-rc.1'), { prerelease: true }))
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.installed?.prerelease, true)
  assert.equal(result.available, true)
  assert.equal(result.latest?.release, 'v1.4.0-rc.1')
})

test('B7 对照：导入的 v1.3.0 没勾 Pre-release → 不记 prerelease，之后的预发布不提示', async () => {
  const m = (version) => envManifest('n-stablerel', version, '1.0.0', depsOf({ a: '1.0.0' }))
  github.setRepo('octo/n-stablerel', [release('v1.3.0', m('1.3.0'))])
  const view = await importBody({ source: 'octo/n-stablerel@v1.3.0' })
  assert.notEqual(view.source?.prerelease, true)
  github.publish('octo/n-stablerel', release('v1.4.0-rc.1', m('1.4.0-rc.1'), { prerelease: true }))
  assert.equal((await checkUpdates({ force: true }))[view.id].available, false)
})

// ---------------------------------------------------------------- B8：同仓库一次请求；失败也缓存

test('B8 一次检查里两个环境跟同一个仓库：force: true 也只请求一次 releases（每次 POST 一次）', async () => {
  const one = await followLocal('octo/n-shared-force', envManifest('n-shared-force-1', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const two = await followLocal('octo/n-shared-force', envManifest('n-shared-force-2', '1.0.0', '1.0.0', depsOf({ b: '1.0.0' })))
  github.setRepo('octo/n-shared-force', [release('v1.1.0', envManifest('n-shared-force', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  for (const round of [1, 2]) {
    const before = github.listHits('octo/n-shared-force')
    const updates = await checkUpdates({ force: true })
    assert.equal(updates[one.id]?.available, true)
    assert.equal(updates[two.id]?.available, true)
    assert.equal(github.listHits('octo/n-shared-force'), before + 1, `第 ${round} 次 force 检查：同一个仓库只请求一次`)
  }
})

test('B8 决策表 查失败也缓存 10 分钟（404 / 403 限流 / 500）：不带 force 不再请求、照样报错；force: true 重试', async () => {
  // 网络层的错误（连接断开）在这里用 500 代替：代理那头一断，启动器会改直连真的 api.github.com，离线测试不能这么做
  const cases = { 'octo/n-fail-404': 0, 'octo/n-fail-403': 403, 'octo/n-fail-500': 500 }
  const ids = {}
  for (const [repo, status] of Object.entries(cases)) {
    ids[repo] = (await followLocal(repo, envManifest(repo.split('/')[1], '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))).id
    if (status) github.setRepo(repo, [], status)
  }
  const first = await checkUpdates({ force: true })
  const hits = Object.fromEntries(Object.keys(cases).map((repo) => [repo, github.listHits(repo)]))
  for (const repo of Object.keys(cases)) {
    assert.equal(typeof first[ids[repo]]?.error, 'string', `${repo}：先报错`)
    assert.ok(hits[repo] >= 1)
  }
  const cached = await checkUpdates()
  for (const repo of Object.keys(cases)) {
    assert.equal(github.listHits(repo), hits[repo], `${repo}：失败结果在缓存期内，不带 force 不再请求`)
    assert.equal(typeof cached[ids[repo]]?.error, 'string', `${repo}：缓存的失败照样报错`)
    assert.equal(cached[ids[repo]].available, false)
  }
  // 仓库恢复了：缓存期内不带 force 还是旧的失败，force 才看得到
  github.setRepo('octo/n-fail-500', [release('v1.1.0', envManifest('n-fail-500', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' })))])
  assert.equal(typeof (await checkUpdates())[ids['octo/n-fail-500']]?.error, 'string', '缓存期内还是那次失败')
  assert.equal(github.listHits('octo/n-fail-500'), hits['octo/n-fail-500'])
  const forced = await checkUpdates({ force: true })
  for (const repo of Object.keys(cases)) assert.equal(github.listHits(repo), hits[repo] + 1, `${repo}：force 重试一次`)
  assert.equal(typeof forced[ids['octo/n-fail-404']]?.error, 'string')
  assert.equal(typeof forced[ids['octo/n-fail-403']]?.error, 'string')
  assert.ok(!forced[ids['octo/n-fail-500']]?.error, `恢复后 force 重试成功：${forced[ids['octo/n-fail-500']]?.error}`)
  assert.equal(forced[ids['octo/n-fail-500']].available, true)
})

// ---------------------------------------------------------------- B9：市场条目怎么算对上

test('B9 决策表 marketId 相同（条目后来改了名字）→ 仍按市场索引查，不调 GitHub', async () => {
  putMarketEntry('octo.n-mid', 'octo', 'n-mid', envManifest('n-mid', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const view = await importFromMarket('octo.n-mid')
  github.setRepo('octo/n-mid', [release('v3.0.0', envManifest('n-mid', '3.0.0', '1.0.0', depsOf({ a: '2.0.0' })))])
  putMarketEntry('octo.n-mid', 'octo', 'n-mid', envManifest('n-mid-renamed', '2.0.0', '1.0.0', depsOf({ a: '1.1.0' })))
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.equal(result.latest?.version, '2.0.0')
  assert.equal(github.apiHits('octo/n-mid'), 0)
})

test('B9 决策表 同一个仓库、但条目 name 和 packId 不同（一个仓库里的另一个包）→ 不用这个条目，退回 GitHub releases', async () => {
  const view = await followGithub('octo/n-mname', envManifest('n-mname', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  assert.equal(view.source?.packId, 'n-mname', '前置条件：来源记着 packId')
  github.publish('octo/n-mname', release('v1.1.0', envManifest('n-mname', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  putMarketEntry('someone.n-mname-other', 'octo', 'n-mname', envManifest('other-pack', '5.0.0', '1.0.0', depsOf({ a: '2.0.0' })))
  const before = github.listHits('octo/n-mname')
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.ok(github.listHits('octo/n-mname') > before, '要退回 GitHub 读 releases')
  assert.equal(result.latest?.release, 'v1.1.0', `不能拿别的包的版本当更新：${JSON.stringify(result.latest)}`)
  const inspected = await inspectUpdate(view.id)
  assert.equal(changeOf(inspected.report.plugins.changed, P('a'))?.to, '1.1.0', '检查下载的也是 GitHub 上这个包的新版')
})

test('B9 决策表 条目 name 和 packId 相同、但仓库不同（别人 fork 的同名包）→ 不用，退回 GitHub releases', async () => {
  const view = await followGithub('octo/n-mrepo', envManifest('n-mrepo', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/n-mrepo', release('v1.1.0', envManifest('n-mrepo', '1.1.0', '1.0.0', depsOf({ a: '1.1.0' }))))
  putMarketEntry('fork.n-mrepo', 'fork', 'n-mrepo', envManifest('n-mrepo', '5.0.0', '1.0.0', depsOf({ a: '2.0.0' })))
  const before = github.listHits('octo/n-mrepo')
  const result = (await checkUpdates({ force: true }))[view.id]
  assert.ok(github.listHits('octo/n-mrepo') > before)
  assert.equal(result.latest?.release, 'v1.1.0')
})

// ---------------------------------------------------------------- B10：DSH 范围解析不了

test('B10 上游新包的 DSH 范围谁都不满足（>=5.0.0）：检查 400，说出真实原因，不是空指针；什么都不写', async () => {
  const view = await followGithub('octo/n-badrange', envManifest('n-badrange', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish('octo/n-badrange', release('v1.1.0', envManifest('n-badrange', '1.1.0', '>=5.0.0', depsOf({ a: '1.1.0' }))))
  const before = treeDigest(envDir(view.id))
  const { data } = await rejected('/api/environments/update/inspect', { id: view.id }, 'DSH 范围解析不了')
  assert.doesNotMatch(data.error, /Cannot read properties|TypeError/, `不能把空指针报给用户：${data.error}`)
  assert.ok(/没有满足/.test(data.error) && data.error.includes('>=5.0.0'), `要说出是哪个范围没人满足：${data.error}`)
  assert.deepEqual(treeDigest(envDir(view.id)), before)
})

// ---------------------------------------------------------------- B11：过期 token

const staleManifest = (name, version, a) => envManifest(name, version, '1.0.0', depsOf({ a }))

test('B11 状态迁移 过期 token：检查 v1.1.0（token A）→ 又检查并应用了 v1.2.0 → 用 A 应用 400，环境不动（不会悄悄降回 v1.1.0）', async () => {
  const repo = 'octo/n-stale'
  const view = await followGithub(repo, staleManifest('n-stale', '1.0.0', '1.0.0'))
  github.publish(repo, release('v1.1.0', staleManifest('n-stale', '1.1.0', '1.1.0')))
  const a = await inspectUpdate(view.id)
  assert.equal(a.latest?.release, 'v1.1.0')
  github.publish(repo, release('v1.2.0', staleManifest('n-stale', '1.2.0', '1.2.0')))
  await checkUpdates({ force: true })
  const b = await inspectUpdate(view.id)
  assert.equal(b.latest?.release, 'v1.2.0', '前置条件：第二次检查看到 v1.2.0')
  await applyUpdate(b.token)
  const before = { manifest: readFileSync(envFile(view.id), 'utf8'), history: historyFiles(view.id) }
  const { data } = await rejected('/api/environments/update/apply', { token: a.token }, '检查之后换过上游版本的 token')
  assert.match(data.error, /换过上游/, data.error)
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before.manifest, '环境不动')
  assert.deepEqual(historyFiles(view.id), before.history, '不能多存档')
  const after = await envById(view.id)
  assert.equal(after.source?.release, 'v1.2.0')
  assert.equal(pluginsOf(after)[P('a')], '1.2.0')
})

test('B11 状态迁移 过期 token：检查 v1.1.0 → v1.2.0（token A）之后切回了 v1.0.0 的存档 → 用 A 应用 400，环境停在切回的那份', async () => {
  const repo = 'octo/n-stale-restore'
  const view = await followGithub(repo, staleManifest('n-stale-restore', '1.0.0', '1.0.0'))
  github.publish(repo, release('v1.1.0', staleManifest('n-stale-restore', '1.1.0', '1.1.0')))
  const { archived } = await applyUpdate((await inspectUpdate(view.id)).token)
  github.publish(repo, release('v1.2.0', staleManifest('n-stale-restore', '1.2.0', '1.2.0')))
  await checkUpdates({ force: true })
  const a = await inspectUpdate(view.id)
  assert.equal(a.installed?.release, 'v1.1.0', '前置条件：检查时装着 v1.1.0')
  await okPost('/api/environments/history/restore', { id: view.id, name: archived })
  const before = { manifest: readFileSync(envFile(view.id), 'utf8'), history: historyFiles(view.id) }
  const { data } = await rejected('/api/environments/update/apply', { token: a.token }, '切回之后的旧 token')
  assert.match(data.error, /换过上游/, data.error)
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before.manifest)
  assert.deepEqual(historyFiles(view.id), before.history)
  assert.equal((await envById(view.id)).source?.release, 'v1.0.0')
})

test('B11 对照：检查之后只在环境页上加了插件（上游没换）→ token 照样能用，新加的插件跟着重放', async () => {
  const repo = 'octo/n-stale-local'
  const view = await followGithub(repo, staleManifest('n-stale-local', '1.0.0', '1.0.0'))
  github.publish(repo, release('v1.1.0', staleManifest('n-stale-local', '1.1.0', '1.1.0')))
  const a = await inspectUpdate(view.id)
  await okPost('/api/environments/plugins/add', { id: view.id, spec: `${P('g')}@1.0.0` })
  await applyUpdate(a.token)
  const after = await envById(view.id)
  assert.equal(after.source?.release, 'v1.1.0')
  assert.equal(pluginsOf(after)[P('g')], '1.0.0', '检查之后的本地改动也要留着')
  assert.equal(pluginsOf(after)[P('a')], '1.1.0')
})

// ---------------------------------------------------------------- B12：只装环境真正要用的 DSH

test('B12 本地钉了已装的 DSH 1.2.0、上游要没装的 1.5.0：检查报生效版本（1.2.0，已装）；应用不装 1.5.0，没有 npm 也成功', async () => {
  const repo = 'octo/n-pin-dsh'
  const view = await followGithub(repo, envManifest('n-pin-dsh', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  await okPost('/api/environments/update', { id: view.id, dshVersion: '1.2.0' })
  github.publish(repo, release('v1.1.0', envManifest('n-pin-dsh', '1.1.0', '1.5.0', depsOf({ a: '1.1.0' }))))
  const inspected = await inspectUpdate(view.id)
  assert.equal(inspected.dsh?.version, '1.2.0', `dsh 要报环境会用的版本：${JSON.stringify(inspected.dsh)}`)
  assert.equal(inspected.dsh?.installed, true)
  assert.equal(inspected.report.dsh.upstreamTo, '1.5.0', '上游要的版本照样在报告里')
  await applyUpdate(inspected.token)
  const after = await envById(view.id)
  assert.equal(after.dshVersion, '1.2.0')
  assert.equal(readEnvFile(view.id).base.dshVersion, '1.5.0', '上游层照样记新上游的 DSH')
  assert.equal(after.source?.release, 'v1.1.0')
  assert.equal(existsSync(versionBin('1.5.0')), false, '用不上的 DSH 不该装')
})

// ---------------------------------------------------------------- B13：先存档再同步启动项

test('B13 应用顺序：旧清单存不下来（history 位置被一个文件占着）→ 应用失败、启动项仍指着旧版本；腾开之后同一个 token 重试，启动项和存档一起到位', async () => {
  const repo = 'octo/n-order'
  const view = await followGithub(repo, envManifest('n-order', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  const preset = await bindPreset(view.id, '1.0.0')
  github.publish(repo, release('v1.1.0', envManifest('n-order', '1.1.0', '1.1.0', depsOf({ a: '1.1.0' }))))
  const { token } = await inspectUpdate(view.id)
  writeFileSync(historyDir(view.id), '占位：history 不是目录，旧清单必然存不进去\n')
  const before = readFileSync(envFile(view.id), 'utf8')
  const result = await env.call('/api/environments/update/apply', { token })
  // 不变式：启动项指向新版本 ⇒ 一定有存档。这里存档写不进去，启动项就不能被改成新版本
  assert.equal(storedPreset(preset.id).version, '1.0.0', '存档失败时启动项不能已经指着新版本')
  assert.equal(result.status, 400, `存不了旧清单就不能更新（更新后要能切回去）：HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`)
  assert.equal(readFileSync(envFile(view.id), 'utf8'), before, '环境不动')
  rmSync(historyDir(view.id))
  await applyUpdate(token)
  assert.equal(storedPreset(preset.id).version, '1.1.0')
  assert.equal(historyFiles(view.id).length, 1, '启动项换到新版本时存档在')
})

// ---------------------------------------------------------------- B14：切回带回什么、留下什么

test('B14 切回保留现在的名字和说明：更新后经导出改了说明、又改了名 → 切回旧清单，名字 / 说明是现在的，包版本 / 来源回到存档', async () => {
  const repo = 'octo/n-keep'
  const view = await followGithub(repo, envManifest('n-keep', '1.0.0', '1.0.0', depsOf({ a: '1.0.0' })))
  github.publish(repo, release('v1.1.0', envManifest('n-keep', '1.1.0', '1.1.0', depsOf({ a: '1.1.0' }))))
  const { archived } = await applyUpdate((await inspectUpdate(view.id)).token)
  mkdirSync(join(env.root, 'out'), { recursive: true })
  await okPost('/api/environments/export', { target: 'file', id: view.id, version: '1.1.0', description: '导出时写的说明', path: join(env.root, 'out', 'n-keep.dspack') })
  assert.equal(readEnvFile(view.id).description, '导出时写的说明', '前置条件：导出把说明记回了环境')
  await okPost('/api/environments/update', { id: view.id, name: '改名之后的 n-keep' })
  await okPost('/api/environments/history/restore', { id: view.id, name: archived })
  const now = readEnvFile(view.id)
  assert.equal(now.name, '改名之后的 n-keep')
  assert.equal(now.description, '导出时写的说明', '说明不能被存档里的（空）说明冲掉')
  assert.equal(now.packVersion, '1.0.0')
  assert.equal(now.source?.release, 'v1.0.0')
  assert.equal(now.base.dshVersion, '1.0.0')
})

/** 一份存档（字段照环境清单）：直接放进 history/，按名字切回。 */
function writeBackup(id, name, manifest) {
  mkdirSync(historyDir(id), { recursive: true })
  writeFileSync(join(historyDir(id), name), `${JSON.stringify({ schema: 1, id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...manifest }, null, 2)}\n`)
}
const keepSource = (repo, version) => ({ kind: 'github', repo, release: `v${version}`, packVersion: version, following: true })

test('B14 决策表 切回只带回 base / delta / updateChannel / source / files / packVersion；name / description / adoptedFrom 保持现在的', async () => {
  const id = 'n-keep-fields'
  const adoptedNow = [{ home: env.home, profile: 'web', version: '1.0.0' }]
  seedEnvironment(id, {
    name: '现在的名字', description: '现在的说明', adoptedFrom: adoptedNow, updateChannel: 'official',
    base: { dshVersion: '1.0.0', dependencies: depsOf({ a: '1.0.0' }), bundles: [BASE, WEB, P('a')] },
    source: keepSource('octo/n-keep-fields', '1.0.0'), packVersion: '1.0.0',
  })
  // 存档里每个字段都和现在不同：哪些被带回、哪些没被带回，一次看清
  const backup = {
    name: '存档里的名字', description: '存档里的说明', adoptedFrom: [{ home: '/elsewhere/.dsh', profile: 'old', version: '0.9.0' }],
    updateChannel: 'rc', packVersion: '0.9.0',
    base: { dshVersion: '1.1.0', dependencies: depsOf({ a: '0.9.0', b: '1.0.0' }), bundles: [BASE, WEB, P('a'), P('b')] },
    delta: { dshVersion: '', dependencies: depsOf({ g: '1.0.0' }), removed: [P('b')], bundlesAdded: [P('g')], bundlesRemoved: [P('b')] },
    source: keepSource('octo/n-keep-fields', '0.9.0'),
    files: { [P('local')]: { file: 'dsh-x-local-0.9.0.tgz', sha256: 'c'.repeat(64) } },
  }
  const name = '2026-01-01T00-00-00-000Z.json'
  writeBackup(id, name, backup)
  await okPost('/api/environments/history/restore', { id, name })
  const now = readEnvFile(id)
  for (const field of ['base', 'delta', 'source', 'files']) assert.deepEqual(now[field], backup[field], `${field} 要带回存档的`)
  assert.equal(now.updateChannel, 'rc', 'updateChannel 要带回存档的')
  assert.equal(now.packVersion, '0.9.0', 'packVersion 要带回存档的')
  assert.equal(now.name, '现在的名字', '名字保持现在的')
  assert.equal(now.description, '现在的说明', '说明保持现在的')
  assert.deepEqual(now.adoptedFrom, adoptedNow, 'adoptedFrom（迁移记录）保持现在的')
  const view = await envById(id)
  assert.equal(view.dshVersion, '1.1.0')
  assert.deepEqual(pluginsOf(view), depsOf({ a: '0.9.0', g: '1.0.0' }))
})

test('B14 状态迁移 存档要的 DSH 本机没装：先装；装不上 → 400，清单、history、启动项都不动；版本目录有了之后同一个存档切回成功', async () => {
  const id = 'n-restore-dsh'
  seedEnvironment(id, {
    name: '切回要装 DSH',
    base: { dshVersion: '1.0.0', dependencies: depsOf({ a: '1.0.0' }), bundles: [BASE, WEB, P('a')] },
    source: keepSource('octo/n-restore-dsh', '1.0.0'), packVersion: '1.0.0',
  })
  const preset = await bindPreset(id, '1.0.0')
  const name = '2026-01-02T00-00-00-000Z.json'
  // 1.4.0 已发布但 registry 里没有 tarball：不管本机有没有 npm 都装不上
  writeBackup(id, name, {
    name: '切回要装 DSH', base: { dshVersion: '1.4.0', dependencies: depsOf({ a: '0.9.0' }), bundles: [BASE, WEB, P('a')] },
    delta: {}, source: keepSource('octo/n-restore-dsh', '0.9.0'), packVersion: '0.9.0',
  })
  assert.equal(existsSync(versionBin('1.4.0')), false, '前置条件：1.4.0 没装')
  const before = { manifest: readFileSync(envFile(id), 'utf8'), history: historyFiles(id) }
  await rejected('/api/environments/history/restore', { id, name }, '存档要的 DSH 装不上')
  assert.equal(readFileSync(envFile(id), 'utf8'), before.manifest, '装不上就不能切')
  assert.deepEqual(historyFiles(id), before.history, '失败的切回不能留下多余的存档')
  assert.equal(storedPreset(preset.id).version, '1.0.0', '启动项不动')
  env.addVersions(['1.4.0'])
  await okPost('/api/environments/history/restore', { id, name })
  const view = await envById(id)
  assert.equal(view.dshVersion, '1.4.0')
  assert.equal(view.source?.release, 'v0.9.0')
  assert.equal(storedPreset(preset.id).version, '1.4.0', '启动项跟着切回的版本')
})
