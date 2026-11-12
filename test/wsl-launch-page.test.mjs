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
  assert.match(page, /async function selectPickerHome\(home\)[\s\S]{0,900}?const wsl = parseWslHomeKey\(home\)/, '选中 WSL 目录走 /api/wsl 探测')
  assert.match(page, /function applyWslPickerToLaunchForm\(\{ distro, home \}, profile\)/)
  assert.match(page, /if \(wsl\) applyWslPickerToLaunchForm\(wsl, pickerProfile\)/)
})

test('新增目录弹窗用两个页签区分本机 / WSL，WSL 页签填发行版 + 用户目录', () => {
  assert.match(page, /id="pickHomeAddDialog"/)
  assert.match(page, /id="pickHomeTabs"[^>]*data-active="local"/, '本机 / WSL 做成页签，默认本机')
  assert.match(page, /data-pick-home-kind="local"[^>]*data-i18n="本机目录"/)
  assert.match(page, /data-pick-home-kind="wsl"[^>]*data-i18n="WSL 目录"/)
  assert.match(page, /function paintPickHomeKind\(kind\)/, '页签切换只切字段，不再用两个大按钮')
  assert.match(page, /id="pickHomeLocalPath"/, '本机页签有目录路径输入框')
  assert.match(page, /id="pickHomeLocalBrowse"/, '浏览按钮只回填路径，不直接登记')
  assert.match(page, /pickHomeKind === 'local'[\s\S]{0,500}?registerPickerHome\(path\)/, '本机页签点「添加」登记输入的路径')
  assert.match(page, /id="pickHomeWslDistro"/)
  assert.match(page, /id="pickHomeWslHome"/)
  assert.match(page, /function confirmPickHomeAdd\(\)[\s\S]{0,1400}?pickerHome = wslHomeKeyOf\(distro, home\)/)
  assert.match(page, /profilePickHomeAddEl\.onclick = \(\) => void openPickHomeAddDialog\(\)/)
  assert.match(css, /\.pick-home-tabs::after \{[^}]*transition: transform 240ms/, '选中块滑动')
  assert.match(css, /html\.reduce-motion \.pick-home-tabs::after \{ transition: none; \}/, '减动效时关掉滑动')
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

test('WSL Profile 可以直接删除：请求走 /api/wsl/profile/remove，不再只留一个灰按钮', () => {
  assert.match(page, /const canRemove = !pickerBusy && \(row\.wsl \|\| Boolean\(row\.pack\) && row\.pack\?\.removable !== false\)/, 'WSL 行也允许删除')
  assert.match(page, /post\('\/api\/wsl\/profile\/remove', \{ distro: wsl\.distro, home: wsl\.home, profile \}\)/)
  assert.match(page, /删除 WSL「\{distro\}」里的 Profile「\{profile\}」？/, 'WSL 的删除确认要说清是发行版里的哪一份')
  assert.match(page, /for \(const key of \[\.\.\.pickerWslProfileCache\.keys\(\)\]\)/, '删完清掉这份 Profile 的插件摘要缓存')
})

test('WSL 用户：启动项可填，探测 / 路径转换 / Profile 详情都带上它', () => {
  assert.match(page, /id="launchWslLocationFields" hidden>[\s\S]{0,400}?id="launchWslUser"/)
  assert.match(page, /data-placeholder-i18n="默认登录用户；例如 root"/)
  assert.match(page, /wslUser: launchWslUserEl\.value\.trim\(\)/, '保存时带上用户')
  assert.match(page, /const user = launchWslUserEl\.value\.trim\(\)/)
  assert.match(page, /user=\$\{encodeURIComponent\(user\)\}/, '探测 dsh 时带 user')
  assert.match(page, /launchWslUserEl\.onchange = \(\) => \{ launchWslProfiles = \[\]; void refreshWslProfiles\(true\)/, '改用户要重新探测 Profile')
  assert.match(page, /\/api\/wsl\/profile\?distro=[^`]*&user=\$\{encodeURIComponent\(user\)\}/, 'Profile 详情带 user')
  assert.match(page, /pickWslDirectory\(distro, input\.value, launchWslUserEl\.value\.trim\(\)\)/, '路径转换按当前用户展开 ~')
})

test('WSL 启动失败按 reasonCode 给可操作文案，原始 message 仍作兜底', () => {
  assert.match(page, /const FAILURE_CODE_TEXT = \{/)
  for (const code of ['wsl-unavailable', 'distro-missing', 'user-missing', 'wsl-timeout', 'dsh-missing', 'workspace-unavailable']) {
    assert.ok(page.includes(`'${code}'`), `缺 ${code} 的页面文案`)
  }
  assert.match(page, /failure\.code && FAILURE_CODE_TEXT\[failure\.code\] \? t\(FAILURE_CODE_TEXT\[failure\.code\]\) : ''/)
})

test('选择窗的切换 / 增删动效：方向推入、删除淡出、新增高亮，且遵守减动效', () => {
  assert.match(css, /@keyframes profile-pick-refresh-right/)
  assert.match(css, /@keyframes profile-pick-refresh-left/)
  assert.match(css, /@keyframes profile-pick-row-out/)
  assert.match(css, /@keyframes profile-pick-row-new/)
  assert.match(css, /\.profile-pick-row\.is-removing \{ animation: profile-pick-row-out/)
  assert.match(css, /\.profile-pick-row\.is-new \{ animation: profile-pick-row-new/)
  assert.match(css, /html\.reduce-motion \.profile-pick-row\.is-removing/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}?\.profile-pick-row\.is-new \{ animation: none; \}/)
  assert.match(page, /async function fadePickerRowOut\(row\)/)
  assert.match(page, /pickerNewRow = `home:\$\{added\}`/, '新增目录高亮')
  assert.match(page, /pickerNewRow = `profile:\$\{data\.createdProfile\}`/, '新建 Profile 高亮')
})
