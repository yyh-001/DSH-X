#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  managerUrlWithToken,
  setHost,
  shutdown,
  startServer,
} from './server.js'
import { resolvePort } from './settings.js'
import { APP_DIR, fileManager } from './filemanager.js'
import { readManagerSession } from './manager-auth.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = resolvePort()
// 由原生外壳（DSH.exe / DSH-X.app）拉起时它设这个变量：管理页装进它自己的窗口，托盘也归它，
// 这里就只剩服务本身，不用再往系统浏览器里开页面。
const APP_WINDOW = process.env.DSH_APP_WINDOW === '1'
/**
 * 服务器 / 容器里只想起服务，就别去 open 浏览器了（没有桌面时 openUrl 只会失败一次）。
 * 用环境变量而不是命令行参数：start.js 的 argv 会被原样转发给拉起 dsh 的命令行。
 */
const NO_OPEN = process.env.DSH_NO_OPEN === '1'
const LOG_DIR = APP_DIR
const LOG = join(LOG_DIR, 'manager.log')

/**
 * npm 包的入口（`dsh-x-core`）。--version / --help 走这里，别为了看版本号先把管理服务拉起来。
 * 返回 true 表示参数只用来打印信息，不该继续启动。
 */
async function handleInfoArgs(argv) {
  if (!argv.includes('--version') && !argv.includes('-v') && !argv.includes('--help') && !argv.includes('-h')) return false
  const { CORE_VERSION } = await import('./app-version.js')
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(CORE_VERSION)
    return true
  }
  console.log(`dsh-x-core ${CORE_VERSION}

用法：
  dsh-x-core              启动管理页（默认用系统浏览器打开）
  dsh-x-core --version    打印版本
  dsh-x-core --help       这份帮助

环境变量：
  PORT           管理页端口（默认取设置，首次 3780）
  DSH_NO_OPEN    设为 1 只起服务，不开浏览器（服务器 / 容器）
  DSH_HOME       dsh 的用户目录（默认 ~/.dsh）
  DSH_APP_WINDOW 由 Electron 外壳设置：管理页装进外壳窗口

其余参数会原样转发给启动的 dsh 实例。`)
  return true
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(' ')}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, line)
  } catch { /* ignore */ }
  console.error(...args)
}

/**
 * 管理页地址。本进程已经起着服务时用内存里的 launch token；被 EALREADY 挡下来时
 * 读正在跑的那个实例写在数据目录里的地址（自己这份 token 是空的）。
 */
function managerPage(port) {
  return managerUrlWithToken()
    || readManagerSession(APP_DIR)?.url
    || `http://127.0.0.1:${port || PORT}/`
}

/**
 * 交给系统默认程序打开。平台差异（Windows 的 cmd 元字符过滤等）都在 fileManager 里；
 * 这里只负责把失败写进日志——启动流程不该因为"浏览器没打开"而中断。
 */
function openPage(target = managerPage()) {
  void fileManager.openUrl(target).catch((error) => log(`打开地址失败，已跳过：${target}（${error?.message || error}）`))
}

/**
 * 让 DSH.exe 把窗口叫到前面。父子之间没有别的 IPC，就约定 stdout 里一行标记：
 * 父进程接着这个管道，看到这行就把窗口显示出来。
 */
function requestShow() {
  if (!APP_WINDOW) return false
  process.stdout.write('__DSH_SHOW__\n')
  return true
}

/** 叫回管理页：有 app 窗口就让它显示，没有就照旧开浏览器标签页。 */
async function showManager(port) {
  if (requestShow()) return
  openPage(managerPage(port))
}

/** 唤醒已经在跑的那个实例（端口可能因为顺延而不是配置值）。 */
async function wakeExisting(port = PORT) {
  const base = `http://127.0.0.1:${port}/`
  try {
    const res = await fetch(`${base}api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return true
    log(`唤醒已有实例失败 HTTP ${res.status}`)
  } catch (error) {
    log('唤醒已有实例失败', error)
  }
  return false
}

async function main() {
  log('启动管理器', ROOT)
  try {
    await startServer()
  } catch (error) {
    // 端口被自己的另一个实例占着：唤醒它、把窗口叫出来，然后退出（不起第二个管理器）。
    // 被别的程序占用的情况已经在 startServer() 里顺延掉了，走不到这里。
    if (error && error.code === 'EALREADY') {
      const port = error.port || PORT
      log(`管理页已经在 ${port} 端口上跑着，通知它把窗口叫出来`)
      await wakeExisting(port)
      await showManager(port)
      if (!APP_WINDOW) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/state`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
          const data = await res.json()
          if (data.running?.url) openPage(data.running.url)
        } catch { /* 管理页开了就够 */ }
      }
      return
    }
    throw error
  }

  // 托盘和窗口都在 DSH.exe 那边，本进程只剩服务，靠 http server 活着。
  // onWake 要尽早挂上：另一个实例双击启动时会立刻打 /api/wake，晚一步就丢了这个请求。
  setHost({ onWake: () => showManager() })

  // 内核由 startServer 按启动项的勾选在后台拉起，这里不等待它们就绪。
  // 更新也一样：启动时不打扰，更新按钮留在界面上，点了才弹确认。
  if (!APP_WINDOW && !NO_OPEN) openPage()

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown().finally(() => process.exit(0))
    })
  }
}

if (await handleInfoArgs(process.argv.slice(2))) {
  // --version / --help 已经打印完，不用起服务
} else {
  main().catch((error) => {
    log(error)
    process.exit(1)
  })
}
