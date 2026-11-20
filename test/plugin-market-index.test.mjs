/**
 * 官方插件市场索引解析、缓存检索与 HTTP 接口单测。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const SAMPLE_INDEX = {
  format: 1,
  title: { zh: '官方精选', en: 'Official Market' },
  metadata: {
    categories: {
      docs: { title: { zh: '应用插件', en: 'Apps & Docs' } },
      tools: { title: { zh: '开发者工具', en: 'Developer Tools' } },
    },
  },
  plugins: [
    {
      name: 'dsh-pdf-viewer',
      title: { zh: 'PDF 阅读器', en: 'PDF Viewer' },
      description: { zh: '创建、编辑与审阅 PDF。', en: 'Create and edit PDFs.' },
      icon: './icons/pdf.png',
      author: 'alice',
      metadata: { category: 'docs', keywords: ['pdf'], labels: [], sortKeys: {} },
      versions: [
        { version: '1.1.0-rc.1', publishTimestamp: 200, source: { type: 'npm' }, engines: {} },
        { version: '1.0.2', publishTimestamp: 100, source: { type: 'npm' }, engines: {} },
      ],
    },
    {
      name: '@acme/dsh-git-helper',
      title: 'GitHub Helper',
      description: { zh: 'GitHub 工作流工具。', en: 'GitHub workflow integration.' },
      author: 'bob',
      metadata: { category: 'tools', keywords: ['github'], labels: [], sortKeys: {} },
      versions: [
        {
          version: '0.3.0',
          publishTimestamp: 150,
          source: { type: 'git', url: 'https://github.com/acme/dsh-git-helper', commit: '0123456789abcdef0123456789abcdef01234567', path: 'packages/plugin' },
          engines: {},
        },
      ],
    },
  ],
}

test('GET /api/plugin-market 对接 GitHub 精选清单、桌面增强与可选索引源', async (t) => {
  const curatedRaw = readFileSync(new URL('../docs/curated-plugins.json', import.meta.url), 'utf8')
  let indexHits = 0
  let curatedHits = 0
  const indexServer = createServer((req, res) => {
    if (req.url === '/curated-plugins.json') {
      curatedHits += 1
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(curatedRaw)
      return
    }
    indexHits += 1
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(SAMPLE_INDEX))
  })
  await new Promise((resolve) => indexServer.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${indexServer.address().port}`
  const indexUrl = `${origin}/index.json`
  const prevCuratedUrl = process.env.DSH_X_CURATED_PLUGINS_URL
  process.env.DSH_X_CURATED_PLUGINS_URL = `${origin}/curated-plugins.json`

  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-market-api-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: data,
    dshHome: home,
    profile: 'web',
    seedMarket: false,
    pluginMarketSources: [indexUrl],
  }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')

  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    if (prevCuratedUrl === undefined) delete process.env.DSH_X_CURATED_PLUGINS_URL
    else process.env.DSH_X_CURATED_PLUGINS_URL = prevCuratedUrl
    await server.stopAll()
    await new Promise((resolve) => indexServer.close(resolve))
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const curatedRes = await fetch(`${base}/api/plugin-market?scope=curated`)
  assert.equal(curatedRes.status, 200)
  const curatedBody = await curatedRes.json()
  assert.equal(indexHits, 0, 'scope=curated 不拉取外部插件市场全量索引')
  assert.equal(curatedHits, 1, '从 GitHub 清单地址拉取精选列表')
  assert.equal(curatedBody.curatedSource, 'github')
  assert.deepEqual(
    curatedBody.desktopEnhance.map((item) => item.name),
    ['dsh-x-desktop-notify', 'dsh-x-sidebar-browser', 'dsh-x-computer-use'],
  )
  assert.ok(Array.isArray(curatedBody.curated) && curatedBody.curated.length >= 40)
  assert.ok(Array.isArray(curatedBody.curatedCategories) && curatedBody.curatedCategories.length === 7)

  const res = await fetch(`${base}/api/plugin-market?q=pdf`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.activeUrl, indexUrl)
  assert.equal(body.total, 1)
  assert.equal(body.entries[0].name, 'dsh-pdf-viewer')
})

test('GitHub 精选清单解析、远程缓存、失败回落磁盘缓存与静态清单校验', async () => {
  const { CURATED_PLUGINS_URL, createCuratedPluginsClient, parseCuratedPluginsManifest } = await import('../src/curated-plugins.js')
  const { safePluginName } = await import('../src/environments.js')
  assert.match(CURATED_PLUGINS_URL, /^https:\/\/raw\.githubusercontent\.com\/yyh-001\/DSH-X\/Staging\/docs\/curated-plugins\.json$/, '精选清单要走真实存在的默认分支 Staging（指 main 会一直 404）')

  const rawManifest = JSON.parse(readFileSync(new URL('../docs/curated-plugins.json', import.meta.url), 'utf8'))
  const parsed = parseCuratedPluginsManifest(rawManifest)
  const categoryIds = new Set(parsed.categories.map((item) => item.id))
  const seen = new Set()
  assert.equal(parsed.plugins.length, rawManifest.plugins.length)
  for (const item of parsed.plugins) {
    assert.equal(safePluginName(item.name), item.name)
    assert.ok(categoryIds.has(item.category), `${item.name} 的分类 ${item.category} 有效`)
    assert.ok(item.installSpec && item.description)
    assert.equal(seen.has(item.name), false, `${item.name} 不重复`)
    seen.add(item.name)
  }
  for (const removed of ['dsh-ego-browser', 'dsh-computer-use-pro', 'dsh-skill-mcp-panel']) {
    assert.equal(seen.has(removed), false, `${removed} 已从精选清单移除`)
  }
  const filtered = parseCuratedPluginsManifest({
    categories: [{ id: 'manage', zh: '管理', tone: 'blue' }],
    plugins: [
      { name: 'dshmarket', category: 'manage', installSpec: 'dshmarket' },
      { name: 'dsh-ego-browser', category: 'manage', installSpec: 'dsh-ego-browser' },
      { name: 'dsh-computer-use-pro', category: 'manage', installSpec: 'dsh-computer-use-pro' },
      { name: 'dsh-skill-mcp-panel', category: 'manage', installSpec: 'dsh-skill-mcp-panel' },
    ],
  })
  assert.deepEqual(filtered.plugins.map((item) => item.name), ['dshmarket'])

  const root = mkdtempSync(join(tmpdir(), 'dsh-curated-cache-'))
  try {
    const cacheFile = join(root, 'curated-cache.json')
    let shouldFail = false
    let fetches = 0
    const sample = {
      version: 1,
      updatedAt: '2026-11-18',
      categories: [{ id: 'manage', zh: '管理', tone: 'blue' }],
      plugins: [
        { name: 'dshmarket', title: '市场', description: 'desc', category: 'manage', installSpec: 'dshmarket' },
        { name: 'bad name with spaces', title: '坏包名', description: 'skip', category: 'manage' },
      ],
    }
    const client = createCuratedPluginsClient({
      url: 'https://example.invalid/curated.json',
      cacheFile,
      fallbackFile: '',
      ttlMs: 60_000,
      fetchFn: async () => {
        fetches += 1
        if (shouldFail) throw new Error('network down')
        return new Response(JSON.stringify(sample), { status: 200 })
      },
    })
    const live = await client.load()
    assert.equal(live.curatedSource, 'github')
    assert.equal(live.curated.length, 1, '非法包名被自动过滤')
    assert.equal(fetches, 1)

    await client.load()
    assert.equal(fetches, 1, 'TTL 内命中内存缓存')

    shouldFail = true
    const staleClient = createCuratedPluginsClient({
      url: 'https://example.invalid/curated.json',
      cacheFile,
      fallbackFile: '',
      fetchFn: async () => { throw new Error('network down') },
    })
    const fromDisk = await staleClient.load({ refresh: true })
    assert.equal(fromDisk.curatedSource, 'cache', '远端失败时回退到上次落盘的 GitHub 缓存')
    assert.equal(fromDisk.curated[0].name, 'dshmarket')
    assert.match(fromDisk.curatedError, /network down/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const curatedModuleSrc = readFileSync(new URL('../src/curated-plugins.js', import.meta.url), 'utf8')
  assert.doesNotMatch(curatedModuleSrc, /CURATED_PLUGINS\s*=/, '精选清单不再写死在 JS 源码里')
  const packCommon = readFileSync(new URL('../scripts/pack-common.mjs', import.meta.url), 'utf8')
  assert.match(packCommon, /'curated-plugins\.js'/)
})

test('format-1 插件市场索引解析、图标绝对化、作者 GitHub 头像兜底、安装坐标生成与检索', async () => {
  const { extractGitHubOwner, extractGitHubOwnerFromUrl, githubAvatarUrl, marketInstallSpec, parsePluginMarketIndex, searchPluginMarketIndex } = await import('../src/plugin-market.js')
  const parsed = parsePluginMarketIndex(SAMPLE_INDEX, 'https://awesome-dsh-plugin.com/index.json')
  assert.equal(parsed.plugins.length, 2)
  assert.equal(parsed.plugins[0].icon, 'https://awesome-dsh-plugin.com/icons/pdf.png', '显式 icon 优先保留')
  assert.equal(parsed.plugins[1].icon, 'https://avatars.githubusercontent.com/acme?s=96', '缺省 icon 时回落到 GitHub 作者头像')
  assert.equal(extractGitHubOwnerFromUrl('git@github.com:01Virex/dsh-status-rotator.git'), '01Virex')
  assert.equal(extractGitHubOwnerFromUrl('https://awesome-dsh-plugin.com/p/0-0-user/dsh-plan-note/'), '0-0-user')
  assert.equal(extractGitHubOwner({ repository: { url: 'https://github.com/ranxianglei/billion-context' } }), 'ranxianglei')
  assert.equal(extractGitHubOwner({ title: '030611/dsh-telemetry-redactor' }), '030611')
  assert.equal(githubAvatarUrl('helloHub1212'), 'https://avatars.githubusercontent.com/helloHub1212?s=96')
  assert.equal(githubAvatarUrl('not valid/user'), '')
  // 默认版本优先挑稳定版而非预发布
  assert.equal(parsed.plugins[0].installSpec, 'dsh-pdf-viewer@1.0.2')
  assert.equal(
    parsed.plugins[1].installSpec,
    '@acme/dsh-git-helper@git+https://github.com/acme/dsh-git-helper.git#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin',
  )
  assert.equal(
    marketInstallSpec('plain', { version: '2.0.0', source: { type: 'npm' } }),
    'plain@2.0.0',
  )

  const byCat = searchPluginMarketIndex(parsed, { category: 'tools', lang: 'zh' })
  assert.equal(byCat.total, 1)
  assert.equal(byCat.entries[0].name, '@acme/dsh-git-helper')

  const byQuery = searchPluginMarketIndex(parsed, { q: 'github', lang: 'en' })
  assert.equal(byQuery.total, 1)
  assert.equal(byQuery.entries[0].description, 'GitHub workflow integration.')
})

test('createPluginMarketClient 缓存检索且打包清单包含 plugin-market.js', async () => {
  const { createPluginMarketClient } = await import('../src/plugin-market.js')
  let fetches = 0
  const client = createPluginMarketClient({
    fetch: async () => {
      fetches += 1
      return new Response(JSON.stringify(SAMPLE_INDEX), { status: 200 })
    },
  })
  const first = await client.query(['https://awesome-dsh-plugin.com/index.json'], { q: 'pdf' })
  assert.equal(first.error, '')
  assert.equal(first.total, 1)
  assert.equal(first.entries[0].title, 'PDF 阅读器')
  await client.query(['https://awesome-dsh-plugin.com/index.json'], { q: 'github' })
  assert.equal(fetches, 1, '同一索引源命中内存缓存')
  await client.query(['https://awesome-dsh-plugin.com/index.json'], { refresh: true })
  assert.equal(fetches, 2, 'refresh=true 强制重新拉取')

  // 并发去重：同一地址同时发起多次 query 时共享同一次网络拉取
  let releaseConcurrent
  let concurrentFetches = 0
  const concurrentClient = createPluginMarketClient({
    fetch: () => {
      concurrentFetches += 1
      return new Promise((resolve) => {
        releaseConcurrent = () => resolve(new Response(JSON.stringify(SAMPLE_INDEX), { status: 200 }))
      })
    },
  })
  const p1 = concurrentClient.query(['https://awesome-dsh-plugin.com/index.json'], { q: 'pdf' })
  const p2 = concurrentClient.query(['https://awesome-dsh-plugin.com/index.json'], { q: 'github' })
  assert.equal(concurrentFetches, 1, '并发请求同一索引源时只发起 1 次底层 fetch')
  releaseConcurrent()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.total, 1)
  assert.equal(r2.total, 1)

  // 中止/超时错误转为明确中文提示（有缓存时优先回落旧缓存）
  const abortClient = createPluginMarketClient({
    fetch: async () => { throw new Error('aborted') },
  })
  const abortedRes = await abortClient.query(['https://awesome-dsh-plugin.com/index.json'])
  assert.match(abortedRes.error, /超时.*刷新重试/)
  assert.doesNotMatch(abortedRes.error, /^aborted$/)

  const packCommon = readFileSync(new URL('../scripts/pack-common.mjs', import.meta.url), 'utf8')
  assert.match(packCommon, /'plugin-market\.js'/)
})

test('curatedUrlCandidates 与 createCuratedPluginsClient 支持多镜像优先/直连失败回退', async () => {
  const { CURATED_PLUGINS_URL, createCuratedPluginsClient, curatedUrlCandidates } = await import('../src/curated-plugins.js')
  const expectedDirect = CURATED_PLUGINS_URL
  const expectedJsdelivrFastly = 'https://fastly.jsdelivr.net/gh/yyh-001/DSH-X@Staging/docs/curated-plugins.json'
  const expectedJsdelivrCdn = 'https://cdn.jsdelivr.net/gh/yyh-001/DSH-X@Staging/docs/curated-plugins.json'

  const mirrorFirst = curatedUrlCandidates(expectedDirect, 'mirror')
  assert.deepEqual(mirrorFirst, [
    `https://gh-proxy.com/${expectedDirect}`,
    `https://ghfast.top/${expectedDirect}`,
    expectedJsdelivrFastly,
    expectedJsdelivrCdn,
    expectedDirect,
  ])

  const directFirst = curatedUrlCandidates(expectedDirect, 'direct')
  assert.deepEqual(directFirst, [
    expectedDirect,
    `https://gh-proxy.com/${expectedDirect}`,
    `https://ghfast.top/${expectedDirect}`,
    expectedJsdelivrFastly,
    expectedJsdelivrCdn,
  ])

  assert.deepEqual(
    curatedUrlCandidates('http://127.0.0.1:8080/curated.json', 'mirror'),
    ['http://127.0.0.1:8080/curated.json'],
    '非 GitHub 地址不套镜像前缀',
  )

  const sample = {
    version: 1,
    updatedAt: '2026-11-20',
    categories: [{ id: 'manage', zh: '管理', tone: 'blue' }],
    plugins: [
      { name: 'dshmarket', title: '市场', description: 'desc', category: 'manage', installSpec: 'dshmarket' },
    ],
  }

  // 1) 直连模式下 raw.githubusercontent.com 不可达，自动回退到镜像并写缓存、命中 TTL
  const root = mkdtempSync(join(tmpdir(), 'dsh-curated-mirror-'))
  try {
    const cacheFile = join(root, 'curated-cache.json')
    const triedDirect = []
    let nowMs = 1000
    const directClient = createCuratedPluginsClient({
      url: expectedDirect,
      getUpdateSource: () => 'direct',
      cacheFile,
      fallbackFile: '',
      ttlMs: 60_000,
      now: () => nowMs,
      fetchFn: async (candidate) => {
        triedDirect.push(candidate)
        if (candidate === expectedDirect) throw new Error('direct blocked')
        return new Response(JSON.stringify(sample), { status: 200 })
      },
    })
    const directFallback = await directClient.load()
    assert.deepEqual(triedDirect, [expectedDirect, `https://gh-proxy.com/${expectedDirect}`])
    assert.equal(directFallback.curatedSource, 'mirror')
    assert.equal(directFallback.curatedUrl, `https://gh-proxy.com/${expectedDirect}`)
    assert.equal(directFallback.curatedError, '')
    assert.equal(directFallback.curated.length, 1)
    assert.ok(readFileSync(cacheFile, 'utf8').includes('dshmarket'), '镜像拉取成功后写入磁盘缓存')

    // TTL 内走内存缓存且保留镜像 source/url
    const ttlHit = await directClient.load()
    assert.equal(triedDirect.length, 2, 'TTL 内不重复发起网络请求')
    assert.equal(ttlHit.curatedSource, 'mirror')
    assert.equal(ttlHit.curatedUrl, `https://gh-proxy.com/${expectedDirect}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // 2) 镜像优先模式下，前序镜像 502 时顺延到 jsDelivr 成功，不打 raw.githubusercontent.com；
  //    所有镜像均失败时再回退到直连 GitHub
  const triedMirror = []
  let failAllMirrors = false
  const mirrorClient = createCuratedPluginsClient({
    url: expectedDirect,
    getUpdateSource: () => 'mirror',
    fallbackFile: '',
    fetchFn: async (candidate) => {
      triedMirror.push(candidate)
      if (!failAllMirrors) {
        if (candidate === expectedJsdelivrFastly) {
          return new Response(JSON.stringify(sample), { status: 200 })
        }
        return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
      }
      if (candidate === expectedDirect) {
        return new Response(JSON.stringify(sample), { status: 200 })
      }
      throw new Error('mirror unreachable')
    },
  })
  const viaJsdelivr = await mirrorClient.load()
  assert.deepEqual(triedMirror, [
    `https://gh-proxy.com/${expectedDirect}`,
    `https://ghfast.top/${expectedDirect}`,
    expectedJsdelivrFastly,
  ])
  assert.equal(triedMirror.includes(expectedDirect), false, '镜像成功时不触发直连 GitHub')
  assert.equal(viaJsdelivr.curatedSource, 'mirror')
  assert.equal(viaJsdelivr.curatedUrl, expectedJsdelivrFastly)

  triedMirror.length = 0
  failAllMirrors = true
  const fallbackDirect = await mirrorClient.load({ refresh: true })
  assert.deepEqual(triedMirror, mirrorFirst)
  assert.equal(fallbackDirect.curatedSource, 'github')
  assert.equal(fallbackDirect.curatedUrl, expectedDirect)
})
