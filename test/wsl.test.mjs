import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  buildAgentInstallScript,
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
