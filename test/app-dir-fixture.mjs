/**
 * DSH_APP_DIR 用例的公共件：外壳的 env.mjs 和核心的 settings.js 都在 import 时按 process.env
 * 定好每用户目录（后者还顺手建好 fileManager 单例），换环境只能起子进程。
 * HOME / APPDATA / XDG_CONFIG_HOME 全指进临时目录，于是「正式版」的每用户目录也是临时的：
 * 可以往里种一份安装来证明覆盖压过它，又碰不到真实的 ~/Library/Application Support/DSH。
 * 这里只描述「怎么驱动」，预期都写在各用例里，只来自需求。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 子进程里别的模块也可能往 stdout 打日志，结果行带个前缀好认
const RESULT = 'APP_DIR_RESULT '
// Windows 的环境变量不分大小写：继承来的 AppData 和这里设的 APPDATA 并存时子进程拿到哪个说不准，先按大写剔掉
const SANDBOXED = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME'])

export function appDirSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-x-app-dir-'))
  const home = join(root, 'home')
  mkdirSync(home)
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 不覆盖时的每用户目录，按需求逐平台写：Windows %APPDATA%\DSH，mac ~/Library/Application Support/DSH，Linux $XDG_CONFIG_HOME/DSH。 */
export function platformAppDir(home) {
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'DSH')
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'DSH')
  return join(home, '.config', 'DSH')
}

/**
 * 在沙盒里起一个 node 子进程 import moduleUrl（模块记作 m），把 expression 的值（可以是 Promise）按 JSON 读回来。
 * override 为 undefined 时不设 DSH_APP_DIR。
 */
export function importInSandbox({ root, home }, moduleUrl, expression, override) {
  // 本机跑着的 DSH-X 可能留下 DSH_* 变量（比如 DSH_RUNTIME_NODE 已设就不会再读设置），一律不继承
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const name = key.toUpperCase()
    return !name.startsWith('DSH_') && !SANDBOXED.has(name)
  }))
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config') })
  if (override !== undefined) env.DSH_APP_DIR = override
  const script = `const m = await import(${JSON.stringify(moduleUrl)})
console.log(${JSON.stringify(RESULT)} + JSON.stringify(await (${expression})))`
  // cwd 放进沙盒：相对路径要是被误当成目录解析，也只会落在临时目录里
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(child.status, 0, child.stderr)
  const line = child.stdout.split(/\r?\n/).find((text) => text.startsWith(RESULT))
  assert.ok(line, `子进程没输出结果：${child.stdout}${child.stderr}`)
  return JSON.parse(line.slice(RESULT.length))
}
