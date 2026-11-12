import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WSL_AGENT_SCRIPT } from '../src/wsl-scripts.js'
import {
  DEFAULT_HOME,
  WSL_SERVICE_MODE,
  buildStartScript,
  buildWslArgs,
  createWslBackend,
  decodeWslOutput,
  inspectWslDistro,
  listWslDistros,
  parseWslDistroList,
  parseWslHomeKey,
  resolveWslHome,
  startWslInstance,
  wslAvailable,
  wslHomeKey,
  buildAgentInstallScript,
} from '../src/wsl.js'
import { IDENTITY_MARKER } from '../src/remote.js'
import { safeLaunchPresets, safeWslUser } from '../src/settings.js'

// WSL 相关纯函数测试：不启动真实 wsl.exe，保证 macOS / Linux 开发机和 CI 也能跑。

/** 按 args 分派的假 wsl.exe：列表 / 身份 / dsh 探测 / 代理探针 / 网关各回各的输出。 */
function wslRunner(options = {}) {
  const calls = []
  const list = options.list ?? '  NAME STATE VERSION\n  Debian Running 2\n'
  const identity = options.identity ?? `${IDENTITY_MARKER}\nDebian\nroot\n/root\n`
  const dsh = options.dsh ?? '__DSHX_DSH_HOME__/root/.dsh\n__DSHX_DSH_CMD__dsh\n__DSHX_DSH_PATH__/usr/local/bin/dsh\n__DSHX_VERSION__0.2.2\n__DSHX_PROFILES__\nweb\n'
  const gateway = options.gateway ?? 'route=172.30.64.1 resolv=10.255.255.254\n'
  const probes = options.probes ?? {}
  const run = (args) => {
    calls.push(args)
    const script = String(args[args.length - 1])
    if (args.includes('--list')) return { ok: true, stdout: Buffer.from(list, 'utf8'), stderr: '' }
    if (script.includes(IDENTITY_MARKER)) return { ok: true, stdout: identity, stderr: '' }
    if (script.includes('__DSHX_DSH_HOME__')) return { ok: true, stdout: dsh, stderr: '' }
    if (script.includes('ip route')) return { ok: true, stdout: gateway, stderr: '' }
    const probe = /\/dev\/tcp\/([^/]+)\/(\d+)/.exec(script)
    if (probe) return { ok: true, stdout: probes[`${probe[1]}:${probe[2]}`] ?? 'unreachable', stderr: '' }
    if (script.includes('test -d')) return { ok: true, stdout: options.dir === false ? 'no' : 'yes', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { run, calls }
}

/** stream 只关心参数：返回一个能挂监听、能 kill 的假 child。 */
function fakeSpawn() {
  const calls = []
  const spawn = (exe, args, opts) => {
    calls.push({ exe, args, opts })
    return { once() {}, on() {}, kill() {}, stdin: { end() {} } }
  }
  return { spawn, calls }
}

test('buildWslArgs：-d → -u → --exec，脚本不再 base64', () => {
  assert.deepEqual(
    buildWslArgs({ distro: 'Debian', user: 'root' }, ['bash', '-lc', 'echo "$HOME"']),
    ['-d', 'Debian', '-u', 'root', '--exec', 'bash', '-lc', 'echo "$HOME"'],
  )
  assert.deepEqual(buildWslArgs({}, ['true']), ['--exec', 'true'])
  assert.deepEqual(buildWslArgs({ distro: 'Debian' }, ['true']), ['-d', 'Debian', '--exec', 'true'])
  assert.equal(buildWslArgs({ distro: 'Debian', user: 'root' }, ['bash', '-lc', 'x']).join(' ').includes('base64'), false)
})

test('buildStartScript：代理 export 在前，agent 前台 exec，参数逐个加引号', () => {
  const script = buildStartScript({
    instanceId: 'abc123',
    profile: 'web',
    home: '~/.dsh',
    workdir: '/root/projects/demo',
    port: 42000,
    dshCommand: 'dsh',
    env: { HTTP_PROXY: 'http://172.30.64.1:7897', NODE_USE_ENV_PROXY: '1' },
  })
  assert.match(script, /export HTTP_PROXY='http:\/\/172\.30\.64\.1:7897'/)
  assert.match(script, /export NODE_USE_ENV_PROXY='1'/)
  assert.match(script, /script="\$HOME\/\.dsh-x\/bin\/dsh-x-wsl\.sh"/)
  assert.match(script, /exec "\$script" start 'abc123' 'web' '~\/\.dsh' '\/root\/projects\/demo' '42000' 'dsh'/)
  const plain = buildStartScript({ instanceId: 'a', profile: 'web', home: '', workdir: '', port: 1, dshCommand: 'dsh' })
  assert.doesNotMatch(plain, /export /)
})

test('身份探测：发行版名大小写归一，用户和 HOME 用远端实际值', async () => {
  const { run, calls } = wslRunner()
  const backend = createWslBackend({ distro: 'debian', user: 'root', run })
  assert.deepEqual(await backend.resolveIdentity(), { distro: 'Debian', user: 'root', home: '/root', version: 2 })
  const identityCall = calls.find((args) => String(args[args.length - 1]).includes(IDENTITY_MARKER))
  assert.deepEqual(identityCall.slice(0, 7), ['-d', 'Debian', '-u', 'root', '--exec', 'bash', '--noprofile'])
  assert.ok(identityCall.includes('--norc'))
})

test('身份探测：发行版不存在直接报 distro-missing，不去 spawn 身份脚本', async () => {
  const { run, calls } = wslRunner()
  const backend = createWslBackend({ distro: 'Ubuntu', run })
  await assert.rejects(backend.resolveIdentity(), (error) => {
    assert.equal(error.reasonCode, 'distro-missing')
    assert.match(error.message, /Ubuntu/)
    return true
  })
  assert.equal(calls.some((args) => String(args[args.length - 1]).includes(IDENTITY_MARKER)), false)
})

test('身份探测：用户不存在映射成 user-missing，并保留 wsl.exe 的原始说明', async () => {
  const failing = (args) => {
    if (args.includes('--list')) return { ok: true, stdout: Buffer.from('  NAME STATE VERSION\n  Debian Running 2\n'), stderr: '' }
    return { ok: false, code: 4294967295, stdout: Buffer.from('找不到用户。\n错误代码: Wsl/WSL_E_USER_NOT_FOUND\n', 'utf8'), stderr: '' }
  }
  const backend = createWslBackend({ distro: 'Debian', user: 'nobody-xyz', run: failing })
  await assert.rejects(backend.resolveIdentity(), (error) => {
    assert.equal(error.reasonCode, 'user-missing')
    assert.match(error.message, /WSL_E_USER_NOT_FOUND/)
    return true
  })
})

test('身份探测：超时映射成 wsl-timeout 且标 retryable', async () => {
  const backend = createWslBackend({
    distro: 'Debian',
    run: (args) => args.includes('--list')
      ? { ok: true, stdout: Buffer.from('  NAME STATE VERSION\n  Debian Running 2\n'), stderr: '' }
      : { ok: false, timedOut: true, stdout: Buffer.alloc(0), stderr: '' },
  })
  await assert.rejects(backend.resolveIdentity(), (error) => {
    assert.equal(error.reasonCode, 'wsl-timeout')
    assert.equal(error.retryable, true)
    return true
  })
})

test('listWslDistros：发行版不存在时 stdout 的 WSL_E_* 优先于 stderr 的代理警告', async () => {
  const run = (args) => args.includes('--list')
    ? {
        ok: false,
        code: 4294967295,
        stdout: Buffer.from('不存在具有所提供名称的分发。\n错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n', 'utf8'),
        stderr: 'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。',
      }
    : { ok: true, stdout: '', stderr: '' }
  const result = await listWslDistros({ run })
  assert.equal(result.available, true)
  assert.match(result.error, /WSL_E_DISTRO_NOT_FOUND/)
  assert.doesNotMatch(result.error, /代理/)
  assert.equal(result.reasonCode, 'distro-missing')
  assert.equal(result.retryable, false)
})

test('回环代理：localhost 不通但网关通时改写到网关；两边都不通标 unreachable', async () => {
  const gatewayRunner = wslRunner({
    probes: {
      '127.0.0.1:7897': 'unreachable',
      '172.30.64.1:7897': 'reachable',
    },
  })
  const backend = createWslBackend({ distro: 'Debian', user: 'root', identity: { distro: 'Debian', user: 'root', home: '/root' }, run: gatewayRunner.run })
  assert.deepEqual(await backend.resolveRuntimeProxy('http://127.0.0.1:7897'), {
    url: 'http://172.30.64.1:7897/',
    original: 'http://127.0.0.1:7897/',
    via: 'gateway',
    gateway: '172.30.64.1',
    note: '',
  })

  const deadRunner = wslRunner({
    probes: { '127.0.0.1:7897': 'unreachable', '172.30.64.1:7897': 'unreachable' },
  })
  const dead = createWslBackend({ distro: 'Debian', identity: { distro: 'Debian', user: 'root', home: '/root' }, run: deadRunner.run })
  const result = await dead.resolveRuntimeProxy('http://127.0.0.1:7897')
  assert.equal(result.via, 'unreachable')
  assert.equal(result.gateway, '172.30.64.1')

  const directRunner = wslRunner()
  const direct = createWslBackend({ distro: 'Debian', identity: { distro: 'Debian', user: 'root', home: '/root' }, run: directRunner.run })
  assert.equal((await direct.resolveRuntimeProxy('http://192.168.1.9:7897')).via, 'direct')
  assert.equal(directRunner.calls.length, 0, '非回环代理不需要进 WSL 探测')
})

test('inspectWslDistro：身份和 dsh 探测都带 -u，解析版本与 Profile', async () => {
  const { run, calls } = wslRunner()
  const info = await inspectWslDistro('debian', '~/.dsh', { user: 'root', run })
  assert.equal(info.ok, true)
  assert.equal(info.distro, 'Debian')
  assert.equal(info.user, 'root')
  assert.equal(info.home, '/root')
  assert.equal(info.dshHome, '/root/.dsh')
  assert.equal(info.version, '0.2.2')
  assert.deepEqual(info.profiles, ['web'])
  const dshCall = calls.find((args) => String(args[args.length - 1]).includes('__DSHX_DSH_HOME__'))
  assert.ok(dshCall.includes('-u') && dshCall.includes('root'))
})

test('inspectWslDistro：删除发行版后报 distro-missing 和可操作文案', async () => {
  const { run } = wslRunner()
  const info = await inspectWslDistro('Ubuntu', '~/.dsh', { run })
  assert.equal(info.ok, false)
  assert.equal(info.reasonCode, 'distro-missing')
  assert.match(info.error, /Ubuntu/)
})

test('startWslInstance：网关代理注入 HTTP_PROXY 和 NODE_USE_ENV_PROXY，脚本走 --exec', async () => {
  const runner = wslRunner({ probes: { '127.0.0.1:7897': 'unreachable', '172.30.64.1:7897': 'reachable' } })
  const spawned = fakeSpawn()
  const started = await startWslInstance({
    distro: 'Debian',
    user: 'root',
    identity: { distro: 'Debian', user: 'root', home: '/root' },
    profile: 'web',
    home: '~/.dsh',
    port: 42000,
    proxy: { url: 'http://127.0.0.1:7897', bypass: [] },
    run: runner.run,
    spawn: spawned.spawn,
  })
  assert.equal(started.proxy.via, 'gateway')
  assert.equal(started.proxy.gateway, '172.30.64.1')
  const { args } = spawned.calls[0]
  assert.ok(args.includes('--exec'))
  assert.equal(args.includes('base64'), false)
  const script = args[args.length - 1]
  assert.match(script, /export HTTP_PROXY='http:\/\/172\.30\.64\.1:7897\/?'/)
  assert.match(script, /export HTTPS_PROXY='http:\/\/172\.30\.64\.1:7897\/?'/)
  assert.match(script, /export NODE_USE_ENV_PROXY='1'/)
  assert.match(script, /exec "\$script" start /)
})

test('startWslInstance：代理两边都不通时不注代理，dsh 直连', async () => {
  const runner = wslRunner({ probes: { '127.0.0.1:7897': 'unreachable', '172.30.64.1:7897': 'unreachable' } })
  const spawned = fakeSpawn()
  const started = await startWslInstance({
    distro: 'Debian',
    identity: { distro: 'Debian', user: 'root', home: '/root' },
    profile: 'web',
    port: 42000,
    proxy: { url: 'http://127.0.0.1:7897', bypass: [] },
    run: runner.run,
    spawn: spawned.spawn,
  })
  assert.equal(started.proxy.via, 'unreachable')
  const script = spawned.calls[0].args[spawned.calls[0].args.length - 1]
  assert.doesNotMatch(script, /HTTP_PROXY|NODE_USE_ENV_PROXY/)
})

test('startWslInstance：项目目录不存在直接报 workspace-unavailable，不起进程', async () => {
  const runner = wslRunner({ dir: false })
  const spawned = fakeSpawn()
  await assert.rejects(startWslInstance({
    distro: 'Debian',
    identity: { distro: 'Debian', user: 'root', home: '/root' },
    profile: 'web',
    home: '~/.dsh',
    workdir: '/root/nope',
    port: 42000,
    run: runner.run,
    spawn: spawned.spawn,
  }), (error) => {
    assert.equal(error.reasonCode, 'workspace-unavailable')
    assert.match(error.message, /\/root\/nope/)
    return true
  })
  assert.equal(spawned.calls.length, 0)
})

test('stopWslInstance：停止脚本也按启动时的用户进发行版', async () => {
  const calls = []
  const run = (args) => {
    calls.push(args)
    return { ok: true, stdout: '', stderr: '' }
  }
  const { stopWslInstance } = await import('../src/wsl.js')
  assert.deepEqual(await stopWslInstance({ distro: 'Debian', user: 'root', instanceId: 'abc', port: 42000, run }), { ok: true, stderr: '', stdout: '' })
  assert.deepEqual(calls[0].slice(0, 4), ['-d', 'Debian', '-u', 'root'])
  assert.ok(calls[0].includes('--exec'))
  assert.match(String(calls[0].at(-1)), /exec "\$script" stop 'abc' '42000'/)
})

test('启动项保存 wslUser：合法值原样保留，非法值让 safeWslUser 报错', () => {
  const presets = safeLaunchPresets([{
    id: '0123456789abcdef', name: 'WSL 测试', version: 'auto', profile: 'web', port: 0,
    backend: 'wsl', wslDistro: 'Debian', wslHome: '~/.dsh', wslUser: 'root',
  }])
  assert.equal(presets.find((item) => item.id === '0123456789abcdef')?.wslUser, 'root')
  assert.equal(safeWslUser(''), '')
  assert.throws(() => safeWslUser('a/b'), /不合法/)
  assert.throws(() => safeWslUser(42), /用户名/)
})

test('WSL 的实例键可以往返，发行版与用户目录都按 URI 编码', () => {
  assert.equal(DEFAULT_HOME, '~/.dsh')
  assert.equal(wslHomeKey('Fedora', '~/.dsh'), 'wsl://Fedora/~%2F.dsh')
  assert.deepEqual(parseWslHomeKey('wsl://Fedora/~%2F.dsh'), { distro: 'Fedora', home: '~/.dsh' })
  assert.deepEqual(parseWslHomeKey(wslHomeKey('Ubuntu 24.04', '/home/a b/.dsh')), { distro: 'Ubuntu 24.04', home: '/home/a b/.dsh' })
})

test('坏的实例键当成本机路径处理，不能把停止流程带崩', () => {
  assert.equal(parseWslHomeKey(''), null)
  assert.equal(parseWslHomeKey('C:\Users\a\.dsh'), null)
  assert.equal(parseWslHomeKey('wsl://Fedora/%E0%A4%A'), null)
})

test('WSL 用户目录只接受 ~ 或绝对路径，末尾斜杠归一化', () => {
  assert.equal(resolveWslHome(''), '~/.dsh')
  assert.equal(resolveWslHome('~'), '~')
  assert.equal(resolveWslHome('~/work/'), '~/work')
  assert.equal(resolveWslHome('/root/.dsh/'), '/root/.dsh')
  assert.equal(resolveWslHome('/'), '/')
  assert.throws(() => resolveWslHome('relative/path'), /绝对路径/)
})

test('wsl --list --verbose 解析：默认发行版、Running/Stopped、名字里有空格都能认', () => {
  const text = [
    '  NAME            STATE           VERSION',
    '* Fedora          Running         2',
    '  Ubuntu 24.04    Stopped         2',
    '  docker-desktop  Running         2',
    '  podman-machine-default  Stopped  2',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWslDistroList(text), [
    { name: 'Fedora', state: 'Running', version: 2, default: true },
    { name: 'Ubuntu 24.04', state: 'Stopped', version: 2, default: false },
  ])
})

test('中文 Windows 的 wsl --list 表头与状态不影响解析，发行版名可以是任意语言', () => {
  const text = [
    '  名称        状态       版本',
    '* 我的发行版  运行中     2',
    '  Ubuntu-24.04 已停止     1',
    '  Debian       Stopped    2',
    '',
  ].join('\r\n')
  assert.deepEqual(parseWslDistroList(text), [
    { name: '我的发行版', state: '运行中', version: 2, default: true },
    { name: 'Ubuntu-24.04', state: '已停止', version: 1, default: false },
    { name: 'Debian', state: 'Stopped', version: 2, default: false },
  ])
})

test('wsl.exe 的 UTF-16LE 输出能解码，普通 UTF-8 不被误判', () => {
  const text = '  NAME  STATE  VERSION\r\n* Fedora  Running  2\r\n'
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.match(decodeWslOutput(utf16), /Fedora/)
  assert.match(decodeWslOutput(Buffer.from('Fedora Running', 'utf8')), /^Fedora Running$/)
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '')
})

test('短的中文 UTF-16LE（无 BOM、无 NUL）也按 UTF-16LE 解，不出乱码', () => {
  // 纯汉字没有 ASCII 高字节的 0，靠 NUL 比例认不出来；严格 UTF-8 解不过时要回退。
  for (const text of ['没有已安装的分发', '错误', '已停止']) {
    assert.equal(decodeWslOutput(Buffer.from(text, 'utf16le')), text)
  }
  // 真 UTF-8 的短中文不能被反向误判。
  assert.equal(decodeWslOutput(Buffer.from('没有已安装的分发', 'utf8')), '没有已安装的分发')
  // 合法 UTF-8 里的字面 U+FFFD 不是「解码失败」，不能被再按 UTF-16 解一遍。
  assert.equal(decodeWslOutput(Buffer.from('\uFFFD\uFFFD', 'utf8')), '\uFFFD\uFFFD')
})

test('wrapper 脚本：pidfile 按实例区分，前台 exec dsh，停止先 TERM 再按端口兜底', () => {
  assert.equal(WSL_SERVICE_MODE, 'wrapper')
  assert.match(WSL_AGENT_SCRIPT, /run_dir="\$state_dir\/run"/)
  assert.match(WSL_AGENT_SCRIPT, /pidfile="\$run_dir\/\$id\.pid"/)
  assert.match(WSL_AGENT_SCRIPT, /--host 127\.0\.0\.1/)
  assert.match(WSL_AGENT_SCRIPT, /--port/)
  assert.match(WSL_AGENT_SCRIPT, /--no-open/)
  assert.match(WSL_AGENT_SCRIPT, /kill -TERM/)
  assert.match(WSL_AGENT_SCRIPT, /fuser -k -TERM/)
})

test('wslAvailable 只返回布尔值，不抛异常', () => {
  assert.equal(typeof wslAvailable(), 'boolean')
})

test('WSL 启动脚本安装：按发行版加锁、临时文件原子替换、内容没变不动目标', () => {
  const script = buildAgentInstallScript('#!/bin/bash\necho hello\n')
  assert.match(script, /mkdir "\$lock"/)
  assert.match(script, /trap 'cleanup' EXIT/)
  assert.match(script, /sha256sum "\$target"/)
  assert.match(script, /mv -f "\$tmp" "\$target"/)
  assert.match(script, /tmp="\$target\.tmp\.\$\$"/)
  const digest = createHash('sha256').update('#!/bin/bash\necho hello\n').digest('hex')
  assert.match(script, new RegExp(digest))
  assert.equal(buildAgentInstallScript('x', '../evil').includes('../evil'), false)
})

test('bootWslOnce 在 finally 释放 rememberedWslPort 认领的自动端口', () => {
  // WSL 实例没法在 CI 里真起；用源码结构锁住「认领 → 必须释放」这条回归点。
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function bootWslOnce')
  const end = source.indexOf('/** 从 WSL 里已安装的 dsh 起一个实例', start)
  const body = source.slice(start, end)
  assert.match(body, /const reused = remembered\.port/)
  assert.match(body, /finally \{\s*claimedAutoPorts\.delete\(reused\)\s*\}/)
})

test('状态快照不做 WSL 探测：发行版列表只在打开设置页/启动项编辑器时按需拉', () => {
  // /api/state 每次状态推送都会走 snapshotDefault；这里放 listWslDistros 等于让
  // 不用 WSL 的用户一直付一次 wsl.exe 的启动成本（本机实测 ~100ms）。
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function snapshotDefault')
  const end = source.indexOf('async function publicSettings', start)
  const body = source.slice(start, end)
  assert.ok(body.length > 0, '找不到 snapshotDefault')
  assert.doesNotMatch(body, /listWslDistros/, '状态快照里不能探测发行版')
  assert.match(body, /available: wslAvailable\(\)/, '快照只报本机有没有 wsl.exe')
})

test('重启全部按启动项重来：带 launchId，auto 的 WSL 启动项重新探测版本', () => {
  // 不带 launchId 时 bootWslOnce 找不到启动项，钉住的端口和 auto 回填都会丢；
  // 用上次记录的具体版本重启，WSL 里 dsh 升级后会直接报「版本不一致」停在那儿。
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const start = source.indexOf('export async function restartInstalled')
  const end = source.indexOf('export function setHost', start)
  const body = source.slice(start, end)
  assert.ok(body.length > 0, '找不到 restartInstalled')
  assert.match(body, /launchId: proc\.launchId \|\| ''/)
  assert.match(body, /preset\.version === 'auto' \? 'auto' : proc\.version/)
  assert.match(body, /\.\.\.\(launchId \? \{ launchId \} : \{\}\)/)
})
