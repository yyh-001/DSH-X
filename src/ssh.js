/**
 * SSH transport：把 `ssh2` 包成和 WSL 相同的 RemoteBackend。
 *
 * 只用纯 JS 的 ssh2（不依赖原生编译）；密码/私钥口令由 server 解密后传进来，
 * 这里不读 settings、不写日志。host key 采用 TOFU：第一次连接记录 SHA256 指纹，
 * 之后指纹变了直接拒绝，必须由用户在连接编辑里明确换指纹。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { buildIdentityScript, parseIdentityOutput, remoteError, REMOTE_REASON, shellQuote } from './remote.js'
import { IS_WINDOWS } from './platform.js'

let ssh2Promise = null
/** ssh2 只在真正用 SSH 时加载：WSL 用户和没装依赖的打包测试不 import 它也能起服务。 */
function loadSsh2() {
  if (!ssh2Promise) ssh2Promise = import('ssh2')
  return ssh2Promise
}

function fingerprintOf(key) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

function errorCodeOf(error) {
  const message = String(error?.message || error || '')
  if (/authentication|All configured authentication methods failed|Permission denied/i.test(message)) return REMOTE_REASON.sshAuthFailed
  if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timeout|Timed out|connect/i.test(message)) return REMOTE_REASON.sshUnreachable
  return REMOTE_REASON.sshFailed
}

function authFailureText(code) {
  return code === REMOTE_REASON.sshAuthFailed
    ? 'SSH 认证失败：请检查用户名、密码或私钥（密码错误时也会落到这里）'
    : code === REMOTE_REASON.sshUnreachable
      ? '连不上 SSH 主机：请检查地址、端口和网络'
      : 'SSH 连接失败'
}

/**
 * @param {object} connection 连接配置（不含明文凭据）
 * @param {{ password?: string, passphrase?: string }} secrets 已解密的凭据
 */
export function createSshBackend(connection, { password = '', passphrase = '' } = {}) {
  const state = {
    client: null,
    connecting: null,
    identity: null,
    hostKeyFingerprint: String(connection.hostKeyFingerprint || ''),
    capturedFingerprint: '',
    hostKeyChanged: null,
    tunnels: new Map(),
  }
  const owned = new Set()

  function connect() {
    if (state.client) return Promise.resolve(state.client)
    if (state.connecting) return state.connecting
    state.connecting = loadSsh2().then(({ Client }) => new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        state.connecting = null
        if (error) {
          try { client.end() } catch { /* 已经断开 */ }
          reject(error)
        } else {
          state.client = client
          resolve(client)
        }
      }
      const config = {
        host: connection.host,
        port: Number(connection.port) || 22,
        username: connection.username,
        readyTimeout: 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
      }
      if (connection.authType === 'password') {
        config.password = password
      } else if (connection.authType === 'key') {
        try {
          config.privateKey = readFileSync(connection.privateKeyPath)
        } catch (error) {
          finish(remoteError(REMOTE_REASON.sshAuthFailed, `读不到私钥：${connection.privateKeyPath}（${error.message}）`))
          return
        }
        if (passphrase) config.passphrase = passphrase
      } else if (connection.authType === 'agent') {
        config.agent = process.env.SSH_AUTH_SOCK || (IS_WINDOWS ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
      }
      config.hostVerifier = (key) => {
        const fingerprint = fingerprintOf(key)
        state.capturedFingerprint = fingerprint
        if (state.hostKeyFingerprint && fingerprint !== state.hostKeyFingerprint) {
          state.hostKeyChanged = { expected: state.hostKeyFingerprint, actual: fingerprint }
          return false
        }
        return true
      }
      // 服务器用 keyboard-interactive 做密码/OTP 时，把密码作为回答；OTP 需要用户自己处理，
      // 这里只回密码，避免把错误的东西填进一次性验证码。
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
        done((Array.isArray(prompts) ? prompts : []).map(() => password))
      })
      client.once('ready', () => finish())
      client.once('error', (error) => {
        if (state.hostKeyChanged) {
          finish(remoteError(REMOTE_REASON.sshHostKeyChanged,
            `SSH 主机指纹变了（原 ${state.hostKeyChanged.expected}，现在 ${state.hostKeyChanged.actual}）。` +
            '如果不是你自己换了主机，先别继续连接；确认无误后在连接编辑里点「信任新指纹」。'))
          return
        }
        const code = errorCodeOf(error)
        finish(remoteError(code, `${authFailureText(code)}（${error.message}）`, { cause: error }))
      })
      try {
        client.connect(config)
      } catch (error) {
        const code = errorCodeOf(error)
        finish(remoteError(code, `${authFailureText(code)}（${error.message}）`, { cause: error }))
      }
    })).catch((error) => {
      state.connecting = null
      throw error
    })
    return state.connecting
  }

  async function exec(script, opts = {}) {
    const client = await connect()
    const timeoutMs = opts.timeoutMs || 20000
    return new Promise((resolve) => {
      let settled = false
      let channel = null
      const out = []
      const err = []
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve({ ...result, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      }
      const timer = setTimeout(() => {
        try { channel?.close() } catch { /* 已关闭 */ }
        finish({ ok: false, code: null, timedOut: true })
      }, timeoutMs)
      try {
        client.exec(String(script), { env: opts.env || {} }, (error, stream) => {
          if (error) {
            clearTimeout(timer)
            finish({ ok: false, code: null, error })
            return
          }
          channel = stream
          let exitCode = null
          stream.on('data', (chunk) => out.push(Buffer.from(chunk)))
          stream.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)))
          stream.once('exit', (code) => { exitCode = code })
          stream.once('close', () => {
            clearTimeout(timer)
            // 有些服务器只在 exit event 里给退出码；close 时还没收到就按成功处理（stderr 仍保留）。
            finish({ ok: exitCode === null || exitCode === 0, code: exitCode })
          })
          stream.once('error', (streamError) => {
            clearTimeout(timer)
            finish({ ok: false, code: null, error: streamError })
          })
        })
      } catch (error) {
        clearTimeout(timer)
        finish({ ok: false, code: null, error })
      }
    })
  }

  /** 长命令的流式句柄：和 child_process 的 stdout/stderr/once/kill 形状保持一致。 */
  async function stream(script) {
    const client = await connect()
    const channel = await new Promise((resolve, reject) => {
      client.exec(String(script), { env: {} }, (error, stream) => error ? reject(error) : resolve(stream))
    })
    owned.add(channel)
    const cleanup = () => owned.delete(channel)
    channel.once('close', cleanup)
    channel.once('error', cleanup)
    return {
      stdout: channel.stdout,
      stderr: channel.stderr,
      once: (...args) => channel.once(...args),
      on: (...args) => channel.on(...args),
      kill: () => { try { channel.close() } catch { /* 已关闭 */ } },
    }
  }

  async function upload(data, remotePath, opts = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
    const target = String(remotePath || '').trim()
    if (!target.startsWith('/')) throw new Error('SSH 上传目标要用绝对路径')
    const dir = target.slice(0, target.lastIndexOf('/')) || '/'
    const prepared = await exec(`mkdir -p ${shellQuote(dir)}`, { timeoutMs: opts.timeoutMs || 20000 })
    if (!prepared.ok) throw remoteError(REMOTE_REASON.sshFailed, `在远端建目录失败：${prepared.stderr || prepared.stdout}`)
    const client = await connect()
    await new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) { reject(error); return }
        sftp.writeFile(target, buffer, { mode: 0o600 }, (writeError) => {
          sftp.end()
          if (writeError) reject(writeError)
          else resolve()
        })
      })
    })
  }

  async function exists(path, opts = {}) {
    const result = await exec(`test -e ${shellQuote(path)} && printf yes || printf no`, { timeoutMs: opts.timeoutMs || 8000 })
    if (!result.ok) throw remoteError(REMOTE_REASON.sshFailed, result.stderr || result.stdout || 'SSH 命令失败')
    return result.stdout.trim() === 'yes'
  }

  async function isDirectory(path, opts = {}) {
    const result = await exec(`test -d ${shellQuote(path)} && printf yes || printf no`, { timeoutMs: opts.timeoutMs || 8000 })
    if (!result.ok) throw remoteError(REMOTE_REASON.sshFailed, result.stderr || result.stdout || 'SSH 命令失败')
    return result.stdout.trim() === 'yes'
  }

  async function readFile(path, opts = {}) {
    const result = await exec(`cat -- ${shellQuote(path)}`, { timeoutMs: opts.timeoutMs || 20000 })
    if (!result.ok) throw remoteError(REMOTE_REASON.sshFailed, result.stderr || result.stdout || 'SSH 命令失败')
    return result.stdout
  }

  async function resolveIdentity(opts = {}) {
    if (state.identity && !opts.force) return state.identity
    const result = await exec(buildIdentityScript(), { timeoutMs: opts.timeoutMs || 15000 })
    if (!result.ok) throw remoteError(REMOTE_REASON.sshFailed, `无法读取 SSH 身份：${result.stderr || result.stdout}`)
    const parsed = parseIdentityOutput(result.stdout)
    if (!parsed.ok) throw remoteError(REMOTE_REASON.sshFailed, `无法解析 SSH 身份：${parsed.error}`)
    state.identity = { distro: 'ssh', user: parsed.user, home: parsed.home, version: null }
    return state.identity
  }

  async function detect() {
    const result = await exec('uname -s; uname -m', { timeoutMs: 10000 })
    if (!result.ok) throw remoteError(REMOTE_REASON.sshFailed, result.stderr || '读不到远端系统信息')
    const [platform = '', arch = ''] = result.stdout.split(/\r?\n/).map((line) => line.trim())
    return { platform: platform.toLowerCase(), arch: arch.toLowerCase() }
  }

  async function resolveRuntimeProxy() {
    // 本机的代理地址对 SSH 远端不可见；不把 127.0.0.1 代理注入远端，远端要代理请在自己的环境里配。
    return { url: '', via: 'none' }
  }

  /**
   * 在 127.0.0.1 上开一个本地端口，每次连接用 ssh2 的 direct-tcpip channel 转到远端回环端口。
   * 远端 core 的 cookie/HTTP 客户端因此完全不用改。
   */
  async function openTunnel(remotePort) {
    const target = Number(remotePort)
    if (state.tunnels.has(target)) return state.tunnels.get(target)
    const client = await connect()
    const sockets = new Set()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', target, (error, stream) => {
        if (error) { socket.destroy(); return }
        socket.pipe(stream).pipe(socket)
        stream.once('close', () => socket.destroy())
        socket.once('error', () => stream.destroy())
      })
    })
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    const tunnel = {
      port,
      close: () => {
        for (const socket of sockets) { try { socket.destroy() } catch { /* 已关闭 */ } }
        try { server.close() } catch { /* 已关闭 */ }
        state.tunnels.delete(target)
      },
    }
    state.tunnels.set(target, tunnel)
    return tunnel
  }

  function dispose() {
    for (const tunnel of state.tunnels.values()) tunnel.close()
    state.tunnels.clear()
    for (const channel of owned) { try { channel.close() } catch { /* 已关闭 */ } }
    owned.clear()
    const client = state.client
    state.client = null
    state.connecting = null
    state.identity = null
    try { client?.end() } catch { /* 已断开 */ }
  }

  async function disposeAndWait() {
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return {
    kind: 'ssh',
    available: () => Boolean(connection.host && connection.username),
    connect,
    exec,
    stream,
    upload,
    exists,
    isDirectory,
    readFile,
    detect,
    resolveIdentity,
    resolveRuntimeProxy,
    openTunnel,
    dispose,
    disposeAndWait,
    get hostKeyFingerprint() { return state.capturedFingerprint || state.hostKeyFingerprint },
    get hostKeyChanged() { return state.hostKeyChanged },
  }
}

/** 一次性测试连接：连上、读身份、返回指纹；失败时抛带 reasonCode 的错误。 */
export async function testSshConnection(connection, secrets) {
  const backend = createSshBackend(connection, secrets)
  try {
    const identity = await backend.resolveIdentity({ force: true })
    const system = await backend.detect().catch(() => ({ platform: '', arch: '' }))
    return {
      kind: 'ssh',
      user: identity.user,
      home: identity.home,
      hostKeyFingerprint: backend.hostKeyFingerprint,
      platform: system.platform,
      arch: system.arch,
    }
  } finally {
    await backend.disposeAndWait()
  }
}
