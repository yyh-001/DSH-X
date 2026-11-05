// 核心增量更新的落地助手：由即将退出的外壳用 ELECTRON_RUN_AS_NODE 拉起。
//
// 流程：等父进程退出 → 备份旧核心目录 → 换上新解压好的暂存目录 → 重启外壳 →
// 等新版本写出启动标记；没等到就回滚到备份再重启。所有结果写进 update.log。
//
// 只替换核心目录（用户目录的 core/current；源码/npm 模式下是别的目录），不碰 DSH.exe 和
// Electron 运行时（所以不受文件锁影响）。参数全部走命令行；这里只依赖 Node 内置模块，
// 脚本可以放在临时目录里跑。

import { appendFileSync, cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : ''
}

const appDir = argValue('--app')
const stagedDir = argValue('--staged')
const exePath = argValue('--exe')
const parentPid = Number(argValue('--pid') || 0)
const backupDir = argValue('--backup')
const marker = argValue('--marker')
const logFile = argValue('--log')

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(logFile, line) } catch { /* 日志写不了也不能挡更新 */ }
  try { process.stdout.write(line) } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function relaunch() {
  try {
    // 助手自己是 ELECTRON_RUN_AS_NODE 跑起来的；这个变量不能带给启动器，
    // 否则 DSH.exe 会按 Node 跑 shell/main.mjs，Electron API 全没有，起来就退。
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(exePath, [], { cwd: dirname(exePath), env, detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return child
  } catch (error) {
    log(`重启启动器失败：${error?.message || error}`)
    return null
  }
}

/** 跨卷时 rename 会 EXDEV：先复制再删源。暂存目录在 %TEMP%，可能在另一个盘上。 */
function move(from, to) {
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function swapIn() {
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true })
  renameSync(appDir, backupDir)
  try {
    move(stagedDir, appDir)
  } catch (error) {
    // 新目录换不上：把备份挪回去，保持旧版本可用
    try { renameSync(backupDir, appDir) } catch { /* 尽力而为 */ }
    throw error
  }
}

function rollback() {
  try {
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
    renameSync(backupDir, appDir)
    log('已回滚到更新前的版本')
    return true
  } catch (error) {
    log(`回滚失败：${error?.message || error}（备份在 ${backupDir}）`)
    return false
  }
}

async function main() {
  if (!appDir || !stagedDir || !exePath) {
    log('参数不完整，放弃更新')
    return 1
  }
  log(`等待父进程 ${parentPid} 退出…`)
  const exited = await waitFor(() => !alive(parentPid), 90_000)
  if (!exited) {
    log('父进程 90 秒内没有退出，放弃更新（暂存目录保留，下次可重试）')
    return 1
  }
  try { rmSync(marker, { force: true }) } catch { /* 没有就算了 */ }
  log(`替换 ${appDir}`)
  try {
    swapIn()
  } catch (error) {
    log(`替换失败：${error?.message || error}`)
    return 1
  }
  const child = relaunch()
  const booted = child ? await waitFor(() => existsSync(marker), 45_000) : false
  if (booted) {
    log('新版本启动成功，更新完成')
    try { rmSync(backupDir, { recursive: true, force: true }) } catch (error) { log(`清理旧版本备份失败：${error?.message || error}`) }
    return 0
  }
  log('新版本 45 秒内没有启动成功，开始回滚')
  try { if (child && child.pid) process.kill(child.pid) } catch { /* 可能已经退出 */ }
  await sleep(1500)
  if (rollback()) {
    relaunch()
    log('已重启旧版本')
  }
  return 1
}

main().then((code) => process.exit(code)).catch((error) => {
  log(`更新助手异常：${error?.stack || error}`)
  process.exit(1)
})
