import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'

import { decodeProcessOutput, describePluginFailure, dshArgs, dshEnv, orderRuntimePaths, pathWithEntry, pickPnpmDir, pnpmCandidates, profileStoreVersion, withBundledRuntime, withVersionBin, writeDshShims } from '../server.js'

const BUNDLED = 'E:\\DSH\\node'

function dirWithPnpm() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-'))
  // Windows 上 pnpm 的 shim 是 .cmd，POSIX 上是可执行文件；两个都放，测试不挑平台
  writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\n')
  writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\n')
  return dir
}

function plainDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-bin-'))
}

test('系统没有 pnpm：自带运行时排最前，其余顺序不变', () => {
  const a = plainDir()
  const b = plainDir()
  assert.deepEqual(orderRuntimePaths([a, b], BUNDLED), [BUNDLED, a, b])
})

test('系统有 pnpm：它的目录优先，自带运行时紧随其后（#12）', () => {
  // 场景：profile 的 .modules.yaml 记着当初建它的那个 pnpm 的 store（v3/v10/v11 随主版本走），
  // 顶上来的自带 pnpm 主版本不同，pnpm 会以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装
  const npmRoot = dirWithPnpm()
  const other = plainDir()
  const ordered = orderRuntimePaths([other, npmRoot], BUNDLED)
  assert.equal(ordered[0], npmRoot, '系统的 pnpm 要最先被找到')
  assert.equal(ordered[1], BUNDLED, '自带的 node/npm 仍优先于系统其余目录')
  assert.deepEqual(ordered.slice(2), [other], '其余目录相对顺序不变')
})

test('pnpm 在 PATH 第一项也认，不只看最后', () => {
  const npmRoot = dirWithPnpm()
  const other = plainDir()
  assert.equal(orderRuntimePaths([npmRoot, other], BUNDLED)[0], npmRoot)
})

test('多个目录带 pnpm：取 PATH 里最靠前的那一个', () => {
  const first = dirWithPnpm()
  const second = dirWithPnpm()
  const ordered = orderRuntimePaths([first, second], BUNDLED)
  assert.equal(ordered[0], first)
  assert.deepEqual(ordered.slice(1), [BUNDLED, second])
})

test('自带目录去重：不会在 PATH 里出现两次', () => {
  const npmRoot = dirWithPnpm()
  const ordered = orderRuntimePaths([BUNDLED, npmRoot, BUNDLED], BUNDLED)
  assert.deepEqual(ordered, [npmRoot, BUNDLED])
  assert.equal(orderRuntimePaths([BUNDLED, npmRoot, BUNDLED], BUNDLED).filter((item) => item === BUNDLED).length, 1)
})

test('pnpm 只在自带目录里：不算系统的，照旧排最前', () => {
  const other = plainDir()
  assert.deepEqual(orderRuntimePaths([BUNDLED, other], BUNDLED), [BUNDLED, other])
})

test('源码启动：pnpm shim 能找到正在使用的 Node，指定 pnpm 仍然优先', () => {
  const pnpm = dirWithPnpm()
  const original = plainDir()
  const parts = withBundledRuntime(original, pnpm).split(delimiter)
  assert.equal(parts[0], pnpm)
  assert.ok(parts.includes(dirname(process.execPath)))
  assert.ok(parts.includes(original))
})

test('Windows 命令输出：UTF-8 与 GBK 中文都可读，不把 UTF-8 错当本地编码', () => {
  assert.equal(decodeProcessOutput(Buffer.from('插件更新失败：权限不足'), 'win32'), '插件更新失败：权限不足')
  assert.equal(decodeProcessOutput(Buffer.from('d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfe', 'hex'), 'win32'), '找不到指定的文件')
  assert.equal(decodeProcessOutput(Buffer.from('Progress: resolved 7'), 'win32'), 'Progress: resolved 7')
})

test('缺少 pnpm 的中英报错与已经被上游损坏的中文都有可操作的提示', () => {
  for (const output of ["'pnpm' 不是内部或外部命令", 'dsh: pnpm was not found; install pnpm', "'pnpm' �����������"]) {
    assert.match(describePluginFailure(output, '更新插件', 1), /找不到 pnpm.*加入 PATH/)
  }
  assert.match(describePluginFailure('Error: permission denied', '更新插件', 1), /permission denied/)
})

// 第 1 条：agent 在 shell 里要能直接调 dsh（版本跟着启动器选的那个走）。
// 追加到 PATH 末尾，用户自己 PATH 上已有的 dsh 仍然优先。
test('版本自己的 .bin 追加在 PATH 末尾：用户已有的 dsh 优先，只有我们能让它可用', () => {
  const userPnpm = dirWithPnpm()
  const userBin = plainDir()          // 假设用户在这里也有个 dsh
  const versionBin = plainDir()
  const pathValue = [userPnpm, userBin].join(delimiter)
  const next = withVersionBin(pathValue, versionBin)
  const parts = next.split(delimiter)
  assert.equal(parts[parts.length - 1], versionBin, '追加在末尾，不插队')
  assert.equal(parts[0], userPnpm, '用户自己的目录顺序不变')
  assert.equal(parts[1], userBin, '用户自己的目录顺序不变')
})

test('版本 .bin 已经在 PATH 里就不重复追加', () => {
  const dir = plainDir()
  const pathValue = [dir, 'C:\Windows'].join(delimiter)
  assert.equal(withVersionBin(pathValue, dir), pathValue)
})

test('版本 .bin 不存在（还没装好 / 系统版 dsh）时原样返回', () => {
  const pathValue = 'C:\Windows'
  assert.equal(withVersionBin(pathValue, ''), pathValue)
  assert.equal(withVersionBin(pathValue, join(tmpdir(), 'dsh-no-such-bin-' + Date.now())), pathValue)
})

// 第 2 条：用户自己的 node 不该被自带运行时盖住（agent 在 shell 里跑的 node 是他自己那个）。
// 自带运行时退到后面兜底，dsh 本身仍然用启动器自己的 node 启动（spawnDsh 的 process.execPath）。
test('用户有 node：他的目录排在自带运行时前面，自带只兜底', () => {
  const userNode = plainDir()
  writeFileSync(join(userNode, process.platform === 'win32' ? 'node.exe' : 'node'), '')
  const other = plainDir()
  const ordered = orderRuntimePaths([other, userNode], BUNDLED)
  assert.equal(ordered.indexOf(userNode) < ordered.indexOf(BUNDLED), true, '用户自己的 node 优先')
  assert.ok(ordered.includes(BUNDLED), '自带运行时仍然在 PATH 里兜底')
})

// 第 3 条：dsh 自己的开关走命令行，别进 NODE_OPTIONS —— 后者会被所有子进程继承，
// agent 在 shell 里跑的 node 万一是老版本，撞上 --use-system-ca 会直接 bad option 退出。
test('dsh 的开关在命令行上，不进 NODE_OPTIONS；worker 需要的 --require 留着', () => {
  const args = dshArgs('0.1.7-rc.1')
  assert.ok(args.includes('--use-system-ca'), '证书库开关在命令行')
  assert.ok(args.some((arg) => arg.startsWith('--max-http-header-size')), '请求头上限在命令行')
  assert.ok(args.some((arg) => arg.startsWith('--import')), 'ESM 补丁钩子在命令行')

  const env = dshEnv('0.1.7-rc.1')
  assert.ok(!env.NODE_OPTIONS.includes('--use-system-ca'), '不能漏给子进程')
  assert.ok(!env.NODE_OPTIONS.includes('--max-http-header-size'), '不能漏给子进程')
  assert.match(env.NODE_OPTIONS, /--require /, 'worker 线程那份 CJS 补丁必须留着')
})

test('dsh shim 用的是启动器自己的 node：用户那套 node 再老也带得动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shim-'))
  const bin = join(dir, 'fake-dsh-bin.js')
  writeFileSync(bin, '// fake\n')
  const written = writeDshShims('0.1.7-rc.1', { dir: join(dir, 'bin'), bin })
  assert.equal(written, join(dir, 'bin'))
  const cmd = readFileSync(join(dir, 'bin', 'dsh.cmd'), 'utf8')
  assert.ok(cmd.includes(process.execPath), 'node 写死成启动器自己的')
  assert.ok(cmd.includes(bin), '指向当前版本的入口')
  assert.ok(readFileSync(join(dir, 'bin', 'dsh'), 'utf8').startsWith('#!/bin/sh'))
})

test('写 shim 时版本入口不存在（还没装好）就安静跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shim-'))
  assert.equal(writeDshShims('0.1.7-rc.1', { dir: join(dir, 'bin'), bin: join(dir, 'nope.js') }), '')
})

// desktop 是 dsh CLI 保留给官方 Electron 端、在参数解析阶段就拒掉的名字：入口得换成
// reserved-profile-boot.mjs（直接调 boot 层），argv 形状一个字不改，别的 profile 照旧。
test('CLI 保留的 profile 换绕行入口，其余 profile 仍走官方 bin.js', () => {
  const plain = dshArgs('0.1.7-rc.1', ['web', '--no-open'], 'web')
  const blocked = dshArgs('0.1.7-rc.1', ['desktop', '--host', '127.0.0.1'], 'desktop')
  const upper = dshArgs('0.1.7-rc.1', ['Desktop'], 'Desktop')

  assert.ok(plain.some((arg) => arg.endsWith('bin.js')), '普通 profile 还是 lib/bin.js')
  assert.ok(!plain.some((arg) => arg.endsWith('reserved-profile-boot.mjs')))
  assert.ok(blocked.some((arg) => arg.endsWith('reserved-profile-boot.mjs')), 'desktop 走绕行入口')
  assert.ok(upper.some((arg) => arg.endsWith('reserved-profile-boot.mjs')), '大小写不敏感')

  // 入口之后是先 bin.js（绕行入口的解析锚点）、再 profile 名与 app 参数：绕行入口按这个约定读 argv
  const at = blocked.findIndex((arg) => arg.endsWith('reserved-profile-boot.mjs'))
  assert.ok(blocked[at + 1].endsWith('bin.js'), '绕行入口的第一个参数是版本目录的 bin.js')
  assert.deepEqual(blocked.slice(at + 2), ['desktop', '--host', '127.0.0.1'])
  assert.ok(blocked.slice(0, at).includes('--use-system-ca'), 'node 开关与钩子照旧在前')

  // 普通 profile 不额外插参数
  const plainAt = plain.findIndex((arg) => arg.endsWith('bin.js'))
  assert.deepEqual(plain.slice(plainAt + 1), ['web', '--no-open'])

  // 不传 profile 的老调用（插件命令那条路）行为不变
  assert.deepEqual(dshArgs('0.1.7-rc.1', ['plugin', 'list']), dshArgs('0.1.7-rc.1', ['plugin', 'list'], ''))
})

// #12 的 store 错配：profile 的 .modules.yaml 记着建它那次用的是哪个 store（v3/v10/v11…），
// 插件操作要挑 store 对得上的那个 pnpm，否则 pnpm 会以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装。
test('从 profile 读出 store 版本：pnpm 8 与 pnpm 11 两种写法都要认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
  assert.equal(profileStoreVersion(dir), '', '没有 .modules.yaml 时是空串')

  const modules = join(dir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  // pnpm 8：无引号的 yaml
  writeFileSync(join(modules, '.modules.yaml'), 'storeDir: C:\\Users\\u\\AppData\\Local\\pnpm\\store\\v3\n')
  assert.equal(profileStoreVersion(dir), 'v3')
  // pnpm 10/11：带引号的 JSON
  writeFileSync(join(modules, '.modules.yaml'), '{ "storeDir": "C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\pnpm\\\\store\\\\v11" }\n')
  assert.equal(profileStoreVersion(dir), 'v11')
})

test('按 store 挑 pnpm：对得上的优先，全对不上就交回调用方回退', async () => {
  const stores = { 'C:\\sys': 'v3', 'C:\\bundle': 'v11' }
  const probe = (dir) => Promise.resolve(stores[dir] || '')
  assert.equal(await pickPnpmDir(['C:\\sys', 'C:\\bundle'], 'v11', probe), 'C:\\bundle', 'v11 的 profile 用自带那份')
  assert.equal(await pickPnpmDir(['C:\\sys', 'C:\\bundle'], 'v3', probe), 'C:\\sys', 'v3 的 profile 用系统那份')
  assert.equal(await pickPnpmDir(['C:\\sys', 'C:\\bundle'], 'v10', probe), '', '都对不上就回退')
  assert.equal(await pickPnpmDir(['C:\\sys'], '', probe), '', 'profile 没记 store 就按老规矩')
})

test('指名的 pnpm 目录顶到 PATH 最前（自带那份也可以）', () => {
  const bundled = dirWithPnpm()
  const npmRoot = dirWithPnpm()
  const other = plainDir()
  assert.deepEqual(orderRuntimePaths([other, npmRoot], bundled, bundled), [bundled, other, npmRoot], '指名自带那份时它在最前')
  assert.deepEqual(orderRuntimePaths([other, npmRoot], bundled, npmRoot), [npmRoot, bundled, other], '指名系统那份 = 老行为')
  assert.deepEqual(orderRuntimePaths([other, npmRoot], bundled), [npmRoot, bundled, other], '不指名照旧')
})

// issue #31：让系统里的 PowerShell / CMD 也能直接用 dsh —— 用户 PATH 里那条 shim 目录的增删
test('pathWithEntry：追加在末尾（不抢用户已有的命令），撤销时清干净', () => {
  const dir = process.platform === 'win32' ? String.raw`C:\Users\a\AppData\Roaming\DSH\bin` : '/tmp/Test Home/DSH/bin'
  const pathValue = (process.platform === 'win32' ? [String.raw`C:\Windows`, String.raw`C:\Program Files\nodejs`] : ['/usr/bin', '/bin']).join(delimiter)
  const on = pathWithEntry(pathValue, dir, true)
  assert.equal(on.split(delimiter).pop(), dir, '追加在末尾')
  assert.equal(pathWithEntry(on, dir, true), on, '重复开启不叠加')
  assert.equal(pathWithEntry(on, dir, false), pathValue, '撤销后回到原样')
  // 大小写不同也算同一条（Windows 的 PATH 不区分大小写）
  const upper = pathWithEntry(pathValue + delimiter + dir.toUpperCase(), dir, false)
  assert.ok(!upper.toLowerCase().includes(dir.toLowerCase()), '大写的旧条目也要清掉')
  assert.equal(pathWithEntry('', dir, true), dir, '空 PATH 也能加')
})


test('旧 PATH 也能发现 PNPM_HOME、全局 npm 和已安装 DSH 自带 pnpm，PATH 优先', () => {
  const root = plainDir(), local = plainDir(), app = plainDir(), pnpmHome = dirWithPnpm(), system = dirWithPnpm()
  const installed = join(local, 'Programs', 'DSH', 'node')
  const npm = join(app, 'npm')
  for (const dir of [installed, npm]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), '')
  }
  const env = { LOCALAPPDATA: local, APPDATA: app, PNPM_HOME: pnpmHome }
  assert.deepEqual(pnpmCandidates(system, env, root), [system, pnpmHome, npm, installed])
  assert.deepEqual(pnpmCandidates('', env, root), [pnpmHome, npm, installed])
  assert.deepEqual(pnpmCandidates(system + delimiter + system, env, root), [system, pnpmHome, npm, installed])
})
