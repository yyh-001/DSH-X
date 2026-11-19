import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { listPlugins, readPluginPackageMeta } from '../src/plugins.js'
import { isolateUserHome } from './isolated-home.mjs'

test('readPluginPackageMeta / listPlugins：读取 package.json icon 与 exports["./icon"] 并校验安全边界', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-icons-'))
  try {
    writeFileSync(join(root, 'outside.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // 1. manifest.icon 优先于 exports['./icon']
    const pkgField = join(root, 'pkg-field')
    mkdirSync(pkgField, { recursive: true })
    writeFileSync(join(pkgField, 'logo.png'), Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(pkgField, 'alt.svg'), '<svg/>')
    writeFileSync(join(pkgField, 'package.json'), JSON.stringify({
      name: 'demo-field',
      version: '1.0.0',
      description: 'Field icon plugin',
      icon: './logo.png',
      exports: { './icon': './alt.svg' },
    }))
    const metaField = readPluginPackageMeta(pkgField, 'zh')
    assert.equal(metaField.icon, `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`)
    assert.equal(metaField.title, '')
    assert.equal(metaField.description, 'Field icon plugin')

    // 2. exports['./icon']（对象条件导出 + SVG）
    const pkgExport = join(root, 'pkg-export')
    mkdirSync(pkgExport, { recursive: true })
    writeFileSync(join(pkgExport, 'icon.svg'), '<svg viewBox="0 0 24 24"></svg>')
    writeFileSync(join(pkgExport, 'package.json'), JSON.stringify({
      name: 'demo-export',
      version: '2.0.0',
      meta: { title: 'Volc Ark', description: 'SVG icon' },
      exports: { '.': './index.js', './icon': { default: './icon.svg' } },
    }))
    const metaExport = readPluginPackageMeta(pkgExport, 'zh')
    assert.match(metaExport.icon, /^data:image\/svg\+xml;base64,/)
    assert.equal(metaExport.title, 'Volc Ark')

    // 3. 安全校验：越界路径、绝对路径、URL、非法扩展名、超 256 KiB 都静默降级为无图标且保留文案
    const pkgBad = join(root, 'pkg-bad')
    mkdirSync(pkgBad, { recursive: true })
    writeFileSync(join(pkgBad, 'huge.webp'), Buffer.alloc(256 * 1024 + 1, 7))
    writeFileSync(join(pkgBad, 'note.txt'), 'not an image')
    for (const badIcon of ['../outside.png', root, 'https://example.com/a.png', './note.txt', './huge.webp']) {
      writeFileSync(join(pkgBad, 'package.json'), JSON.stringify({
        name: 'demo-bad',
        version: '0.1.0',
        description: 'Still readable',
        icon: badIcon,
      }))
      const metaBad = readPluginPackageMeta(pkgBad, 'zh')
      assert.equal(metaBad.icon, '', `非法图标 ${badIcon} 应被拦截`)
      assert.equal(metaBad.description, 'Still readable', '图标无效时仍保留文字元数据')
    }

    // 4. listPlugins 返回真实 icon
    const profileDir = join(root, 'profile')
    mkdirSync(join(profileDir, 'node_modules', 'demo-real'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'demo-real': '1.0.0' },
      dsh: { profile: { bundles: ['demo-real'] } },
    }))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(profileDir, 'node_modules', 'demo-real', 'icon.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    writeFileSync(join(profileDir, 'node_modules', 'demo-real', 'package.json'), JSON.stringify({
      name: 'demo-real',
      version: '1.0.0',
      icon: 'icon.jpg',
    }))
    const listed = listPlugins(profileDir)
    assert.equal(listed.plugins[0].name, 'demo-real')
    assert.match(listed.plugins[0].icon, /^data:image\/jpeg;base64,/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('服务端接口：/api/environments 返回本地真实图标，/api/plugin-market 命中后为缺少本地图标的插件补齐 marketIcons', async (t) => {
  const curatedRaw = readFileSync(new URL('../docs/curated-plugins.json', import.meta.url), 'utf8')
  let indexHits = 0
  const srv = createServer((req, res) => {
    if (req.url === '/curated.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(curatedRaw)
      return
    }
    indexHits += 1
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      format: 1,
      title: 'Market',
      metadata: { categories: { ext: { title: 'Ext' } } },
      plugins: [
        {
          name: 'remote-only-icon-plugin',
          title: 'Remote Only',
          description: 'Has icon in market',
          icon: './assets/remote.png',
          metadata: { category: 'ext', keywords: [], labels: [], sortKeys: {} },
          versions: [{ version: '0.5.0', publishTimestamp: 100, source: { type: 'npm' }, engines: {} }],
        },
        {
          name: 'local-icon-plugin',
          title: 'Local Wins',
          description: 'Should keep local icon',
          icon: './assets/market-fallback.png',
          metadata: { category: 'ext', keywords: [], labels: [], sortKeys: {} },
          versions: [{ version: '0.1.0', publishTimestamp: 100, source: { type: 'npm' }, engines: {} }],
        },
      ],
    }))
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${srv.address().port}`
  const indexUrl = `${origin}/market/index.json`
  const prevEnv = {
    DSH_X_CURATED_PLUGINS_URL: process.env.DSH_X_CURATED_PLUGINS_URL,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PORT: process.env.PORT,
    DSH_VERSIONS_DATA: process.env.DSH_VERSIONS_DATA,
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME,
  }
  process.env.DSH_X_CURATED_PLUGINS_URL = `${origin}/curated.json`

  const root = mkdtempSync(join(tmpdir(), 'dsh-env-icons-api-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const profileDir = join(home, 'profiles', 'web')
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  mkdirSync(app, { recursive: true })
  const localPluginDir = join(root, 'local-icon-plugin')
  mkdirSync(localPluginDir, { recursive: true })
  writeFileSync(join(localPluginDir, 'icon.svg'), '<svg viewBox="0 0 8 8"></svg>')
  writeFileSync(join(localPluginDir, 'package.json'), JSON.stringify({
    name: 'local-icon-plugin',
    version: '0.1.0',
    exports: { './icon': './icon.svg' },
  }))
  mkdirSync(join(profileDir, 'node_modules', 'remote-only-icon-plugin'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'remote-only-icon-plugin': '0.5.0' },
    dsh: { profile: { bundles: ['remote-only-icon-plugin'] } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profileDir, 'node_modules', 'remote-only-icon-plugin', 'package.json'), JSON.stringify({
    name: 'remote-only-icon-plugin',
    version: '0.5.0',
    description: 'No local icon file',
  }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: data,
    dshHome: home,
    profile: 'web',
    seedMarket: false,
    pluginMarketSources: [indexUrl],
  }))
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')

  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await server.stopAll()
    await new Promise((resolve) => srv.close(resolve))
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const postJson = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(res.status, 200)
    return res.json()
  }
  const created = await postJson('/api/environments/create', { name: 'icon-test-env' })
  const envId = created.environment.id
  await postJson('/api/environments/plugins/add', { id: envId, spec: `local-icon-plugin@file:${localPluginDir}` })
  await postJson('/api/environments/plugins/add', { id: envId, spec: 'remote-only-icon-plugin@0.5.0' })

  // 未拉索引前：local-icon-plugin 有本地 data:image 图标，scope=curated 不触发索引请求
  const envBefore = await (await fetch(`${base}/api/environments`)).json()
  const webBefore = envBefore.environments.find((item) => item.id === envId)
  const localBefore = webBefore.plugins.find((item) => item.name === 'local-icon-plugin')
  assert.match(localBefore.icon, /^data:image\/svg\+xml;base64,/)
  const remoteBefore = webBefore.plugins.find((item) => item.name === 'remote-only-icon-plugin')
  assert.equal(remoteBefore.icon, undefined)

  const curatedOnly = await (await fetch(`${base}/api/plugin-market?scope=curated`)).json()
  assert.equal(indexHits, 0)
  assert.deepEqual(curatedOnly.marketIcons, {})

  // 拉取全量市场索引后，scope=curated 与 /api/environments 都能拿到缓存的市场图标，且本地图标优先
  const marketRes = await (await fetch(`${base}/api/plugin-market`)).json()
  assert.equal(indexHits, 1)
  assert.equal(marketRes.marketIcons['remote-only-icon-plugin'], `${origin}/market/assets/remote.png`)

  const envAfter = await (await fetch(`${base}/api/environments`)).json()
  const webAfter = envAfter.environments.find((item) => item.id === envId)
  assert.match(webAfter.plugins.find((item) => item.name === 'local-icon-plugin').icon, /^data:image\/svg\+xml;base64,/, '本地真实图标优先于市场图标')
  assert.equal(webAfter.plugins.find((item) => item.name === 'remote-only-icon-plugin').icon, `${origin}/market/assets/remote.png`, '无本地图标时使用市场缓存的真实图标')
})

test('createPluginMarketClient：分页时也返回全量 marketIcons 且 cachedIcons 不发请求', async () => {
  const { createPluginMarketClient } = await import('../src/plugin-market.js')
  let fetches = 0
  const index = {
    format: 1,
    title: 'Market',
    metadata: { categories: { ext: { title: '扩展' } } },
    plugins: [
      {
        name: 'plugin-one',
        title: 'One',
        description: 'First',
        icon: './icons/one.png',
        metadata: { category: 'ext', keywords: [], labels: [], sortKeys: {} },
        versions: [{ version: '1.0.0', publishTimestamp: 100, source: { type: 'npm' }, engines: {} }],
      },
      {
        name: 'plugin-two',
        title: 'Two',
        description: 'Second',
        icon: 'https://cdn.example.com/two.svg',
        metadata: { category: 'ext', keywords: [], labels: [], sortKeys: {} },
        versions: [{ version: '1.2.0', publishTimestamp: 200, source: { type: 'npm' }, engines: {} }],
      },
    ],
  }
  const client = createPluginMarketClient({
    fetch: async () => {
      fetches += 1
      return new Response(JSON.stringify(index), { status: 200 })
    },
  })
  const source = 'https://market.example.com/nested/index.json'
  assert.deepEqual(client.cachedIcons([source]), {})

  const page1 = await client.query([source], { limit: 1, offset: 0 })
  assert.equal(fetches, 1)
  assert.equal(page1.entries.length, 1, 'entries 按 limit=1 分页')
  assert.deepEqual(page1.marketIcons, {
    'plugin-one': 'https://market.example.com/nested/icons/one.png',
    'plugin-two': 'https://cdn.example.com/two.svg',
  }, 'marketIcons 包含索引内全部插件的真实图标')

  assert.deepEqual(client.cachedIcons([source]), page1.marketIcons)
  assert.equal(fetches, 1, 'cachedIcons 不额外触发请求')
})

test('实例详情页：4 签切换（配置签）、已安装/市场子签切换、市场风格卡片图标及图片失败兜底', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const envJs = readFileSync(new URL('../src/public/environments-page.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

  const elements = new Map()
  const listenerMap = new Map()
  function node(id = '', tag = 'div') {
    const attrs = new Map()
    const classes = new Set()
    let children = []
    const item = {
      id,
      tagName: tag.toUpperCase(),
      value: '',
      hidden: false,
      disabled: false,
      checked: false,
      innerHTML: '',
      textContent: '',
      scrollTop: 0,
      maxLength: 0,
      options: [],
      dataset: {},
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
        toggle: (n, force = !classes.has(n)) => { force ? classes.add(n) : classes.delete(n); return force },
      },
      setAttribute(name, value) { attrs.set(name, String(value)) },
      getAttribute(name) { return attrs.get(name) ?? null },
      addEventListener(type, fn, capture = false) {
        if (!listenerMap.has(item)) listenerMap.set(item, [])
        listenerMap.get(item).push({ type, fn, capture })
      },
      dispatch(type, extra = {}) {
        const event = { type, target: item, preventDefault() {}, ...extra }
        for (const entry of listenerMap.get(item) || []) {
          if (entry.type === type) entry.fn(event)
        }
      },
      focus() {},
      contains: () => false,
      closest: () => null,
      append() {},
      querySelector: () => null,
      querySelectorAll(selector) {
        if (item === elements.get('environmentTabs') && selector === '[data-env-tab]') return children
        if (item === elements.get('environmentPluginSubtabs') && selector === '[data-plugin-subtab]') return children
        return []
      },
      _setChildren(list) { children = list },
    }
    return item
  }
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, node(id))
    return elements.get(id)
  }

  // 构建 4 个主签、2 个子签与必需控件节点
  const tabButtons = ['plugins', 'mcp', 'skills', 'config'].map((key) => {
    const b = node('', 'button')
    b.dataset.envTab = key
    return b
  })
  byId('environmentTabs')._setChildren(tabButtons)
  const subtabButtons = ['installed', 'curated', 'market'].map((key) => {
    const b = node('', 'button')
    b.dataset.pluginSubtab = key
    return b
  })
  byId('environmentPluginSubtabs')._setChildren(subtabButtons)
  byId('environmentPluginsBox')
  byId('environmentInstalledPane')
  byId('environmentMarketPane').hidden = true
  byId('environmentMarketTools').hidden = true
  byId('environmentConfigBox').hidden = true
  byId('environmentMcpHost').hidden = true
  byId('environmentSkillsHost').hidden = true
  byId('environmentAddDialog').hidden = true
  let searchFocusCount = 0
  byId('environmentAddSearch').focus = () => { searchFocusCount += 1 }
  byId('environmentAddMarket')

  const syncCalls = []
  const getCalls = []
  const postCalls = []
  const envList = [{
    id: 'env-web',
    name: 'web',
    dshVersion: 'auto',
    updateChannel: 'alpha',
    following: false,
    source: null,
    plugins: [
      { name: 'dsh-meme', spec: '0.1.85', enabled: true, official: false, icon: 'data:image/jpeg;base64,AAAA', description: 'Meme plugin' },
      { name: 'dsh-remote', spec: '1.0.0', enabled: true, official: false, description: 'Uses market icon' },
      { name: 'dsh-llm-retry-settings', spec: '0.1.19', enabled: true, official: false, description: 'Curated lucide fallback' },
      { name: 'custom-unknown-plugin', spec: '0.0.1', enabled: false, official: false, description: 'Deterministic color fallback' },
    ],
    usedBy: [{ id: 'a', name: 'DSH' }],
    applied: [{ profile: 'web', home: '/home' }],
    history: [],
    targetProfile: 'web',
    targetHome: '/home',
  }]

  const doc = {
    getElementById: byId,
    querySelector: () => null,
    activeElement: null,
    documentElement: { classList: { contains: () => false } },
  }
  const context = vm.createContext({
    document: doc,
    window: null,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    AUTO_VERSION: 'auto',
    UPDATE_CHANNELS: ['official', 'rc', 'alpha'],
    UPDATE_CHANNEL_NAMES: { official: '正式版', rc: '预览版', alpha: '测试版' },
    t: (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    notify() {},
    appConfirm: async () => true,
    installedList: () => ['0.2.2-rc.4'],
    switchChannel: () => 'alpha',
    paintChannelSwitch() {},
    openVersionManager() {},
    recommendedVersion: () => '0.2.2-rc.4',
    paintCompatibilityResult() {},
    paintLaunchVersionGroup() {},
    setLaunchVersion() {},
    launchChannel: () => 'alpha',
    createUiSelect() {},
    syncUiSelect() {},
    showPackDialog(dialog) { if (dialog) dialog.hidden = false },
    hidePackDialog: async (dialog) => { if (dialog) dialog.hidden = true; return true },
    trapPackDialog() {},
    openImportDialog() {},
    openExportDialog() {},
    packNotes: () => '',
    gridCardHtml: () => '',
    packMoreIcons: { copy: '', export: '', trash: '' },
    paneLoaders: {},
    environmentState: { pendingOpen: 'env-web', list: [], defaults: {} },
    globalThis: null,
    syncEnvironmentToolTab: (tab, env, subTab) => { syncCalls.push({ tab, envId: env?.id || '', subTab }) },
    async getJson(url) {
      getCalls.push(url)
      if (url.startsWith('/api/plugin-market')) {
        if (url.includes('scope=curated')) {
          return {
            curatedCategories: [{ id: 'perf', zh: '性能与效率', tone: 'indigo', icon: 'lucide-rocket' }],
            curated: [{ name: 'dsh-llm-retry-settings', title: 'dsh-llm-retry-settings', category: 'perf', icon: 'lucide-refresh-cw', description: 'Retry' }],
            desktopEnhance: [],
            marketIcons: {},
          }
        }
        return {
          sources: [{ url: 'https://awesome-dsh-plugin.com/index.json', title: 'Awesome DSH' }],
          activeUrl: 'https://awesome-dsh-plugin.com/index.json',
          categories: [{ id: 'ext', title: 'Extensions', count: 1 }],
          entries: [{ name: 'dsh-remote', title: 'DSH Remote', author: 'alice', version: '1.0.0', installSpec: 'dsh-remote@1.0.0', icon: 'https://cdn.example/remote.png', description: 'Remote icon entry' }],
          marketIcons: { 'dsh-remote': 'https://cdn.example/remote.png' },
          total: 1,
          nextOffset: null,
        }
      }
      return { environments: envList, builtin: [], limits: { nameMax: 32 }, defaults: {} }
    },
    async post(url, payload) {
      postCalls.push({ url, payload: structuredClone(payload) })
      if (url === '/api/environments/plugins/add') {
        envList[0].plugins.push({ name: 'added-plugin', spec: '1.0.0', enabled: true, official: false })
      }
      return {}
    },
  })
  context.window = context
  context.globalThis = context

  // 验证 HTML 里没有 syntax error 且挂载 environments-page.js 成功
  assert.doesNotThrow(() => {
    new vm.Script(html.match(/<script>\s*([\s\S]*?)\s*<\/script>/g).map((s) => s.replace(/^<script>|<\/script>$/g, '')).join('\n'))
  })
  vm.runInContext(envJs, context)

  await context.paneLoaders.environments()
  await new Promise((resolve) => setTimeout(resolve, 25))

  // 初始状态：在 插件 -> 已安装，计数为 4，市场工具栏藏着，配置盒子藏着
  assert.equal(byId('environmentInstalledCount').textContent, '4')
  assert.equal(byId('environmentPluginsBox').hidden, false)
  assert.equal(byId('environmentInstalledPane').hidden, false)
  assert.equal(byId('environmentMarketPane').hidden, true)
  assert.equal(byId('environmentMarketTools').hidden, true)
  assert.equal(byId('environmentConfigBox').hidden, true)

  const installedHtml = byId('environmentPluginList').innerHTML
  assert.match(installedHtml, /plugin-market-card plugin-installed-card/)
  assert.match(installedHtml, /plugin-installed-head/)
  assert.match(installedHtml, /plugin-installed-desc/)
  assert.match(installedHtml, /src="data:image\/jpeg;base64,AAAA"/, '本地插件图标显示 img')
  assert.match(installedHtml, /src="https:\/\/cdn\.example\/remote\.png"/, '已安装插件同步拿到市场索引真实图标')
  assert.match(installedHtml, /class="plugin-market-icon tone-indigo"><svg[^>]*><use href="\/icons\.svg#lucide-refresh-cw"\/><\/svg>/, '无图片时使用精选清单图标与分类色系')
  assert.match(installedHtml, /class="plugin-market-icon tone-(?:blue|indigo|cyan|purple|emerald|amber|pink)"><svg[^>]*><use href="\/icons\.svg#lucide-package"\/><\/svg>/, '未知插件退回确定性色系默认图标')

  // 验证图片加载失败兜底监听器
  const iconFrame = node()
  iconFrame.classList.add('plugin-market-icon', 'has-image')
  const brokenImg = node('', 'img')
  brokenImg.dataset.fallbackIcon = 'lucide-globe'
  brokenImg.dataset.fallbackTone = 'cyan'
  brokenImg.parentElement = iconFrame
  const errListeners = listenerMap.get(byId('environmentPluginList')).filter((l) => l.type === 'error' && l.capture)
  assert.ok(errListeners.length >= 1)
  errListeners[0].fn({ target: brokenImg })
  assert.equal(iconFrame.classList.contains('has-image'), false)
  assert.equal(iconFrame.classList.contains('tone-cyan'), true)
  assert.match(iconFrame.innerHTML, /#lucide-globe/)

  // 切到「配置」主签：插件/MCP/技能藏起来，#environmentConfigBox 露出来
  tabButtons[3].onclick()
  assert.equal(byId('environmentTabs').dataset.active, 'config')
  assert.equal(byId('environmentPluginsBox').hidden, true)
  assert.equal(byId('environmentMcpHost').hidden, true)
  assert.equal(byId('environmentSkillsHost').hidden, true)
  assert.equal(byId('environmentConfigBox').hidden, false)
  assert.equal(syncCalls.at(-1).tab, 'config')

  // 切回「插件」再切到「DSH-X 精选」：展示精选卡片、分类过滤栏隐藏且不抢占搜索框焦点
  tabButtons[0].onclick()
  subtabButtons[1].onclick()
  assert.equal(byId('environmentInstalledPane').hidden, true)
  assert.equal(byId('environmentMarketPane').hidden, false)
  assert.equal(byId('environmentMarketTools').hidden, false)
  assert.equal(byId('environmentAddCategories').hidden, true)
  assert.equal(searchFocusCount, 0, '切换到精选不自动聚焦搜索框')
  assert.equal(syncCalls.at(-1).subTab, 'curated')
  assert.match(byId('environmentAddMarket').innerHTML, /plugin-market-card/)

  // 切到「插件市场」：显示索引分类栏并渲染插件市场索引条目，仍不自动聚焦搜索框
  subtabButtons[2].onclick()
  assert.equal(byId('environmentInstalledPane').hidden, true)
  assert.equal(byId('environmentMarketPane').hidden, false)
  assert.equal(byId('environmentAddCategories').hidden, false)
  assert.equal(searchFocusCount, 0, '切换到插件市场不自动聚焦搜索框')
  assert.match(byId('environmentAddCategories').innerHTML, /data-index-cat="ext"/)
  assert.equal(syncCalls.at(-1).subTab, 'market')
  assert.match(byId('environmentAddMarket').innerHTML, /DSH Remote/)

  // 点顶部「+」打开添加插件弹窗，手动提交包名添加并关闭弹窗切回「已安装」
  byId('environmentAddOpen').onclick()
  assert.equal(byId('environmentAddDialog').hidden, false)
  byId('environmentSpec').value = 'added-plugin@1.0.0'
  byId('environmentAddForm').onsubmit({ preventDefault() {} })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(postCalls.find((c) => c.url === '/api/environments/plugins/add')?.payload, { id: 'env-web', spec: 'added-plugin@1.0.0' })
  assert.equal(byId('environmentSpec').value, '')
  assert.equal(byId('environmentAddDialog').hidden, true)
  assert.equal(byId('environmentInstalledPane').hidden, false, '手动安装完成后切回已安装子签展示新插件')
  assert.equal(byId('environmentInstalledCount').textContent, '5')

  const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const themeCss = readFileSync(new URL('../src/public/theme.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(css, /\.plugin-installed-list\s*\{[^}]*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /\.plugin-market-search\s*\{[^}]*margin:\s*0/)
  assert.match(css, /\.environment-plugin-subtabs\.has-pill::before\s*\{/)
  assert.match(css, /\.environment-tab-actions\s+\.action-icon\s*\{[^}]*padding:\s*0/)
  assert.match(css, /\.plugin-market-tabs\s*\{[^}]*flex:\s*0\s+0\s+auto;\s*flex-wrap:\s*nowrap/)
  assert.match(html, /id="environmentTabActions"[\s\S]*?id="environmentAddOpen"[\s\S]*?id="environmentMarketActions"[\s\S]*?id="environmentAddRefresh"/)
  assert.match(html, /id="environmentAddDialog"[\s\S]*?id="environmentAddForm"[\s\S]*?id="environmentSpec"/)
  assert.doesNotMatch(css, /\.plugin-market-footer\s*\{/, '移除市场底部手填栏样式')
  assert.match(css, /\.environment-toolbar\s*\{[^}]*border-bottom:/)
  assert.match(css, /\.environment-tabs\s*\{[^}]*background:\s*transparent/)
  assert.match(css, /\.plugin-installed-list\s*>\s*\.plugin-item\s*\{[^}]*border-bottom:\s*0/)
  assert.match(css, /#launchPluginsDialog\s+#environmentDuplicate,\s*#launchPluginsDialog\s+#environmentDelete\s*\{\s*display:\s*none;\s*\}/)
  assert.match(themeCss, /html\[data-color-scheme="dark"\]\s*\.environment-plugin-subtabs\.has-pill::before\s*\{/)

  // MCP 与技能切齐为「已安装 / 精选 / 市场」三签 + 在线市场卡片 + 环境变量框
  assert.match(html, /id="mcpSubtabs"[\s\S]*?data-mcp-subtab="installed"[\s\S]*?data-mcp-subtab="curated"[\s\S]*?data-mcp-subtab="market"[\s\S]*?id="mcpSearch"[\s\S]*?id="mcpMarketPane"/)
  assert.match(html, /id="mcpEnv"/)
  assert.match(html, /id="skillSubtabs"[\s\S]*?data-skill-subtab="installed"[\s\S]*?data-skill-subtab="market"[\s\S]*?data-skill-subtab="openai"[\s\S]*?id="skillSearch"[\s\S]*?id="skillMarketPane"/)
  assert.match(html, /function mcpRow\(server\)[\s\S]*?plugin-installed-card mcp-card[\s\S]*?plugin-installed-head[\s\S]*?plugin-installed-actions/)
  assert.match(html, /function skillRow\(skill\)[\s\S]*?plugin-installed-card skill-card[\s\S]*?plugin-installed-head[\s\S]*?plugin-installed-actions[\s\S]*?class="skill-open-desc"[^>]*><span class="plugin-desc plugin-installed-desc">/)
  assert.match(css, /#mcpList,\s*#skillList\s*\{[^}]*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /#mcpList:not\(\[hidden\]\):has\(>\s*\.plugin-empty\),\s*#skillList:not\(\[hidden\]\):has\(>\s*\.plugin-empty\)\s*\{\s*display:\s*block;?\s*\}/)
  assert.ok(css.indexOf('#mcpList[hidden]') > css.indexOf('#mcpList, #skillList'), '#mcpList[hidden] 必须排在网格与空态规则之后才不会失效')
  assert.match(css, /\.plugin-market-sub\s*\{[^}]*white-space:\s*nowrap/)
  assert.match(css, /\.plugin-empty-spinner\s*\{[^}]*display:\s*inline-block/)
  assert.match(css, /\.plugin-market-icon\.has-image\.has-avatar\s*\{\s*padding:\s*0;\s*\}/)
  assert.match(envJs, /has-avatar/)
  assert.match(css, /\.market-skeleton-card\s*\{[\s\S]*@keyframes market-shimmer/)
  assert.match(themeCss, /html\[data-color-scheme="dark"\]\s*\.market-skeleton-bone\s*\{/)
  assert.match(html, /globalThis\.marketLoadingHtml\s*=/)
  assert.match(envJs, /globalThis\.marketLoadingHtml/)

  // 配置主签只保留实例配置；启动项编辑拆成独立弹窗 #envLaunchConfigDialog（双列布局、自动保存与设为 DSH_HOME 开关）
  const envConfigSlice = html.slice(html.indexOf('id="environmentConfigBox"'), html.indexOf('<section class="pane fill" id="pane-mcp">'))
  assert.doesNotMatch(envConfigSlice, /id="envLaunchConfigCard"/, '实例配置签不再内嵌启动项配置卡片')
  assert.match(envConfigSlice, /id="environmentConfigBox"[\s\S]*?id="environmentEditForm"[\s\S]*?class="environment-config-inline-grid"[\s\S]*?id="environmentSaveStatus"[^>]*\shidden[\s\S]*?class="environment-config-info"/)
  assert.match(html, /id="envLaunchConfigDialog"[\s\S]*?id="envLaunchConfigTitle"[\s\S]*?id="envLaunchConfigCard"[\s\S]*?class="env-launch-grid-top"[\s\S]*?id="envLaunchName"[\s\S]*?id="envLaunchPort"[\s\S]*?class="env-launch-grid-mid"[\s\S]*?id="envLaunchHome"[\s\S]*?id="envLaunchEnvironment"[\s\S]*?id="envLaunchAutoLaunch"[\s\S]*?id="envLaunchDshHomeEnv"[\s\S]*?id="envLaunchRecover"[\s\S]*?id="envLaunchDelete"[\s\S]*?id="envLaunchSaveStatus"[^>]*\shidden/)
  assert.doesNotMatch(html, /id="environmentSave"\b/, '移除手动保存按钮，改为自动保存')
  assert.doesNotMatch(html, /environment-autosave-badge/, '不展示常驻「自动保存」徽章')
  assert.match(css, /\.environment-config-field\s+\.launch-name-row\s+input\[type=text\]\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*width:\s*auto;[^}]*min-width:\s*0/)
  assert.match(css, /\.environment-config-version-row\s+\.ui-select\s*\{[^}]*flex:\s*1\s+1\s+[^;]*;[^}]*min-width:\s*220px/)
  assert.ok(css.indexOf('.environment-config-history[hidden]') > css.indexOf('.environment-config-history {'), '.environment-config-history[hidden] 必须排在 .environment-config-history 之后才不会被 grid 覆盖')
  assert.match(themeCss, /html\[data-color-scheme="dark"\]\s+\.environment-config-extra,\s*html\[data-color-scheme="dark"\]\s+\.env-launch-footer-row/)
})

test('启动项配置卡：设为环境变量 DSH_HOME 开关跟随当前用户目录状态并支持开启、关闭与状态同步', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const startMark = '    // 实例详情「配置」页签顶部的启动项配置卡'
  const endMark = '    applyLang()'
  const start = html.indexOf(startMark)
  const end = html.indexOf(endMark, start)
  assert.ok(start >= 0 && end > start, '能找到启动项配置卡脚本片段')
  const snippet = html.slice(start, end)

  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        hidden: false,
        disabled: false,
        checked: false,
        innerHTML: '',
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        querySelectorAll: () => [],
        addEventListener() {},
      })
    }
    return elements.get(id)
  }
  byId('envLaunchConfigDialog').hidden = true
  byId('launchPluginsDialog').hidden = true

  let launchEntry = { id: '0000000000000000', name: 'web', profile: 'web', dshHome: '', environment: 'env-1', version: 'auto', autoLaunch: false }
  const posts = []
  let postHandler = async (url, payload) => {
    posts.push({ url, payload: JSON.parse(JSON.stringify(payload)) })
    if (url === '/api/dsh-homes/env') return { ok: true, mode: 'automatic', userDshHome: payload.home }
    if (url === '/api/launch-presets') return { entry: { ...launchEntry, dshHome: payload.dshHome } }
    return {}
  }

  const context = vm.createContext({
    document: {
      getElementById: byId,
      activeElement: null,
      addEventListener() {},
    },
    getComputedStyle: () => ({ opacity: '1', transform: 'none' }),
    setTimeout,
    clearTimeout,
    t: (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
    escapeHtml: (value) => String(value ?? ''),
    normalizeHomePath: (home) => String(home || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
    createUiSelect() {},
    syncUiSelect() {},
    closeUiSelect() {},
    showPackDialog(dialog) { if (dialog) dialog.hidden = false },
    hidePackDialog: async (dialog) => { if (dialog) dialog.hidden = true; return true },
    trapPackDialog() {},
    isReducedMotion: () => true,
    LAUNCH_ICON_PATHS: { terminal: '' },
    LAUNCH_ICON_NAMES: { terminal: '终端' },
    UPDATE_CHANNEL_NAMES: { official: '正式版', rc: '预览版', alpha: '测试版' },
    launchIconMarkup: () => '',
    DEFAULT_LAUNCH_ID: '0000000000000000',
    installedList: () => ['0.2.2'],
    launchChannel: () => 'official',
    updateLaunchEntry(entry) { launchEntry = entry },
    render() {},
    pluginHomeName: (_h, fallback) => fallback,
    homeOptionLabel: (h, n) => `${n} (${h})`,
    homeOptions: () => new Map([['D:/work', '工作目录']]),
    launchEntries: () => [launchEntry],
    pluginLaunchEntry: null,
    launchPluginsDialogEl: byId('launchPluginsDialog'),
    state: { dshHome: 'C:/Users/yyh/.dsh', userDshHome: '', dshHomes: ['D:/work'] },
    environmentState: { list: [{ id: 'env-1', name: '默认实例', dshVersion: 'auto', updateChannel: 'official' }] },
    getJson: async () => ({ profile: 'web', backups: [] }),
    post: (url, payload) => postHandler(url, payload),
    globalThis: null,
  })
  context.globalThis = context
  vm.runInContext(snippet, context)

  const toggle = byId('envLaunchDshHomeEnv')
  const homeSelect = byId('envLaunchHome')
  const envSelect = byId('envLaunchEnvironment')
  const statusEl = byId('envLaunchSaveStatus')

  await context.openEnvLaunchConfig(launchEntry)
  assert.equal(byId('envLaunchConfigDialog').hidden, false)
  assert.equal(envSelect.value, 'env-1')
  assert.equal(toggle.checked, false)
  assert.equal(toggle.disabled, false)

  // 开启开关：把当前全局目录 C:/Users/yyh/.dsh 写入 DSH_HOME
  toggle.checked = true
  await toggle.onchange()
  assert.deepEqual(posts.at(-1), { url: '/api/dsh-homes/env', payload: { home: 'C:/Users/yyh/.dsh' } })
  assert.equal(context.state.userDshHome, 'C:/Users/yyh/.dsh')
  assert.equal(toggle.checked, true)
  assert.equal(statusEl.hidden, true)

  // 切换到另一个目录：开关随之变为未选中，再次开启则写入 D:/work
  homeSelect.value = 'D:/work'
  homeSelect.onchange()
  assert.equal(toggle.checked, false)
  toggle.checked = true
  await toggle.onchange()
  assert.deepEqual(posts.at(-1), { url: '/api/dsh-homes/env', payload: { home: 'D:/work' } })
  assert.equal(context.state.userDshHome, 'D:/work')
  assert.equal(toggle.checked, true)

  // 关闭开关：传空串取消 DSH_HOME
  toggle.checked = false
  await toggle.onchange()
  assert.deepEqual(posts.at(-1), { url: '/api/dsh-homes/env', payload: { home: '' } })
  assert.equal(context.state.userDshHome, '')
  assert.equal(toggle.checked, false)

  // 外部状态同步：其他地方改了 userDshHome，syncEnvLaunchDshHomeEnv 跟着刷新
  context.state.userDshHome = 'd:/work/'
  context.syncEnvLaunchDshHomeEnv()
  assert.equal(toggle.checked, true)

  // 失败回显并恢复开关状态
  postHandler = async () => { throw new Error('写用户环境变量 DSH_HOME 失败') }
  toggle.checked = false
  await toggle.onchange()
  assert.equal(statusEl.hidden, false)
  assert.equal(statusEl.textContent, '写用户环境变量 DSH_HOME 失败')
  assert.equal(toggle.checked, true)
  assert.equal(toggle.disabled, false)
})
