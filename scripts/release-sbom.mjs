// SBOM：用 SPDX 2.3 列出「安装包里到底带了什么」，随发布资产一起发出。
//
//   node scripts/release-sbom.mjs          生成 release/dsh-x-<版本>.spdx.json
//
// 尺度说明：安装包里的第三方运行时（node / npm / corepack / pnpm）按「整包一个条目」声明版本与许可证，
// 不逐层展开它们内部的 node_modules；启动器自己随包发的文件逐个列入并带 sha256，方便核对。
// 这不是法律意义上的完整 SBOM，而是「这个安装包里有什么、能对上哈希」的可核验清单。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = 'yyh-001/DSH-X'

/** 随包发的第三方运行时：目录 → SPDX 条目信息。 */
const RUNTIMES = [
  { key: 'node', dir: 'node/node.exe', name: 'Node.js', homepage: 'https://nodejs.org', license: 'MIT' },
  { key: 'npm', dir: 'node/node_modules/npm', name: 'npm', homepage: 'https://github.com/npm/cli', license: 'Artistic-2.0' },
  { key: 'corepack', dir: 'node/node_modules/corepack', name: 'corepack', homepage: 'https://github.com/nodejs/corepack', license: 'MIT' },
  { key: 'pnpm', dir: 'node/node_modules/pnpm', name: 'pnpm', homepage: 'https://pnpm.io', license: 'MIT' },
]

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 版本优先读包自带的 package.json；node.exe 这种只能问它自己。 */
function runtimeVersion(nodeDir, entry) {
  if (entry.key === 'node') {
    const exe = join(nodeDir, 'node.exe')
    if (!existsSync(exe)) return null
    const result = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? String(result.stdout).trim().replace(/^v/, '') : null
  }
  const manifest = readJson(join(nodeDir, 'node_modules', entry.key, 'package.json'))
  return manifest?.version ?? null
}

export function collectComponents({ nodeDir } = {}) {
  const components = {}
  if (!nodeDir || !existsSync(nodeDir)) return components
  for (const entry of RUNTIMES) {
    const version = runtimeVersion(nodeDir, entry)
    if (version) components[entry.key] = version
  }
  return components
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 随包发的文件：release/DSH 下除 node/（运行时按条目声明）以外的所有文件。 */
export function collectShippedFiles(dshDir) {
  const out = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        if (dir === dshDir && item.name === 'node') continue
        walk(full)
      } else {
        out.push(relative(dshDir, full).split(sep).join('/'))
      }
    }
  }
  if (existsSync(dshDir)) walk(dshDir)
  return out.sort()
}

function spdxId(kind, name) {
  return `SPDXRef-${kind}-${String(name).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, '')}`
}

export function buildSbom({ version, commit, builtAt, components = {}, files = [], extras = [], releaseDir, dshDir }) {
  const namespace = `https://github.com/${REPO}/spdx/${version}-${String(commit ?? 'nogit').slice(0, 8)}-${builtAt.replace(/[^0-9]/g, '').slice(0, 14)}`
  const appId = spdxId('Package', 'dsh-x')
  const packages = [
    {
      SPDXID: appId,
      name: 'DSH-X',
      versionInfo: version,
      downloadLocation: `https://github.com/${REPO}/releases/tag/v${version}`,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
      externalRefs: [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/${REPO}@v${version}` },
      ],
    },
  ]
  const relationships = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: appId }]

  for (const entry of RUNTIMES) {
    const ver = components[entry.key]
    if (!ver) continue
    const id = spdxId('Package', entry.name)
    packages.push({
      SPDXID: id,
      name: entry.name,
      versionInfo: ver,
      downloadLocation: entry.homepage,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: entry.license,
      copyrightText: 'NOASSERTION',
    })
    relationships.push({ spdxElementId: appId, relationshipType: 'CONTAINS', relatedSpdxElement: id })
  }

  const filesOut = []
  const addFile = (label, file, comment) => {
    const id = spdxId('File', label)
    filesOut.push({
      SPDXID: id,
      fileName: `./${label}`,
      checksums: [{ algorithm: 'SHA256', checksumValue: hashFile(file) }],
      licenseConcluded: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(comment ? { comment } : {}),
    })
    relationships.push({ spdxElementId: appId, relationshipType: 'CONTAINS', relatedSpdxElement: id })
  }

  for (const name of extras) addFile(name, join(releaseDir, name), '发布资产（安装包）')
  for (const name of files) addFile(`DSH/${name}`, join(dshDir, name), '安装到用户机器上的文件')
  const nodeExe = join(dshDir, 'node', 'node.exe')
  if (existsSync(nodeExe)) addFile('DSH/node/node.exe', nodeExe, '随包发的 Node 运行时')

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `DSH-X-${version}`,
    documentNamespace: namespace,
    documentComment: '第三方运行时（node/npm/corepack/pnpm）按整包声明，未展开其内部依赖；启动器自身随包文件逐个列出并带 sha256。',
    creationInfo: {
      created: builtAt,
      creators: ['Tool: dsh-x release-sbom (scripts/release-sbom.mjs)'],
    },
    packages,
    files: filesOut,
    relationships,
  }
}

export function writeSbom({ releaseDir = join(ROOT, 'release'), version, commit, now = new Date() } = {}) {
  const dshDir = join(releaseDir, 'DSH')
  const sbom = buildSbom({
    version,
    commit,
    builtAt: now.toISOString(),
    components: collectComponents({ nodeDir: join(dshDir, 'node') }),
    files: collectShippedFiles(dshDir),
    extras: ['DSH-Setup.exe'].filter((name) => existsSync(join(releaseDir, name))),
    releaseDir,
    dshDir,
  })
  mkdirSync(releaseDir, { recursive: true })
  const out = join(releaseDir, `dsh-x-${version}.spdx.json`)
  writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`)
  return { sbom, path: out }
}

function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const { sbom, path } = writeSbom({ version })
  const counts = { 包: sbom.packages.length, 文件: sbom.files.length, 关系: sbom.relationships.length }
  console.log(`SBOM: ${path}`)
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  console.log(`  组件: ${sbom.packages.slice(1).map((p) => `${p.name} ${p.versionInfo}`).join(', ') || '（release/DSH/node 里没找到）'}`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exit(main())
  } catch (error) {
    console.error(`失败: ${error.message}`)
    process.exit(1)
  }
}
