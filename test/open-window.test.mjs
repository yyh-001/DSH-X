import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { appWindowArgs, chromiumCandidates, findChromiumBrowser, openRoute } from '../server.js'
import { DEFAULTS, OPEN_MODES, safeOpenMode } from '../settings.js'

// 打开方式（issue #26 的诉求）：默认还是系统浏览器的标签页，想要「更像 App」的用户可以切成
// Chromium 的应用窗口（--app=…，找不到就退回标签页）；想要完全不经过浏览器的用户可以切成
// 启动器内嵌的桌面窗口（原生外壳自己开一个 WebView2 窗口承载 dsh 界面）。

test('打开方式只认内置几项，脏值回标签页，默认是标签页', () => {
  assert.deepEqual(OPEN_MODES, ['tab', 'app', 'window'])
  assert.equal(DEFAULTS.openMode, 'tab')
  assert.equal(safeOpenMode('app'), 'app')
  assert.equal(safeOpenMode('window'), 'window')
  assert.equal(safeOpenMode('tab'), 'tab')
  assert.equal(safeOpenMode('webview'), 'tab', '没实现的形态不能被放行')
  assert.equal(safeOpenMode(''), 'tab')
  assert.equal(safeOpenMode(undefined), 'tab')
})

test('应用窗口的参数就是 --app=<url>', () => {
  assert.deepEqual(appWindowArgs('http://127.0.0.1:59482/?token=x'), ['--app=http://127.0.0.1:59482/?token=x'])
})

test('浏览器候选：Windows 优先用户自己的 Chrome，其次 Edge（自带，兜底最稳）', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  }
  const list = chromiumCandidates(env, 'win32')
  assert.match(list[0], /Chrome[\\/]Application[\\/]chrome\.exe$/)
  assert.ok(list.some((item) => /Edge[\\/]Application[\\/]msedge\.exe$/.test(item)), 'Edge 要在候选里')
  // 便携版 / 指定浏览器：一条 DSH_CHROMIUM 就够
  assert.deepEqual(chromiumCandidates({ DSH_CHROMIUM: 'D:\\chrome\\chrome.exe' }, 'win32'), ['D:\\chrome\\chrome.exe'])
})

test('找不到任何 Chromium 时返回空串（调用方据此退回默认浏览器）', () => {
  const empty = { LOCALAPPDATA: join(tmpdir(), 'no-such-la'), ProgramFiles: join(tmpdir(), 'no-such-pf') }
  assert.equal(findChromiumBrowser(empty, 'win32'), '')
})

test('DSH_CHROMIUM 指到真实文件就被采用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chromium-'))
  const fake = join(dir, 'chrome.exe')
  writeFileSync(fake, '')
  assert.equal(findChromiumBrowser({ DSH_CHROMIUM: fake }, 'win32'), fake)
})

test('桌面窗口模式只在原生外壳托管时成立', () => {
  assert.equal(openRoute('window', true), 'window')
  assert.equal(openRoute('window', false), 'browser', '源码运行（没有外壳）时退回系统浏览器')
  // 另外两种模式跟外壳在不在无关
  assert.equal(openRoute('app', true), 'browser')
  assert.equal(openRoute('app', false), 'browser')
  assert.equal(openRoute('tab', true), 'browser')
  assert.equal(openRoute('tab', false), 'browser')
})

test('设置页在「选了桌面窗口但没有原生外壳」时如实说明会落到标签页', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
  assert.match(html, /openModeEl\.value === 'window' && data\.openModeWindow === false/, '按服务端给的可用性判断')
  assert.match(html, /当前不是由 DSH\.exe 启动的/, '说明会退回浏览器标签页')
  assert.match(html, /打开 dsh 的方式[\s\S]{0,400}?<select id="openMode"><\/select>/, '还是同一个下拉')
})
