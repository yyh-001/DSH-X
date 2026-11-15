#!/usr/bin/env node
// dsh-x npm 版的入口：确保核心已下载，然后用 electron 依赖启动外壳（DSH_CORE_DIR 指向核心）。
//
//   dsh-x             启动管理器（首次会从 npm 拉核心）
//   dsh-x --update    更新核心到 npm 上的最新版
//   dsh-x --version   打印 CLI（外壳）和已安装核心的版本
//   dsh-x --core      打印核心目录
//
// 安装版（DSH-Setup.exe）和这个 npm 版共用同一份核心包，但 npm 版的更新走 npm，
// 不走安装包自更新。

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCore, installedCore } from '../lib/core.mjs'
import { linuxBackendLaunch } from '../lib/launch.mjs'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const commandArgs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))

function help() {
  console.log(`dsh-x ${pkg.version}

用法：
  dsh-x              启动管理器
  dsh-x --update     更新核心到 npm 最新版
  dsh-x --version    打印版本
  dsh-x --core       打印核心目录
  dsh-x --ozone-platform=wayland  使用原生 Wayland（排序和菜单拆分/合并）
  其他启动参数原样传给 Electron；Linux Wayland 桌面默认优先 XWayland

环境变量：
  DSH_CORE_REGISTRY  覆盖 npm registry（默认 npmmirror，失败退回 npmjs）
  DSH_CORE_CHANNEL   latest / rc / alpha（默认 latest）
  DSH_CORE_PACKAGE   覆盖核心包名（默认 dsh-x-core）
  DSH_NPM_CACHE      覆盖缓存目录
  DSH_ELECTRON_BIN   覆盖 Electron 可执行文件（测试用）
`)
}

function electronBinary() {
  if (process.env.DSH_ELECTRON_BIN) return process.env.DSH_ELECTRON_BIN
  try {
    return require('electron')
  } catch {
    throw new Error('没有找到 electron 依赖：请在安装 dsh-x 的目录里执行 npm install，或重新安装 dsh-x')
  }
}

async function launch() {
  const electronVersion = (() => { try { return require('electron/package.json').version } catch { return '' } })()
  const core = await ensureCore({ electronVersion })
  const electron = electronBinary()
  if (!electron || !existsSync(electron)) throw new Error(`Electron 可执行文件不存在：${electron}`)
  console.log(`dsh-x ${pkg.version} · 核心 ${core.version}${core.downloaded ? '（刚下载）' : ''}`)
  // Electron 跑的是这个 npm 包的根目录（外壳，package.json 的 main 指向 shell/main.mjs），
  // 核心目录通过 DSH_CORE_DIR 传给外壳；外壳启动时优先加载它。
  const appRoot = join(HERE, '..')
  const launch = linuxBackendLaunch(args, process.env)
  if (launch.message) console.warn(launch.message)
  const child = spawn(electron, [appRoot, ...launch.args], {
    stdio: 'inherit',
    env: { ...process.env, DSH_NPM: '1', DSH_CORE_DIR: core.dir, DSH_ELECTRON_BIN: electron },
    windowsHide: false,
  })
  const forward = (signal) => { try { child.kill(signal) } catch { /* 已经退出 */ } }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))
  child.on('exit', (code, signal) => {
    if (launch.preferX11 && (signal || code !== 0)) console.error('DSH-X: X11/XWayland 进程退出失败。请检查上方原生错误及 DISPLAY/认证；可用 --ozone-platform=wayland 启动。')
    if (signal) process.exitCode = 1
    else process.exitCode = code ?? 0
  })
}

async function main() {
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) return help()
  if (commandArgs.includes('--version') || commandArgs.includes('-v')) {
    const installed = installedCore()
    console.log(`dsh-x ${pkg.version}${installed ? ` · 核心 ${installed.version}` : ' · 核心未安装'}`)
    return
  }
  if (commandArgs.includes('--core')) {
    const installed = installedCore()
    console.log(installed ? installed.dir : '核心未安装')
    return
  }
  if (commandArgs.includes('--update')) {
    const electronVersion = (() => { try { return require('electron/package.json').version } catch { return '' } })()
    const core = await ensureCore({ force: true, electronVersion })
    console.log(`核心已更新：${core.version}（${core.dir}）`)
    return
  }
  await launch()
}

main().catch((error) => {
  console.error(`dsh-x: ${error?.message || error}`)
  process.exitCode = 1
})
