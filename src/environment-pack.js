// 环境文件：导出 / 导入环境用的 .dspack（PackForge manifest v5）。
// 设计见 docs/plans/2026-11-11-environment-profile-split.md「环境文件」一节：
// 只带 DSH 版本 + 插件清单（+ 本地插件的离线文件），不带补丁层、overrides、home、package.json 快照。
//
// 这里只放纯规则：清单长什么样、版本怎么挑、github 坐标怎么钉到提交、离线文件怎么核对。
// 打包本地插件（npm pack）、下载、装 DSH 这些副作用都在 server.js。
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { MANIFEST_FIELDS, MANIFEST_VERSIONS, OFFLINE_PACK_DIR, PACK_FORMAT, PACK_TYPES, bundledSpecErrors, isSensitiveFile, slugName } from './packs.js'
import { ENVIRONMENT, isLocalSpec, localSpecPath, normalizePluginList, normalizeSource, profilePluginList, safePluginName, withSkeletonBundles } from './environments.js'
import { cmpVer, isExactVersion, isVersionRange, parseVer, satisfiesRange } from './version.js'

export const ENVIRONMENT_PACK = Object.freeze({
  // 包里放离线文件的目录（classify 认它，不再当成「不属于整合包」跳过）
  OFFLINE_DIR: OFFLINE_PACK_DIR,
  OFFLINE_FIELD: MANIFEST_FIELDS.OFFLINE,
  SOURCE_FIELD: MANIFEST_FIELDS.ENVIRONMENT,
  // 离线文件导回来后，依赖坐标里的这个前缀换成环境自己的 files/ 目录
  OFFLINE_SPEC_PREFIX: 'file:offline/',
  MARKER_FILE: 'dspack.json',
  MANIFEST_FILE: 'manifest.json',
  PACKAGE_FILE: 'package.json',
  LOCK_FILE: 'pnpm-lock.yaml',
  WORKSPACE_FILE: 'pnpm-workspace.yaml',
  COMMIT_RE: /^[0-9a-f]{40}$/,
  DEFAULT_PACK_VERSION: '1.0.0',
  FALLBACK_NAME: 'environment',
  WORKFLOW_FILE: '.github/workflows/release-environment.yml',
  // 环境文件的版本号：和旧导出同一条规则（清单里的 version 字段，也会进文件名）
  PACK_VERSION_RE: /^[0-9A-Za-z._+-]{1,24}$/,
  // 没有版本号可写的离线文件（现成的 tarball），或者两个插件撞了文件名时，用内容摘要的前几位区分
  DIGEST_TAG_LENGTH: 8,
  // dsh 里的插件市场插件自己装的插件放这儿，不在 package.json 里，环境管不到（设计稿「默认」）
  MARKET_PLUGIN_DIR: '.dsh-market',
  // 导出到哪：单个 .dspack，或者一个能直接提交的仓库目录
  TARGET_FILE: 'file',
  TARGET_DIRECTORY: 'dir',
  // npm pack 产出的 tarball 里，文件都在这个目录下
  TARBALL_ROOT: 'package/',
})

/** 导出时每个直接依赖的钉法（设计稿「直接依赖怎么钉」）。 */
export const EXPORT_KIND = Object.freeze({
  EXACT: 'exact',
  NPM: 'npm',
  GITHUB: 'github',
  DIRECTORY: 'directory',
  TARBALL: 'tarball',
  OTHER: 'other',
})

// 配置导入只写配置：这几个文件是插件清单本身，由环境在启动前写，配置导入碰了就会和环境打架
const PLUGIN_LIST_FILES = new Set([ENVIRONMENT_PACK.PACKAGE_FILE, ENVIRONMENT_PACK.LOCK_FILE, ENVIRONMENT_PACK.WORKSPACE_FILE])

const GITHUB_SPEC_RE = /^github:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:#(.+))?$/
const TARBALL_PATH_RE = /\.(?:tgz|tar\.gz)$/i
const PROTOCOL_SPEC_RE = /^[a-z][a-z0-9+.-]*:/i
// 离线文件名里 OFFLINE_FILE_RE 不收的字符（包名里的 /、~ 这些）一律换成 -
const OFFLINE_NAME_UNSAFE_RE = /[^A-Za-z0-9._+-]/g
// 锁文件里一条依赖解析到的那个提交：pnpm 9+ 是 codeload…/tar.gz/<提交>，pnpm 8 是 github.com/o/r/<提交>，
// 私有仓库是 git+https://…#<提交>；只认 40 位十六进制，不猜短提交
const LOCKED_COMMIT_RE = /(?:^|[/#])([0-9a-f]{40})(?=$|[/?#&)])/
// npm: 别名的版本段（npm:pkg@^1.2.0 → ^1.2.0）
const NPM_ALIAS_RE = /^npm:(?:@[^/@]+\/)?[^@]+@(.+)$/
const GIT_SPEC_RE = /^(?:git\+|git:|git@)/i
// tar 头：一块 512 字节，名字在 0–100、长度（八进制）在 124–136、类型在 156、前缀在 345–500
const TAR_BLOCK = 512
const TAR_TYPE_OFFSET = 156
// 路径长到头里放不下时，前面会多一条说明下一个文件真名的记录：pax 扩展头（x，里面的 path=）或
// GNU 长名（L）。g 是全局 pax 头，不对应文件。不认这几种，长路径的凭据文件就漏查了
const TAR_TYPE = Object.freeze({ PAX: 'x', PAX_GLOBAL: 'g', GNU_LONG_NAME: 'L' })
const PAX_PATH_RE = /(?:^|\n)\d+ path=([^\n]*)\n/
const NUL_TAIL_RE = /\0.*$/s

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** `file:offline/x.tgz` → `x.tgz`；不是离线文件坐标返回空串。 */
export function offlineSpecFile(spec) {
  const value = String(spec ?? '')
  return value.startsWith(ENVIRONMENT_PACK.OFFLINE_SPEC_PREFIX) ? value.slice(ENVIRONMENT_PACK.OFFLINE_SPEC_PREFIX.length) : ''
}

/** 清单里写的离线文件位置（`offline/x.tgz` 或 `x.tgz`）→ 文件名；名字不合法返回空串（不许带路径）。 */
export function offlineEntryFile(path) {
  const file = String(path ?? '').replace(new RegExp(`^${ENVIRONMENT_PACK.OFFLINE_DIR}/`), '')
  return ENVIRONMENT.OFFLINE_FILE_RE.test(file) ? file : ''
}

/**
 * 离线文件在包里的文件名：包名里的 / 这些换成 -，带上版本（没有版本就用内容摘要），一眼看得出是
 * 哪个插件的哪一版。@foo/bar 和 foo-bar 同版本会撞成一个名字：taken 里已有时再带上摘要区分。
 */
export function offlineFileName(name, version, digest = '', taken = new Set()) {
  const stem = safePluginName(name).replace(/^@/, '').replace(OFFLINE_NAME_UNSAFE_RE, '-')
  const tag = String(digest).slice(0, ENVIRONMENT_PACK.DIGEST_TAG_LENGTH)
  const plain = `${stem}-${version || tag}.tgz`
  const file = taken.has(plain) && version && tag ? `${stem}-${version}-${tag}.tgz` : plain
  if (!(version || tag) || !ENVIRONMENT.OFFLINE_FILE_RE.test(file) || taken.has(file)) throw new Error(`插件 ${name} 的离线文件名不合法`)
  return file
}

/**
 * 一个直接依赖导出时怎么处理：精确版本原样；npm 范围 / tag 要钉成精确版本；github 钉到提交；
 * 本地目录打成 tarball、本地 tarball 直接带上（都进 offline/）；其他坐标（npm: 别名、git+https、
 * 直链 tarball）原样带，别人那边 pnpm 照样认。
 * @returns {{kind: string, path?: string}} path 只有本地坐标才有
 */
export function exportKind(spec) {
  const value = String(spec ?? '').trim()
  if (isExactVersion(value)) return { kind: EXPORT_KIND.EXACT }
  if (GITHUB_SPEC_RE.test(value)) return { kind: EXPORT_KIND.GITHUB }
  const local = localSpecPath(value)
  if (local) return { kind: TARBALL_PATH_RE.test(local.path) ? EXPORT_KIND.TARBALL : EXPORT_KIND.DIRECTORY, path: local.path }
  if (PROTOCOL_SPEC_RE.test(value) || isLocalSpec(value)) return { kind: EXPORT_KIND.OTHER }
  return { kind: EXPORT_KIND.NPM }
}

/**
 * 原样导出的其他坐标里，哪些在别人那边装到的东西会变：npm: 别名带范围、git 地址没钉提交。
 * 直链 tarball 地址本身就是一个固定文件，不算。
 */
export function isFloatingSpec(spec) {
  const value = String(spec ?? '').trim()
  const alias = NPM_ALIAS_RE.exec(value)
  if (alias) return !isExactVersion(alias[1])
  if (GIT_SPEC_RE.test(value)) return !LOCKED_COMMIT_RE.test(value)
  return false
}

/**
 * 把 github 坐标钉到 profile 里实际装的那个提交：读 pnpm-lock.yaml 里 importer 那一条的 version，
 * 从里面取提交（几种锁文件写法见 LOCKED_COMMIT_RE）。已经钉了 40 位提交的原样返回；
 * #path: 这类子目录写法保留。
 * @returns 钉好的坐标；读不到提交时返回空串（调用方给警告，不编一个提交出来）
 */
export function pinnedGithubSpec(spec, lockText = '') {
  const match = GITHUB_SPEC_RE.exec(String(spec ?? '').trim())
  if (!match) return ''
  const [, repo, hash = ''] = match
  const parts = hash ? hash.split('&') : []
  if (parts.some((part) => ENVIRONMENT_PACK.COMMIT_RE.test(part))) return spec
  const escaped = String(spec).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const locked = new RegExp(`specifier: ['"]?${escaped}['"]?\\s*\\n\\s*version: ['"]?([^'"\\n]+)`).exec(lockText)
  const commit = locked ? LOCKED_COMMIT_RE.exec(locked[1].trim()) : null
  if (!commit) return ''
  // 分支名 / semver 范围之类的 ref 被提交替代，只留 path: 这种「装哪个子目录」的参数
  const keep = parts.filter((part) => part.startsWith('path:'))
  return `github:${repo}#${[commit[1], ...keep].join('&')}`
}

/**
 * npm 范围 / tag 导出时用 profile 里实测的版本。范围要真的装在范围里才算（换过环境、目录里留着
 * 别的版本时不算）；tag 没法离线核对，装出来的就是那时这个 tag 指的版本。
 */
export function installedSatisfies(installed, spec) {
  if (!isExactVersion(installed)) return false
  return !isVersionRange(spec) || satisfiesRange(installed, spec, { includePrerelease: false })
}

/**
 * 导入时挑 DSH 版本：精确版本照用；范围（老包常见 `>=0.2.1-rc.1 <0.3.0-0`）先挑本机已装里满足的
 * 最高版本，没有再挑远端满足的最高版本（之后自动安装）。环境里记下的永远是精确版本。
 * @returns {{version: string, installed: boolean} | null} 都不满足时 null
 */
export function pickDshVersion(range, { installed = [], published = [] } = {}) {
  const wanted = String(range ?? '').trim()
  if (isExactVersion(wanted)) return { version: wanted, installed: installed.includes(wanted) }
  const newestFirst = (list) => [...new Set(list)].filter((version) => parseVer(version)).sort((a, b) => cmpVer(parseVer(b), parseVer(a)))
  const local = newestFirst(installed).find((version) => satisfiesRange(version, wanted))
  if (local) return { version: local, installed: true }
  const remote = newestFirst(published).find((version) => satisfiesRange(version, wanted))
  return remote ? { version: remote, installed: false } : null
}

/**
 * 导出用的清单。dependencies 里离线插件的坐标是 `file:offline/<文件>`：PackForge 这类工具装的时候
 * 找不到这个相对路径会漏掉它（设计稿「风险」里写了），本启动器导入时换成环境目录里的绝对路径。
 */
export function environmentManifest({ name, version, description = '', dshVersion, list, offline = {}, repo = '' }) {
  return {
    manifestVersion: MANIFEST_VERSIONS[0],
    type: PACK_TYPES.PROFILE,
    name: slugName(name, ENVIRONMENT_PACK.FALLBACK_NAME),
    version: version || ENVIRONMENT_PACK.DEFAULT_PACK_VERSION,
    displayName: name,
    ...(description ? { description } : {}),
    dshVersion,
    bundles: [...list.bundles],
    dependencies: { ...list.dependencies },
    ...(Object.keys(offline).length ? { [ENVIRONMENT_PACK.OFFLINE_FIELD]: offline } : {}),
    ...(repo ? { [ENVIRONMENT_PACK.SOURCE_FIELD]: { repo } } : {}),
  }
}

/** 导出包（或仓库目录）里的全部文件：标记、清单、离线文件。 */
export function environmentEntries(manifest, offlineFiles = []) {
  return [
    { name: ENVIRONMENT_PACK.MARKER_FILE, data: `${JSON.stringify(PACK_FORMAT, null, 2)}\n` },
    { name: ENVIRONMENT_PACK.MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` },
    ...offlineFiles.map((item) => ({ name: `${ENVIRONMENT_PACK.OFFLINE_DIR}/${item.file}`, data: item.data })),
  ]
}

/** 一个目录是不是之前导出过的环境仓库（有标记文件、清单认得出版本）：只有这种目录才往里覆盖。 */
export function isEnvironmentRepository(markerText, manifestText) {
  try {
    const marker = JSON.parse(markerText)
    const manifest = JSON.parse(manifestText)
    return marker?.format === PACK_FORMAT.format && MANIFEST_VERSIONS.includes(Number(manifest?.manifestVersion))
  } catch {
    return false
  }
}

/** 上次导出写在仓库目录清单里的离线文件名（再导出时按它删掉这次不要的，别的文件一律不碰）。 */
export function declaredOfflineFiles(manifestText) {
  let declared = null
  try {
    declared = JSON.parse(manifestText)?.[ENVIRONMENT_PACK.OFFLINE_FIELD]
  } catch {
    return []
  }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return []
  return Object.values(declared).map((item) => offlineEntryFile(item?.file)).filter(Boolean)
}

/**
 * 仓库目录模式的可选 GitHub Actions 模板：推一个 v* tag 就把目录打成 .dspack 挂到 release 上。
 * 启动器自己从不调 GitHub 的写接口、不存 token（设计稿第 7 条），提交、打 tag、推送都是作者的事。
 */
export function releaseWorkflow(packName) {
  const file = `${slugName(packName, ENVIRONMENT_PACK.FALLBACK_NAME)}.dspack`
  return `# DSH-X 导出的环境仓库：推一个 v* 标签就发布一个 release，附件是 ${file}。
# 别人在 DSH-X 里填这个仓库（owner/repo）就能导入，并跟着之后的 release 更新。
name: release-environment
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: pack
        run: zip -r ${file} ${ENVIRONMENT_PACK.MARKER_FILE} ${ENVIRONMENT_PACK.MANIFEST_FILE} $([ -d ${ENVIRONMENT_PACK.OFFLINE_DIR} ] && echo ${ENVIRONMENT_PACK.OFFLINE_DIR})
      - uses: softprops/action-gh-release@v2
        with:
          files: ${file}
`
}

/** npm pack 出来的 tarball 里的文件（去掉 package/ 前缀）：导出前查一遍有没有混进凭据。 */
export function tarballFiles(buffer) {
  const data = gunzipSync(buffer)
  const files = []
  // 上一条 pax / GNU 长名记录给下一个文件的真名
  let longName = ''
  for (let offset = 0; offset + TAR_BLOCK <= data.length;) {
    const header = data.subarray(offset, offset + TAR_BLOCK)
    if (header.every((byte) => byte === 0)) break
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(NUL_TAIL_RE, '')
    const size = parseInt(text(124, 136).trim() || '0', 8) || 0
    const body = data.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size).toString('utf8')
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    const type = String.fromCharCode(header[TAR_TYPE_OFFSET])
    if (type === TAR_TYPE.PAX) {
      longName = PAX_PATH_RE.exec(body)?.[1] || longName
      continue
    }
    if (type === TAR_TYPE.GNU_LONG_NAME) {
      longName = body.replace(NUL_TAIL_RE, '')
      continue
    }
    if (type === TAR_TYPE.PAX_GLOBAL) continue
    const name = longName || [text(345, 500), text(0, 100)].filter(Boolean).join('/')
    longName = ''
    files.push(name.startsWith(ENVIRONMENT_PACK.TARBALL_ROOT) ? name.slice(ENVIRONMENT_PACK.TARBALL_ROOT.length) : name)
  }
  return files
}

/** tarball 里像凭据、密钥的文件（npm pack 只看 files / .npmignore，.env 照样会打进去）。 */
export function sensitiveTarballFiles(buffer) {
  return tarballFiles(buffer).filter((file) => isSensitiveFile(file))
}

/** 包里声明的离线文件：名字、文件、sha256 都要对上，缺一个都不装（离线文件是可执行代码）。 */
function offlineFilesOf(manifest, files) {
  const declared = manifest?.[ENVIRONMENT_PACK.OFFLINE_FIELD]
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return { offline: [], errors: [] }
  const offline = []
  const errors = []
  for (const [name, item] of Object.entries(declared)) {
    try {
      safePluginName(name)
    } catch {
      errors.push(`离线文件声明里的插件名不合法：${name}`)
      continue
    }
    const file = offlineEntryFile(item?.file)
    if (!file || !ENVIRONMENT.SHA256_RE.test(String(item?.sha256 || ''))) {
      errors.push(`离线文件 ${name} 的声明不完整（要 file 和 sha256）`)
      continue
    }
    const data = files.get(`${ENVIRONMENT_PACK.OFFLINE_DIR}/${file}`)
    if (!data) {
      errors.push(`包里缺少离线文件 ${file}`)
      continue
    }
    if (sha256(data) !== item.sha256) {
      errors.push(`离线文件 ${file} 的 sha256 对不上，可能被改过或下载不完整`)
      continue
    }
    offline.push({ name, file, sha256: item.sha256, data })
  }
  return { offline, errors }
}

/** 清单里的插件清单：认不出的条目（坏名字、过长的坐标）一条一条报出来，不悄悄丢；挂载里也去掉它，不留一个装不上的名字。 */
function declaredPluginList(pack, warnings) {
  const raw = pack.installSpecs || pack.fields.dependencies || {}
  let list = normalizePluginList({ dependencies: raw, bundles: pack.fields.bundles }, { strict: false })
  const dropped = Object.keys(raw).filter((name) => !Object.hasOwn(list.dependencies, name))
  for (const name of dropped) warnings.push(`依赖 ${name}（${raw[name]}）的写法认不出来，没有进环境`)
  if (dropped.length) list = { ...list, bundles: list.bundles.filter((name) => !dropped.includes(name)) }
  if (!list.bundles.length && pack.snapshots?.package) {
    // 很老的包没写层栈，只带了 package.json 快照：按快照里的清单来
    try {
      list = profilePluginList(JSON.parse(pack.snapshots.package.toString('utf8')))
    } catch {
      warnings.push('包里的 package.json 快照读不了')
    }
  }
  return withSkeletonBundles(list)
}

/**
 * 指向作者机器上本地路径的依赖（不是离线文件）：这里装不上，留着每次启动都装失败。
 * 和导出时一样去掉并说明，依赖和挂载一起去。
 */
function withoutForeignPaths(list, warnings) {
  const foreign = Object.entries(list.dependencies).filter(([, spec]) => isLocalSpec(spec) && !offlineSpecFile(spec))
  if (!foreign.length) return list
  const dependencies = { ...list.dependencies }
  for (const [name, spec] of foreign) {
    delete dependencies[name]
    warnings.push(`${name} 指向作者机器上的本地路径（${spec}），这里装不上，没有进环境`)
  }
  return { dependencies, bundles: list.bundles.filter((name) => Object.hasOwn(dependencies, name) || !Object.hasOwn(list.dependencies, name)) }
}

/**
 * 从任意整合包（我们导出的、社区市场里的、老格式的）取出建环境要的东西：DSH 版本、插件清单、
 * 离线文件；补丁层、overrides、home 里的技能这些算 Profile 的数据，单独列出来，默认不导入
 * （设计稿第 10 条），用户勾了才写进选的 Profile。
 */
export function environmentFromPack(pack) {
  const fields = pack.fields
  const errors = [...pack.errors]
  const warnings = [...pack.warnings]
  if (fields.type === PACK_TYPES.WHOLE_HOME) errors.push('这是整机快照形态（dshhome）的包：里面有好几份 Profile，环境只有一份插件清单，不能导入成环境')
  bundledSpecErrors(fields.dependencies, errors)
  const list = withoutForeignPaths(declaredPluginList(pack, warnings), warnings)
  const { offline, errors: offlineErrors } = offlineFilesOf(pack.manifest, pack.files)
  errors.push(...offlineErrors)
  // 坐标指向离线文件、包里却没有核对过的那份：留着相对路径装到哪个目录都是错的
  const verified = new Set(offline.map((item) => item.file))
  for (const [name, spec] of Object.entries(list.dependencies)) {
    const file = offlineSpecFile(spec)
    if (file && !verified.has(file)) errors.push(`${name} 要用离线文件 ${file}，但包里没有核对通过的这一份`)
  }
  const declaredRepo = pack.manifest?.[ENVIRONMENT_PACK.SOURCE_FIELD]?.repo
  const config = configOnlyPack(pack)
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    name: pack.displayName || fields.name,
    packId: fields.name,
    packVersion: fields.version,
    description: pack.description || '',
    dshVersion: fields.dshVersion,
    list,
    offline,
    repo: typeof declaredRepo === 'string' && ENVIRONMENT.REPO_RE.test(declaredRepo) ? declaredRepo : '',
    profileData: {
      patch: Boolean(config.patch),
      overrides: config.overrides.map((item) => item.path),
      home: config.home.map((item) => item.path),
    },
  }
}

/** 包里有没有能导进 Profile 的配置（补丁层、overrides、用户级文件，任一样）。 */
export function hasProfileData(profileData) {
  return Boolean(profileData.patch || profileData.overrides.length || profileData.home.length)
}

/**
 * 包的「配置那部分」：去掉插件清单（依赖、层栈）和清单类文件，交给 packs.js 的 planConfigInstall /
 * applyInstall 写进选的 Profile——设计稿要求配置导入走现有的写入、备份、回滚那条路。
 * 插件清单归环境管，启动前由启动器写，这里再写一份只会和环境打架。
 */
export function configOnlyPack(pack) {
  return {
    ...pack,
    fields: { ...pack.fields, type: PACK_TYPES.PROFILE, bundles: [], dependencies: {} },
    installSpecs: {},
    overrides: pack.overrides.filter((item) => !PLUGIN_LIST_FILES.has(item.path)),
  }
}

/**
 * 导入来源 → 环境的结构化来源（设计稿「跟随上游」）。仓库优先用来源本身的（GitHub、市场条目），
 * 其次用包里声明的 environment.repo（我们导出时作者填的）；有仓库才算跟随上游。
 * fallbackRepo：两处都没写时用的仓库（上游更新时传环境原来跟的那个：新版本的市场条目和包里都没写仓库，
 * 不能因此悄悄不跟了）。
 * @param origin {kind, repo?, release?, prerelease?, marketId?, label}
 */
export function environmentSource(origin, imported, { fallbackRepo = '' } = {}) {
  return normalizeSource({
    kind: origin.kind,
    repo: origin.repo || imported.repo || fallbackRepo,
    release: origin.release || '',
    prerelease: origin.prerelease === true,
    marketId: origin.marketId || '',
    packId: imported.packId || '',
    packVersion: imported.packVersion || '',
    label: origin.label || '',
  })
}

/**
 * 离线文件在环境 files/ 下放哪：按内容摘要分子目录。作者改了本地插件却没改版本号时，新旧两版同名不同内容；
 * 跟随上游更新后旧清单还要能切回去，所以各放各的，谁也不覆盖谁。
 */
export function offlineFilePath(filesDir, item) {
  return join(filesDir, item.sha256.slice(0, ENVIRONMENT_PACK.DIGEST_TAG_LENGTH), item.file)
}

/** 导入后离线插件的坐标：`file:offline/x.tgz` → 环境 files/ 目录里那份的绝对路径。 */
export function withOfflinePaths(list, offline, filesDir) {
  const byFile = new Map(offline.map((item) => [item.file, item]))
  const dependencies = Object.fromEntries(Object.entries(list.dependencies).map(([name, spec]) => {
    const file = offlineSpecFile(spec)
    return [name, file && byFile.has(file) ? `file:${offlineFilePath(filesDir, byFile.get(file))}` : spec]
  }))
  return { ...list, dependencies }
}

/**
 * 环境的离线文件搬了目录（复制环境时拷到新环境自己的 files/）：上游层和增量里指着旧目录的坐标
 * 一起换成新目录。不换的话删掉原环境，副本的插件就装不上了。
 */
export function withMovedFiles(env, fromDir, toDir) {
  const prefix = `file:${join(fromDir, '')}`
  const move = (dependencies) => Object.fromEntries(Object.entries(dependencies).map(([name, spec]) =>
    [name, spec.startsWith(prefix) ? `file:${join(toDir, spec.slice(prefix.length))}` : spec]))
  return {
    ...env,
    base: { ...env.base, dependencies: move(env.base.dependencies) },
    delta: { ...env.delta, dependencies: move(env.delta.dependencies) },
  }
}
