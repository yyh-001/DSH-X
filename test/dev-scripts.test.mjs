/**
 * 本地验收启动器（scripts/dev.mjs）的入口与计划检查。
 * 真正启动 Electron / DSH.exe 的路径不在这里跑：测试只验 dry-run 的计划和几条硬规则，
 * 避免 CI 上弹出窗口或依赖已安装的 DSH-X。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir as tmpdirOf } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function dev(args, extra = {}) {
  // 清掉可能从外面带进来的覆盖变量，保证断言的是脚本的默认计划。
  const env = { ...process.env }
  delete env.DSH_DEV_APPDATA
  delete env.DSH_CORE_DIR
  delete env.DSH_INSTALLED
  Object.assign(env, extra)
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

test('dry-run：core 全平台都用临时数据目录 + release/core-stage，不组装不启动', () => {
  const result = dev(['core', '--dry-run'])
  assert.equal(result.status, 0)
  // APPDATA（Windows）+ DSH_APP_DIR（全平台）一起隔离，mac/Linux 不再落回真实数据目录
  assert.match(result.stdout, /dshx-dev/, '临时数据目录在系统临时目录的 dshx-dev 下')
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

test('隔离实例同时给 APPDATA 和 DSH_APP_DIR（mac/Linux 只认后者）', () => {
  const script = read('scripts/dev.mjs')
  assert.match(script, /APPDATA: appdata, \[APP_DIR_ENV\]: join\(appdata, 'DSH'\)/)
  assert.match(script, /const APP_DIR_ENV = 'DSH_APP_DIR'/)
})

test('「正在运行」按外壳可执行文件名精确匹配，不再 pgrep -f 命中 DSH-X 目录下的任意进程', () => {
  const script = read('scripts/dev.mjs')
  assert.match(script, /spawnSync\('pgrep', \['-x', 'DSH'\]/)
  assert.doesNotMatch(script, /'pgrep', \['-f'/)
})

test('--fresh 拒绝清空不是验收草稿的目录（例如家目录），什么都不删', () => {
  const result = dev(['app', '--fresh', '--dry-run'], { DSH_DEV_APPDATA: homedir() })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--fresh 拒绝清空/)
  assert.ok(existsSync(homedir()))
})

test('--fresh 放行：系统临时目录里的、或带脚本标记的目录', () => {
  const inTemp = dev(['app', '--fresh', '--dry-run'], { DSH_DEV_APPDATA: join(mkdtempSync(join(tmpdirOf(), 'dshx-fresh-')), 'data') })
  assert.equal(inTemp.status, 0, inTemp.stderr)
  // 不在临时目录、但带标记（脚本自己建的）：放行。用仓库的 release/ 下一个子目录模拟
  const marked = join(root, 'release', `dev-fresh-test-${process.pid}`)
  mkdirSync(marked, { recursive: true })
  try {
    writeFileSync(join(marked, 'settings.json'), '{}')
    assert.equal(dev(['app', '--fresh', '--dry-run'], { DSH_DEV_APPDATA: marked }).status, 1, '有内容又没标记：拒绝')
    writeFileSync(join(marked, '.dshx-dev-scratch'), '')
    const ok = dev(['app', '--fresh', '--dry-run'], { DSH_DEV_APPDATA: marked })
    assert.equal(ok.status, 0, ok.stderr)
  } finally {
    rmSync(marked, { recursive: true, force: true })
  }
})
