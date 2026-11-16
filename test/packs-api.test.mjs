/**
 * 环境文件（.dspack）导入 / 导出与整合包残留接口的端到端测试：起真的管理页服务，但把 APP_DIR / 数据目录 /
 * dsh 家目录都指到临时目录，并且放一个「假 dsh 入口」当 plugin 命令的落点（真跑 pnpm 装几十个包不是单测该干的事）。
 *
 * 需求（整合包改成环境之后）：
 *   - 老的「整包装进 Profile」三条接口（/api/packs/inspect|install|export）下线，404
 *   - POST /api/environments/import/inspect { source | builtin | market }：只读，不建环境、不写任何 Profile 文件；
 *     npm 范围 / tag 钉成此刻 registry 上满足它的最高精确版本，查不到的原样留着并提醒
 *   - POST /api/environments/import { token, name?, profile? }：存一个环境；带 profile 时才把包里的配置
 *     （补丁层 / overrides / home）写进那个 Profile，插件清单归环境，不写进 Profile；写进去的配置记成
 *     configOnly 的安装记录，可以撤销。两条导入接口都带 x-dsh-home 时，可选 Profile 和写配置都按那个用户目录走
 *   - POST /api/environments/export { id, target: file|dir, path, version?, description?, … }：只带 DSH 精确版本与插件清单；
 *     填的版本号和说明记回环境；版本号空着用环境记着的，再没有就用 GET /api/environments 的 defaults.packVersion
 *   - /api/packs 列表、按包开关、撤销还在：老用户数据目录里留着旧版装出来的安装记录，要认。
 *     「更新整合包 = 把里面的插件都升到最新」撤了（/api/packs/update 404）：环境的更新只跟上游 release 走，
 *     单个插件的升级还是 /api/plugins/update，按明确的目标 Profile 执行
 *     撤销按「名字 + Profile + configOnly」认记录：带 configOnly: true 撤配置导入，不带撤同名的旧整包安装；
 *     /api/packs 不再带内置配方（只在 /api/environments 的 builtin 里）
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { writeZip } from '../src/zip.js'
import { parsePackArchive, parsePackDir } from '../src/packs.js'
import { startPluginRegistry } from './environments-fixture.mjs'

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'

/** 找一个空闲端口：先绑 0 拿系统分配的，再放开。 */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 造一个整合包文件：两层、一个依赖、一份补丁层（补丁层是 Profile 的配置，导入时默认不导）。 */
function demoPack(file, { name = 'demo', dependencies = { 'dsh-cost-meter': '1.7.37' } } = {}) {
  const buffer = writeZip([
    { name: 'dspack.json', data: '{"format":"dspack","version":3}\n' },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifestVersion: 5,
        type: 'profile',
        name,
        version: '1.2.3',
        displayName: '示例整合包',
        description: '给测试用的整合包',
        profileName: 'demo',
        bundles: [BASE, WEB, ...Object.keys(dependencies)],
        dependencies,
      }, null, 2),
    },
    { name: 'overrides/cordis.patch.yml', data: '- id: dsh-cost-meter\n  disabled: false\n' },
  ])
  writeFileSync(file, buffer)
  return file
}

/**
 * 期望被拒：错误状态码 + 能给人看的 error。状态码到底是不是 4xx 单独一条用例验（见「用户给的东西有问题」），
 * 这里只要求「拒了、说清了原因」，免得一处状态码问题把后面别的断言都挡住。
 */
function refused(result, why) {
  assert.ok(result.status >= 400, `${why}：应被拒绝，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(typeof result.data?.error, 'string', `${why}：要带 error 文案`)
  return result.data.error
}

/** 接口视图里的依赖表：有 spec 的插件行。 */
const depsOf = (view) => Object.fromEntries((view?.plugins || []).filter((item) => item.spec).map((item) => [item.name, item.spec]))
const pluginListOf = (file) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  return { dependencies: manifest.dependencies || {}, bundles: manifest.dsh?.profile?.bundles || [] }
}

/**
 * 起一套隔离的管理页。
 *
 * 隔离靠三件事：HOME / APPDATA 指向临时目录（settings.json 与日志都写在那儿）、DSH_VERSIONS_DATA
 * 指向临时版本目录、settings.json 里的 dshHome 指向临时家目录。假 dsh 入口只是个立刻退出的
 * 空脚本——`dsh plugin …` 那条路走通了就够，装依赖本身不是这里要测的。
 */
async function startManager() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packs-api-'))
  const appDir = isolateUserHome(root, join(root, 'appdata'))
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
    // 市场条目的 displayName 按界面语言选（localized）：固定中文，别让英文 CI runner 的系统语言
    // 把断言里的「示例」变成「Demo」。
    lang: 'zh',
    // 假索引的失败请求也留在本机，不能把 localhost 兜底成外网镜像而卡住离线测试。
    downloadSource: 'official',
  }, null, 2))
  // 假 dsh：版本目录里放一份能解析的入口，plugin 命令跑它就够了
  const fakeBin = join(dataDir, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(join(fakeBin, '..'), { recursive: true })
  writeFileSync(fakeBin, 'process.exit(0)\n')
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ versions: ['9.9.9'] }, null, 2))

  // 插件版本从本机假 registry 查（服务端每次用时现读 npm_config_registry），导入钉版不出网。
  // 每个范围 / tag 都有一个「满足但不是最新」的答案；dsh 本体也在，只有本机装着的 9.9.9
  const registry = await startPluginRegistry({
    '@deepseek-ai/dsh': { tags: { latest: '9.9.9' }, versions: ['9.9.9'] },
    'dsh-cost-meter': { tags: { latest: '1.8.0' }, versions: ['1.7.30', '1.7.37', '1.8.0'] },
    'dsh-x-ranged': { tags: { latest: '2.0.0' }, versions: ['1.1.0', '1.2.0', '1.4.2', '2.0.0'] },
    'dsh-x-tagged': { tags: { latest: '2.0.0', next: '3.0.0-beta.1' }, versions: ['2.0.0', '3.0.0-beta.1'] },
    // 卡片区那个手动插件：单个插件更新要查得到它的新版本
    'dsh-meme': { tags: { latest: '0.1.50' }, versions: ['0.1.43', '0.1.50'] },
  })
  process.env.npm_config_registry = registry.url
  process.env.APPDATA = join(root, 'appdata')
  process.env.DSH_VERSIONS_DATA = dataDir
  process.env.PORT = String(port)
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  const call = async (path, body, headers = {}) => {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body ?? {}),
    })
    return { status: res.status, data: await res.json() }
  }
  return {
    origin,
    root,
    appDir,
    home,
    dataDir,
    registry,
    call,
    get: async (path, headers = {}) => {
      const res = await fetch(`${origin}${path}`, { headers: { origin, ...headers } })
      return { status: res.status, data: await res.json() }
    },
    stop: async () => {
      server.stopAll()
      await registry.close()
    },
  }
}

/**
 * 一个进程里 server.js 只会被加载一次（模块缓存），所以整套流程共用一个管理页实例：
 * 用同一个 startManager，在子测试里按顺序走完检查 → 导入 → 导出 → 配置导入与撤销 → 老安装记录。
 */
test('环境文件与整合包接口', async (t) => {
  const manager = await startManager()
  t.after(async () => { await manager.stop() })
  const packFile = demoPack(join(manager.root, 'demo-1.2.3.dspack'))
  const stateFile = join(manager.dataDir, 'packs', 'installed.json')
  const profilesDir = join(manager.home, 'profiles')
  const envs = async () => (await manager.get('/api/environments')).data.environments
  const inspect = async (body) => {
    const result = await manager.call('/api/environments/import/inspect', body)
    assert.equal(result.status, 200, result.data.error)
    return result.data
  }
  let imported = null

  /**
   * 旧版启动器装过的整合包：新版不再有「整包装进 Profile」这条路（packs.js 里那套安装计划也撤了），但老用户的
   * 数据目录里还留着这些安装记录，撤销 / 按包开关 / 更新仍要认。这里照旧版的落盘形状手写一遍，等于「旧版装过、新版接手」：
   * 清单并进层栈与依赖、新 profile 补工作区模板和空条目根、补丁层整份替换；写之前把原有文件拷进备份目录的 files/，
   * 最后往 <数据目录>/packs/installed.json 记一条（同名同 Profile 的整包记录只留最新一条）。
   */
  let legacySeq = 0
  function oldInstall(profile, file = packFile) {
    const pack = parsePackArchive(readFileSync(file))
    assert.equal(pack.ok, true, pack.errors.join('；'))
    const { name, version, type, dshVersion, bundles, dependencies } = pack.fields
    const rel = (inner) => `profiles/${profile}/${inner}`
    const abs = (relPath) => join(manager.home, relPath)
    const createdProfile = !existsSync(abs(rel('package.json')))
    const current = createdProfile
      ? { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [BASE, WEB], patchReload: 'live' } } }
      : JSON.parse(readFileSync(abs(rel('package.json')), 'utf8'))
    const layers = current.dsh?.profile?.bundles || []
    const next = {
      ...current,
      dependencies: { ...(current.dependencies || {}), ...pack.installSpecs },
      dsh: { ...current.dsh, profile: { ...current.dsh?.profile, bundles: [...layers, ...bundles.filter((item) => !layers.includes(item))] } },
    }
    const writes = [[rel('package.json'), 'manifest', `${JSON.stringify(next, null, 2)}\n`]]
    if (!existsSync(abs(rel('pnpm-workspace.yaml')))) writes.push([rel('pnpm-workspace.yaml'), 'workspace', 'packages:\n  - .\n'])
    if (!existsSync(abs(rel('cordis.yml')))) writes.push([rel('cordis.yml'), 'root', '[]\n'])
    if (pack.patch) writes.push([rel('cordis.patch.yml'), 'patch', pack.patch.text])
    const backupDir = join(manager.dataDir, 'packs', 'backups', `legacy-${(legacySeq += 1)}-${profile}`)
    mkdirSync(join(backupDir, 'files'), { recursive: true })
    const files = []
    for (const [relPath, kind, data] of writes) {
      const target = abs(relPath)
      const existed = existsSync(target)
      if (existed) {
        mkdirSync(dirname(join(backupDir, 'files', relPath)), { recursive: true })
        writeFileSync(join(backupDir, 'files', relPath), readFileSync(target))
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
      files.push({ rel: relPath, existed, kind, note: '' })
    }
    const record = {
      id: `${name}@${version}`, name, displayName: pack.displayName, version, type, profile,
      source: `文件：${file}`, installedAt: new Date().toISOString(), createdProfile, backupDir, files,
      bundles, dependencies, specs: pack.installSpecs, dshVersion, manifestVersion: 5,
    }
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { packs: [] }
    state.packs = state.packs.filter((item) => !(item.name === name && item.profile === profile && !item.configOnly))
    state.packs.push(record)
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    return record
  }
  const recordsOf = async (profile, headers) => ((await manager.get('/api/packs', headers)).data.packs.find((item) => item.profile === profile)?.records || [])

  await t.test('老接口下线：整包检查 / 安装 / 导出都是 404', async () => {
    for (const path of ['/api/packs/inspect', '/api/packs/install', '/api/packs/export']) {
      const result = await manager.call(path, { source: packFile, profile: 'demo', path: join(manager.root, 'gone.dspack') })
      assert.equal(result.status, 404, `${path} 应该已经下线`)
    }
    assert.ok(!existsSync(profilesDir), '下线的接口不能顺手写 Profile')
    assert.ok(!existsSync(join(manager.root, 'gone.dspack')))
  })

  await t.test('导入检查：只读——列出要建的环境和包里的配置，不建环境、不落任何 Profile 文件', async () => {
    const before = (await envs()).length
    const data = await inspect({ source: packFile })
    assert.equal(data.ok, true, JSON.stringify(data.errors))
    assert.equal(typeof data.token, 'string')
    assert.ok(data.token, '检查过的包要回一个 token，导入时不用再读一遍')
    assert.ok(data.bytes > 0)
    assert.equal(data.environment.packId, 'demo')
    assert.equal(data.environment.packVersion, '1.2.3')
    assert.equal(data.environment.description, '给测试用的整合包')
    assert.deepEqual(data.environment.bundles, [BASE, WEB, 'dsh-cost-meter'])
    const plugin = data.environment.plugins.find((item) => item.name === 'dsh-cost-meter')
    assert.deepEqual(plugin, { name: 'dsh-cost-meter', spec: '1.7.37', bundle: true, official: false, offline: false, local: false })
    assert.deepEqual(data.environment.offline, [], '这个包不带离线文件')
    assert.equal(data.profileData.patch, true, '补丁层单列成「可以导进 Profile 的配置」')
    assert.equal(data.profileData.available, true)
    assert.ok(Array.isArray(data.profiles), '给页面列出可选的 Profile')
    assert.deepEqual(data.errors, [])
    assert.ok(Array.isArray(data.warnings))
    assert.equal((await envs()).length, before, '检查阶段不建环境')
    assert.ok(!existsSync(profilesDir), '检查阶段不写 Profile')
    assert.ok(!existsSync(stateFile), '检查阶段不记安装记录')
  })

  await t.test('导入：只存一个环境，插件清单来自包，任何 Profile 都不动', async () => {
    const data = await inspect({ source: packFile })
    const result = await manager.call('/api/environments/import', { token: data.token, name: '导入的示例' })
    assert.equal(result.status, 200, result.data.error)
    assert.equal(result.data.ok, true)
    assert.equal(result.data.config, null, '没选 Profile 就不导配置')
    imported = result.data.environment
    assert.ok(imported?.id, '要回新环境')
    assert.ok(existsSync(join(manager.appDir, 'envs', imported.id, 'environment.json')), '清单落在启动器设置目录里')
    const view = (await envs()).find((item) => item.id === imported.id)
    assert.ok(view, '导入的环境出现在列表里')
    assert.equal(view.name, '导入的示例', '导入时可以改名')
    assert.deepEqual(depsOf(view), { 'dsh-cost-meter': '1.7.37' })
    assert.deepEqual(view.bundles, [BASE, WEB, 'dsh-cost-meter'])
    assert.ok(!existsSync(profilesDir), '导入不写 Profile（下次用这个环境启动时才写）')
    assert.ok(!existsSync(stateFile), '没导配置就没有安装记录')

    // token 用过一次就作废；不认识的 token 同样拒绝，不会去猜是哪个包
    for (const token of [data.token, 'expired']) {
      assert.match(refused(await manager.call('/api/environments/import', { token }), `token ${token}`), /过期/)
    }
  })

  await t.test('导入钉版：npm 范围和 tag 钉成 registry 上满足它的最高版本；查不到的原样留着并提醒；精确版本不查', async () => {
    const file = demoPack(join(manager.root, 'ranged.dspack'), {
      name: 'ranged',
      dependencies: { 'dsh-x-ranged': '^1.2.0', 'dsh-x-tagged': 'next', 'dsh-x-missing': '^1.0.0', 'dsh-cost-meter': '1.7.37' },
    })
    const asked = manager.registry.requests.length
    const data = await inspect({ source: file })
    const specs = Object.fromEntries(data.environment.plugins.map((item) => [item.name, item.spec]))
    assert.equal(specs['dsh-x-ranged'], '1.4.2', '范围 → 满足它的最高版本（不是 latest 2.0.0，也不是下限 1.2.0）')
    assert.equal(specs['dsh-x-tagged'], '3.0.0-beta.1', 'tag → 它指向的版本')
    assert.equal(specs['dsh-cost-meter'], '1.7.37', '精确版本原样')
    assert.equal(specs['dsh-x-missing'], '^1.0.0', 'registry 里查不到：原样留着，不编一个版本')
    assert.ok(data.warnings.some((line) => /dsh-x-missing 没能钉成精确版本（.+），先按 \^1\.0\.0 导入/.test(line)), `查不到要提醒：${data.warnings.join('；')}`)
    assert.equal(data.ok, true, '查不到版本只是提醒，不挡导入')
    assert.ok(!manager.registry.requests.slice(asked).some((path) => path.startsWith('dsh-cost-meter')), '精确版本不用查 registry')

    const result = await manager.call('/api/environments/import', { token: data.token, name: '钉过版的' })
    assert.equal(result.status, 200, result.data.error)
    const view = (await envs()).find((item) => item.id === result.data.environment.id)
    assert.deepEqual(depsOf(view), { 'dsh-x-ranged': '1.4.2', 'dsh-x-tagged': '3.0.0-beta.1', 'dsh-x-missing': '^1.0.0', 'dsh-cost-meter': '1.7.37' }, '存下来的就是检查时看到的那份')
  })

  await t.test('导出成单个 .dspack：只带 DSH 精确版本和插件清单，能再解析回来', async () => {
    const exportPath = join(manager.root, 'out.dspack')
    const exported = await manager.call('/api/environments/export', { id: imported.id, target: 'file', path: exportPath, version: '9.9.9', description: '导出说明' })
    assert.equal(exported.status, 200, exported.data.error)
    assert.equal(exported.data.ok, true)
    assert.ok(existsSync(exportPath))
    const back = parsePackArchive(readFileSync(exportPath))
    assert.equal(back.ok, true, back.errors.join('；'))
    assert.equal(back.fields.version, '9.9.9', '导出时填的版本号')
    assert.equal(back.description, '导出说明')
    assert.deepEqual(back.fields.dependencies, { 'dsh-cost-meter': '1.7.37' })
    // 包里没写 DSH 版本，导入成「跟着最新版本走」；导出时冻结成此刻会用的那个精确版本（本机只装了 9.9.9）
    assert.equal(back.fields.dshVersion, '9.9.9')
    assert.ok(!back.patch, '不带补丁层：配置属于 Profile')
    assert.deepEqual(back.overrides, [], '不带 overrides')
    assert.deepEqual(back.home, [], '不带 home 里的文件')
    // 说明在导出时填，填的说明和版本号都记回环境，下次导出从这里接着填
    const view = (await envs()).find((item) => item.id === imported.id)
    assert.equal(view.description, '导出说明')
    assert.equal(view.packVersion, '9.9.9')
  })

  await t.test('导出成仓库目录：清单直接写进文件夹，勾了才附带 GitHub Actions 发布模板', async () => {
    const plain = join(manager.root, 'repo-plain')
    const result = await manager.call('/api/environments/export', { id: imported.id, target: 'dir', path: plain, version: '1.0.0' })
    assert.equal(result.status, 200, result.data.error)
    const back = parsePackDir(plain)
    assert.equal(back.ok, true, back.errors.join('；'))
    assert.deepEqual(back.fields.dependencies, { 'dsh-cost-meter': '1.7.37' })
    assert.equal(existsSync(join(plain, '.github')), false, '没勾就不写工作流')

    const withWorkflow = join(manager.root, 'repo-workflow')
    const again = await manager.call('/api/environments/export', { id: imported.id, target: 'dir', path: withWorkflow, workflow: true })
    assert.equal(again.status, 200, again.data.error)
    const workflows = join(withWorkflow, '.github', 'workflows')
    assert.ok(existsSync(workflows) && readdirSync(workflows).some((file) => /\.ya?ml$/.test(file)), '勾了要写一份 GitHub Actions 工作流')
    assert.equal(parsePackDir(withWorkflow).fields.version, '1.0.0', '版本号空着就用上次导出记下的那个')
    assert.equal(parsePackDir(withWorkflow).description, '导出说明', '说明没带就用环境记着的')
  })

  await t.test('导出：版本号空着、环境也没记过时用接口给的默认版本号', async () => {
    const listing = (await manager.get('/api/environments')).data
    const fallback = listing.defaults?.packVersion
    assert.equal(typeof fallback, 'string')
    assert.match(fallback, /^\d+\.\d+\.\d+/, 'GET /api/environments 给页面一个默认版本号（输入框的占位）')
    const created = await manager.call('/api/environments/create', { name: '没导出过', dshVersion: '9.9.9' })
    assert.equal(created.status, 200, created.data.error)
    const path = join(manager.root, 'fresh-default.dspack')
    const result = await manager.call('/api/environments/export', { id: created.data.environment.id, target: 'file', path, version: '' })
    assert.equal(result.status, 200, result.data.error)
    assert.equal(parsePackArchive(readFileSync(path)).fields.version, fallback)
    assert.equal((await envs()).find((item) => item.id === created.data.environment.id).packVersion, fallback, '用了哪个版本号就记哪个')
  })

  await t.test('导出：不存在的环境报错，不落文件', async () => {
    const path = join(manager.root, 'ghost.dspack')
    refused(await manager.call('/api/environments/export', { id: 'no-such-env', target: 'file', path }), '不存在的环境')
    assert.ok(!existsSync(path))
  })

  await t.test('导入时选了 Profile：包里的补丁层写进去，插件清单不动；列表标出来源，撤销后还原', async () => {
    const webDir = join(profilesDir, 'web')
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-meme': '0.1.43' },
      dsh: { profile: { bundles: [BASE, 'dsh-meme'], patchReload: 'live' } },
    }, null, 2))
    writeFileSync(join(webDir, 'cordis.patch.yml'), '[]\n')
    const listBefore = pluginListOf(join(webDir, 'package.json'))

    const data = await inspect({ source: packFile })
    const result = await manager.call('/api/environments/import', { token: data.token, name: '带配置的示例', profile: 'web' })
    assert.equal(result.status, 200, result.data.error)
    assert.ok(result.data.environment?.id, '环境照样建')
    assert.equal(result.data.config?.profile, 'web')
    assert.equal(result.data.config?.error, undefined, JSON.stringify(result.data.config))
    assert.match(readFileSync(join(webDir, 'cordis.patch.yml'), 'utf8'), /dsh-cost-meter/, '补丁层写进了选的 Profile')
    assert.deepEqual(pluginListOf(join(webDir, 'package.json')), listBefore, '插件清单归环境管，配置导入不碰它')

    const list = await manager.get('/api/packs')
    assert.equal('builtin' in list.data, false, '内置配方只在环境页列，/api/packs 不再带')
    const card = list.data.packs.find((item) => item.profile === 'web')
    assert.ok(card, 'web 有一张卡')
    assert.deepEqual(card.records.map((record) => record.name), ['demo'], '导进来的配置记成一条可以撤销的记录')
    assert.equal(card.records[0].configOnly, true, '记录标成只导配置')
    assert.equal(card.records[0].createdProfile, false, '配置导入从不新建 profile')
    assert.ok(list.data.profiles.includes('web'))

    // 不带 configOnly 说的是同名的旧整包安装：web 上没有那种记录
    assert.equal((await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web' })).status, 404)
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web', configOnly: true })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(readFileSync(join(webDir, 'cordis.patch.yml'), 'utf8'), '[]\n', '补丁层还原')
    assert.deepEqual(pluginListOf(join(webDir, 'package.json')), listBefore)
    assert.ok((await envs()).some((item) => item.id === result.data.environment.id), '撤销配置不删环境')
  })

  await t.test('老安装记录：包新建的 profile 撤销后还原成安装前的样子', async () => {
    oldInstall('fresh')
    const freshDir = join(profilesDir, 'fresh')
    assert.ok(existsSync(join(freshDir, 'package.json')))
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'fresh' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.packs.filter((item) => item.profile === 'fresh' && item.records.length).length, 0)
    assert.ok(!existsSync(join(freshDir, 'package.json')), '包新建的清单删掉')
    assert.ok(!existsSync(join(freshDir, 'cordis.yml')))
    assert.match(removed.data.lines.join(), /node_modules/, '说明 node_modules 里还留着装过的插件')
  })

  await t.test('老安装记录：删 profile 只在包自建且不是当前 profile 时才允许', async () => {
    oldInstall('removable')
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'removable', removeProfile: true })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.removedProfile, true)
    assert.ok(!existsSync(join(profilesDir, 'removable')))

    // web 在装整合包之前就在，不许整个删掉（先判条件，别留下半截状态）
    oldInstall('web')
    const web = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web', removeProfile: true })
    assert.equal(web.status, 400)
    assert.match(web.data.error, /不敢整个删掉/)
    assert.ok(existsSync(join(profilesDir, 'web')), '当前 profile 的目录不动')
    assert.equal((await manager.get('/api/packs')).data.packs.filter((item) => item.profile === 'web' && item.records.length).length, 1, '被拒时不动安装记录')
    await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'web' })
  })

  await t.test('卡片按 profile 发：装过包的标来源，手动拼的也有一张卡', async () => {
    oldInstall('grouped')

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

    // 按包/其它组操作必须用安装记录归属过滤实际插件，不能误改同 profile 的手动插件。
    const manifestPath = join(profilesDir, 'grouped', 'package.json')
    const profileManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    profileManifest.dependencies['dsh-meme'] = '0.1.43'
    writeFileSync(manifestPath, JSON.stringify(profileManifest, null, 2))
    const memeDir = join(profilesDir, 'grouped', 'node_modules', 'dsh-meme')
    mkdirSync(memeDir, { recursive: true })
    writeFileSync(join(memeDir, 'package.json'), JSON.stringify({ name: 'dsh-meme', version: '0.1.43', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(memeDir, 'cordis.patch.yml'), '- insert:\n    - id: dsh-meme\n')

    const packOff = await manager.call('/api/packs/toggle', { profile: 'grouped', pack: 'demo', enabled: false })
    assert.equal(packOff.status, 200, packOff.data.error)
    assert.deepEqual(packOff.data.selected, ['dsh-cost-meter'])
    assert.equal(packOff.data.group, 'pack')
    assert.ok(!packOff.data.disables.includes('dsh-meme'), '包开关不碰其它组')
    const otherOn = await manager.call('/api/packs/toggle', { profile: 'grouped', group: 'other', enabled: false })
    assert.equal(otherOn.status, 200, otherOn.data.error)
    assert.deepEqual(otherOn.data.selected, ['dsh-meme'])
    assert.ok(otherOn.data.disables.includes('dsh-meme'), '其它组开关只动手动插件')

    // 手动拼的 profile（没有任何安装记录）也要出现在卡片里
    const handMade = join(profilesDir, 'hand-made')
    mkdirSync(handMade, { recursive: true })
    writeFileSync(join(handMade, 'package.json'), JSON.stringify({ name: 'dsh-profile-hand-made', private: true, dependencies: { 'dsh-meme': '0.1.43' }, dsh: { profile: { bundles: ['dsh-meme'] } } }, null, 2))
    const again = (await manager.get('/api/packs')).data.packs.find((item) => item.profile === 'hand-made')
    assert.ok(again, '手动拼的 profile 也有一张卡')
    assert.deepEqual(again.records, [])
    assert.equal(again.packName, '')

    // 整包开关按 profile 走：没有可开关的加载行时如实报出来，不当成成功
    const off = await manager.call('/api/packs/toggle', { profile: 'grouped', enabled: false })
    assert.equal(off.status, 200, off.data.error)
    assert.equal(off.data.changed, 0, '手动插件已由其它组开关禁用，重复操作幂等')
    assert.equal(off.data.failed.length, 1)
    assert.match(off.data.failed.join(), /dsh-cost-meter/)

    const noProfile = await manager.call('/api/packs/toggle', { enabled: false })
    assert.equal(noProfile.status, 400)

    // 官方桌面端专用目录仍受保护；普通模板和默认选择的删除在 profile-delete 用例覆盖。
    const desktop = await manager.call('/api/packs/remove-profile', { profile: 'desktop' })
    assert.equal(desktop.status, 400)
    assert.match(desktop.data.error, /官方桌面端专用/)

    const removed = await manager.call('/api/packs/remove-profile', { profile: 'hand-made' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.ok(!existsSync(handMade))
    assert.ok(!(removed.data.packs || []).some((item) => item.profile === 'hand-made'))
  })

  // 用的还是上一条留下的 grouped（一条旧安装记录 + 一个手动插件 dsh-meme），收尾时整个删掉。
  // 「按包 / 按 Profile 把插件都升到最新」撤了（设计稿第三期：环境的更新只跟上游 release 走，见 /api/environments/update*），
  // 还活着的是单个插件的升级：按明确的目标 Profile 执行、装完回读版本
  await t.test('整合包更新接口已下线；单个插件更新照旧按目标 Profile 走，回读失败如实汇总，不改默认 Profile', async () => {
    const manifestPath = join(profilesDir, 'grouped', 'package.json')
    try {
      const before = readFileSync(manifestPath)
      for (const body of [{ profile: 'grouped', pack: 'demo' }, { profile: 'grouped', group: 'other' }, { profile: 'grouped' }]) {
        const gone = await manager.call('/api/packs/update', body)
        assert.equal(gone.status, 404, `/api/packs/update ${JSON.stringify(body)} 应该已经下线`)
      }
      assert.ok(readFileSync(manifestPath).equals(before), '下线的接口不碰 Profile')

      // 浏览 Profile 不再改变默认启动的 Profile，更新必须按明确的目标 Profile 执行。
      const update = await manager.call('/api/plugins/update', { all: true, profile: 'grouped' })
      assert.equal(update.status, 200, update.data.error)
      assert.equal(update.data.profile, 'grouped')
      // dsh-meme 有新版本（0.1.50）；dsh-cost-meter 没装成、读不到版本，不算可更新
      assert.equal(update.data.checked, 1)
      assert.deepEqual(update.data.failed.map((item) => item.name), ['dsh-meme'], '假 dsh 没有真的装，回读版本没换就如实记成失败')
      assert.match(update.data.failed[0].error, /不是 0\.1\.50/)
      assert.equal((await manager.get('/api/settings')).data.profile, 'web', '更新其它 Profile 不改变默认值')
    } finally {
      await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'grouped', removeProfile: true })
    }
  })

  await t.test('坏包、不认识的来源、跨站请求都被挡住', async () => {
    const bad = join(manager.root, 'bad.dspack')
    writeFileSync(bad, '这不是压缩包')
    const before = (await envs()).length
    assert.match(refused(await manager.call('/api/environments/import/inspect', { source: bad }), '坏包'), /不是 ZIP/)
    assert.match(refused(await manager.call('/api/environments/import/inspect', { source: '不存在的路径' }), '不认识的来源'), /认不出这个来源/)
    refused(await manager.call('/api/environments/import/inspect', { builtin: 'no-such-recipe' }), '不认识的内置配方名')
    assert.equal((await envs()).length, before, '被拒的检查不留环境')

    // 跨站来源（Origin 不是本机）不许碰这些会读文件、写环境、写文件的接口
    for (const path of ['/api/environments/import/inspect', '/api/environments/import', '/api/environments/export']) {
      const res = await fetch(`${manager.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ source: packFile, token: 'x', id: imported.id, target: 'file', path: join(manager.root, 'evil.dspack') }),
      })
      assert.equal(res.status, 403, `${path} 要挡跨站请求`)
    }
    assert.equal((await envs()).length, before)
    assert.ok(!existsSync(join(manager.root, 'evil.dspack')))

    const noRecord = await manager.call('/api/packs/uninstall', { name: 'nothing', profile: 'web' })
    assert.equal(noRecord.status, 404)
  })

  await t.test('老安装记录：profile 目录被手动删掉时不硬还原，只清记录', async () => {
    oldInstall('vanished')
    const dir = join(profilesDir, 'vanished')
    assert.ok(existsSync(dir))
    rmSync(dir, { recursive: true, force: true })
    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'vanished' })
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(removed.data.restored, 0)
    assert.match(removed.data.lines.join(), /已经不在了/)
    assert.ok(!existsSync(dir), '不会把目录重新造出来')
    assert.equal((await manager.get('/api/packs')).data.packs.filter((item) => item.profile === 'vanished').length, 0)
  })

  await t.test('链接来源：检查时下载一次，导入复用那份下载，不再回源', async () => {
    let downloads = 0
    const fake = createHttpServer((req, res) => { downloads += 1; res.end(readFileSync(packFile)) })
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
    t.after(() => fake.listening ? new Promise((resolve) => fake.close(resolve)) : undefined)
    const data = await inspect({ source: `http://127.0.0.1:${fake.address().port}/demo.dspack` })
    assert.equal(data.ok, true, JSON.stringify(data.errors))
    assert.equal(downloads, 1)
    // 远端关掉也能导：导入用的是检查时落下的那份
    await new Promise((resolve) => fake.close(resolve))
    const result = await manager.call('/api/environments/import', { token: data.token, name: '从链接导入' })
    assert.equal(result.status, 200, result.data.error)
    assert.equal(downloads, 1, '导入不再下载一次')
    assert.deepEqual(depsOf((await envs()).find((item) => item.id === result.data.environment.id)), { 'dsh-cost-meter': '1.7.37' })
    assert.ok(!existsSync(join(profilesDir, 'demo')), '导入不建配方里写的 profile')
  })

  await t.test('老安装记录叠了两层：拒绝乱序撤销；还原失败保留记录供重试', async () => {
    const otherFile = demoPack(join(manager.root, 'other.dspack'), { name: 'other' })
    const dir = join(profilesDir, 'stacked')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"original","private":true}\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), 'original\n')
    // 旧版允许往同一个 profile 按顺序叠装好几个包；新版不再叠装，但叠出来的记录要能按顺序撤掉
    oldInstall('stacked', packFile)
    const latest = oldInstall('stacked', otherFile)
    const wrong = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'stacked' })
    assert.equal(wrong.status, 400)
    assert.match(wrong.data.error, /请先撤销/)
    const backup = join(latest.backupDir, 'files', 'profiles', 'stacked', 'cordis.patch.yml')
    const contents = readFileSync(backup)
    rmSync(backup)
    const failed = await manager.call('/api/packs/uninstall', { name: 'other', profile: 'stacked' })
    assert.equal(failed.status, 400)
    assert.match(failed.data.error, /未能还原/)
    assert.ok(JSON.parse(readFileSync(stateFile, 'utf8')).packs.some((item) => item.name === 'other' && item.profile === 'stacked'))
    writeFileSync(backup, contents)
    for (const name of ['other', 'demo']) {
      const removed = await manager.call('/api/packs/uninstall', { name, profile: 'stacked' })
      assert.equal(removed.status, 200, removed.data.error)
    }
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), 'original\n')
  })

  await t.test('同一个包先整包装过、后来又只导配置：两条记录，各自按 configOnly 撤，顺序不能乱', async () => {
    const dir = join(profilesDir, 'mixed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"dsh-profile-mixed","private":true}\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), 'original\n')
    const manifestBefore = readFileSync(join(dir, 'package.json'))
    oldInstall('mixed')
    const afterLegacy = readFileSync(join(dir, 'package.json'))

    const data = await inspect({ source: packFile })
    const result = await manager.call('/api/environments/import', { token: data.token, name: '混装的示例', profile: 'mixed' })
    assert.equal(result.status, 200, result.data.error)
    assert.equal(result.data.config?.error, undefined, JSON.stringify(result.data.config))
    assert.deepEqual((await recordsOf('mixed')).map((record) => [record.name, record.configOnly === true]), [['demo', false], ['demo', true]], '配置导入不顶掉同名的整包记录')

    // 不带 configOnly 指的是那条整包记录：它不是最近一次，先撤配置
    const early = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'mixed' })
    assert.equal(early.status, 400)
    assert.match(early.data.error, /请先撤销/)
    const config = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'mixed', configOnly: true })
    assert.equal(config.status, 200, config.data.error)
    assert.deepEqual((await recordsOf('mixed')).map((record) => [record.name, record.configOnly === true]), [['demo', false]], '只摘掉配置那条')
    assert.ok(readFileSync(join(dir, 'package.json')).equals(afterLegacy), '撤配置不碰插件清单')
    const legacy = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'mixed' })
    assert.equal(legacy.status, 200, legacy.data.error)
    assert.ok(readFileSync(join(dir, 'package.json')).equals(manifestBefore), '整包安装撤掉后清单回到安装前')
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), 'original\n')
    assert.deepEqual(await recordsOf('mixed'), [])
  })

  await t.test('导入带 x-dsh-home：可选 Profile 和配置写入都跟着 Profile 页选的那个用户目录走', async () => {
    const two = join(manager.root, 'home-two')
    const sideDir = join(two, 'profiles', 'side')
    mkdirSync(sideDir, { recursive: true })
    writeFileSync(join(sideDir, 'package.json'), '{"name":"dsh-profile-side","private":true}\n')
    writeFileSync(join(sideDir, 'cordis.patch.yml'), '[]\n')
    const scope = { 'x-dsh-home': encodeURIComponent(two) }

    const checked = await manager.call('/api/environments/import/inspect', { source: packFile }, scope)
    assert.equal(checked.status, 200, checked.data.error)
    assert.ok(checked.data.profiles.includes('side'), '列的是那个目录里的 Profile')
    assert.ok(!checked.data.profiles.includes('mixed'), '默认目录里的 Profile 不混进来')
    const result = await manager.call('/api/environments/import', { token: checked.data.token, name: '第二个目录', profile: 'side' }, scope)
    assert.equal(result.status, 200, result.data.error)
    assert.equal(result.data.config?.profile, 'side')
    assert.equal(result.data.config?.error, undefined, JSON.stringify(result.data.config))
    assert.match(readFileSync(join(sideDir, 'cordis.patch.yml'), 'utf8'), /dsh-cost-meter/, '补丁层写进那个目录的 Profile')
    assert.ok(!existsSync(join(profilesDir, 'side')), '默认目录里不多出一份')
    assert.deepEqual((await recordsOf('side', scope)).map((record) => [record.name, record.configOnly === true]), [['demo', true]], '记录也记在那个目录名下')
    assert.deepEqual(await recordsOf('side'), [], '默认目录看不到')
    assert.ok(!JSON.parse(readFileSync(stateFile, 'utf8')).packs.some((item) => item.profile === 'side'), '默认目录的安装记录不混进来')

    const removed = await manager.call('/api/packs/uninstall', { name: 'demo', profile: 'side', configOnly: true }, scope)
    assert.equal(removed.status, 200, removed.data.error)
    assert.equal(readFileSync(join(sideDir, 'cordis.patch.yml'), 'utf8'), '[]\n')
  })

  // 旧的整包检查 / 安装接口对坏包、认不出的来源、过期的检查都回 400：问题出在用户给的东西上，
  // 页面据此提示「换一个文件」，而不是当成启动器自己坏了。换成环境的接口后这一点不该变。
  await t.test('用户给的东西有问题（坏包、认不出的来源、过期的检查、不存在的环境）回 4xx，不是 500', async () => {
    const bad = join(manager.root, 'bad-again.dspack')
    writeFileSync(bad, '这也不是压缩包')
    const wrong = []
    for (const [path, body, why] of [
      ['/api/environments/import/inspect', { source: bad }, '坏包'],
      ['/api/environments/import/inspect', { source: '不存在的路径' }, '认不出的来源'],
      ['/api/environments/import', { token: 'expired' }, '过期的检查'],
      ['/api/environments/export', { id: 'no-such-env', target: 'file', path: join(manager.root, 'ghost-2.dspack') }, '不存在的环境'],
    ]) {
      const result = await manager.call(path, body)
      if (!(result.status >= 400 && result.status < 500)) wrong.push(`${why}（${path}）HTTP ${result.status}`)
    }
    // 一次列全：哪几条不对一眼看清，不会只报第一条
    assert.deepEqual(wrong, [], '这些应回 4xx')
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
