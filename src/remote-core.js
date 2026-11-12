/**
 * 远端 core：把同一份 dsh-x-core 装进 WSL 并发在一段 HTTP 上，本地管理器通过
 * `127.0.0.1:<port>`（WSL2 的 localhost 转发）连过去。
 *
 * 这一层只负责“起一个能连的远端 core”：安装、启动、拿 launch token、转发 HTTP。
 * 启动项/页面怎么用远端的 state、哪些请求要代理，放在 server.js 和页面层。
 * SSH（#97）以后复用同样的 install/start/request，只换 transport。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { allocateWslPort, buildWslArgs, createWslBackend, WSL_EXE } from './wsl.js'
import { buildExportsScript, shellQuote } from './remote.js'
import { proxyEnv } from './proxy.js'

const CORE_READY_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u
const VERSION_RE = /^[0-9][0-9A-Za-z._+-]*$/u
const DEFAULT_INSTALL_ROOT = '$HOME/.dsh-x/core'
const DEFAULT_CONFIG_ROOT = '$HOME/.dsh-x/core-config'

function localPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/**
 * 路径放进 shell：`$HOME/...` 要保留展开，不能整段单引号；其它绝对路径照常单引号。
 * 这样默认安装目录在 WSL 里会落到 `/root/.dsh-x/...`，而不是相对当前目录的 `$HOME/...`。
 */
function shellPath(value) {
  const text = String(value || '')
  const homePrefix = text.startsWith('$HOME/') ? '$HOME/' : text.startsWith('~/') ? '~/' : ''
  if (!homePrefix) return shellQuote(text)
  const rest = text.slice(homePrefix.length)
  return `"${homePrefix === '~/' ? '$HOME/' : homePrefix}${rest.replace(/["\\$`]/g, '\\$&')}"`
}

/** 安装脚本：只装 dsh-x-core 本体；数据目录/配置目录由启动参数固定。 */
export function buildRemoteCoreInstallScript(options = {}) {
  const version = String(options.version || '').trim()
  if (!VERSION_RE.test(version)) throw new Error('核心版本号不合法')
  const root = String(options.installRoot || `${DEFAULT_INSTALL_ROOT}/${version}`)
  const spec = String(options.packageSpec || `dsh-x-core@${version}`)
  return [
    'set -eu',
    `root=${shellPath(root)}`,
    'target="$root/node_modules/dsh-x-core/start.js"',
    'if [ -f "$target" ]; then printf \'__DSHX_CORE_READY__\\n\'; exit 0; fi',
    'mkdir -p "$root"',
    'cd "$root"',
    "printf '%s\\n' '{\"name\":\"dsh-x-remote-core\",\"private\":true}' > package.json",
    `npm install --no-audit --no-fund --loglevel=error ${shellQuote(spec)}`,
    'test -f "$target"',
    'printf \'__DSHX_CORE_INSTALLED__\\n\'',
  ].join('\n')
}

/** 启动脚本：固定 XDG 配置目录 + 端口，前台 exec，stdout 里会有 token 行。 */
export function buildRemoteCoreStartScript(options = {}) {
  const version = String(options.version || '').trim()
  if (!VERSION_RE.test(version)) throw new Error('核心版本号不合法')
  const root = String(options.installRoot || `${DEFAULT_INSTALL_ROOT}/${version}`)
  const configRoot = String(options.configRoot || DEFAULT_CONFIG_ROOT)
  const port = Number(options.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('核心端口不合法')
  const exports = buildExportsScript(options.env || {})
  return [
    exports,
    `cd ${shellPath(root)}`,
    `XDG_CONFIG_HOME=${shellPath(configRoot)} PORT=${port} DSH_NO_OPEN=1 exec node node_modules/dsh-x-core/start.js`,
  ].filter(Boolean).join('\n')
}

/** 从 core 的 stdout 里认 ready 行；返回 null 表示还没到。 */
export function parseRemoteCoreReady(text) {
  const match = CORE_READY_RE.exec(String(text || ''))
  if (!match) return null
  return { port: Number(match[1]), token: match[2] }
}

/**
 * 一个 WSL 里的 dsh-x-core。安装和启停都走 `wsl.exe`，HTTP 请求走 localhost 转发。
 * 同一台发行版/用户只会有一个实例；多开由 core 自己的启动项管理。
 */
export class WslRemoteCore {
  constructor(options = {}) {
    this.distro = String(options.distro || '').trim()
    this.user = String(options.user || '').trim()
    this.version = String(options.version || '').trim()
    if (!this.distro) throw new Error('先选择一个 WSL 发行版')
    if (!VERSION_RE.test(this.version)) throw new Error('核心版本号不合法')
    this.installRoot = String(options.installRoot || `${DEFAULT_INSTALL_ROOT}/${this.version}`)
    this.configRoot = String(options.configRoot || DEFAULT_CONFIG_ROOT)
    this.packageSpec = String(options.packageSpec || `dsh-x-core@${this.version}`)
    this.proxy = options.proxy || null
    this.port = Number(options.port) || 0
    this.backend = options.backend || createWslBackend({ distro: this.distro, user: this.user, exe: options.exe, run: options.run })
    this.spawnChild = options.spawn || spawn
    this.child = null
    this.token = ''
    this.baseUrl = ''
    this.cookie = ''
    this.starting = null
    this.output = ''
  }

  get running() {
    return Boolean(this.child && this.baseUrl)
  }

  async install() {
    const identity = await this.backend.resolveIdentity()
    const proxy = await this.backend.resolveRuntimeProxy(this.proxy?.url ?? this.proxy ?? '')
    const env = proxy.via === 'unreachable' || proxy.via === 'none'
      ? {}
      : { ...proxyEnv({ url: proxy.url, bypass: [] }), NODE_USE_ENV_PROXY: '1' }
    const script = buildRemoteCoreInstallScript({
      version: this.version,
      installRoot: this.installRoot,
      packageSpec: this.packageSpec,
    })
    const result = await this.backend.exec([buildExportsScript(env), script].filter(Boolean).join('\n'), {
      identity,
      timeoutMs: 15 * 60 * 1000,
    })
    if (!result.ok) {
      // wsl.exe 的 localhost 代理警告和 npm 的真实错误可能分别落在 stderr/stdout；
      // 两边都取，过滤掉警告，别让「找不到原因」只显示一行警告。
      const text = [result.stderr, result.stdout]
        .map((value) => String(value || ''))
        .join('\n')
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/localhost.*代理|localhost proxy/i.test(line))
        .slice(-8)
        .join('\n')
      throw new Error(`在 WSL 里安装 dsh-x-core ${this.version} 失败：${text || '没有输出'}`)
    }
    return { ok: true, installed: String(result.stdout || '').includes('__DSHX_CORE_INSTALLED__') }
  }

  async ensureInstalled() {
    if (this._installed) return
    await this.install()
    this._installed = true
  }

  async start(options = {}) {
    if (this.running) return this
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.ensureInstalled()
      const port = await allocateWslPort(this.distro, this.port || 0, localPortAvailable)
      this.port = port
      const proxy = await this.backend.resolveRuntimeProxy(options.proxy?.url ?? options.proxy ?? '')
      const env = proxy.via === 'unreachable' || proxy.via === 'none'
        ? {}
        : { ...proxyEnv({ url: proxy.url, bypass: options.proxy?.bypass || [] }), NODE_USE_ENV_PROXY: '1' }
      const script = buildRemoteCoreStartScript({
        version: this.version,
        installRoot: this.installRoot,
        configRoot: this.configRoot,
        port,
        env,
      })
      const child = this.spawnChild(WSL_EXE, buildWslArgs({ distro: this.distro, user: this.user }, ['bash', '-lc', script]), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
      })
      this.child = child
      this.output = ''
      const ready = new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error(`等待 WSL 里的 dsh-x-core 就绪超时（端口 ${port}）`)), 45000)
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }
        const onData = (chunk) => {
          this.output += chunk.toString('utf8')
          const parsed = parseRemoteCoreReady(this.output)
          if (parsed) {
            this.port = parsed.port
            this.token = parsed.token
            this.baseUrl = `http://127.0.0.1:${parsed.port}`
            finish(null, parsed)
          }
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        child.once('error', (error) => finish(error))
        child.once('close', (code) => {
          this.child = null
          if (!this.baseUrl) finish(new Error(`WSL 里的 dsh-x-core 启动失败（退出码 ${code}）：${this.output.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')}`))
        })
      })
      await ready
      await this.request('/api/state', { timeoutMs: 10000 })
      return this
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async ensureCookie() {
    if (this.cookie) return
    const base = this.baseUrl
    if (!base || !this.token) throw new Error('远端 core 还没就绪')
    let lastError = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await fetch(`${base}/?token=${encodeURIComponent(this.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
        const setCookie = response.headers.get('set-cookie')
        if (!setCookie) throw new Error(`远端 core 没有返回会话 cookie（HTTP ${response.status}）`)
        this.cookie = String(setCookie).split(';')[0]
        return
      } catch (error) {
        // WSL 的 localhost 转发比 core 自己 bind 晚一拍；刚 ready 的几百毫秒内 fetch 会失败。
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    throw lastError || new Error('连不上远端 core')
  }

  /** 带 cookie 的 HTTP 请求；401 时重换一次 cookie。 */
  async request(path, options = {}) {
    await this.ensureCookie()
    const send = async () => fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), cookie: this.cookie },
      signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
    })
    let response = await send()
    if (response.status === 401) {
      this.cookie = ''
      await this.ensureCookie()
      response = await send()
    }
    return response
  }

  async json(path, options = {}) {
    const response = await this.request(path, options)
    const text = await response.text()
    if (!response.ok) throw new Error(`远端 core ${path} 返回 ${response.status}：${text.slice(0, 400)}`)
    return text ? JSON.parse(text) : {}
  }

  async stop() {
    try {
      if (this.running) {
        await this.request('/api/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 5000 })
      }
    } catch { /* core 可能已经退出 */ }
    const child = this.child
    this.child = null
    this.baseUrl = ''
    this.token = ''
    this.cookie = ''
    if (!child) return
    const closed = new Promise((resolve) => child.once('close', resolve))
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))])
    try { child.kill() } catch { /* 已经退出 */ }
  }
}

const cores = new Map()

/** 一个 WSL 发行版/用户只保留一个 core 实例；重复调用拿到同一个。 */
export function getWslRemoteCore(options = {}) {
  const distro = String(options.distro || '').trim()
  const user = String(options.user || '').trim()
  const version = String(options.version || '').trim()
  const key = `${distro}\0${user}\0${version}`
  let core = cores.get(key)
  if (!core) {
    core = new WslRemoteCore({ ...options, distro, user, version })
    cores.set(key, core)
  }
  return core
}

export async function stopAllRemoteCores() {
  const list = [...cores.values()]
  cores.clear()
  await Promise.allSettled(list.map((core) => core.stop()))
}
