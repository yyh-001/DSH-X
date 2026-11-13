import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoteCoreInstallScript,
  buildRemoteCoreStartScript,
  parseRemoteCoreReady,
  resolveWslInstallRoot,
  WslRemoteCore,
} from '../src/remote-core.js'

test('远端 core 安装脚本：默认目录保留 $HOME 展开，版本号校验', () => {
  const script = buildRemoteCoreInstallScript({ version: '0.1.27-rc.1' })
  assert.match(script, /root="\$HOME\/\.dsh-x\/core\/0\.1\.27-rc\.1"/)
  assert.match(script, /npm install .*'dsh-x-core@0\.1\.27-rc\.1'/)
  assert.match(script, /__DSHX_CORE_INSTALLED__/)
  assert.throws(() => buildRemoteCoreInstallScript({ version: '../evil' }), /版本号/)
  // 自定义绝对路径仍然按单引号安全传入
  const custom = buildRemoteCoreInstallScript({ version: '1.2.3', installRoot: '/opt/dsh-core' })
  assert.match(custom, /root='\/opt\/dsh-core'/)
})

test('远端 core 启动脚本：配置目录/端口/不自动开浏览器', () => {
  const script = buildRemoteCoreStartScript({
    version: '0.1.27-rc.1',
    port: 45678,
    configRoot: '$HOME/.dsh-x/core-config',
    env: { HTTP_PROXY: 'http://172.30.64.1:7897', NODE_USE_ENV_PROXY: '1' },
  })
  assert.match(script, /export HTTP_PROXY='http:\/\/172\.30\.64\.1:7897'/)
  assert.match(script, /export NODE_USE_ENV_PROXY='1'/)
  assert.match(script, /cd "\$HOME\/\.dsh-x\/core\/0\.1\.27-rc\.1"/)
  assert.match(script, /XDG_CONFIG_HOME="\$HOME\/\.dsh-x\/core-config" PORT=45678 DSH_NO_OPEN=1 exec node node_modules\/dsh-x-core\/start\.js/)
  assert.throws(() => buildRemoteCoreStartScript({ version: '1.2.3', port: 0 }), /端口/)
})

test('远端 core 的 ready 行只认带 token 的管理页地址', () => {
  assert.deepEqual(parseRemoteCoreReady('DSH 管理器 http://127.0.0.1:3802/?token=abc_DEF-123\n'), { port: 3802, token: 'abc_DEF-123' })
  assert.equal(parseRemoteCoreReady('dsh-versions: http://127.0.0.1:3802\n'), null)
  assert.equal(parseRemoteCoreReady(''), null)
})

test('安装探测：$HOME 展开成真实路径，判断 start.js 是否存在', async () => {
  assert.equal(resolveWslInstallRoot('$HOME/.dsh-x/core/1.2.3', '/home/dev'), '/home/dev/.dsh-x/core/1.2.3')
  assert.equal(resolveWslInstallRoot('~/.dsh-x/core/1.2.3', '/home/dev'), '/home/dev/.dsh-x/core/1.2.3')
  assert.equal(resolveWslInstallRoot('/opt/dsh-core', '/home/dev'), '/opt/dsh-core')
  const calls = []
  const backend = {
    async resolveIdentity() { return { user: 'dev', home: '/home/dev' } },
    async exec(script) {
      calls.push(script)
      return { ok: true, stdout: script.includes('test -f') ? 'yes\n' : '', stderr: '' }
    },
  }
  const core = new WslRemoteCore({ distro: 'Debian', version: '1.2.3', backend })
  const result = await core.inspectInstall()
  assert.equal(result.installed, true)
  assert.equal(result.root, '/home/dev/.dsh-x/core/1.2.3')
  assert.equal(result.identity.user, 'dev')
  assert.match(calls[0], /test -f '\/home\/dev\/\.dsh-x\/core\/1\.2\.3\/node_modules\/dsh-x-core\/start\.js'/)
})

test('安装时把进度和日志回调交给连接准备弹窗', async () => {
  const events = []
  const logs = []
  const backend = {
    async resolveIdentity() { return { user: 'root', home: '/root' } },
    async resolveRuntimeProxy() { return { via: 'none' } },
    async exec() { return { ok: true, stdout: '__DSHX_CORE_INSTALLED__\n', stderr: '' } },
  }
  const core = new WslRemoteCore({ distro: 'Debian', version: '1.2.3', backend })
  await core.install({
    onProgress: (progress) => events.push(progress),
    onLog: (line) => logs.push(line),
  })
  assert.equal(events.at(-1)?.percent, 100)
  assert.ok(events.some((item) => item.label === '正在安装依赖…'))
  assert.ok(logs.some((line) => line.includes('安装完成')))
})
