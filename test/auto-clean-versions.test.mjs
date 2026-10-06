/**
 * 设置页里的「自动清理旧版本」开关。
 *
 * 装完新版本删掉更旧的是老行为，现在它是可选项：默认仍然替用户清理（只留最新的和
 * 最近装的一个，够回退），但显式关掉之后一个版本都不能删——用户宁可占几百 MB 也要
 * 留住每一个装过的版本。这里用真的版本目录跑真函数，别让「关掉了还在删」漏出去。
 *
 * APP_DIR / 版本目录都是 import 时定下的，所以环境要在 import server.js 之前摆好。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** 挑一个当前没人用的端口，免得撞上用户正开着的那个管理页（默认 3780）。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const appDir = mkdtempSync(join(tmpdir(), 'dsh-autoclean-'))
const APP = isolateUserHome(appDir)
const DATA = join(appDir, 'data')
const ROOT = join(DATA, 'versions')
process.env.APPDATA = appDir
process.env.PORT = String(await freePort())
mkdirSync(APP, { recursive: true })

/** 一份配置的写法：假的版本目录 + settings.json（dataDir 指到临时目录）。 */
function writeSettings(extra = {}) {
  writeFileSync(join(APP, 'settings.json'), JSON.stringify({
    dataDir: DATA,
    // 预置市场要联网跑 pnpm，测试里关掉
    seedMarket: false,
    ...extra,
  }), 'utf8')
}
writeSettings()

/** 摆出几个「已装」的版本（只要管理页认得的那几个文件在位就算）。 */
function installVersions(...versions) {
  rmSync(ROOT, { recursive: true, force: true })
  for (const version of versions) {
    const lib = join(ROOT, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'bin.js'), '// 假的 dsh\n', 'utf8')
  }
}

const onDisk = () => readdirSync(ROOT).sort()

const { pruneVersions, snapshot } = await import('../server.js')

// 受管 fixture 还未生成，只精确允许此时已发现的全局版本，不能过滤掉后来混入的条目。
const initialVersions = (await snapshot()).versions
assert.ok(initialVersions.every((item) => item.managed === false), '临时版本目录起初应为空')
assert.ok(initialVersions.length <= 1, '系统发现逻辑最多提供一个全局版本')
const knownSystemVersions = initialVersions.map((item) => item.version)

test.after(() => rmSync(appDir, { recursive: true, force: true }))

test('默认（设置里没这个键）：装完新版留下最新的和最近装的一个，更旧的删掉', async () => {
  installVersions('0.1.11', '0.1.12', '0.1.13')
  const config = { versions: ['0.1.13', '0.1.12', '0.1.11'] }
  assert.deepEqual(await pruneVersions(config), ['0.1.11'])
  assert.deepEqual(onDisk(), ['0.1.12', '0.1.13'])
  const expectedVersions = [...new Set(['0.1.13', '0.1.12', ...knownSystemVersions])]
  assert.deepEqual(config.versions, expectedVersions, '完整列表只保留存活的受管版本和预先记录的全局版本，拒绝额外条目')
})

test('设置里关掉之后：一个都不删，配置也不动', async () => {
  writeSettings({ autoCleanVersions: false })
  installVersions('0.1.11', '0.1.12', '0.1.13')
  const config = { versions: ['0.1.13', '0.1.12', '0.1.11'] }
  assert.deepEqual(await pruneVersions(config), [], '应该一个都不清理')
  assert.deepEqual(onDisk(), ['0.1.11', '0.1.12', '0.1.13'])
  assert.deepEqual(config.versions, ['0.1.13', '0.1.12', '0.1.11'], '没删就别改配置')
})

test('再打开开关：照旧清理（关掉只是当次生效，不是一次性的）', async () => {
  writeSettings({ autoCleanVersions: true })
  installVersions('0.1.11', '0.1.12', '0.1.13')
  assert.deepEqual(await pruneVersions({ versions: ['0.1.13', '0.1.12', '0.1.11'] }), ['0.1.11'])
  assert.deepEqual(onDisk(), ['0.1.12', '0.1.13'])
})

test('不足两个以外还有余量时不动手：只有两个版本时开关关不关都无所谓', async () => {
  writeSettings({ autoCleanVersions: true })
  installVersions('0.1.12', '0.1.13')
  assert.deepEqual(await pruneVersions({ versions: ['0.1.13', '0.1.12'] }), [])
  assert.deepEqual(onDisk(), ['0.1.12', '0.1.13'])
})

test('自定义保留数量实际控制清理；运行中的版本始终额外保留', async () => {
  writeSettings({ keepVersions: 3 })
  installVersions('0.1.10', '0.1.11', '0.1.12', '0.1.13')
  assert.deepEqual(await pruneVersions({ versions: ['0.1.13', '0.1.12', '0.1.11', '0.1.10'] }), ['0.1.10'])
  assert.deepEqual(onDisk(), ['0.1.11', '0.1.12', '0.1.13'])
  writeSettings({ keepVersions: 1 })
  installVersions('0.1.12', '0.1.13')
  assert.deepEqual(await pruneVersions({ versions: ['0.1.13', '0.1.12'] }), ['0.1.12'])
  assert.deepEqual(onDisk(), ['0.1.13'])
  const { versionsToKeep } = await import('../server.js')
  assert.deepEqual([...versionsToKeep(['0.1.13', '0.1.12', '0.1.11'], ['0.1.11'], 1)], ['0.1.13', '0.1.11'])
  writeSettings({ keepVersions: 0 })
  installVersions('0.1.11', '0.1.12', '0.1.13')
  assert.deepEqual(await pruneVersions({ versions: ['0.1.13', '0.1.12', '0.1.11'] }), ['0.1.11'])
  assert.deepEqual(onDisk(), ['0.1.12', '0.1.13'], '损坏的配置回退为保留两版')
})

test('每个启动项各自保留「当前用 + 上一次用」：不被全局只留两个的底线挤掉', async () => {
  writeSettings({ launchPresets: [
    { id: 'a'.repeat(16), name: '旧版专用', version: '0.1.11', profile: 'web', port: 0, usedVersion: '0.1.11', prevVersion: '0.1.10' },
    { id: 'b'.repeat(16), name: 'DSH', version: 'auto', profile: 'web', port: 0, usedVersion: '0.1.13', prevVersion: '0.1.12' },
  ] })
  installVersions('0.1.9', '0.1.10', '0.1.11', '0.1.12', '0.1.13')
  const config = { versions: ['0.1.13', '0.1.12', '0.1.11', '0.1.10', '0.1.9'] }
  assert.deepEqual(await pruneVersions(config), ['0.1.9'], '两个启动项各自的两个版本都留下，只清没人用的')
  assert.deepEqual(onDisk(), ['0.1.10', '0.1.11', '0.1.12', '0.1.13'])
})

test('启动时记下用的版本：当前用让位给上一次用；重复启动和陌生 ID 都不动历史', async () => {
  writeSettings({ launchPresets: [
    { id: 'c'.repeat(16), name: 'DSH', version: 'auto', profile: 'web', port: 0, usedVersion: '0.1.12' },
  ] })
  const { recordLaunchUse } = await import('../server.js')
  await recordLaunchUse('c'.repeat(16), '0.1.13')
  let stored = JSON.parse(readFileSync(join(APP, 'settings.json'), 'utf8'))
  assert.deepEqual(stored.launchPresets.find((item) => item.id === 'c'.repeat(16)), {
    id: 'c'.repeat(16), name: 'DSH', version: 'auto', profile: 'web', port: 0, usedVersion: '0.1.13', prevVersion: '0.1.12',
  })
  await recordLaunchUse('c'.repeat(16), '0.1.13')
  await recordLaunchUse('d'.repeat(16), '0.1.13')
  stored = JSON.parse(readFileSync(join(APP, 'settings.json'), 'utf8'))
  assert.equal(stored.launchPresets.find((item) => item.id === 'c'.repeat(16)).prevVersion, '0.1.12', '重复启动不洗牌')
})

test('设置页那一下开关走真接口：POST /api/settings 存下去，GET /api/settings 读回来', async () => {
  writeSettings()
  const { startServer, stopAll } = await import('../server.js')
  const base = await startServer()
  const read = () => fetch(`${base}/api/settings`).then((res) => res.json())
  const save = (body) => fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json())
  try {
    assert.equal((await read()).autoCleanVersions, true, '没设过 = 开着（老配置文件也是这个行为）')
    assert.equal((await save({ autoCleanVersions: false })).autoCleanVersions, false)
    assert.equal((await read()).autoCleanVersions, false, '再读一遍还是关着')
    assert.equal((await save({ autoCleanVersions: true })).autoCleanVersions, true, '还能再打开')
    assert.equal((await read()).keepVersions, 2)
    assert.equal((await save({ keepVersions: 5 })).keepVersions, 5)
    assert.equal((await read()).keepVersions, 5)
    for (const keepVersions of [0, -1, 21, 1.5, 'bad']) {
      assert.match((await save({ keepVersions })).error, /保留版本数量/)
      assert.equal((await read()).keepVersions, 5, '无效输入不改变已保存的数量')
    }
  } finally {
    await stopAll()
  }
})
