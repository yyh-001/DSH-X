import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { safeConnection, safeConnections, safeLaunchPresets } from '../src/settings.js'
import { createSecretStore } from '../src/secret-store.js'
import { listSshConfigAliases } from '../src/ssh-config.js'

test('连接校验：WSL 需要发行版，SSH 需要主机/用户，坏条目不影响其他连接', () => {
  const wsl = safeConnection({ id: 'abcdef0123456789', kind: 'wsl', name: '开发', wslDistro: 'Debian', wslUser: 'root' })
  assert.deepEqual(wsl, { id: 'abcdef0123456789', name: '开发', kind: 'wsl', wslDistro: 'Debian', wslUser: 'root' })
  assert.equal(safeConnection({ kind: 'wsl', name: 'x' }), null, '没发行版不能保存')
  const ssh = safeConnection({
    id: '1111111111111111', kind: 'ssh', name: '服务器', host: '10.0.0.2', port: '2200',
    username: 'root', authType: 'key', privateKeyPath: '~/.ssh/id_ed25519',
  })
  assert.equal(ssh.host, '10.0.0.2')
  assert.equal(ssh.port, 2200)
  assert.equal(ssh.authType, 'key')
  assert.ok(ssh.privateKeyPath.startsWith(homedir()), '~ 展开成绝对路径')
  assert.equal(safeConnection({ kind: 'ssh', name: 'x', host: 'h' }), null, '没用户名不能保存')
  const list = safeConnections([wsl, { kind: 'wsl' }, ssh, { kind: 'wsl', wslDistro: 'Debian', wslUser: 'root' }])
  assert.equal(list.length, 2, '重复目标去重，坏条目丢弃')
})

test('启动项新字段：connectionId/remoteHome/workdir，SSH 必须有连接', () => {
  const wsl = safeLaunchPresets([{
    id: 'aaaaaaaaaaaaaaaa', name: 'WSL', version: 'auto', profile: 'web',
    backend: 'wsl', connectionId: 'abcdef0123456789', remoteHome: '~/.dsh-work', workdir: '/root/demo',
  }]).find((item) => item.id === 'aaaaaaaaaaaaaaaa')
  assert.equal(wsl.connectionId, 'abcdef0123456789')
  assert.equal(wsl.remoteHome, '~/.dsh-work')
  assert.equal(wsl.workdir, '/root/demo')
  assert.equal(wsl.wslHome, '~/.dsh-work', '旧字段继续保留给老调用方')
  const ssh = safeLaunchPresets([{
    id: 'bbbbbbbbbbbbbbbb', name: 'SSH', version: 'auto', profile: 'web',
    backend: 'ssh', connectionId: '1111111111111111', remoteHome: '/srv/.dsh',
  }]).find((item) => item.id === 'bbbbbbbbbbbbbbbb')
  assert.equal(ssh.backend, 'ssh')
  assert.equal(ssh.remoteHome, '/srv/.dsh')
  const invalid = safeLaunchPresets([{ id: 'cccccccccccccccc', name: '坏 SSH', version: 'auto', profile: 'web', backend: 'ssh' }])
  assert.ok(!invalid.some((item) => item.id === 'cccccccccccccccc'), '没有连接的 SSH 启动项丢弃')
})

test('凭据信封：AES 来回、密文不含明文、换钥匙解不开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-'))
  try {
    const keyFile = join(dir, 'key')
    const store = createSecretStore({ keyFile, forceFileKey: true })
    const envelope = store.protect('hello-密码')
    assert.match(envelope, /^v1:[A-Za-z0-9+/=]+$/)
    assert.equal(envelope.includes('hello'), false)
    assert.equal(store.reveal(envelope), 'hello-密码')
    const other = createSecretStore({ keyFile: join(dir, 'other-key'), forceFileKey: true })
    assert.throws(() => other.reveal(envelope), /无法解密/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SSH config 导入：Host 别名、Include、端口/用户/私钥，通配 Host 不列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-config-'))
  try {
    const config = join(dir, 'config')
    const extra = join(dir, 'extra.conf')
    writeFileSync(config, [
      'Host dev',
      '  HostName 10.0.0.2',
      '  User root',
      '  Port 2200',
      '  IdentityFile ~/.ssh/id_dev',
      `Include ${extra}`,
      'Host *',
      '  User ignored',
    ].join('\n'))
    writeFileSync(extra, ['Host staging', '  HostName staging.example.com', '  User deploy'].join('\n'))
    const { aliases } = listSshConfigAliases({ configPath: config })
    const dev = aliases.find((item) => item.alias === 'dev')
    const staging = aliases.find((item) => item.alias === 'staging')
    assert.ok(dev, '主配置里的 Host')
    assert.equal(dev.host, '10.0.0.2')
    assert.equal(dev.port, 2200)
    assert.equal(dev.username, 'root')
    assert.ok(dev.privateKeyPath.endsWith('id_dev'))
    assert.ok(staging, 'Include 进来的 Host')
    assert.equal(staging.host, 'staging.example.com')
    assert.ok(!aliases.some((item) => item.alias === '*'), '通配 Host 不列')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
