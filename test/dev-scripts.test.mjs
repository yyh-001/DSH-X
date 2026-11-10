/**
 * 本地验收启动器（scripts/dev.mjs）的入口与计划检查。
 * 真正启动 Electron / DSH.exe 的路径不在这里跑：测试只验 dry-run 的计划和几条硬规则，
 * 避免 CI 上弹出窗口或依赖已安装的 DSH-X。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function dev(args) {
  // 清掉可能从外面带进来的覆盖变量，保证断言的是脚本的默认计划。
  const env = { ...process.env }
  delete env.DSH_DEV_APPDATA
  delete env.DSH_CORE_DIR
  delete env.DSH_INSTALLED
  return spawnSync(process.execPath, ['scripts/dev.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
}

test('三个不打包的验收入口挂在 npm scripts 上', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts['dev:core'], 'node scripts/dev.mjs core')
  assert.equal(pkg.scripts['dev:shell'], 'node scripts/dev.mjs shell')
  assert.equal(pkg.scripts['dev:app'], 'node scripts/dev.mjs app')
})

test('启动子进程不用 detached：Windows 上 detached 会把控制台子进程静默杀掉', () => {
  const script = read('scripts/dev.mjs')
  assert.doesNotMatch(script, /detached\s*:\s*true/)
  assert.match(script, /stdio: 'inherit'/, '日志直连终端，应用退出脚本才退出')
})

test('dry-run：core 按平台给出数据目录 + release/core-stage，不组装不启动', () => {
  const result = dev(['core', '--dry-run'])
  assert.equal(result.status, 0)
  // Windows 用 %TEMP%\dshx-dev 隔离；mac/Linux 的 APP_DIR 不认 APPDATA，只能走真实数据目录。
  if (process.platform === 'win32') assert.match(result.stdout, /dshx-dev/, '临时数据目录在 %TEMP%\\dshx-dev 下')
  else assert.match(result.stdout, /真实数据目录/, 'mac/Linux 没有 APPDATA 隔离')
  assert.match(result.stdout, /core-stage/)
  assert.match(result.stdout, /没有组装、复制或启动/)
})

test('dry-run：shell 启动源码外壳的 shell/main.mjs', () => {
  const result = dev(['shell', '--dry-run'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /shell[\\/]main\.mjs/)
  assert.match(result.stdout, /真实数据目录|隔离/)
})

test('dev:shell 默认用真实数据目录，--fresh 必须拒绝', () => {
  const result = dev(['shell', '--fresh', '--dry-run'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--fresh/)
})

test('dry-run：app 指向 release/dev-app（伪安装，app.isPackaged=true）', () => {
  const result = dev(['app', '--dry-run'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /dev-app/)
})

test('未知模式给出用法并以 1 退出', () => {
  const result = dev(['nope'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /core\|shell\|app/)
})
