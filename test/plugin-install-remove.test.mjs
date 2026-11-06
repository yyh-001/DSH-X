/**
 * 插件页的「添加 / 卸载」：官方做法是把 spec 交给 `dsh plugin add` / `remove`
 * （pnpm 透传），再补上 0.2.x 不再自动写的 `dsh.profile.bundles`；卸载还要清掉
 * 补丁层里这个包留下的 `disabled: true`。
 *
 * 真装插件要跑 pnpm，单测不碰网络：这里的假 dsh 只维护 profile 的
 * package.json / node_modules，并按命令记录调用参数。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

const PLUGIN = 'demo-plugin'
const OFFICIAL = '@deepseek-ai/dsh-web-app'
const VERSION = '0.2.0'

test('添加与卸载插件：装进指定环境、写层栈，卸载清掉补丁层残留', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const calls = join(root, 'commands.jsonl')
  mkdirSync(app, { recursive: true })
  writeFileSync(calls, '')

  const lib = join(data, 'versions', VERSION, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(lib, { recursive: true })
  // 假 dsh：add/remove 只动 profile 的清单和 node_modules，不跑 pnpm。
  writeFileSync(join(lib, 'bin.js'), `
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'plugin') {
  const profile = args[args.indexOf('--profile') + 1]
  const dir = join(process.env.DSH_HOME, 'profiles', profile)
  const pkgFile = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const verbAt = args.findIndex((value) => value === 'add' || value === 'remove')
  const verb = args[verbAt]
  const spec = args[verbAt + 1] === '-w' ? args[verbAt + 2] : args[verbAt + 1]
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ verb, spec, argv: args }) + '\\n')
  if (verb === 'add') {
    let name, version
    if (spec.startsWith('file:')) {
      const source = JSON.parse(readFileSync(join(spec.slice(5), 'package.json'), 'utf8'))
      name = source.name
      version = source.version
    } else {
      const match = /^(@[^/@]+\\/[^@/]+|[^@/]+)(?:@(.+))?$/.exec(spec)
      name = match[1]
      version = match[2] || '1.0.0'
    }
    pkg.dependencies = { ...pkg.dependencies, [name]: version }
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(target, 'cordis.patch.yml'), '- insert:\\n    - id: demo-row\\n      name: demo-plugin\\n')
  } else if (verb === 'remove') {
    delete pkg.dependencies[spec]
    rmSync(join(dir, 'node_modules', spec), { recursive: true, force: true })
  }
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
}
`)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: [VERSION] }))

  for (const profile of ['web', 'work']) {
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { [OFFICIAL]: VERSION },
      dsh: { profile: { bundles: [OFFICIAL] } },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    const officialDir = join(dir, 'node_modules', OFFICIAL)
    mkdirSync(officialDir, { recursive: true })
    writeFileSync(join(officialDir, 'package.json'), JSON.stringify({ name: OFFICIAL, version: VERSION }))
  }

  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: data, dshHome: home, profile: 'web', seedMarket: false, systemPath: false,
  }))
  process.env.PORT = String(await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  }))

  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())

  const api = async (path, body) => {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, ...(await response.json()) }
  }
  const view = async (profile = 'web') => {
    const response = await fetch(`${origin}/api/plugins?profile=${profile}`, { headers: { origin } })
    assert.equal(response.status, 200)
    return response.json()
  }
  const manifest = (profile = 'web') => JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  const patch = (profile = 'web') => readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
  const commands = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

  await t.test('首次添加：pnpm 收到原始 spec，清单与 bundles 一起更新', async () => {
    const added = await api('/api/plugins/add', { spec: `${PLUGIN}@1.0.0`, profile: 'web' })
    assert.equal(added.status, 200, JSON.stringify(added))
    assert.equal(added.name, PLUGIN)
    assert.deepEqual(commands().map(({ verb, spec }) => ({ verb, spec })), [{ verb: 'add', spec: `${PLUGIN}@1.0.0` }])
    assert.equal(manifest().dependencies[PLUGIN], '1.0.0')
    assert(manifest().dsh.profile.bundles.includes(PLUGIN), '0.2.x 的 add 不写层栈，启动器要补')
    assert((await view()).plugins.some((plugin) => plugin.name === PLUGIN && plugin.version === '1.0.0'))
    assert.equal((await view('work')).plugins.some((plugin) => plugin.name === PLUGIN), false, '不串到别的 profile')
  })

  await t.test('重复添加被挡住，官方组件不允许单独添加', async () => {
    const before = commands().length
    const again = await api('/api/plugins/add', { spec: PLUGIN, profile: 'web' })
    assert.equal(again.status, 400)
    assert.match(again.error, /已经在这个环境里/)
    const official = await api('/api/plugins/add', { spec: `${OFFICIAL}@${VERSION}`, profile: 'web' })
    assert.equal(official.status, 400)
    assert.match(official.error, /官方组件/)
    assert.equal(commands().length, before, '被挡下的请求不执行插件命令')
  })

  await t.test('卸载：pnpm remove + 摘层栈 + 清掉补丁层的禁用行', async () => {
    const off = await api('/api/plugins/toggle', { name: PLUGIN, enabled: false, profile: 'web' })
    assert.equal(off.status, 200, JSON.stringify(off))
    assert.match(patch(), /demo-row[\s\S]*disabled: true/)

    const removed = await api('/api/plugins/remove', { name: PLUGIN, profile: 'web' })
    assert.equal(removed.status, 200, JSON.stringify(removed))
    assert.deepEqual(commands().at(-1), { verb: 'remove', spec: PLUGIN, argv: ['plugin', '--profile', 'web', 'remove', PLUGIN] })
    assert.equal(Object.hasOwn(manifest().dependencies, PLUGIN), false)
    assert.equal(manifest().dsh.profile.bundles.includes(PLUGIN), false)
    assert.doesNotMatch(patch(), /demo-row/, '重装时不能带着旧的「已禁用」状态回来')
    assert.equal((await view()).plugins.some((plugin) => plugin.name === PLUGIN), false)
    assert(manifest().dsh.profile.bundles.includes(OFFICIAL), '官方组件不动')
  })

  await t.test('卸载不存在的 / 官方组件都拒绝，且不执行命令', async () => {
    const before = commands().length
    const missing = await api('/api/plugins/remove', { name: PLUGIN, profile: 'web' })
    assert.equal(missing.status, 400)
    assert.match(missing.error, /没有装/)
    const official = await api('/api/plugins/remove', { name: OFFICIAL, profile: 'web' })
    assert.equal(official.status, 400)
    assert.match(official.error, /官方组件/)
    assert.equal(commands().length, before)
  })

  await t.test('本地路径会补成 file: 交给 pnpm，装完从依赖增量认出包名', async () => {
    const dir = join(root, '本地插件')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '0.1.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const added = await api('/api/plugins/add', { spec: dir, profile: 'work' })
    assert.equal(added.status, 200, JSON.stringify(added))
    const command = commands().at(-1)
    assert.equal(command.verb, 'add')
    assert.match(command.spec, /^file:/)
    assert.equal(manifest('work').dependencies['local-plugin'], '0.1.0')
    assert(manifest('work').dsh.profile.bundles.includes('local-plugin'), '包名靠安装前后依赖清单的增量识别')
  })
})

test('界面入口与文案：环境详情里有添加按钮，行尾有卸载按钮，删改都要提醒重启', () => {
  const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')

  assert.match(server, /url\.pathname === '\/api\/plugins\/add'/)
  assert.match(server, /url\.pathname === '\/api\/plugins\/remove'/)
  assert.match(server, /await addPlugin\(version, spec, \{ profile \}\)/, '添加复用插件页同一条 pnpm 链路')
  assert.match(server, /await removePlugin\(version, name, \{ profile \}\)/, '卸载复用统一封装')
  assert.match(server, /removeBundleMounted\(dir, \[name\]\)/, '卸载同时从层栈摘掉')
  assert.match(server, /dropRowDisables\(dir, stale\)/, '卸载清理补丁层里的开关残留')

  assert.match(page, /data-plugin-add="1"/, '环境详情顶部有添加入口')
  assert.match(page, /id="pluginAddDialog"/, '添加插件弹窗')
  assert.match(page, /id="pluginAddSpec"[^>]*autocomplete="off"/)
  assert.match(page, /data-remove="\$\{escapeHtml\(plugin\.name\)\}"/, '插件行有卸载按钮')
  assert.match(page, /!plugin\.official/, '官方组件不给卸载入口')
  assert.match(page, /正在卸载…/, '卸载时行内进度说卸载，不是更新')
  assert.match(page, /卸载「\{name\}」？卸载后它提供的功能会消失，重启 dsh 后生效。/, '卸载要二次确认并提醒重启')
  assert.match(page, /data-remove[\s\S]{0,260}?event\.preventDefault\(\)[\s\S]{0,80}?event\.stopPropagation\(\)/, '卸载按钮要挡住整行 label 的开关')
  assert.match(css, /\.plugin-remove \{/, '卸载按钮有样式')
  assert.match(css, /#pluginAddDialog \.mcp-field input \{ width: 100%/, '包名/地址输入框占满')

  const dict = new Function(`return (${page.match(/const EN = (\{[\s\S]*?\n\})/)[1]})`)()
  for (const key of [
    '添加插件', '输入插件的 npm 包名、GitHub 地址或本地路径。', '包名或地址',
    '卸载插件', '卸载失败', '请填写插件包名或地址',
  ]) assert.equal(typeof dict[key], 'string', `缺少英文翻译：${key}`)
})
