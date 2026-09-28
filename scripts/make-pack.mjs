/**
 * 把 packs/<名字>/ 打成一个 .dspack（生态里的 DSH-PackForge 格式，ZIP）。
 *
 *   node scripts/make-pack.mjs                 # 打 packs/ 下所有包
 *   node scripts/make-pack.mjs packs/xxx       # 只打这一个
 *
 * 产物在 release/packs/<name>-<version>.dspack。打完会用它自己的解析器（packs.js）
 * 回读一遍：产物必须是启动器认得的包，不然发出去就是废文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parsePackArchive, parseManifest } from '../packs.js'
import { writeZip } from '../zip.js'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT_DIR = join(ROOT, 'release', 'packs')

/** 目录里的所有文件（正斜杠相对路径 → Buffer）。 */
function collect(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push({ name: relative(dir, path).split(sep).join('/'), data: readFileSync(path) })
    }
  }
  walk(dir)
  return out
}

function packDirs(args) {
  if (args.length) return args.map((arg) => resolve(arg))
  const base = join(ROOT, 'packs')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
}

let made = 0
for (const dir of packDirs(process.argv.slice(2))) {
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) {
    console.error(`跳过 ${dir}：没有 manifest.json`)
    continue
  }
  const parsed = parseManifest(readFileSync(manifestFile, 'utf8'))
  if (!parsed.ok) {
    console.error(`跳过 ${dir}：清单不合法——${parsed.errors.join('；')}`)
    process.exitCode = 1
    continue
  }
  const name = parsed.fields.name
  const version = parsed.fields.version
  const entries = collect(dir)
  if (!entries.some((entry) => entry.name === 'dspack.json')) {
    entries.push({ name: 'dspack.json', data: Buffer.from(JSON.stringify({ format: 'dspack', version: 3 }, null, 2) + '\n') })
  }
  const archive = writeZip(entries)
  // 回读一遍：产物得能被自己的解析器认出来，否则发出去就是废文件
  const check = parsePackArchive(archive)
  if (!check.ok) {
    console.error(`${name}: 打出来的包自己都不认——${check.errors.join('；')}`)
    process.exitCode = 1
    continue
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const target = join(OUT_DIR, `${name}-${version}.dspack`)
  writeFileSync(target, archive)
  made += 1
  console.log(`${target}（${entries.length} 个文件，${Math.round(statSync(target).size / 1024)} KB，${check.fields.bundles.length} 层 / ${Object.keys(check.fields.dependencies).length} 个依赖）`)
  for (const warning of check.warnings) console.log(`  ⚠ ${warning}`)
}
console.log(made ? `打好 ${made} 个整合包` : '没有可打的包')
