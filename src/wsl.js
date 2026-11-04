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
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { WSL_AGENT_SCRIPT } from './wsl-scripts.js'

const WSL_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'wsl.exe')
  : 'C:\\Windows\\System32\\wsl.exe'
const HELPER_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine-.*|wslenv)$/i
const DEFAULT_HOME = '~/.dsh'
const SCRIPT_PATH = '$HOME/.dsh-x/bin/dsh-x-wsl.sh'

/** 首版只支持 wrapper：脚本前台 exec dsh，wsl.exe 的 stdout 就是 dsh 的 stdout。 */
export const WSL_SERVICE_MODE = 'wrapper'

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
const inspectCache = new Map()

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

export function invalidateWslCache() {
  distroCache = { at: 0, value: null }
  inspectCache.clear()
}

async function wslExec(distro, argv, options = {}) {
  const args = distro ? ['-d', distro, '--'].concat(argv) : ['--'].concat(argv)
  return runProcess(WSL_EXE, args, options)
}

/**
 * wsl.exe 会在进入 Linux 之前再做一层命令行展开：脚本里的 $变量 会被它先吃掉，
 * 位置参数也会丢。把整段脚本 base64 后交给远端 bash 解码执行，才能保证内容原样到达。
 * 脚本本身可以用 $HOME、引号和任意多行，不经过 Windows 这一层的参数解析。
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

/** 探测一个发行版：dsh 在不在、什么版本、有哪些 profile。 */
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
  ].join('\n')
  const result = await runBashScript(distro, command, { timeoutMs: 20000 })
  const lines = String(result.stdout || '').split(/\r?\n/)
  const info = { ok: false, distro: distro, home: '', dshHome: '', dshCommand: '', dshPath: '', version: '', profiles: [], missing: false, error: '', raw: '' }
  let inProfiles = false
  for (const line of lines) {
    if (line.indexOf('__DSHX_HOME__') === 0) info.home = line.slice('__DSHX_HOME__'.length)
    else if (line.indexOf('__DSHX_DSH_HOME__') === 0) info.dshHome = line.slice('__DSHX_DSH_HOME__'.length)
    else if (line.indexOf('__DSHX_DSH_CMD__') === 0) info.dshCommand = line.slice('__DSHX_DSH_CMD__'.length)
    else if (line.indexOf('__DSHX_DSH_PATH__') === 0) info.dshPath = line.slice('__DSHX_DSH_PATH__'.length)
    else if (line.indexOf('__DSHX_VERSION__') === 0) info.version = line.slice('__DSHX_VERSION__'.length).trim()
    else if (line === '__DSHX_MISSING__1') info.missing = true
    else if (line === '__DSHX_PROFILES__') inProfiles = true
    else if (inProfiles && line.trim()) info.profiles.push(line.trim())
  }
  info.raw = String(result.stdout || '').slice(0, 4000)
  if (!result.ok) info.error = result.stderr.trim() || (result.timedOut ? '探测 WSL 超时' : 'wsl 退出码 ' + result.code)
  else if (info.missing) info.error = 'WSL 里找不到 ' + (info.dshCommand || 'dsh') + '，先在该发行版里安装 dsh'
  else info.ok = Boolean(info.version)
  inspectCache.set(key, { at: Date.now(), value: info })
  return info
}

async function installAgentScript(distro) {
  const base64 = Buffer.from(WSL_AGENT_SCRIPT, 'utf8').toString('base64')
  const script = [
    'set -eu',
    'd="$HOME/.dsh-x/bin"',
    'mkdir -p "$d"',
    "printf '%s' '" + base64 + "' | base64 -d > \"$d/dsh-x-wsl.sh\"",
    'chmod 755 "$d/dsh-x-wsl.sh"',
    'printf "%s\\n" "$d/dsh-x-wsl.sh"',
  ].join('\n')
  const result = await wslBash(distro, script, { timeoutMs: 20000 })
  if (!result.ok) throw new Error('写入 WSL 启动脚本失败：' + (result.stderr.trim() || result.stdout.trim() || '未知错误'))
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

/** 启动一个 WSL 实例；返回的 child 就是 wsl.exe，stdout/stderr 由 attachProcess 读。 */
export async function startWslInstance(options) {
  const distro = options.distro
  const serviceMode = options.serviceMode || WSL_SERVICE_MODE
  if (serviceMode !== WSL_SERVICE_MODE) throw new Error('暂不支持 WSL 服务模式：' + serviceMode)
  await installAgentScript(distro)
  const instanceId = randomBytes(8).toString('hex')
  // 所有启动参数都拼进脚本文本：wsl.exe 不把 argv 尾部原样交给 bash（见 shellQuote）。
  const script = 'script="$HOME/.dsh-x/bin/dsh-x-wsl.sh"\nexec "$script" start ' + [
    instanceId, options.profile, options.home || DEFAULT_HOME,
    options.workdir || '', String(options.port), options.dshCommand || 'dsh',
  ].map(shellQuote).join(' ')
  const args = ['-d', distro, '--', 'bash', '-lc', bashScriptCommand(script)]
  let child
  try {
    child = spawn(WSL_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    throw new Error('启动 wsl.exe 失败：' + (error instanceof Error ? error.message : String(error)))
  }
  return { child: child, instanceId: instanceId, distro: distro, port: options.port, serviceMode: serviceMode, home: options.home || DEFAULT_HOME, workdir: options.workdir || '' }
}

/** 停一个 WSL 实例：先让 Linux 侧按 pidfile 收尸，再由调用方杀 wsl.exe 门。 */
export async function stopWslInstance(options) {
  if (!options.distro || !options.instanceId) return { ok: true, skipped: true }
  const command = 'script="$HOME/.dsh-x/bin/dsh-x-wsl.sh"; if [ -x "$script" ]; then exec "$script" stop ' + shellQuote(options.instanceId) + ' ' + shellQuote(String(options.port || '')) + '; fi'
  const result = await runBashScript(options.distro, command, { timeoutMs: 20000 })
  return { ok: result.ok, stderr: result.stderr, stdout: result.stdout }
}

export { WSL_EXE, DEFAULT_HOME }
