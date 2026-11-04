import assert from 'node:assert/strict'
import test from 'node:test'

import { WSL_AGENT_SCRIPT } from '../src/wsl-scripts.js'
import {
  DEFAULT_HOME,
  WSL_SERVICE_MODE,
  decodeWslOutput,
  parseWslDistroList,
  parseWslHomeKey,
  resolveWslHome,
  wslAvailable,
  wslHomeKey,
} from '../src/wsl.js'

// WSL 相关纯函数测试：不启动真实 wsl.exe，保证 macOS / Linux 开发机和 CI 也能跑。

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

test('wsl.exe 的 UTF-16LE 输出能解码，普通 UTF-8 不被误判', () => {
  const text = '  NAME  STATE  VERSION\r\n* Fedora  Running  2\r\n'
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.match(decodeWslOutput(utf16), /Fedora/)
  assert.match(decodeWslOutput(Buffer.from('Fedora Running', 'utf8')), /^Fedora Running$/)
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '')
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
