/**
 * 装 dsh 版本时 npm 跑的是生命周期脚本，脚本里的裸 `node` 只在 PATH 里找 —— 而启动器
 * 是用 RUNTIME_NODE 的绝对路径起 npm 的，机器上没装 Node.js（干净的 Windows）就找不到。
 * 实测：0.2.1-rc.5 的 koffi postinstall（`node ./cnoke.cjs`）就是这么挂的，
 * `'node' 不是内部或外部命令`，整个安装以 exit 1 结束。
 *
 * 所以 runNpm 把自带运行时目录追加到 PATH 末尾（见 registry.js withRuntimeNode）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { withRuntimeNode } from '../src/registry.js'

const BUNDLED = '/app/node'

test('打包后：自带运行时目录追加到 PATH 末尾，原有条目一条不动', () => {
  const path = withRuntimeNode('/usr/bin:/bin', {
    dir: BUNDLED,
    sep: ':',
    exists: () => true,
    executable: () => true,
    inElectron: true,
  })
  assert.equal(path, `/usr/bin:/bin:${BUNDLED}`)
})

test('追加不插队：用户的 node 仍排在前面（和 dsh 子进程的 PATH 排序一致）', () => {
  const path = withRuntimeNode('/opt/node/bin:/usr/bin', {
    dir: BUNDLED,
    sep: ':',
    exists: () => true,
    executable: () => true,
    inElectron: true,
  })
  assert.ok(path.indexOf('/opt/node/bin') < path.indexOf(BUNDLED))
})

test('已经在 PATH 里就不重复塞', () => {
  const original = `/usr/bin:${BUNDLED}`
  assert.equal(withRuntimeNode(original, { dir: BUNDLED, sep: ':', exists: () => true, executable: () => true, inElectron: true }), original)
})

test('源码运行没有 node/ 目录：退回 node 自己所在的目录', () => {
  const path = withRuntimeNode('/usr/bin', {
    dir: '/repo/node',
    runtime: '/opt/node/bin/node',
    sep: ':',
    exists: () => false,
    inElectron: false,
  })
  assert.equal(path, '/usr/bin:/opt/node/bin')
})

test('Electron 外壳里没有 node/ 目录时帮不上忙，PATH 原样返回', () => {
  const original = '/usr/bin'
  // Electron 本体所在目录里没有 node.exe，塞进去只会让人以为修好了
  assert.equal(withRuntimeNode(original, {
    dir: '/app/node',
    runtime: '/app/DSH.exe',
    sep: ':',
    exists: () => false,
    inElectron: true,
  }), original)
})

test('空 PATH 也能用', () => {
  assert.equal(withRuntimeNode('', { dir: BUNDLED, sep: ':', exists: () => true, executable: () => true, inElectron: true }), BUNDLED)
})

test('POSIX 的 node 包装没有执行位：不能塞进 PATH，退回真实 node 目录', () => {
  const path = withRuntimeNode('/usr/bin', {
    dir: '/remote/core/node',
    runtime: '/remote/.dsh-x/node/bin/node',
    sep: ':',
    exists: () => true,
    executable: () => false,
    isWindows: false,
    inElectron: false,
  })
  assert.equal(path, '/usr/bin:/remote/.dsh-x/node/bin')
})
