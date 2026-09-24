// 发布清单：把「这次发布到底发了什么」写成一份可核验的文件，并支持 Ed25519 签名。
//
//   node scripts/release-manifest.mjs keygen           生成签名密钥（私钥留本机，不进仓库）
//   node scripts/release-manifest.mjs make             生成 release/release-manifest.json，有私钥就顺带签名
//   node scripts/release-manifest.mjs verify           校验签名，并逐个文件核对 sha256 与体积
//   node scripts/release-manifest.mjs check-tag [tag]  tag 与 package.json 版本必须一致（发版前的闸门）
//
// 取向：清单只写事实（版本、提交、产物哈希），不下「可信」这类结论；没有私钥时 make 照样成功，
// 只是不出签名并给出提示——打包流程不该因为本机没配密钥就断。
// 私钥默认在 release/release-key.pem（release/ 已被 .gitignore 忽略）；公钥在 scripts/release-pubkey.pem，随仓库分发。

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA = 'dsh-x.release/v1'
export const PRIVATE_KEY = process.env.DSH_RELEASE_KEY || join(ROOT, 'release', 'release-key.pem')
export const PUBLIC_KEY = process.env.DSH_RELEASE_PUBKEY || join(ROOT, 'scripts', 'release-pubkey.pem')
export const MANIFEST = join(ROOT, 'release', 'release-manifest.json')
export const SIGNATURE = join(ROOT, 'release', 'release-manifest.sig')

/** `v1.2.3` / `1.2.3` / `1.2.3-beta.1` → `1.2.3…`；认不出来返回 null。 */
export function parseTagVersion(tag) {
  const text = String(tag ?? '').trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null
}

/** tag 与版本对不上时返回人话，对得上返回 null。 */
export function tagProblem(tag, version) {
  const parsed = parseTagVersion(tag)
  if (!parsed) return `tag 认不出来：${tag}（期望 v1.2.3 这种）`
  if (parsed !== String(version ?? '').trim()) return `tag ${tag} 与 package.json 的版本 ${version} 不一致`
  return null
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function describeArtifact(releaseDir, name) {
  const file = join(releaseDir, name)
  const stat = statSync(file)
  return { path: name, size: stat.size, sha256: hashFile(file) }
}

export function signBytes(bytes, privateKeyPem) {
  return cryptoSign(null, bytes, privateKeyPem).toString('base64')
}

export function verifySignature(bytes, signatureBase64, publicKeyPem) {
  try {
    return cryptoVerify(null, bytes, publicKeyPem, Buffer.from(String(signatureBase64).trim(), 'base64'))
  } catch {
    return false
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? String(result.stdout).trim() : null
}

/** 这次构建的来源：提交、tag、有没有未提交改动。拿不到 git 信息时如实写 null。 */
export function buildProvenance() {
  const commit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain'])
  const tag = git(['describe', '--tags', '--exact-match', 'HEAD']) || null
  return { commit, tag, dirty: status === null ? null : status.length > 0 }
}

/** 产物清单：安装包必填，SBOM 之类有就带上。 */
export function collectArtifacts(releaseDir, names) {
  return names.filter((name) => existsSync(join(releaseDir, name))).map((name) => describeArtifact(releaseDir, name))
}

export function buildManifest({ version, artifacts, provenance, builtAt, components }) {
  return {
    schema: SCHEMA,
    name: 'DSH-X',
    version,
    ...provenance,
    builtAt,
    components,
    artifacts,
    signature: { algorithm: 'ed25519', file: 'release-manifest.sig', publicKey: 'scripts/release-pubkey.pem' },
  }
}

/** 生成清单（可选签名）。返回 { manifest, signed, manifestPath }。 */
export function writeReleaseManifest({
  releaseDir = join(ROOT, 'release'),
  version,
  artifacts,
  now = new Date(),
  components = {},
  manifestPath = MANIFEST,
  signaturePath = SIGNATURE,
  privateKeyPath = PRIVATE_KEY,
  provenance = null,
} = {}) {
  mkdirSync(releaseDir, { recursive: true })
  const manifest = buildManifest({
    version,
    artifacts,
    provenance: provenance ?? buildProvenance(),
    builtAt: now.toISOString(),
    components,
  })
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(manifestPath, bytes)
  let signed = false
  if (existsSync(privateKeyPath)) {
    writeFileSync(signaturePath, `${signBytes(bytes, readFileSync(privateKeyPath))}\n`)
    signed = true
  } else if (existsSync(signaturePath)) {
    // 换了机器或丢了私钥重建时，别把上一次的签名留在包里：它跟这份新清单对不上，
    // 下游只会看到「签名校验不通过」，比明说「这个包没签名」更容易被当成遭了篡改
    rmSync(signaturePath, { force: true })
  }
  return { manifest, signed, manifestPath }
}

/** 校验：签名有效 + 每个产物的体积与 sha256 与清单一致。返回 { ok, problems, manifest }。 */
export function verifyReleaseManifest({ releaseDir = join(ROOT, 'release'), manifestPath = MANIFEST, signaturePath = SIGNATURE, publicKeyPath = PUBLIC_KEY } = {}) {
  const problems = []
  if (!existsSync(manifestPath)) return { ok: false, problems: ['没有 release-manifest.json（先跑 make）'], manifest: null }
  const bytes = readFileSync(manifestPath)
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (!existsSync(publicKeyPath)) problems.push('缺少公钥，无法校验签名')
  else if (!existsSync(signaturePath)) problems.push('这个包没有签名（不是用官方密钥打的）')
  else if (!verifySignature(bytes, readFileSync(signaturePath, 'utf8'), readFileSync(publicKeyPath, 'utf8'))) problems.push('签名校验不通过')
  for (const artifact of manifest.artifacts ?? []) {
    const file = join(releaseDir, artifact.path)
    if (!existsSync(file)) {
      problems.push(`产物不见了：${artifact.path}`)
      continue
    }
    const actual = describeArtifact(releaseDir, artifact.path)
    if (actual.size !== artifact.size) problems.push(`${artifact.path} 体积不一致：清单 ${artifact.size}，实际 ${actual.size}`)
    if (actual.sha256 !== artifact.sha256) problems.push(`${artifact.path} sha256 不一致：清单 ${artifact.sha256.slice(0, 12)}…，实际 ${actual.sha256.slice(0, 12)}…`)
  }
  return { ok: problems.length === 0, problems, manifest }
}

export function keygen({ privateKeyPath = PRIVATE_KEY, publicKeyPath = PUBLIC_KEY } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  mkdirSync(dirname(privateKeyPath), { recursive: true })
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  return { privateKeyPath, publicKeyPath }
}

function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

async function main(argv) {
  const [command = 'make', ...rest] = argv
  if (command === 'keygen') {
    const { privateKeyPath, publicKeyPath } = keygen()
    console.log(`私钥（不要外传、建议备份）: ${privateKeyPath}`)
    console.log(`公钥（随仓库分发）      : ${publicKeyPath}`)
    return 0
  }
  if (command === 'make') {
    const version = packageVersion()
    const releaseDir = join(ROOT, 'release')
    const artifacts = collectArtifacts(releaseDir, [`DSH-Setup.exe`, `dsh-x-${version}.spdx.json`])
    if (!artifacts.length) throw new Error('release/ 里没有安装包，先 npm run dist')
    const { collectComponents } = await import('./release-sbom.mjs')
    const { manifest, signed } = writeReleaseManifest({ releaseDir, version, artifacts, components: collectComponents({ nodeDir: join(releaseDir, 'DSH', 'node') }) })
    console.log(`发布清单: ${MANIFEST}`)
    console.log(`版本 ${manifest.version}${manifest.tag ? ` · tag ${manifest.tag}` : ' · 没有 tag'}${manifest.dirty ? ' · 有未提交改动' : ''}`)
    for (const artifact of manifest.artifacts) console.log(`  ${artifact.path}  ${(artifact.size / 1048576).toFixed(1)}MB  ${artifact.sha256.slice(0, 16)}…`)
    console.log(signed ? `已签名: ${SIGNATURE}` : `没有私钥（${PRIVATE_KEY}），本次只出清单没签名；要签名先跑 keygen`)
    return 0
  }
  if (command === 'verify') {
    // verify [目录]：默认核本机 release/；换成别的目录就能核「从 release 页下载下来的一套」
    const dir = rest[0] ? resolve(rest[0]) : join(ROOT, 'release')
    const { ok, problems, manifest } = verifyReleaseManifest({
      releaseDir: dir,
      manifestPath: join(dir, 'release-manifest.json'),
      signaturePath: join(dir, 'release-manifest.sig'),
    })
    for (const problem of problems) console.log(`  ! ${problem}`)
    console.log(ok ? `清单校验通过（DSH-X ${manifest.version}）` : '清单校验未通过')
    return ok ? 0 : 1
  }
  if (command === 'check-tag') {
    const version = packageVersion()
    const tag = rest[0] || git(['describe', '--tags', '--exact-match', 'HEAD'])
    if (!tag) {
      console.log(`HEAD 上没有 tag，跳过一致性检查（发版时用：node scripts/release-manifest.mjs check-tag v${version}）`)
      return 0
    }
    const problem = tagProblem(tag, version)
    if (problem) {
      console.log(`  ! ${problem}`)
      return 1
    }
    console.log(`tag ${tag} 与版本 ${version} 一致`)
    return 0
  }
  console.log('用法: node scripts/release-manifest.mjs <keygen|make|verify|check-tag>')
  return 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (error) {
    console.error(`失败: ${error.message}`)
    process.exit(1)
  }
}
