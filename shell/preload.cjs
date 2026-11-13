/**
 * 管理页的预加载脚本：把 Rust 外壳里 wry 注入的 `window.ipc.postMessage`
 * 原样补上，页面（public/index.html、internal-tabs.js）不用为 Electron 改一行。
 *
 * 只给管理页和本地标签顶栏装；实例内容始终使用 preload-browser.cjs。
 * 必须是 CommonJS：沙盒里的预加载不支持 ESM。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 和 main.mjs 的 IPC_CHANNEL 一致。 */
const IPC_CHANNEL = 'dsh-x:ipc'
/** 外壳 → 页面的通道（和 main.mjs 的 SHELL_CHANNEL 一致）：退出前的询问。 */
const SHELL_CHANNEL = 'dsh-x:shell'
/** 单条消息的上限：页面发的都是很短的 JSON，超长的直接丢，别让主进程去解析。 */
const MESSAGE_MAX_CHARS = 64 * 1024

// 各平台的 Electron 外壳使用统一的无边框顶栏，窗口按钮由页面画（.app-window），
// 拖动只能靠 Chromium 的 -webkit-app-region（wry 版靠 ipc 'drag'，Electron 没有从页面开始系统拖动的接口）。
// 预加载可能比 DOM 就绪早：documentElement 还没有时先挂到 DOMContentLoaded 上，别在顶层直接抛。
{
  const markWindow = () => document.documentElement?.classList.add('electron-window')
  if (document.documentElement) markWindow()
  else document.addEventListener('DOMContentLoaded', markWindow, { once: true })
}

contextBridge.exposeInMainWorld('ipc', {
  postMessage(message) {
    const text = String(message)
    if (text.length <= MESSAGE_MAX_CHARS) ipcRenderer.send(IPC_CHANNEL, text)
  },
  // 外壳 → 页面：目前只有「退出前还有实例在跑」这一种询问（见 main.mjs 的 confirmQuitWithInstances）。
  // 页面在启动时订阅一次就够了，不返回「取消订阅」函数：跨 contextBridge 往回传函数没必要，也没人用。
  onMessage(handler) {
    if (typeof handler !== 'function') return
    ipcRenderer.on(SHELL_CHANNEL, (_event, text) => handler(String(text)))
  },
})
