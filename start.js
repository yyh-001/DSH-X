import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setHost,
  shutdown,
  startServer,
} from './server.js'
import { resolvePort } from './settings.js'
import { APP_DIR } from './platform.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = resolvePort()
const MANAGER_URL = `http://127.0.0.1:${PORT}/`
// 由原生外壳（DSH.exe / DSH-X.app）拉起时它设这个变量：管理页装进它自己的窗口，托盘也归它，
// 这里就只剩服务本身，不用再往系统浏览器里开页面。
const APP_WINDOW = process.env.DSH_APP_WINDOW === '1'
const LOG_DIR = APP_DIR
const LOG = join(LOG_DIR, 'manager.log')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(' ')}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, line)
  } catch { /* ignore */ }
  console.error(...args)
}

/** cmd 会二次解析命令行，URL 里出现它的元字符就不安全（原因见 server.js 的 openExternal）。 */
const CMD_SAFE_URL = /^[A-Za-z0-9\-._~:/?#\[\]@$'*,;=+]+$/

function openPage(target = MANAGER_URL) {
  if (process.platform === 'win32') {
    if (!CMD_SAFE_URL.test(target)) {
      log(`地址含不能安全打开的字符，已跳过：${target}`)
      return
    }
    execFile('cmd', ['/c', 'start', '', target], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
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
async function showManager() {
  if (requestShow()) return
  openPage(MANAGER_URL)
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
      await showManager()
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

  // 打开启动器只把界面摆出来，不再默认拉起 dsh——跑哪个版本、什么时候跑，由用户在界面上点。
  // 更新也一样：启动时不打扰，更新按钮留在界面上，点了才弹确认。
  if (!APP_WINDOW) openPage(MANAGER_URL)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown().finally(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  log(error)
  process.exit(1)
})
