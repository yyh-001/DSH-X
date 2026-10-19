import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_ID, packumentOf, startChannelServer } from './update-channel-fixture.mjs'

test('版本检测：真服务验证缓存、通道口径、GitHub 隔离与静默失败', { timeout: 30000 }, async (t) => {
  const originalFetch = globalThis.fetch
  let githubCalls = 0, releaseGithub, blockGithub = true
  // 只替换外网边界：registry 和管理接口仍然真的走 HTTP。GitHub 可以无限慢，
  // 用未完成请求证明 dsh 响应独立，不依赖机器快慢或人为等几秒的时间断言。
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === '127.0.0.1') return originalFetch(input, init)
    githubCalls++
    if (blockGithub) await new Promise(resolve => { releaseGithub = resolve })
    return new Response(JSON.stringify({ tag_name: 'v99.0.0' }), { headers: { 'content-type': 'application/json' } })
  })
  let env
  t.after(async () => {
    blockGithub = false
    releaseGithub?.()
    await env?.cleanup()
    t.mock.restoreAll()
  })
  env = await startChannelServer({
    prefix: 'dsh-version-check-', installed: ['1.0.0', '1.2.3', '2.0.0-alpha.1'],
    packument: packumentOf({ latest: '1.2.3', alpha: '2.0.0-alpha.2' }, ['1.0.0', '1.2.3', '1.3.0', '2.0.0-alpha.2']),
  })
  const logs = async () => String((await env.call('/api/logs/export')).data)
  const checkLogs = async () => (await logs()).split('\n').filter(line => /检测版本失败|检测到新版本|版本检测：|\[更新\]/.test(line))

  await t.test('静默检测不请求 GitHub，最高已装版本按通道排序，与启动提醒一致', async () => {
    const before = await checkLogs()
    const data = await env.getJson('/api/versions/check')
    assert.equal(data.current, '1.2.3', '配置第一个版本和其他通道的更高版本都不能挡住正式版更新')
    assert.equal(data.latest, '2.0.0-alpha.2', '安装列表仍返回全部版本中的最高版本')
    assert.equal(data.updateLatest, '1.3.0')
    assert.equal(data.channel, 'official')
    assert.equal(data.update, true)
    assert.equal(githubCalls, 0)
    assert.deepEqual(await checkLogs(), before)
    // pending 本身仍会检查启动器，先把它的独立检查放行。
    blockGithub = false
    const pending = await env.pendingDsh()
    assert.equal(pending.current, data.current)
    assert.equal(pending.latest, data.updateLatest)
    blockGithub = true
  })

  await t.test('GitHub 请求尚未完成时仍可读缓存和强制刷新 dsh', async () => {
    const selfRequest = env.getJson('/api/self?refresh=1')
    while (!releaseGithub) await new Promise(resolve => setImmediate(resolve))
    const count = env.requests.length, calls = githubCalls, before = await checkLogs()
    const cached = await env.getJson('/api/versions/check')
    assert.equal(cached.updateLatest, '1.3.0')
    assert.equal(env.requests.length, count, '普通检测命中远端列表缓存')
    const response = await fetch(env.origin + '/api/versions/check?refresh=1', { signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).current, '1.2.3')
    assert.equal(env.requests.length, count + 1, '强制检测同时绕过 registry 元数据缓存')
    assert.equal(githubCalls, calls, 'DSH 检测不能重复发起 GitHub 请求')
    assert.equal((await checkLogs()).length, before.length + 1, '只记录主动检测')
    blockGithub = false
    releaseGithub()
    const self = await selfRequest
    assert.equal(self.latest, '99.0.0')
    const selfCalls = githubCalls
    assert.equal((await env.getJson('/api/self')).latest, '99.0.0')
    assert.equal(githubCalls, selfCalls, '启动器普通检查复用缓存')
    await env.getJson('/api/self?refresh=1')
    assert.equal(githubCalls, selfCalls + 1, '启动器也能单独强制刷新')
  })

  await t.test('切换所跟通道后检测提示也随之改变', async () => {
    const entry = (await env.state()).launchPresets.find(item => item.id === BUILTIN_ID)
    const saved = await env.call('/api/launch-presets', { ...entry, updateChannel: 'alpha' })
    assert.ok(saved.ok, JSON.stringify(saved.data))
    const data = await env.getJson('/api/versions/check')
    assert.equal(data.channel, 'alpha')
    assert.equal(data.current, '2.0.0-alpha.1')
    assert.equal(data.updateLatest, '2.0.0-alpha.2')
    assert.equal((await env.pendingDsh()).latest, data.updateLatest)
  })

  await t.test('registry 失败返回错误，静默调用不追加日志，主动调用给出网络提示', async () => {
    await env.republish(null, { online: false })
    const before = await checkLogs(), calls = githubCalls
    const quiet = await env.call('/api/versions/check')
    assert.equal(quiet.status, 500)
    assert.match(quiet.data.error, /检查网络或下载源/)
    assert.deepEqual(await checkLogs(), before)
    const manual = await env.call('/api/versions/check?refresh=1')
    assert.equal(manual.status, 500)
    assert.match(manual.data.error, /检查网络或下载源/)
    assert.equal((await checkLogs()).length, before.length + 1)
    assert.equal(githubCalls, calls)
  })
})
