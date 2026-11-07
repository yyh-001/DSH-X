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
 * 首版只支持 wrapper（前台进程）模式：脚本自己 exec dsh，wsl.exe 的输出就是
 * dsh 的输出，Windows 侧照旧用 READY_RE 认端口。systemd 模式留到后面再加。
 */
const scriptLines = [
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
  "mkdir -p \"$run_dir\"",
  "",
  "expand_home() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s' \"$HOME\" \"${1:2}\" ;;",
  "    *) printf '%s' \"$1\" ;;",
  "  esac",
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
  "    shift 6 || true",
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

export const WSL_AGENT_SCRIPT = scriptLines.join('\n')
