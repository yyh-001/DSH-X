import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  buildTunnelArgs,
  chooseEdgeIPVersion,
  cloudflaredAssetForPlatform,
  CloudflareTunnelManager,
  ensureCloudflaredBinary,
  findCloudflaredBinary,
  getStableMachineId,
  isBenignCloudflareLog,
  isCloudflareEdgeIP,
  isIpv6TlsEofLine,
  isProxyFakeIP,
  parseFailedEdgeIP,
  parseQuickTunnelUrl,
  parseRegisteredLine,
  probeCloudflareEdge,
  registerOrFetchWorkerTunnel,
} from '../src/tunnel-cloudflare.js'
import workerHandler from '../docs/cloudflare-worker/worker.js'

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dshx-tunnel-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 构造可控的假子进程，用于完全离线验证状态机、日志解析、IPv6 回落与优雅停机。 */
function createFakeChild({ pid = 4242, ignoreSigterm = false } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.killSignals = []
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal)
    child.killed = true
    if (ignoreSigterm && signal !== 'SIGKILL') return true
    queueMicrotask(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.signalCode = signal || 'SIGTERM'
      child.emit('exit', null, child.signalCode)
      child.emit('close', null, child.signalCode)
    })
    return true
  }
  child.crash = (code = 1) => {
    child.exitCode = code
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  return child
}

/** 等待某个条件在合理时间内成立，避免测试写死脆弱的 sleep。 */
async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitFor timeout')
}

/* ---------------------------------------------------------- IP 分类与选路 */

test('isCloudflareEdgeIP: 准确匹配 IPv4/IPv6 官方段与 IPv4-mapped IPv6', () => {
  // IPv4 198.41.128.0/17 与 162.159.0.0/16
  assert.equal(isCloudflareEdgeIP('198.41.128.0'), true)
  assert.equal(isCloudflareEdgeIP('198.41.192.7'), true)
  assert.equal(isCloudflareEdgeIP('198.41.255.255'), true)
  assert.equal(isCloudflareEdgeIP('162.159.0.1'), true)
  assert.equal(isCloudflareEdgeIP('162.159.255.254'), true)
  assert.equal(isCloudflareEdgeIP('::ffff:198.41.192.7'), true)

  // 边界外与非 Cloudflare 地址
  assert.equal(isCloudflareEdgeIP('198.41.127.255'), false)
  assert.equal(isCloudflareEdgeIP('162.158.255.255'), false)
  assert.equal(isCloudflareEdgeIP('162.160.0.1'), false)
  assert.equal(isCloudflareEdgeIP('1.1.1.1'), false)
  assert.equal(isCloudflareEdgeIP('31.13.66.1'), false)

  // IPv6 2606:4700::/32 与 2803:f800::/32
  assert.equal(isCloudflareEdgeIP('2606:4700::1'), true)
  assert.equal(isCloudflareEdgeIP('2606:4700:ffff:1234::5'), true)
  assert.equal(isCloudflareEdgeIP('[2803:f800::42]'), true)
  assert.equal(isCloudflareEdgeIP('2606:4701::1'), false)
  assert.equal(isCloudflareEdgeIP('2001:4860:4860::8888'), false)
  assert.equal(isCloudflareEdgeIP('not-an-ip'), false)
  assert.equal(isCloudflareEdgeIP(''), false)
})

test('isProxyFakeIP: 豁免 Clash/Mihomo/Sing-box TUN Fake-IP 网段', () => {
  // IPv4 198.18.0.0/15
  assert.equal(isProxyFakeIP('198.18.0.1'), true)
  assert.equal(isProxyFakeIP('198.19.255.254'), true)
  assert.equal(isProxyFakeIP('::ffff:198.18.12.34'), true)
  assert.equal(isProxyFakeIP('198.17.255.255'), false)
  assert.equal(isProxyFakeIP('198.20.0.0'), false)

  // IPv6 fc00::/7 (fc00:: ~ fdff::)
  assert.equal(isProxyFakeIP('fc00::1'), true)
  assert.equal(isProxyFakeIP('fd12:3456:789a::1'), true)
  assert.equal(isProxyFakeIP('fbff:ffff::1'), false)
  assert.equal(isProxyFakeIP('fe00::1'), false)
  assert.equal(isProxyFakeIP('fe80::1%eth0'), false)
})

test('chooseEdgeIPVersion: 15% 阈值与单栈/不可达兜底', () => {
  assert.equal(chooseEdgeIPVersion(null, null), 'auto')
  assert.equal(chooseEdgeIPVersion(0, 0), 'auto')
  assert.equal(chooseEdgeIPVersion(NaN, Infinity), 'auto')
  assert.equal(chooseEdgeIPVersion(45, null), '4')
  assert.equal(chooseEdgeIPVersion(null, 38), '6')

  // 差距 >= 15% 时锁定更快一侧
  assert.equal(chooseEdgeIPVersion(80, 100), '4')
  assert.equal(chooseEdgeIPVersion(85, 100), '4')
  assert.equal(chooseEdgeIPVersion(100, 80), '6')
  assert.equal(chooseEdgeIPVersion(100, 85), '6')

  // 差距 < 15% 时保留双栈 auto
  assert.equal(chooseEdgeIPVersion(90, 100), 'auto')
  assert.equal(chooseEdgeIPVersion(100, 92), 'auto')
  assert.equal(chooseEdgeIPVersion(50, 50), 'auto')
})

test('probeCloudflareEdge: 过滤污染 IP、豁免 TUN Fake-IP 并择优选栈', async () => {
  const dialedIps = []
  const resolvedHosts = []

  const result = await probeCloudflareEdge({
    resolve: async (host) => {
      resolvedHosts.push(host)
      if (host === 'region1.v2.argotunnel.com') {
        return ['31.13.66.1', '198.41.192.7', '2606:4700::1']
      }
      return ['2001:db8::99', '162.159.192.1', '2803:f800::1']
    },
    dial: async ({ ip }) => {
      dialedIps.push(ip)
      if (ip === '198.41.192.7') return 42
      if (ip === '162.159.192.1') return 60
      if (ip === '2606:4700::1') return 120
      throw new Error('connect failed')
    },
    timeoutMs: 1000,
  })

  assert.deepEqual(resolvedHosts.sort(), ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'])
  assert.deepEqual(result.polluted.sort(), ['2001:db8::99', '31.13.66.1'])
  assert.equal(dialedIps.includes('31.13.66.1'), false)
  assert.equal(dialedIps.includes('2001:db8::99'), false)
  assert.equal(result.v4RttMs, 42)
  assert.equal(result.v6RttMs, 120)
  assert.equal(result.chosen, '4')
  assert.equal(result.fakeIPDetected, false)

  // TUN Fake-IP 场景：198.18.x.x / fd00:: 不应被判成污染，且可正常探测
  const fakeDialed = []
  const fakeResult = await probeCloudflareEdge({
    resolve: async () => ['198.18.0.10', 'fd00::10'],
    dial: async ({ ip }) => {
      fakeDialed.push(ip)
      if (ip === '198.18.0.10') return 25
      throw new Error('v6 blocked')
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(fakeResult.polluted, [])
  assert.equal(fakeResult.fakeIPDetected, true)
  assert.deepEqual(fakeDialed.sort(), ['198.18.0.10', 'fd00::10'])
  assert.equal(fakeResult.v4RttMs, 25)
  assert.equal(fakeResult.v6RttMs, null)
  assert.equal(fakeResult.chosen, '4')
})

/* ---------------------------------------------------------- 日志解析器 */

test('日志解析器：注册成功、失败边缘 IP、Quick Tunnel URL 与无害日志判定', () => {
  assert.deepEqual(
    parseRegisteredLine('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=2 connection=abc event=0 ip=198.41.192.7 location=hkg05 protocol=http2'),
    { connIndex: 2, location: 'hkg05' },
  )
  assert.equal(parseRegisteredLine('2026-01-01T00:00:00Z INF Starting tunnel'), null)

  assert.equal(
    parseFailedEdgeIP('2026-01-01T00:00:00Z ERR Failed to dial a quic connection ip=198.41.192.7 error="timeout"'),
    '198.41.192.7',
  )
  assert.equal(
    parseFailedEdgeIP('2026-01-01T00:00:00Z ERR dial tcp [2606:4700::1]:7844: unexpected EOF'),
    '2606:4700::1',
  )
  assert.equal(
    parseFailedEdgeIP('2026-01-01T00:00:00Z ERR Unable to establish connection to 31.13.66.1:7844'),
    '31.13.66.1',
  )
  assert.equal(
    parseFailedEdgeIP('2026-01-01T00:00:00Z INF Registered tunnel connection ip=198.41.192.7 location=hkg05'),
    null,
  )

  assert.equal(
    parseQuickTunnelUrl('2026-01-01T00:00:00Z INF |  https://cool-blue-fox-42.trycloudflare.com  |'),
    'https://cool-blue-fox-42.trycloudflare.com',
  )
  assert.equal(parseQuickTunnelUrl('https://example.com'), null)

  assert.equal(isBenignCloudflareLog('Cannot determine default origin certificate path. No file cert.pem in [~/.cloudflared]'), true)
  assert.equal(isBenignCloudflareLog('WRN failed to sufficiently increase receive buffer size'), true)
  assert.equal(isBenignCloudflareLog('ERR Failed to dial edge: unauthorized invalid tunnel token'), false)
  assert.equal(isIpv6TlsEofLine('ERR dial tcp [2606:4700::1]:7844: unexpected EOF'), true)
  assert.equal(isIpv6TlsEofLine('ERR dial tcp 198.41.192.7:7844: unexpected EOF'), false)
})

/* ---------------------------------------------------------- Machine ID & Worker */

test('getStableMachineId: 持久化 64 位 SHA-256 hex，后续读取不因网卡变动漂移', (t) => {
  const dir = makeTempDir(t)
  const id1 = getStableMachineId(dir, {
    hostname: 'workstation-1',
    interfaces: {
      eth0: [{ internal: false, mac: 'aa:bb:cc:dd:ee:ff' }],
      lo: [{ internal: true, mac: '00:00:00:00:00:00' }],
    },
    platform: 'win32',
    arch: 'x64',
  })
  assert.match(id1, /^[0-9a-f]{64}$/)

  const persisted = readFileSync(join(dir, 'machine-id'), 'utf8').trim()
  assert.equal(persisted, id1)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'machine-id')).mode & 0o777, 0o600)
  }

  // 即使后续网卡/主机名改变，仍读回持久化 ID
  const id2 = getStableMachineId(dir, {
    hostname: 'different-host',
    interfaces: { eth1: [{ internal: false, mac: '11:22:33:44:55:66' }] },
  })
  assert.equal(id2, id1)
})

test('registerOrFetchWorkerTunnel: POST 注册、缓存复用、端口变更与强制刷新', async (t) => {
  const dir = makeTempDir(t)
  const calls = []
  const mockFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({
      tunnel_id: 'tun-001',
      token: 'secret-token-from-worker',
      subdomain: 'dshx-1234567890',
      hostname: 'dshx-1234567890.tunnel.example.com',
      public_url: 'https://dshx-1234567890.tunnel.example.com',
      target_port: JSON.parse(init.body).target_port,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const first = await registerOrFetchWorkerTunnel({
    appDir: dir,
    workerUrl: 'https://dispatch.example.com/',
    inviteCode: 'my-invite',
    targetPort: 3781,
    fetchFn: mockFetch,
  })
  assert.equal(first.cached, false)
  assert.equal(first.token, 'secret-token-from-worker')
  assert.equal(first.publicUrl, 'https://dshx-1234567890.tunnel.example.com')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://dispatch.example.com/api/tunnel/register')
  assert.equal(calls[0].init.headers['x-invite-code'], 'my-invite')
  assert.equal(calls[0].body.invite_code, 'my-invite')
  assert.equal(calls[0].body.target_port, 3781)
  assert.match(calls[0].body.machine_id, /^[0-9a-f]{64}$/)

  // 第二次同参数命中缓存，不发网络请求
  const second = await registerOrFetchWorkerTunnel({
    appDir: dir,
    workerUrl: 'https://dispatch.example.com',
    inviteCode: 'my-invite',
    targetPort: 3781,
    fetchFn: mockFetch,
  })
  assert.equal(second.cached, true)
  assert.equal(second.token, 'secret-token-from-worker')
  assert.equal(calls.length, 1)

  // 本地网关端口变更时触发重新注册以同步 Ingress
  const portChanged = await registerOrFetchWorkerTunnel({
    appDir: dir,
    workerUrl: 'https://dispatch.example.com',
    inviteCode: 'my-invite',
    targetPort: 3799,
    fetchFn: mockFetch,
  })
  assert.equal(portChanged.cached, false)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].body.target_port, 3799)

  // forceRefresh 强制刷新
  await registerOrFetchWorkerTunnel({
    appDir: dir,
    workerUrl: 'https://dispatch.example.com',
    inviteCode: 'my-invite',
    targetPort: 3799,
    forceRefresh: true,
    fetchFn: mockFetch,
  })
  assert.equal(calls.length, 3)

  // 邀请码错误返回明确中文提示
  await assert.rejects(
    registerOrFetchWorkerTunnel({
      appDir: dir,
      workerUrl: 'https://dispatch.example.com',
      inviteCode: 'wrong',
      targetPort: 3799,
      forceRefresh: true,
      fetchFn: async () => new Response(JSON.stringify({ error: '邀请码无效' }), { status: 401 }),
    }),
    /鉴权失败.*邀请码无效/,
  )
})

/* ---------------------------------------------------------- 二进制发现与按需下载 */

test('cloudflaredAssetForPlatform & findCloudflaredBinary: 多平台映射与查找优先级', () => {
  assert.equal(cloudflaredAssetForPlatform('win32', 'x64').asset, 'cloudflared-windows-amd64.exe')
  assert.equal(cloudflaredAssetForPlatform('win32', 'arm64').asset, 'cloudflared-windows-amd64.exe')
  assert.equal(cloudflaredAssetForPlatform('darwin', 'arm64').asset, 'cloudflared-darwin-arm64.tgz')
  assert.equal(cloudflaredAssetForPlatform('darwin', 'x64').asset, 'cloudflared-darwin-amd64.tgz')
  assert.equal(cloudflaredAssetForPlatform('linux', 'x64').asset, 'cloudflared-linux-amd64')
  assert.equal(cloudflaredAssetForPlatform('linux', 'arm64').asset, 'cloudflared-linux-arm64')
  assert.throws(() => cloudflaredAssetForPlatform('freebsd', 'x64'), /暂不支持/)

  const managedWin = join('/app', 'bin', 'cloudflared.exe')
  const pathWin = join('/usr/local/bin', 'cloudflared.exe')
  assert.equal(
    findCloudflaredBinary('/app', {
      platform: 'win32',
      envPath: '/usr/local/bin;/other',
      existsSync: (p) => p === managedWin || p === pathWin,
    }),
    managedWin,
  )
  assert.equal(
    findCloudflaredBinary('/app', {
      platform: 'win32',
      envPath: '/usr/local/bin;/other',
      existsSync: (p) => p === pathWin,
    }),
    pathWin,
  )
  assert.equal(
    findCloudflaredBinary('/app', {
      platform: 'linux',
      envPath: '/usr/bin:/usr/local/bin',
      existsSync: () => false,
    }),
    null,
  )
})

test('ensureCloudflaredBinary: 镜像回退直连、进度回调、原子落盘、macOS tgz 与 --version 校验', async (t) => {
  const dir = makeTempDir(t)
  const requestedUrls = []
  const progressEvents = []
  const verifiedCalls = []

  // Linux 原始二进制 + 镜像失败后回退直连
  const linuxBin = await ensureCloudflaredBinary(dir, {
    platform: 'linux',
    arch: 'x64',
    envPath: '',
    mirrorPrefix: 'https://gh-proxy.com/',
    fetchFn: async (url) => {
      requestedUrls.push(url)
      if (url.startsWith('https://gh-proxy.com/')) {
        return new Response('mirror down', { status: 502 })
      }
      const bytes = Buffer.from('#!/bin/sh\necho cloudflared 2026.1.0\n')
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })
    },
    onProgress: (p) => progressEvents.push(p),
    execFileFn: async (bin, args) => {
      verifiedCalls.push({ bin, args })
      return { stdout: 'cloudflared version 2026.1.0', stderr: '' }
    },
  })

  assert.equal(linuxBin, join(dir, 'bin', 'cloudflared'))
  assert.equal(existsSync(linuxBin), true)
  assert.equal(requestedUrls.length, 2)
  assert.equal(requestedUrls[0].startsWith('https://gh-proxy.com/https://github.com/cloudflare/cloudflared/'), true)
  assert.equal(requestedUrls[1].startsWith('https://github.com/cloudflare/cloudflared/'), true)
  assert.ok(progressEvents.length >= 1)
  assert.deepEqual(verifiedCalls[0], { bin: linuxBin, args: ['--version'] })

  // macOS .tgz 解压路径验证
  const macDir = makeTempDir(t)
  let extractedArchive = false
  const macBin = await ensureCloudflaredBinary(macDir, {
    platform: 'darwin',
    arch: 'arm64',
    envPath: '',
    fetchFn: async () => new Response(Buffer.from('fake-tgz-bytes'), { status: 200 }),
    extractTgzFn: async (_archivePath, destDir) => {
      extractedArchive = true
      writeFileSync(join(destDir, 'cloudflared'), 'fake-mach-o')
    },
    execFileFn: async () => ({ stdout: 'cloudflared version 2026.1.0', stderr: '' }),
  })
  assert.equal(extractedArchive, true)
  assert.equal(macBin, join(macDir, 'bin', 'cloudflared'))
  assert.equal(existsSync(macBin), true)

  // --version 校验失败时必须清理已落盘的坏文件
  const badDir = makeTempDir(t)
  await assert.rejects(
    ensureCloudflaredBinary(badDir, {
      platform: 'win32',
      arch: 'x64',
      envPath: '',
      fetchFn: async () => new Response(Buffer.from('<html>502</html>'), { status: 200 }),
      execFileFn: async () => { throw new Error('not a valid executable') },
    }),
    /校验失败/,
  )
  assert.equal(existsSync(join(badDir, 'bin', 'cloudflared.exe')), false)
})

/* ---------------------------------------------------------- buildTunnelArgs */

test('buildTunnelArgs: 正确放置前置/后置参数且绝不将 token 放入 argv', () => {
  const secretToken = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJ0b2tlbi1zZWNyZXQiLCJzIjoiYWJjIn0='
  const tokenArgs = buildTunnelArgs({
    mode: 'token',
    token: secretToken,
    edgeIPVersion: '4',
    region: 'us',
    protocol: 'http2',
    dnsResolverAddrs: ['1.1.1.1:53', '8.8.8.8:53'],
  })
  assert.deepEqual(tokenArgs, [
    'tunnel',
    '--edge-ip-version', '4',
    '--region', 'us',
    'run',
    '--protocol', 'http2',
    '--dns-resolver-addrs', '1.1.1.1:53,8.8.8.8:53',
  ])
  assert.equal(tokenArgs.includes('--token'), false)
  assert.equal(tokenArgs.some((arg) => arg.includes(secretToken)), false)

  const workerArgs = buildTunnelArgs({
    mode: 'worker',
    token: secretToken,
    edgeIPVersion: 'auto',
    protocol: 'http2',
  })
  assert.deepEqual(workerArgs, ['tunnel', '--edge-ip-version', 'auto', 'run', '--protocol', 'http2'])
  assert.equal(workerArgs.includes('--token'), false)

  const quickArgs = buildTunnelArgs({
    mode: 'quick',
    targetPort: 3781,
    edgeIPVersion: '6',
    protocol: 'http2',
  })
  assert.deepEqual(quickArgs, [
    'tunnel',
    '--edge-ip-version', '6',
    '--url', 'http://127.0.0.1:3781',
    '--protocol', 'http2',
  ])

  assert.throws(() => buildTunnelArgs({ mode: 'quick', targetPort: 0 }), /targetPort/)
  assert.throws(() => buildTunnelArgs({ mode: 'unknown' }), /不支持/)
})

/* ------------------------------------------------ CloudflareTunnelManager */

test('CloudflareTunnelManager: worker 模式完整启动、凭据仅在 env、就绪与干净停机', async (t) => {
  const dir = makeTempDir(t)
  const spawns = []
  const statuses = []
  const secretToken = 'worker-secret-token-xyz'

  const manager = new CloudflareTunnelManager({
    appDir: dir,
    onStatus: (s) => statuses.push(s),
    ensureBinaryFn: async () => '/fake/bin/cloudflared',
    registerWorkerFn: async () => ({
      tunnelId: 'tun-1',
      token: secretToken,
      subdomain: 'dshx-abc123',
      hostname: 'dshx-abc123.example.com',
      publicUrl: 'https://dshx-abc123.example.com',
      cached: false,
    }),
    probeFn: async () => ({
      v4RttMs: 40,
      v6RttMs: 130,
      polluted: ['31.13.66.1'],
      chosen: '4',
      fakeIPDetected: false,
    }),
    spawnFn: (bin, args, opts) => {
      const child = createFakeChild({ pid: 9001 })
      spawns.push({ bin, args, opts, child })
      return child
    },
  })

  await manager.start({
    mode: 'worker',
    workerUrl: 'https://dispatch.example.com',
    inviteCode: 'code-1',
    targetPort: 3781,
  })

  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].bin, '/fake/bin/cloudflared')
  assert.equal(spawns[0].opts.windowsHide, true)
  assert.equal(spawns[0].opts.env.TUNNEL_TOKEN, secretToken)
  assert.equal(spawns[0].args.includes(secretToken), false)
  assert.equal(spawns[0].args.includes('--token'), false)
  assert.deepEqual(spawns[0].args, ['tunnel', '--edge-ip-version', '4', 'run', '--protocol', 'http2'])

  // 模拟 cloudflared 输出注册成功日志
  spawns[0].child.stderr.write('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0 location=hkg05\n')
  spawns[0].child.stderr.write('2026-01-01T00:00:01Z INF Registered tunnel connection connIndex=1 location=sin02\n')
  await waitFor(() => manager.getStatus().locations.length === 2)

  const st = manager.getStatus()
  assert.equal(st.state, 'running')
  assert.equal(st.mode, 'worker')
  assert.equal(st.publicUrl, 'https://dshx-abc123.example.com')
  assert.equal(st.subdomain, 'dshx-abc123')
  assert.deepEqual(st.locations, ['hkg05', 'sin02'])
  assert.equal(st.pid, 9001)
  assert.equal(JSON.stringify(st).includes(secretToken), false)
  assert.ok(statuses.some((s) => s.state === 'probing'))
  assert.ok(statuses.some((s) => s.state === 'running'))

  await manager.stop()
  assert.equal(manager.getStatus().state, 'stopped')
  assert.equal(manager.getStatus().pid, null)
  assert.ok(spawns[0].child.killSignals.length >= 1)
})

test('CloudflareTunnelManager: Quick 模式解析临时域名 + IPv6 TLS EOF 自动回落 IPv4', async (t) => {
  const dir = makeTempDir(t)
  const spawns = []

  const manager = new CloudflareTunnelManager({
    appDir: dir,
    ensureBinaryFn: async () => '/fake/bin/cloudflared',
    probeFn: async () => ({
      v4RttMs: 95,
      v6RttMs: 90,
      polluted: [],
      chosen: 'auto',
      fakeIPDetected: false,
    }),
    spawnFn: (bin, args, opts) => {
      const child = createFakeChild({ pid: 7000 + spawns.length })
      spawns.push({ bin, args, opts, child })
      return child
    },
  })

  await manager.start({ mode: 'quick', targetPort: 3781 })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].opts.env.TUNNEL_TOKEN, undefined)
  assert.deepEqual(spawns[0].args, ['tunnel', '--edge-ip-version', 'auto', '--url', 'http://127.0.0.1:3781', '--protocol', 'http2'])

  // 触发 IPv6 TLS 握手 EOF -> 自动切 IPv4 重拉
  spawns[0].child.stderr.write('2026-01-01T00:00:00Z ERR dial tcp [2606:4700::1]:7844: unexpected EOF\n')
  await waitFor(() => spawns.length === 2)
  assert.deepEqual(spawns[1].args, ['tunnel', '--edge-ip-version', '4', '--url', 'http://127.0.0.1:3781', '--protocol', 'http2'])

  // 第二次以 IPv4 成功拿到 Quick URL 并注册
  spawns[1].child.stderr.write('INF | https://lucky-pine-tree.trycloudflare.com |\n')
  spawns[1].child.stderr.write('INF Registered tunnel connection connIndex=0 location=nrt01\n')
  await waitFor(() => manager.getStatus().state === 'running')

  const st = manager.getStatus()
  assert.equal(st.publicUrl, 'https://lucky-pine-tree.trycloudflare.com')
  assert.equal(st.subdomain, 'lucky-pine-tree')
  assert.deepEqual(st.locations, ['nrt01'])

  await manager.stop()
})

test('CloudflareTunnelManager: 意外崩溃指数退避重拉与 stop() 超时强杀不留孤儿', async (t) => {
  const dir = makeTempDir(t)
  const spawns = []

  const manager = new CloudflareTunnelManager({
    appDir: dir,
    baseBackoffMs: 40,
    maxBackoffMs: 120,
    killGraceMs: 40,
    ensureBinaryFn: async () => '/fake/bin/cloudflared',
    spawnFn: (bin, args, opts) => {
      // 最后一个进程故意忽略 SIGTERM，用于验证 stop() 的 SIGKILL 兜底
      const child = createFakeChild({ pid: 8000 + spawns.length, ignoreSigterm: spawns.length === 1 })
      spawns.push({ bin, args, opts, child })
      return child
    },
  })

  await manager.start({
    mode: 'token',
    token: 'tok-abc',
    publicUrl: 'https://my.example.com',
    edgeIPVersion: '4',
  })
  assert.equal(spawns.length, 1)

  // 运行期检测到污染 IP 告警
  spawns[0].child.stderr.write('ERR Unable to connect to 31.13.66.9:7844 timeout\n')
  await waitFor(() => manager.getStatus().edgeProbe?.polluted?.includes('31.13.66.9'))

  // 子进程意外退出 -> 进入 error 并指数退避重拉
  spawns[0].child.crash(1)
  assert.equal(manager.getStatus().state, 'error')
  await waitFor(() => spawns.length === 2, 1000)

  // 第二次拉起后恢复 running
  spawns[1].child.stderr.write('INF Registered tunnel connection connIndex=0 location=lax02\n')
  await waitFor(() => manager.getStatus().state === 'running')

  // stop() 面对忽略 SIGTERM 的子进程必须升级 SIGKILL 并干净结束
  await manager.stop()
  assert.equal(manager.getStatus().state, 'stopped')
  assert.equal(spawns[1].child.killSignals.includes('SIGKILL'), true)

  // 停机后不再触发任何重启
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(spawns.length, 2)
})

/* ------------------------------------------------ Worker 模板离线验证 */

test('docs/cloudflare-worker/worker.js: 校验邀请码、动态端口与幂等创建流程', async () => {
  const prevFetch = globalThis.fetch
  const cfCalls = []
  globalThis.fetch = async (url, init = {}) => {
    cfCalls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (String(url).includes('/cfd_tunnel?')) {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })
    }
    if (String(url).endsWith('/cfd_tunnel') && init.method === 'POST') {
      return new Response(JSON.stringify({ success: true, result: { id: 'cf-tun-99' } }), { status: 200 })
    }
    if (String(url).endsWith('/token')) {
      return new Response(JSON.stringify({ success: true, result: 'cf-token-99' }), { status: 200 })
    }
    if (String(url).endsWith('/configurations')) {
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    }
    if (String(url).includes('/dns_records?')) {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })
    }
    if (String(url).endsWith('/dns_records') && init.method === 'POST') {
      return new Response(JSON.stringify({ success: true, result: { id: 'dns-1' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: false }), { status: 404 })
  }

  try {
    const env = {
      CF_ACCOUNT_ID: 'acc-1',
      CF_ZONE_ID: 'zone-1',
      CF_API_TOKEN: 'api-tok',
      BASE_DOMAIN: 'tunnel.example.com',
      INVITE_CODE: 'secret-invite',
      TARGET_PORT: '3781',
    }

    // 1. /health 正常
    const healthRes = await workerHandler.fetch(new Request('https://w.example.com/health'), env)
    assert.equal(healthRes.status, 200)
    assert.equal((await healthRes.json()).ok, true)

    // 2. 邀请码错误 -> 401
    const badRes = await workerHandler.fetch(new Request('https://w.example.com/api/tunnel/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-invite-code': 'wrong' },
      body: JSON.stringify({ machine_id: 'a'.repeat(64), target_port: 3900 }),
    }), env)
    assert.equal(badRes.status, 401)

    // 3. 正确注册 -> dshx-<shortId> + 动态端口 3900 + Proxied CNAME
    const okRes = await workerHandler.fetch(new Request('https://w.example.com/api/tunnel/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-invite-code': 'secret-invite' },
      body: JSON.stringify({ machine_id: 'a'.repeat(64), target_port: 3900 }),
    }), env)
    assert.equal(okRes.status, 200)
    const body = await okRes.json()
    assert.equal(body.tunnel_id, 'cf-tun-99')
    assert.equal(body.token, 'cf-token-99')
    assert.match(body.subdomain, /^dshx-[0-9a-f]{10}$/)
    assert.equal(body.public_url, `https://${body.subdomain}.tunnel.example.com`)
    assert.equal(body.target_port, 3900)

    const ingressCall = cfCalls.find((c) => c.url.endsWith('/configurations'))
    assert.equal(ingressCall.body.config.ingress[0].service, 'http://127.0.0.1:3900')
    const dnsCall = cfCalls.find((c) => c.url.endsWith('/dns_records') && c.method === 'POST')
    assert.equal(dnsCall.body.proxied, true)
    assert.equal(dnsCall.body.content, 'cf-tun-99.cfargotunnel.com')
  } finally {
    globalThis.fetch = prevFetch
  }
})
