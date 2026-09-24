import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectArtifacts,
  describeArtifact,
  keygen,
  parseTagVersion,
  signBytes,
  tagProblem,
  verifyReleaseManifest,
  verifySignature,
  writeReleaseManifest,
} from '../scripts/release-manifest.mjs'
import { buildSbom, collectComponents, collectShippedFiles } from '../scripts/release-sbom.mjs'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('tag 认得 v1.2.3 / 1.2.3-beta.1，别的认不出来', () => {
  assert.equal(parseTagVersion('v0.1.13'), '0.1.13')
  assert.equal(parseTagVersion('0.1.13'), '0.1.13')
  assert.equal(parseTagVersion('v1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(parseTagVersion('release-1.2'), null)
  assert.equal(parseTagVersion(''), null)
  assert.equal(parseTagVersion(undefined), null)
})

test('tag 与版本不一致要挡住（发版前的闸门）', () => {
  assert.equal(tagProblem('v0.1.13', '0.1.13'), null, '一致时放行')
  assert.match(tagProblem('v0.1.12', '0.1.13'), /不一致/, '版本对不上要报出来')
  assert.match(tagProblem('nonsense', '0.1.13'), /认不出来/, '认不出的 tag 也要报出来')
})

test('签名能验，改一个字节就验不过', () => {
  const box = sandbox()
  try {
    const privateKeyPath = join(box.dir, 'key.pem')
    const publicKeyPath = join(box.dir, 'pub.pem')
    keygen({ privateKeyPath, publicKeyPath })
    const bytes = Buffer.from('{"version":"9.9.9"}\n', 'utf8')
    const signature = signBytes(bytes, readFileSync(privateKeyPath, 'utf8'))
    const publicKey = readFileSync(publicKeyPath, 'utf8')
    assert.equal(verifySignature(bytes, signature, publicKey), true)
    assert.equal(verifySignature(Buffer.from('{"version":"9.9.8"}\n', 'utf8'), signature, publicKey), false, '内容变了必须验不过')
    assert.equal(verifySignature(bytes, 'bm90LWEtc2ln', publicKey), false, '垃圾签名不能当通过')
  } finally {
    box.done()
  }
})

test('清单记下产物的哈希与体积，产物被换掉后 verify 会抓住', () => {
  const box = sandbox()
  try {
    const releaseDir = join(box.dir, 'release')
    mkdirSync(releaseDir, { recursive: true })
    const exe = join(releaseDir, 'DSH-Setup.exe')
    writeFileSync(exe, Buffer.from('fake installer bytes'))

    const artifacts = collectArtifacts(releaseDir, ['DSH-Setup.exe', 'dsh-x-9.9.9.spdx.json'])
    assert.equal(artifacts.length, 1, '不存在的产物不该进清单')
    assert.equal(artifacts[0].size, Buffer.from('fake installer bytes').length)
    assert.equal(artifacts[0].sha256, describeArtifact(releaseDir, 'DSH-Setup.exe').sha256)

    const privateKeyPath = join(box.dir, 'key.pem')
    const publicKeyPath = join(box.dir, 'pub.pem')
    keygen({ privateKeyPath, publicKeyPath })
    const manifestPath = join(box.dir, 'release-manifest.json')
    const signaturePath = join(box.dir, 'release-manifest.sig')
    const { manifest, signed } = writeReleaseManifest({
      releaseDir,
      version: '9.9.9',
      artifacts,
      provenance: { commit: 'deadbeef', tag: 'v9.9.9', dirty: false },
      now: new Date('2026-01-01T00:00:00Z'),
      privateKeyPath,
      manifestPath,
      signaturePath,
    })
    assert.equal(signed, true, '有私钥就该签名')
    assert.equal(manifest.version, '9.9.9')
    assert.equal(manifest.tag, 'v9.9.9')
    assert.equal(manifest.signature.algorithm, 'ed25519')
    assert.equal(manifest.builtAt, '2026-01-01T00:00:00.000Z')

    const good = verifyReleaseManifest({ releaseDir, manifestPath, signaturePath, publicKeyPath })
    assert.deepEqual(good.problems, [], '刚生成的清单应该干净通过')
    assert.equal(good.ok, true)

    writeFileSync(exe, Buffer.from('tampered installer'))
    const bad = verifyReleaseManifest({ releaseDir, manifestPath, signaturePath, publicKeyPath })
    assert.equal(bad.ok, false, '产物被换掉必须验不过')
    assert.ok(bad.problems.some((problem) => problem.includes('DSH-Setup.exe')), `要指出是哪个产物：${bad.problems}`)
  } finally {
    box.done()
  }
})

test('没私钥重建会清掉上一次的签名，verify 明说「没签名」而不是「验不过」', () => {
  const box = sandbox()
  try {
    const releaseDir = join(box.dir, 'release')
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(join(releaseDir, 'DSH-Setup.exe'), Buffer.from('installer'))
    const artifacts = collectArtifacts(releaseDir, ['DSH-Setup.exe'])
    const privateKeyPath = join(box.dir, 'key.pem')
    const publicKeyPath = join(box.dir, 'pub.pem')
    keygen({ privateKeyPath, publicKeyPath })
    const manifestPath = join(box.dir, 'release-manifest.json')
    const signaturePath = join(box.dir, 'release-manifest.sig')
    const base = { releaseDir, version: '9.9.9', artifacts, provenance: { commit: 'x', tag: null, dirty: false }, manifestPath, signaturePath }
    writeReleaseManifest({ ...base, privateKeyPath })
    assert.ok(existsSync(signaturePath), '有私钥时应写出签名')

    // 换台机器/丢了私钥：重建时旧签名必须清掉，否则下游会以为包被人动过
    rmSync(privateKeyPath)
    const again = writeReleaseManifest({ ...base, privateKeyPath })
    assert.equal(again.signed, false)
    assert.equal(existsSync(signaturePath), false, '没私钥就该把旧签名清掉')

    const { ok, problems } = verifyReleaseManifest({ releaseDir, manifestPath, signaturePath, publicKeyPath })
    assert.equal(ok, false, '没签名的包不应算核过')
    assert.ok(problems.some((item) => item.includes('没有签名')), `要说清是没签名：${problems}`)
    assert.ok(!problems.some((item) => item.includes('签名校验不通过')), '不能报成「签名不对」，那会被当成遭篡改')
  } finally {
    box.done()
  }
})

test('allowUnsigned：没签名只提醒，体积和哈希照样得对上', () => {
  const box = sandbox()
  try {
    const releaseDir = join(box.dir, 'release')
    mkdirSync(releaseDir, { recursive: true })
    const exe = join(releaseDir, 'DSH-Setup.exe')
    writeFileSync(exe, Buffer.from('installer'))
    const publicKeyPath = join(box.dir, 'pub.pem')
    keygen({ privateKeyPath: join(box.dir, 'key.pem'), publicKeyPath })
    const exported = writeReleaseManifest({
      releaseDir,
      version: '9.9.9',
      artifacts: collectArtifacts(releaseDir, ['DSH-Setup.exe']),
      provenance: { commit: 'x', tag: null, dirty: false },
      privateKeyPath: join(box.dir, 'no-such-key.pem'), // 没配私钥：只出清单
      manifestPath: join(box.dir, 'release-manifest.json'),
      signaturePath: join(box.dir, 'release-manifest.sig'),
    })
    assert.equal(exported.signed, false)

    const relaxed = verifyReleaseManifest({ releaseDir, manifestPath: exported.manifestPath, signaturePath: join(box.dir, 'release-manifest.sig'), publicKeyPath, allowUnsigned: true })
    assert.equal(relaxed.ok, true, '明确允许未签名时应算核过')
    assert.equal(relaxed.unsigned, true, '要能说清这次是未签名')

    writeFileSync(exe, Buffer.from('tampered installer'))
    const bad = verifyReleaseManifest({ releaseDir, manifestPath: exported.manifestPath, signaturePath: join(box.dir, 'release-manifest.sig'), publicKeyPath, allowUnsigned: true })
    assert.equal(bad.ok, false, '放过签名不等于放过体积/哈希')
    assert.ok(bad.problems.some((item) => item.includes('不一致')), `对不上的文件要点名：${bad.problems}`)
  } finally {
    box.done()
  }
})

test('SBOM：运行时按条目声明，启动器自己的文件逐个带哈希', () => {
  const box = sandbox()
  try {
    const releaseDir = join(box.dir, 'release')
    const dshDir = join(releaseDir, 'DSH')
    mkdirSync(join(dshDir, 'public'), { recursive: true })
    mkdirSync(join(dshDir, 'node', 'node_modules', 'pnpm'), { recursive: true })
    writeFileSync(join(releaseDir, 'DSH-Setup.exe'), Buffer.from('installer'))
    writeFileSync(join(dshDir, 'server.js'), '// server\n')
    writeFileSync(join(dshDir, 'public', 'index.html'), '<html></html>\n')
    writeFileSync(join(dshDir, 'node', 'node.exe'), 'not a real exe')
    writeFileSync(join(dshDir, 'node', 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: '8.15.9' }))

    const files = collectShippedFiles(dshDir)
    assert.ok(files.includes('server.js'), '启动器自己的文件要列进去')
    assert.ok(files.includes('public/index.html'))
    assert.ok(!files.some((name) => name.startsWith('node/')), 'node/ 里不逐个列文件（按运行时条目声明）')

    const components = collectComponents({ nodeDir: join(dshDir, 'node') })
    assert.equal(components.pnpm, '8.15.9', '从包自带 package.json 读版本')
    assert.equal(components.node, undefined, '假 exe 跑不起来就该如实缺席，不能瞎编版本')

    const sbom = buildSbom({
      version: '9.9.9',
      commit: 'abcdef1234',
      builtAt: '2026-01-01T00:00:00Z',
      components,
      files,
      extras: ['DSH-Setup.exe'],
      releaseDir,
      dshDir,
    })
    assert.equal(sbom.spdxVersion, 'SPDX-2.3')
    assert.equal(sbom.SPDXID, 'SPDXRef-DOCUMENT')
    assert.equal(sbom.packages[0].name, 'DSH-X')
    assert.equal(sbom.packages[0].versionInfo, '9.9.9')
    assert.ok(sbom.packages.some((item) => item.name === 'pnpm' && item.versionInfo === '8.15.9'))
    assert.ok(sbom.files.length >= 4, `安装包 + 启动器文件 + node.exe 都要在：${sbom.files.map((f) => f.fileName)}`)
    for (const file of sbom.files) {
      assert.equal(file.checksums[0].algorithm, 'SHA256')
      assert.equal(file.checksums[0].checksumValue.length, 64)
    }
    const kinds = new Set(sbom.relationships.map((item) => item.relationshipType))
    assert.ok(kinds.has('DESCRIBES'), '文档要 describe 这个发行物')
    assert.ok(kinds.has('CONTAINS'), '要声明包含关系')
    assert.ok(sbom.documentNamespace.includes('9.9.9'), '命名空间带版本，便于区分多次构建')
  } finally {
    box.done()
  }
})
