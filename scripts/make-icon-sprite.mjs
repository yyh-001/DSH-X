// 把 vendored 的 Lucide 图标拼成页面共用的 SVG 雪碧图（src/public/icons.svg）。
// 页面只写 <svg><use href="/icons.svg#lucide-x"/></svg>；新增图标时把源 SVG 放进
// scripts/icons/lucide-<版本>/ 再跑 `npm run icons`。不要手改 icons.svg。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '1.69.0'
const SOURCE = join(ROOT, 'scripts', 'icons', `lucide-${VERSION}`)
const TARGET = join(ROOT, 'src', 'public', 'icons.svg')
const LICENSE = join(ROOT, 'src', 'public', 'icons-LICENSE.txt')
// 页面里的图标统一细一档：Lucide 默认 2，现有界面一直是 1.7/1.8，取 1.8 最接近。
const STROKE_WIDTH = '1.8'

const files = readdirSync(SOURCE).filter((name) => name.endsWith('.svg')).sort()
const symbols = []
for (const file of files) {
  const name = file.slice(0, -4)
  const text = readFileSync(join(SOURCE, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const inner = text.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
  const body = inner.replace(/\s+/g, ' ').trim()
  if (!body) throw new Error(`图标是空的：${file}`)
  symbols.push(`  <symbol id="lucide-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`)
}

// 页面引用了但没进雪碧图的图标要当场发现（比运行时空白好查）。
const page = readFileSync(join(ROOT, 'src', 'public', 'index.html'), 'utf8')
const used = new Set([...page.matchAll(/\/icons\.svg#lucide-([a-z0-9-]+)/g)].map((match) => match[1]))
const known = new Set(files.map((file) => file.slice(0, -4)))
const missing = [...used].filter((name) => !known.has(name)).sort()
if (missing.length) throw new Error(`页面引用了没有源文件的图标：${missing.join(', ')}（放进 ${SOURCE} 再跑）`)

writeFileSync(TARGET, `<!-- 由 scripts/make-icon-sprite.mjs 生成：Lucide v${VERSION}（ISC，见 src/public/icons-LICENSE.txt）。不要手改。 -->
<svg xmlns="http://www.w3.org/2000/svg">
${symbols.join('\n')}
</svg>
`)

const license = readFileSync(join(SOURCE, 'LICENSE'), 'utf8').trim()
writeFileSync(LICENSE, `icons.svg 的图标来自 Lucide v${VERSION}（https://lucide.dev）。
生成脚本：scripts/make-icon-sprite.mjs；源文件：scripts/icons/lucide-${VERSION}/。

${license}
`)
console.log(`icons.svg：${symbols.length} 个图标，页面引用 ${used.size} 个`)
