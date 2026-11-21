import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readEnSource } from './helpers/frontend-source.mjs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { publicFailure } from '../src/server.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(ROOT, 'src', 'public', 'index.html'), 'utf8')

test('没有失败记录时不往界面塞东西', () => {
  assert.equal(publicFailure(null), null)
  assert.equal(publicFailure(undefined), null)
})

test('失败信息带着 dsh 的输出尾巴，key 打码、终端颜色去掉、超长行截断', () => {
  const failure = {
    at: 1,
    version: '0.5.2',
    message: '0.5.2 启动失败',
    exit: { code: 1, signal: null },
    tail: [
      '[auth] key my-very-secret-token',
      '[auth] fallback sk-abcdefghijklmnop',
      '\u001b[90m    at Module._compile (node:internal/modules/cjs/loader:1705:14)\u001b[39m',
      'x'.repeat(5000),
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173',
    ],
  }
  const shown = publicFailure(failure, ['my-very-secret-token'])
  assert.equal(shown.version, '0.5.2')
  assert.equal(shown.message, '0.5.2 启动失败')
  assert.deepEqual(shown.exit, { code: 1, signal: null })
  assert.equal(shown.tail[0], '[auth] key sk-***')
  assert.equal(shown.tail[1], '[auth] fallback sk-***')
  assert.equal(shown.tail[2], '    at Module._compile (node:internal/modules/cjs/loader:1705:14)')
  assert.equal(shown.tail[3].length, 2001, '一行最多 2000 个字符，外加一个省略号')
  assert.equal(shown.tail[4], 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', '真正的报错原样保留')
  // 原始记录不能被改：自动修复还要拿它去认出问题的插件
  assert.match(failure.tail[2], /\u001b\[90m/)
})

test('没走到拉起子进程的失败（未安装之类）只有一句话，也照样能显示', () => {
  const shown = publicFailure({ at: 1, version: '1.2.3', profile: 'web', home: '/h', message: '1.2.3 未安装', exit: null, tail: [] })
  assert.deepEqual(shown, { at: 1, version: '1.2.3', profile: 'web', home: '/h', message: '1.2.3 未安装', exit: null, tail: [] })
})

test('结构化诊断的所有层级都脱敏，原始报告不修改', () => {
  const secret = 'known-private-value'
  const diagnosis = { context: { entry: secret }, failed: [{ package: secret, reason: '\u001b[31msk-abcdefghijklmnop' }], advice: [{ text: secret }] }
  const shown = publicFailure({ diagnosis }, [secret])
  assert.ok(!JSON.stringify(shown).includes(secret))
  assert.ok(!JSON.stringify(shown).includes('sk-abcdefghijklmnop'))
  assert.equal(shown.diagnosis.failed[0].reason, 'sk-***')
  assert.equal(diagnosis.context.entry, secret)
})

test('提示框能带一段可复制的输出，启动这条线上的报错都走它', () => {
  assert.match(html, /<pre class="notice-detail" id="noticeDetail" hidden><\/pre>/, '提示框里有放输出的地方')
  assert.match(html, /<button type="button" class="ghost" id="noticeCopy" hidden><\/button>/, '旁边有复制按钮')
  // 「复制」在词典里已经是启动项的「Duplicate」，按钮用自己的词条
  assert.match(html, /noticeCopyEl\.textContent = t\('复制错误信息'\)/)
  assert.match(html, /function notify\(message, title = t\('操作失败'\), detail = '', fromTop = false\)/)
  // 输出只能当文本塞进去：里面什么字符都可能有
  assert.match(html, /noticeDetailEl\.textContent = detail/)
  assert.match(html, /if \(data\.failure\) error\.failure = data\.failure/, 'post() 把服务端带回来的失败信息挂到 Error 上')
  assert.match(html, /function notifyError\(error\) \{\s+if \(error\?\.failure\) showFailure\(error\.failure\)/)
  // 启动项启动、升级后拉起、自动启动、整合包重启及显式开窗共用诊断入口。
  assert.equal(html.match(/notifyError\(error\)/g)?.length, 6, '五处调用加一处定义')
})

test('主界面留着上次启动失败的入口：托盘里点的启动没有页面在等结果', () => {
  assert.match(html, /failure: data\.failure \?\? null,/, '状态里的失败信息要留下来')
  assert.match(
    html,
    /if \(!hintEl\.textContent && failure && !failureLive\) \{[\s\S]{0,200}?escapeHtml\(failureText\(failure\)\)[\s\S]{0,120}?data-failure/,
    '那个组合没在跑、提示行也没被安装进度占着时才提示',
  )
  assert.match(html, /closest\('\[data-failure\]'\) && state\.failure\) showFailure\(state\.failure\)/, '点提示行上的入口重新打开那段输出')
  const enSource = readEnSource()
  for (const key of ['启动失败', '{label} 启动失败', '{label} 启动超时', '{text}（退出码 {code}）', '{text}，以下是 dsh 退出前的输出：', '查看错误信息', '复制错误信息', '已复制']) {
    assert.ok(enSource.includes(`  "${key}": "`), `英文界面要有「${key}」`)
  }
})

test('同版本同 profile 的另一个用户目录运行时，不能隐藏失败目录的错误入口', () => {
  const start = html.indexOf('      const failure = state.failure')
  const end = html.indexOf('      if (!hintEl.textContent && failure && !failureLive)', start)
  assert.ok(start >= 0 && end > start)
  const failure = { version: '9.9.9', profile: 'web', home: '/failed-home' }
  for (const home of ['/other-home', failure.home]) {
    const state = { failure, instances: [{ version: failure.version, profile: failure.profile, home, status: 'running' }] }
    assert.equal(vm.runInNewContext(html.slice(start, end) + '\nBoolean(failureLive)', { state }), home === failure.home)
  }
})

/** 找一个空闲端口：管理页在端口被占时会自己顺延，那样测试就不知道该连哪了。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

test('dsh 起不来时，接口的报错和状态里都带着它退出前的输出', async () => {
  const box = mkdtempSync(join(tmpdir(), 'dsh-fail-'))
  const data = join(box, 'data')
  const bin = join(data, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(bin, { recursive: true })
  // 假的 dsh：打两行启动日志，然后带着一个 key 和一条报错退出
  writeFileSync(join(bin, 'bin.js'), [
    "console.log('[boot] loading profile')",
    "console.error('[auth] using key sk-abcdefghijklmnop')",
    "console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173')",
    'process.exit(3)',
  ].join('\n'))
  const home = join(box, 'home')
  // 每用户目录按平台不同（见 platform.js 的 userAppDir）：三处都放一份设置
  for (const dir of [join(box, 'appdata', 'DSH'), join(home, 'Library', 'Application Support', 'DSH'), join(home, '.config', 'DSH')]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ dataDir: data, seedMarket: false, autoDisablePlugins: false }))
  }

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const manager = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    // 设置、日志、dsh 家目录全部指进临时目录，别碰这台机器上真正的那份
    env: { ...process.env, PORT: String(port), APPDATA: join(box, 'appdata'), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') },
    stdio: 'ignore',
  })
  try {
    let up = false
    for (let i = 0; i < 100 && !up; i += 1) {
      up = await fetch(`${base}/api/ping`).then((res) => res.ok, () => false)
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(up, '管理页应该起得来')

    const res = await fetch(`${base}/api/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9' }),
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.error, '9.9.9/web 启动失败')
    assert.equal(body.failure.profile, 'web')
    assert.deepEqual(body.failure.exit, { code: 3, signal: null })
    assert.ok(
      body.failure.tail.includes('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173'),
      `报错那行应该在输出尾巴里：${JSON.stringify(body.failure.tail)}`,
    )
    assert.ok(body.failure.tail.includes('[auth] using key sk-***'), 'key 要打码')

    // 另开的页面、托盘触发的启动都读状态：同一份失败信息得在那里
    const state = await fetch(`${base}/api/state`).then((item) => item.json())
    assert.equal(state.running, null)
    assert.equal(state.failure.version, '9.9.9')
    assert.deepEqual(state.failure.tail, body.failure.tail)

    const missing = await fetch(`${base}/api/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '8.8.8' }),
    })
    assert.equal(missing.status, 500)
    const missingBody = await missing.json()
    assert.equal(missingBody.failure.version, '8.8.8')
    assert.equal(missingBody.failure.profile, 'web')
    assert.equal(missingBody.failure.message, '8.8.8 未安装')
    assert.deepEqual(missingBody.failure.tail, [])
  } finally {
    manager.kill()
  }
})
