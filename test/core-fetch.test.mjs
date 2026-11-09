// shell/core-fetch.mjs 的纯逻辑：版本比较、通道判断、挑和当前 Electron 兼容的核心。

import assert from 'node:assert/strict'
import test from 'node:test'

import { channelOf, compareVersions, fetchCoreMetadata, pickCoreRelease, tarballFor } from '../shell/core-fetch.mjs'

const metadata = {
  'dist-tags': { latest: '0.1.30', rc: '0.1.31-rc.2' },
  versions: {
    '0.1.28': { dist: { tarball: 'https://example.test/0.1.28.tgz', integrity: 'sha512-a' }, dshX: { electron: '44.7.0' } },
    '0.1.29': { dist: { tarball: 'https://example.test/0.1.29.tgz', integrity: 'sha512-b' }, dshX: { electron: '44.7.0' } },
    '0.1.30': { dist: { tarball: 'https://example.test/0.1.30.tgz', integrity: 'sha512-c' }, dshX: { electron: '45.0.0' } },
    '0.1.31-rc.1': { dist: { tarball: 'https://example.test/0.1.31-rc.1.tgz' }, dshX: { electron: '44.7.0' } },
  },
}

test('版本比较：数字段、预发布、rc 序号', () => {
  assert.equal(compareVersions('0.1.29', '0.1.28'), 1)
  assert.equal(compareVersions('0.1.29', '0.1.29'), 0)
  assert.equal(compareVersions('0.1.30-rc.1', '0.1.30'), -1)
  assert.equal(compareVersions('0.1.30', '0.1.30-rc.1'), 1)
  assert.equal(compareVersions('0.1.30-rc.10', '0.1.30-rc.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})

test('通道跟着版本号：正式版 latest，预发布取前缀', () => {
  assert.equal(channelOf('0.1.26'), 'latest')
  assert.equal(channelOf('0.1.26-rc.1'), 'rc')
  assert.equal(channelOf('0.1.26-alpha.3'), 'alpha')
})

test('挑核心：跳过 Electron 对不上的 dist-tag 头部，往下找兼容的', () => {
  const picked = pickCoreRelease(metadata, { electron: '44.7.0', channel: 'latest' })
  assert.equal(picked.version, '0.1.29', '0.1.30 要 Electron 45，正式版外壳应该停在 0.1.29')
  assert.equal(picked.tarball, 'https://example.test/0.1.29.tgz')
  assert.equal(picked.integrity, 'sha512-b')
})

test('挑核心：rc 外壳优先 rc，没有 rc 版本时退回正式版', () => {
  const rc = pickCoreRelease(metadata, { electron: '44.7.0', channel: 'rc' })
  assert.equal(rc.version, '0.1.31-rc.1')
  const { '0.1.31-rc.1': _rc, ...stable } = metadata.versions
  const stableOnly = pickCoreRelease({ versions: stable }, { electron: '44.7.0', channel: 'rc' })
  assert.equal(stableOnly.version, '0.1.29', '没有 rc 版本时用兼容的正式版')
})

test('挑核心：跳过起不来的版本；没有兼容版本时返回 null', () => {
  const picked = pickCoreRelease(metadata, { electron: '44.7.0', channel: 'latest', skip: ['0.1.29'] })
  assert.equal(picked.version, '0.1.28')
  assert.equal(pickCoreRelease(metadata, { electron: '99.0.0', channel: 'latest' }), null)
})

test('挑核心：dist-tag 指回旧版就不装更新的版本，deprecated 的版本跳过', () => {
  const entry = (v) => ({ dist: { tarball: `https://example.test/${v}.tgz` }, dshX: { electron: '44.7.0' } })
  const pulled = {
    'dist-tags': { latest: '0.1.28', rc: '0.1.29-rc.1' },
    versions: { '0.1.28': entry('0.1.28'), '0.1.29': entry('0.1.29'), '0.1.29-rc.1': entry('0.1.29-rc.1'), '0.1.29-rc.2': entry('0.1.29-rc.2') },
  }
  assert.equal(pickCoreRelease(pulled, { electron: '44.7.0', channel: 'latest' }).version, '0.1.28', 'latest 被指回 0.1.28，0.1.29 不该再被首启装上')
  assert.equal(pickCoreRelease(pulled, { electron: '44.7.0', channel: 'rc' }).version, '0.1.29-rc.1', 'rc 按自己的 tag 封顶')
  const deprecated = {
    'dist-tags': { latest: '0.1.29' },
    versions: { '0.1.28': entry('0.1.28'), '0.1.29': { ...entry('0.1.29'), deprecated: 'broken' } },
  }
  assert.equal(pickCoreRelease(deprecated, { electron: '44.7.0', channel: 'latest' }).version, '0.1.28')
})

test('核心包没声明 dshX.electron 时按兼容处理', () => {
  const picked = pickCoreRelease({
    versions: {
      '0.2.0': { dist: { tarball: 'https://example.test/0.2.0.tgz' } },
    },
  }, { electron: '44.7.0', channel: 'latest' })
  assert.equal(picked.version, '0.2.0')
})

test('换源重试用同一个版本拼 tarball 地址（含 scope）', () => {
  assert.equal(
    tarballFor('https://registry.npmjs.org', 'dsh-x-core', '0.1.26-rc.2'),
    'https://registry.npmjs.org/dsh-x-core/-/dsh-x-core-0.1.26-rc.2.tgz',
  )
  assert.equal(
    tarballFor('https://registry.npmmirror.com/', '@scope/pkg', '1.2.3'),
    'https://registry.npmmirror.com/@scope/pkg/-/pkg-1.2.3.tgz',
  )
  assert.equal(tarballFor('', 'dsh-x-core', '1.0.0'), '')
})

test('元数据读取：镜像失败自动落到官方源；指定 registry 时只问一个', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('npmmirror')) throw new Error('offline')
    return { ok: true, json: async () => ({ versions: { '1.0.0': {} } }) }
  }
  const data = await fetchCoreMetadata('dsh-x-core', { fetchImpl })
  assert.deepEqual(data, { versions: { '1.0.0': {} } })
  assert.equal(calls.length, 2)
  assert.match(calls[0], /registry\.npmmirror\.com/)
  assert.match(calls[1], /registry\.npmjs\.org/)

  const single = []
  await fetchCoreMetadata('dsh-x-core', {
    fetchImpl: async (url, init) => {
      single.push({ url, hasSignal: Boolean(init?.signal) })
      return { ok: true, json: async () => ({}) }
    },
    registry: 'https://example.test/',
    timeoutMs: 1_000,
  })
  assert.equal(single.length, 1, '指定 registry 时不再偷偷多问一个源')
  assert.equal(single[0].url, 'https://example.test/dsh-x-core')
  assert.equal(single[0].hasSignal, true, '请求要带超时信号，慢镜像才会尽快失败')
})
