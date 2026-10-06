/**
 * 把启动器仓库里的同步引擎拷进插件（单一来源，别手工同步）。
 *
 *   node scripts/sync-engine.mjs                 # 默认去 ../../strategies（和 DSH-X 同一层）
 *   DSH_X_REPO=D:\path\to\strategies node scripts/sync-engine.mjs
 *
 * 引擎三件套本身零依赖（只用 Node 内置模块），所以拷进来就能跑；
 * 插件侧只加一段「这几只文件是拷过来的、别在这里改」的文件头。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// 两种布局都认：插件住在 DSH-X 仓库里（strategies/plugins/dsh-x-sync），或独立仓库与 strategies 同级
const CANDIDATES = [
  process.env.DSH_X_REPO,
  resolve(ROOT, '..', '..'),
  resolve(ROOT, '..', 'strategies'),
].filter(Boolean)
const SOURCE = CANDIDATES.find((dir) => existsSync(join(dir, 'sync.js')))
const TARGET = join(ROOT, 'lib', 'engine')
const FILES = ['sync.js', 'zipfile.js', 'version.js']

if (!SOURCE) {
  console.error(`找不到引擎源码（找过：${CANDIDATES.join('、')}）\n用 DSH_X_REPO=<DSH-X 仓库目录> 指过去。`)
  process.exit(1)
}

mkdirSync(TARGET, { recursive: true })
for (const name of FILES) {
  const text = readFileSync(join(SOURCE, name), 'utf8')
  const header = `// ⚠ 这个文件是从 DSH-X 启动器仓库拷过来的（strategies/${name}），别在这里改：
// 改那边，然后在本目录跑 \`npm run sync-engine\` 重新拷贝。
`
  writeFileSync(join(TARGET, name), header + text)
  console.log(`✓ ${name}（${text.split('\n').length} 行）`)
}
console.log(`引擎已同步自 ${SOURCE}`)
