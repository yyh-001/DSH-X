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

/**
 * WSL 里跑的那半截启动器。
 *
 * 为什么要有这个脚本：WSL 实例不是 Windows 上的一个普通子进程。wsl.exe 只是
 * 一扇门，门后面还有 bash、dsh、以及 WSL 自己的进程树；从 Windows 直接 taskkill
 * 只能杀掉门，门后面的 dsh 可能继续占着端口。启动、停止、状态都放在同一个脚本里，
 * 让「谁写的 pidfile 谁负责收尸」这件事只有一个实现。
 *
 * 两种服务模式共用同一套 pidfile 约定：
 * - wrapper：脚本前台 exec dsh，wsl.exe 的 stdout 就是 dsh 的 stdout；
 * - systemd：脚本写一个 systemd user unit，unit 里再 exec dsh，Windows 侧 tail journal。
 *
 * Runtime Bridge 是独立的 Node 小进程（见 WSL_BRIDGE_SCRIPT）：dsh 的启动 token 只在
 * stdout 里出现一次，WSL 外的管理器拿不到；桥用 DSH-X 自己生成的 token 提供 ping /
 * 状态 / 优雅停止，插件代理则走 WSL_HELPER_SCRIPT。
 */

const wrapperLines = [
  "#!/usr/bin/env bash",
  "set -u",
  "",
  "action=\"${1:-}\"",
  "if [ -n \"$action\" ]; then shift; fi",
  "",
  "# 状态目录固定放在 Linux 用户自己的 HOME 下，不跟 DSH_HOME 走：",
  "# 同一个 HOME 下可能有好几个 DSH_HOME，每个实例的 pidfile 不能混。",
  "state_dir=\"${DSH_X_WSL_STATE_DIR:-$HOME/.dsh-x}\"",
  "run_dir=\"$state_dir/run\"",
  "mkdir -p \"$run_dir\" \"$state_dir/logs\"",
  "",
  "expand_home() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s' \"$HOME\" \"${1:2}\" ;;",
  "    *) printf '%s' \"$1\" ;;",
  "  esac",
  "}",
  "",
  "# 桥进程和 dsh 分开写 pidfile：dsh 被信号杀时桥还活着的话，下一次启动会误以为实例在跑。",
  "start_bridge() {",
  "  bridge_port=\"${1:-}\"",
  "  bridge_token=\"${2:-}\"",
  "  if [ -z \"$bridge_port\" ] || [ \"$bridge_port\" = \"0\" ]; then return 0; fi",
  "  bridge=\"$state_dir/bin/dsh-x-bridge.mjs\"",
  "  if [ ! -f \"$bridge\" ]; then return 0; fi",
  "  if ! command -v node >/dev/null 2>&1; then echo \"dsh-x: 找不到 node，Runtime Bridge 不启动\" >&2; return 0; fi",
  "  node \"$bridge\" --port \"$bridge_port\" --token \"$bridge_token\" --profile \"$profile\" --web-port \"$port\" --dsh-pidfile \"$pidfile\" --dsh-command \"$dsh_cmd\" --dsh-home \"$dsh_home\" --state-dir \"$state_dir\" >>\"$state_dir/logs/$id.bridge.log\" 2>&1 &",
  "  echo $! > \"$run_dir/$id.bridge.pid\"",
  "}",
  "",
  "stop_bridge() {",
  "  bpidfile=\"$run_dir/$id.bridge.pid\"",
  "  if [ -f \"$bpidfile\" ]; then",
  "    bpid=\"$(cat \"$bpidfile\" 2>/dev/null || true)\"",
  "    if [ -n \"$bpid\" ] && kill -0 \"$bpid\" 2>/dev/null; then kill -TERM \"$bpid\" 2>/dev/null || true; fi",
  "    rm -f \"$bpidfile\"",
  "  fi",
  "}",
  "",
  "case \"$action\" in",
  "  start)",
  "    id=\"${1:?missing instance id}\"",
  "    profile=\"${2:?missing profile}\"",
  "    dsh_home=\"${3:-}\"",
  "    workdir=\"${4:-}\"",
  "    port=\"${5:?missing port}\"",
  "    dsh_cmd=\"${6:-dsh}\"",
  "    bridge_port=\"${7:-}\"",
  "    bridge_token=\"${8:-}\"",
  "    shift 8 || true",
  "    if [ -z \"$dsh_home\" ]; then dsh_home=\"$HOME/.dsh\"; fi",
  "    dsh_home=\"$(expand_home \"$dsh_home\")\"",
  "    export DSH_HOME=\"$dsh_home\"",
  "    if [ -n \"$workdir\" ]; then",
  "      workdir=\"$(expand_home \"$workdir\")\"",
  "      cd \"$workdir\" || { echo \"dsh-x: workdir 不存在：$workdir\" >&2; exit 66; }",
  "    else",
  "      cd \"$dsh_home\" 2>/dev/null || cd \"$HOME\" || exit 66",
  "    fi",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    if [ -f \"$pidfile\" ]; then",
  "      old_pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"",
  "      if [ -n \"$old_pid\" ] && kill -0 \"$old_pid\" 2>/dev/null; then",
  "        echo \"dsh-x: 这个 WSL 实例已经在运行（PID $old_pid）\" >&2",
  "        exit 0",
  "      fi",
  "      rm -f \"$pidfile\"",
  "    fi",
  "    echo $$ > \"$pidfile\"",
  "    start_bridge \"$bridge_port\" \"$bridge_token\"",
  "    echo \"dsh-x: 启动 $dsh_cmd $profile --host 127.0.0.1 --port $port\"",
  "    # exec 很关键：pidfile 里的 PID 必须就是 dsh 本体的 PID，停止时才能精确杀。",
  "    exec \"$dsh_cmd\" \"$profile\" --host 127.0.0.1 --port \"$port\" --no-open \"$@\"",
  "    ;;",
  "  stop)",
  "    id=\"${1:?missing instance id}\"",
  "    port=\"${2:-}\"",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    pid=\"\"",
  "    if [ -f \"$pidfile\" ]; then pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"; fi",
  "    if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
  "      kill -TERM \"$pid\" 2>/dev/null || true",
  "      i=0",
  "      while [ \"$i\" -lt 50 ]; do",
  "        kill -0 \"$pid\" 2>/dev/null || break",
  "        sleep 0.1",
  "        i=$((i + 1))",
  "      done",
  "      if kill -0 \"$pid\" 2>/dev/null; then kill -KILL \"$pid\" 2>/dev/null || true; fi",
  "    fi",
  "    stop_bridge",
  "    rm -f \"$pidfile\"",
  "    # pidfile 丢了（例如 Windows 侧被杀）时，按端口兜底收一次。只在 pid 不可用时做，",
  "    # 避免误杀端口复用后的新进程。",
  "    if [ -z \"$pid\" ] && [ -n \"$port\" ] && command -v fuser >/dev/null 2>&1; then",
  "      fuser -k -TERM \"${port}/tcp\" 2>/dev/null || true",
  "    fi",
  "    exit 0",
  "    ;;",
  "  status)",
  "    id=\"${1:?missing instance id}\"",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    if [ -f \"$pidfile\" ]; then",
  "      pid=\"$(cat \"$pidfile\" 2>/dev/null || true)\"",
  "      if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
  "        echo \"running:$pid\"",
  "        exit 0",
  "      fi",
  "    fi",
  "    echo \"stopped\"",
  "    exit 1",
  "    ;;",
  "  *)",
  "    echo \"dsh-x: 未知操作：$action\" >&2",
  "    exit 64",
  "    ;;",
  "esac"
]

export const WSL_AGENT_SCRIPT = wrapperLines.join('\n')

const systemdLines = [
  "#!/usr/bin/env bash",
  "set -u",
  "",
  "action=\"${1:-}\"",
  "if [ -n \"$action\" ]; then shift; fi",
  "state_dir=\"${DSH_X_WSL_STATE_DIR:-$HOME/.dsh-x}\"",
  "run_dir=\"$state_dir/run\"",
  "unit_dir=\"$HOME/.config/systemd/user\"",
  "mkdir -p \"$run_dir\" \"$unit_dir\" \"$state_dir/logs\"",
  "",
  "expand_home() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s' \"$HOME\" \"${1:2}\" ;;",
  "    *) printf '%s' \"$1\" ;;",
  "  esac",
  "}",
  "",
  "ensure_systemd() {",
  "  export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "  if [ ! -d /run/systemd/system ]; then echo \"dsh-x: 这个发行版没有 systemd\" >&2; exit 69; fi",
  "  if ! command -v systemctl >/dev/null 2>&1; then echo \"dsh-x: 找不到 systemctl\" >&2; exit 69; fi",
  "  systemctl --user show-environment >/dev/null 2>&1 || { echo \"dsh-x: systemd user 会话不可用\" >&2; exit 69; }",
  "}",
  "",
  "case \"$action\" in",
  "  start)",
  "    id=\"${1:?missing instance id}\"",
  "    profile=\"${2:?missing profile}\"",
  "    dsh_home=\"${3:-}\"",
  "    workdir=\"${4:-}\"",
  "    port=\"${5:?missing port}\"",
  "    dsh_cmd=\"${6:-dsh}\"",
  "    bridge_port=\"${7:-}\"",
  "    bridge_token=\"${8:-}\"",
  "    if [ -z \"$dsh_home\" ]; then dsh_home=\"$HOME/.dsh\"; fi",
  "    dsh_home=\"$(expand_home \"$dsh_home\")\"",
  "    if [ -n \"$workdir\" ]; then workdir=\"$(expand_home \"$workdir\")\"; fi",
  "    target_dir=\"${workdir:-$dsh_home}\"",
  "    if [ ! -d \"$target_dir\" ]; then target_dir=\"$HOME\"; fi",
  "    pidfile=\"$run_dir/$id.pid\"",
  "    start_script=\"$run_dir/$id-start.sh\"",
  "    bridge_pidfile=\"$run_dir/$id.bridge.pid\"",
  "    {",
  "      echo '#!/usr/bin/env bash'",
  "      echo 'set -u'",
  "      echo \"export DSH_HOME=$(printf '%q' \"$dsh_home\")\"",
  "      echo \"cd $(printf '%q' \"$target_dir\") || exit 66\"",
  "      echo \"echo \\\$\\$ > $(printf '%q' \"$pidfile\")\"",
  "      if [ -n \"$bridge_port\" ] && [ \"$bridge_port\" != \"0\" ]; then",
  "        echo \"node $(printf '%q' \"$state_dir/bin/dsh-x-bridge.mjs\") --port $(printf '%q' \"$bridge_port\") --token $(printf '%q' \"$bridge_token\") --profile $(printf '%q' \"$profile\") --web-port $(printf '%q' \"$port\") --dsh-pidfile $(printf '%q' \"$pidfile\") --dsh-command $(printf '%q' \"$dsh_cmd\") --dsh-home $(printf '%q' \"$dsh_home\") --state-dir $(printf '%q' \"$state_dir\") >>$(printf '%q' \"$state_dir/logs/$id.bridge.log\") 2>&1 &\"",
  "        echo \"echo \\\$! > $(printf '%q' \"$bridge_pidfile\")\"",
  "      fi",
  "      echo \"exec $(printf '%q' \"$dsh_cmd\") $(printf '%q' \"$profile\") --host 127.0.0.1 --port $(printf '%q' \"$port\") --no-open\"",
  "    } > \"$start_script\"",
  "    chmod 755 \"$start_script\"",
  "    unit=\"$unit_dir/dsh-x-$id.service\"",
  "    cat > \"$unit\" <<EOF",
  "[Unit]",
  "Description=DSH-X WSL dsh web ($profile:$port)",
  "After=network.target",
  "",
  "[Service]",
  "Type=simple",
  "Environment=HOME=%h",
  "ExecStart=/bin/bash $start_script",
  "Restart=on-failure",
  "RestartSec=3",
  "KillMode=control-group",
  "",
  "[Install]",
  "WantedBy=default.target",
  "EOF",
  "    ensure_systemd",
  "    systemctl --user daemon-reload",
  "    systemctl --user start \"dsh-x-$id.service\"",
  "    sleep 0.2",
  "    if ! systemctl --user is-active --quiet \"dsh-x-$id.service\"; then",
  "      echo \"dsh-x: systemd unit 没起来\" >&2",
  "      systemctl --user status \"dsh-x-$id.service\" --no-pager >&2 || true",
  "      exit 70",
  "    fi",
  "    echo \"started:$id\"",
  "    ;;",
  "  stop)",
  "    id=\"${1:?missing instance id}\"",
  "    unit=\"$unit_dir/dsh-x-$id.service\"",
  "    export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "    if [ -f \"$unit\" ]; then",
  "      systemctl --user stop \"dsh-x-$id.service\" 2>/dev/null || true",
  "      systemctl --user reset-failed \"dsh-x-$id.service\" 2>/dev/null || true",
  "      rm -f \"$unit\"",
  "      systemctl --user daemon-reload 2>/dev/null || true",
  "    fi",
  "    bpidfile=\"$run_dir/$id.bridge.pid\"",
  "    if [ -f \"$bpidfile\" ]; then",
  "      bpid=\"$(cat \"$bpidfile\" 2>/dev/null || true)\"",
  "      if [ -n \"$bpid\" ] && kill -0 \"$bpid\" 2>/dev/null; then kill -TERM \"$bpid\" 2>/dev/null || true; fi",
  "      rm -f \"$bpidfile\"",
  "    fi",
  "    rm -f \"$run_dir/$id-start.sh\" \"$run_dir/$id.pid\"",
  "    echo stopped",
  "    ;;",
  "  status)",
  "    id=\"${1:?missing instance id}\"",
  "    export XDG_RUNTIME_DIR=\"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}\"",
  "    if systemctl --user is-active --quiet \"dsh-x-$id.service\" 2>/dev/null; then echo \"running:systemd\"; exit 0; fi",
  "    echo stopped",
  "    exit 1",
  "    ;;",
  "  *)",
  "    echo \"dsh-x: 未知操作：$action\" >&2",
  "    exit 64",
  "    ;;",
  "esac"
]

export const WSL_SYSTEMD_SCRIPT = systemdLines.join('\n')

/** Runtime Bridge：只在 WSL 内 127.0.0.1 上监听，token 由 Windows 侧生成。 */
export const WSL_BRIDGE_SCRIPT = `#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
function arg(name, fallback = '') {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const port = Number(arg('--port'))
const token = arg('--token')
const profile = arg('--profile')
const webPort = Number(arg('--web-port'))
const dshPidfile = arg('--dsh-pidfile')
const dshCommand = arg('--dsh-command', 'dsh')
const dshHome = arg('--dsh-home')
const startedAt = Date.now()
let shuttingDown = false

function dshPid() {
  try {
    const value = Number(fs.readFileSync(dshPidfile, 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function dshRunning() {
  const pid = dshPid()
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function status() {
  return {
    v: 1,
    ok: true,
    running: dshRunning() && !shuttingDown,
    shuttingDown,
    pid: dshPid(),
    startedAt,
    uptimeMs: Date.now() - startedAt,
    profile,
    webPort,
    host: '127.0.0.1',
  }
}

function runtimeInfo() {
  let dshVersion = ''
  try {
    dshVersion = String(execFileSync(dshCommand, ['--version'], { encoding: 'utf8', timeout: 3000 })).trim().split(/\\r?\\n/)[0] || ''
  } catch { /* dsh 可能正在退出，版本只是附加信息 */ }
  return {
    v: 1,
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dshVersion,
    hostname: os.hostname(),
    cwd: process.cwd(),
    profileDir: dshHome ? dshHome.replace(/\\/+$/, '') + '/profiles/' + profile : '',
  }
}

function send(socket, value) {
  try { socket.write(JSON.stringify(value) + '\\n') } catch { /* 对端已断开 */ }
}

function handle(request) {
  if (!request || request.token !== token) return { v: 1, ok: false, error: 'unauthorized' }
  if (request.method === 'ping') return { v: 1, ok: true, pid: process.pid }
  if (request.method === 'getStatus') return status()
  if (request.method === 'getRuntimeInfo') return runtimeInfo()
  if (request.method === 'shutdown') {
    const pid = dshPid()
    shuttingDown = true
    setTimeout(() => {
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* 已经退出 */ } }
      setTimeout(() => process.exit(0), 300)
    }, 50)
    return { v: 1, ok: true, shuttingDown: true }
  }
  return { v: 1, ok: false, error: 'unknown method' }
}

const server = net.createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > 65536) { socket.destroy(); return }
    let index
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let request = null
      try { request = JSON.parse(line) } catch { send(socket, { v: 1, ok: false, error: 'bad json' }); continue }
      send(socket, handle(request))
    }
  })
})
server.on('error', (error) => {
  console.error('dsh-x bridge: ' + (error && error.message ? error.message : error))
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => console.log('dsh-x bridge: 127.0.0.1:' + port))
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500) })
process.on('SIGINT', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500) })
`

/** 插件代理：在 WSL 里复用 DSH-X 那套 plugins.js，列出 / 开关 WSL profile 的插件。 */
export const WSL_HELPER_SCRIPT = `#!/usr/bin/env node
import { listPlugins, setPluginEnabled } from './plugins.mjs'

const argv = process.argv.slice(2)
const action = argv[0] || ''
function arg(name, fallback = '') {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
function emit(value) {
  console.log('__DSHX_JSON__' + JSON.stringify(value))
}

const home = arg('--home', '')
const profile = arg('--profile', '')
const profileDir = home.replace(/\\/+$/, '') + '/profiles/' + profile

try {
  if (action === 'list') {
    const data = listPlugins(profileDir)
    emit({ ok: true, home, profile, ...data })
  } else if (action === 'toggle') {
    const name = arg('--name')
    const enabled = arg('--enabled') === '1'
    const result = setPluginEnabled(profileDir, name, enabled)
    emit({ ok: true, home, profile, changed: Boolean(result && result.changed), ...listPlugins(profileDir) })
  } else {
    emit({ ok: false, error: 'unknown action' })
    process.exitCode = 2
  }
} catch (error) {
  emit({ ok: false, error: error && error.message ? error.message : String(error) })
  process.exitCode = 1
}
`
