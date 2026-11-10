// node/ 里的 node / node.cmd 包装要在没有 DSH_ELECTRON_BIN 时转调 Electron 本体。
//
// 外壳和核心拆开后，核心住在用户目录的 core/current，包装脚本按 `..\..\..` 猜安装根
// 只会猜到 %APPDATA%\DSH，而 DSH.exe 还在安装盘（Program Files、D:\…），于是
// `'..\core\current\node\..\..\..\DSH.exe' 不是内部或外部命令`（#102）。
// 启动器自己拉 dsh 时环境里有 DSH_ELECTRON_BIN，走不到那条回退；但 dsh 页面和
// agent 的 plugin_manager 走 execution: service，dsh-subprocess 的 scrubbedParentEnv
// 会把所有 DSH_* 变量剥掉，包装脚本只好去猜 —— 插件安装就全失败在 pnpm 启动之前。
//
// 所以核心启动时把真正的 Electron 路径写进 core 目录旁边的 electron-bin 文件，
// 包装脚本先读它，读不到才回退旧的相对路径。文件放在 core/ 下（不是 core/current 里）：
// 核心更新只整目录替换 current，这份标记原地不动；每次启动也会再写一次，路径变了能自愈。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 标记文件名。pack.mjs 写进 node 包装脚本的相对路径也用它，别在别处另写字符串。 */
export const ELECTRON_BIN_FILE = 'electron-bin'

/**
 * 标记位置：<coreDir>/../electron-bin。node 包装在 <coreDir>/node，所以从 node 目录
 * 往上是 `..\..`、shell 里是 `$dir/../../`。安装版 = %APPDATA%\DSH\core\electron-bin，
 * npm 版 = <cache>/core/electron-bin，源码组装的核心 = release/electron-bin。
 */
export function electronBinMarkerPath(coreDir) {
  return join(dirname(coreDir), ELECTRON_BIN_FILE)
}

/**
 * 把 Electron 本体的绝对路径写到 core 目录旁边。返回写成功的路径，没写返回空串。
 * 只在 Electron 里、且核心目录带 node/ 运行时（有包装脚本可读）时才写 ——
 * 源码运行没有 node/ 目录，别往仓库里丢文件。
 */
export function writeElectronBinMarker({ coreDir, execPath = '', inElectron = false, exists = existsSync, writeFile = writeFileSync, makeDir = mkdirSync } = {}) {
  if (!inElectron || !coreDir || !execPath) return ''
  if (!exists(join(coreDir, 'node'))) return ''
  const file = electronBinMarkerPath(coreDir)
  try {
    makeDir(dirname(file), { recursive: true })
    writeFile(file, `${execPath}\n`)
    return file
  } catch {
    return ''
  }
}

/**
 * Windows 的 node.cmd。回退顺序：DSH_ELECTRON_BIN（启动器拉的子进程）→ 标记文件 →
 * 旧的相对安装布局（resources/core/node 那一代）。
 *
 * 用 GOTO 而不是 IF/ELSE 块：块里的 %VAR% 在解析时就展开了，SET /p 刚写进去的值会读成空。
 */
export function nodeShimWindows() {
  return [
    '@ECHO off',
    'SETLOCAL',
    'SET "ELECTRON_RUN_AS_NODE=1"',
    'IF DEFINED DSH_ELECTRON_BIN GOTO dshElectron',
    'SET "DSH_NODE_BIN="',
    `IF EXIST "%~dp0..\\..\\${ELECTRON_BIN_FILE}" SET /p DSH_NODE_BIN=<"%~dp0..\\..\\${ELECTRON_BIN_FILE}"`,
    'IF DEFINED DSH_NODE_BIN IF EXIST "%DSH_NODE_BIN%" GOTO dshMarker',
    '"%~dp0..\\..\\..\\DSH.exe" %*',
    'GOTO :eof',
    '',
    ':dshMarker',
    '"%DSH_NODE_BIN%" %*',
    'GOTO :eof',
    '',
    ':dshElectron',
    '"%DSH_ELECTRON_BIN%" %*',
    '',
  ].join('\r\n')
}

/** POSIX（mac / Linux）的 node 包装，回退顺序和 Windows 一样。 */
export function nodeShimPosix() {
  return [
    '#!/bin/sh',
    'if [ -n "$DSH_ELECTRON_BIN" ]; then ELECTRON_RUN_AS_NODE=1 exec "$DSH_ELECTRON_BIN" "$@"; fi',
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    `if [ -f "$dir/../../${ELECTRON_BIN_FILE}" ]; then`,
    `  electron="$(cat "$dir/../../${ELECTRON_BIN_FILE}")"`,
    '  if [ -n "$electron" ] && [ -x "$electron" ]; then ELECTRON_RUN_AS_NODE=1 exec "$electron" "$@"; fi',
    'fi',
    'if [ -x "$dir/../../../DSH.exe" ]; then ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../DSH.exe" "$@"; fi',
    'if [ -x "$dir/../../../MacOS/DSH" ]; then ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../MacOS/DSH" "$@"; fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$dir/../../../DSH" "$@"',
    '',
  ].join('\n')
}
