/**
 * 环境的 HTTP 接口（系统测试）：进程内真服务 + 隔离用户目录 + 本地假 npm registry（插件包也从它解析）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   - GET  /api/environments → { environments: [{ id, name, dshVersion, updateChannel, following, source, plugins, bundles, usedBy }] }
 *   - POST /api/environments/create { name, dshVersion?, updateChannel?, from? }：空环境默认两个官方 bundle、无依赖；
 *     from 复制插件列表与版本；名字 1–48 个字符
 *   - POST /api/environments/update { id, name?, dshVersion?, updateChannel? }：只改名字和 DSH 版本（版本类型）；改 DSH 版本时
 *     把用它的启动项的 version / updateChannel 一起改（双写）。说明不在这里改：导出时填，导出后记回环境
 *   - POST /api/environments/export { id, target, path, description?, version? }：导出时填的说明和版本号记回环境
 *   - POST /api/environments/remove { id }：有启动项在用就拒绝，否则清单目录一起删
 *   - POST /api/environments/plugins/add|remove|upgrade：精确版本不联网原样存；github:/link:/file: 原样存；
 *     裸名 / tag / 范围经 registry 解析成精确版本；官方包不能删；upgrade 回 upgraded:[{name,from,to}]
 *   - POST /api/launch-presets：认 environment；不存在的 id 报错；不带时按 Profile 派生（同目录 + Profile + 版本 → 同一个环境，
 *     前提是 Profile 目录有 package.json）；改已绑定启动项的版本 → 环境的版本跟着改
 *   - /api/state 里的启动项始终带合法的 version 与 profile
 *
 * 设计：等价类（精确版本 / 协议型 / 需解析三类 spec）、边界值（名字 0/1/48/49 个字符）、决策表（启动项带不带 environment ×
 * Profile 有没有清单）、状态迁移（新建 → 绑定 → 删除被拒 → 解绑 → 删除成功）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import { BASE, ENV_ID_RE, WEB, profileManifest, seedProfile, startPluginRegistry } from './environments-fixture.mjs'

// 注意：src/settings.js（以及 server.js）在导入时就按 HOME 定下设置目录，绝不能在夹具隔离 HOME 之前静态导入，
// 否则整个用例会读写本机真实的启动器设置与数据目录。要用里面的东西就从夹具返回的模块上取。
const env = await startChannelServer({
  prefix: 'dsh-env-api-',
  packument: packumentOf({ latest: '1.1.0' }, ['1.0.0', '1.1.0']),
  installed: ['1.0.0', '1.1.0'],
})
// 插件包的解析走这个 registry（服务端每次用时现读 npm_config_registry）；dsh 本体也照样能查到
const registry = await startPluginRegistry({
  '@deepseek-ai/dsh': { tags: { latest: '1.1.0' }, versions: ['1.0.0', '1.1.0'] },
  'dsh-x-foo': { tags: { latest: '2.0.0', next: '3.0.0-beta.1' }, versions: ['1.0.0', '1.5.0', '2.0.0', '3.0.0-beta.1'] },
  '@acme/dsh-bar': { tags: { latest: '2.3.0' }, versions: ['2.1.0', '2.3.0'] },
})
process.env.npm_config_registry = registry.url
const { VERSION_RE } = env.settings
test.after(async () => {
  await env.cleanup()
  await registry.close()
})

// ---------------------------------------------------------------- 驱动件

async function okPost(path, body, headers) {
  const result = await env.call(path, body, headers)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
/** 期望被拒：非 2xx 且带 error 文案。 */
async function rejected(path, body, why) {
  const result = await env.call(path, body)
  assert.equal(result.ok, false, `${why}：应被拒绝，实际 HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.ok(result.status >= 400, `${why}：要回错误状态码`)
  assert.equal(typeof result.data?.error, 'string', `${why}：要带 error 文案`)
  return result
}
const listEnvs = async () => (await env.getJson('/api/environments')).environments
const envById = async (id) => (await listEnvs()).find((item) => item.id === id)
const create = async (body) => {
  const data = await okPost('/api/environments/create', body)
  assert.ok(data.environment?.id, `新建要回 environment：${JSON.stringify(data)}`)
  return data.environment
}
/** 接口视图里的依赖表：有 spec 的插件行。 */
const depsOf = (view) => Object.fromEntries((view?.plugins || []).filter((item) => item.spec).map((item) => [item.name, item.spec]))
const specOf = (view, name) => (view?.plugins || []).find((item) => item.name === name)?.spec
// 环境清单放在启动器自己的设置目录（APP_DIR，和 settings.json、manager.log 同处），不在数据目录（<数据目录>/envs 是早先的位置）
const manifestDir = (id) => join(env.app, 'envs', id)
const storedPreset = (id) => (env.stored().launchPresets || []).find((item) => item.id === id)
const savePreset = (body) => okPost('/api/launch-presets', body).then((data) => data.entry)
let profileSeq = 0
/** 每个用例一个新 Profile（默认目录里），不同用例互不干扰。 */
function freshProfile(prefix, list) {
  const name = `${prefix}-${(profileSeq += 1)}`
  seedProfile(env.home, name, profileManifest(name, list))
  return name
}

// ---------------------------------------------------------------- 列表与新建

test('GET /api/environments：返回 environments 数组', async () => {
  const data = await env.getJson('/api/environments')
  assert.ok(Array.isArray(data.environments), `要有 environments 数组：${JSON.stringify(data).slice(0, 200)}`)
})

test('新建空环境：两个官方 bundle、没有依赖，清单落在 <APP_DIR>/envs/<id>/environment.json，列表里看得到', async () => {
  const created = await create({ name: '空环境', dshVersion: '1.0.0' })
  assert.match(created.id, ENV_ID_RE)
  assert.equal(created.name, '空环境')
  assert.ok(existsSync(join(manifestDir(created.id), 'environment.json')), '每个环境一份清单文件')
  assert.equal(existsSync(join(env.data, 'envs', created.id)), false, '数据目录里不该再有环境清单')
  const view = await envById(created.id)
  assert.ok(view, '新建的环境要出现在列表里')
  assert.equal(view.dshVersion, '1.0.0')
  assert.deepEqual(view.bundles, [BASE, WEB], '空环境默认 dsh-base + dsh-web-app')
  assert.deepEqual((view.plugins || []).filter((item) => !item.official), [], '空环境没有第三方插件')
  assert.deepEqual(depsOf(view), {}, '空环境没有依赖')
  assert.equal(view.following, false, '本地新建的环境不跟随上游')
  assert.deepEqual(view.usedBy, [], '还没有启动项用它')
})

test('新建：不给版本也能建，版本是 auto 或一个精确版本', async () => {
  const created = await create({ name: '不给版本' })
  const view = await envById(created.id)
  assert.ok(view.dshVersion === 'auto' || VERSION_RE.test(view.dshVersion), `版本要合法：${view.dshVersion}`)
})

test('新建：auto + rc 版本类型原样保存', async () => {
  const created = await create({ name: '跟 RC', dshVersion: 'auto', updateChannel: 'rc' })
  const view = await envById(created.id)
  assert.equal(view.dshVersion, 'auto')
  assert.equal(view.updateChannel, 'rc')
})

test('新建：名字边界——1 个和 48 个字符可以；空串、纯空白、49 个字符拒绝', async () => {
  assert.equal((await create({ name: 'x', dshVersion: '1.0.0' })).name, 'x')
  const long = '长'.repeat(48)
  assert.equal((await create({ name: long, dshVersion: '1.0.0' })).name, long)
  const before = (await listEnvs()).length
  await rejected('/api/environments/create', { name: '', dshVersion: '1.0.0' }, '空名字')
  await rejected('/api/environments/create', { name: '   ', dshVersion: '1.0.0' }, '纯空白名字')
  await rejected('/api/environments/create', { name: '长'.repeat(49), dshVersion: '1.0.0' }, '49 个字符')
  await rejected('/api/environments/create', { dshVersion: '1.0.0' }, '没有 name 字段')
  assert.equal((await listEnvs()).length, before, '被拒的请求不能留下环境')
})

test('新建：坏版本号、坏版本类型拒绝', async () => {
  await rejected('/api/environments/create', { name: '坏版本', dshVersion: 'not-a-version!' }, '坏版本号')
  await rejected('/api/environments/create', { name: '坏类型', dshVersion: 'auto', updateChannel: 'beta' }, '坏版本类型')
})

test('复制：from 复制插件列表与版本，id 不同；改副本不影响原件', async () => {
  const original = await create({ name: '原件', dshVersion: '1.1.0' })
  await okPost('/api/environments/plugins/add', { id: original.id, spec: 'dsh-x-copy-a@1.0.0' })
  await okPost('/api/environments/plugins/add', { id: original.id, spec: '@acme/dsh-copy-b@0.2.0' })
  const source = await envById(original.id)

  const copy = await create({ name: '副本', from: original.id })
  assert.notEqual(copy.id, original.id)
  const view = await envById(copy.id)
  assert.equal(view.dshVersion, '1.1.0', '版本跟着复制')
  assert.deepEqual(depsOf(view), depsOf(source), '依赖跟着复制')
  assert.deepEqual(view.bundles, source.bundles, 'bundles 连顺序一起复制')

  await okPost('/api/environments/plugins/remove', { id: copy.id, name: 'dsh-x-copy-a' })
  assert.equal(specOf(await envById(original.id), 'dsh-x-copy-a'), '1.0.0', '改副本不能动到原件')
})

test('复制：from 指向不存在的环境报错', async () => {
  await rejected('/api/environments/create', { name: '无源', from: 'no-such-env' }, '复制不存在的环境')
})

// ---------------------------------------------------------------- 修改

test('修改：改名、版本生效，说明不在这里改；不存在的 id、超长名字拒绝', async () => {
  const created = await create({ name: '待改', dshVersion: '1.0.0' })
  const descriptionBefore = (await envById(created.id)).description
  const data = await okPost('/api/environments/update', { id: created.id, name: '改好了', description: '说明文字', dshVersion: '1.1.0' })
  assert.equal(data.environment?.name, '改好了')
  const view = await envById(created.id)
  assert.equal(view.name, '改好了')
  assert.equal(view.dshVersion, '1.1.0')
  assert.equal(view.description, descriptionBefore, '修改接口只管名字和版本，带了说明也不改')
  await rejected('/api/environments/update', { id: 'no-such-env', name: 'x' }, '不存在的环境')
  await rejected('/api/environments/update', { id: created.id, name: 'x'.repeat(49) }, '超长名字')
  assert.equal((await envById(created.id)).name, '改好了', '被拒的修改不能落盘')
})

// 中文界面把这个对象叫「实例」（装好插件的 DSH），接口回给页面的报错也跟着说实例
test('报错文案说「实例」：不存在、id 不合法、名字超长、移除不存在的插件', async () => {
  const created = await create({ name: '报错文案', dshVersion: '1.0.0' })
  const cases = [
    ['/api/environments/update', { id: 'no-such-env', name: 'x' }, /^这个实例已不存在，请刷新后重试$/],
    ['/api/environments/plugins/add', { id: 'no-such-env', spec: 'dsh-x-foo@1.0.0' }, /^这个实例已不存在，请刷新后重试$/],
    ['/api/environments/update', { id: '../evil', name: 'x' }, /^实例 id 不合法$/],
    ['/api/environments/update', { id: created.id, name: 'x'.repeat(49) }, /^实例名称请填 1-48 个字符$/],
    ['/api/environments/plugins/remove', { id: created.id, name: 'dsh-x-not-here' }, /^实例里没有 dsh-x-not-here$/],
  ]
  for (const [path, body, expected] of cases) {
    const { data } = await rejected(path, body, `${path} ${JSON.stringify(body)}`)
    assert.match(data.error, expected, path)
    assert.doesNotMatch(data.error, /环境/, `${path} 的报错不再说环境`)
  }
  // 启动项绑了不存在的实例：报错也说实例
  const { data } = await rejected('/api/launch-presets', { name: '幽灵实例', version: '1.0.0', profile: freshProfile('ghost-instance'), environment: 'no-such-env' }, '不存在的实例 id')
  assert.match(data.error, /这个实例已不存在，请刷新后/)
})

test('说明：导出时填，导出后记回环境（连同导出的版本号）', async () => {
  const created = await create({ name: '要导出', dshVersion: '1.0.0' })
  const path = join(env.root, `export-${created.id}.dspack`)
  await okPost('/api/environments/export', { id: created.id, target: 'file', path, description: '说明文字', version: '2.0.0' })
  assert.ok(existsSync(path), '导出文件要写出来')
  const view = await envById(created.id)
  assert.equal(view.description, '说明文字', '导出时填的说明记回环境')
  assert.equal(view.packVersion, '2.0.0', '导出的版本号也记回环境，下次导出从这里接着填')
})

// ---------------------------------------------------------------- 插件

test('装插件：精确版本原样存、不联网，并追加到 bundles 末尾', async () => {
  const created = await create({ name: '精确版本', dshVersion: '1.0.0' })
  const data = await okPost('/api/environments/plugins/add', { id: created.id, spec: 'dsh-x-exact@1.2.3' })
  assert.ok(data.environment, '要回更新后的环境')
  await okPost('/api/environments/plugins/add', { id: created.id, spec: '@acme/dsh-exact@4.5.6' })
  const view = await envById(created.id)
  assert.equal(specOf(view, 'dsh-x-exact'), '1.2.3')
  assert.equal(specOf(view, '@acme/dsh-exact'), '4.5.6', '带 scope 的包名也认')
  assert.deepEqual(view.bundles, [BASE, WEB, 'dsh-x-exact', '@acme/dsh-exact'], '按添加顺序追加在末尾')
  assert.equal(registry.asked('dsh-x-exact'), false, '精确版本不该去 registry 查')
  assert.equal(registry.asked('@acme/dsh-exact'), false, '精确版本不该去 registry 查')
})

test('装插件：github: / link: / file: 原样存，本地路径标成 local', async () => {
  const created = await create({ name: '协议型', dshVersion: '1.0.0' })
  const gh = 'github:octo/dsh-x-gh#0123456789abcdef0123456789abcdef01234567'
  const linked = `link:${join(env.root, 'plugins', 'linked')}`
  const filed = `file:${join(env.root, 'plugins', 'filed.tgz')}`
  await okPost('/api/environments/plugins/add', { id: created.id, spec: `dsh-x-gh@${gh}` })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: `dsh-x-linked@${linked}` })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: `dsh-x-filed@${filed}` })
  const view = await envById(created.id)
  assert.equal(specOf(view, 'dsh-x-gh'), gh)
  assert.equal(specOf(view, 'dsh-x-linked'), linked)
  assert.equal(specOf(view, 'dsh-x-filed'), filed)
  const row = (name) => view.plugins.find((item) => item.name === name)
  assert.equal(row('dsh-x-linked').local, true, 'link: 是本地插件')
  assert.equal(row('dsh-x-filed').local, true, 'file: 是本地插件')
  assert.ok(!row('dsh-x-gh').local, 'github: 不是本地插件')
  assert.ok(['dsh-x-gh', 'dsh-x-linked', 'dsh-x-filed'].every((name) => view.bundles.includes(name)))
})

test('装插件：裸名 → latest、tag → 对应版本、范围 → 满足范围的最高版本', async () => {
  const cases = [['dsh-x-foo', '2.0.0'], ['dsh-x-foo@latest', '2.0.0'], ['dsh-x-foo@next', '3.0.0-beta.1'], ['dsh-x-foo@^1.0.0', '1.5.0'], ['@acme/dsh-bar', '2.3.0']]
  for (const [spec, expected] of cases) {
    const created = await create({ name: `解析 ${spec}`, dshVersion: '1.0.0' })
    const result = await env.call('/api/environments/plugins/add', { id: created.id, spec })
    assert.ok(result.ok, `${spec} 应能解析：HTTP ${result.status} ${JSON.stringify(result.data)}`)
    const name = spec.startsWith('@') ? spec.split('@').slice(0, 2).join('@') : spec.split('@')[0]
    assert.equal(specOf(await envById(created.id), name), expected, `${spec} 要钉成精确版本 ${expected}`)
  }
})

test('装插件：同一个插件再装一次只换版本，bundles 里不重复', async () => {
  const created = await create({ name: '重复装', dshVersion: '1.0.0' })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: 'dsh-x-foo@1.0.0' })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: 'dsh-x-foo@1.5.0' })
  const view = await envById(created.id)
  assert.equal(specOf(view, 'dsh-x-foo'), '1.5.0')
  assert.equal(view.bundles.filter((name) => name === 'dsh-x-foo').length, 1)
})

test('装插件：registry 里没有的包、空 spec、不存在的环境都报错，环境不变', async () => {
  const created = await create({ name: '装不上', dshVersion: '1.0.0' })
  const before = await envById(created.id)
  await rejected('/api/environments/plugins/add', { id: created.id, spec: 'dsh-x-nope' }, 'registry 里没有的包')
  await rejected('/api/environments/plugins/add', { id: created.id, spec: '' }, '空 spec')
  await rejected('/api/environments/plugins/add', { id: 'no-such-env', spec: 'dsh-x-foo@1.0.0' }, '不存在的环境')
  const after = await envById(created.id)
  assert.deepEqual(depsOf(after), depsOf(before))
  assert.deepEqual(after.bundles, before.bundles)
})

test('卸插件：从依赖和 bundles 一起删；不认识的名字、官方包拒绝', async () => {
  const created = await create({ name: '卸插件', dshVersion: '1.0.0' })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: 'dsh-x-foo@1.0.0' })
  await okPost('/api/environments/plugins/add', { id: created.id, spec: '@acme/dsh-bar@2.1.0' })
  await okPost('/api/environments/plugins/remove', { id: created.id, name: 'dsh-x-foo' })
  const view = await envById(created.id)
  assert.equal(specOf(view, 'dsh-x-foo'), undefined)
  assert.deepEqual(view.bundles, [BASE, WEB, '@acme/dsh-bar'], '其余 bundle 顺序不变')
  await rejected('/api/environments/plugins/remove', { id: created.id, name: 'dsh-x-not-here' }, '不认识的插件')
  await rejected('/api/environments/plugins/remove', { id: created.id, name: WEB }, '官方 dsh-web-app')
  assert.deepEqual((await envById(created.id)).bundles, [BASE, WEB, '@acme/dsh-bar'], '被拒的卸载不能动列表')
})

test('升级插件：不带 name 全部升到 latest 并回 from/to；带 name 只升那一个；已是最新的不列', async () => {
  const all = await create({ name: '全部升级', dshVersion: '1.0.0' })
  await okPost('/api/environments/plugins/add', { id: all.id, spec: 'dsh-x-foo@1.0.0' })
  await okPost('/api/environments/plugins/add', { id: all.id, spec: '@acme/dsh-bar@2.1.0' })
  const data = await okPost('/api/environments/plugins/upgrade', { id: all.id })
  const upgraded = Object.fromEntries((data.upgraded || []).map((item) => [item.name, item]))
  assert.deepEqual(upgraded['dsh-x-foo'], { name: 'dsh-x-foo', from: '1.0.0', to: '2.0.0' })
  assert.deepEqual(upgraded['@acme/dsh-bar'], { name: '@acme/dsh-bar', from: '2.1.0', to: '2.3.0' })
  const view = await envById(all.id)
  assert.equal(specOf(view, 'dsh-x-foo'), '2.0.0')
  assert.equal(specOf(view, '@acme/dsh-bar'), '2.3.0')
  const again = await okPost('/api/environments/plugins/upgrade', { id: all.id })
  assert.deepEqual(again.upgraded, [], '都已是最新时不该再列')

  const one = await create({ name: '单个升级', dshVersion: '1.0.0' })
  await okPost('/api/environments/plugins/add', { id: one.id, spec: 'dsh-x-foo@1.0.0' })
  await okPost('/api/environments/plugins/add', { id: one.id, spec: '@acme/dsh-bar@2.1.0' })
  const single = await okPost('/api/environments/plugins/upgrade', { id: one.id, name: '@acme/dsh-bar' })
  assert.deepEqual((single.upgraded || []).map((item) => item.name), ['@acme/dsh-bar'])
  const oneView = await envById(one.id)
  assert.equal(specOf(oneView, '@acme/dsh-bar'), '2.3.0')
  assert.equal(specOf(oneView, 'dsh-x-foo'), '1.0.0', '没点名的插件不动')
})

// ---------------------------------------------------------------- 启动项绑定

test('启动项绑定：显式 environment 保存后 settings.json 同时有 environment、version、profile，usedBy 列出它', async () => {
  const profile = freshProfile('bind')
  const created = await create({ name: '绑定用', dshVersion: '1.0.0' })
  const entry = await savePreset({ name: '绑定启动项', version: '1.0.0', profile, environment: created.id })
  assert.equal(entry.environment, created.id)
  const stored = storedPreset(entry.id)
  assert.equal(stored.environment, created.id, 'environment 要落盘')
  assert.equal(stored.version, '1.0.0', '旧字段 version 照写（回滚兼容）')
  assert.equal(stored.profile, profile, '旧字段 profile 照写')
  const view = await envById(created.id)
  assert.deepEqual(view.usedBy, [{ id: entry.id, name: '绑定启动项' }])
})

test('启动项绑定：不存在的环境 id 拒绝，不落盘', async () => {
  const profile = freshProfile('ghost-env')
  await rejected('/api/launch-presets', { name: '幽灵环境', version: '1.0.0', profile, environment: 'no-such-env' }, '不存在的环境 id')
  await rejected('/api/launch-presets', { name: '坏环境', version: '1.0.0', profile, environment: '../evil' }, '不合法的环境 id')
  const presets = env.stored().launchPresets || []
  assert.ok(!presets.some((item) => ['幽灵环境', '坏环境'].includes(item.name)), '被拒的启动项不能留下')
})

test('启动项自动绑定：不带 environment 时按 Profile 派生，列表 = Profile 清单、版本 = 启动项版本；不同版本各一个环境', async () => {
  const list = { dependencies: { 'dsh-x-memory': '1.0.0' }, bundles: [BASE, WEB, 'dsh-x-memory'] }
  const profile = freshProfile('derive', list)
  const first = await savePreset({ name: '派生一', version: '1.0.0', profile })
  assert.match(String(first.environment), ENV_ID_RE, '没带 environment 也要自动绑上')
  const view = await envById(first.environment)
  assert.ok(view, '派生的环境要在列表里')
  assert.equal(view.dshVersion, '1.0.0')
  assert.deepEqual(depsOf(view), list.dependencies)
  assert.deepEqual(view.bundles, list.bundles)

  const second = await savePreset({ name: '派生二', version: '1.1.0', profile })
  assert.match(String(second.environment), ENV_ID_RE)
  assert.notEqual(second.environment, first.environment, '同 Profile 不同版本要各一个环境')
  assert.equal((await envById(second.environment)).dshVersion, '1.1.0')
})

test('启动项自动绑定：同目录 + 同 Profile + 同版本 → 同一个环境（删掉重存也接回去，不多建）', async () => {
  const profile = freshProfile('same')
  const first = await savePreset({ name: '同一组合', version: '1.0.0', profile })
  const count = (await listEnvs()).length
  await okPost('/api/launch-presets/remove', { id: first.id })
  const again = await savePreset({ name: '同一组合重存', version: '1.0.0', profile })
  assert.equal(again.environment, first.environment, '同一组合要落到同一个环境')
  assert.equal((await listEnvs()).length, count, '不能多建环境')

  const edited = await savePreset({ ...again, name: '同一组合改名' })
  assert.equal(edited.environment, first.environment, '只改名字不换环境')
})

test('启动项自动绑定：Profile 目录没有 package.json 时不绑环境', async () => {
  // web 是 dsh 的模板名：目录还没初始化时也允许存启动项（首次启动 dsh 自己建）
  const home = join(env.root, 'home-without-manifest')
  const entry = await savePreset({ name: '无清单', version: '1.0.0', profile: 'web', dshHome: home })
  assert.equal(entry.environment, undefined, '没有清单就没有可收养的插件列表')
  assert.equal(storedPreset(entry.id).environment, undefined)
  assert.equal(storedPreset(entry.id).version, '1.0.0')
})

// ---------------------------------------------------------------- 双写

test('双写：改环境的 DSH 版本，所有用它的启动项的 version（和 updateChannel）跟着改', async () => {
  const created = await create({ name: '双写', dshVersion: '1.0.0' })
  const a = await savePreset({ name: '双写甲', version: '1.0.0', profile: freshProfile('dual'), environment: created.id })
  const b = await savePreset({ name: '双写乙', version: '1.0.0', profile: freshProfile('dual'), environment: created.id })

  await okPost('/api/environments/update', { id: created.id, dshVersion: '1.1.0' })
  assert.equal(storedPreset(a.id).version, '1.1.0', '甲的 version 要跟着环境改')
  assert.equal(storedPreset(b.id).version, '1.1.0', '乙的 version 要跟着环境改')

  await okPost('/api/environments/update', { id: created.id, dshVersion: 'auto', updateChannel: 'rc' })
  for (const id of [a.id, b.id]) {
    assert.equal(storedPreset(id).version, 'auto')
    assert.equal(storedPreset(id).updateChannel, 'rc', 'auto 的版本类型也要写回启动项')
    assert.equal(storedPreset(id).environment, created.id, '双写不能把绑定丢了')
  }
  const unrelated = await savePreset({ name: '不相关', version: '1.0.0', profile: freshProfile('dual') })
  await okPost('/api/environments/update', { id: created.id, dshVersion: '1.0.0' })
  assert.equal(storedPreset(unrelated.id).version, '1.0.0', '没用这个环境的启动项不受影响')
})

test('双写：改已绑定启动项的版本，它的环境的 DSH 版本跟着改', async () => {
  const created = await create({ name: '反向双写', dshVersion: '1.0.0' })
  const entry = await savePreset({ name: '反向甲', version: '1.0.0', profile: freshProfile('reverse'), environment: created.id })
  const saved = await savePreset({ ...entry, version: '1.1.0' })
  assert.equal(saved.environment, created.id, '改版本不换环境')
  assert.equal((await envById(created.id)).dshVersion, '1.1.0', '环境是版本的真源，要跟着改')
})

test('双写：改一个启动项的版本，同一环境的其他启动项也跟着改', async () => {
  const created = await create({ name: '连带双写', dshVersion: '1.0.0' })
  const a = await savePreset({ name: '连带甲', version: '1.0.0', profile: freshProfile('chain'), environment: created.id })
  const b = await savePreset({ name: '连带乙', version: '1.0.0', profile: freshProfile('chain'), environment: created.id })
  await savePreset({ ...a, version: '1.1.0' })
  assert.equal(storedPreset(b.id).version, '1.1.0', '同环境的启动项 version 是环境版本的副本')
})

// ---------------------------------------------------------------- 删除

test('删除环境：有启动项在用拒绝；解绑后删除，清单目录一起删', async () => {
  const created = await create({ name: '要删的', dshVersion: '1.0.0' })
  const entry = await savePreset({ name: '占着', version: '1.0.0', profile: freshProfile('remove'), environment: created.id })
  await rejected('/api/environments/remove', { id: created.id }, '还有启动项在用')
  assert.ok(existsSync(manifestDir(created.id)), '被拒的删除不能动清单')
  assert.ok(await envById(created.id))

  await okPost('/api/launch-presets/remove', { id: entry.id })
  await okPost('/api/environments/remove', { id: created.id })
  assert.equal(existsSync(manifestDir(created.id)), false, '清单目录要删掉')
  assert.equal(await envById(created.id), undefined, '列表里不再有它')
  await rejected('/api/environments/remove', { id: created.id }, '删过的再删')
})

// ---------------------------------------------------------------- WSL 启动项

test('WSL 启动项不接环境：本机启动项查重不看它，存别的启动项、列环境都不给它绑环境', async () => {
  const profile = freshProfile('wsl-twin', { dependencies: {}, bundles: [BASE, WEB] })
  const wsl = { id: 'abcdefabcdef0123', name: 'WSL 同名', version: '1.0.0', profile, port: 0, backend: 'wsl', wslDistro: 'Ubuntu', wslHome: '~/.dsh' }
  // WSL 启动项要 wsl.exe 探测才能经接口存，这里直接写进设置（等于在 Windows 上存好后换到这台机器读）
  await env.settings.saveSettings((current) => ({ launchPresets: [...(current.launchPresets || []), wsl] }))
  try {
    // 同 Profile 名、同版本，但一个在本机目录、一个在 WSL：不是同一个实例，不算重复
    const local = await savePreset({ name: '本机同名', version: '1.0.0', profile })
    assert.match(String(local.environment), ENV_ID_RE, '本机启动项照常绑上环境')
    await listEnvs()
    const stored = storedPreset(wsl.id)
    assert.ok(stored, 'WSL 启动项还在')
    assert.equal('environment' in stored, false, 'WSL 启动项不记 environment')
    assert.ok(!(await listEnvs()).some((item) => (item.usedBy || []).some((use) => use.id === wsl.id)), '没有哪个环境说自己被 WSL 启动项用着')
  } finally {
    await env.settings.saveSettings((current) => ({ launchPresets: (current.launchPresets || []).filter((item) => item.id !== wsl.id) }))
  }
})

// ---------------------------------------------------------------- 回滚兼容

test('/api/state 里每个启动项都带合法的 version 与 profile', async () => {
  const state = await env.state()
  assert.ok((state.launchPresets || []).length > 1, '前面的用例存了不少启动项')
  for (const entry of state.launchPresets) {
    if (entry.error) continue
    assert.match(String(entry.version), VERSION_RE, `「${entry.name}」的 version 要合法`)
    assert.match(String(entry.profile), /^[A-Za-z0-9._-]{1,32}$/, `「${entry.name}」的 profile 要合法`)
  }
})
