/**
 * 整合包接口的端到端测试：起真的管理页服务，但把 APP_DIR / 数据目录 / dsh 家目录都指到临时目录，
 * 并且放一个「假 dsh 入口」当 plugin 命令的落点（真跑 pnpm 装几十个包不是单测该干的事）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeZip } from '../zip.js'
import { parsePackArchive } from '../packs.js'

/** 找一个空闲端口：先绑 0 拿系统分配的，再放开。 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 造一个整合包文件：两层、一个依赖、一份补丁层。 */
function demoPack(file) {
  const buffer = writeZip([
    { name: 'dspack.json', data: '{"format":"dspack","version":3}\n' },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifestVersion: 5,
        type: 'profile',
        name: 'demo',
        version: '1.2.3',
        displayName: '示例整合包',
        description: '给测试用的整合包',
        profileName: 'demo',
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'],
        dependencies: { 'dsh-cost-meter': '1.7.37' },
      }, null, 2),
    },
    { name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n  disabled: false\n' },
  ])
  writeFileSync(file, buffer)
  return file
}

/**
 * 起一套隔离的管理页。
 *
 * 隔离靠三件事：APPDATA 指向临时目录（settings.json 与日志都写在那儿）、DSH_VERSIONS_DATA
 * 指向临时版本目录、settings.json 里的 dshHome 指向临时家目录。假 dsh 入口只是个立刻退出的
 * 空脚本——`dsh plugin …` 那条路走通了就够，装依赖本身不是这里要测的。
 */
async function startManager() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packs-api-'))
  const appDir = join(root, 'appdata', 'DSH')
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

  process.env.APPDATA = join(root, 'appdata')
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
  return {
    origin,
    root,
    home,
    dataDir,
    call,
    get: async (path) => {
      const res = await fetch(`${origin}${path}`, { headers: { origin } })
      return { status: res.status, data: await res.json() }
    },
    stop: () => server.stopAll(),
  }
}

/**
 * 一个进程里 server.js 只会被加载一次（模块缓存），所以整套流程共用一个管理页实例：
 * 用同一个 startManager，在子测试里按顺序走完检查 → 安装 → 列表 → 卸载 → 导出。
 */
test('整合包接口', async (t) => {
  const manager = await startManager()
  t.after(() => manager.stop())
  const packFile = demoPack(join(manager.root, 'demo-1.2.3.dspack'))
  const profileDir = join(manager.home, 'profiles', 'demo')
  const stateFile = join(manager.dataDir, 'packs', 'installed.json')

  await t.test('检查：只读，不落任何文件', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile })
    assert.equal(inspect.status, 200)
    assert.equal(inspect.data.ok, true)
    assert.equal(inspect.data.pack.name, 'demo')
    assert.equal(inspect.data.pack.displayName, '示例整合包')
    assert.equal(inspect.data.target.profile, 'demo')
    assert.equal(inspect.data.target.createsProfile, true)
    assert.deepEqual(inspect.data.plan.writes.map((write) => write.rel), [
      'profiles/demo/package.json',
      'profiles/demo/pnpm-workspace.yaml',
      'profiles/demo/cordis.yml',
      'profiles/demo/cordis.patch.yml',
    ])
    assert.ok(!existsSync(join(manager.home, 'profiles')), '检查阶段不写 profile')
  })

  await t.test('安装：写清单与补丁层，并记下这次安装', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile })
    const install = await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'demo' })
    assert.equal(install.status, 200, install.data.error)
    assert.equal(install.data.ok, true)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { 'dsh-cost-meter': '1.7.37' })
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'])
    assert.match(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), /dsh-cost-meter/)
    assert.ok(existsSync(join(profileDir, 'cordis.yml')))
    const state = JSON.parse(readFileSync(stateFile, 'utf8')).packs
    assert.equal(state.length, 1)
    assert.equal(state[0].profile, 'demo')
    assert.ok(existsSync(state[0].backupDir), '备份目录留下了')
  })

  await t.test('列表：装出来的 profile 与可切换的 profile 都在', async () => {
    const list = await manager.get('/api/packs')
    assert.equal(list.data.packs.length, 1)
    assert.equal(list.data.packs[0].profile, 'demo', '一张卡就是一份 profile')
    assert.equal(list.data.packs[0].packName, '示例整合包', '来源标在这张卡上')
    assert.ok(list.data.profiles.includes('demo'), '新 profile 出现在可切换列表里')
  })

  await t.test('再检查：目标 profile 已存在时不再写骨架文件', async () => {
    const again = await manager.call('/api/packs/inspect', { source: packFile, profile: 'demo' })
    assert.equal(again.data.target.createsProfile, false)
    assert.ok(!again.data.plan.writes.some((write) => write.rel === 'profiles/demo/cordis.yml'), '已存在的 profile 不重写根文件')
  })

  await t.test('导出：把 profile 打成包，能再解析回来', async () => {
    const exportPath = join(manager.root, 'out.dspack')
    const exported = await manager.call('/api/packs/export', { profile: 'demo', path: exportPath, version: '9.9.9' })
    assert.equal(exported.status, 200, exported.data.error)
    assert.ok(existsSync(exportPath))
    const back = parsePackArchive(readFileSync(exportPath))
    assert.equal(back.ok, true)
    assert.equal(back.fields.version, '9.9.9')
    assert.deepEqual(back.fields.dependencies, { 'dsh-cost-meter': '1.7.37' })
    assert.equal(back.patch?.source, 'overrides/cordis.patch.yml')
  })

  await t.test('装进已有 profile：覆盖的补丁层卸载时还原', async () => {
    // web 是当前 profile：包会并进它已有的清单，补丁层被覆盖后要能从备份还原
    mkdirSync(join(manager.home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(manager.home, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-meme': '0.1.43' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-meme'], patchReload: 'live' } },
    }, null, 2))
    writeFileSync(join(manager.home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
    const inspect = await manager.call('/api/packs/inspect', { source: packFile, profile: 'web' })
    assert.equal(inspect.data.target.createsProfile, false)
    assert.match(inspect.data.plan.warnings.join(), /重启 dsh/, '装当前 profile 要提示重启')
    const install = await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'web' })
    assert.equal(install.status, 200, install.data.error)
    const merged = JSON.parse(readFileSync(join(manager.home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.deepEqual(merged.dependencies, { 'dsh-meme': '0.1.43', 'dsh-cost-meter': '1.7.37' }, '用户自己的依赖留着')
    assert.deepEqual(merged.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-meme', '@deepseek-ai/dsh-web-app', 'dsh-cost-meter'])
    assert.match(readFileSync(join(manager.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /dsh-cost-meter/)

    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(readFileSync(join(manager.home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n', '补丁层还原')
    assert.deepEqual(JSON.parse(readFileSync(join(manager.home, 'profiles', 'web', 'package.json'), 'utf8')).dependencies, { 'dsh-meme': '0.1.43' })
  })

  await t.test('卸载：包新建的 profile 还原成安装前的样子', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile, profile: 'fresh' })
    assert.equal(inspect.data.target.createsProfile, true)
    await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'fresh' })
    const freshDir = join(manager.home, 'profiles', 'fresh')
    assert.ok(existsSync(join(freshDir, 'package.json')))
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'fresh' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.packs.filter((item) => item.profile === 'fresh').length, 0)
    assert.ok(!existsSync(join(freshDir, 'package.json')), '包新建的清单删掉')
    assert.ok(!existsSync(join(freshDir, 'cordis.yml')))
    assert.match(removed.data.lines.join(), /node_modules/, '说明 node_modules 里还留着装过的插件')
  })

  await t.test('删 profile：包自建且不是当前 profile 时才允许', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile, profile: 'removable' })
    await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'removable' })
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'removable', removeProfile: true })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.removedProfile, true)
    assert.ok(!existsSync(join(manager.home, 'profiles', 'removable')))

    // web 在装整合包之前就在，不许整个删掉（先判条件，别留下半截状态）
    const again = await manager.call('/api/packs/inspect', { source: packFile, profile: 'web' })
    await manager.call('/api/packs/install', { token: again.data.token, profile: 'web' })
    const web = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web', removeProfile: true })
    assert.equal(web.status, 400)
    assert.match(web.data.error, /不敢整个删掉/)
    assert.ok(existsSync(join(manager.home, 'profiles', 'web')), '当前 profile 的目录不动')
    assert.equal((await manager.get('/api/packs')).data.packs.filter((item) => item.profile === 'web').length, 1, '被拒时不动安装记录')
    await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web' })
  })

  await t.test('卡片按 profile 发：装过包的标来源，手动拼的也有一张卡', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile, profile: 'grouped' })
    await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'grouped' })

    // 列表里每个条目都是一份 profile，带着它自己的插件清单（卡片和详情都靠它渲染）。
    // 假 dsh 不跑 pnpm，所以 node_modules 是空的：插件清单来自 profile 的 package.json，
    // 有包名但读不到版本，也就没有可开关的加载行。
    const list = await manager.get('/api/packs')
    const record = list.data.packs.find((item) => item.profile === 'grouped')
    assert.equal(record.pluginCount, 1)
    assert.deepEqual(record.plugins.map((plugin) => plugin.name), ['dsh-cost-meter'])
    assert.equal(record.toggleable, false, '没有加载行时整包开关不可用')
    assert.equal(record.packName, '示例整合包', '装过包的要带上来源（包名与版本）')
    assert.equal(record.records.length, 1)
    // 当前 profile（web）排最前
    assert.equal(list.data.packs[0].profile, 'web')
    const fromPlugins = (await manager.get('/api/plugins')).data.packs
    assert.equal(fromPlugins.find((item) => item.profile === 'grouped')?.pluginCount, 1, '插件页一次请求就能拿到卡片需要的东西')

    // 手动拼的 profile（没有任何安装记录）也要出现在卡片里
    const handMade = join(manager.home, 'profiles', 'hand-made')
    mkdirSync(handMade, { recursive: true })
    writeFileSync(join(handMade, 'package.json'), JSON.stringify({ name: 'dsh-profile-hand-made', private: true, dependencies: { 'dsh-meme': '0.1.43' }, dsh: { profile: { bundles: ['dsh-meme'] } } }, null, 2))
    const again = (await manager.get('/api/packs')).data.packs.find((item) => item.profile === 'hand-made')
    assert.ok(again, '手动拼的 profile 也有一张卡')
    assert.deepEqual(again.records, [])
    assert.equal(again.packName, '')

    // 整包开关按 profile 走：没有可开关的加载行时如实报出来，不当成成功
    const off = await manager.call('/api/packs/toggle', { profile: 'grouped', enabled: false })
    assert.equal(off.status, 200, off.data.error)
    assert.equal(off.data.changed, 0)
    assert.equal(off.data.failed.length, 1)
    assert.match(off.data.failed.join(), /dsh-cost-meter/)

    // 整包更新只在「就是当前 profile」时可用：更新走的是单插件升级那条路
    const update = await manager.call('/api/packs/update', { profile: 'grouped' })
    assert.equal(update.status, 400)
    assert.match(update.data.error, /不是当前在用的那个/)

    const noProfile = await manager.call('/api/packs/toggle', { enabled: false })
    assert.equal(noProfile.status, 400)

    // 删除整个 profile：当前 profile 与 dsh 自带模板都不许删
    const current = await manager.call('/api/packs/remove-profile', { profile: 'web' })
    assert.equal(current.status, 400)
    assert.match(current.data.error, /正在用的那个/)
    const template = await manager.call('/api/packs/remove-profile', { profile: 'sdk' })
    assert.equal(template.status, 400)
    assert.match(template.data.error, /自带的 profile 模板/)

    const removed = await manager.call('/api/packs/remove-profile', { profile: 'hand-made' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.ok(!existsSync(handMade))
    assert.ok(!(removed.data.packs || []).some((item) => item.profile === 'hand-made'))

    await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'grouped', removeProfile: true })
  })

  await t.test('坏包、不认识的来源、跨站请求都被挡住', async () => {
    const bad = join(manager.root, 'bad.dspack')
    writeFileSync(bad, '这不是压缩包')
    const inspect = await manager.call('/api/packs/inspect', { source: bad })
    assert.equal(inspect.status, 400)
    assert.match(inspect.data.error, /不是 ZIP/)

    const missing = await manager.call('/api/packs/inspect', { source: '不存在的路径' })
    assert.equal(missing.status, 400)
    assert.match(missing.data.error, /认不出这个来源/)

    // 跨站来源（Origin 不是本机）不许碰这些接口
    const res = await fetch(`${manager.origin}/api/packs/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ source: 'x' }),
    })
    assert.equal(res.status, 403)

    const noRecord = await manager.call('/api/packs/uninstall', { name: 'nothing', profile: 'web' })
    assert.equal(noRecord.status, 404)
  })

  await t.test('卸载：profile 目录被手动删掉时不硬还原，只清记录', async () => {
    const inspect = await manager.call('/api/packs/inspect', { source: packFile, profile: 'vanished' })
    await manager.call('/api/packs/install', { token: inspect.data.token, profile: 'vanished' })
    const dir = join(manager.home, 'profiles', 'vanished')
    assert.ok(existsSync(dir))
    rmSync(dir, { recursive: true, force: true })
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'vanished' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.restored, 0)
    assert.match(removed.data.lines.join(), /已经不在了/)
    assert.ok(!existsSync(dir), '不会把目录重新造出来')
    assert.equal((await manager.get('/api/packs')).data.packs.filter((item) => item.profile === 'vanished').length, 0)
  })

  await t.test('市场：索引读回来按 PackForge 的字段收敛', async () => {
    // 市场索引是 URL（fetch 不认本地路径），这里起一只假索引站，形状照抄真实那份
    const index = {
      schemaVersion: 2,
      generatedAt: '2026-09-26T00:00:00Z',
      modpacks: [
        {
          manifestVersion: 5,
          type: 'profile',
          name: 'demo',
          version: '1.0.0',
          displayName: { 'zh-CN': '示例', 'en-US': 'Demo' },
          description: '一句话',
          downloadUrl: 'https://example.com/demo-1.0.0.dspack',
          sha256: 'abc',
          size: 1234,
          bundleCount: 3,
          depCount: 1,
          id: 'owner.demo',
        },
        { manifestVersion: 5, name: '没有下载地址', downloadUrl: '' },
      ],
    }
    const fake = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(index))
    })
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => fake.close(resolve)))
    process.env.DSH_PACK_MARKET = `http://127.0.0.1:${fake.address().port}/index.json`
    const market = await manager.get('/api/packs/market?refresh=1')
    assert.equal(market.status, 200)
    assert.equal(market.data.ok, true)
    assert.equal(market.data.entries.length, 1, '没有下载地址的条目丢掉')
    assert.equal(market.data.entries[0].displayName, '示例')
    assert.equal(market.data.entries[0].bundleCount, 3)
    // 索引读不到时不是页面错误：手贴链接照样能用
    process.env.DSH_PACK_MARKET = 'http://127.0.0.1:1/nope.json'
    const broken = await manager.get('/api/packs/market?refresh=1')
    assert.equal(broken.status, 200)
    assert.equal(broken.data.ok, false)
    assert.ok(broken.data.error)
    delete process.env.DSH_PACK_MARKET
  })
})
