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
 * 进度由 main.mjs 节流后用 executeJavaScript 更新（#bar 宽度、#hint 状态、#detail 字节数、
 * #source 下载源）；总大小未知时进度条走不确定态动画，不会停在 0%。
 * 窗口固定高度、页面禁止滚动：内容比窗口高时右侧会冒出滚动条，很难看。
 */
export function coreSetupPage(lang) {
  const en = lang === 'en'
  const title = en ? 'Preparing the runtime core' : '正在准备运行核心'
  const hint = en ? 'Contacting the download source…' : '正在连接下载源…'
  const source = en ? 'npm mirror first, official registry as fallback' : '镜像源优先，失败自动切到官方源'
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee; font: 14px/1.6 -apple-system, "PingFang SC", sans-serif;
         -webkit-user-select: none; user-select: none; -webkit-app-region: drag; }
  .card { width: 100%; max-width: 360px; padding: 0 24px; text-align: center; }
  .spinner { width: 18px; height: 18px; margin: 0 auto 12px; border: 2px solid #2b303b;
             border-top-color: #3b6cff; border-radius: 50%; animation: spin .8s linear infinite; }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  #hint { margin: 0 0 16px; color: #b9bec9; font-size: 13px; }
  .track { height: 5px; border-radius: 3px; background: #262a33; overflow: hidden; }
  .bar { height: 100%; width: 0; border-radius: 3px; background: #3b6cff; transition: width .2s ease; }
  .track.is-indeterminate .bar { width: 32%; animation: slide 1.1s ease-in-out infinite; }
  .detail { min-height: 17px; margin: 10px 0 0; color: #8f96a5; font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .source { min-height: 15px; margin: 5px 0 0; color: #6f7686; font-size: 11px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(330%); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
    .track.is-indeterminate .bar { animation: none; width: 100%; opacity: .35; }
  }
</style></head>
<body><div class="card">
  <div class="spinner" aria-hidden="true"></div>
  <h1>${title}</h1>
  <p id="hint">${hint}</p>
  <div class="track" id="track"><div class="bar" id="bar"></div></div>
  <p class="detail" id="detail"></p>
  <p class="source" id="source">${source}</p>
</div></body></html>`
}

/**
 * 首启下载窗口的注入脚本。单独成函数是为了能在单测里 `new Function(script)` 验一遍——
 * 拼字符串时少个引号（`width = 50%`）会让整段脚本解析失败，再被空 catch 吞掉，窗口看起来完全不动。
 */
export function coreSetupPaintScript({ percent = 0, indeterminate = false, hint = '', detail = '', source = '' } = {}) {
  const width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`
  return `(() => {
    const bar = document.getElementById('bar')
    const track = document.getElementById('track')
    const hint = document.getElementById('hint')
    const detail = document.getElementById('detail')
    const source = document.getElementById('source')
    if (bar) bar.style.width = ${JSON.stringify(width)}
    if (track) track.classList.toggle('is-indeterminate', ${Boolean(indeterminate)})
    if (hint) hint.textContent = ${JSON.stringify(String(hint))}
    if (detail) detail.textContent = ${JSON.stringify(String(detail))}
    if (source && ${JSON.stringify(String(source))}) source.textContent = ${JSON.stringify(String(source))}
  })()`
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
 * 标签页原生视图（WebContentsView）自己的底色：页面还没画出第一帧时露出的就是它，
 * 不设就是纯白——深色模式下打开标签页那一下白屏就是它。取 launcher.css / theme.css 的 --bg，
 * 和页面 body 同色，画出第一帧时看不出接缝。
 */
export function tabBaseColor(dark) {
  return dark ? '#18181b' : '#eef3fd'
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
