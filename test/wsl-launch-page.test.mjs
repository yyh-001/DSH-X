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

test('编辑启动项按运行位置 → 名称 → 版本 → WSL 目录/Profile → 本机启动环境排列', () => {
  const order = [
    'id="launchBackendField"',
    'id="launchIdentityField"',
    'id="launchLocalVersionGroup"',
    'id="launchWslHomeField"',
    'id="launchWslProfileField"',
    'id="launchWslWorkdirField"',
    'id="launchEnvField"',
    'id="launchPort"',
  ]
  const indexes = order.map(at)
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), '字段顺序不能乱；WSL 和本机字段按同一位置成对出现')
})

test('WSL 发行版归在运行位置，切到 WSL 时藏掉本机版本整组', () => {
  const start = at('id="launchWslLocationFields"')
  const end = at('id="launchCustomFields"')
  const location = page.slice(start, end)
  assert.match(location, /id="launchWslDistro"/)
  assert.match(location, /id="launchWslHint"/)
  assert.doesNotMatch(location, /launchWslServiceMode/)
  assert.doesNotMatch(page, /id="launchWslVersionField"/, '核心版不包含 WSL 版本管理，版本字段留到版本管理 PR')
  assert.doesNotMatch(css, /launchWslVersionHint/, '核心版不留下 WSL 版本说明的样式')
  assert.match(page, /launchLocalVersionGroupEl\.hidden = wsl/, '本机版本下拉、版本类型、管理按钮与渠道说明要整组隐藏')
  assert.match(css, /\.home-pickers\[hidden\] \{ display: none; \}/, 'home-pickers 的 display:flex 不能盖掉 hidden')
  assert.match(css, /\.launch-modal-fields \{[^}]*gap: 14px;/)
  assert.match(css, /\.launch-wsl-location \{ margin-top: 14px; \}/)
})

test('WSL 发行版列表按需拉：切到 WSL 才请求 /api/wsl，不等状态推送', () => {
  // /api/state 推送里不再带发行版列表（每次探测要 spawn wsl.exe），页面自己按需取。
  const ensure = page.indexOf('async function ensureWslInfo')
  assert.ok(ensure >= 0, '页面里要有 ensureWslInfo')
  assert.match(page.slice(ensure, ensure + 1200), /getJson\('\/api\/wsl'\)/)
  const backend = page.indexOf('function setLaunchBackend')
  const body = page.slice(backend, backend + 2200)
  assert.match(body, /await ensureWslInfo\(/, '切到 WSL / 打开 WSL 启动项时要按需拉列表')
  assert.match(body, /ensureWslInfo\(!\(state\.wsl\?\.distros \|\| \[\]\)\.length\)/, '手里没有发行版时强制刷新，别让缓存挡住刚装好的发行版')
  assert.match(body, /state\.wsl\?\.error \|\| t\('没有检测到 WSL 发行版。'\)/, '一个发行版都没有时要说清楚，而不是「先选择一个」')
})
