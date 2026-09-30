/**
 * 内置插件（plugins/ 下的 dsh-x-memory 与 dsh-x-sync）的两条落地路径：
 *
 * 1. 预置：启动器把安装包自带的那两件复制到 $DSH_HOME/bundled/，再按 `file:` 装进当前 profile
 *    （「内置插件」开关，默认关；旧键 seedMemory 当别名读）；
 * 2. 内置整合包：推荐包（packs/dsh-x-recommended）里那两条 `"…": "bundled"` 依赖，
 *    安装时解析成同一批 file: 路径。
 *
 * 两条都跑真服务（假 dsh 入口）——复制、写清单、注册 bundle 都是启动器自己的代码，
 * 只有 pnpm 那一步被假入口挡掉，正是这里要验的边界。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGINS_ROOT = fileURLToPath(new URL('../plugins', import.meta.url))
const PACK_DIR = fileURLToPath(new URL('../packs/dsh-x-recommended', import.meta.url))
const BUNDLED = ['dsh-x-memory', 'dsh-x-sync']

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 起一套隔离的管理页（同 packs-api 的套路：临时 APPDATA / 数据目录 / dsh 家目录 + 假 dsh 入口）。 */
async function startManager() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-seed-plugins-'))
  const appData = join(root, 'appdata')
  const appDir = join(appData, 'DSH')
  const dataDir = join(root, 'data')
  const home = join(root, 'dsh-home')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  const port = await freePort()
  writeFileSync(join(appDir, 'settings.json'), JSON.stringify({
    dataDir,
    dshHome: home,
    port,
    autoStart: false,
    seedMarket: false,
  }, null, 2))
  // 假 dsh：版本目录里放一份能解析的入口，plugin 命令跑它就够了
  const fakeBin = join(dataDir, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(fakeBin, '..'), { recursive: true })
  writeFileSync(fakeBin, 'process.exit(0)\n')
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ versions: ['9.9.9'] }, null, 2))
  // 当前 profile 的清单：registerBundle 要有东西可写
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
  }, null, 2))

  process.env.APPDATA = appData
  process.env.DSH_VERSIONS_DATA = dataDir
  process.env.PORT = String(port)
  const server = await import('../server.js')
  const origin = await server.startServer()
  const call = async (path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body ?? {}),
    })
    return { status: res.status, data: await res.json() }
  }
  return { root, home, dataDir, profileDir, call, get: async (path) => {
    const res = await fetch(`${origin}${path}`, { headers: { origin } })
    return { status: res.status, data: await res.json() }
  }, stop: () => server.stopAll() }
}

test('内置插件与内置整合包', async (t) => {
  const manager = await startManager()
  t.after(() => {
    manager.stop()
    rmSync(manager.root, { recursive: true, force: true })
  })
  const bundledDir = join(manager.home, 'bundled')
  const versions = Object.fromEntries(BUNDLED.map((name) => [
    name,
    JSON.parse(readFileSync(join(PLUGINS_ROOT, name, 'package.json'), 'utf8')).version,
  ]))

  await t.test('默认关：设置里没写过这个键时，状态里是 false', async () => {
    const res = await manager.get('/api/settings')
    assert.equal(res.data.seedBundled, false, '内置插件默认应该是关闭的')
  })

  await t.test('旧键 seedMemory 还认：关掉就什么都不做', async () => {
    const res = await manager.call('/api/settings', { seedMemory: false })
    assert.equal(res.status, 200)
    assert.equal(res.data.seedBundled, false, '旧键当作别名写进新键')
    assert.ok(!existsSync(bundledDir), '关掉就不该复制')
  })

  await t.test('打开开关：两件都复制到 DSH_HOME 并写进 profile 的 bundles', async () => {
    const res = await manager.call('/api/settings', { seedBundled: true })
    assert.equal(res.status, 200)
    assert.equal(res.data.seedBundled, true)
    for (const name of BUNDLED) {
      assert.ok(existsSync(join(bundledDir, name, 'package.json')), `${name} 复制到了 DSH_HOME/bundled`)
      assert.equal(JSON.parse(readFileSync(join(bundledDir, name, 'package.json'), 'utf8')).version, versions[name])
      assert.ok(existsSync(join(bundledDir, name, 'lib', 'index.js')), `${name} 的主体在`)
      assert.ok(existsSync(join(bundledDir, name, 'cordis.patch.yml')), `${name} 的补丁层在`)
      assert.ok(!existsSync(join(bundledDir, name, 'test')), '用例不进用户机器')
    }
    assert.ok(existsSync(join(bundledDir, 'dsh-x-memory', 'lib', 'client.js')), '记忆的面板在')
    assert.ok(existsSync(join(bundledDir, 'dsh-x-sync', 'lib', 'client.js')), '同步的面板在')
    const manifest = JSON.parse(readFileSync(join(manager.profileDir, 'package.json'), 'utf8'))
    for (const name of BUNDLED) {
      assert.ok(manifest.dsh.profile.bundles.includes(name), `bundle 列表里要有 ${name}，否则 dsh 不加载`)
    }
  })

  await t.test('重复打开不重复登记', async () => {
    const res = await manager.call('/api/settings', { seedBundled: true })
    assert.equal(res.status, 200)
    const manifest = JSON.parse(readFileSync(join(manager.profileDir, 'package.json'), 'utf8'))
    for (const name of BUNDLED) {
      assert.equal(manifest.dsh.profile.bundles.filter((item) => item === name).length, 1)
    }
  })

  await t.test('内置整合包：两件 bundled 依赖都解析成 DSH_HOME 下那份的 file: 路径', async () => {
    const packs = await manager.get('/api/packs')
    assert.equal(packs.data.builtin?.name, 'dsh-x-recommended', '/api/packs 要带上内置整合包的信息')
    assert.ok(packs.data.builtin.path.endsWith('dsh-x-recommended'))

    const inspect = await manager.call('/api/packs/inspect', { source: PACK_DIR })
    assert.equal(inspect.status, 200, inspect.data.error)
    assert.equal(inspect.data.ok, true, JSON.stringify(inspect.data.plan?.errors))
    assert.equal(inspect.data.pack.name, 'dsh-x-recommended')
    const install = await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'dshx' })
    assert.equal(install.status, 200, install.data.error)
    const manifest = JSON.parse(readFileSync(join(manager.home, 'profiles', 'dshx', 'package.json'), 'utf8'))
    for (const name of BUNDLED) {
      assert.equal(manifest.dependencies[name], `file:${join(bundledDir, name)}`, `${name} 的 bundled 依赖要落成绝对路径`)
      assert.ok(manifest.dsh.profile.bundles.includes(name))
    }
    assert.match(manifest.dependencies['dsh-config-manager'], /^\^/, '生态插件仍然按版本从 npm 装')
  })
})
