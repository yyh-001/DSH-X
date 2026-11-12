import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoteCoreInstallScript,
  buildRemoteCoreStartScript,
  parseRemoteCoreReady,
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
