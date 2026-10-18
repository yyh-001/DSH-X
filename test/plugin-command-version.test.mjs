import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const OLD = '0.2.0'
const NEW = '0.2.1-alpha.2'
const PLUGIN = '@nanmicoder/dsh-agent-teams'
const ID = '1111111111111111'
const OTHER_ID = '2222222222222222'

test('插件更新遵循目标启动项的内核，停止后和跨目录也不切到最高版本', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-version-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const otherHome = join(root, '独立目录')
  const data = join(root, 'data')
  const calls = join(root, 'commands.jsonl')
  mkdirSync(app, { recursive: true })
  writeFileSync(calls, '')
  for (const version of [OLD, NEW]) {
    const lib = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    // 真正执行所选版本的 CLI 入口，记录内核与目录；依赖安装由本地夹具完成，不访问 npm。
    writeFileSync(join(lib, 'bin.js'), `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'plugin') {
  const profile = args[args.indexOf('--profile') + 1]
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ version: process.env.DSH_VERSION, home: process.env.DSH_HOME, profile, args }) + '\\n')
  const dir = join(process.env.DSH_HOME, 'profiles', profile)
  for (const file of [join(dir, 'package.json'), join(dir, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json')]) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    if (pkg.dependencies) pkg.dependencies[${JSON.stringify(PLUGIN)}] = '0.1.23'
    else pkg.version = '0.1.23'
    writeFileSync(file, JSON.stringify(pkg))
  }
} else {
  const server = createServer((req, res) => res.end('<!doctype html><html><body>ok</body></html>'))
  server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
}
`)
  }
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: [NEW, OLD] }))
  const settingsFile = join(app, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ dataDir: data, dshHome: home, seedMarket: false, systemPath: false }))
  const registry = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ versions: { '0.1.22': {}, '0.1.23': {} }, 'dist-tags': { latest: '0.1.23' } }))
  })
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve))
  t.after(() => registry.close())
  process.env.npm_config_registry = `http://127.0.0.1:${registry.address().port}`
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise((resolve) => probe.close(resolve))
  const server = await import('../server.js')
  const { saveSettings } = await import('../settings.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())

  function resetPlugin(target = home, profile = 'myweb1') {
    const dir = join(target, 'profiles', profile)
    const pkg = join(dir, 'node_modules', '@nanmicoder', 'dsh-agent-teams')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN]: '0.1.22' }, dsh: { profile: { bundles: [PLUGIN] } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: PLUGIN, version: '0.1.22', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: teams\n      name: teams\n')
  }
  const preset = (id, version, target = home, profile = 'myweb1') => ({ id, name: id, version, profile, ...(target === home ? {} : { dshHome: target }) })
  const commands = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  async function api(path, body, headers = {}) {
    const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  async function update(expected, { launchId = '', target = home, profile = 'myweb1', path = '/api/plugins/update', all = false } = {}) {
    resetPlugin(target, profile)
    const before = commands().length
    const result = await api(path, { name: PLUGIN, profile, ...(all ? { all: true } : {}) }, launchId ? { 'x-dsh-launch-id': launchId } : { 'x-dsh-home': encodeURIComponent(target) })
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.deepEqual(result.failed || [], [])
    assert.equal(commands().length, before + 1, '插件命令只执行一次')
    const command = commands().at(-1)
    assert.equal(command.version, expected)
    assert.equal(command.home, target)
    assert.equal(command.profile, profile)
    assert.equal(command.args.includes('--accept-risk'), false)
  }

  await t.test('停止的启动项固定 0.2.0：单个、全部和整合包更新均使用 0.2.0', async () => {
    await saveSettings({ launchPresets: [preset(ID, OLD)] })
    for (const options of [{}, { all: true }, { path: '/api/packs/update' }]) {
      await update(OLD, { launchId: ID, ...options })
    }
  })
  await t.test('按目录管理 Profile 时也采用唯一匹配启动项的固定版本', async () => {
    await update(OLD)
  })
  await t.test('独立目录的同名 Profile 与全局目录分别使用自己的固定版本', async () => {
    await saveSettings({ launchPresets: [preset(ID, NEW), preset(OTHER_ID, OLD, otherHome)] })
    await update(OLD, { launchId: OTHER_ID, target: otherHome })
    await update(OLD, { target: otherHome })
    await update(NEW)
  })
  await t.test('同目录同 Profile 保存了多个内核时，明确启动项决定版本', async () => {
    await saveSettings({ launchPresets: [preset(ID, OLD), preset(OTHER_ID, NEW)] })
    await update(OLD, { launchId: ID })
    await update(NEW, { launchId: OTHER_ID })
    const before = commands().length
    resetPlugin()
    const result = await api('/api/plugins/update', { name: PLUGIN, profile: 'myweb1' })
    assert.equal(result.status, 400)
    assert.match(result.error, /多个内核版本/)
    assert.equal(commands().length, before, '不能随意选择一个内核安装')
  })
  await t.test('固定内核缺失时报出版本，不能偷偷换成最高已装版本', async () => {
    await saveSettings({ launchPresets: [preset(ID, '0.1.0')] })
    resetPlugin()
    const before = commands().length
    const result = await api('/api/plugins/update', { name: PLUGIN, profile: 'myweb1' }, { 'x-dsh-launch-id': ID })
    assert.equal(result.status, 400)
    assert.match(result.error, /0\.1\.0.*未安装/)
    assert.equal(commands().length, before)
  })
  await t.test('请求的 Profile 不属于当前启动项时，不套用它的固定内核', async () => {
    await saveSettings({ launchPresets: [preset(ID, OLD)] })
    await update(NEW, { launchId: ID, profile: 'unbound' })
  })
  await t.test('auto 与未绑定 Profile 保留运行版本优先、否则最高已装版本的选择', async () => {
    // 自动项只在自己的版本类型里挑；这里测的是「运行优先、否则最高已装」，用收全部类别的 Alpha，
    // 免得默认的正式版类型把已装的 alpha 内核筛掉（按类型筛选另有 update-channel 的用例）。
    await saveSettings({ launchPresets: [{ ...preset(ID, 'auto'), updateChannel: 'alpha' }] })
    await update(NEW, { launchId: ID })
    await update(NEW, { profile: 'unbound' })
    resetPlugin()
    assert.equal((await api('/api/start', { version: OLD, profile: 'myweb1' })).status, 200)
    try {
      await update(OLD, { launchId: ID })
      await update(OLD)
      // 另一个内核正在运行也不能覆盖明确选中的固定内核。
      await saveSettings({ launchPresets: [preset(ID, NEW)] })
      await update(NEW, { launchId: ID })
    } finally {
      await api('/api/stop', { version: OLD, profile: 'myweb1' })
    }
  })
  await t.test('绑定通道没有已装版本时，按目录更新插件不能回退到 Alpha；未绑定 Profile 仍可使用 Alpha', async () => {
    const oldDir = join(data, 'versions', OLD)
    const parked = join(root, 'parked-official')
    renameSync(oldDir, parked)
    try {
      // 远端有正式版，但本机只装了 Alpha：正式版通道不能退档，也不能借未绑定 Profile 的兜底绕过去。
      await fetch(origin + '/api/remote')
      await saveSettings({ launchPresets: [preset(ID, 'auto')] })
      resetPlugin()
      const before = commands().length
      const result = await api('/api/plugins/update', { name: PLUGIN, profile: 'myweb1' })
      assert.equal(result.status, 400, JSON.stringify(result))
      assert.match(result.error, /没有可用的 dsh 版本/)
      assert.equal(commands().length, before, '通道没有可用版本时不执行其他通道的插件命令')
      await update(NEW, { profile: 'unbound' })
    } finally {
      renameSync(parked, oldDir)
    }
  })
})
