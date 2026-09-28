/**
 * 网络代理（issue #32）：设置校验、系统探测、以及「带代理的 fetch」整条链路。
 *
 * 为什么这些测试值得存在：Node 的全局 fetch 不看系统代理也不看 HTTP_PROXY，代理软件开着、
 * 浏览器能上网，启动器却卡在「正在读取版本」。修法是自己实现一段（proxy.js），而这段代码
 * 的每一处都只能靠真实连接验证——CONNECT 隧道、TLS 握手、重定向、失败回落直连。
 * 所以这里起一只假代理（test/fake-proxy.mjs）+ 一只本地 https 源站（自签证书，
 * test/fixtures/localhost-tls.pem），把整条路真跑一遍。
 *
 * settings.js 在导入时就把 settings.json 的位置定死了（来自 APPDATA），而下面要验证
 * 「设置里选了什么，netFetch 就往哪走」，所以先把 APPDATA 指到临时目录，再动态导入。
 */
import assert from 'node:assert/strict'
import { createServer as createHttpServer, get } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// 换成临时 APPDATA 必须在导入 settings.js / platform.js 之前（它们导入时就读环境变量）
const APP_DATA = mkdtempSync(join(tmpdir(), 'dsh-proxy-appdata-'))
process.env.APPDATA = APP_DATA
process.env.XDG_CONFIG_HOME = APP_DATA
delete process.env.HTTPS_PROXY
delete process.env.https_proxy
delete process.env.HTTP_PROXY
delete process.env.http_proxy
delete process.env.ALL_PROXY
delete process.env.all_proxy

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
/**
 * 读仓库里的源码文件来钉接线。**换行先统一成 \n**：Windows 上检出（autocrlf）是 CRLF，
 * 而断言里为了看清同一段代码用了带 \n 的正则——不统一的话这套用例只在本机 LF 的树里绿。
 */
const read = (name) => readFileSync(join(ROOT, name), 'utf8').replace(/\r\n/g, '\n')
const PEM = readFileSync(join(ROOT, 'test', 'fixtures', 'localhost-tls.pem'), 'utf8')
// 自签证书的源站只能这么连；只影响这个测试进程
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const core = await import('../proxy.js')
const settings = await import('../settings.js')
const { startFakeProxy } = await import('./fake-proxy.mjs')

const {
  detectSystemProxy, hostBypassed, isLoopbackHost, parseScutilProxy, parseWindowsProxy,
  pickProxyServer, proxyEnv, proxyFetch, resetProxyCache, resolveProxy, systemProxy,
} = core
const { DEFAULTS, normalizeProxyUrl, safeProxyMode, safeProxyUrl } = settings

const SETTINGS_FILE = join(APP_DATA, 'DSH', 'settings.json')
/** 把设置写进临时 settings.json，然后按它解析一遍（探测缓存要清掉）。 */
async function writeSettings(patch) {
  await mkdir(join(APP_DATA, 'DSH'), { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(patch, null, 2))
  resetProxyCache()
}

const manual = (url) => ({ url, bypass: [], note: '', detail: '', from: 'manual' })

/** 关掉测试用的服务器：先断开还活着的连接（keep-alive 会让 close 一直等）。 */
const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.()
  server.close(() => resolve())
})
const origin = (port, path = '/') => `http://origin.test:${port}${path}`

/** 一只本机源站（http 或 https）+ 一只假代理，测试用完自己收摊。 */
async function startPair(t, { secure = false } = {}) {
  const handler = (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/landed' })
      res.end()
      return
    }
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' })
    res.end('plain-body')
  }
  const server = secure
    ? createHttpsServer({ cert: PEM, key: PEM }, handler)
    : createHttpServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const proxy = await startFakeProxy()
  t.after(async () => {
    await proxy.close()
    // 直连那条路用的是全局 agent（keep-alive），不断掉的话 close() 会一直等
    await closeServer(server)
  })
  return { port: server.address().port, proxy }
}

/* ------------------------------------------------------------------ 设置 */

test('代理模式只认三种，脏值回「跟随系统」', () => {
  assert.deepEqual(settings.PROXY_MODES, ['off', 'system', 'manual'])
  assert.equal(settings.DEFAULT_PROXY_MODE, 'system')
  assert.equal(DEFAULTS.proxyMode, 'system', '默认跟着系统代理走，装了代理软件的用户不用填任何东西')
  assert.equal(DEFAULTS.proxyUrl, '')
  assert.equal(safeProxyMode('manual'), 'manual')
  assert.equal(safeProxyMode('OFF'), 'off', '大小写不敏感')
  for (const bad of ['', null, undefined, 'on', 'auto', 42, {}]) {
    assert.equal(safeProxyMode(bad), 'system', JSON.stringify(bad))
  }
})

test('代理地址：认简写、丢掉路径，认不出来给一句人话', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890', '只填主机:端口也认')
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890', '末尾斜杠与路径不要')
  assert.equal(normalizeProxyUrl('http://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890', '带认证的地址原样留着')
  assert.equal(normalizeProxyUrl('https://proxy.corp:8443'), 'https://proxy.corp:8443')
  assert.equal(normalizeProxyUrl(''), '')
  assert.equal(normalizeProxyUrl('   '), '')
  assert.equal(normalizeProxyUrl('不是地址'), '')
  assert.equal(normalizeProxyUrl('ftp://127.0.0.1:21'), '', '只支持 http(s) 代理')
  assert.equal(safeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(safeProxyUrl(''), '', '留空 = 没填，不是错误')
  assert.throws(() => safeProxyUrl('socks5://127.0.0.1:7891'), /http/, 'socks 要说清楚该换成哪个端口')
  assert.throws(() => safeProxyUrl('随便写的'), /代理地址/)
})

/* -------------------------------------------------------------- 系统探测 */

test('Windows 注册表：开了才是代理，http/https 优先，只配 socks 就说明原因', () => {
  const reg = (server, extra = '') => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    ${server}
${extra}`
  assert.deepEqual(parseWindowsProxy(reg('127.0.0.1:7890')), { url: 'http://127.0.0.1:7890', bypass: [], note: '', detail: '', from: 'system' })
  const both = parseWindowsProxy(reg('http=127.0.0.1:7890;https=127.0.0.1:7891'))
  assert.equal(both.url, 'http://127.0.0.1:7891', 'https 那条优先（我们的请求基本都是 https）')
  const socks = parseWindowsProxy(reg('socks=127.0.0.1:7891'))
  assert.equal(socks.url, '', 'socks 用不了')
  assert.equal(socks.note, 'socks')
  assert.equal(socks.detail, 'socks://127.0.0.1:7891')
  const bypass = parseWindowsProxy(reg('127.0.0.1:7890', '    ProxyOverride    REG_SZ    <local>;*.corp.cn;192.168.*'))
  assert.deepEqual(bypass.bypass, ['*.corp.cn', '192.168.*'], '<local> 不用留（回环本来就直连）')
  assert.equal(parseWindowsProxy('    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890'), null, '没开代理')
  assert.equal(parseWindowsProxy('     ProxyEnable    REG_DWORD    0x1'), null, '开了但没填服务器')
  assert.equal(parseWindowsProxy(''), null)
})

test('macOS scutil：HTTPS 优先，例外名单进绕过表；只有 SOCKS 时说明原因', () => {
  const text = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`
  const parsed = parseScutilProxy(text)
  assert.equal(parsed.url, 'http://127.0.0.1:7891')
  assert.deepEqual(parsed.bypass, ['*.local', '169.254/16'])
  const socksOnly = parseScutilProxy(`<dictionary> {
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`)
  assert.equal(socksOnly.url, '')
  assert.equal(socksOnly.note, 'socks')
  assert.equal(socksOnly.detail, 'socks://127.0.0.1:7892')
  assert.equal(parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n}'), null)
})

test('探测：环境变量优先于系统设置，没有就老实说没有', () => {
  const fromEnv = detectSystemProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,*.corp.cn' }, platform: 'linux', run: () => '' })
  assert.equal(fromEnv.url, 'http://127.0.0.1:7890')
  assert.equal(fromEnv.from, 'env')
  assert.deepEqual(fromEnv.bypass, ['localhost', '*.corp.cn'])
  const lower = detectSystemProxy({ env: { http_proxy: '127.0.0.1:1080' }, platform: 'linux', run: () => '' })
  assert.equal(lower.url, 'http://127.0.0.1:1080', '小写的 http_proxy 也认（git/curl 那套）')
  const win = detectSystemProxy({
    env: {},
    platform: 'win32',
    run: () => '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890',
  })
  assert.equal(win.url, 'http://127.0.0.1:7890')
  const none = detectSystemProxy({ env: {}, platform: 'linux', run: () => '' })
  assert.deepEqual(none, { url: '', bypass: [], note: '', detail: '', from: '' })
  // 探测本身不许抛：reg/scutil 不在、输出格式不认识，都算没配
  const broken = detectSystemProxy({ env: {}, platform: 'win32', run: () => { throw new Error('reg 不存在') } })
  assert.equal(broken.url, '')
})

test('resolveProxy：三种模式各走各的', () => {
  assert.deepEqual(resolveProxy({ proxyMode: 'off', proxyUrl: 'http://127.0.0.1:7890' }), { url: '', bypass: [], note: '', detail: '', from: '', mode: 'off' })
  const man = resolveProxy({ proxyMode: 'manual', proxyUrl: '127.0.0.1:7890' })
  assert.equal(man.url, 'http://127.0.0.1:7890')
  assert.equal(man.from, 'manual')
  assert.equal(resolveProxy({ proxyMode: 'manual', proxyUrl: '' }).url, '', '手动但没填地址 = 没有代理')
  const bad = resolveProxy({ proxyMode: 'manual', proxyUrl: '这不是地址' })
  assert.equal(bad.note, 'bad-url')
  assert.equal(bad.detail, '这不是地址')
  const sys = resolveProxy({ proxyMode: 'system' }, )
  assert.equal(sys.mode, 'system')
  assert.equal(typeof sys.url, 'string')
})

/* ------------------------------------------------------------ 回环 / env */

test('回环地址永远直连，系统代理的绕过名单也照做', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '127.8.8.8', 'dsh.localhost']) {
    assert.equal(isLoopbackHost(host), true, host)
    assert.equal(hostBypassed(host, manual('http://127.0.0.1:7890')), true, host)
  }
  const proxy = { url: 'http://127.0.0.1:7890', bypass: ['*.corp.cn', '192.168.*', 'github.com'] }
  assert.equal(hostBypassed('api.corp.cn', proxy), true, '通配后缀')
  assert.equal(hostBypassed('corp.cn', proxy), true, '*.x 也盖住 x 本身')
  assert.equal(hostBypassed('192.168.1.5', proxy), true, '前缀通配')
  assert.equal(hostBypassed('github.com', proxy), true, '整名匹配')
  assert.equal(hostBypassed('api.github.com', proxy), true, '子域也算')
  assert.equal(hostBypassed('registry.npmjs.org', proxy), false)
  assert.equal(hostBypassed('127.0.0.1', { url: 'http://127.0.0.1:7890', bypass: [] }), true, '回环不用名单也直连')
  assert.equal(hostBypassed('example.com', { url: 'http://127.0.0.1:7890', bypass: [] }), false)
})

test('子进程的代理环境变量：大小写都写，回环进 NO_PROXY，npm 那几个也带上', () => {
  const env = proxyEnv({ url: 'http://127.0.0.1:7890', bypass: ['*.corp.cn'] })
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7890', key)
  }
  assert.match(env.NO_PROXY, /localhost/)
  assert.match(env.NO_PROXY, /127\.0\.0\.1/)
  assert.match(env.NO_PROXY, /\*\.corp\.cn/)
  assert.equal(env.no_proxy, env.NO_PROXY)
  assert.equal(env.npm_config_proxy, 'http://127.0.0.1:7890')
  assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:7890')
  assert.equal(env.npm_config_noproxy, env.NO_PROXY)
  assert.deepEqual(proxyEnv({ url: '' }), {}, '没代理就别往子进程里塞变量')
  assert.deepEqual(proxyEnv(null), {})
})

/* ------------------------------------------------------------------ 走代理 */

test('http 目标：绝对形式的请求行发给代理，响应照常读', async (t) => {
  const { port, proxy } = await startPair(t)
  const res = await proxyFetch(origin(port, '/hello'), {}, manual(proxy.url))
  assert.equal(res.status, 200)
  assert.equal(res.ok, true)
  assert.equal(res.viaProxy, proxy.url, 'viaProxy 记下实际走通的代理')
  assert.equal(await res.text(), 'plain-body')
  assert.equal(proxy.requests.length, 1, '请求确实经过了代理')
  assert.equal(proxy.requests[0].url, origin(port, '/hello'), '代理看到的是完整 URL（绝对形式）')
  assert.equal(proxy.connects.length, 0, '明文 http 不用 CONNECT')
})

test('https 目标：CONNECT 隧道 + 隧道里握手', async (t) => {
  const { port, proxy } = await startPair(t, { secure: true })
  const res = await proxyFetch(`https://origin.test:${port}/json`, {}, manual(proxy.url))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, url: '/json' })
  assert.deepEqual(proxy.connects.map((item) => item.target), [`origin.test:${port}`], 'CONNECT 报的是目标主机:端口')
  assert.equal(proxy.connects[0].headers.host, `origin.test:${port}`, 'CONNECT 的 Host 头也要对')
  assert.equal(proxy.requests.length, 0, '隧道里的请求不再经过代理的请求行')
})

test('跟着重定向走，最后一跳的地址才是 res.url', async (t) => {
  const { port, proxy } = await startPair(t)
  const res = await proxyFetch(origin(port, '/redirect'), {}, manual(proxy.url))
  assert.equal(res.status, 200)
  assert.equal(res.url, origin(port, '/landed'))
  assert.equal(proxy.requests.length, 2, '两跳都经过代理')
})

test('响应体是标准的 web stream：registry.js 的 Readable.fromWeb 直接用', async (t) => {
  const { port, proxy } = await startPair(t)
  const res = await proxyFetch(origin(port, '/hello'), {}, manual(proxy.url))
  assert.equal(res.headers.get('content-length'), '10', 'content-length 要在（下载进度靠它）')
  let got = ''
  for await (const chunk of Readable.fromWeb(res.body)) got += chunk
  assert.equal(got, 'plain-body')
})

test('POST 带 body 也走代理；代理认证能带上', async (t) => {
  const { port, proxy } = await startPair(t, { secure: true })
  const auth = await startFakeProxy({ username: 'dsh', password: 'pw' })
  t.after(() => auth.close())
  const res = await proxyFetch(`https://origin.test:${port}/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  }, manual(auth.url))
  assert.equal(res.status, 200)
  assert.equal(auth.connects.length, 1, '带用户名密码的代理地址照样能用')
  assert.equal(proxy.connects.length, 0)
})

test('代理连不上/拒绝 CONNECT：错误里说清楚是代理那头的问题', async (t) => {
  const { port } = await startPair(t, { secure: true })
  const refusing = await startFakeProxy({ refuseConnect: 1 })
  t.after(() => refusing.close())
  await assert.rejects(
    () => proxyFetch(`https://origin.test:${port}/json`, {}, manual(refusing.url)),
    /代理拒绝 CONNECT|直连/,
  )
  await assert.rejects(
    () => proxyFetch(`https://origin.test:${port}/json`, {}, manual('http://127.0.0.1:1')),
    /走代理没通/,
    '代理死了、直连也不通时，两边的说法都要在错误里',
  )
})

test('代理不通就回落直连：代理不是单点', async (t) => {
  // 源站监听所有网卡，用本机主机名访问（不是回环 → 会先试代理；代理死了 → 走直连）
  const server = createHttpServer((req, res) => {
    res.writeHead(200)
    res.end('direct ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))
  t.after(() => closeServer(server))
  const port = server.address().port
  // 先确认这台机器的主机名真能连回自己（防火墙、公司网络会挡掉，那就跳过这条）
  const reachable = await new Promise((resolve) => {
    get({ host: hostname(), port, path: '/', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false)).on('timeout', () => resolve(false))
  })
  if (!reachable) {
    t.skip(`本机主机名 ${hostname()} 连不回自己，跳过回落直连这条`)
    return
  }
  const res = await proxyFetch(`http://${hostname()}:${port}/`, {}, manual('http://127.0.0.1:1'))
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'direct ok')
  assert.equal(res.viaProxy, '', 'viaProxy 空着 = 最后是直连拿到的')
})

test('回环目标压根不碰代理', async (t) => {
  const { port, proxy } = await startPair(t)
  const res = await proxyFetch(`http://127.0.0.1:${port}/hello`, {}, manual(proxy.url))
  assert.equal(res.status, 200)
  assert.equal(res.viaProxy, '')
  assert.equal(proxy.requests.length, 0, '管理页/dsh web/本机 MCP 都在回环上，不能被绕进代理')
})

test('没配代理时交给全局 fetch：一个请求都不发到代理', async (t) => {
  const { port, proxy } = await startPair(t)
  // 直连通不通取决于本机 DNS（origin.test 是给假代理用的假域名），这里只钉一件事：
  // 没有代理配置时，绝不会绕到代理上去
  await proxyFetch(origin(port, '/hello'), {}, { url: '', bypass: [] }).catch(() => null)
  assert.equal(proxy.requests.length, 0)
  assert.equal(proxy.connects.length, 0)
})

/* -------------------------------------------------- 设置 → netFetch 整条链 */

test('netFetch 读设置：手动填的代理真的会用上，改成「不走代理」就真不走', async (t) => {
  const { port, proxy } = await startPair(t)
  await writeSettings({ proxyMode: 'manual', proxyUrl: proxy.url })
  const res = await core.netFetch(origin(port, '/hello'))
  assert.equal(res.status, 200)
  assert.equal(res.viaProxy, proxy.url, '设置里的代理生效')
  assert.equal(proxy.requests.length, 1)

  await writeSettings({ proxyMode: 'off' })
  await core.netFetch(origin(port, '/hello')).catch(() => null)
  assert.equal(proxy.requests.length, 1, '关了代理之后一次都没再经过代理')
})

test('netFetch 跟着环境变量走（跟随系统模式）', async (t) => {
  const { port, proxy } = await startPair(t)
  await writeSettings({ proxyMode: 'system' })
  process.env.HTTPS_PROXY = proxy.url
  try {
    resetProxyCache()
    const res = await core.netFetch(origin(port, '/hello'))
    assert.equal(res.viaProxy, proxy.url)
  } finally {
    delete process.env.HTTPS_PROXY
    resetProxyCache()
  }
})

test('系统探测结果有缓存，改设置要能立刻失效', async () => {
  resetProxyCache()
  const first = systemProxy()
  const second = systemProxy()
  assert.equal(first, second, '同一份结果复用（探测要起进程，不能每次请求都探）')
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
  try {
    assert.equal(systemProxy(), first, '没失效前还是老结果')
    resetProxyCache()
    assert.equal(systemProxy().url, 'http://127.0.0.1:7890', '失效之后立刻按新的来')
  } finally {
    delete process.env.HTTPS_PROXY
    resetProxyCache()
  }
})

/* ---------------------------------------------------------------- 接线 */

test('server.js：外网请求走 netFetch，回环请求不折腾', () => {
  const server = read('server.js')
  assert.match(server, /import \{ netFetch, proxyEnv, resetProxyCache, resolveProxy \} from '\.\/proxy\.js'/)
  // 外网那几个点都换掉了
  for (const site of [
    /await netFetch\(url, \{ redirect: 'follow', signal: AbortSignal\.timeout\(10 \* 60 \* 1000\) \}\)/,
    /await netFetch\(url, \{ headers: \{ 'user-agent': 'dsh-launcher' \} \}\)/,
    /await netFetch\(candidate, \{ redirect: 'follow' \}\)/,
    /await netFetch\(candidate, \{ headers: \{ accept: 'application\/vnd\.github\+json', 'user-agent': 'dsh-x' \} \}\)/,
  ]) {
    assert.match(server, site)
  }
  // 回环的（自己的管理页、换端口探测）留在全局 fetch 上：走代理绕一圈没意义
  assert.match(server, /const res = await fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/api\/ping`/)
  assert.match(server, /const first = await fetch\(`\$\{base\}\/\?token=/, '唤醒本机的请求不该被改')
  assert.match(server, /\.\.\.proxyEnv\(\)/, 'dsh 子进程拿到代理环境变量')
  assert.match(server, /function probeEnv\(\) \{\n  const env = \{ \.\.\.process\.env, \.\.\.proxyEnv\(\)/)
  assert.match(server, /if \(error\?\.proxyError\) \{/, 'describeFetchError 认得「代理和直连都没通」')
  assert.match(server, /const proxy = resolveProxy\(\)\n  return proxy\.url \? `；也可以看设置页的「网络代理」/)
})

test('server.js：设置页拿得到代理状态，保存后探测缓存作废', () => {
  const server = read('server.js')
  assert.match(server, /proxyMode: safeProxyMode\(stored\.proxyMode\)/)
  assert.match(server, /proxyUrl: stored\.proxyUrl \|\| ''/)
  assert.match(server, /proxyInUse: resolveProxy\(stored\)/)
  assert.match(server, /proxyModes: \[\s*\{ id: 'system', label: '跟随系统' \},\s*\{ id: 'manual', label: '手动填写' \},\s*\{ id: 'off', label: '不走代理' \},\s*\]/)
  assert.match(server, /\('proxyMode' in body \? \{ proxyMode: safeProxyMode\(body\.proxyMode\) \}/, '保存时校验')
  assert.match(server, /\('proxyUrl' in body \? \{ proxyUrl: safeProxyUrl\(body\.proxyUrl\) \}/)
  assert.match(server, /if \('proxyMode' in body \|\| 'proxyUrl' in body\) \{\s*\/\/[^\n]*\n\s*resetProxyCache\(\)/, '改完设置立刻重新探测')
  // 自检接口
  assert.match(server, /url\.pathname === '\/api\/proxy\/test'/)
  assert.match(server, /async function testNetwork\(\)/)
  assert.match(server, /const url = `\$\{currentRegistry\(\)\}\/-\/ping`/, '自检打的是下载源的 ping，小且便宜')
  assert.match(server, /const proxyError = res\.proxyError \|\| ''/, '自检结果要带上代理那头的失败原因')
})

test('registry.js / mcp.js：查版本、下 tarball、探测端点也带代理', () => {
  const registry = read('registry.js')
  assert.match(registry, /import \{ netFetch, proxyEnv \} from '\.\/proxy\.js'/)
  assert.match(registry, /const res = await netFetch\(url, \{\s*headers: \{\s*accept: 'application\/vnd\.npm\.install-v1\+json, application\/json'/)
  assert.match(registry, /const res = await netFetch\(url, \{ headers: \{ 'user-agent': USER_AGENT \} \}\)/)
  assert.match(registry, /npm_config_registry: currentRegistry\(\),\s*\.\.\.proxyEnv\(\)/, 'npm 子进程也拿代理变量')
  const mcp = read('mcp.js')
  assert.match(mcp, /import \{ netFetch \} from '\.\/proxy\.js'/)
  assert.match(mcp, /return netFetch\(url, \{\s*method: 'POST'/)
})

test('设置页：网络代理一行齐全，改动即保存，文案都有英文', () => {
  const html = read('public/index.html')
  assert.match(html, /<span class="set-name" data-i18n="网络代理">网络代理<\/span>[\s\S]{0,400}?<select id="proxyMode">/, '一行里有模式下拉')
  assert.match(html, /<div class="set-row stacked">[\s\S]{0,900}?<select id="proxyMode"><\/select>[\s\S]{0,200}?<input id="proxyUrl" type="text"[\s\S]{0,200}?<button class="ghost" id="proxyTest"/, '模式 + 地址 + 自检挤在一行的控件区里')
  assert.match(html, /queueSetting\('proxyMode', proxyModeEl\.value\)/, '模式改动即保存')
  assert.match(html, /queueSetting\('proxyUrl', proxyUrlEl\.value\.trim\(\)\)/, '地址改动即保存（失焦才提交）')
  assert.match(html, /proxyUrlEl\.hidden = String\(mode\) !== 'manual'/, '只有手动模式才要地址')
  assert.match(html, /proxyModeEl\.innerHTML = list\.map/, '选项由服务端给')
  assert.match(html, /proxyHintEl\.textContent = describeProxy\(data\)/, '读设置时回填提示行')
  assert.match(html, /post\('\/api\/proxy\/test', \{\}\)/, '自检走 /api/proxy/test')
  assert.match(html, /await flushSettings\(\)\n\s+const data = await post\('\/api\/proxy\/test'/, '自检前先把没落盘的改动存掉')
  assert.match(html, /data\.proxyError[\s\S]{0,200}?直连通了（\{url\}），但代理没通/, '代理没通、直连兜住时要如实说出来')
  const selectList = html.match(/document\.querySelectorAll\('([^']*#profile[^']*)'\)/)?.[1] || ''
  assert.ok(selectList.includes('#proxyMode'), '网络代理也进自绘下拉名单')
  // 中文文案（这一行 + 这段 JS）都要有英文
  const dict = new Function(`return (${html.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`)()
  const cjk = /[\u4e00-\u9fff]/
  const missing = []
  const check = (text) => { if (cjk.test(text) && !dict[text]) missing.push(text) }
  const row = html.match(/<span class="set-name" data-i18n="网络代理"[\s\S]*?<p class="hint" id="proxyHint"><\/p>/)[0]
  for (const match of row.matchAll(/data-i18n="([^"]+)"/g)) check(match[1])
  const block = html.match(/const proxyModeEl = document\.getElementById\('proxyMode'\)[\s\S]*?\n    const settingsHint/)[0]
    + html.match(/proxyModeEl\.onchange = \(\) => \{[\s\S]*?\n    \}\n    webBindEl\.onchange/)[0]
  for (const match of block.matchAll(/t\('([^']+)'/g)) check(match[1])
  assert.deepEqual([...new Set(missing)], [], '网络代理这块没翻的中文')
})

test('settings.js：默认值、保存、脏值都有交代', () => {
  const src = read('settings.js')
  assert.match(src, /export const PROXY_MODES = \['off', 'system', 'manual'\]/)
  assert.match(src, /proxyMode: DEFAULT_PROXY_MODE,\s*\n\s*proxyUrl: '',/)
  assert.match(src, /merged\.proxyMode = safeProxyMode\(merged\.proxyMode\)/)
  assert.match(src, /if \('proxyMode' in patch\) merged\.proxyMode = safeProxyMode\(patch\.proxyMode\)/)
  // 脏值顺手修回空（当没填），显式填错才抛给页面
  assert.match(src, /try \{\s*merged\.proxyUrl = safeProxyUrl\(merged\.proxyUrl\)\s*\} catch \{\s*merged\.proxyUrl = ''\s*\}/)
  assert.match(src, /if \('proxyUrl' in patch\) merged\.proxyUrl = safeProxyUrl\(patch\.proxyUrl\)/)
})

test('打包名单里有 proxy.js（漏了就是装完启动器起不来）', () => {
  const pack = read('scripts/pack-common.mjs')
  assert.match(pack, /'proxy\.js',/, 'APP_FILES 要带上新模块')
})

test('测试用的自签证书只是本机回路用的，别误当密码学资产', () => {
  const pem = read('test/fixtures/localhost-tls.pem')
  assert.match(pem, /BEGIN (RSA )?PRIVATE KEY/, '证书和私钥在一个文件里（本地测试用）')
  assert.match(pem, /BEGIN CERTIFICATE/)
  assert.ok(read('test/fixtures/README.md').includes('openssl'), '怎么重新生成要写在旁边')
})
