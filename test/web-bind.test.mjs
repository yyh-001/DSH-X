import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { DEFAULT_WEB_BIND, safeWebBind } from '../src/settings.js'
import { lanBindActive } from '../src/server.js'

const html = readFileSync(fileURLToPath(new URL('../src/public/index.html', import.meta.url)), 'utf8')
const server = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')

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

/** 从 server.js 抠出 bootArgs，在沙箱里配上依赖跑（它没有导出，和其他用例同一套做法）。 */
function bootArgsWith({ webBind = 'loopback', extra = [], web = true } = {}) {
  const begin = server.indexOf('function bootArgs(')
  const context = vm.createContext({
    PROFILE_NAME: 'web',
    WEB_BIND: webBind,
    EXTRA_ARGS: extra,
    bootsWebApp: () => web,
    sidebarBrowserPatchArgs: () => ['--patch', 'overlay.yml'],
  })
  vm.runInContext(`${server.slice(begin, server.indexOf('\n}', begin) + 2)}\nthis.run = bootArgs`, context)
  return (...args) => [...context.run(...args)]
}

test('bootArgs：回环和局域网都钉死 --host 127.0.0.1（dsh 不再接受 0.0.0.0）', () => {
  for (const webBind of ['loopback', 'lan']) {
    const args = bootArgsWith({ webBind })
    assert.deepEqual(args('web', 0), ['web', '--patch', 'overlay.yml', '--host', '127.0.0.1', '--port', '0', '--no-open'], `${webBind} 首次由系统挑端口`)
    assert.deepEqual(args('web', 3080), ['web', '--patch', 'overlay.yml', '--host', '127.0.0.1', '--port', '3080', '--no-open'], `${webBind} 固定端口`)
  }
})

test('bootArgs：额外参数排最后，不起 web 的 profile 不注入任何 flag', () => {
  assert.deepEqual(bootArgsWith({ extra: ['--port', '4000'] })('web', 0).slice(-3), ['--no-open', '--port', '4000'])
  assert.deepEqual(bootArgsWith({ webBind: 'lan', web: false, extra: ['--x'] })('headless', 3080), ['headless', '--x'])
})

test('生效判定只看设置：远程访问插件的开关不再左右启动器', () => {
  assert.equal(lanBindActive('loopback'), false)
  assert.equal(lanBindActive('lan'), true)
  assert.doesNotMatch(server, /lanBindToggleOn|LAN_TOGGLE|webBindLan/, '旧的插件开关联动已撤')
  assert.doesNotMatch(server, /由配置层决定/, '启动日志不再说「交给配置层」')
})

test('局域网模式也记自动端口：端口不变，复制出去的局域网链接才不变', () => {
  const begin = server.indexOf('function remembersAutoPort(')
  assert.doesNotMatch(server.slice(begin, server.indexOf('\n}', begin)), /lanBindActive/)
})

test('设置页有 Web 绑定选择框，并会一起提交/回填', () => {
  // 设置项现在统一是 .set-row（标题 + 说明在左、控件在右），不再用旧的 .field
  assert.match(html, /<span class="set-name" data-i18n="Web 绑定">Web 绑定<\/span>[\s\S]{0,900}?<select id="webBind">/, '控件放在高级设置里，复用现有设置项样式')
  assert.match(html, /<option value="loopback"[^>]*>回环（127\.0\.0\.1）<\/option>/)
  assert.match(html, /<option value="lan"[^>]*>局域网（本机局域网 IP）<\/option>/)
  // 设置页是「改了就自动保存」：跟着排进 queueSetting，而不是等保存按钮
  assert.match(html, /webBindEl\.onchange = \(\) => queueSetting\('webBind', webBindEl\.value\)/, '改动自动提交')
  assert.match(html, /if \('webBind' in data\) webBindEl\.value = data\.webBind === 'lan' \? 'lan' : 'loopback'/, '读设置时回填')
  assert.match(html, /已保存。Web 绑定更改在下次启动 dsh 时生效。/, '改过要有生效时机提示')
})

test('提示行说明本机与其他设备各用什么地址', () => {
  assert.match(html, /webBindHintEl\.textContent = t\('本机仍用 127\.0\.0\.1 访问；其他设备用复制的局域网链接。换网络后需重启实例。'\)/)
  assert.doesNotMatch(html, /局域网访问还需在 dsh 中开启远程访问|0\.0\.0\.0）/, '旧文案已撤')
})

test('访问链接：显示和复制用局域网地址，点击仍在本机按回环打开', () => {
  assert.match(html, /class="launch-link-value" href="\$\{escapeHtml\(live\.url\)\}" data-copy-url="\$\{escapeHtml\(live\.lanUrl \|\| live\.url\)\}"/)
  assert.match(html, /querySelector\('\.launch-link-value'\)\.dataset\.copyUrl/, '复制取 data-copy-url')
  assert.match(html, /link\.onclick = \(event\) => \{ event\.preventDefault\(\); void openInstance\(link\.getAttribute\('href'\)\) \}/, '点击仍用 href（回环）')
})

test('内联脚本仍能解析', () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, '页面里应该有一段内联脚本')
  // 只编译不运行：语法坏了这里就炸，运行时的行为靠上面的结构断言看住
  new vm.Script(match[1])
})
