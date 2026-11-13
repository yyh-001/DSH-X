import assert from 'node:assert/strict'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const env = await startChannelServer({ prefix: 'dsh-window-api-', packument: packumentOf({}, []) })
test.after(() => env.cleanup())
process.env.DSH_APP_WINDOW = '1'
process.env.DSH_INTERNAL_TABS = '1'
const calls = []
const waiting = new URL('/booting', env.origin)
waiting.search = new URLSearchParams({ home: env.home, version: '1.2.3', profile: 'work', name: '工作' })

test('旧外壳保留 URL 协议，显式窗口请求不能假成功', async () => {
  env.server.setHost({ presentInstance: undefined, openWindow: (url) => calls.push(url) })
  await env.call('/api/settings', { openMode: 'window' })
  assert.equal((await env.call('/api/settings')).data.instanceWindows, false)
  const opened = await env.call('/api/open', { url: waiting.href })
  assert.ok(opened.ok)
  assert.equal(calls.pop(), waiting.href)
  const explicit = await env.call('/api/open', { url: waiting.href, presentation: 'window' })
  assert.equal(explicit.status, 400)
  assert.equal(calls.length, 0)
})

test('新协议按稳定身份传递等待页，显式窗口不改变打开设置', async () => {
  env.server.setHost({ presentInstance: (target, options) => calls.push({ target, options }) })
  await env.call('/api/settings', { openMode: 'internal' })
  assert.equal((await env.call('/api/settings')).data.instanceWindows, true)
  assert.ok((await env.call('/api/open', { url: waiting.href })).ok)
  const normal = calls.pop()
  assert.deepEqual(JSON.parse(normal.target.id), [env.home, '1.2.3', 'work'])
  assert.deepEqual(normal.options, { presentation: 'internal', explicit: true })
  assert.equal(normal.target.status, 'starting')
  assert.ok((await env.call('/api/open', { url: waiting.href, presentation: 'window' })).ok)
  assert.deepEqual(calls.pop().options, { presentation: 'window', explicit: true })
  assert.ok((await env.call('/api/open', { url: waiting.href })).ok)
  assert.deepEqual(calls.pop().options, { presentation: 'internal', explicit: true }, '临时开窗后普通打开必须允许迁回当前默认宿主')
  assert.equal((await env.call('/api/settings')).data.openMode, 'internal')
})

test('WSL 等待页身份不随 auto 变更；其他服务的同名路径不算等待页', async () => {
  const wsl = new URL(waiting)
  wsl.searchParams.set('home', 'wsl://Fedora/~%2F.dsh')
  wsl.searchParams.set('version', 'auto')
  assert.ok((await env.call('/api/open', { url: wsl.href, presentation: 'window' })).ok)
  assert.deepEqual(JSON.parse(calls.pop().target.id), ['wsl://Fedora/~%2F.dsh', '', 'work'])
  for (const body of [
    { url: 'http://127.0.0.1:1/booting?home=x&version=1&profile=web', presentation: 'window' },
    { url: waiting.href, presentation: 'invalid' },
    { url: `${env.origin}/booting`, presentation: 'window' },
  ]) assert.equal((await env.call('/api/open', body)).status, 400)
  assert.equal(calls.length, 0)
})

test('运行页面按核心实例认领，使用最新认证地址，版本和目录分别区分', () => {
  const proc = { home: env.home, version: '1.2.3', profile: 'work', status: 'running', url: 'http://127.0.0.1:12345/?token=fake-current' }
  const get = (instance) => env.server.instanceTargetFromUrl('http://127.0.0.1:12345/session/1', env.origin, [instance], () => '工作')
  const target = get(proc)
  assert.equal(target.url, proc.url)
  assert.equal(target.title, '工作')
  assert.notEqual(get({ ...proc, version: '2.0.0' }).id, target.id)
  assert.notEqual(get({ ...proc, home: env.home + '-other' }).id, target.id)
  assert.equal(env.server.instanceTargetFromUrl('http://127.0.0.1:12346/', env.origin, [proc]), null)
})
