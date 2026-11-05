/**
 * 外壳自己画的几张本地页（data: URL）：不依赖管理服务在不在。文案与样式照搬已删的 Rust 外壳
 * （launcher/main.rs 的 ERROR_PAGE / IDLE_PAGE、tabs.rs 的停止页，git 历史可查），两个平台看到的一样。
 */

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/**
 * 启动失败页。「关闭」直接 window.close()：错误窗口一关外壳就退出（见 main.mjs 的 showStartupError），
 * 不需要给这张页开 IPC。
 */
export function errorPage(title, message, detail) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee; font: 14px/1.6 -apple-system, "PingFang SC", sans-serif;
         -webkit-user-select: none; user-select: none; }
  .card { width: 100%; max-height: 100%; display: flex; flex-direction: column; padding: 26px 28px; }
  .head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #f2777a; box-shadow: 0 0 0 4px rgba(242, 119, 122, .16); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 14px; color: #b9bec9; }
  pre { margin: 0 0 20px; padding: 10px 12px; background: #14161b; border: 1px solid #262a33; border-radius: 8px;
        overflow: auto; color: #9aa1ad; font: 12px/1.5 Menlo, monospace; white-space: pre-wrap; word-break: break-all;
        -webkit-user-select: text; user-select: text; }
  button { align-self: flex-start; border: 0; border-radius: 8px; padding: 9px 20px; background: #3b6cff; color: #fff;
           font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { background: #4a78ff; }
</style></head>
<body><div class="card">
  <div class="head"><span class="dot"></span><h1>${escapeHtml(title)}</h1></div>
  <p>${escapeHtml(message)}</p>
  <pre>${escapeHtml(detail)}</pre>
  <button onclick="window.close()">关闭</button>
</div></body></html>`
}

/**
 * 首次启动在下载核心：安装包里不再带核心，这张页把等待说清楚。
 * 进度条由 main.mjs 用 executeJavaScript 更新（#bar 的宽度、#hint 的百分比）。
 */
export function coreSetupPage(lang) {
  const en = lang === 'en'
  const title = en ? 'Downloading the runtime core' : '正在下载运行核心'
  const hint = en ? 'First launch: fetching dsh-x-core from npm (about 12 MB).' : '第一次启动：从 npm 取 dsh-x-core（约 12 MB）。'
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee; font: 14px/1.6 -apple-system, "PingFang SC", sans-serif;
         -webkit-user-select: none; user-select: none; }
  .card { width: 100%; padding: 0 32px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 18px; color: #b9bec9; }
  .track { height: 6px; border-radius: 3px; background: #262a33; overflow: hidden; }
  .bar { height: 100%; width: 0; border-radius: 3px; background: #3b6cff; transition: width .2s ease; }
</style></head>
<body><div class="card">
  <h1>${title}</h1>
  <p id="hint">${hint}</p>
  <div class="track"><div class="bar" id="bar"></div></div>
</div></body></html>`
}

/** 独立 DSH 窗口在 dsh 没跑时显示的页：给「启动」和「打开管理页」两个按钮（走 window.ipc）。 */
export function idlePage(lang) {
  const en = lang === 'en'
  const title = en ? 'dsh is not running' : 'dsh 没在运行'
  const hint = en ? 'Start it here, or go back to the launcher page.' : '可以在这里直接启动，或者回到启动器管理页。'
  const start = en ? 'Start dsh' : '启动 dsh'
  const manager = en ? 'Open launcher' : '打开管理页'
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><title>${title}</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee; font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; }
  .card { text-align: center; padding: 0 32px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #8a93a5; display: inline-block; margin-right: 8px; vertical-align: 1px; }
  h1 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  p { margin: 0 0 20px; color: #b9bec9; }
  .actions { display: flex; gap: 10px; justify-content: center; }
  button { border: 0; border-radius: 8px; padding: 9px 20px; font: inherit; font-size: 13px; cursor: pointer; }
  .primary { background: #3b6cff; color: #fff; }
  .primary:hover { background: #4a78ff; }
  .ghost { background: #262a33; color: #e7e9ee; }
  .ghost:hover { background: #303643; }
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>${title}</h1>
  <p>${hint}</p>
  <div class="actions">
    <button class="primary" onclick="window.ipc.postMessage('launch')">${start}</button>
    <button class="ghost" onclick="window.ipc.postMessage('manager')">${manager}</button>
  </div>
</div></body></html>`
}

/**
 * 实际生效的深色状态：显式 light/dark 说了算；system（以及将来新增的未知值）跟随系统。
 * 和已删的 launcher/tabs.rs 的 resolve_dark 一致（#58）。
 */
export function resolveDark(theme, systemDark) {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return systemDark
}

/**
 * 标签页对应的实例停了：不在旧端口上反复刷新，以免重启间隙误加载到另一个实例。
 * 深色沿用 idlePage 的配色（底色 #15171c、文字 #b9bec9）：同一个外壳里不该有两种黑。
 */
export function stoppedPage(lang, dark) {
  const text = lang === 'en' ? 'This DSH instance has stopped. Return to the launcher to start it.' : '此 DSH 实例已停止，请返回启动器启动。'
  const [color, background] = dark ? ['#b9bec9', '#15171c'] : ['#7182a2', '#f5f8ff']
  return `<!doctype html><meta charset='utf-8'><style>body{font:16px system-ui;color:${color};background:${background};display:grid;place-items:center;height:90vh}</style><p>${text}</p>`
}
