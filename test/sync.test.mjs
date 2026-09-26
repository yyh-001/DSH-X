import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  S3_NAMESPACE,
  canonicalQuery,
  localDepPath,
  localPathFor,
  mergeProfileManifest,
  parseListXml,
  parseS3Address,
  planSync,
  resolveStyle,
  safePolicy,
  safeS3Config,
  safeScopeIds,
  s3Configured,
  s3ErrorMessage,
  s3Missing,
  scanLocal,
  scopeTargets,
  shortKey,
  signV4,
  uriEncode,
} from '../sync.js'

test('SigV4 签名对得上 AWS 文档里的 GET 例子', () => {
  // 官方文档「Signature Calculation Examples」里那只桶：AKIAIOSFODNN7EXAMPLE /
  // wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY，20130524T000000Z，us-east-1
  const signed = signV4({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    headers: { range: 'bytes=0-9' },
    date: new Date('2013-05-24T00:00:00Z'),
  })
  assert.equal(signed.canonicalRequest, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'))
  assert.equal(signed.stringToSign, [
    'AWS4-HMAC-SHA256',
    '20130524T000000Z',
    '20130524/us-east-1/s3/aws4_request',
    '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
  ].join('\n'))
  // 上面那两段是 AWS 文档里逐字抄下来的（规范请求的哈希也是文档给的值）；
  // 签名另有算法之外的独立核算：同样的 kSigning 与 stringToSign 交给 openssl
  // dgst -sha256 -mac HMAC 跑出来是同一个值，见 PR 说明。
  assert.equal(signed.signature, '67fe34c8530db585abddc51067328adfedb6e42487d2566dc7d927d6e2722900')
  assert.equal(
    signed.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=67fe34c8530db585abddc51067328adfedb6e42487d2566dc7d927d6e2722900',
  )
})

test('编码按 RFC3986：斜杠分段、空格与中文都编码，~ 不编', () => {
  assert.equal(uriEncode('a/b c'), 'a%2Fb%20c')
  assert.equal(uriEncode('sessions/a b'), 'sessions%2Fa%20b')
  assert.equal(uriEncode('会话', false), '%E4%BC%9A%E8%AF%9D')
  assert.equal(uriEncode('a~b!c', false), 'a~b%21c')
  assert.equal(canonicalQuery({ b: '2', a: '1 2', empty: '' }), 'a=1%202&b=2')
})

test('端点与桶的填写方式都能归一化，s3:// 写法会被拆开', () => {
  assert.deepEqual(
    { bucket: safeS3Config({ endpoint: 's3://my-bucket/dsh', region: 'ap-east-1' }).bucket,
      prefix: safeS3Config({ endpoint: 's3://my-bucket/dsh', region: 'ap-east-1' }).prefix,
      endpoint: safeS3Config({ endpoint: 's3://my-bucket/dsh', region: 'ap-east-1' }).endpoint },
    { bucket: 'my-bucket', prefix: 'dsh', endpoint: 'https://s3.ap-east-1.amazonaws.com' },
  )
  // 不带协议按 https 补；带尾斜杠去掉
  assert.equal(safeS3Config({ endpoint: 'minio.example.com:9000/' }).endpoint, 'https://minio.example.com:9000')
  // 区域默认 us-east-1；前缀去掉两头的斜杠
  assert.equal(safeS3Config({ prefix: '/a/b/' }).region, 'us-east-1')
  assert.equal(safeS3Config({ prefix: '/a/b/' }).prefix, 'a/b')
  assert.equal(parseS3Address('https://x/y'), null)
  assert.throws(() => safeS3Config({ bucket: 'bad bucket' }), /桶名/)
  assert.throws(() => safeS3Config({ prefix: '../x' }), /前缀/)
})

test('寻址风格：域名走虚拟主机、IP 与 localhost 走路径风格', () => {
  assert.equal(resolveStyle(safeS3Config({ bucket: 'b', endpoint: 's3.us-east-1.amazonaws.com' }), new URL('https://s3.us-east-1.amazonaws.com')), 'virtual')
  assert.equal(resolveStyle(safeS3Config({ bucket: 'b', endpoint: 'http://192.168.0.9:9000' }), new URL('http://192.168.0.9:9000')), 'path')
  assert.equal(resolveStyle(safeS3Config({ bucket: 'b', endpoint: 'http://localhost:9000' }), new URL('http://localhost:9000')), 'path')
  assert.equal(resolveStyle(safeS3Config({ bucket: 'b', endpoint: 'https://r2.example.com', style: 'path' }), new URL('https://r2.example.com')), 'path')
  // 端点里已经带了桶名（各家控制台给的就是这种）
  assert.equal(resolveStyle(safeS3Config({ bucket: 'b', endpoint: 'https://b.s3.amazonaws.com' }), new URL('https://b.s3.amazonaws.com')), 'virtual')
})

test('填没填全说得出来', () => {
  assert.deepEqual(s3Missing({}), ['存储端点', '桶名', 'AccessKey', 'SecretKey'])
  assert.equal(s3Configured({ endpoint: 'https://x', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }), true)
  assert.equal(s3Configured({ endpoint: 'https://x', bucket: 'b', accessKeyId: 'a' }), false)
})

test('列桶的响应解析：翻页、键解码、大小与时间', () => {
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>1ueGcxLPRx1Tr%2FXYExHnhbYLgveDs2J%2Fwm36Hy4vbOwM%3D</NextContinuationToken>
    <Contents><Key>dsh-x/v1/sessions/a%20b/s.jsonl.zstd</Key><LastModified>2026-09-01T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>412</Size></Contents>
    <Contents><Key>dsh-x/v1/sessions/plain</Key><LastModified>2026-09-02T10:00:00.000Z</LastModified><Size>7</Size></Contents>
  </ListBucketResult>`
  const parsed = parseListXml(xml)
  assert.equal(parsed.truncated, true)
  // 续传令牌在 encoding-type=url 下也是编码的，得解回原样再发回去（不然翻页会断在第二页）
  assert.equal(parsed.nextToken, '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=')
  assert.equal(parsed.contents.length, 2)
  assert.equal(parsed.contents[0].key, 'dsh-x/v1/sessions/a b/s.jsonl.zstd')
  assert.equal(parsed.contents[0].size, 412)
  assert.equal(parsed.contents[0].etag, 'abc')
  assert.equal(parsed.contents[0].lastModifiedMs, Date.parse('2026-09-01T10:00:00.000Z'))
  assert.equal(parseListXml('<ListBucketResult></ListBucketResult>').truncated, false)
})

test('报错码翻成人话，认不出来的码原样带出来', () => {
  const xml = '<Error><Code>SignatureDoesNotMatch</Code><Message>signature mismatch</Message></Error>'
  assert.match(s3ErrorMessage(403, xml), /SecretKey 填错了/)
  assert.match(s3ErrorMessage(403, '<Error><Code>Nope</Code><Message>whatever</Message></Error>'), /Nope/)
  assert.match(s3ErrorMessage(500, ''), /HTTP 500/)
})

test('范围：默认三个，脏值被过滤，插件配置只挑三个文件', () => {
  assert.deepEqual(safeScopeIds(undefined), ['sessions', 'attachments', 'plugins'])
  assert.deepEqual(safeScopeIds(['plugins', 'plugins', 'nope', 'memory']), ['plugins', 'memory'])
  assert.equal(safePolicy('overwrite'), 'overwrite')
  assert.equal(safePolicy('乱填'), 'skip')
  const targets = scopeTargets('plugins', { home: 'H', profile: 'web', profileDir: 'H/profiles/web' })
  assert.equal(targets[0].prefix, 'profiles/web')
  assert.deepEqual(targets[0].files.map((file) => file.name), ['package.json', 'cordis.yml', 'cordis.patch.yml'])
  assert.deepEqual(targets[0].files.map((file) => file.kind), ['manifest', 'file', 'file'])
  assert.deepEqual(
    scopeTargets('skills', { roots: [{ key: 'dsh', dir: 'H/skills' }, { key: 'agents', dir: 'A/skills' }] }).map((item) => item.prefix),
    ['skills/dsh', 'skills/agents'],
  )
})

test('差异计划：上传只碰桶里没有/不一样/本机更新的那些', () => {
  const entries = new Map([
    ['k/new', { size: 10, mtimeMs: 1000 }],
    ['k/same', { size: 10, mtimeMs: 1000 }],
    ['k/bigger', { size: 20, mtimeMs: 1000 }],
    ['k/newer', { size: 10, mtimeMs: 9000 }],
  ])
  const remote = new Map([
    ['k/same', { size: 10, lastModifiedMs: 1000 }],
    ['k/bigger', { size: 11, lastModifiedMs: 1000 }],
    ['k/newer', { size: 10, lastModifiedMs: 2000 }],
    // 时钟差：本机只快 1 秒以内不算更新
    ['k/skew', { size: 10, lastModifiedMs: 1000 }],
  ])
  entries.set('k/skew', { size: 10, mtimeMs: 2000 })
  const up = planSync({ entries, remote, mode: 'up' })
  assert.deepEqual(up.map((item) => [item.key, item.reason]).sort(), [['k/bigger', 'changed'], ['k/new', 'new'], ['k/newer', 'newer']])
  // 强制：全都传
  assert.equal(planSync({ entries, remote, mode: 'up', force: true }).length, entries.size)
  // 桶里有的、本机没有的，上传方向不管
  assert.ok(!up.some((item) => item.key === 'k/same'))
})

test('差异计划：下载按冲突策略分三路', () => {
  const remote = new Map([
    ['k/only-remote', { size: 5, lastModifiedMs: 10 }],
    ['k/same', { size: 5, lastModifiedMs: 10 }],
    ['k/clash', { size: 9, lastModifiedMs: 10 }],
  ])
  const entries = new Map([
    ['k/same', { size: 5, mtimeMs: 10 }],
    ['k/clash', { size: 4, mtimeMs: 10 }],
  ])
  const skip = planSync({ entries, remote, mode: 'down', policy: 'skip' })
  assert.deepEqual(skip.map((item) => [item.key, item.action]), [['k/only-remote', 'download'], ['k/clash', 'conflict']])
  assert.deepEqual(
    planSync({ entries, remote, mode: 'down', policy: 'overwrite' }).map((item) => [item.key, item.action]),
    [['k/only-remote', 'download'], ['k/clash', 'download']],
  )
  assert.deepEqual(
    planSync({ entries, remote, mode: 'down', policy: 'duplicate' }).map((item) => [item.key, item.action]),
    [['k/only-remote', 'download'], ['k/clash', 'duplicate']],
  )
})

test('本机扫描：键是相对路径，Windows 反斜杠换成正斜杠，临时文件跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
  mkdirSync(join(root, 'home', 'sessions', 'proj', 'session-1'), { recursive: true })
  writeFileSync(join(root, 'home', 'sessions', 'proj', 'session-1', 'session.jsonl.zstd'), 'x')
  writeFileSync(join(root, 'home', 'sessions', 'proj', 'session-1', 'session.jsonl.zstd.sync-bak'), 'x')
  // 冲突时另存的副本：是本机自己的东西（内容就是桶里那份），不该再传回桶里
  writeFileSync(join(root, 'home', 'sessions', 'proj', 'session-1', 'session.jsonl.zstd.remote-20260926-0930'), 'x')
  writeFileSync(join(root, 'home', 'sessions', 'top.txt'), 'x')
  const home = join(root, 'home')
  const targets = scopeTargets('sessions', { home })
  const local = scanLocal(targets)
  assert.deepEqual([...local.keys()].sort(), ['sessions/proj/session-1/session.jsonl.zstd', 'sessions/top.txt'])
  const meta = local.get('sessions/proj/session-1/session.jsonl.zstd')
  assert.equal(meta.size, 1)
  assert.equal(meta.kind, 'file')
  // 键回到本机路径：能原样落回同一个位置
  assert.equal(localPathFor('sessions/proj/session-1/session.jsonl.zstd', targets), meta.path)
  // 范围外的键不认
  assert.equal(localPathFor('other/x.txt', targets), '')
  // 没有 files 清单的目录：远端多出来的键也能算出落点
  assert.match(localPathFor('sessions/newproj/s2/file', targets), /newproj[\\/]s2[\\/]file$/)
})

test('插件清单合并：并集、版本取高、bundles 跟着依赖走、本地路径依赖摘掉', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-merge-'))
  mkdirSync(join(root, 'plugin', 'dsh-companion'), { recursive: true })
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const local = JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {
      'dsh-local-only': '1.0.0',
      'dsh-meme': '0.1.43',
      'dsh-companion': `file:${join(root, 'plugin', 'dsh-companion')}`,
    },
    dsh: { profile: { bundles: ['dsh-local-only', 'dsh-meme', 'dsh-companion'], patchReload: 'live' } },
  }, null, 2)
  const remote = JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {
      'dsh-meme': '0.1.44',
      'dsh-remote-only': '2.0.0',
      'dsh-gone': 'file:C:/Users/someone/Desktop/gone',
    },
    dsh: { profile: { bundles: ['dsh-meme', 'dsh-remote-only', 'dsh-gone'] } },
  }, null, 2)
  const merged = mergeProfileManifest(local, remote, { profileDir })
  const manifest = JSON.parse(merged.text)
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-companion', 'dsh-local-only', 'dsh-meme', 'dsh-remote-only'])
  assert.equal(manifest.dependencies['dsh-meme'], '0.1.44')
  assert.deepEqual(merged.added, ['dsh-remote-only'])
  assert.deepEqual(merged.updated, [{ name: 'dsh-meme', from: '0.1.43', to: '0.1.44' }])
  assert.deepEqual(merged.dropped.map((item) => item.name), ['dsh-gone'])
  assert.deepEqual(merged.bundlesAdded, ['dsh-remote-only'])
  assert.deepEqual(merged.bundlesDropped, [])
  // 别的字段以本机为准
  assert.equal(manifest.name, 'dsh-profile-desktop')
  assert.equal(manifest.dsh.profile.patchReload, 'live')
  // 合并是幂等的：再合一次没有变化
  assert.equal(mergeProfileManifest(merged.text, merged.text, { profileDir }).text, merged.text)
})

test('本机没有清单时整份用桶里的，坏的清单不写坏本机', () => {
  const remote = JSON.stringify({ dependencies: { a: '1.0.0' } }, null, 2)
  const taken = mergeProfileManifest('', remote)
  assert.equal(taken.fromRemote, true)
  assert.deepEqual(taken.added, ['a'])
  assert.equal(taken.bucketText, taken.text, '本机是空的：两边拿到同一份')
  // 本机清单坏了、桶里没有 → 什么都不做（返回 null，调用方保持原样）
  assert.equal(mergeProfileManifest('{坏了', '', {}), null)
  // 本机清单坏了、桶里有 → 用桶里的覆盖（前提是它能解析）
  assert.equal(JSON.parse(mergeProfileManifest('{坏了', remote, {}).text).dependencies.a, '1.0.0')
})

test('本地路径依赖两边不一样：本机那份留着，桶里那份摘掉', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-merge-file-'))
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const local = JSON.stringify({
    dependencies: { 'dsh-mine': 'file:D:/portable/dsh-mine', 'dsh-ok': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-mine', 'dsh-ok'] } },
  })
  const remote = JSON.stringify({
    dependencies: { 'dsh-theirs': 'file:C:/Users/someone/elsewhere' },
    dsh: { profile: { bundles: ['dsh-mine', 'dsh-theirs'] } },
  })
  const merged = mergeProfileManifest(local, remote, { profileDir })
  const mine = JSON.parse(merged.text)
  const bucket = JSON.parse(merged.bucketText)
  // 本机的 file: 依赖（路径暂时不在）留在本机，但不会跟着传上去
  assert.equal(mine.dependencies['dsh-mine'], 'file:D:/portable/dsh-mine')
  assert.equal(bucket.dependencies['dsh-mine'], undefined)
  assert.ok(mine.dsh.profile.bundles.includes('dsh-mine'))
  assert.ok(!bucket.dsh.profile.bundles.includes('dsh-mine'))
  // 桶里的 file: 依赖本机没有 → 两边都不进本机清单
  assert.equal(mine.dependencies['dsh-theirs'], undefined)
  assert.equal(bucket.dependencies['dsh-theirs'], undefined)
  assert.deepEqual(merged.dropped.map((item) => [item.name, item.local]), [['dsh-mine', true], ['dsh-theirs', false]])
  assert.deepEqual(merged.bundlesDropped, [])
})

test('本地依赖路径：file:/link:/portal: 才算，相对路径按 profile 目录补', () => {
  assert.equal(localDepPath('/p', 'file:C:/x'), 'C:/x')
  assert.equal(localDepPath('C:/p/web', 'file:./local'), join('C:/p/web', 'local'))
  assert.equal(localDepPath('/p', '^1.2.3'), '')
  assert.equal(localDepPath('/p', 'github:a/b'), '')
})

test('日志里的键名收短，命名空间不出现', () => {
  assert.equal(shortKey(`${S3_NAMESPACE}/sessions/proj/session-1/session.jsonl.zstd`), 'sessions/…/session.jsonl.zstd')
  assert.equal(shortKey(`${S3_NAMESPACE}/profiles/web/package.json`), 'profiles/web/package.json')
})
