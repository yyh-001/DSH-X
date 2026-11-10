// #102：dsh 页面 / agent 的插件操作会剥掉 DSH_* 变量，核心写在 node/ 旁边的
// electron-bin 标记是 node 包装脚本唯一的兜底路径（安装盘不是 %APPDATA%\DSH 时）。

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { ELECTRON_BIN_FILE, electronBinMarkerPath, nodeShimPosix, nodeShimWindows, writeElectronBinMarker } from '../src/electron-bin.js'

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-electron-bin-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('标记写在 core 目录旁边：核心更新只换 current，标记原地留下', () => {
  const { root, cleanup } = scratch()
  try {
    const core = join(root, 'core', 'current')
    mkdirSync(join(core, 'node'), { recursive: true })
    const written = writeElectronBinMarker({ coreDir: core, execPath: 'D:\\Program Files\\DSH\\DSH.exe', inElectron: true })
    assert.equal(written, join(root, 'core', ELECTRON_BIN_FILE))
    assert.equal(readFileSync(written, 'utf8'), 'D:\\Program Files\\DSH\\DSH.exe\n')
    assert.equal(electronBinMarkerPath(core), written)
  } finally {
    cleanup()
  }
})

test('源码运行（核心目录没有 node/）不写，别往仓库里丢文件', () => {
  const { root, cleanup } = scratch()
  try {
    const src = join(root, 'src')
    mkdirSync(src, { recursive: true })
    assert.equal(writeElectronBinMarker({ coreDir: src, execPath: '/usr/bin/electron', inElectron: true }), '')
  } finally {
    cleanup()
  }
})

test('不在 Electron 里（跑测试 / dsh CLI）不写', () => {
  const { root, cleanup } = scratch()
  try {
    const core = join(root, 'core', 'current')
    mkdirSync(join(core, 'node'), { recursive: true })
    assert.equal(writeElectronBinMarker({ coreDir: core, execPath: '/usr/bin/node', inElectron: false }), '')
  } finally {
    cleanup()
  }
})

test('标记写不进去时不抛错（核心还得能启动）', () => {
  const core = join('C:', 'missing-parent', 'core', 'current')
  const written = writeElectronBinMarker({
    coreDir: core,
    execPath: 'D:\\DSH.exe',
    inElectron: true,
    exists: () => true,
    makeDir: () => { throw new Error('EACCES') },
  })
  assert.equal(written, '')
})

test('node 包装：先认 DSH_ELECTRON_BIN，再认标记，最后回退旧安装布局', () => {
  const windows = nodeShimWindows()
  assert.match(windows, /IF DEFINED DSH_ELECTRON_BIN GOTO dshElectron/)
  assert.match(windows, /%~dp0\.\.\\\.\.\\electron-bin/)
  assert.match(windows, /"%~dp0\.\.\\\.\.\\\.\.\\DSH\.exe" %\*/)

  const posix = nodeShimPosix()
  assert.match(posix, /\$DSH_ELECTRON_BIN/)
  assert.match(posix, /\$dir\/\.\.\/\.\.\/electron-bin/)
  assert.match(posix, /\$dir\/\.\.\/\.\.\/\.\.\/MacOS\/DSH/)
})

test('打包的文件清单要带 electron-bin.js，否则核心包起不来', () => {
  assert.match(readFileSync(new URL('../scripts/pack-common.mjs', import.meta.url), 'utf8'), /'electron-bin\.js',/)
  assert.match(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'), /writeElectronBinMarker\(\{ coreDir: ROOT, execPath: process\.execPath, inElectron: IN_ELECTRON \}\)/)
})

// 真跑一遍 cmd：标记指到假的 Electron（.cmd 替身），确认能转调、退出码也传得出来。
// 这条是 #102 的复现路径 —— 没有 DSH_ELECTRON_BIN、安装根也不是 core 的三级父目录。
test('Windows 包装脚本经标记转调目标并透传退出码', { skip: process.platform !== 'win32' }, () => {
  const { root, cleanup } = scratch()
  try {
    const core = join(root, 'DSH', 'core', 'current')
    const nodeDir = join(core, 'node')
    mkdirSync(nodeDir, { recursive: true })
    writeFileSync(join(nodeDir, 'node.cmd'), nodeShimWindows())
    const fake = join(root, 'fake-electron.cmd')
    writeFileSync(fake, '@ECHO off\r\nECHO fake-electron %*\r\nEXIT /b 5\r\n')
    writeFileSync(join(root, 'DSH', 'core', ELECTRON_BIN_FILE), `${fake}\n`)

    const env = { ...process.env }
    delete env.DSH_ELECTRON_BIN
    const result = spawnSync('cmd.exe', ['/d', '/c', 'node.cmd', '--version'], { cwd: nodeDir, env, encoding: 'utf8', windowsHide: true })
    assert.match(String(result.stdout), /fake-electron --version/, result.stderr || String(result.status))
    assert.equal(result.status, 5)
  } finally {
    cleanup()
  }
})
