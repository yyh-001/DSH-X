import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_WEB_BIND, lanBindToggleOn, safeWebBind } from '../settings.js'
import { lanBindActive } from '../server.js'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

/** 造一个临时 dsh home，写一份 settings.yaml 进去。 */
function homeWithSettings(text) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-webbind-'))
  writeFileSync(join(home, 'settings.yaml'), text, 'utf8')
  return home
}

test('Web 绑定默认回环：保留原来的安全姿势', () => {
  assert.equal(DEFAULT_WEB_BIND, 'loopback')
  // 和历史文件里的脏值一样，空值/非法值都不放行：默认回环由 DEFAULTS 和
  // resolveWebBind() 兜底，显式填错要让用户知道
  assert.throws(() => safeWebBind(undefined), /Web 绑定只能选/)
  assert.throws(() => safeWebBind(''), /Web 绑定只能选/)
})

test('Web 绑定只认 loopback / lan，顺手收下两种主机写法', () => {
  assert.equal(safeWebBind('loopback'), 'loopback')
  assert.equal(safeWebBind('127.0.0.1'), 'loopback')
  assert.equal(safeWebBind(' LAN '), 'lan')
  assert.equal(safeWebBind('0.0.0.0'), 'lan')
  for (const value of ['all', '0.0.0.0.0', 'localhost', 42, null, {}]) {
    assert.throws(() => safeWebBind(value), /Web 绑定只能选/, JSON.stringify(value))
  }
})

test('远程插件开关：真实形状的 settings.yaml 认 remote-web-ui.lanBind', () => {
  const home = homeWithSettings([
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    'remote-web-ui:',
    '  lanBind: true',
    '  publicBaseUrl: https://example.ts.net',
    'agent-default-model:',
    '  provider: stepfun',
  ].join('\n'))
  assert.equal(lanBindToggleOn(home), true)
})

test('远程插件开关：false / 缺段 / 缺文件都当没开', () => {
  assert.equal(lanBindToggleOn(homeWithSettings('remote-web-ui:\n  lanBind: false\n')), false)
  assert.equal(lanBindToggleOn(homeWithSettings('other-plugin:\n  lanBind: true\n')), false)
  assert.equal(lanBindToggleOn(homeWithSettings('remote-web-ui:\n  tokenTtlMs: 600000\n')), false)
  assert.equal(lanBindToggleOn(join(tmpdir(), 'dsh-webbind-does-not-exist')), false)
})

test('远程插件开关：只看本段的键，别的段里同名键不算', () => {
  const home = homeWithSettings([
    'decoy:',
    '  lanBind: true',
    'remote-web-ui:',
    '  lanBind: false',
    'ui-theme:',
    '  preference: dark',
  ].join('\n'))
  assert.equal(lanBindToggleOn(home), false)
})

test('生效判定：设置或插件开关任一条选局域网就不再注入 --host', () => {
  assert.equal(lanBindActive('loopback', false), false)
  assert.equal(lanBindActive('loopback', true), true)
  assert.equal(lanBindActive('lan', false), true)
  assert.equal(lanBindActive('lan', true), true)
})

test('设置页有 Web 绑定选择框，并会一起提交/回填', () => {
  // 设置项现在统一是 .set-row（标题 + 说明在左、控件在右），不再用旧的 .field
  assert.match(html, /<span class="set-name" data-i18n="Web 绑定">Web 绑定<\/span>[\s\S]{0,900}?<select id="webBind">/, '控件放在高级设置里，复用现有设置项样式')
  assert.match(html, /<option value="loopback"[^>]*>回环（127\.0\.0\.1）<\/option>/)
  assert.match(html, /<option value="lan"[^>]*>局域网（0\.0\.0\.0）<\/option>/)
  // 设置页是「改了就自动保存」：跟着排进 queueSetting，而不是等保存按钮
  assert.match(html, /webBindEl\.onchange = \(\) => queueSetting\('webBind', webBindEl\.value\)/, '改动自动提交')
  assert.match(html, /if \('webBind' in data\) webBindEl\.value = data\.webBind === 'lan' \? 'lan' : 'loopback'/, '读设置时回填')
  assert.match(html, /已保存。Web 绑定更改在下次启动 dsh 时生效。/, '改过要有生效时机提示')
})

test('插件开关压着设置值时，提示行如实说明', () => {
  assert.match(html, /data\.webBindLan\s*$[\s\S]*?远程访问插件的「局域网访问」开关已打开/m, '开关开着时说明当前按局域网处理')
  assert.match(html, /启动器不再固定注入 --host 127\.0\.0\.1/, '回环提示解释局域网选项在做什么')
})

test('内联脚本仍能解析', () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, '页面里应该有一段内联脚本')
  // 只编译不运行：语法坏了这里就炸，运行时的行为靠上面的结构断言看住
  new vm.Script(match[1])
})
