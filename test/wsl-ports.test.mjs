import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  allocateWslPort,
  createWslOutputDecoder,
  invalidateWslCache,
  listWslDistros,
  probeWslPort,
  sameWslDistro,
  startWslInstance,
  wslHomeKey,
  wslPortAvailable,
  wslTextStream,
} from '../src/wsl.js'
import { IDENTITY_MARKER } from '../src/remote.js'
import { safeWslPorts } from '../src/settings.js'

// 不起真实 wsl.exe：run 是按脚本内容回话的假 wsl.exe，macOS / Linux / CI 都能跑。

/** 端口探测用的假 wsl.exe：ports 里列出被占的端口和占用者，failure 让 wsl.exe 本身失败。 */
function portRunner({ busy = {}, failure = null } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (failure) return { ok: false, code: failure.code ?? null, timedOut: failure.timedOut === true, stdout: failure.stdout || '', stderr: failure.stderr || '' }
    const script = String(args[args.length - 1])
    const port = Number(/port='(\d+)'/.exec(script)?.[1])
    if (port in busy) {
      const line = busy[port]
        ? `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("${busy[port]}",pid=4242,fd=21))`
        : `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*`
      return { ok: true, code: 0, stdout: `__DSHX_PORT_BUSY__${line}\n`, stderr: '' }
    }
    return { ok: true, code: 0, stdout: '__DSHX_PORT_FREE__\n', stderr: '' }
  }
  return { run, calls }
}

test('probeWslPort：用标记行区分「空 / 被占」，并带回占用者', async () => {
  const { run } = portRunner({ busy: { 42001: 'node', 42002: '' } })
  assert.deepEqual(await probeWslPort('Debian', 42000, { run }), { free: true, holder: '' })
  assert.deepEqual(await probeWslPort('Debian', 42001, { run }), { free: false, holder: 'node (pid 4242)' })
  assert.deepEqual(await probeWslPort('Debian', 42002, { run }), { free: false, holder: '' })
  assert.equal(await wslPortAvailable('Debian', 42000, { run }), true)
  assert.equal(await wslPortAvailable('Debian', 42001, { run }), false)
})

test('probeWslPort：wsl.exe 超时 / 失败不再冒充「端口被占」，直接抛出原因', async () => {
  const timeout = portRunner({ failure: { timedOut: true } })
  await assert.rejects(probeWslPort('Debian', 42000, { run: timeout.run }), (error) => {
    assert.match(error.message, /端口 42000/)
    assert.match(error.message, /超时/)
    assert.equal(error.reasonCode, 'wsl-timeout')
    return true
  })
  // 发行版不存在时 wsl.exe 的退出码也非 0：以前这就是「端口被占」，然后换下一个端口接着探。
  const missing = portRunner({ failure: { code: 4294967295, stdout: Buffer.from('There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n', 'utf16le') } })
  await assert.rejects(wslPortAvailable('Nope', 42000, { run: missing.run }), /WSL_E_DISTRO_NOT_FOUND/)
})

test('allocateWslPort：钉住的端口被 WSL 里的进程占着时报错点名端口和占用者，不悄悄换', async () => {
  const { run, calls } = portRunner({ busy: { 47001: 'python3' } })
  await assert.rejects(allocateWslPort('Debian', 47001, async () => true, { pinned: true, run }), (error) => {
    assert.equal(error.code, 'PINNED_PORT_BUSY')
    assert.equal(error.port, 47001)
    assert.match(error.message, /固定端口 47001/)
    assert.match(error.message, /WSL Debian/)
    assert.match(error.message, /python3 \(pid 4242\)/)
    return true
  })
  assert.equal(calls.length, 1, '钉住的端口只探一次，不去试别的端口')
})

test('allocateWslPort：钉住的端口被 Windows 侧占着也报错，占用者由调用方说明', async () => {
  const { run } = portRunner()
  await assert.rejects(
    allocateWslPort('Debian', 47001, async (port) => port !== 47001, { pinned: true, run, windowsHolder: () => '0.2.2/web 正在用它' }),
    (error) => {
      assert.equal(error.code, 'PINNED_PORT_BUSY')
      assert.match(error.message, /固定端口 47001 在 Windows 侧已被占用（0\.2\.2\/web 正在用它）/)
      return true
    },
  )
  // 没说明占用者也要说得出是「别的程序」，不能只剩一句启动失败。
  await assert.rejects(allocateWslPort('Debian', 47001, async () => false, { pinned: true, run }), /别的程序占着/)
})

test('allocateWslPort：钉住的端口空着就用它；自动端口被占才允许换', async () => {
  const pinned = portRunner()
  assert.equal(await allocateWslPort('Debian', 47001, async () => true, { pinned: true, run: pinned.run }), 47001)
  const auto = portRunner({ busy: { 47001: 'node' } })
  const port = await allocateWslPort('Debian', 47001, async () => true, { run: auto.run })
  assert.notEqual(port, 47001, '自动端口被占时换一个')
  assert.ok(port >= 42000 && port < 54000)
})

test('allocateWslPort：wsl.exe 失败时第一次探测就停，不再串行试 41 个端口', async () => {
  const { run, calls } = portRunner({ failure: { timedOut: true } })
  await assert.rejects(allocateWslPort('Debian', 0, async () => true, { run }), /超时/)
  assert.equal(calls.length, 1)
  const pinned = portRunner({ failure: { timedOut: true } })
  await assert.rejects(allocateWslPort('Debian', 47001, async () => true, { pinned: true, run: pinned.run }), /超时/)
  assert.equal(pinned.calls.length, 1)
})

/** 把 buffer 按给定大小切块喂给解码器，模拟管道的任意块边界。 */
function decodeChunks(buffer, size) {
  const decoder = createWslOutputDecoder()
  let text = ''
  for (let at = 0; at < buffer.length; at += size) text += decoder.write(buffer.subarray(at, at + size))
  return text + decoder.end()
}

test('createWslOutputDecoder：wsl.exe 的 UTF-16LE 报错按任意块边界都解得干净', () => {
  const english = 'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'
  const chinese = '不存在具有所提供名称的分发。\r\n错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'
  for (const text of [english, chinese]) {
    const buffer = Buffer.from(text, 'utf16le')
    for (const size of [1, 3, 7, 64, buffer.length]) assert.equal(decodeChunks(buffer, size), text, `块大小 ${size}`)
  }
  // 带 BOM 的输出：BOM 不进文本。
  assert.equal(decodeChunks(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(english, 'utf16le')]), 64), english)
})

test('createWslOutputDecoder：纯中文的 UTF-16LE 提示（一个 NUL 都没有）在第一块也认得出', () => {
  const text = '无法启动虚拟机'
  assert.equal(decodeChunks(Buffer.from(text, 'utf16le'), 1024), text)
})

test('createWslOutputDecoder：dsh 的 UTF-8 输出从中文字符中间切开也不会被错认成 UTF-16', () => {
  const text = 'dsh web: http://127.0.0.1:42001/?token=abc\n插件加载完成，正在监听端口\n'
  const buffer = Buffer.from(text, 'utf8')
  for (const size of [1, 2, 5, 16, buffer.length]) assert.equal(decodeChunks(buffer, size), text, `块大小 ${size}`)
})

test('createWslOutputDecoder：wsl.exe 的 UTF-16 警告之后接 bash/dsh 的 UTF-8，两段都对', () => {
  const warning = 'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。\r\n'
  const output = 'dsh web: http://127.0.0.1:42001/?token=abc\n'
  const decoder = createWslOutputDecoder()
  const text = decoder.write(Buffer.from(warning, 'utf16le')) + decoder.write(Buffer.from(output, 'utf8')) + decoder.end()
  assert.equal(text, warning + output)
})

test('wslTextStream：readline 切出来的是解好的行（启动进度页 / 失败日志读的就是这些行）', async () => {
  const input = new PassThrough()
  const lines = []
  const reader = createInterface({ input: wslTextStream(input), crlfDelay: Infinity }).on('line', (line) => lines.push(line))
  const closed = new Promise((resolve) => reader.on('close', resolve))
  const buffer = Buffer.from('不存在具有所提供名称的分发。\r\n错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n', 'utf16le')
  input.write(buffer.subarray(0, 9))
  input.write(buffer.subarray(9))
  input.end()
  await closed
  assert.deepEqual(lines, ['不存在具有所提供名称的分发。', '错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'])
})

test('listWslDistros(waitMs)：wsl.exe 卡住时按时交出 pending，不叠第二个 wsl.exe，回来后进缓存', async (t) => {
  invalidateWslCache()
  t.after(() => invalidateWslCache())
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const run = async () => {
    calls += 1
    await gate
    return { ok: true, stdout: Buffer.from('  NAME STATE VERSION\n* Debian Running 2\n', 'utf16le'), stderr: '' }
  }
  const startedAt = Date.now()
  const first = await listWslDistros({ run, cacheable: true, waitMs: 30 })
  assert.ok(Date.now() - startedAt < 1000, '等不到也要很快返回')
  assert.equal(first.pending, true)
  assert.deepEqual(first.distros, [])
  const second = await listWslDistros({ run, cacheable: true, waitMs: 30 })
  assert.equal(second.pending, true)
  assert.equal(calls, 1, '探测还没回来时不再另起一个 wsl.exe')
  release()
  const settled = await listWslDistros({ run, cacheable: true })
  assert.deepEqual(settled.distros.map((item) => item.name), ['Debian'])
  assert.equal(calls, 1)
  // 有缓存之后 waitMs 也直接拿缓存（10 秒内不再 spawn）。
  const cached = await listWslDistros({ run, cacheable: true, waitMs: 0 })
  assert.deepEqual(cached.distros.map((item) => item.name), ['Debian'])
  assert.equal(calls, 1)
})

test('listWslDistros(waitMs)：缓存过期、新探测卡住时交上一次的列表', async (t) => {
  invalidateWslCache()
  t.after(() => invalidateWslCache())
  const ok = async () => ({ ok: true, stdout: Buffer.from('  NAME STATE VERSION\n* Debian Running 2\n', 'utf16le'), stderr: '' })
  await listWslDistros({ run: ok, cacheable: true })
  const realNow = Date.now
  Date.now = () => realNow() + 60000
  t.after(() => { Date.now = realNow })
  const hung = () => new Promise(() => {})
  const stale = await listWslDistros({ run: hung, cacheable: true, waitMs: 20 })
  assert.equal(stale.pending, true)
  assert.deepEqual(stale.distros.map((item) => item.name), ['Debian'], '交上一次的列表，而不是空列表')
})

test('startWslInstance：写完脚本后、拉起 dsh 前再查一次取消，取消了就不 spawn', async () => {
  const spawned = []
  const run = async (args) => {
    const script = String(args[args.length - 1])
    if (args.includes('--list')) return { ok: true, stdout: Buffer.from('  NAME STATE VERSION\n  Debian Running 2\n', 'utf8'), stderr: '' }
    if (script.includes(IDENTITY_MARKER)) return { ok: true, stdout: `${IDENTITY_MARKER}\nDebian\nroot\n/root\n`, stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  const cancelled = Object.assign(new Error('启动器已退出，取消自动启动'), { code: 'STARTUP_CANCELLED' })
  await assert.rejects(startWslInstance({
    distro: 'Debian', profile: 'web', port: 42000, run,
    spawn: (...args) => { spawned.push(args); return { once() {}, on() {}, kill() {} } },
    beforeSpawn: () => { throw cancelled },
  }), (error) => error === cancelled)
  assert.equal(spawned.length, 0)
})

test('sameWslDistro：发行版名不分大小写', () => {
  assert.equal(sameWslDistro('Ubuntu', 'ubuntu'), true)
  assert.equal(sameWslDistro(' Ubuntu-22.04 ', 'UBUNTU-22.04'), true)
  assert.equal(sameWslDistro('Ubuntu', 'Debian'), false)
  assert.equal(sameWslDistro('', ''), false)
})

test('safeWslPorts：目录键和老的发行版名键都留着，坏键丢掉', () => {
  const home = wslHomeKey('Fedora', '~/.dsh')
  assert.deepEqual(safeWslPorts({
    [home]: { '0.2.2@web': 47001 },
    Fedora: { '0.2.2@web': 47002 },
    'wsl://%E0%A4%A/x': { '0.2.2@web': 47003 },
    'wsl:///~%2F.dsh': { '0.2.2@web': 47004 },
  }), { [home]: { '0.2.2@web': 47001 }, Fedora: { '0.2.2@web': 47002 } })
})

test('远端启动：拉起 dsh 的 /api/start 前紧挨着再查一次取消', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function startRemoteViaCore')
  const body = source.slice(start, source.indexOf('async function stopRemoteCoreInstance', start))
  assert.ok(start > 0, '找不到 startRemoteViaCore')
  assert.match(body, /assertStartupActive\(\)\s*\n\s*const started = await core\.json\('\/api\/start'/)
  assert.match(body, /assertStartupActive\(\)\s*\n\s*if \(!remoteInstalled\.includes\(effective\)\)/)
})

test('删除 WSL 配置前的「正在运行」检查按发行版名不分大小写比较', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf("url.pathname === '/api/wsl/profile/remove'")
  const body = source.slice(start, source.indexOf('removeWslProfile(distro', start))
  assert.ok(start > 0, '找不到 /api/wsl/profile/remove')
  assert.match(body, /sameWslDistro\(proc\.distro, distro\)/)
  assert.doesNotMatch(body, /proc\.distro === distro/)
})

test('设置页读发行版列表不等 wsl.exe：publicSettings 带 waitMs', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function publicSettings')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert.match(body, /listWslDistros\(\{ waitMs: WSL_SETTINGS_WAIT_MS \}\)/)
})
