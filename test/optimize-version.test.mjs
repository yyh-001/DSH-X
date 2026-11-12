import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { optimizeDependencies } from '../src/registry.js'

const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
// 切片终点跟着 server.js 的函数签名走：killTree 改成 async 后这里会切到文件末尾，
// 把 export 语句也带进来，vm 里就是「Unexpected token 'export'」。
const code = source.slice(source.indexOf('async function optimizeVersion('), source.indexOf('\nasync function killTree('))
const starting = source.slice(source.indexOf('async function start(version, profile)'), source.indexOf('\nexport async function launchInstalled('))

function manager(overrides = {}) {
  const ctx = vm.createContext({
    installing: null, optimizingVersion: null, installProgress: null, packInstalling: false, pluginBusy: false,
    startChains: new Map(), startingProfiles: new Set(), safeVersion: value => value, safeProfile: value => value,
    profileKey: value => value, PROFILE_NAME: 'web', maintainingProfiles: new Set(),
    revokeIdleInstanceLinks() {},
    instanceList: () => [], isManaged: () => true, existsSync: () => true, binPath: version => version,
    versionDir: version => '/versions/' + version, pushLog() {}, emit() {}, emitState: async () => {},
    optimizeDependencies: async () => {}, assertStartupActive() {}, startWithRepair: async () => { throw new Error('不应启动') },
    ...overrides,
  })
  vm.runInContext(code + '\n' + starting, ctx)
  return ctx
}

test('只整理已安装的闲置受管版本，启动准备与其它安装操作均受保护', async () => {
  for (const change of [
    { installing: '2.0.0' }, { packInstalling: true }, { pluginBusy: true },
    { startChains: new Map([['pending', Promise.resolve()]]) }, { startingProfiles: new Set(['web']) },
    { instanceList: () => [{ version: '1.0.0', status: 'stopping' }] },
    { isManaged: () => false }, { existsSync: () => false },
  ]) {
    let called = false
    const ctx = manager({ ...change, optimizeDependencies: async () => { called = true } })
    await assert.rejects(ctx.optimizeVersion('1.0.0'))
    assert.equal(called, false)
  }
})

test('整理前同步占锁，阻止并发启动与整理；失败释放状态后可重试', async () => {
  let reject, calls = 0
  const ctx = manager({ optimizeDependencies: async root => {
    assert.equal(root, '/versions/1.0.0')
    if (++calls === 1) await new Promise((_resolve, fail) => { reject = fail })
  } })
  const first = ctx.optimizeVersion('1.0.0')
  const rejected = assert.rejects(first, /offline/)
  assert.equal(ctx.optimizingVersion, '1.0.0')
  await assert.rejects(ctx.start('1.0.0', 'web'), /优化/)
  await assert.rejects(ctx.optimizeVersion('1.0.0'), /安装或启动/)
  reject(new Error('offline'))
  await rejected
  assert.equal(ctx.optimizingVersion, null)
  assert.equal(ctx.installing, null)
  assert.equal(ctx.installProgress, null)
  await ctx.optimizeVersion('1.0.0')
  assert.equal(calls, 2)
})

test('真实 npm 离线整理重复依赖，保留不兼容版本，不执行包脚本或改直接依赖', {
  skip: !existsSync(join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-optimize-'))
  const previousRegistry = process.env.npm_config_registry, previousCache = process.env.npm_config_cache
  const packages = new Map()
  const registry = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://registry').pathname.slice(1))
    const versions = packages.get(name)
    if (!versions) { res.writeHead(404); res.end(JSON.stringify({ error: name })); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name, 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions }))
  })
  const pkg = (path, data) => {
    const dir = join(root, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(data))
    writeFileSync(join(dir, 'index.js'), 'module.exports = 1\n')
    if (!packages.has(data.name)) packages.set(data.name, {})
    packages.get(data.name)[data.version] = { ...data, dist: { tarball: 'http://127.0.0.1/not-needed.tgz' } }
  }
  try {
    const manifest = JSON.stringify({ name: 'fixture', version: '1.0.0', private: true,
      dependencies: { 'fixture-a': '1.0.0', 'fixture-b': '1.0.0', 'fixture-c': '1.0.0' },
      scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'script-ran\',\'bad\')"' } })
    writeFileSync(join(root, 'package.json'), manifest)
    pkg('node_modules/fixture-a', { name: 'fixture-a', version: '1.0.0', dependencies: { 'fixture-shared': '1.0.0' } })
    pkg('node_modules/fixture-b', { name: 'fixture-b', version: '1.0.0', dependencies: { 'fixture-shared': '1.0.0' } })
    pkg('node_modules/fixture-c', { name: 'fixture-c', version: '1.0.0', dependencies: { 'fixture-shared': '2.0.0' } })
    pkg('node_modules/fixture-shared', { name: 'fixture-shared', version: '1.0.0' })
    pkg('node_modules/fixture-a/node_modules/fixture-shared', { name: 'fixture-shared', version: '1.0.0' })
    pkg('node_modules/fixture-c/node_modules/fixture-shared', { name: 'fixture-shared', version: '2.0.0' })
    await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))
    process.env.npm_config_registry = `http://127.0.0.1:${registry.address().port}`
    process.env.npm_config_cache = join(root, 'npm-cache')
    // 只向回环假仓库取元数据，不修改依赖树；随后关闭仓库，证明正式整理能离线完成。
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        'dedupe', '--dry-run', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'],
      { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let errors = ''
      child.stdout.resume()
      child.stderr.on('data', chunk => { errors += chunk })
      child.once('error', reject)
      child.once('exit', code => code ? reject(new Error(errors)) : resolve())
    })
    await new Promise(resolve => registry.close(resolve))
    assert.equal(existsSync(join(root, 'node_modules/fixture-a/node_modules/fixture-shared')), true)
    const logs = []
    await optimizeDependencies(root, line => logs.push(line))
    assert.equal(existsSync(join(root, 'node_modules/fixture-a/node_modules/fixture-shared')), false, logs.join('\n'))
    assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/fixture-c/node_modules/fixture-shared/package.json'))).version, '2.0.0')
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), manifest)
    assert.equal(existsSync(join(root, 'script-ran')), false)
    assert.equal(existsSync(join(root, 'package-lock.json')), false)
  } finally {
    registry.close()
    if (previousRegistry === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previousRegistry
    if (previousCache === undefined) delete process.env.npm_config_cache
    else process.env.npm_config_cache = previousCache
    rmSync(root, { recursive: true, force: true })
  }
})
