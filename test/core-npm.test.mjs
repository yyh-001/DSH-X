import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CORE_PACKAGE, coreDistTag, coreMetadataUrl, extractCoreTarball, resolveCoreRelease, stagingStats, tarCommand } from '../src/core-npm.js'
import { VERSION_CHANNEL } from '../src/version.js'
import { pickCoreRelease } from '../shell/core-fetch.mjs'

const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-core-npm-'))

test('npm 元数据：按通道取 dist-tag，取不到退回 latest', () => {
  const release = (version, extra = {}) => ({ version, dist: { tarball: `https://example.com/${version}.tgz`, integrity: `sha512-${version}`, shasum: 'abc', unpackedSize: 123 }, dshX: { electron: '44.7.0' }, ...extra })
  const metadata = {
    'dist-tags': { latest: '0.1.20', rc: '0.1.21-rc.1', alpha: '0.1.22-alpha.1' },
    versions: {
      '0.1.20': release('0.1.20'),
      '0.1.21-rc.1': release('0.1.21-rc.1'),
      '0.1.22-alpha.1': release('0.1.22-alpha.1'),
    },
  }
  assert.equal(coreDistTag(VERSION_CHANNEL.OFFICIAL), 'latest')
  assert.equal(coreDistTag(VERSION_CHANNEL.RC), 'rc')
  assert.equal(coreDistTag(VERSION_CHANNEL.ALPHA), 'alpha')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.OFFICIAL).version, '0.1.20')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC).version, '0.1.21-rc.1')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.ALPHA).version, '0.1.22-alpha.1')
  const alpha = resolveCoreRelease(metadata, VERSION_CHANNEL.ALPHA)
  assert.equal(alpha.electron, '44.7.0')
  assert.equal(alpha.tarball, 'https://example.com/0.1.22-alpha.1.tgz')
  assert.equal(resolveCoreRelease({ 'dist-tags': { next: '1.0.0' }, versions: {} }, VERSION_CHANNEL.RC), null)
  assert.equal(resolveCoreRelease({ 'dist-tags': { latest: '1.0.0' }, versions: {} }, VERSION_CHANNEL.OFFICIAL), null)
})

test('rc 通道同时看 rc 与 latest：rc tag 停在旧版时取更新的正式版，和首启 pickCoreRelease 一致', () => {
  const entry = (version, electron = '44.7.0') => ({ version, dist: { tarball: `https://example.com/${version}.tgz` }, dshX: { electron } })
  const metadata = {
    'dist-tags': { latest: '0.1.27', rc: '0.1.26-rc.6' },
    versions: { '0.1.26-rc.6': entry('0.1.26-rc.6'), '0.1.26': entry('0.1.26'), '0.1.27': entry('0.1.27') },
  }
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC).version, '0.1.27')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.ALPHA).version, '0.1.27', 'alpha 通道也收 rc / latest')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC, { current: '0.1.26-rc.6', electron: '44.7.0' }).version, '0.1.27')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC, { current: '0.1.27' }), null, '已经是最新就没有更新')
  for (const channel of [VERSION_CHANNEL.OFFICIAL, VERSION_CHANNEL.RC, VERSION_CHANNEL.ALPHA]) {
    const shellChannel = channel === VERSION_CHANNEL.OFFICIAL ? 'latest' : channel
    assert.equal(resolveCoreRelease(metadata, channel, { electron: '44.7.0' }).version, pickCoreRelease(metadata, { electron: '44.7.0', channel: shellChannel }).version, channel)
  }
  // rc 比 latest 新时仍按 rc 走
  const fresh = { ...metadata, 'dist-tags': { latest: '0.1.27', rc: '0.1.28-rc.1' }, versions: { ...metadata.versions, '0.1.28-rc.1': entry('0.1.28-rc.1') } }
  assert.equal(resolveCoreRelease(fresh, VERSION_CHANNEL.RC).version, '0.1.28-rc.1')
  assert.equal(resolveCoreRelease(fresh, VERSION_CHANNEL.OFFICIAL).version, '0.1.27', '正式版通道不收 rc')
})

test('查更新优先 Electron 兼容的 tag；只剩不兼容的更新时照样返回，由调用方提示更新外壳', () => {
  const entry = (version, electron) => ({ dist: { tarball: `https://example.com/${version}.tgz` }, dshX: { electron } })
  const metadata = {
    'dist-tags': { latest: '0.1.27', rc: '0.1.28-rc.1' },
    versions: { '0.1.26': entry('0.1.26', '44.7.0'), '0.1.27': entry('0.1.27', '44.7.0'), '0.1.28-rc.1': entry('0.1.28-rc.1', '45.0.0') },
  }
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC, { current: '0.1.26', electron: '44.7.0' }).version, '0.1.27', '跳过要新 Electron 的 rc，先给兼容的正式版')
  const blocked = resolveCoreRelease(metadata, VERSION_CHANNEL.RC, { current: '0.1.27', electron: '44.7.0' })
  assert.equal(blocked.version, '0.1.28-rc.1')
  assert.equal(blocked.electron, '45.0.0', '调用方按它报 reason: electron')
  assert.equal(resolveCoreRelease(metadata, VERSION_CHANNEL.RC, { current: '0.1.26' }).version, '0.1.28-rc.1', '不传 Electron 就不过滤')
  // deprecated 的 tag 头部跳过（和首启一致），不会因为它比别的新就被推给用户
  const pulled = { ...metadata, versions: { ...metadata.versions, '0.1.28-rc.1': { ...metadata.versions['0.1.28-rc.1'], deprecated: 'broken' } } }
  assert.equal(resolveCoreRelease(pulled, VERSION_CHANNEL.RC, { current: '0.1.27', electron: '44.7.0' }), null)
})

test('npm 包名：核心包跨平台，scoped 包要编码斜杠', () => {
  assert.equal(CORE_PACKAGE, 'dsh-x-core', 'Windows 和 mac 共用同一个核心包')
  assert.equal(coreMetadataUrl('https://registry.npmjs.org/', 'dsh-x-core'), 'https://registry.npmjs.org/dsh-x-core')
  assert.equal(coreMetadataUrl('https://registry.npmjs.org', '@scope/dsh-x-core'), 'https://registry.npmjs.org/@scope%2Fdsh-x-core')
})

test('解压 npm tarball：剥掉 package/ 前缀，校验 server.js 和 package.json', { skip: spawnSync(tarCommand(), ['--version']).error ? '没有 tar' : false }, () => {
  const root = tempRoot()
  try {
    const source = join(root, 'package')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'server.js'), 'console.log(1)\n')
    writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    const tarball = join(root, 'core.tgz')
    const packed = spawnSync(tarCommand(), ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const dest = join(root, 'out')
    const pkg = extractCoreTarball(tarball, dest)
    assert.equal(pkg.version, '9.9.9')
    assert.equal(stagingStats(dest).files, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
