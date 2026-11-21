/**
 * mac / deb 外壳不能自更新：核心按发布页的安装包提醒换包。
 * 安装包名是真实发布页上的两代命名（0.1.26 及以前 / 0.1.27-rc 起）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { manualShellAssetMatcher, pickManualShellRelease, shellVersionOfAsset } from '../src/shell-release.js'

const asset = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` })
const RELEASES = [
  { tag_name: 'v0.1.27-rc.6', prerelease: true, html_url: 'rc6', assets: [] },
  { tag_name: 'v0.1.27-rc.5', prerelease: true, html_url: 'rc5', assets: ['DSH-X-0.1.27-rc.5-linux-arm64.deb', 'DSH-X-0.1.27-rc.5-linux-x64.deb', 'DSH-X-0.1.27-rc.5-mac-arm64.dmg', 'DSH-X-0.1.27-rc.5-mac-x64.dmg'].map(asset) },
  { tag_name: 'v0.1.26', prerelease: false, html_url: '0126', assets: ['DSH-X-0.1.26-amd64.deb', 'DSH-X-0.1.26-arm64.deb', 'DSH-X-0.1.26-arm64.dmg', 'DSH-X-0.1.26-x64.dmg'].map(asset) },
  { tag_name: 'v0.1.25', prerelease: false, html_url: '0125', assets: ['DSH-X-0.1.24-amd64.deb', 'DSH-X-0.1.24-arm64.dmg'].map(asset) },
  { tag_name: 'v0.1.28', prerelease: false, draft: true, html_url: 'draft', assets: ['DSH-X-0.1.28-mac-arm64.dmg'].map(asset) },
]

test('安装包名里读外壳版本：新旧两代命名都认', () => {
  assert.equal(shellVersionOfAsset('DSH-X-0.1.27-rc.5-mac-arm64.dmg'), '0.1.27-rc.5')
  assert.equal(shellVersionOfAsset('DSH-X-0.1.27-rc.5-linux-x64.deb'), '0.1.27-rc.5')
  assert.equal(shellVersionOfAsset('DSH-X-0.1.26-arm64.dmg'), '0.1.26')
  assert.equal(shellVersionOfAsset('DSH-X-0.1.26-amd64.deb'), '0.1.26')
  assert.equal(shellVersionOfAsset('weird.dmg', 'v0.1.9'), '0.1.9')
})

test('rc 通道的 arm64 mac 从 0.1.22 外壳拿到最新带 dmg 的预发布（跳过没有安装包的纯核心发版）', () => {
  const found = pickManualShellRelease(RELEASES, { current: '0.1.22', allowPrerelease: true, match: manualShellAssetMatcher('darwin', 'arm64') })
  assert.deepEqual(found, { latest: '0.1.27-rc.5', url: 'rc5', asset: 'https://example.invalid/DSH-X-0.1.27-rc.5-mac-arm64.dmg' })
})

test('正式版通道只看正式版；草稿不算；外壳 0.1.24 的旧包名照样比得出来', () => {
  const found = pickManualShellRelease(RELEASES, { current: '0.1.22', allowPrerelease: false, match: manualShellAssetMatcher('darwin', 'x64') })
  assert.equal(found.latest, '0.1.26')
  assert.equal(found.asset, 'https://example.invalid/DSH-X-0.1.26-x64.dmg')
})

test('deb：x64 认 linux-x64 和旧的 amd64；已是最新就不提醒', () => {
  const match = manualShellAssetMatcher('linux', 'x64')
  assert.equal(pickManualShellRelease(RELEASES, { current: '0.1.20', allowPrerelease: true, match }).asset, 'https://example.invalid/DSH-X-0.1.27-rc.5-linux-x64.deb')
  assert.equal(pickManualShellRelease(RELEASES, { current: '0.1.27-rc.5', allowPrerelease: true, match }), null)
  assert.equal(pickManualShellRelease(RELEASES, { current: '0.1.26', allowPrerelease: false, match }), null)
})

test('能自更新的平台（Windows）不走这条', () => {
  assert.equal(manualShellAssetMatcher('win32', 'x64'), null)
  assert.equal(pickManualShellRelease(RELEASES, { current: '0.1.0', allowPrerelease: true, match: null }), null)
})
