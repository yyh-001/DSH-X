/**
 * SSH 版远端 core：和 WSL 一样，在远端跑 dsh-x-core，本地页面通过隧道访问。
 *
 * 和 WSL 实现的两个差别：
 * - 安装不走 npm：把本地 core tarball 上传后直接 tar 解压，远端不需要 npm；
 * - 远端 core 监听一个远端回环端口，本地用 ssh2 的 direct-tcpip 隧道接到 127.0.0.1。
 */
import { existsSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadCoreTarball, fetchCoreMetadata } from './core-npm.js'
import { buildExportsScript, remoteError, REMOTE_REASON, shellQuote } from './remote.js'
import { parseRemoteCoreReady } from './remote-core.js'
import { proxyEnv } from './proxy.js'
import { createSshBackend } from './ssh.js'
import { VERSION_RE } from './settings.js'

const DEFAULT_INSTALL_ROOT = '~/.dsh-x/ssh-core'
const DEFAULT_CONFIG_ROOT = '~/.dsh-x/core-config'
const REMOTE_NODE_VERSION = '24.22.3'

function resolveRemoteHomePath(value, home) {
  const text = String(value || '').trim() || '~/.dsh'
  if (text === '~') return home
  if (text.startsWith('~/')) return `${home}/${text.slice(2)}`.replace(/\/+/g, '/')
  return text
}

/** 远端架构名映射到 nodejs.org 的发行包命名。 */
function nodeArch(unameArch) {
  const value = String(unameArch || '').toLowerCase()
  if (/^(x86_64|amd64)$/.test(value)) return 'x64'
  if (/^(aarch64|arm64)$/.test(value)) return 'arm64'
  return ''
}

/** 本地 core tarball：优先 DSH_CORE_TARBALL / release 目录，否则从 npm 下载。 */
async function resolveLocalCoreTarball(version, { cacheDir = tmpdir(), source = 'official' } = {}) {
  const direct = String(process.env.DSH_CORE_TARBALL || '').trim()
  if (direct && existsSync(direct)) return direct
  const candidates = [
    join(cacheDir, `dsh-x-core-${version}.tgz`),
    join(process.cwd(), 'release', `dsh-x-core-${version}.tgz`),
    join(tmpdir(), `dsh-x-core-${version}.tgz`),
  ]
  for (const file of candidates) if (existsSync(file)) return file
  const metadata = await fetchCoreMetadata({ source })
  const info = metadata?.versions?.[version] || null
  if (!info?.dist?.tarball) throw remoteError(REMOTE_REASON.sshCoreInstallFailed, `找不到 core ${version} 的安装包`)
  await downloadCoreTarball(info.dist.tarball, candidates[0], { integrity: info.dist.integrity, shasum: info.dist.shasum })
  return candidates[0]
}

/** 远端 node 满足 dsh 的 engines（>=24.9）就用系统 node；否则下载固定版本到 ~/.dsh-x/node。 */
async function ensureRemoteNode(backend) {
  const probe = await backend.exec('command -v node >/dev/null 2>&1 && node -p "process.versions.node" || true', { timeoutMs: 10000 })
  const version = String(probe.stdout || '').trim()
  if (version) {
    const [major, minor] = version.split('.').map((part) => Number(part) || 0)
    if (major > 24 || (major === 24 && minor >= 9)) return { node: 'node', version, downloaded: false }
  }
  const identity = await backend.resolveIdentity()
  const home = identity.home
  if (!home) throw remoteError(REMOTE_REASON.sshNodeMissing, '读不到远端 HOME，无法安装 Node')
  const system = await backend.detect()
  const arch = nodeArch(system.arch)
  if (!arch) throw remoteError(REMOTE_REASON.sshNodeDownloadFailed, `远端架构 ${system.arch || '未知'} 暂不支持自动下载 Node`)
  const baseDir = `${home.replace(/\/+$/, '')}/.dsh-x`
  const dir = `${baseDir}/node/node-v${REMOTE_NODE_VERSION}-linux-${arch}`
  const nodeBin = `${dir}/bin/node`
  const check = await backend.exec(`test -x ${shellQuote(nodeBin)} && ${shellQuote(nodeBin)} -v || true`, { timeoutMs: 10000 })
  if (String(check.stdout || '').trim().startsWith('v')) return { node: nodeBin, version: String(check.stdout).trim().slice(1), downloaded: true }
  const tools = await backend.exec('command -v curl || command -v wget; command -v tar; command -v sha256sum || command -v shasum', { timeoutMs: 10000 })
  const toolText = String(tools.stdout || '')
  if (!/(curl|wget)/.test(toolText) || !/tar/.test(toolText) || !/(sha256sum|shasum)/.test(toolText)) {
    throw remoteError(REMOTE_REASON.sshNodeMissing, '远端缺少 curl/wget、tar 或 sha256sum，无法安全地自动安装 Node')
  }
  const file = `node-v${REMOTE_NODE_VERSION}-linux-${arch}.tar.xz`
  const base = `https://nodejs.org/dist/v${REMOTE_NODE_VERSION}`
  const cache = `${baseDir}/cache`
  const script = [
    'set -eu',
    `mkdir -p ${shellQuote(cache)} ${shellQuote(`${baseDir}/node`)}`,
    `cd ${shellQuote(cache)}`,
    `if ! [ -f ${shellQuote(file)} ]; then`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL -o ${shellQuote(file)} ${shellQuote(`${base}/${file}`)};`,
    `  else wget -qO ${shellQuote(file)} ${shellQuote(`${base}/${file}`)}; fi`,
    'fi',
    `if command -v sha256sum >/dev/null 2>&1; then`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL -o SHASUMS256.txt ${shellQuote(`${base}/SHASUMS256.txt`)}; else wget -qO SHASUMS256.txt ${shellQuote(`${base}/SHASUMS256.txt`)}; fi`,
    `  grep ${shellQuote(` ${file}$`)} SHASUMS256.txt > node.sha256 && sha256sum -c node.sha256`,
    'fi',
    `tar -xJf ${shellQuote(file)} -C ${shellQuote(`${baseDir}/node`)}`,
    `test -x ${shellQuote(nodeBin)}`,
    `${shellQuote(nodeBin)} -v`,
  ].join('\n')
  const result = await backend.exec(script, { timeoutMs: 10 * 60 * 1000 })
  if (!result.ok) {
    throw remoteError(REMOTE_REASON.sshNodeDownloadFailed, `远端 Node ${REMOTE_NODE_VERSION} 安装失败：${(result.stderr || result.stdout || '').split(/\r?\n/).filter(Boolean).slice(-4).join('\n')}`)
  }
  return { node: nodeBin, version: REMOTE_NODE_VERSION, downloaded: true }
}

export class SshRemoteCore {
  constructor(options = {}) {
    this.connection = options.connection
    if (!this.connection?.id) throw new Error('SSH 连接不合法')
    this.version = String(options.version || '').trim()
    if (!VERSION_RE.test(this.version)) throw new Error('核心版本号不合法')
    this.backend = options.backend || createSshBackend(this.connection, options.secrets || {})
    this.installRoot = String(options.installRoot || `${DEFAULT_INSTALL_ROOT}/${this.version}`)
    this.configRoot = String(options.configRoot || DEFAULT_CONFIG_ROOT)
    this.source = options.source || 'official'
    this.cacheDir = options.cacheDir || tmpdir()
    this.child = null
    this.tunnel = null
    this.port = 0
    this.token = ''
    this.baseUrl = ''
    this.cookie = ''
    this.output = ''
    this.starting = null
    this._installed = false
    this.logListeners = new Set()
    this.logFollowing = false
    this.logRequest = null
  }

  get running() {
    return Boolean(this.child && this.baseUrl)
  }

  async inspectInstall() {
    const identity = await this.backend.resolveIdentity()
    const root = resolveRemoteHomePath(this.installRoot, identity.home)
    this.root = root
    const probe = await this.backend.exec(`test -f ${shellQuote(`${root}/start.js`)} && printf installed || true`, { timeoutMs: 10000 })
    return { installed: String(probe.stdout || '').includes('installed'), root, identity }
  }

  async install(options = {}) {
    const identity = await this.backend.resolveIdentity()
    const root = resolveRemoteHomePath(this.installRoot, identity.home)
    this.root = root
    const probe = await this.backend.exec(`test -f ${shellQuote(`${root}/start.js`)} && printf installed || true`, { timeoutMs: 10000 })
    if (String(probe.stdout || '').includes('installed')) return { ok: true, installed: false }
    options.onProgress?.({ label: '正在准备安装包…' })
    options.onLog?.(`开始上传 dsh-x-core ${this.version}`)
    const tarball = await resolveLocalCoreTarball(this.version, { cacheDir: this.cacheDir, source: this.source })
    const data = readFileSync(tarball)
    options.onProgress?.({ percent: 20, label: '正在上传安装包' })
    await this.backend.exec(`mkdir -p ${shellQuote(root)}`, { timeoutMs: 10000 })
    await this.backend.upload(data, `${root}/core.tgz`, { timeoutMs: 10 * 60 * 1000 })
    options.onProgress?.({ percent: 75, label: '正在解压安装包' })
    const script = [
      'set -eu',
      `cd ${shellQuote(root)}`,
      'tar -xzf core.tgz --strip-components=1',
      'test -f start.js',
      'rm -f core.tgz',
      "printf '__DSHX_CORE_INSTALLED__\\n'",
    ].join('\n')
    const result = await this.backend.exec(script, { timeoutMs: 10 * 60 * 1000 })
    if (!result.ok) {
      throw remoteError(REMOTE_REASON.sshCoreInstallFailed, `在 SSH 主机上安装 dsh-x-core 失败：${(result.stderr || result.stdout || '').split(/\r?\n/).filter(Boolean).slice(-6).join('\n')}`)
    }
    options.onProgress?.({ percent: 100, label: '安装完成' })
    options.onLog?.(`dsh-x-core ${this.version} 安装完成`)
    return { ok: true, installed: true }
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
      const identity = await this.backend.resolveIdentity()
      const root = this.root || resolveRemoteHomePath(this.installRoot, identity.home)
      this.root = root
      const configRoot = resolveRemoteHomePath(this.configRoot, identity.home)
      const node = await ensureRemoteNode(this.backend)
      const pick = await this.backend.exec(`${shellQuote(node.node)} -e ${shellQuote("const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})")}`, { timeoutMs: 10000 })
      const port = Number(String(pick.stdout || '').trim())
      if (!port) throw remoteError(REMOTE_REASON.sshFailed, '远端没有分配到可用端口')
      this.port = port
      const proxy = await this.backend.resolveRuntimeProxy(options.proxy?.url ?? options.proxy ?? '')
      const env = proxy.via === 'unreachable' || proxy.via === 'none'
        ? {}
        : { ...proxyEnv({ url: proxy.url, bypass: [] }), NODE_USE_ENV_PROXY: '1' }
      const script = [
        buildExportsScript(env),
        `cd ${shellQuote(root)}`,
        `XDG_CONFIG_HOME=${shellQuote(configRoot)} PORT=${port} DSH_NO_OPEN=1 exec ${shellQuote(node.node)} start.js`,
      ].filter(Boolean).join('\n')
      const child = await this.backend.stream(script)
      this.child = child
      this.output = ''
      const ready = new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error(`等待 SSH 远端 dsh-x-core 就绪超时（端口 ${port}）`)), 60000)
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }
        const onData = (chunk) => {
          this.output += Buffer.from(chunk).toString('utf8')
          const parsed = parseRemoteCoreReady(this.output)
          if (parsed) {
            this.port = parsed.port
            this.token = parsed.token
            finish(null, parsed)
          }
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        child.once?.('close', (code) => {
          this.child = null
          if (!this.token) finish(new Error(`SSH 远端 dsh-x-core 启动失败（退出码 ${code}）：${this.output.split(/\r?\n/).filter(Boolean).slice(-6).join('\n')}`))
        })
      })
      await ready
      this.tunnel = await this.backend.openTunnel(this.port)
      this.baseUrl = `http://127.0.0.1:${this.tunnel.port}`
      await this.request('/api/state', { timeoutMs: 10000 })
      return this
    })()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * 隧道会把本地端口换成临时端口；Host 必须保持「远端 core 自己的 127.0.0.1:port」，
   * 否则 manager-auth 的 Host 校验会 403、cookie 也会绑到错的 authority。
   */
  rawRequest(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
      host: `127.0.0.1:${this.port}`,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        timeout: options.timeoutMs || 30000,
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('timeout', () => req.destroy(new Error(`请求远端 core 超时（${path}）`)))
      req.on('error', reject)
      if (options.body !== undefined) req.write(options.body)
      req.end()
    })
  }

  async ensureCookie() {
    if (this.cookie) return
    if (!this.baseUrl || !this.token) throw new Error('远端 core 还没就绪')
    let lastError = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await this.rawRequest(`/?token=${encodeURIComponent(this.token)}`, { timeoutMs: 10000 })
        const setCookie = response.headers['set-cookie']
        const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
        if (!value) throw new Error(`远端 core 没有返回会话 cookie（HTTP ${response.status}）`)
        this.cookie = String(value).split(';')[0]
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    throw lastError || new Error('连不上远端 core')
  }

  async request(path, options = {}) {
    await this.ensureCookie()
    const send = () => this.rawRequest(path, options)
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
    if (!response.ok) throw new Error(`远端 core ${path} 返回 ${response.status}：${response.text.slice(0, 400)}`)
    return response.text ? JSON.parse(response.text) : {}
  }

  /**
   * 订阅远端 core 的日志流（SSE）。dsh 的 stdout/stderr 只落在远端 core 的
   * manager.log 里，本机启动项日志要看到它就得从这条流抄回来。
   * 返回取消订阅函数；core 退出时内部会自己收尾。
   */
  followLogs(listener) {
    if (typeof listener !== 'function') return () => {}
    this.logListeners.add(listener)
    this.followCoreLogs()
    return () => { this.logListeners.delete(listener) }
  }

  async followCoreLogs() {
    if (this.logFollowing || !this.running) return
    this.logFollowing = true
    const loop = async () => {
      while (this.logFollowing) {
        try {
          await this.streamLogs()
        } catch {
          // core 可能刚好在重启/退出，下一轮再连；真退了 running 会变 false。
        }
        if (!this.logFollowing) break
        if (!this.baseUrl) break
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    void loop()
  }

  async streamLogs() {
    await this.ensureCookie()
    if (!this.logFollowing || !this.baseUrl) return
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        if (this.logRequest === req) this.logRequest = null
        if (error) reject(error)
        else resolve()
      }
      const req = httpRequest(`${this.baseUrl}/api/events`, {
        method: 'GET',
        headers: {
          host: `127.0.0.1:${this.port}`,
          cookie: this.cookie,
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          if (res.statusCode === 401) this.cookie = ''
          res.resume()
          done(new Error(`远端 core 日志流 HTTP ${res.statusCode}`))
          return
        }
        res.setEncoding('utf8')
        let buffer = ''
        let firstLogBatch = true
        res.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
            if (event !== 'log') continue
            // 连上时的第一批是最近 120 行历史；启动前发生的行没必要再灌进启动项日志。
            if (firstLogBatch) { firstLogBatch = false; continue }
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
            if (!data) continue
            let parsed
            try { parsed = JSON.parse(data) } catch { continue }
            for (const line of Array.isArray(parsed?.lines) ? parsed.lines : []) {
              for (const listener of [...this.logListeners]) {
                try { listener(String(line)) } catch { /* 单个订阅者出错不影响其它 */ }
              }
            }
          }
        })
        res.on('end', () => done(null))
        res.on('error', done)
      })
      req.on('error', done)
      this.logRequest = req
      req.end()
    })
  }

  async stop() {
    this.logFollowing = false
    try { this.logRequest?.destroy() } catch { /* 已经断开 */ }
    this.logRequest = null
    this.logListeners.clear()
    try {
      if (this.running) {
        await this.request('/api/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 5000 })
      }
    } catch { /* core 可能已经退出 */ }
    this.tunnel?.close()
    this.tunnel = null
    this.child?.kill?.()
    this.child = null
    this.baseUrl = ''
    this.token = ''
    this.cookie = ''
    await this.backend.disposeAndWait?.()
  }
}

const sshCores = new Map()

export function getSshRemoteCore(options = {}) {
  const id = String(options.connection?.id || '').trim()
  const version = String(options.version || '').trim()
  const key = `${id}\0${version}`
  let core = sshCores.get(key)
  if (!core) {
    core = new SshRemoteCore({ ...options, connection: options.connection, version })
    sshCores.set(key, core)
  }
  return core
}

export async function stopAllSshRemoteCores() {
  const list = [...sshCores.values()]
  sshCores.clear()
  await Promise.allSettled(list.map((core) => core.stop()))
}

/** 连接被编辑/删除时，丢掉它名下的远端 core，别拿旧主机/旧凭据继续跑。 */
export async function stopSshRemoteCore(connectionId) {
  const prefix = `${String(connectionId || '').trim()}\0`
  const targets = [...sshCores.entries()].filter(([key]) => key.startsWith(prefix))
  for (const [key] of targets) sshCores.delete(key)
  await Promise.allSettled(targets.map(([, core]) => core.stop()))
}

export { resolveRemoteHomePath, ensureRemoteNode }
