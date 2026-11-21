/**
 * dsh 标签页的预加载：暴露官方右侧栏浏览器需要的 `dshDesktop` 桥，以及官方 web profile
 * 拖拽/粘贴文件时用来取真实路径的 `__DSH_HOST_PATHS__`。
 *
 * 前者的接口与校验取自官方 DSH Desktop（MIT，Copyright (c) 2026 Anywhere Labs）的
 * `dsh-desktop-next/src/preload-browser.ts`；后者是同一份 `preload-app.cjs` 里的桥。
 * 都不暴露原始 IPC、Electron 对象或任何外壳通道。
 *
 * 必须是 CommonJS：沙盒里的预加载不支持 ESM。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const IPC = {
  acquire: 'dsh-x:browser-acquire',
  release: 'dsh-x:browser-release',
  openRequested: 'dsh-x:browser-open-requested',
}

// 迁移视图使用同一份预加载。只有本地占位页获得两个短命令，主进程还会核对
// WebContents、顶层 frame 和完整占位页 URL；远端 dsh 文档没有这个桥。
if (location.protocol === 'data:') {
  contextBridge.exposeInMainWorld('ipc', {
    postMessage(message) {
      if (message === 'launch' || message === 'manager') ipcRenderer.send('dsh-x:ipc', message)
    },
  })
}

/** Lease-scoped browser operations and one main-process event subscription per window. */
function createDesktopBrowserBridge() {
  const listeners = new Map()
  ipcRenderer.on(IPC.openRequested, (_event, request) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: (workspace) => ipcRenderer.invoke(IPC.acquire, workspace),
    release: (lease) => ipcRenderer.invoke(IPC.release, lease),
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}

// 官方 sidebar-browser 客户端只认 protocolVersion === 1 且带 browser 的载体；
// 没有这个对象它会静默回退到 iframe。
contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,
  browser: createDesktopBrowserBridge(),
})

// 本机地址的主机名，和 model.mjs 的 LOOPBACK_HOSTS、browser-guests.mjs 的 isApplicationHost
// 是同一组：只有回环上的 dsh 页面能拿真实路径，外部网页（理论上进不了标签页，见 main.mjs 的
// will-navigate）和外壳自己的 data: 停止页都过不了。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isLoopbackDshPage() {
  return (location.protocol === 'http:' || location.protocol === 'https:') && LOOPBACK_HOSTS.has(location.hostname)
}

// 官方 web profile 的输入框用这个桥判断：拖入/粘贴的文件有真实路径时变成 `@路径` 引用，
// 文件夹变成目录引用；没有桥（旧行为）只能走上传，文件夹直接报「仅桌面端支持」。
// 只暴露 pathFor 一个函数；右侧栏 webview 的 guest 是另一块 WebContents，
// will-attach-webview 已把预加载清掉（browser-guests.mjs），拿不到这个桥。
// WSL 实例由外壳在建视图时传 `--dsh-x-wsl=<发行版>`（默认发行版是空串）；没有这个参数就是
// 本机实例。沙盒预加载 require 不了本地模块，换算只能写在这份文件里。
const WSL_ARG = '--dsh-x-wsl='
const wslArg = (Array.isArray(process.argv) ? process.argv : []).find((value) => typeof value === 'string' && value.startsWith(WSL_ARG))
const wslDistro = typeof wslArg === 'string' ? wslArg.slice(WSL_ARG.length) : null

/**
 * 把 Windows 路径换成 WSL 里的路径：WSL 里的 agent 拿到 C:\… 打不开。
 * - `C:\a\b` → `/mnt/c/a/b`（WSL 默认的 automount 位置；改过 automount root 的极少数人不管）。
 * - `\\wsl$\<发行版>\a`、`\\wsl.localhost\<发行版>\a` → `/a`，但只认本实例的发行版：
 *   别的发行版里的文件在这个发行版里没有对应路径，硬换会指到同名的另一个文件，原样交回更安全；
 *   实例用的是默认发行版（名字不知道）时照换。
 * - 其他 UNC（网络共享）WSL 里也没有对应位置，原样交回。
 */
function toWslPath(value, distro) {
  let text = String(value || '').replace(/\\/g, '/')
  // \\?\C:\… 是长路径前缀，去掉后就是普通盘符路径
  if (/^\/\/\?\/[A-Za-z]:/.test(text)) text = text.slice(4)
  const drive = /^([A-Za-z]):(?:\/(.*))?$/.exec(text)
  if (drive) {
    const rest = (drive[2] || '').replace(/\/+$/, '')
    return rest ? `/mnt/${drive[1].toLowerCase()}/${rest}` : `/mnt/${drive[1].toLowerCase()}`
  }
  const unc = /^\/\/wsl(?:\$|\.localhost)\/([^/]+)(?:\/(.*))?$/i.exec(text)
  if (unc && (!distro || unc[1].toLowerCase() === distro.toLowerCase())) {
    return '/' + (unc[2] || '').replace(/\/+$/, '')
  }
  return String(value || '')
}

if (isLoopbackDshPage()) {
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor(file) {
      let path = ''
      try { path = webUtils.getPathForFile(file) } catch { return '' }
      return wslDistro === null || !path ? path : toWslPath(path, wslDistro)
    },
  })
}
