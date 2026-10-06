/**
 * 内置整合包（packs/dsh-x-recommended）：随安装包发的配方，四件依赖都按版本从 npm 装。
 *
 * 跑真服务（假 dsh 入口）——写清单、注册 bundle 都是启动器自己的代码，
 * 只有 pnpm 那一步被假入口挡掉，正是这里要验的边界。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const PACK_DIR = fileURLToPath(new URL('../packs/dsh-x-recommended', import.meta.url))
const PACKAGES = ['dsh-config-manager', 'dsh-x-memory', 'dsh-x-sync', 'dsh-x-aquarium']

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 起一套隔离的管理页（同 packs-api 的套路：临时 APPDATA / 数据目录 / dsh 家目录 + 假 dsh 入口）。 */
async function startManager() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-builtin-pack-'))
  const appData = join(root, 'appdata')
  const appDir = isolateUserHome(root, appData)
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

test('内置整合包：四件依赖都按版本从 npm 装', async (t) => {
  const manager = await startManager()
  t.after(() => {
    manager.stop()
    rmSync(manager.root, { recursive: true, force: true })
  })

  const packs = await manager.get('/api/packs')
  assert.equal(packs.data.builtin?.name, 'dsh-x-recommended', '/api/packs 要带上内置整合包的信息')
  assert.ok(packs.data.builtin.path.endsWith('dsh-x-recommended'))

  const inspect = await manager.call('/api/packs/inspect', { source: PACK_DIR })
  assert.equal(inspect.status, 200, inspect.data.error)
  assert.equal(inspect.data.ok, true, JSON.stringify(inspect.data.plan?.errors))
  assert.equal(inspect.data.pack.name, 'dsh-x-recommended')
  assert.deepEqual(inspect.data.pack.bundles.map((item) => item.name).sort(), [...PACKAGES].sort(), '四件都在层栈里')
  assert.ok(inspect.data.pack.dependencies.every((dep) => /^\^/.test(dep.spec)), '依赖都要是版本号，不能再有 bundled')

  const install = await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'dshx' })
  assert.equal(install.status, 200, install.data.error)
  const manifest = JSON.parse(readFileSync(join(manager.home, 'profiles', 'dshx', 'package.json'), 'utf8'))
  for (const name of PACKAGES) {
    assert.match(manifest.dependencies[name], /^\^/, `${name} 按版本从 npm 装`)
    assert.ok(manifest.dsh.profile.bundles.includes(name), `${name} 要在 bundle 列表里，否则 dsh 不加载`)
  }
})
