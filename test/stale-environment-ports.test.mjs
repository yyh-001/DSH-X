/**
 * #90 旧环境删掉后，端口归属表还留着它的钉子，把端口永久占住。
 * 启动时要清掉死目录/未登记环境的记录；移除环境、删除启动项也要把对应的钉子带走。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function distinctPorts(count) {
  const ports = new Set()
  while (ports.size < count) ports.add(await freePort())
  return [...ports]
}

const root = mkdtempSync(join(tmpdir(), 'dsh-stale-ports-'))
const appData = join(root, 'app')
mkdirSync(appData, { recursive: true })
const APP = isolateUserHome(root, appData)
const DATA = join(root, 'data')
const HOME = join(root, 'home')
const OTHER = join(root, 'other-home')
const OLD = join(root, 'gone-home')
// 还登记着、但这会儿没挂上的外接盘：目录不存在，钉子不能被当成旧环境清掉
const UNMOUNTED = join(root, 'unmounted-home')
mkdirSync(APP, { recursive: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(OTHER, { recursive: true })
const web = join(HOME, 'profiles', 'web')
mkdirSync(web, { recursive: true })
writeFileSync(join(web, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}))

const [MANAGER_PORT, STALE_PORT, OTHER_PORT, PRESET_PORT, UNMOUNTED_PORT] = await distinctPorts(5)
process.env.PORT = String(MANAGER_PORT)
const presetId = '1111111111111111'
const SETTINGS_FILE = join(APP, 'settings.json')
writeFileSync(SETTINGS_FILE, JSON.stringify({
  dataDir: DATA,
  dshHome: HOME,
  dshHomes: [OTHER, UNMOUNTED],
  profile: 'web',
  seedMarket: false,
  launchPresets: [
    { id: presetId, name: '待删启动项', version: '0.1.7', profile: 'work', port: 0, usedVersion: '0.1.7' },
  ],
  instancePorts: { '0.1.7@work': PRESET_PORT },
  environmentPorts: {
    // 盘符变了的旧目录：已经不在 dshHomes 里，目录也不存在
    [OLD]: { '0.1.6@web': STALE_PORT },
    [OTHER]: { '0.1.8@web': OTHER_PORT },
    [UNMOUNTED]: { '0.1.9@web': UNMOUNTED_PORT },
  },
}))

const { startServer, stopAll } = await import('../src/server.js')
const base = await startServer()

async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}
const settings = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))

test('启动时清掉死目录的端口记录，端口可以重新钉', async () => {
  const stored = settings()
  assert.equal(stored.environmentPorts[OLD], undefined, '旧环境的端口记录要从文件里删掉')
  assert.deepEqual(stored.environmentPorts[OTHER], { '0.1.8@web': OTHER_PORT }, '还存在的环境不动')
  assert.deepEqual(stored.environmentPorts[UNMOUNTED], { '0.1.9@web': UNMOUNTED_PORT }, '登记着但没挂上的盘：钉子要留着')
  const result = await api('/api/instance-port', { version: '0.1.6', profile: 'web', port: STALE_PORT })
  assert.equal(result.key, '0.1.6@web')
  assert.equal(settings().instancePorts['0.1.6@web'], STALE_PORT, '旧钉子清掉后同一端口能重新钉')
  assert.deepEqual(settings().environmentPorts[UNMOUNTED], { '0.1.9@web': UNMOUNTED_PORT }, '在别处钉端口不能顺手抹掉没挂上的盘的钉子')
  await assert.rejects(api('/api/instance-port', { version: '0.1.5', profile: 'web', port: UNMOUNTED_PORT }), /已经钉给/, '没挂上的盘的端口照样保留，不能被别的组合钉走')
})

test('移除用户目录时带走它的端口记录', async () => {
  await api('/api/dsh-homes/remove', { home: OTHER })
  const stored = settings()
  assert.equal(stored.environmentPorts[OTHER], undefined)
  assert.deepEqual(stored.dshHomes, [UNMOUNTED])
})

test('删除启动项时释放它用过的版本端口', async () => {
  await api('/api/launch-presets/remove', { id: presetId })
  const stored = settings()
  assert.equal(stored.instancePorts['0.1.7@work'], undefined, '启动项没了，钉子也不该留着')
  assert.ok(!(await api('/api/state')).launchPresets.some((item) => item.id === presetId))
})

test.after(async () => {
  await stopAll()
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})
