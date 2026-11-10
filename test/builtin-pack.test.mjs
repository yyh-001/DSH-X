/**
 * 内置环境（src/packs/dsh-x-recommended）：随安装包发的配方，导入成一个环境，四件依赖都按版本从 npm 装。
 *
 * 跑真服务（假 dsh 入口 + 假 npm registry）。配方以前是「整包装进一个 Profile」，现在是内置环境：
 * 环境页列出来 → 检查（只读）→ 导入成一个普通环境；导入这一步只存环境清单，不往任何 Profile 里装东西，
 * 下次用这个环境启动时才写进 Profile、装依赖。
 * 配方里写的是范围（^0.1.65 这种）：环境只锁直接依赖，导入时按 registry 钉成此刻满足范围的最高版本。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startPluginRegistry } from './environments-fixture.mjs'

const RECIPE = 'dsh-x-recommended'
const PACKAGES = ['dsh-config-manager', 'dsh-x-memory', 'dsh-x-sync', 'dsh-x-aquarium']
// 假 registry 上的版本表：每个范围都有一个「满足但不是最新」的答案，钉错（拿 latest、拿范围下限）一眼看得出来
const PUBLISHED = {
  'dsh-config-manager': { versions: ['0.1.60', '0.1.65', '0.1.70', '0.2.0'], pinned: '0.1.70' },
  'dsh-x-memory': { versions: ['0.1.0', '0.1.1', '0.1.4', '1.0.0'], pinned: '0.1.4' },
  'dsh-x-sync': { versions: ['0.1.0', '0.1.1', '0.1.9', '0.2.0'], pinned: '0.1.9' },
  'dsh-x-aquarium': { versions: ['0.1.2', '0.1.3', '0.1.8', '1.0.0-rc.1'], pinned: '0.1.8' },
}

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
  // 假 dsh：被拉起一次就往 DSH_HOME/calls.log 记一行，用来证明导入时没跑任何 dsh 命令（没往 Profile 装东西）
  const fakeBin = join(dataDir, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(fakeBin, '..'), { recursive: true })
  writeFileSync(fakeBin, "import { appendFileSync } from 'node:fs'\nimport { join } from 'node:path'\nappendFileSync(join(process.env.DSH_HOME, 'calls.log'), process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(0)\n")
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ versions: ['9.9.9'] }, null, 2))
  // 默认 Profile 的清单：导入前后要一个字节不差
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
  }, null, 2))

  // 插件版本从这里查，不出网（服务端每次用时现读 npm_config_registry）
  const registry = await startPluginRegistry(Object.fromEntries(Object.entries(PUBLISHED).map(([name, { versions }]) => [
    name, { versions, tags: { latest: versions.at(-1) } },
  ])))
  process.env.npm_config_registry = registry.url
  process.env.APPDATA = appData
  process.env.DSH_VERSIONS_DATA = dataDir
  process.env.PORT = String(port)
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  const call = async (path, body) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body ?? {}),
    })
    return { status: res.status, data: await res.json() }
  }
  return { root, appDir, home, dataDir, profileDir, call, get: async (path) => {
    const res = await fetch(`${origin}${path}`, { headers: { origin } })
    return { status: res.status, data: await res.json() }
  }, registry, stop: async () => { server.stopAll(); await registry.close() } }
}

test('内置环境：配方导入成一个环境，四件依赖钉成 npm 上的精确版本，导入时不碰任何 Profile', async (t) => {
  const manager = await startManager()
  t.after(async () => {
    await manager.stop()
    rmSync(manager.root, { recursive: true, force: true })
  })

  // 内置配方只在环境页列（/api/environments 的 builtin）；/api/packs 不再带一份
  const packs = await manager.get('/api/packs')
  assert.equal(packs.status, 200)
  assert.equal('builtin' in packs.data, false, '/api/packs 不再有 builtin 字段')

  const recipeOf = async () => (await manager.get('/api/environments')).data.builtin?.find((item) => item.name === RECIPE)
  const before = await recipeOf()
  assert.ok(before, '/api/environments 的 builtin 要列出内置配方')
  assert.ok(before.displayName, '有给人看的名字')
  assert.ok(before.version, '有版本号')
  assert.equal(typeof before.description, 'string')
  assert.equal(before.imported, false, '还没导入过')
  const envCount = (await manager.get('/api/environments')).data.environments.length
  const profileBytes = readFileSync(join(manager.profileDir, 'package.json'))

  const inspect = await manager.call('/api/environments/import/inspect', { builtin: RECIPE })
  assert.equal(inspect.status, 200, inspect.data.error)
  assert.equal(inspect.data.ok, true, JSON.stringify(inspect.data.errors))
  const preview = inspect.data.environment
  assert.equal(preview.packId, RECIPE)
  const plugins = preview.plugins.filter((plugin) => !plugin.official)
  assert.deepEqual(plugins.map((plugin) => plugin.name).sort(), [...PACKAGES].sort(), '四件都在插件清单里')
  for (const plugin of plugins) {
    // 依赖都要是 npm 上的精确版本：范围按 registry 钉成满足它的最高版本，不能再有 bundled，也不能是本地路径
    assert.equal(plugin.spec, PUBLISHED[plugin.name].pinned, `${plugin.name} 钉成满足范围的最高版本`)
    assert.equal(plugin.local, false, `${plugin.name} 不是本地插件`)
    assert.equal(plugin.offline, false, `${plugin.name} 不带离线文件`)
    assert.equal(plugin.bundle, true, `${plugin.name} 要在 bundle 列表里，否则 dsh 不加载`)
  }
  // 配方写的是范围（>=0.1.6）：本机已装的 9.9.9 满足，就用它，不联网也不再装一个
  assert.equal(preview.dshVersion, '9.9.9', '取本机已装、满足范围的最高版本')
  assert.equal(preview.dshInstalled, true)
  assert.deepEqual(inspect.data.warnings, [], '每个范围都钉上了，没有提醒')
  for (const name of PACKAGES) assert.ok(manager.registry.asked(name), `${name} 的版本是查 registry 得来的`)
  assert.equal((await manager.get('/api/environments')).data.environments.length, envCount, '检查是只读的：不建环境')

  const imported = await manager.call('/api/environments/import', { token: inspect.data.token })
  assert.equal(imported.status, 200, imported.data.error)
  assert.equal(imported.data.ok, true)
  const id = imported.data.environment?.id
  assert.ok(id, '导入要回新环境')
  assert.ok(existsSync(join(manager.appDir, 'envs', id, 'environment.json')), '环境清单落在启动器的设置目录里')
  const view = (await manager.get('/api/environments')).data.environments.find((item) => item.id === id)
  assert.ok(view, '导入的环境出现在列表里')
  assert.deepEqual(view.plugins.filter((plugin) => !plugin.official).map((plugin) => plugin.name).sort(), [...PACKAGES].sort())
  for (const name of PACKAGES) assert.ok(view.bundles.includes(name), `${name} 要挂载`)
  // 存下来的是检查时钉好的那一份精确版本
  const saved = JSON.parse(readFileSync(join(manager.appDir, 'envs', id, 'environment.json'), 'utf8'))
  for (const name of PACKAGES) assert.equal(saved.base.dependencies[name], PUBLISHED[name].pinned, `${name} 在环境清单里是精确版本`)
  assert.equal((await recipeOf()).imported, true, '导入过一次就标成已导入')

  // 导入只存环境：不建配方里写的那个 Profile，不改现有 Profile，也不跑 dsh 去装依赖
  assert.equal(existsSync(join(manager.home, 'profiles', 'dshx')), false, '不再新建 dshx 这份 Profile')
  assert.ok(readFileSync(join(manager.profileDir, 'package.json')).equals(profileBytes), '现有 Profile 的清单一个字节不改')
  assert.equal(existsSync(join(manager.home, 'calls.log')), false, '导入时没跑任何 dsh 命令')
})
