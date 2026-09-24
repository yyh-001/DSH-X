import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { MAC_BUNDLE_ID, appBundle, userAppDir } from '../platform.js'
import { launchAgentPlist } from '../settings.js'

test('每用户目录：Windows 走 %APPDATA%\\DSH，macOS 走 Application Support', () => {
  assert.equal(userAppDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Roaming', 'DSH'))
  assert.equal(userAppDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/DSH')
})

test('每用户目录：macOS 不看 APPDATA（它在 mac 上多半是别的工具随手设的）', () => {
  assert.equal(userAppDir('darwin', { APPDATA: '/tmp/x' }, '/Users/a'), '/Users/a/Library/Application Support/DSH')
})

test('每用户目录：Windows 没有 APPDATA 时返回空串，调用方退回 data/', () => {
  assert.equal(userAppDir('win32', {}, 'C:\\Users\\a'), '')
  assert.equal(userAppDir('linux', {}, '/home/a'), '')
})

test('appBundle：认得 <X>.app/Contents/Resources/app 布局', () => {
  assert.equal(appBundle('/Applications/DSH-X.app/Contents/Resources/app'), '/Applications/DSH-X.app')
})

test('appBundle：源码目录、布局不全都不算包', () => {
  for (const root of [
    '/Users/a/code/DSH-X',
    '/Applications/DSH-X.app/Contents/Resources',
    '/Applications/DSH-X/Contents/Resources/app',
    '/x/Contents/Other/app',
  ]) {
    assert.equal(appBundle(root), '', root)
  }
})

test('LaunchAgent：登录时跑一次、参数逐个成项、特殊字符转义', () => {
  const plist = launchAgentPlist(['/usr/bin/open', '-a', '/Applications/A&B <x>.app'], '/tmp/work')
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${MAC_BUNDLE_ID.replace(/\./g, '\\.')}</string>`))
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  // 用户主动退出后不该被 launchd 再拉起来
  assert.doesNotMatch(plist, /KeepAlive/)
  assert.match(plist, /<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>\s*<string>\/Applications\/A&amp;B &lt;x&gt;\.app<\/string>/)
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/work<\/string>/)
})
