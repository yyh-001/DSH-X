import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REMOTE_REASON,
  buildExportsScript,
  buildHostGatewayCommand,
  buildIdentityScript,
  buildProxyPortProbeCommand,
  formatProxyForLog,
  IDENTITY_MARKER,
  isLoopbackProxyHostname,
  isPrivateOrLinkLocalAddress,
  isValidWslUser,
  parseHostGatewayOutput,
  parseIdentityOutput,
  parseProxyPortProbeOutput,
  pickDistro,
  proxyUrlObject,
  remoteError,
  remoteErrorFields,
  replaceProxyHostname,
  shellQuote,
} from '../src/remote.js'

test('错误码与 retryable：只有超时默认可重试，字段能挂进失败记录', () => {
  const timeout = remoteError(REMOTE_REASON.wslTimeout, '超时')
  assert.equal(timeout.reasonCode, 'wsl-timeout')
  assert.equal(timeout.retryable, true)
  assert.deepEqual(remoteErrorFields(timeout), { code: 'wsl-timeout', retryable: true })
  const missing = remoteError(REMOTE_REASON.distroMissing, '没有发行版')
  assert.equal(missing.retryable, false)
  assert.deepEqual(remoteErrorFields(missing), { code: 'distro-missing', retryable: false })
  assert.deepEqual(remoteErrorFields(new Error('plain')), {})
})

test('身份探测脚本带 marker 和三行输出，解析取最后一次 marker', () => {
  assert.match(buildIdentityScript(), /__DSHX_IDENTITY__/)
  assert.match(buildIdentityScript(), /\$WSL_DISTRO_NAME/)
  assert.match(buildIdentityScript(), /\$\(id -un\)/)
  assert.match(buildIdentityScript(), /\$HOME/)
  const output = [
    'profile noise',
    IDENTITY_MARKER,
    'Debian',
    'root',
    '/root',
    '',
  ].join('\r\n')
  assert.deepEqual(parseIdentityOutput(output), { ok: true, distro: 'Debian', user: 'root', home: '/root', error: '' })
  // profile 里恰好打印了 marker：取最后一次，前面的噪音不参与解析。
  assert.equal(parseIdentityOutput(`${IDENTITY_MARKER}\nnoise\n${output}`).distro, 'Debian')
})

test('身份探测缺 marker / 缺 HOME 都如实失败，不拼一个空身份出来', () => {
  assert.equal(parseIdentityOutput('Debian\nroot\n/root').ok, false)
  const noHome = parseIdentityOutput(`${IDENTITY_MARKER}\nDebian\nroot\n\n`)
  assert.equal(noHome.ok, false)
  assert.match(noHome.error, /HOME/)
})

test('WSL 用户名校验沿用 ZCode 规则：1-64、禁控制字符和 : / \\，空串合法', () => {
  assert.equal(isValidWslUser(''), true)
  assert.equal(isValidWslUser('root'), true)
  assert.equal(isValidWslUser('user.name-1_2'), true)
  assert.equal(isValidWslUser('a'.repeat(64)), true)
  assert.equal(isValidWslUser('a'.repeat(65)), false)
  assert.equal(isValidWslUser('a:b'), false)
  assert.equal(isValidWslUser('a/b'), false)
  assert.equal(isValidWslUser('a\\b'), false)
  assert.equal(isValidWslUser('a\u0000b'), false)
})

test('发行版名大小写不敏感归一；列表没有时不凭空判失败', () => {
  const distros = [
    { name: 'Debian', default: false },
    { name: 'Ubuntu 24.04', default: true },
  ]
  assert.equal(pickDistro('debian', distros).name, 'Debian')
  assert.equal(pickDistro('UBUNTU 24.04', distros).name, 'Ubuntu 24.04')
  assert.equal(pickDistro('', distros).name, 'Ubuntu 24.04')
  assert.equal(pickDistro('fedora', distros).missing, true)
  assert.deepEqual(pickDistro('Fedora', []), { name: 'Fedora', entry: null, listed: false, missing: false })
})

test('shell 引号与 export 行：单引号值安全，坏键名/换行值不进脚本', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  const script = buildExportsScript({
    HTTP_PROXY: 'http://127.0.0.1:7897',
    NO_PROXY: "localhost,127.0.0.1,it's",
    'BAD-KEY': 'x',
    '1BAD': 'x',
    NEWLINE: 'a\nb',
  })
  assert.match(script, /export HTTP_PROXY='http:\/\/127\.0\.0\.1:7897'/)
  assert.match(script, /export NO_PROXY='localhost,127\.0\.0\.1,it'\\''s'/)
  assert.doesNotMatch(script, /BAD-KEY/)
  assert.doesNotMatch(script, /1BAD/)
  assert.doesNotMatch(script, /NEWLINE/)
  assert.equal(buildExportsScript({}), '')
})

test('回环代理判断覆盖 localhost / 127.* / ::1 / 0.0.0.0，非回环原样保留', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '0.0.0.0']) {
    assert.equal(isLoopbackProxyHostname(host), true, host)
  }
  for (const host of ['172.30.64.1', 'example.com', '192.168.1.2', '::2', '10.0.0.1']) {
    assert.equal(isLoopbackProxyHostname(host), false, host)
  }
  assert.equal(proxyUrlObject('http://127.0.0.1:7897').hostname, '127.0.0.1')
  assert.equal(proxyUrlObject('socks5://127.0.0.1:7897'), null)
  assert.equal(proxyUrlObject('nope'), null)
})

test('改写代理 host：保留协议/端口/用户名密码，IPv6 自动补方括号', () => {
  assert.equal(replaceProxyHostname('http://127.0.0.1:7897', '172.30.64.1'), 'http://172.30.64.1:7897/')
  assert.equal(replaceProxyHostname('http://user:pass@localhost:7890', '172.30.64.1'), 'http://user:pass@172.30.64.1:7890/')
  assert.equal(replaceProxyHostname('http://[::1]:7890', 'fe80::1'), 'http://[fe80::1]:7890/')
})

test('代理端口探测命令：默认端口、https 443、IPv6 方括号；无效地址不出命令', () => {
  const plain = buildProxyPortProbeCommand('http://127.0.0.1:7897')
  assert.match(plain, /127\.0\.0\.1\/7897/)
  assert.match(plain, /timeout 1 bash -c/)
  assert.match(plain, /printf reachable/)
  assert.match(buildProxyPortProbeCommand('https://localhost'), /localhost\/443/)
  assert.match(buildProxyPortProbeCommand('http://[::1]:7890'), /\[::1\]\/7890/)
  assert.equal(buildProxyPortProbeCommand('socks5://127.0.0.1:7890'), '')
  assert.equal(parseProxyPortProbeOutput('reachable'), true)
  assert.equal(parseProxyPortProbeOutput('unreachable'), false)
  assert.equal(parseProxyPortProbeOutput('weird'), undefined)
})

test('宿主网关：route 优先，resolv 只认私有/链路本地，回环跳过', () => {
  const command = buildHostGatewayCommand()
  assert.match(command, /ip route show default/)
  assert.match(command, /nameserver/)
  assert.equal(parseHostGatewayOutput('route=172.30.64.1 resolv=10.255.255.254'), '172.30.64.1')
  assert.equal(parseHostGatewayOutput('resolv=10.255.255.254'), '10.255.255.254')
  assert.equal(parseHostGatewayOutput('resolv=8.8.8.8'), '')
  assert.equal(parseHostGatewayOutput('resolv=127.0.0.1'), '')
  assert.equal(parseHostGatewayOutput('route=::1'), '')
  assert.equal(parseHostGatewayOutput('resolv=fe80::1'), 'fe80::1')
  assert.equal(isPrivateOrLinkLocalAddress('192.168.1.1'), true)
  assert.equal(isPrivateOrLinkLocalAddress('172.31.0.1'), true)
  assert.equal(isPrivateOrLinkLocalAddress('172.32.0.1'), false)
  assert.equal(isPrivateOrLinkLocalAddress('169.254.1.1'), true)
  assert.equal(isPrivateOrLinkLocalAddress('8.8.8.8'), false)
  assert.equal(isPrivateOrLinkLocalAddress('fd00::1'), true)
  assert.equal(isPrivateOrLinkLocalAddress('2001:db8::1'), false)
})

test('启动日志里的代理地址不泄露用户名密码', () => {
  assert.equal(formatProxyForLog('http://user:pass@127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(formatProxyForLog('http://[::1]:7890'), 'http://[::1]:7890')
  assert.equal(formatProxyForLog('nope'), '<invalid-proxy>')
})
