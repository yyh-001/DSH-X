/**
 * 启动进度页（/booting）：点「启动」后新开的那张页。管理页不再铺全屏遮罩，
 * 版本 / profile / 阶段 / 已用秒数 / 安装进度都在那张页上实时刷新，dsh 就绪后它自己跳进去。
 *
 * 这里盯三件事：
 *   1. 管理页真的没有遮罩了（结构、样式、重绘函数都不该留）；
 *   2. 进度页地址由页面按启动项拼出来（目录、名称都带上，多开时不串台）；
 *   3. 服务端把这张页当管理页的一份子渲染：语言、主题跟设置一致，且不缓存。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'

const env = await startChannelServer({ prefix: 'dsh-booting-', packument: packumentOf({ latest: '1.0.0' }, ['1.0.0']) })
test.after(() => env.cleanup())

const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const booting = readFileSync(new URL('../src/public/booting.html', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')

/** 页面里从 from 到 to 的那一段（含两端）：把要测的函数原样装进沙箱，不复制一份实现。 */
const section = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)))

function bootPageSandbox({ state = { dshHome: 'C:/Users/me/.dsh', launchPresets: [] }, urls = [] } = {}) {
  const context = vm.createContext({
    state,
    post: async (path, body) => { urls.push([path, body]) },
    URLSearchParams,
    // 管理页在哪个端口上被打开，进度页就开在哪个端口上（同源）。
    location: { origin: 'http://127.0.0.1:62604' },
    launchEntries: () => context.state.launchPresets,
  })
  vm.runInContext(section('    function bootPageUrl(', '    // ---- 启动项日志'), context)
  return { context, urls }
}

test('管理页不再有全屏启动遮罩，启动时改为打开 /booting', () => {
  assert.doesNotMatch(page, /boot-overlay|bootOverlay|paintBootOverlay/, '遮罩的结构、样式钩子和重绘函数都该撤掉')
  assert.doesNotMatch(styles, /\.boot-(overlay|card|spinner|title|phase|bar|hint)/, '遮罩样式不留在主样式表里')
  assert.match(page, /const bootPage = openBootPage\(version, profile, launchId\)/, '点启动先把进度页开出来（与启动请求并行发，不拖慢启动）')
  assert.match(page, /if \(data\.url && !\(await bootPage\)\) await openInstance\(data\.url\)/, '进度页没打开时才兜底直接开 dsh，避免开两份')
})

test('进度页地址带上版本、profile、目录和启动项名称', () => {
  const { context, urls } = bootPageSandbox({
    state: {
      dshHome: 'C:/Users/me/.dsh',
      launchPresets: [{ id: 'work', name: '工作环境', profile: 'work', dshHome: 'D:/dsh/work' }],
    },
  })
  const url = new URL(context.bootPageUrl('1.2.3', 'work', 'work'))
  assert.equal(url.pathname, '/booting')
  assert.equal(url.searchParams.get('version'), '1.2.3')
  assert.equal(url.searchParams.get('profile'), 'work')
  assert.equal(url.searchParams.get('home'), 'D:/dsh/work', '独立目录要带上，否则页面会去等全局目录的那个实例')
  assert.equal(url.searchParams.get('launch'), 'work')
  assert.equal(url.searchParams.get('name'), '工作环境', '标签页标题用启动项名字')

  context.bootPageUrl('1.2.3', 'web', '')
  assert.equal(urls.length, 0, '拼地址不该顺手打开页面')
})

test('WSL 自动版本在进度页保持 auto，并带合成目录', () => {
  const { context } = bootPageSandbox({
    state: {
      dshHome: 'C:/global',
      launchPresets: [{ id: 'wsl', name: 'WSL 环境', profile: 'web', backend: 'wsl', version: 'auto', wslDistro: 'Fedora', wslHome: '~/.dsh' }],
    },
  })
  context.launchHomeOf = () => 'wsl://Fedora/~%2F.dsh'
  const url = new URL(context.bootPageUrl('0.2.1-rc.5', 'web', 'wsl'))
  assert.equal(url.searchParams.get('version'), 'auto', 'WSL auto 不能把上次用过的旧版本传给进度页')
  assert.equal(url.searchParams.get('home'), 'wsl://Fedora/~%2F.dsh')
})

test('全局目录的启动项不写 dshHome，换成默认目录', () => {
  const { context } = bootPageSandbox()
  const url = new URL(context.bootPageUrl('1.2.3', 'web', ''))
  assert.equal(url.searchParams.get('home'), 'C:/Users/me/.dsh')
  assert.equal(url.searchParams.get('launch'), null, '没有启动项就不带这一项')
  assert.equal(url.searchParams.get('name'), null)
})

test('打开失败时返回 false：启动照发，完成后再兜底开 dsh', async () => {
  const context = vm.createContext({
    state: { dshHome: 'C:/global', launchPresets: [] },
    post: async () => { throw new Error('blocked') },
    URLSearchParams,
    location: { origin: 'http://127.0.0.1:62604' },
    launchEntries: () => [],
  })
  vm.runInContext(section('    function bootPageUrl(', '    // ---- 启动项日志'), context)
  assert.equal(await context.openBootPage('1.2.3', 'web', ''), false)
})

test('/booting：服务端渲染页面，语言与主题跟管理页一致，且不缓存', async () => {
  const response = await fetch(`${env.origin}/booting?version=1.2.3&profile=web`)
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(String(response.headers.get('content-type')), /text\/html/)
  assert.equal(response.headers.get('cache-control'), 'no-store', '升级后第一下就得是新页面')
  assert.doesNotMatch(html, /__APP_LANG__|__APP_THEME__/, '占位符要被替换掉')
  assert.match(html, /data-lang="zh"/)
  // 实时进度靠这几处：轮询状态、读安装进度、就绪后跳进去
  assert.match(html, /fetch\('\/api\/state'/, '页面自己轮询 /api/state')
  assert.match(html, /location\.replace\(url\)/, '就绪后跳进 dsh')
  assert.match(html, /snapshot\?\.progress/, '首次启动要看安装/下载进度')
  assert.match(html, /startupPhase/, '启动阶段（启动进程 / 加载插件 / 校验依赖）要在页面上走')
})

test('/booting：切成英文后页面跟着变', async () => {
  const saved = await env.call('/api/settings', { lang: 'en' })
  assert.ok(saved.ok, `保存语言失败：HTTP ${saved.status}`)
  const html = await (await fetch(`${env.origin}/booting`)).text()
  assert.match(html, /data-lang="en"/)
  assert.match(html, /Starting dsh|Booting|Starting \{version\}/)
})

