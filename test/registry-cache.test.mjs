import assert from 'node:assert/strict'
import test from 'node:test'
import { createPackumentReader } from '../registry.js'

test('元数据缓存合并并发请求，按源隔离，超过容量淘汰最久未使用的包', async () => {
  let base = 'http://first', calls = []
  const read = createPackumentReader({ limit: 2, registry: () => base, get: async (url) => { calls.push(url); return { url } } })
  const [a, b] = await Promise.all([read('@scope/a'), read('@scope/a')])
  assert.equal(a, b)
  assert.deepEqual(calls, ['http://first/@scope%2fa'])
  await read('b')
  await read('@scope/a')
  await read('c')
  await read('b')
  assert.equal(calls.length, 4)
  base = 'http://second'
  assert.equal((await read('b')).url, 'http://second/b')
})

test('闲置元数据到期后重新获取；旧失败请求不能误删同名新缓存', async () => {
  let calls = 0, fail
  const read = createPackumentReader({ ttl: 15, registry: () => 'http://registry', get: async () => {
    if (++calls === 1) return new Promise((_resolve, reject) => { fail = reject })
    return { calls }
  } })
  const first = read('a')
  const rejected = assert.rejects(first, /offline/)
  await new Promise(resolve => setTimeout(resolve, 30))
  const next = await read('a')
  fail(new Error('offline'))
  await rejected
  assert.equal(await read('a'), next)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await read('a')).calls, 3)
})

test('请求失败允许立即重试', async () => {
  let calls = 0
  const read = createPackumentReader({ registry: () => 'http://registry', get: async () => {
    if (++calls === 1) throw new Error('offline')
    return 'ok'
  } })
  await assert.rejects(read('a'), /offline/)
  assert.equal(await read('a'), 'ok')
})

test('force 绕过短期缓存，立刻拿到刚发布的版本', async () => {
  let calls = 0
  const read = createPackumentReader({ registry: () => 'http://registry', get: async () => ({ calls: ++calls }) })
  assert.equal((await read('a')).calls, 1)
  assert.equal((await read('a')).calls, 1, '默认走缓存')
  assert.equal((await read('a', { force: true })).calls, 2, 'force 要现拉一次')
  assert.equal((await read('a')).calls, 2, 'force 的结果要存回缓存')
})
