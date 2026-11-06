/**
 * 启动项的数据目录与「从已有 Profile 复制」。
 *
 * 项目目录（issue #72 里的「项目根」绑定）已经下线：启动项只认 dsh 用户目录，
 * dsh 子进程固定落在 DSH_HOME 里。这里守的是仍然保留的行为：
 *   1) 保存启动项时能跨用户目录复制已有 Profile（只复制配置，不复制历史）；
 *   2) 子进程的 cwd 是 dsh 用户目录，不再跟着项目根；
 *   3) 旧设置里的 workdir 能迁移成 <项目>/.dsh，坏值不丢启动项。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'

/** 起得来的假 dsh，额外把 cwd 记到 DSH_HOME/cwd，用来验「子进程落在数据目录里」。 */
const recordCwdBin = (version) => `import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
// 桌面增强会调 \`dsh plugin add\`：假 dsh 只负责起服务，插件命令直接成功退出，也不记 spawn。
if (process.argv.includes('plugin')) process.exit(0)
const home = process.env.DSH_HOME
appendFileSync(join(home, 'spawned'), '${version}\\n')
appendFileSync(join(home, 'cwd'), process.cwd() + '\\n')
const server = createServer((req, res) => res.end('fake dsh ${version}'))
const at = process.argv.indexOf('--port')
server.listen(at >= 0 ? Number(process.argv[at + 1]) : 0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`

const env = await startChannelServer({
  prefix: 'dsh-launch-home-',
  packument: packumentOf({ latest: '1.0.0' }, ['1.0.0']),
  installed: ['1.0.0'],
  bin: recordCwdBin,
})
test.after(() => env.cleanup())

const save = (body) => env.call('/api/launch-presets', body)
const profileFile = (home, profile, name) => join(home, 'profiles', profile, name)

/** 在某个用户目录里手造一份「已经调好的 Profile」（无依赖，省掉安装那一步）。 */
function seedProfile(home, profile, { patch = '', marker = 'source' } = {}) {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    marker,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  if (patch) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  // 复制时要跳过的东西：真实环境里有几百 MB
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  return dir
}

test('从别的用户目录复制 Profile：配置过来、依赖重装、历史和 node_modules 不跟过来', async () => {
  const sourceHome = join(env.root, 'global-home')
  const patch = "- id: dsh-x-memory\n  disabled: true\n"
  seedProfile(sourceHome, 'ios-dev', { patch })
  const targetHome = join(env.root, 'homes', 'project-b')
  const result = await save({
    name: '环境 B',
    version: '1.0.0',
    profile: 'ios-dev',
    dshHome: targetHome,
    copyFrom: { profile: 'ios-dev', home: sourceHome },
  })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)

  const target = join(targetHome, 'profiles', 'ios-dev')
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-ios-dev', '复制出来的 Profile 要按新名字改名，别顶着来源的名字')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app'], '插件清单要保留')
  assert.equal(readFileSync(join(target, 'cordis.patch.yml'), 'utf8'), patch, '开关（补丁层）要原样过来')
  assert.ok(!existsSync(join(target, 'node_modules')), 'node_modules 不复制，装依赖是复制之后的事')
  assert.ok(!existsSync(join(targetHome, 'sessions')), '新环境不继承来源的会话历史')

  // 来源那份不能被动到：复制是读，不是搬
  assert.ok(existsSync(join(sourceHome, 'profiles', 'ios-dev', 'node_modules', 'left-pad', 'index.js')), '来源的 node_modules 要还在')
  assert.equal(JSON.parse(readFileSync(profileFile(sourceHome, 'ios-dev', 'package.json'), 'utf8')).name, 'dsh-profile-ios-dev')
})

test('目标里已经有同名 Profile 时不再复制，别覆盖用户后来改的那份', async () => {
  const sourceHome = join(env.root, 'global-home-2')
  seedProfile(sourceHome, 'keep', { marker: 'source' })
  const targetHome = join(env.root, 'homes', 'project-c')
  const target = join(targetHome, 'profiles', 'keep')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-profile-keep', private: true, marker: 'mine' }))

  const result = await save({
    name: '环境 C',
    version: '1.0.0',
    profile: 'keep',
    dshHome: targetHome,
    copyFrom: { profile: 'keep', home: sourceHome },
  })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).marker, 'mine', '目标已有的配置不能被覆盖')
})

test('子进程的 cwd 是 dsh 用户目录，不再有项目根', async () => {
  const home = join(env.root, 'homes', 'cwd-home')
  const saved = await save({ name: '目录 D', version: '1.0.0', profile: 'work', dshHome: home, ensureProfile: true })
  assert.ok(saved.ok, `保存失败：HTTP ${saved.status} ${JSON.stringify(saved.data)}`)
  const id = saved.data.entry.id

  const started = await env.call('/api/start', { version: '1.0.0', profile: 'work' }, { 'x-dsh-launch-id': id })
  assert.ok(started.ok, `启动失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)

  assert.equal(readFileSync(join(home, 'cwd'), 'utf8').trim(), realpathSync(home), 'cwd 要落在 DSH_HOME 里')
  assert.ok(existsSync(join(home, 'spawned')), '数据目录就是启动项选的用户目录')
  await env.call('/api/stop', { version: '1.0.0', profile: 'work', home }, { 'x-dsh-launch-id': id })
})

test('手工启动（不带启动项 ID）也用请求里的 dsh 用户目录当 cwd', async () => {
  const home = join(env.root, 'homes', 'manual-home')
  const headers = { 'x-dsh-home': encodeURIComponent(home) }
  // 先让服务端认得这个目录，再按目录启动
  await save({ name: '环境 E', version: '1.0.0', profile: 'web', dshHome: home, ensureProfile: true })
  const started = await env.call('/api/start', { version: '1.0.0', profile: 'web' }, headers)
  assert.ok(started.ok, `启动失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)
  assert.equal(readFileSync(join(home, 'cwd'), 'utf8').trim(), realpathSync(home))
  await env.call('/api/stop', { version: '1.0.0', profile: 'web', home }, headers)
})

test('旧设置里的 workdir 迁移成 <项目>/.dsh，坏值回默认而不丢启动项', async () => {
  const settings = await import('../src/settings.js')
  assert.equal(settings.safeWorkdir(''), '')
  assert.equal(settings.safeWorkdir(undefined), '')
  assert.throws(() => settings.safeWorkdir('proj'), /绝对路径/)

  const project = join(env.root, 'legacy-project')
  const legacy = settings.safeLaunchPresets([{
    id: 'aaaaaaaaaaaaaaaa', name: 'x', version: '1.0.0', profile: 'web', workdir: project,
  }])
  const migrated = legacy.find((item) => item.id === 'aaaaaaaaaaaaaaaa')
  assert.equal(migrated?.dshHome, join(project, '.dsh'), '只写了 workdir 的旧启动项，数据目录按 <项目>/.dsh 保留')
  assert.equal(migrated?.workdir, undefined, 'workdir 不再出现在新设置里')

  // 用当前平台的绝对路径：'D:/other' 在 POSIX 上不是绝对路径，会被 safeDshHome 拒掉。
  const otherHome = join(env.root, 'other-home')
  const both = settings.safeLaunchPresets([{
    id: 'bbbbbbbbbbbbbbbb', name: 'y', version: '1.0.0', profile: 'web', workdir: project, dshHome: otherHome,
  }])
  assert.equal(both.find((item) => item.id === 'bbbbbbbbbbbbbbbb')?.dshHome, resolve(otherHome), '已有 dshHome 时以它为准')

  const bad = settings.safeLaunchPresets([{
    id: 'cccccccccccccccc', name: 'z', version: '1.0.0', profile: 'web', workdir: 'proj',
  }])
  assert.ok(bad.some((item) => item.id === 'cccccccccccccccc'), '坏 workdir 只是不迁移，别把启动项整条丢掉')
  assert.equal(bad.find((item) => item.id === 'cccccccccccccccc')?.dshHome, undefined)
})
