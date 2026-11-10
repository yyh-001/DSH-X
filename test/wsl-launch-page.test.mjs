import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const at = (needle) => {
  const index = page.indexOf(needle)
  assert.ok(index >= 0, `页面里找不到 ${needle}`)
  return index
}

test('启动项只有一套表单：WSL 作为「目录」出现在三级选择窗里，不再有单独的 WSL 选项', () => {
  assert.doesNotMatch(page, /id="launchBackendTabs"/)
  assert.doesNotMatch(page, /id="launchWslEnvPick"/)
  assert.doesNotMatch(page, /id="wslPickDialog"/)
  assert.match(page, /id="launchWslDistro" hidden/)
  assert.match(page, /id="launchWslProfile" hidden/)
  assert.match(page, /id="launchWslHome" type="hidden"/)
  assert.match(page, /id="launchWslWorkdirField" hidden/)
  assert.match(page, /function parseWslHomeKey\(/)
  assert.match(page, /pickerMode === 'form' && state\.wsl\?\.available !== false/)
  assert.match(page, /name: t\('WSL · \{distro\}'/, '左栏把 WSL 发行版当目录行')
  assert.match(page, /async function selectPickerHome\(home\)[\s\S]{0,400}?const wsl = parseWslHomeKey\(home\)/, '选中 WSL 目录走 /api/wsl 探测')
  assert.match(page, /function applyWslPickerToLaunchForm\(\{ distro, home \}, profile\)/)
  assert.match(page, /if \(wsl\) applyWslPickerToLaunchForm\(wsl, pickerProfile\)/)
})

test('新增目录弹窗可以选 WSL：发行版 + 用户目录，添加后选中那个 WSL 目录', () => {
  assert.match(page, /id="pickHomeAddDialog"/)
  assert.match(page, /id="pickHomeAddLocal"[^>]*data-i18n="本机目录…"/)
  assert.match(page, /id="pickHomeAddWsl"[^>]*data-i18n="WSL 目录…"/)
  assert.match(page, /id="pickHomeWslDistro"/)
  assert.match(page, /id="pickHomeWslHome"/)
  assert.match(page, /function confirmPickHomeAdd\(\)[\s\S]{0,600}?pickerHome = wslHomeKeyOf\(distro, home\)/)
  assert.match(page, /profilePickHomeAddEl\.onclick = \(\) => void openPickHomeAddDialog\(\)/)
})

test('WSL 字段和本机版本互斥：选 WSL 目录时藏掉版本组、露出项目目录', () => {
  assert.match(page, /launchLocalVersionGroupEl\.hidden = wsl/, '本机版本整组隐藏')
  assert.match(page, /launchWslWorkdirFieldEl\.hidden = !wsl/)
  assert.match(page, /launchWslLocationFieldsEl\.hidden = !wsl/)
  assert.match(page, /if \(launchBackendIsWsl\(\)\) setLaunchBackend\('local'\)/, '选择本机目录时切回本机')
  assert.match(page, /launch-tag launch-tag-wsl/, '启动项卡片上有 WSL 标签')
  assert.match(page, /post\('\/api\/wsl\/path'/, '目录选择要走 wslpath 转换接口')
})

test('常规设置里不再重复 WSL 默认值：发行版 / 用户目录都在启动项里选', () => {
  assert.doesNotMatch(page, /id="wslDefaultDistro"/)
  assert.doesNotMatch(page, /id="wslDefaultHome"/)
  assert.doesNotMatch(page, /id="wslDshCommand"/)
  assert.match(page, /WSL 的默认值不再单独占一块设置/)
})

test('WSL 发行版列表按需拉：切到 WSL 才请求 /api/wsl，不等状态推送', () => {
  // /api/state 推送里不再带发行版列表（每次探测要 spawn wsl.exe），页面自己按需取。
  const ensure = page.indexOf('async function ensureWslInfo')
  assert.ok(ensure >= 0, '页面里要有 ensureWslInfo')
  assert.match(page.slice(ensure, ensure + 1200), /getJson\('\/api\/wsl'\)/)
  const backend = page.indexOf('function setLaunchBackend')
  const body = page.slice(backend, backend + 3600)
  assert.match(body, /await ensureWslInfo\(\)/, '切到 WSL / 打开 WSL 启动项时要按需拉列表')
  assert.doesNotMatch(page, /wslInfoLoaded/, '发行版列表不做跨会话缓存，靠服务端 10 秒缓存控成本')
  assert.match(body, /state\.wsl\?\.error \|\| t\('没有检测到 WSL 发行版。'\)/, '一个发行版都没有时要说清楚，而不是「先选择一个」')
})
