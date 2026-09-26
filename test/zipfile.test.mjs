/**
 * ZIP 编解码这一层：自己写的档案自己能读回来、系统工具（PowerShell 的 Compress-Archive /
 * Expand-Archive）也认——互操作才是重点，否则导出的包别人打不开。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  crc32,
  crc32Stream,
  fromDosTime,
  looksLikeZip,
  normalizeZipName,
  readZipEntry,
  readZipIndex,
  toDosTime,
  writeZip,
} from '../zipfile.js'

const WIN = process.platform === 'win32'
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

test('CRC32 对得上已知值，流式与一次性结果一致', () => {
  assert.equal(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926)
  assert.equal(crc32(Buffer.from('')), 0)
  const stream = crc32Stream()
  stream.update(Buffer.from('1234'))
  stream.update(Buffer.from('56789'))
  assert.equal(stream.digest(), 0xcbf43926)
})

test('DOS 时间来回一趟（精度就是 2 秒）', () => {
  const date = new Date(2026, 8, 26, 14, 30, 44)
  const { time, date: day } = toDosTime(date)
  assert.deepEqual(fromDosTime(time, day), new Date(2026, 8, 26, 14, 30, 44))
  // 比 1980 还早的时间会被夹到 1980（ZIP 的表达上限）
  assert.equal(fromDosTime(toDosTime(new Date(1970, 0, 1)).time, toDosTime(new Date(1970, 0, 1)).date).getFullYear(), 1980)
})

test('名字归一化：反斜杠、./、开头斜杠都收干净', () => {
  assert.equal(normalizeZipName('dsh-x\\v1\\sessions/a.jsonl'), 'dsh-x/v1/sessions/a.jsonl')
  assert.equal(normalizeZipName('/a/./b/'), 'a/b')
  assert.equal(normalizeZipName('./dsh-x/v1'), 'dsh-x/v1')
})

test('写→读：文本走 deflate、已压过的原样存，大小与 CRC 都对', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-codec-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = join(dir, 'out.zip')
  const textFile = join(dir, 'package.json')
  const binaryFile = join(dir, 'session.jsonl.zstd')
  write(textFile, JSON.stringify({ hello: 'world', 中文: '值' }, null, 2))
  write(binaryFile, 'not-really-compressed-but-named-so')

  const result = await writeZip(target, [
    { name: 'dsh-x/v1/profiles/web/package.json', file: textFile, mtime: new Date(2026, 8, 26, 10, 0, 0) },
    { name: 'dsh-x/v1/sessions/s1/session.jsonl.zstd', file: binaryFile },
    { name: 'dsh-x/v1/note.txt', buffer: Buffer.from('内存里的内容') },
  ])
  assert.equal(result.entries, 3)
  assert.ok(await looksLikeZip(target))
  const { entries } = await readZipIndex(target)
  assert.deepEqual([...entries.keys()].sort(), [
    'dsh-x/v1/note.txt',
    'dsh-x/v1/profiles/web/package.json',
    'dsh-x/v1/sessions/s1/session.jsonl.zstd',
  ])
  const pkg = entries.get('dsh-x/v1/profiles/web/package.json')
  assert.equal(pkg.method, 8, '文本走 deflate')
  assert.equal(pkg.size, readFileSync(textFile).length)
  assert.ok(pkg.compressedSize < pkg.size, '压得动才叫压')
  assert.equal(entries.get('dsh-x/v1/sessions/s1/session.jsonl.zstd').method, 0, '.zstd 不再压一遍')
  assert.equal(pkg.mtime.getFullYear(), 2026)

  const back = await readZipEntry(target, pkg)
  assert.equal(back.toString('utf8'), readFileSync(textFile, 'utf8'))
  assert.equal((await readZipEntry(target, entries.get('dsh-x/v1/note.txt'))).toString('utf8'), '内存里的内容')
  assert.ok((await readZipEntry(target, entries.get('dsh-x/v1/sessions/s1/session.jsonl.zstd'))).toString().startsWith('not-really'))

  // 流式读：分块回调拿到的拼起来要一样
  const chunks = []
  await readZipEntry(target, pkg, (chunk) => chunks.push(chunk))
  assert.equal(Buffer.concat(chunks).toString('utf8'), readFileSync(textFile, 'utf8'))
})

test('从旧档案里原样搬条目：内容不变、压缩数据不重压', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-copy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = join(dir, 'v1.zip')
  const second = join(dir, 'v2.zip')
  const file = join(dir, 'a.txt')
  write(file, 'keep me intact'.repeat(50))
  await writeZip(first, [{ name: 'dsh-x/v1/a.txt', file }])
  const index = await readZipIndex(first)
  const old = index.entries.get('dsh-x/v1/a.txt')

  write(file, 'fresh content')
  await writeZip(second, [
    // 一个搬过来的、一个新写的
    { name: 'dsh-x/v1/a.txt', copy: { file: first, entry: old } },
    { name: 'dsh-x/v1/b.txt', file },
  ])
  const after = await readZipIndex(second)
  const kept = after.entries.get('dsh-x/v1/a.txt')
  assert.equal(kept.compressedSize, old.compressedSize, '压缩数据原样搬，不解也不重压')
  assert.equal((await readZipEntry(second, kept)).toString(), 'keep me intact'.repeat(50))
  assert.equal((await readZipEntry(second, after.entries.get('dsh-x/v1/b.txt'))).toString(), 'fresh content')
})

test('坏输入给人话，不吐垃圾', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const notZip = join(dir, 'x.zip')
  write(notZip, 'hello'.repeat(20))
  await assert.rejects(() => readZipIndex(notZip), /不是一个 ZIP 文件/)
  assert.equal(await looksLikeZip(notZip), false)
  assert.equal(await looksLikeZip(join(dir, 'nope.zip')), false)
  await assert.rejects(() => readZipIndex(join(dir, 'nope.zip')), /ENOENT|no such file/i)
})

test('系统工具认我们写的包（PowerShell 解压出来内容一致）', { skip: WIN ? false : '只在 Windows 上验 PowerShell' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-interop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = join(dir, 'out.zip')
  const out = join(dir, 'expanded')
  await writeZip(target, [
    { name: 'dsh-x/v1/sessions/proj/s1/session.jsonl.zstd', buffer: Buffer.from('系统工具也读得出来') },
    { name: 'dsh-x/v1/profiles/web/package.json', buffer: Buffer.from('{"a":1}') },
  ])
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${target}' -DestinationPath '${out}' -Force`], { stdio: 'pipe' })
  assert.equal(readFileSync(join(out, 'dsh-x', 'v1', 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8'), '系统工具也读得出来')
  assert.equal(readFileSync(join(out, 'dsh-x', 'v1', 'profiles', 'web', 'package.json'), 'utf8'), '{"a":1}')
})

test('别人打的包我们也读得动（Compress-Archive 写、我们读）', { skip: WIN ? false : '只在 Windows 上验 PowerShell' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-foreign-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'dsh-backup')
  write(join(source, 'dsh-x', 'v1', 'sessions', 'p', 's1', 'session.jsonl.zstd'), '别人的压缩工具写的')
  write(join(source, 'dsh-x', 'v1', 'note.txt'), 'hello interop')
  const target = join(dir, 'foreign.zip')
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${join(source, 'dsh-x')}' -DestinationPath '${target}' -Force`], { stdio: 'pipe' })
  assert.ok(existsSync(target))
  const { entries } = await readZipIndex(target)
  const names = [...entries.keys()]
  assert.ok(names.includes('dsh-x/v1/note.txt'), `读到的条目：${names.join(', ')}`)
  assert.equal((await readZipEntry(target, entries.get('dsh-x/v1/note.txt'))).toString(), 'hello interop')
  assert.equal((await readZipEntry(target, entries.get('dsh-x/v1/sessions/p/s1/session.jsonl.zstd'))).toString(), '别人的压缩工具写的')
})
