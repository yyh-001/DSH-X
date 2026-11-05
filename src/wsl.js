/*
MIT License

Copyright (c) 2026 Nexus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { WSL_AGENT_SCRIPT, WSL_BRIDGE_SCRIPT, WSL_HELPER_SCRIPT, WSL_SYSTEMD_SCRIPT } from './wsl-scripts.js'

const WSL_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'wsl.exe')
  : 'C:\\Windows\\System32\\wsl.exe'
const HELPER_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine-.*|wslenv)$/i
const DEFAULT_HOME = '~/.dsh'
const SCRIPT_PATH = '$HOME/.dsh-x/bin/dsh-x-wsl.sh'

/** 启动方式：wrapper 由 wsl.exe 前台托管；systemd 由 WSL 内的 systemd user unit 托管。 */
export const WSL_SERVICE_MODES = ['wrapper', 'systemd']
export const WSL_SERVICE_MODE = 'wrapper'

export function normalizeWslServiceMode(value) {
  return value === 'systemd' ? 'systemd' : 'wrapper'
}

export function wslAvailable() {
  return process.platform === 'win32' && existsSync(WSL_EXE)
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 20000
  const raw = Boolean(options.raw)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ ok: false, code: null, stdout: raw ? Buffer.alloc(0) : '', stderr: String(error && error.message || error), error })
      return
    }
    const out = []
    const err = []
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = raw ? Buffer.concat(out) : Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      resolve(Object.assign({}, result, { stdout: stdout, stderr: stderr }))
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      finish({ ok: false, code: null, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => finish({ ok: false, code: null, error: error }))
    // 用 close 而不是 exit：exit 触发时 stdio 可能还没排空，探测输出会被截断。
    child.on('close', (code) => finish({ ok: code === 0, code: code }))
  })
}

/** wsl.exe --list 的输出是 UTF-16LE；bash 的输出是 UTF-8。中间用这个函数兜住两种。 */
export function decodeWslOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (!buf.length) return ''
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  // 用偶数位 NUL 的比例判断 UTF-16LE：中文文本的 UTF-16 也会在奇数位出现非零，所以只看 NUL。
  const sample = buf.subarray(0, Math.min(buf.length, 256))
  let zeros = 0
  for (let index = 1; index < sample.length; index += 2) if (sample[index] === 0) zeros += 1
  if (zeros >= Math.max(1, sample.length / 8)) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  return buf.toString('utf8')
}

/** 解析 wsl --list --verbose。名字里可能有空格，所以按两个以上空格切列。 */
export function parseWslDistroList(text) {
  const distros = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\u0000/g, '').trimEnd()
    if (!line.trim() || /^\s*NAME\s+STATE\s+VERSION\s*$/i.test(line)) continue
    const isDefault = /^\s*\*/.test(line)
    const body = line.replace(/^\s*\*\s*/, '').trim()
    let parts = body.split(/\s{2,}/).filter(Boolean)
    if (parts.length < 3) {
      const match = /^(.*?)\s+(Running|Stopped|Installing|Uninstalling|Converting)\s+(\d+)\s*$/i.exec(body)
      if (!match) continue
      parts = [match[1], match[2], match[3]]
    }
    const name = parts[0].trim()
    if (!name || HELPER_DISTRO_RE.test(name)) continue
    distros.push({ name: name, state: parts[1] || '', version: Number(parts[2]) || 2, default: isDefault })
  }
  return distros
}

let distroCache = { at: 0, value: null }
let distroRefresh = null
const inspectCache = new Map()
const systemdCache = new Map()

export async function listWslDistros(options = {}) {
  if (!wslAvailable()) return { available: false, distros: [], error: '当前不是 Windows，或找不到 wsl.exe' }
  if (!options.force && distroCache.value && Date.now() - distroCache.at < 10000) return distroCache.value
  const result = await runProcess(WSL_EXE, ['--list', '--verbose'], { timeoutMs: 15000, raw: true })
  if (!result.ok) {
    const value = { available: true, distros: [], error: result.stderr.trim() || (result.timedOut ? 'wsl --list 超时' : 'wsl --list 失败') }
    distroCache = { at: Date.now(), value: value }
    return value
  }
  const value = { available: true, distros: parseWslDistroList(decodeWslOutput(result.stdout)), error: '' }
  distroCache = { at: Date.now(), value: value }
  return value
}

/**
 * 给状态页/设置页用的非阻塞快照：有缓存就先返回旧值，过期了在后台刷新。
 * 管理页每 1-2 秒拉一次 /api/state，不能每次都等 wsl.exe；WSL 服务忙的时候
 * 一次 wsl --list 可能要几秒，会把整个接口拖到超时。
 */
export function wslDistroSnapshot() {
  if (!wslAvailable()) return { available: false, distros: [], error: '当前不是 Windows，或找不到 wsl.exe' }
  if (!distroCache.value) {
    refreshWslDistros()
    return { available: true, distros: [], error: '', pending: true }
  }
  if (Date.now() - distroCache.at >= 10000) refreshWslDistros()
  return distroCache.value
}

function refreshWslDistros() {
  if (distroRefresh) return
  distroRefresh = listWslDistros({ force: true })
    .catch(() => {})
    .finally(() => { distroRefresh = null })
}

export function invalidateWslCache() {
  distroCache = { at: 0, value: null }
  inspectCache.clear()
  systemdCache.clear()
}

async function wslExec(distro, argv, options = {}) {
  const args = distro ? ['-d', distro, '--'].concat(argv) : ['--'].concat(argv)
  return runProcess(WSL_EXE, args, options)
}

/**
 * wsl.exe 会在进入 Linux 之前再做一层命令行展开：脚本里的 $变量 会被它先吃掉，
 * 位置参数也会丢。把整段脚本 base64 后交给远端 bash 解码执行，才能保证内容原样到达。
 */
function bashScriptCommand(script) {
  const encoded = Buffer.from(String(script), 'utf8').toString('base64')
  return 'echo ' + encoded + ' | base64 -d | bash'
}

async function runBashScript(distro, script, options = {}) {
  return wslExec(distro, ['bash', '-lc', bashScriptCommand(script)], options)
}

export async function wslBash(distro, script, options = {}) {
  return runBashScript(distro, script, options)
}

/**
 * wsl.exe 只把命令串交给 bash，后面的位置参数在 Windows 参数解析这一层会丢；
 * 所以不能学本机 spawn 那样把值放在 argv 尾部，必须转义后拼进脚本。
 */
function shellQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'"
}

/** 探测一个发行版：dsh 在不在、什么版本、有哪些 profile、systemd 能不能用。 */
export async function inspectWslDistro(distro, home, options = {}) {
  const wantedHome = home || DEFAULT_HOME
  const wantedCommand = options.dshCommand || 'dsh'
  const key = distro + '\0' + wantedHome + '\0' + wantedCommand
  const cached = inspectCache.get(key)
  if (!options.force && cached && Date.now() - cached.at < 5000) return cached.value
  const command = [
    'dsh_cmd=' + shellQuote(wantedCommand),
    'home=' + shellQuote(wantedHome),
    'case "$home" in',
    '  "~") home="$HOME" ;;',
    '  "~/"*) home="$HOME/${home:2}" ;;',
    'esac',
    'case "$dsh_cmd" in',
    '  "~") dsh_cmd="$HOME" ;;',
    '  "~/"*) dsh_cmd="$HOME/${dsh_cmd:2}" ;;',
    'esac',
    'printf \'__DSHX_HOME__%s\\n\' "$HOME"',
    'printf \'__DSHX_DSH_HOME__%s\\n\' "$home"',
    'printf \'__DSHX_DSH_CMD__%s\\n\' "$dsh_cmd"',
    'if command -v "$dsh_cmd" >/dev/null 2>&1; then',
    '  printf \'__DSHX_DSH_PATH__%s\\n\' "$(command -v "$dsh_cmd")"',
    '  printf \'__DSHX_VERSION__%s\\n\' "$("$dsh_cmd" --version 2>&1 | head -n 1)"',
    'else',
    '  printf \'__DSHX_MISSING__1\\n\'',
    'fi',
    'printf \'__DSHX_PROFILES__\\n\'',
    'if [ -d "$home/profiles" ]; then ls -1 "$home/profiles" 2>/dev/null; fi',
    'if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user show-environment >/dev/null 2>&1; then',
    '  printf \'__DSHX_SYSTEMD__1\\n\'',
    'else',
    '  printf \'__DSHX_SYSTEMD__0\\n\'',
    'fi',
    'printf \'__DSHX_LINGER__%s\\n\' "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null || echo unknown)"',
  ].join('\n')
  const result = await runBashScript(distro, command, { timeoutMs: 20000 })
  const lines = String(result.stdout || '').split(/\r?\n/)
  const info = { ok: false, distro: distro, home: '', dshHome: '', dshCommand: '', dshPath: '', version: '', profiles: [], systemd: false, linger: '', missing: false, error: '', raw: '' }
  let inProfiles = false
  for (const line of lines) {
    if (line.indexOf('__DSHX_HOME__') === 0) info.home = line.slice('__DSHX_HOME__'.length)
    else if (line.indexOf('__DSHX_DSH_HOME__') === 0) info.dshHome = line.slice('__DSHX_DSH_HOME__'.length)
    else if (line.indexOf('__DSHX_DSH_CMD__') === 0) info.dshCommand = line.slice('__DSHX_DSH_CMD__'.length)
    else if (line.indexOf('__DSHX_DSH_PATH__') === 0) info.dshPath = line.slice('__DSHX_DSH_PATH__'.length)
    else if (line.indexOf('__DSHX_VERSION__') === 0) info.version = line.slice('__DSHX_VERSION__'.length).trim()
    else if (line === '__DSHX_MISSING__1') info.missing = true
    else if (line === '__DSHX_SYSTEMD__1') info.systemd = true
    else if (line.indexOf('__DSHX_LINGER__') === 0) info.linger = line.slice('__DSHX_LINGER__'.length).trim()
    else if (line === '__DSHX_PROFILES__') inProfiles = true
    else if (inProfiles && line.trim()) info.profiles.push(line.trim())
  }
  info.raw = String(result.stdout || '').slice(0, 4000)
  if (!result.ok) info.error = result.stderr.trim() || (result.timedOut ? '探测 WSL 超时' : 'wsl 退出码 ' + result.code)
  else if (info.missing) info.error = 'WSL 里找不到 ' + (info.dshCommand || 'dsh') + '，先在该发行版里安装 dsh'
  else info.ok = Boolean(info.version)
  inspectCache.set(key, { at: Date.now(), value: info })
  systemdCache.set(distro, { at: Date.now(), value: info.systemd })
  return info
}

/** systemd user 会话是否可用（不只看目录，避免 systemctl 在容器式发行版里空转）。 */
export async function systemdAvailable(distro, options = {}) {
  if (!distro) return false
  const cached = systemdCache.get(distro)
  if (!options.force && cached && Date.now() - cached.at < 30000) return cached.value
  const info = await inspectWslDistro(distro, options.home || DEFAULT_HOME, { force: true, dshCommand: options.dshCommand || 'dsh' })
  return Boolean(info && info.systemd)
}

async function installAgentScript(distro) {
  let pluginsSource = ''
  try {
    pluginsSource = readFileSync(new URL('./plugins.js', import.meta.url), 'utf8')
  } catch { /* 打包目录缺文件时插件代理降级，不影响启动 */ }
  const files = [
    ['dsh-x-wsl.sh', WSL_AGENT_SCRIPT, '755'],
    ['dsh-x-systemd.sh', WSL_SYSTEMD_SCRIPT, '755'],
    ['dsh-x-bridge.mjs', WSL_BRIDGE_SCRIPT, '644'],
    ['dsh-x-helper.mjs', WSL_HELPER_SCRIPT, '644'],
    ...(pluginsSource ? [['plugins.mjs', pluginsSource, '644']] : []),
  ]
  // 一个文件一条 wsl.exe 命令：plugins.js 有 20KB，五份文件拼在一条命令行里会撞
  // Windows 的 32K 参数上限（spawn ENAMETOOLONG）。单个文件再按 8KB 切片，保险。
  for (const [name, text, mode] of files) {
    const base64 = Buffer.from(String(text), 'utf8').toString('base64')
    const chunks = []
    for (let index = 0; index < base64.length; index += 8000) chunks.push(base64.slice(index, index + 8000))
    // 每一片单独一条 wsl.exe：runBashScript 还会把整条脚本再 base64 一次，几片拼在一起同样会超限。
    for (let index = 0; index < chunks.length; index += 1) {
      const script = [
        'set -eu',
        'd="$HOME/.dsh-x/bin"',
        'mkdir -p "$d"',
        "printf '%s' '" + chunks[index] + "' | base64 -d " + (index === 0 ? '>' : '>>') + ' "$d/' + name + '"',
      ].join('\n')
      const result = await wslBash(distro, script, { timeoutMs: 20000 })
      if (!result.ok) throw new Error('写入 WSL 启动脚本失败：' + (result.stderr.trim() || result.stdout.trim() || '未知错误'))
    }
    const chmodResult = await wslBash(distro, 'chmod ' + mode + ' "$HOME/.dsh-x/bin/' + name + '"', { timeoutMs: 20000 })
    if (!chmodResult.ok) throw new Error('设置 WSL 启动脚本权限失败：' + (chmodResult.stderr.trim() || chmodResult.stdout.trim() || '未知错误'))
  }
}

export function wslHomeKey(distro, home) {
  return 'wsl://' + encodeURIComponent(distro || '') + '/' + encodeURIComponent(home || DEFAULT_HOME)
}

export function parseWslHomeKey(key) {
  const text = String(key || '')
  const match = /^wsl:\/\/([^/]*)\/(.*)$/.exec(text)
  if (!match) return null
  try {
    return { distro: decodeURIComponent(match[1]), home: decodeURIComponent(match[2]) }
  } catch {
    // 手工改坏的键不能让停止/状态查询整条崩掉；当成不是 WSL 实例处理。
    return null
  }
}

export function resolveWslHome(home) {
  const value = String(home || '').trim() || DEFAULT_HOME
  if (value === '~') return '~'
  if (value.indexOf('~/') === 0) return value.replace(/\/+$/, '') || '~/'
  if (value.charAt(0) !== '/') throw new Error('WSL 路径要填绝对路径（例如 /root/.dsh）')
  const normalized = value.replace(/\/+$/, '')
  return normalized || '/'
}

export async function wslPortAvailable(distro, port) {
  const script = [
    'port=' + shellQuote(String(port)),
    'if command -v ss >/dev/null 2>&1; then',
    '  if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then exit 1; fi',
    '  exit 0',
    'fi',
    'timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null && exit 1 || exit 0',
  ].join('\n')
  const result = await runBashScript(distro, script, { timeoutMs: 5000 })
  return result.ok
}

/** 由启动器统一挑端口：优先沿用钉住的，再随机试；同时检查 Windows 侧和 WSL 侧。 */
export async function allocateWslPort(distro, preferred, windowsFree) {
  const checkWindows = windowsFree || (async () => true)
  const candidates = []
  if (preferred > 0) candidates.push(preferred)
  for (let index = 0; index < 40; index += 1) {
    const port = 42000 + Math.floor(Math.random() * 12000)
    if (candidates.indexOf(port) === -1) candidates.push(port)
  }
  for (const port of candidates) {
    if (!(await wslPortAvailable(distro, port))) continue
    if (!(await checkWindows(port))) continue
    return port
  }
  throw new Error('WSL 里没有找到可用端口')
}

function windowsPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch { /* 已关闭 */ }
      resolve(value)
    }
    try {
      socket = net.connect({ host: '127.0.0.1', port: port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

/** 查 WSL 侧端口的主人：ss 能给出 PID 和命令行，用来区分 dsh 与别的服务。 */
export async function probeWslDshPort(distro, port) {
  const script = [
    'port=' + shellQuote(String(port)),
    'if command -v ss >/dev/null 2>&1; then',
    '  out=$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)',
    '  if [ -n "$out" ]; then',
    '    echo "__DSHX_LISTEN__1"',
    '    pid=$(printf \'%s\' "$out" | grep -o \'pid=[0-9]*\' | head -n 1 | cut -d= -f2)',
    '    if [ -n "$pid" ]; then',
    '      echo "__DSHX_PID__$pid"',
    '      ps -p "$pid" -o args= 2>/dev/null | sed \'s/^/__DSHX_CMD__/\' || true',
    '    fi',
    '  else',
    '    echo "__DSHX_LISTEN__0"',
    '  fi',
    'else',
    '  if timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then echo "__DSHX_LISTEN__1"; else echo "__DSHX_LISTEN__0"; fi',
    'fi',
  ].join('\n')
  const result = await runBashScript(distro, script, { timeoutMs: 5000 })
  const info = { port: Number(port) || 0, wslListening: false, listening: false, dsh: false, pid: 0, command: '', raw: String(result.stdout || '') }
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (line === '__DSHX_LISTEN__1') info.wslListening = true
    else if (line.indexOf('__DSHX_PID__') === 0) info.pid = Number(line.slice('__DSHX_PID__'.length)) || 0
    else if (line.indexOf('__DSHX_CMD__') === 0) info.command = line.slice('__DSHX_CMD__'.length).trim()
  }
  info.dsh = /(?:^|[\s/])dsh(?:\s|$)|@deepseek-ai\/dsh|dsh\s+web/.test(info.command)
  info.listening = await windowsPortOpen(info.port)
  return info
}

/** Runtime Bridge 请求：桥只监听 WSL 的 127.0.0.1，Windows 侧经 localhostForwarding 访问。 */
export function queryWslBridge(port, token, method = 'getStatus') {
  if (!port || !token) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    let buffer = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch { /* 已关闭 */ }
      resolve(value)
    }
    try {
      socket = net.connect({ host: '127.0.0.1', port: Number(port) })
      socket.setTimeout(2500)
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        try { socket.write(JSON.stringify({ v: 1, method: method, token: token }) + '\n') } catch { finish(null) }
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index < 0) return
        try { finish(JSON.parse(buffer.slice(0, index))) } catch { finish(null) }
      })
      socket.once('timeout', () => finish(null))
      socket.once('error', () => finish(null))
      socket.once('close', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

export function shutdownWslBridge(port, token) {
  return queryWslBridge(port, token, 'shutdown')
}

/** 启动一个 WSL 实例；返回的 child 就是 wsl.exe（wrapper）或 journal 跟随器（systemd）。 */
export async function startWslInstance(options) {
  const distro = options.distro
  let serviceMode = normalizeWslServiceMode(options.serviceMode)
  let fallbackFromSystemd = false
  if (serviceMode === 'systemd' && !(await systemdAvailable(distro, { dshCommand: options.dshCommand }))) {
    serviceMode = 'wrapper'
    fallbackFromSystemd = true
  }
  await installAgentScript(distro)
  const instanceId = randomBytes(8).toString('hex')
  const port = Number(options.port) || 0
  // 桥端口固定为 dsh 端口 +100；超出范围就关掉，状态探测仍按端口做。
  const bridgePort = port > 0 && port + 100 <= 65535 ? port + 100 : 0
  const bridgeToken = randomBytes(16).toString('hex')
  if (serviceMode === 'systemd') {
    const started = await startSystemdInstance({ ...options, distro, instanceId, port, bridgePort, bridgeToken })
    return { ...started, serviceMode, fallbackFromSystemd }
  }
  const script = 'script="$HOME/.dsh-x/bin/dsh-x-wsl.sh"\nexec "$script" start ' + [
    instanceId, options.profile, options.home || DEFAULT_HOME,
    options.workdir || '', String(port), options.dshCommand || 'dsh',
    String(bridgePort), bridgeToken,
  ].map(shellQuote).join(' ')
  const args = ['-d', distro, '--', 'bash', '-lc', bashScriptCommand(script)]
  let child
  try {
    child = spawn(WSL_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    throw new Error('启动 wsl.exe 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  return { child: child, instanceId: instanceId, distro: distro, port: port, serviceMode: serviceMode, home: options.home || DEFAULT_HOME, workdir: options.workdir || '', bridgePort, bridgeToken, fallbackFromSystemd }
}

/** systemd 模式：unit 托管 dsh，另起一个 wsl.exe 跟随 journal 作为 attachProcess 的 stdout 来源。 */
async function startSystemdInstance(options) {
  const { distro, instanceId, port, bridgePort, bridgeToken } = options
  const command = 'script="$HOME/.dsh-x/bin/dsh-x-systemd.sh"\nexec "$script" start ' + [
    instanceId, options.profile, options.home || DEFAULT_HOME, options.workdir || '',
    String(port), options.dshCommand || 'dsh', String(bridgePort), bridgeToken,
  ].map(shellQuote).join(' ')
  const result = await runBashScript(distro, command, { timeoutMs: 30000 })
  if (!result.ok) {
    throw new Error('启动 systemd 服务失败：' + (result.stderr.trim() || result.stdout.trim() || '未知错误'))
  }
  // unit 的唯一 id 保证 journal 里只有这一次实例的日志；-n +1 从本次 unit 的第一行开始跟。
  const journalScript = 'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; exec journalctl --user -u ' + shellQuote('dsh-x-' + instanceId + '.service') + ' -n 100 -f -o cat'
  let child
  try {
    child = spawn(WSL_EXE, ['-d', distro, '--', 'bash', '-lc', bashScriptCommand(journalScript)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    throw new Error('跟随 WSL systemd 日志失败：' + (error instanceof Error ? error.message : String(error)))
  }
  // systemd 模式下的 wsl.exe 都是短命调用；必须留一个长期进程，否则 WSL VM 可能休眠把 unit 一起冻住。
  let keepalive = null
  try {
    keepalive = spawn(WSL_EXE, ['-d', distro, '--', 'bash', '-lc', 'exec sleep infinity'], { stdio: 'ignore', windowsHide: true })
  } catch { /* 没有 keepalive 也能跑，只是 VM 空闲策略可能影响 unit */ }
  return { child, instanceId, distro, port, home: options.home || DEFAULT_HOME, workdir: options.workdir || '', bridgePort, bridgeToken, keepalive }
}

/** 停一个 WSL 实例：先让 Linux 侧按 pidfile / unit 收尸，再由调用方杀 wsl.exe 门。 */
export async function stopWslInstance(options) {
  if (!options.distro || !options.instanceId) return { ok: true, skipped: true }
  const serviceMode = normalizeWslServiceMode(options.serviceMode)
  const scriptName = serviceMode === 'systemd' ? 'dsh-x-systemd.sh' : 'dsh-x-wsl.sh'
  const command = 'script="$HOME/.dsh-x/bin/' + scriptName + '"; if [ -x "$script" ]; then exec "$script" stop ' + shellQuote(options.instanceId) + ' ' + shellQuote(String(options.port || '')) + '; fi'
  const result = await runBashScript(options.distro, command, { timeoutMs: 30000 })
  try { options.keepalive?.kill('SIGKILL') } catch { /* 已退出 */ }
  return { ok: result.ok, stderr: result.stderr, stdout: result.stdout }
}

/** 停止不是本管理器拉起的 dsh：只在 stopAttached 打开时调用，按端口找到 PID 再 TERM。 */
export async function stopWslExternal(options) {
  if (!options.distro || !options.port) return { ok: false, skipped: true }
  const script = [
    'port=' + shellQuote(String(options.port)),
    'if ! command -v ss >/dev/null 2>&1; then exit 1; fi',
    'out=$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)',
    'pid=$(printf \'%s\' "$out" | grep -o \'pid=[0-9]*\' | head -n 1 | cut -d= -f2)',
    'if [ -z "$pid" ]; then exit 0; fi',
    'cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)',
    'case "$cmd" in *dsh*) kill -TERM "$pid" 2>/dev/null || true ;; *) exit 3 ;; esac',
  ].join('\n')
  const result = await runBashScript(options.distro, script, { timeoutMs: 10000 })
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr }
}

async function runWslHelper(distro, action, args) {
  await installAgentScript(distro)
  const command = [
    'home=' + shellQuote(args.home || DEFAULT_HOME),
    'case "$home" in',
    '  "~") home="$HOME" ;;',
    '  "~/"*) home="$HOME/${home:2}" ;;',
    'esac',
    'node "$HOME/.dsh-x/bin/dsh-x-helper.mjs" ' + shellQuote(action) + ' --home "$home" --profile ' + shellQuote(args.profile || '') + (args.name ? ' --name ' + shellQuote(args.name) : '') + (args.enabled === undefined ? '' : ' --enabled ' + shellQuote(args.enabled ? '1' : '0')),
  ].join('\n')
  const result = await runBashScript(distro, command, { timeoutMs: 20000 })
  const lines = String(result.stdout || '').split(/\r?\n/)
  const line = lines.find((item) => item.indexOf('__DSHX_JSON__') === 0)
  if (!line) throw new Error('WSL 插件代理没有返回数据：' + (result.stderr.trim() || result.stdout.trim() || '无输出'))
  let payload
  try { payload = JSON.parse(line.slice('__DSHX_JSON__'.length)) } catch { throw new Error('WSL 插件代理返回了坏 JSON') }
  if (!payload.ok) throw new Error(payload.error || 'WSL 插件代理执行失败')
  return payload
}

export function wslPluginList(distro, home, profile) {
  return runWslHelper(distro, 'list', { home, profile })
}

export function wslPluginToggle(distro, home, profile, name, enabled) {
  return runWslHelper(distro, 'toggle', { home, profile, name, enabled })
}

export { WSL_EXE, DEFAULT_HOME }
