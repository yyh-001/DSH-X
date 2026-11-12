import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createCoreRecovery, isEnvironmentStartupError } from '../shell/core-recovery.mjs'

function fixture(t, { pending = true, previous = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-core-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const appDir = join(root, 'DSH'), current = join(appDir, 'core', 'current'), old = join(appDir, 'core', 'previous')
  mkdirSync(current, { recursive: true })
  writeFileSync(join(current, 'server.js'), 'valid current core')
  if (previous) { mkdirSync(old); writeFileSync(join(old, 'server.js'), 'valid previous core') }
  if (pending) writeFileSync(join(appDir, 'core', 'pending'), JSON.stringify({ version: '0.1.26-rc.4', at: 1 }))
  writeFileSync(join(appDir, 'core', 'bootstrap.json'), JSON.stringify({ version: '0.1.25', failed: ['0.1.25'], at: 0 }))
  let relaunches = 0
  const recovery = createCoreRecovery({ appDir, relaunch: () => { relaunches++ }, log() {} })
  const files = ['core/current/server.js', 'core/previous/server.js', 'core/pending', 'core/bootstrap.json']
  const snapshot = () => files.map(file => existsSync(join(appDir, file)) ? readFileSync(join(appDir, file), 'utf8') : null)
  return { root, appDir, current, old, recovery, snapshot, relaunches: () => relaunches }
}

const systemError = (code, syscall, path) => Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path })

test('原生权限/磁盘/资源错误保留核心，模块错误与代码错误仍可恢复', () => {
  const core = join(tmpdir(), 'DSH', 'core', 'current')
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO', 'ENODEV', 'ENXIO', 'EBUSY', 'ESTALE']) {
    assert.equal(isEnvironmentStartupError(systemError(code, 'open', join(core, 'server.js')), core), true, code)
  }
  for (const error of [new TypeError('broken'), new ReferenceError('broken'), new SyntaxError('broken'), { code: 'ERR_MODULE_NOT_FOUND' }, { code: 'ERR_REQUIRE_ESM' }, { code: 'EACCES' }, new TypeError('bad code', { cause: systemError('EACCES', 'open', '/data') })]) {
    assert.equal(isEnvironmentStartupError(error, core), false, String(error))
  }
  assert.equal(isEnvironmentStartupError(systemError('EADDRINUSE', 'listen'), core), true)
  assert.equal(isEnvironmentStartupError(systemError('EADDRNOTAVAIL', 'listen'), core), true)
  assert.equal(isEnvironmentStartupError(systemError('EAFNOSUPPORT', 'listen'), core), true)
  assert.equal(isEnvironmentStartupError(systemError('EADDRINUSE', 'open'), core), false)
})

test('缺核心文件仍回退，外部数据路径和 mkdir 失败不误删核心', () => {
  const core = join(tmpdir(), 'DSH', 'core', 'current')
  for (const code of ['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP']) {
    assert.equal(isEnvironmentStartupError(systemError(code, 'open', join(core, 'asset.json')), core), false, code)
    assert.equal(isEnvironmentStartupError(systemError(code, 'open', join(core + '-other', 'config.json')), core), true, code)
    assert.equal(isEnvironmentStartupError(systemError(code, 'open', join(core, '..', 'settings.json')), core), true, code)
    assert.equal(isEnvironmentStartupError(systemError(code, 'mkdir', join(core, 'user-data')), core), true, code)
    assert.equal(isEnvironmentStartupError(systemError(code, 'open', 'relative-unknown'), core), false, code)
  }
  if (process.platform === 'win32') {
    const windowsCore = String.raw`C:\Users\tester\DSH\core\current`
    assert.equal(isEnvironmentStartupError(systemError('ENOENT', 'open', String.raw`c:\users\TESTER\dsh\CORE\CURRENT\asset.json`), windowsCore), false)
    assert.equal(isEnvironmentStartupError(systemError('ENOENT', 'open', String.raw`D:\data\config.json`), windowsCore), true)
    assert.equal(isEnvironmentStartupError(systemError('ENOENT', 'open', String.raw`\\server\share\data\config.json`), windowsCore), true)
  }
})

for (const previous of [false, true]) {
  test(`环境错误保留 current/pending/黑名单原文${previous ? '与 previous' : '（首次安装）'}，不重启`, (t) => {
    const f = fixture(t, { previous }), before = f.snapshot()
    for (const error of [systemError('ENOTDIR', 'mkdir', join(f.root, 'data')), systemError('EACCES', 'mkdir', join(f.root, 'data')), systemError('ENOSPC', 'write', join(f.appDir, 'settings.json')), systemError('EADDRINUSE', 'listen')]) {
      assert.equal(f.recovery.recoverCore(f.current, { pendingOnly: true, error }), false)
      assert.deepEqual(f.snapshot(), before)
      assert.equal(f.relaunches(), 0)
    }
    // import 阶段的权限失败也不能把有效核心删掉。
    assert.equal(f.recovery.recoverCore(f.current, { error: systemError('EACCES', 'open', join(f.current, 'server.js')) }), false)
    assert.deepEqual(f.snapshot(), before)
  })
}

test('待验证核心的代码错误仍拉黑并回退到 previous', (t) => {
  const f = fixture(t)
  assert.equal(f.recovery.recoverCore(f.current, { pendingOnly: true, error: new TypeError('bad core startup') }), true)
  assert.equal(readFileSync(join(f.current, 'server.js'), 'utf8'), 'valid previous core')
  assert.equal(existsSync(f.old), false)
  assert.equal(existsSync(join(f.appDir, 'core', 'pending')), false)
  assert.deepEqual(f.recovery.failedCoreVersions(), ['0.1.25', '0.1.26-rc.4'])
  assert.equal(f.relaunches(), 1)
})

test('没有 pending 的旧核心启动失败不回退，源码/CLI 目录不被删除', (t) => {
  const f = fixture(t, { pending: false }), before = f.snapshot()
  assert.equal(f.recovery.recoverCore(f.current, { pendingOnly: true, error: new ReferenceError('bad startup') }), false)
  assert.equal(f.recovery.recoverCore(join(f.root, 'source'), { error: new SyntaxError('bad source') }), false)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.relaunches(), 0)
})

test('真实语法错误和缺失模块仍触发坏核心恢复', async (t) => {
  for (const source of ['export const invalid = ;', "import './missing-file.mjs'"]) {
    await t.test(source, async (t) => {
      const f = fixture(t, { previous: false })
      const entry = join(f.current, 'broken.mjs')
      writeFileSync(entry, source)
      let error
      try { await import(pathToFileURL(entry).href) } catch (caught) { error = caught }
      assert.ok(error instanceof SyntaxError || error?.code === 'ERR_MODULE_NOT_FOUND')
      assert.equal(f.recovery.recoverCore(f.current, { error }), true)
      assert.equal(existsSync(f.current), false)
      assert.deepEqual(f.recovery.failedCoreVersions(), ['0.1.25', '0.1.26-rc.4'])
      assert.equal(f.relaunches(), 1)
    })
  }
})

test('原生 ENOENT 缺核心文件仍恢复，旧格式黑名单兼容', (t) => {
  const f = fixture(t, { previous: false })
  writeFileSync(join(f.appDir, 'core', 'bootstrap.json'), JSON.stringify({ version: '0.1.24' }))
  let error
  try { readFileSync(join(f.current, 'missing-asset.json')) } catch (caught) { error = caught }
  assert.equal(error.code, 'ENOENT')
  assert.equal(f.recovery.recoverCore(f.current, { pendingOnly: true, error }), true)
  assert.deepEqual(f.recovery.failedCoreVersions(), ['0.1.24', '0.1.26-rc.4'])
})

// 用真实 server.startServer() 的 mkdir 错误走同一个恢复入口，不只构造错误对象。
// 子进程隔离模块初始化时读到的 HOME/APPDATA，避免接触测试者的设置和版本目录。
const serverUrl = new URL('../src/server.js', import.meta.url).href
const recoveryUrl = new URL('../shell/core-recovery.mjs', import.meta.url).href
const homeUrl = new URL('./isolated-home.mjs', import.meta.url).href
for (const mode of ['ENOTDIR', 'EACCES']) {
  for (const previous of [false, true]) {
    test(`真实 startServer ${mode}${previous ? '（含 previous）' : '（首启）'}保留核心，修复路径后同一核心能启动`, { skip: mode === 'EACCES' && (process.platform === 'win32' || process.getuid?.() === 0) }, (t) => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-core-environment-'))
      t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
      const script = `
        import assert from 'node:assert/strict'
        import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
        import { createServer } from 'node:net'
        import { join } from 'node:path'
        import { isolateUserHome } from ${JSON.stringify(homeUrl)}
        import { createCoreRecovery } from ${JSON.stringify(recoveryUrl)}
        const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)}
        const appDir = isolateUserHome(root), parent = join(root, 'blocked'), dataDir = join(parent, 'data')
        process.env.DSH_CORE = '1'
        delete process.env.DSH_NPM
        mkdirSync(appDir, { recursive: true })
        if (mode === 'ENOTDIR') writeFileSync(parent, 'file blocking data directory')
        else { mkdirSync(parent); chmodSync(parent, 0o500) }
        const current = join(appDir, 'core', 'current'), old = join(appDir, 'core', 'previous')
        mkdirSync(current, { recursive: true }); writeFileSync(join(current, 'server.js'), 'valid core')
        if (${previous}) { mkdirSync(old); writeFileSync(join(old, 'server.js'), 'previous core') }
        writeFileSync(join(appDir, 'core', 'pending'), JSON.stringify({ version: '0.1.26-rc.4' }))
        writeFileSync(join(appDir, 'core', 'bootstrap.json'), JSON.stringify({ version: '0.1.25', failed: ['0.1.25'] }))
        writeFileSync(join(appDir, 'settings.json'), JSON.stringify({ dataDir, dshHome: join(root, 'home'), seedMarket: false, autoUpdate: false, launchPresets: [] }))
        const files = ['core/current/server.js', 'core/previous/server.js', 'core/pending', 'core/bootstrap.json']
        const snapshot = () => files.map(f => existsSync(join(appDir, f)) ? readFileSync(join(appDir, f), 'utf8') : null)
        const before = snapshot()
        const recovery = createCoreRecovery({ appDir, relaunch() { assert.fail('环境错误不应重启') } })
        const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r))
        process.env.PORT = String(probe.address().port); await new Promise(r => probe.close(r))
        const core = await import(${JSON.stringify(serverUrl)})
        let error
        try { await core.startServer() } catch (caught) { error = caught }
        assert.equal(error?.code, mode)
        assert.equal(error?.syscall, 'mkdir')
        // Windows 的 libuv 报 ENOTDIR 时给的是被挡住的那一级（parent），POSIX 给完整 dataDir
        const expectedPaths = mode === 'ENOTDIR' && process.platform === 'win32' ? [parent, dataDir] : [dataDir]
        assert.ok(expectedPaths.includes(error?.path), 'error.path=' + error?.path)
        assert.equal(recovery.recoverCore(current, { pendingOnly: true, error }), false)
        assert.deepEqual(snapshot(), before)
        if (mode === 'ENOTDIR') rmSync(parent)
        else chmodSync(parent, 0o700)
        const url = await core.startServer()
        // 管理页要会话 cookie：用 launch token 换一次再读（和浏览器 / 外壳走同一条路）
        const exchange = await fetch(core.managerUrlWithToken(), { redirect: 'manual' })
        const cookie = String(exchange.headers.get('set-cookie') || '').split(';')[0]
        assert.equal((await fetch(url, { headers: { cookie } })).status, 200)
        assert.deepEqual(snapshot(), before, '仅启动服务不应擅自改恢复标记，成功后的清理由外壳负责')
        await core.stopAll()
        // Windows + Node 24：undici 的连接还在关闭时 process.exit 会撞 libuv 的
        // UV_HANDLE_CLOSING 断言（同一个脚本只发一次请求就不会）。等一拍再退。
        await new Promise((resolve) => setTimeout(resolve, 250))
        console.log('REAL_CORE_RETRY_OK')
        process.exit(0)
      `
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 })
      assert.match(output, /REAL_CORE_RETRY_OK/)
    })
  }
}

test('外壳把原始错误传入两个恢复入口，EALREADY 仍先唤醒现有实例', () => {
  const main = readFileSync(new URL('../shell/main.mjs', import.meta.url), 'utf8')
  assert.match(main, /recoverCore\(coreDir, \{ error \}\)/)
  assert.match(main, /recoverCore\(coreDir, \{ pendingOnly: true, error \}\)/)
  const startCatch = main.slice(main.indexOf('await server.startServer()'))
  assert.ok(startCatch.indexOf("error?.code === 'EALREADY'") < startCatch.indexOf('recoverCore('))
  assert.match(startCatch, /api\/wake/)
  assert.match(startCatch, /rmSync\(join\(APP_DIR, 'core', 'pending'\), \{ force: true \}\)/)
  assert.match(startCatch, /rmSync\(PREVIOUS_CORE, \{ recursive: true, force: true \}\)/)
})
