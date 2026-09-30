import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarketStatsReader, marketRepository } from '../pack-market.js'

test('市场仓库只接受有效 GitHub 来源', () => {
  assert.deepEqual(marketRepository({ downloadUrl: 'https://github.com/user/pack/releases/download/v1/a.dspack' }), { owner: 'user', repo: 'pack', url: 'https://github.com/user/pack' })
  assert.equal(marketRepository({ downloadUrl: 'https://example.org/user/pack/a' }), null)
  assert.equal(marketRepository({ owner: '../outside', repo: 'pack' }), null)
})

test('仓库统计保留真实零值，共享缓存，过期后更新', async () => {
  let clock = 0, calls = 0
  const read = createMarketStatsReader({ now: () => clock, ttl: 1000, fetchRepo: async (url) => {
    calls += 1
    assert.equal(url, 'https://api.github.com/repos/user/pack')
    return { ok: true, json: async () => ({ stargazers_count: calls === 1 ? 0 : 8, forks_count: 2 }) }
  } })
  const entry = { id: 'one', owner: 'user', repo: 'pack' }
  const values = await Promise.all([read(entry), read({ ...entry, id: 'two' })])
  assert.equal(calls, 1)
  assert.equal(values[0].stars, 0)
  assert.equal(values[1].id, 'two')
  clock = 500
  assert.equal((await read(entry)).stars, 0)
  clock = 1001
  assert.equal((await read(entry)).stars, 8)
  assert.equal(calls, 2)
})

test('统计失败或字段缺失时返回未知，且不影响条目', async () => {
  const failing = createMarketStatsReader({ fetchRepo: async () => { throw new Error('offline') } })
  const entry = { id: 'one', owner: 'user', repo: 'pack' }
  assert.equal((await failing(entry)).stars, null)
  const incomplete = createMarketStatsReader({ fetchRepo: async () => ({ ok: true, json: async () => ({ forks_count: 0 }) }) })
  assert.deepEqual(await incomplete(entry), { id: 'one', stars: null, forks: 0, repoUrl: 'https://github.com/user/pack' })
})
