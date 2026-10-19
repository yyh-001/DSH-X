/**
 * 版本类型系统测试的公共夹具：隔离用户目录 + 本地假 npm registry + 进程内真服务，外加一份「需求预言」。
 *
 * 为什么单独成文件：几份系统测试各需要一套不同的远端版本表与已装版本，服务端的远端列表又是模块级缓存，
 * 同一进程里不好换夹具，只能每份夹具一个测试文件（node --test 每个文件一个进程）；搭环境的步骤完全相同，放这里只写一遍。
 *
 * 需求预言（ACCEPTS / classOf / expectedPlan / expectedAuto）照需求原文写成，不读实现：
 *   类别：无预发布段 = official；预发布首段是 rc = rc；其余预发布 = alpha；解析不了 = 无类别
 *   接受：official 只收 official；rc 收 rc + official；alpha 全收
 *   退档：已知版本（已发布 ∪ 已装；还没拉过远端时只有已装）里一个都不被选的类型接受，就退到下一个更不稳定的；
 *         一个已知版本都没有时原样保留
 * 为什么要预言而不是全写死：本机若另有全局 npm 装的 dsh，服务端会把它算进「已装」（也就算进「已知」），
 * 写死的期望在这种机器上会错；预言把服务端如实报告的已装列表也算进去，期望仍只来自需求。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmpVer, parseVer } from '../version.js'
import { isolateUserHome } from './isolated-home.mjs'

export const PACKAGE_PATH = '/@deepseek-ai/dsh'
export const BUILTIN_ID = '0000000000000000'
export const TYPES = ['official', 'rc', 'alpha']
export const ACCEPTS = { official: ['official'], rc: ['rc', 'official'], alpha: ['alpha', 'rc', 'official'] }
const FAKE_BIN = 'console.log("fake dsh")\n'

/** 把版本号数组摊成 packument 的 versions 表。 */
export function packumentOf(tags, versions) {
  return { name: '@deepseek-ai/dsh', 'dist-tags': tags, versions: Object.fromEntries(versions.map((version) => [version, {}])) }
}

/**
 * 会真的跑起来的假 dsh：把自己的版本号记到 DSH_HOME/spawned（看自动启动挑了哪个版本），
 * 打印真实格式的就绪地址、真的监听端口（服务端据此把实例标成 running）。
 */
export function runningBin(version) {
  return `import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
appendFileSync(join(process.env.DSH_HOME, 'spawned'), '${version}\\n')
const server = createServer((req, res) => res.end('fake dsh ${version}'))
const at = process.argv.indexOf('--port')
server.listen(at >= 0 ? Number(process.argv[at + 1]) : 0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`
}

/** 需求里的类别：只看预发布段的第一节；构建元数据不算预发布。 */
export function classOf(version) {
  const match = String(version ?? '').trim().match(/^\d+(?:\.\d+)?(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return ''
  if (!match[1]) return 'official'
  return match[1].split('.')[0] === 'rc' ? 'rc' : 'alpha'
}
export const accepts = (type, version) => (ACCEPTS[type] || []).includes(classOf(version))
export const newestFirst = (list) => [...list].filter((version) => parseVer(version)).sort((a, b) => cmpVer(parseVer(b), parseVer(a)))
export const newer = (a, b) => Boolean(parseVer(a) && parseVer(b) && cmpVer(parseVer(a), parseVer(b)) > 0)

/** 需求 R2：选的类型 → 实际生效的类型。 */
export function effectiveType(chosen, known) {
  const classes = new Set(known.map(classOf).filter(Boolean))
  if (!classes.size) return chosen
  for (const type of TYPES.slice(TYPES.indexOf(chosen))) {
    if (ACCEPTS[type].some((kind) => classes.has(kind))) return type
  }
  return chosen
}

/** 需求 R5：published = null 表示还没拉过远端（latest 为空串、已知只算已装）。 */
export function expectedPlan(chosen, installed, published) {
  const channel = effectiveType(chosen, [...installed, ...(published || [])])
  return {
    channel,
    installed: newestFirst(installed.filter((version) => accepts(channel, version))),
    latest: published ? newestFirst(published.filter((version) => accepts(channel, version)))[0] || '' : '',
  }
}

/** 需求 R1（服务端口径）：同 profile + 目录里在跑、且被生效类型接受的最高版本优先，否则已装的最高版本，都没有就是空串。 */
export function expectedAuto(chosen, { installed, published = null, running = [] }) {
  const plan = expectedPlan(chosen, installed, published)
  return newestFirst(running.filter((version) => accepts(plan.channel, version)))[0] || plan.installed[0] || ''
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * 环境必须在导入 server.js 之前摆好：设置目录、数据目录、registry 地址都在模块加载或启动时确定。
 * installed：受管版本（造出 bin.js 让服务端认作已安装）；presets：预置在 settings.json 里的启动项，
 * 也可以是 (root) => 启动项列表（要给每个启动项一个临时根目录下的独立 dsh 用户目录时用，目录会先建好）；
 * bin：版本号 → bin.js 内容（要真跑起来的用例传 runningBin）；online：registry 一开始是否在线。
 */
export async function startChannelServer({ prefix, packument, installed = [], presets, bin = () => FAKE_BIN, online = true }) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const app = isolateUserHome(join(root, 'user'))
  // Windows 还会从这些目录发现全局 dsh；只隔离 HOME/APPDATA 会把真运行时带进来，
  // 自动启动用例就可能启动它而不是下面写出的假 dsh。和 PATH API 测试一样隔离这些入口。
  for (const key of ['LOCALAPPDATA', 'npm_config_prefix', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    process.env[key] = join(root, 'system')
  }
  const data = join(root, 'data')
  const home = join(root, 'home')
  for (const dir of [app, data, home]) mkdirSync(dir, { recursive: true })
  const settingsFile = join(app, 'settings.json')
  let listed = []

  function writeVersion(version) {
    const lib = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'bin.js'), bin(version))
  }
  /** 整体换成这几个已装版本（旧的删掉）。 */
  function installVersions(versions) {
    rmSync(join(data, 'versions'), { recursive: true, force: true })
    versions.forEach(writeVersion)
    listed = [...versions]
    writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: listed }))
  }
  /** 追加已装版本，不动已有的（正在跑的实例的版本目录不能被删）。 */
  function addVersions(versions) {
    versions.forEach(writeVersion)
    listed = [...listed, ...versions.filter((version) => !listed.includes(version))]
    writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: listed }))
  }
  installVersions(installed)
  if (typeof presets === 'function') presets = presets(root)
  for (const entry of presets || []) if (entry.dshHome) mkdirSync(entry.dshHome, { recursive: true })
  writeFileSync(settingsFile, JSON.stringify({
    dataDir: data, dshHome: home, seedMarket: false, proxyMode: 'off', systemPath: false,
    ...(presets ? { launchPresets: presets } : {}),
  }))

  const requests = []
  let current = packument
  let up = online
  let generation = 0
  const registry = createServer((req, res) => {
    // 路径前缀 /g<n> 是「第几版远端」：换远端时换前缀，服务端按 registry 地址做的短时缓存也就跟着换掉
    const path = decodeURIComponent(req.url || '').toLowerCase().replace(/^\/g\d+(?=\/)/, '')
    requests.push(req.url)
    if (!up) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":"offline"}')
      return
    }
    if (path !== PACKAGE_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(current))
  })
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve))
  const registryBase = () => `http://127.0.0.1:${registry.address().port}/g${generation}`
  process.env.npm_config_registry = registryBase()
  process.env.PORT = String(await freePort())

  const server = await import('../server.js')
  const settings = await import('../settings.js')
  const version = await import('../version.js')
  let origin = await server.startServer()

  async function call(path, body, headers = {}) {
    const init = body === undefined ? { headers }
      : { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
    const response = await fetch(origin + path, init)
    const text = await response.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, ok: response.ok, data: parsed }
  }

  /** 读取并解析 JSON 接口；非 2xx 直接让用例失败并带上服务端说法。 */
  async function getJson(path) {
    const result = await call(path)
    if (!result.ok) throw new Error(`GET ${path} → HTTP ${result.status}: ${JSON.stringify(result.data)}`)
    return result.data
  }

  /** 在某个 dsh 用户目录里起 / 停一个版本（页面「环境」那条按目录限定的路子，不碰启动项）。 */
  const homeHeader = (dir) => ({ 'x-dsh-home': encodeURIComponent(dir) })
  async function startIn(dir, ver, profile = 'web') {
    const result = await call('/api/start', { version: ver, profile }, homeHeader(dir))
    if (!result.ok) throw new Error(`在 ${dir} 启动 ${ver} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
    return result.data
  }
  async function stopIn(dir, ver, profile = 'web') {
    const result = await call('/api/stop', { version: ver, profile, home: dir }, homeHeader(dir))
    if (!result.ok) throw new Error(`在 ${dir} 停止 ${ver} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  }

  return {
    root, app, data, home, settingsFile, requests, server, settings, version,
    get origin() { return origin },
    call, getJson, installVersions, addVersions, startIn, stopIn,
    /** 远端是否已经被问过（判断「还没拉过远端」这个状态用）。 */
    fetchedPackage: () => requests.some((url) => /@deepseek-ai%2fdsh/i.test(url || '')),
    stored: () => JSON.parse(readFileSync(settingsFile, 'utf8')),
    state: () => getJson('/api/state'),
    remote: () => getJson('/api/remote'),
    async pendingDsh() { return (await getJson('/api/pending')).update?.dsh ?? null },
    /** 托盘菜单读的启动项行（id / 版本 / 是否已装 / 状态），GET /api/tray 的 launches= 那一行。 */
    async trayLaunches() {
      const result = await call('/api/tray')
      const line = String(result.data).split('\n').find((row) => row.startsWith('launches='))
      if (!line) throw new Error(`托盘接口没有 launches 行：${String(result.data).slice(0, 200)}`)
      return JSON.parse(line.slice('launches='.length))
    },
    /**
     * 换远端版本表（或上下线）并让服务端重新拉一次。为什么切下载源：设置页切下载源会清掉远端缓存
     * （这是已有的、文档写明的行为），这是不改代码、不等 60 秒缓存过期就能让服务端看到新远端的唯一入口。
     */
    async republish(next, { online: nextOnline = true } = {}) {
      if (next) current = next
      up = nextOnline
      generation += 1
      process.env.npm_config_registry = registryBase()
      const result = await call('/api/settings', { downloadSource: 'official' })
      if (!result.ok) throw new Error(`切下载源失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
      return up ? getJson('/api/remote') : null
    },
    /** 托盘里点某个启动项（start / stop …）；带上菜单当时看到的 instanceId，跟真托盘一样。 */
    async trayAct(id, action) {
      const row = (await this.trayLaunches()).find((item) => item.id === id)
      return call('/api/tray/action', { id, action, instanceId: row?.instanceId, targetId: row?.target?.id })
    },
    /** 页面连上 /api/events 后收到的第一份状态推送（页面就是靠它和后续推送更新 state 的）。 */
    async firstPush() {
      const controller = new AbortController()
      const response = await fetch(origin + '/api/events', { signal: controller.signal })
      const decoder = new TextDecoder()
      let text = ''
      try {
        for await (const chunk of response.body) {
          text += decoder.decode(chunk, { stream: true })
          const match = /(?:^|\n)event: state\ndata: ([^\n]*)\n\n/.exec(text)
          if (match) return JSON.parse(match[1])
        }
      } finally {
        controller.abort()
      }
      throw new Error('事件流结束前没有收到状态推送')
    },
    async restart() {
      await server.stopAll()
      origin = await server.startServer()
    },
    async cleanup() {
      await server.stopAll()
      await new Promise((resolve) => registry.close(resolve))
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { rmSync(root, { recursive: true, force: true }); return }
        catch (error) {
          if (attempt === 19) throw error
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    },
  }
}
