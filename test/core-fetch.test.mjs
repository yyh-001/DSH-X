// shell/core-fetch.mjs 的纯逻辑：版本比较、通道判断、挑和当前 Electron 兼容的核心。

import assert from 'node:assert/strict'
import test from 'node:test'

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { channelOf, compareVersions, downloadCoreTarball, fetchCoreMetadata, NPM_SIGNING_KEYS, pickCoreRelease, tarballFor, verifyCoreRelease } from '../shell/core-fetch.mjs'

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

test('Electron patch 升级仍精确匹配核心，旧外壳回溯兼容版本而新外壳不误用旧核心', () => {
  // patch 版本也有原生视图行为差异；不能因为同属44.7就跳过核心的运行时声明。
  const release = (electron) => ({ dist: { tarball: `https://example.test/${electron}.tgz` }, dshX: { electron } })
  const versions = { '0.1.28': release('44.7.0'), '0.1.29': release('44.7.1') }
  const metadata = { 'dist-tags': { latest: '0.1.29' }, versions }
  assert.equal(pickCoreRelease(metadata, { electron: '44.7.0' }).version, '0.1.28')
  assert.equal(pickCoreRelease(metadata, { electron: '44.7.1' }).version, '0.1.29')
  assert.equal(pickCoreRelease({ versions: { '0.1.28': versions['0.1.28'] } }, { electron: '44.7.1' }), null)
  assert.equal(pickCoreRelease({ versions: { '0.1.29': versions['0.1.29'] } }, { electron: '44.7.0' }), null)
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

// dsh-x-core@0.2.0 在 npm 上的真实签名（公开数据）：验签逻辑要对得上线上格式，自己造一对密钥测不出这一点。
const SIGNED = {
  version: '0.2.0',
  tarball: 'https://registry.npmmirror.com/dsh-x-core/-/dsh-x-core-0.2.0.tgz',
  integrity: 'sha512-c+S730RjV6Yezq1UBlW+kQws7OG8leb2NAPxUhwFQD3WDVX2yoPpxVJ5Ewhv9MrHf1OK+MXPbnymZWJNswMKUA==',
  signatures: [{
    keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    sig: 'MEYCIQCf+gf8y/t1hLo3yugtuduRT0Dql0QunWXFhfHHtLC00QIhAKfJkcbGXm99wraAwmKsUn+9FlJ7T+nEq5WXU2vFD1NK',
  }],
}

function withoutCustomRegistry(run) {
  const saved = process.env.DSH_CORE_REGISTRY
  delete process.env.DSH_CORE_REGISTRY
  return Promise.resolve().then(run).finally(() => {
    if (saved === undefined) delete process.env.DSH_CORE_REGISTRY
    else process.env.DSH_CORE_REGISTRY = saved
  })
}

test('验签：npm 官方签过的版本通过；换了 integrity、版本、包名或没有签名都拒绝', () => withoutCustomRegistry(async () => {
  const noFetch = async () => { throw new Error('不该联网') }
  await verifyCoreRelease(SIGNED, { name: 'dsh-x-core', fetchImpl: noFetch })
  const forged = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
  await assert.rejects(verifyCoreRelease({ ...SIGNED, integrity: forged }, { name: 'dsh-x-core', fetchImpl: noFetch }), /签名校验/)
  await assert.rejects(verifyCoreRelease({ ...SIGNED, version: '0.2.1' }, { name: 'dsh-x-core', fetchImpl: noFetch }), /签名校验/)
  await assert.rejects(verifyCoreRelease(SIGNED, { name: 'other-core', fetchImpl: noFetch }), /签名校验/)
  await assert.rejects(verifyCoreRelease({ ...SIGNED, signatures: [] }, { name: 'dsh-x-core', fetchImpl: noFetch }), /签名校验/)
  await assert.rejects(verifyCoreRelease({ ...SIGNED, integrity: '' }, { name: 'dsh-x-core', fetchImpl: noFetch }), /sha512/)
}))

test('验签：没见过的 keyid 只去 npm 官方域名取公钥，取回来的也得真能验过', () => withoutCustomRegistry(async () => {
  const asked = []
  const rotated = { ...SIGNED, signatures: [{ ...SIGNED.signatures[0], keyid: 'SHA256:rotated' }] }
  const answer = (key) => async (url) => {
    asked.push(String(url))
    return { ok: true, json: async () => ({ keys: [{ keyid: 'SHA256:rotated', key, expires: null }] }) }
  }
  // 官方回的新公钥就是签这个版本的那把：通过
  await verifyCoreRelease(rotated, { name: 'dsh-x-core', fetchImpl: answer(NPM_SIGNING_KEYS[0].key) })
  assert.deepEqual(asked, ['https://registry.npmjs.org/-/npm/v1/keys'])
  // 公钥对不上、已过期、或者取不到：都拒绝
  const other = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg=='
  await assert.rejects(verifyCoreRelease(rotated, { name: 'dsh-x-core', fetchImpl: answer(other) }), /签名校验/)
  const expired = async () => ({ ok: true, json: async () => ({ keys: [{ keyid: 'SHA256:rotated', key: NPM_SIGNING_KEYS[0].key, expires: '2020-01-01T00:00:00.000Z' }] }) })
  await assert.rejects(verifyCoreRelease(rotated, { name: 'dsh-x-core', fetchImpl: expired }), /签名校验/)
  await assert.rejects(verifyCoreRelease(rotated, { name: 'dsh-x-core', fetchImpl: async () => { throw new Error('offline') } }), /签名校验/)
}))

test('下载：没有 sha512、不是 https 都不发请求；哈希对不上不落盘', () => withoutCustomRegistry(async () => {
  let requests = 0
  const body = Buffer.from('not the real tarball')
  const fetchImpl = async () => {
    requests += 1
    return { ok: true, headers: new Headers(), body: (async function* () { yield body })() }
  }
  const dest = join(mkdtempSync(join(tmpdir(), 'dsh-core-fetch-')), 'core.tgz')
  await assert.rejects(downloadCoreTarball(SIGNED.tarball, dest, { integrity: '', fetchImpl }), /sha512/)
  await assert.rejects(downloadCoreTarball(SIGNED.tarball, dest, { integrity: 'sha1-abc', fetchImpl }), /sha512/)
  await assert.rejects(downloadCoreTarball('http://registry.npmmirror.com/x.tgz', dest, { integrity: SIGNED.integrity, fetchImpl }), /https/)
  assert.equal(requests, 0)
  await assert.rejects(downloadCoreTarball(SIGNED.tarball, dest, { integrity: SIGNED.integrity, fetchImpl }), /校验失败/)
  assert.equal(existsSync(dest), false)
  const good = `sha512-${createHash('sha512').update(body).digest('base64')}`
  assert.equal(await downloadCoreTarball(SIGNED.tarball, dest, { integrity: good, fetchImpl }), body.length)
  rmSync(dirname(dest), { recursive: true, force: true })
}))

test('自己指定 registry（演练 / 自建源）时不强求签名和 https', async () => {
  const saved = process.env.DSH_CORE_REGISTRY
  process.env.DSH_CORE_REGISTRY = 'http://127.0.0.1:8899'
  try {
    await verifyCoreRelease({ version: '9.9.9', integrity: '', signatures: [] }, { name: 'dsh-x-core' })
  } finally {
    if (saved === undefined) delete process.env.DSH_CORE_REGISTRY
    else process.env.DSH_CORE_REGISTRY = saved
  }
})
