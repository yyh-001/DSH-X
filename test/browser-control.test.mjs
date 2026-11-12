/**
 * 内置浏览器（设置 → 常规 → 浏览器）的两端约定：核心只负责放开官方侧栏浏览器那一行，
 * 外壳负责证书策略和真正的数据清理。
 *
 * 外壳依赖 Electron（node --test 里加载不了），这里按仓库惯例做结构检查；
 * 证书开关本身的读写语义在 test/system-prefs.test.mjs 与 test/shell-prefs.test.mjs 里。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const server = read('src/server.js')
const main = read('shell/main.mjs')
const guests = read('shell/browser-guests.mjs')

test('启动补丁只放开侧栏 Browser：不碰插件行，desktop profile 不写补丁', () => {
  assert.match(server, /- id: ui-sidebar-browser\\n  disabled: false\\n/, 'ui-sidebar-browser 始终放开')
  assert.doesNotMatch(server, /AGENT_BROWSER_PLUGIN/, 'agent 插件不再由补丁停用')
  assert.match(server, /if \(String\(profile \?\? ''\)\.toLowerCase\(\) === 'desktop'\) return \[\]/, 'desktop profile 不用补丁')
  assert.doesNotMatch(server, /BROWSER_CONTROL/, '浏览器总开关已撤')
})

test('设置接口回显证书开关和外壳能力字段', () => {
  assert.match(server, /browserIgnoreCertificate: stored\.browserIgnoreCertificate === true/)
  assert.match(server, /browserHost: capabilities\(\)\.browser/, '页面据它决定清理按钮能不能点')
  assert.match(server, /\('browserIgnoreCertificate' in body \? \{ browserIgnoreCertificate: body\.browserIgnoreCertificate === true \}/)
})

test('清理路由只转发给外壳：没有 host.browser 时 503，不让浏览器模式假装成功', () => {
  assert.match(
    server,
    /url\.pathname === '\/api\/browser\/clear-cache' \|\| url\.pathname === '\/api\/browser\/clear-data'/,
    '两条 POST 路由',
  )
  assert.match(server, /if \(!host\.browser\) \{[\s\S]{0,220}?send\(res, 503/, '没有外壳能力返回 503')
  assert.match(server, /const action = url\.pathname\.endsWith\('\/clear-cache'\) \? 'clearCache' : 'clearAll'/, '按路径分派')
})

test('外壳：证书策略在分区创建时套一次、清理只扫内置浏览器分区', () => {
  assert.doesNotMatch(main, /disabled by settings/, '侧栏 Browser 不因开关被拦')
  assert.doesNotMatch(main, /syncCertificatePolicy/, '证书策略不跟外壳轮询：改设置后重启启动器生效')
  assert.match(main, /ignoreCertificateErrors: \(\) => prefs\.browserIgnoreCertificate === true/, '证书策略读设置')
  assert.match(main, /entry\.name\.startsWith\('dsh-sidebar-browser-'\)/, '磁盘上以前跑过的分区也算')
  assert.match(main, /clearStorageData\(\{ storages: \['cachestorage', 'serviceworkers'\] \}\)/, '清缓存保留 Cookie 和站点数据')
  assert.match(main, /browser: \{[\s\S]{0,160}?clearCache: \(\) => clearBrowserData\('cache'\)[\s\S]{0,120}?clearAll: \(\) => clearBrowserData\('all'\)/)
})

test('证书策略：开着全放过（0），关着交回 Chromium 默认（-3）', () => {
  assert.match(guests, /if \(this\.ignoreCertificateErrors\(\)\) browserSession\.setCertificateVerifyProc\(\(_request, callback\) => callback\(0\)\)/)
  assert.match(guests, /else browserSession\.setCertificateVerifyProc\(\(_request, callback\) => callback\(-3\)\)/)
})
