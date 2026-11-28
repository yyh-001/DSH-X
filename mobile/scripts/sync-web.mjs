import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(MOBILE_DIR, '..')
const DEFAULT_SRC_MOBILE = join(REPO_ROOT, 'src', 'public', 'mobile')
const DEFAULT_SRC_ICON = join(REPO_ROOT, 'src', 'public', 'icon.png')
const DEFAULT_OVERLAY_BRIDGE = join(MOBILE_DIR, 'web-overlay', 'native-bridge.js')
const DEFAULT_WWW_DIR = join(MOBILE_DIR, 'www')

/**
 * 将网页版 `/_dshx/m/` 绝对资源引用改写为 Capacitor 本地包相对路径，并注入 `native-bridge.js`。
 * 保持原生 ESM 脚本加载顺序：native-bridge.js 必须在 app.js 之前同步挂上 window.DSHXNative。
 */
export function transformIndexHtml(rawHtml) {
  let html = String(rawHtml || '')
  html = html.replaceAll('/_dshx/m/', './')
  if (!html.includes('./native-bridge.js')) {
    const appScriptTag = '<script type="module" src="./app.js"></script>'
    if (html.includes(appScriptTag)) {
      html = html.replace(
        appScriptTag,
        `<script src="./native-bridge.js"></script>\n  ${appScriptTag}`,
      )
    } else {
      html = html.replace('</body>', '  <script src="./native-bridge.js"></script>\n</body>')
    }
  }
  return html
}

export function syncWeb({
  srcMobileDir = DEFAULT_SRC_MOBILE,
  srcIconPath = DEFAULT_SRC_ICON,
  overlayBridgePath = DEFAULT_OVERLAY_BRIDGE,
  outDir = DEFAULT_WWW_DIR,
} = {}) {
  if (!existsSync(srcMobileDir)) {
    throw new Error(`找不到手机端静态资源目录：${srcMobileDir}`)
  }
  if (!existsSync(overlayBridgePath)) {
    throw new Error(`找不到原生桥接脚本：${overlayBridgePath}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  for (const name of ['style.css', 'app.js', 'manifest.json']) {
    const src = join(srcMobileDir, name)
    if (existsSync(src)) {
      cpSync(src, join(outDir, name))
    }
  }

  const indexSrc = join(srcMobileDir, 'index.html')
  if (!existsSync(indexSrc)) {
    throw new Error(`找不到 index.html：${indexSrc}`)
  }
  const indexHtml = transformIndexHtml(readFileSync(indexSrc, 'utf8'))
  writeFileSync(join(outDir, 'index.html'), indexHtml, 'utf8')

  if (existsSync(srcIconPath)) {
    cpSync(srcIconPath, join(outDir, 'icon.png'))
  }
  cpSync(overlayBridgePath, join(outDir, 'native-bridge.js'))

  return { outDir }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outDir } = syncWeb()
  console.log(`Synced mobile web assets to ${outDir}`)
}
