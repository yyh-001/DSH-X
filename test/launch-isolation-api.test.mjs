/**
 * 启动项保存接口的隔离引导配套：body.ensureProfile 在目标目录里补建缺失的 Profile。
 * 页面「新建启动项」的插件隔离 / 会话隔离两档只填名字和目录，Profile 由服务端在这里一次建好，
 * 免得页面先建 Profile 再存启动项、两步之间失败留下半截环境。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const env = await startChannelServer({ prefix: 'dsh-launch-isolation-', packument: packumentOf({ latest: '1.0.0' }, ['1.0.0']) })
test.after(() => env.cleanup())

const save = (body) => env.call('/api/launch-presets', body)
const profileManifest = (home, name) => join(home, 'profiles', name, 'package.json')

test('插件隔离：ensureProfile 在全局目录补建 Profile，启动项落在默认目录', async () => {
  const result = await save({ name: '隔离测试', version: 'auto', profile: 'work', dshHome: '', ensureProfile: true })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(result.data.entry.profile, 'work')
  assert.equal('dshHome' in result.data.entry, false, '插件隔离用全局目录，不写 dshHome')

  const manifest = JSON.parse(readFileSync(profileManifest(env.home, 'work'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-work')
  assert.ok(Array.isArray(manifest.dsh.profile.bundles), '补建的 Profile 要带 bundle 清单')
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'), '新建 Profile 要能起网页')

  const state = await env.state()
  assert.ok((state.launchPresets || []).some((entry) => entry.id === result.data.entry.id), '启动项要真的存进状态')
})

test('会话隔离：Profile 建在与启动项相同的独立目录里', async () => {
  const home = join(env.root, 'iso-home')
  const result = await save({ name: '独立目录', version: 'auto', profile: 'work2', dshHome: home, ensureProfile: true })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(result.data.entry.dshHome, home)
  assert.ok(existsSync(profileManifest(home, 'work2')), 'Profile 要建在新目录里，不能跑到全局目录去')
})

test('不带 ensureProfile 时保持老行为：Profile 不存在就报错，不落盘', async () => {
  const result = await save({ name: '老行为', version: 'auto', profile: 'ghost' })
  assert.equal(result.ok, false, '缺 Profile 的老请求要继续被拒')
  assert.match(String(result.data.error), /profile ghost 不存在/)
  const state = await env.state()
  assert.ok(!(state.launchPresets || []).some((entry) => entry.name === '老行为'), '失败的请求不能留下启动项')
})

test('隔离方式记忆：设置接口存取上次选的档，认不出的值回插件隔离', async () => {
  const saved = await env.call('/api/settings', { launchIsolation: 'home' })
  assert.ok(saved.ok, `保存失败：HTTP ${saved.status} ${JSON.stringify(saved.data)}`)
  assert.equal(saved.data.launchIsolation, 'home')
  assert.equal(env.stored().launchIsolation, 'home', '要真的落到 settings.json')
  assert.equal((await env.getJson('/api/settings')).launchIsolation, 'home', '重新读取还是上次那一档')

  const dirty = await env.call('/api/settings', { launchIsolation: '../../etc' })
  assert.equal(dirty.data.launchIsolation, 'profile', '认不出的值回默认档')
})
