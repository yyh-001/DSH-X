/**
 * Windows / macOS 的 Electron 外壳（shell/）里与 Electron 无关的规则。期望值取自旧 Rust 外壳的同名用例
 * （已随旧外壳一起删除）：两个外壳对管理服务说的是同一套协议，规则必须一致。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isExternalWebUrl,
  isBootingUrl,
  followAction,
  isLoopbackUrl,
  launchActionEnabled,
  launchActionRequest,
  launchLabel,
  parseLaunchEntry,
  parseTabAction,
  parseTabTarget,
  parseTrayState,
  reorderBy,
  sameOrigin,
  internalMode,
  windowMode,
  surfaceInk,
} from '../shell/model.mjs'
import { runtimeNode, runtimeNodeEnv } from '../src/platform.js'
import { resolveDark, stoppedPage, tabBaseColor } from '../shell/pages.mjs'

test('停止页跟随主题与系统深浅色（#58，和 tabs.rs 的同名用例一致）', () => {
  assert.ok(resolveDark('dark', false) && resolveDark('dark', true))
  assert.ok(!resolveDark('light', false) && !resolveDark('light', true))
  assert.ok(!resolveDark('system', false) && resolveDark('system', true))
  assert.ok(resolveDark('', true), '缺 theme 行时按跟随系统处理')
  assert.ok(stoppedPage('zh', false).includes('background:#f5f8ff'))
  const dark = stoppedPage('zh', true)
  assert.ok(dark.includes('background:#15171c') && !dark.includes('#f5f8ff'), '深色停止页不能带浅色底')
  const en = stoppedPage('en', true)
  assert.ok(en.includes('This DSH instance has stopped.') && !en.includes('此 DSH'), '英文界面不能冒出中文')
})

test('标签页视图的底色跟页面 body 一致：默认白色会在深色下闪一下白屏', () => {
  assert.equal(tabBaseColor(false), '#eef3fd', '浅色用 launcher.css 的 --bg')
  assert.equal(tabBaseColor(true), '#18181b', '深色用 theme.css 的 --bg')
})

test('本机地址判定：只认回环，userinfo 里的主机名骗不过去', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:9716/?token=a'))
  assert.ok(isLoopbackUrl('http://localhost/'))
  assert.ok(isLoopbackUrl('http://[::1]:80/'))
  assert.ok(!isLoopbackUrl('http://127.0.0.1@evil.example/'))
  assert.ok(!isLoopbackUrl('https://example.com/'))
  assert.ok(!isLoopbackUrl('data:text/html,hi'))
  assert.ok(isExternalWebUrl('https://github.com/yyh-001/DSH-X'))
  assert.ok(!isExternalWebUrl('http://127.0.0.1:3780/'))
  // data:/blob: 不是外部网页：交给系统只会弹「用什么打开」
  assert.ok(!isExternalWebUrl('data:text/html,hi'))
  assert.ok(sameOrigin('http://127.0.0.1:1/a?b', 'HTTP://127.0.0.1:1/'))
  assert.ok(!sameOrigin('http://127.0.0.1:1/', 'http://127.0.0.1:2/'))
  assert.ok(!sameOrigin('about:blank', 'about:blank'))
})

test('认出启动进度页：只有 /booting 才算，别的路径与坏地址都不算', () => {
  assert.ok(isBootingUrl('http://127.0.0.1:3780/booting?version=1.2.3&profile=web'))
  assert.ok(isBootingUrl('http://127.0.0.1:3780/booting/'))
  assert.ok(!isBootingUrl('http://127.0.0.1:3780/'))
  assert.ok(!isBootingUrl('http://127.0.0.1:59536/?token=abc'))
  assert.ok(!isBootingUrl('http://127.0.0.1:3780/booting-x'))
  assert.ok(!isBootingUrl(''))
  assert.ok(!isBootingUrl('not a url'))
  assert.ok(!isBootingUrl('data:text/html,hi'))
})

test('进度页在实例还没就绪时不被外壳换成停止页（#booting 活不过一轮轮询的原因）', () => {
  const booting = { booting: true, loaded: 'http://127.0.0.1:3780/booting?version=1.2.3&profile=web' }
  const normal = { booting: false, loaded: '' }
  // 还在起、地址没打印出来：让进度页自己走，别换成停止页
  assert.equal(followAction(booting, { status: 'starting', url: null }, ''), 'leave')
  assert.equal(followAction(booting, { status: 'starting', url: '' }, ''), 'leave')
  // 实例压根还没进列表（首次启动要先装依赖）：同样不动它
  assert.equal(followAction(booting, undefined, ''), 'leave')
  // 已经就绪：进度页自己跳进同源地址了，认下地址、不再 loadURL
  assert.equal(followAction(booting, { status: 'running', url: 'http://127.0.0.1:59536/?token=t' }, 'http://127.0.0.1:59536/'), 'adopt')
  // 就绪了但页面还没跳（还停在 /booting）：正常按地址 load
  assert.equal(followAction(booting, { status: 'running', url: 'http://127.0.0.1:59536/?token=t' }, 'http://127.0.0.1:3780/booting'), 'load')
  // 普通标签不受影响：实例在起（地址为空）照旧换成停止页，这是实例真停了的既有语义
  assert.equal(followAction(normal, { status: 'starting', url: '' }, ''), 'load')
  // 地址没变就不动（重启间隙不反复刷新）
  assert.equal(followAction({ booting: false, loaded: 'http://127.0.0.1:1/?token=t' }, { status: 'running', url: 'http://127.0.0.1:1/?token=t' }, ''), 'leave')
  // 换了端口要跟着换
  assert.equal(followAction({ booting: false, loaded: 'http://127.0.0.1:1/?token=t' }, { status: 'running', url: 'http://127.0.0.1:2/?token=t' }, 'http://127.0.0.1:1/'), 'load')
})

test('标签目标保留认证地址，拒收外部地址', () => {
  const target = parseTabTarget({ id: 'web@1', title: 'web · 1', url: 'http://127.0.0.1:1234/?token=abc&x=2' })
  assert.ok(target.url.endsWith('token=abc&x=2'))
  assert.equal(target.managed, true)
  assert.equal(parseTabTarget({ id: 'x', url: 'https://example.com/' }), null)
  assert.equal(parseTabTarget({ id: '', url: 'http://127.0.0.1/' }), null)
})

test('/api/tray 解析：实例与启动项各自校验，坏行不影响其余字段', () => {
  const state = parseTrayState([
    'status=running',
    'lang=en',
    'openmode=internal',
    'shell=1',
    'theme=dark',
    `instances=${JSON.stringify([{ id: 'a', url: 'http://127.0.0.1:1/?token=t' }, { id: 'b', url: 'https://example.com/' }])}`,
    'launches=not json',
  ].join('\n'))
  assert.equal(state.lang, 'en')
  assert.equal(state.theme, 'dark')
  assert.deepEqual(state.instances.map((item) => item.id), ['a'])
  assert.deepEqual(state.launches, [])
  assert.ok(internalMode(state))
  assert.ok(!windowMode(state))
  // 源码运行（shell=0）时选了内部 / 窗口也不成立，退回系统浏览器
  assert.ok(!internalMode(parseTrayState('openmode=internal\nshell=0')))
})

test('管理页的标签消息：未知动作与脏字段一律拒绝', () => {
  assert.deepEqual(parseTabAction('{"action":"select","id":""}'), { action: 'select', id: '' })
  assert.equal(parseTabAction('{"action":"launch"}'), null)
  assert.equal(parseTabAction('{"action":"select"}'), null)
  assert.deepEqual(parseTabAction('{"action":"present","serial":3}'), { action: 'present', serial: 3 })
  assert.equal(parseTabAction('{"action":"present","serial":-1}'), null)
  assert.deepEqual(parseTabAction('{"action":"overlay","open":true}'), { action: 'overlay', open: true })
  assert.equal(parseTabAction('{"action":"overlay"}'), null)
  assert.deepEqual(parseTabAction('{"action":"select","id":"web","request":2}'), { action: 'select', id: 'web', request: 2 })
  assert.equal(parseTabAction('{"action":"select","id":"web","request":-1}'), null)
  assert.deepEqual(parseTabAction('{"action":"layout","height":72}'), { action: 'layout', height: 72 })
  assert.equal(parseTabAction('{"action":"layout","height":4000}'), null)
  assert.equal(parseTabAction('minimize'), null)
})

test('排序消息校验 id，并让新开的标签留在末尾', () => {
  assert.deepEqual(parseTabAction('{"action":"reorder","ids":["second","first"],"request":3}'), { action: 'reorder', ids: ['second', 'first'], request: 3 })
  for (const body of [
    '{"action":"reorder","ids":["first","first"],"request":3}',
    '{"action":"reorder","ids":[""],"request":3}',
    '{"action":"reorder","ids":[1],"request":3}',
    '{"action":"reorder","ids":[],"request":-1}',
  ]) assert.equal(parseTabAction(body), null, body)
  const ids = reorderBy(['first', 'new-a', 'second', 'new-b'], ['closed', 'second', 'first'], (id) => id)
  assert.deepEqual(ids, ['second', 'first', 'new-a', 'new-b'])
})

test('托盘启动项：操作可用性跟着各自的状态和地址走', () => {
  const row = parseLaunchEntry({ id: 'custom', name: '测试 & 工作', status: 'running', installed: true, target: { id: 'instance', url: 'http://127.0.0.1:7890/?token=test' } })
  assert.ok(launchActionEnabled(row, 'open'))
  assert.ok(!launchActionEnabled(row, 'start'))
  assert.ok(launchActionEnabled(row, 'stop'))
  // macOS 菜单不把 & 当快捷键标记，不转义
  assert.equal(launchLabel(row, false), '测试 & 工作 · 运行中')
  assert.deepEqual(launchActionRequest(row, 'stop'), { id: 'custom', instanceId: '', action: 'stop', targetId: 'instance' })
  assert.equal(launchActionRequest(row, 'start'), null)
  assert.ok(!launchActionEnabled({ ...row, busy: true }, 'restart'))
  const stopped = { ...row, status: 'stopped' }
  assert.ok(launchActionEnabled(stopped, 'start'))
  assert.ok(!launchActionEnabled(stopped, 'open'))
  assert.ok(!launchActionEnabled({ ...stopped, installed: false }, 'start'))
  assert.ok(launchLabel({ ...stopped, installed: false }, true).endsWith('Not installed'))
  // 外部地址的目标被拒收，「打开」不可用
  const external = parseLaunchEntry({ id: 'x', name: 'x', status: 'running', target: { id: 'i', url: 'https://example.com/' } })
  assert.ok(!launchActionEnabled(external, 'open'))
})

test('Electron 外壳里，dsh 子进程固定用 Electron 自带的 Node（旧包残留的 node.exe 不参与）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-node-'))
  try {
    // 不在 Electron 里：就是正在跑的 node
    assert.equal(runtimeNode({}, root, false), process.execPath)
    // 显式指定优先
    assert.equal(runtimeNode({ DSH_RUNTIME_NODE: '/custom/node' }, root, true), '/custom/node')
    // 打包后没有自带 node：就是 Electron 本体（加 ELECTRON_RUN_AS_NODE 环境变量）
    assert.equal(runtimeNode({ PATH: '' }, root, true), process.execPath)
    // ≤0.1.19 的安装包会在 core 目录留下 node/node.exe（v22.19）：它低于 dsh 的 engines，
    // 就地升级后不能被优先使用，否则 dsh 会跑在过时的 Node 上（#89）
    mkdirSync(join(root, 'node'))
    writeFileSync(join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), '')
    assert.equal(runtimeNode({ PATH: '' }, root, true), process.execPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RUNTIME_NODE_ENV：只有落到 Electron 本体时才补 ELECTRON_RUN_AS_NODE', () => {
  assert.deepEqual(runtimeNodeEnv('/app/DSH.exe', '/app/DSH.exe', true), { ELECTRON_RUN_AS_NODE: '1' })
  // Windows 路径大小写不敏感
  if (process.platform === 'win32') assert.deepEqual(runtimeNodeEnv('C:\\App\\dsh.exe', 'c:\\APP\\DSH.exe', true), { ELECTRON_RUN_AS_NODE: '1' })
  // 旧安装包的 node.exe、或根本不在 Electron 里：什么都不用设
  assert.deepEqual(runtimeNodeEnv('/app/node/node.exe', '/app/DSH.exe', true), {})
  assert.deepEqual(runtimeNodeEnv('/app/DSH.exe', '/app/DSH.exe', false), {})
})

test('标签字色跟着采到的底色走：亮底深字、暗底浅字', () => {
  // 暗色主题下 iframe 里的 dsh 页面可以是浅色的，标签底色跟着页面变白时，主题里的浅色字就不够用了
  assert.equal(surfaceInk('rgb(255, 255, 255)'), '#1b2434')
  assert.equal(surfaceInk('rgba(248, 251, 255, 0.7)'), '#1b2434')
  assert.equal(surfaceInk('rgb(24, 24, 27)'), '#f2f4f8')
  assert.equal(surfaceInk('rgb(39, 39, 43)'), '#f2f4f8')
  assert.equal(surfaceInk(''), '', '采不到就不给字色，退回主题色')
  assert.equal(surfaceInk('transparent'), '')
})
