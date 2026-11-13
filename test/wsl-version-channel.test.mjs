import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWslAutoVersion } from '../src/server.js'

const pick = (options) => resolveWslAutoVersion({ requested: 'auto', profile: 'web', ...options })

test('WSL 自动版本：正式版只收正式版，没有正式版时按远端已知版本退到 RC', () => {
  const official = pick({ channel: 'official', installed: ['0.2.0', '0.2.1-rc.1', '0.2.2-alpha.1'] })
  assert.equal(official.version, '0.2.0')
  assert.equal(official.channel, 'official')
  const fallback = pick({ channel: 'official', installed: ['0.2.1-rc.2', '0.2.1-rc.1', '0.2.2-alpha.1'] })
  assert.equal(fallback.version, '0.2.1-rc.2', '没有正式版时退到 RC，而不是 Alpha')
  assert.equal(fallback.channel, 'rc')
})

test('WSL 自动版本：RC 不收 Alpha，Alpha 全收', () => {
  assert.equal(pick({ channel: 'rc', installed: ['0.2.1-rc.3', '0.2.2-alpha.2'] }).version, '0.2.1-rc.3')
  assert.equal(pick({ channel: 'alpha', installed: ['0.2.1-rc.3', '0.2.2-alpha.2'] }).version, '0.2.2-alpha.2')
})

test('WSL 自动版本：同 profile 正在跑的版本优先，其次已装最高版', () => {
  const live = pick({
    channel: 'alpha',
    installed: ['0.2.1', '0.2.2-alpha.1'],
    instances: [{ version: '0.2.1', profile: 'web', status: 'running' }],
  })
  assert.equal(live.version, '0.2.1', '运行中的正式版在 Alpha 通道里也算，优先沿用')
  const otherProfile = pick({
    channel: 'alpha',
    installed: ['0.2.1', '0.2.2-alpha.1'],
    instances: [{ version: '0.2.1', profile: 'bot', status: 'running' }],
  })
  assert.equal(otherProfile.version, '0.2.2-alpha.1', '别的 profile 在跑不影响这个 profile')
})

test('WSL 自动版本：一个都没装时返回空串，通道仍按远端发布列表算出来', () => {
  const result = pick({ channel: 'official', installed: [], check: { versions: ['0.3.0-rc.1'], tags: { next: '0.3.0-rc.1' } } })
  assert.equal(result.version, '')
  assert.equal(result.channel, 'rc')
})
