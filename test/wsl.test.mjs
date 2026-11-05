import assert from 'node:assert/strict'
import test from 'node:test'

import { WSL_AGENT_SCRIPT, WSL_BRIDGE_SCRIPT, WSL_HELPER_SCRIPT, WSL_SYSTEMD_SCRIPT } from '../src/wsl-scripts.js'
import { safeWslServiceMode } from '../src/settings.js'
import {
  DEFAULT_HOME,
  WSL_SERVICE_MODE,
  WSL_SERVICE_MODES,
  decodeWslOutput,
  normalizeWslServiceMode,
  parseWslDistroList,
  parseWslHomeKey,
  resolveWslHome,
  wslAvailable,
  wslHomeKey,
  wslListErrorText,
  wslProbeNeeded,
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

test('没有 WSL 启动项和默认发行版时不轮询 wsl.exe', () => {
  assert.equal(wslProbeNeeded([], { defaultDistro: '' }), false)
  assert.equal(wslProbeNeeded([{ backend: 'local' }], null), false)
  assert.equal(wslProbeNeeded([{ backend: 'wsl' }], { defaultDistro: '' }), true)
  assert.equal(wslProbeNeeded([], { defaultDistro: 'Fedora' }), true)
})

test('wsl --list 失败时原因从 stderr 退回 UTF-16 stdout', () => {
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.equal(wslListErrorText({ stdout: utf16('没有已安装的分发。\r\n第二行'), stderr: '' }), '没有已安装的分发。')
  assert.equal(wslListErrorText({ stdout: Buffer.alloc(0), stderr: 'boom\nignored' }), 'boom')
  assert.equal(wslListErrorText({ stdout: Buffer.alloc(0), stderr: '', timedOut: true }), 'wsl --list 超时')
  assert.equal(wslListErrorText({ stdout: Buffer.alloc(0), stderr: '' }), 'wsl --list 失败')
})

test('服务模式只认 wrapper / systemd，未知值回 wrapper', () => {
  assert.deepEqual(WSL_SERVICE_MODES, ['wrapper', 'systemd'])
  assert.equal(normalizeWslServiceMode('wrapper'), 'wrapper')
  assert.equal(normalizeWslServiceMode('systemd'), 'systemd')
  assert.equal(normalizeWslServiceMode('systemd '), 'wrapper')
  assert.equal(normalizeWslServiceMode(''), 'wrapper')
  assert.equal(safeWslServiceMode('systemd'), 'systemd')
  assert.equal(safeWslServiceMode('bad'), 'wrapper')
})

test('systemd 脚本：user unit 用专用 unit 名，前台 exec dsh，停止会停 unit 和桥', () => {
  assert.match(WSL_SYSTEMD_SCRIPT, /unit_dir="\$HOME\/\.config\/systemd\/user"/)
  assert.match(WSL_SYSTEMD_SCRIPT, /dsh-x-\$id\.service/)
  assert.match(WSL_SYSTEMD_SCRIPT, /Restart=on-failure/)
  assert.match(WSL_SYSTEMD_SCRIPT, /KillMode=control-group/)
  assert.match(WSL_SYSTEMD_SCRIPT, /systemctl --user start/)
  assert.match(WSL_SYSTEMD_SCRIPT, /systemctl --user stop/)
  assert.match(WSL_SYSTEMD_SCRIPT, /exec \$\(printf '%q' "\$dsh_cmd"\)/)
})

test('Runtime Bridge 和插件代理脚本带完整协议与开关入口', () => {
  assert.match(WSL_BRIDGE_SCRIPT, /method === 'ping'/)
  assert.match(WSL_BRIDGE_SCRIPT, /method === 'getStatus'/)
  assert.match(WSL_BRIDGE_SCRIPT, /method === 'getRuntimeInfo'/)
  assert.match(WSL_BRIDGE_SCRIPT, /method === 'shutdown'/)
  assert.match(WSL_BRIDGE_SCRIPT, /request\.token !== token/)
  assert.match(WSL_HELPER_SCRIPT, /from '\.\/plugins\.mjs'/)
  assert.match(WSL_HELPER_SCRIPT, /setPluginEnabled/)
  assert.match(WSL_HELPER_SCRIPT, /__DSHX_JSON__/)
})
