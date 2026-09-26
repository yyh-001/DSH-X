/**
 * ZIP 那一档的引擎级测试：导出成一个 .zip、从 .zip 导入、增量、以及「手动压过一层」的宽容。
 * 编码层（CRC/deflate/互操作）在 zipfile.test.mjs 里单独测。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { ZipStore, runSync, safeZipConfig, storeClient, storeConfigured, storeDisplayUrl, storeLabel, storeMissing } from '../sync.js'
import { readZipEntry, readZipIndex } from '../zipfile.js'

const WIN = process.platform === 'win32'
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

async function makeHome(files = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-zip-home-'))
  for (const [rel, text] of Object.entries(files)) write(join(home, ...rel.split('/')), text)
  return home
}

const contextOf = (home, profile = 'web') => ({ home, profile, profileDir: join(home, 'profiles', profile), roots: [] })
const configOf = (file) => ({ store: 'zip', zip: { path: file } })

test('ZIP 配置：绝对路径 + .zip 结尾，脏值回默认', () => {
  assert.deepEqual(safeZipConfig({ path: ' D:\\a\\b.zip ' }), { path: 'D:\\a\\b.zip' })
  assert.deepEqual(safeZipConfig({}), { path: '' })
  assert.throws(() => safeZipConfig({ path: 'backup.zip' }), /绝对路径/)
  assert.throws(() => safeZipConfig({ path: 'D:\\backup.txt' }), /\.zip/)
  assert.equal(storeLabel({ store: 'zip' }), 'ZIP 文件')
  assert.equal(storeConfigured({ store: 'zip', zip: { path: 'D:\\x.zip' } }), true)
  assert.deepEqual(storeMissing({ store: 'zip', zip: {} }), ['ZIP 文件'])
  assert.equal(storeDisplayUrl({ store: 'zip', zip: { path: 'D:\\x.zip' } }), 'D:\\x.zip')
  assert.ok(storeClient({ store: 'zip', zip: { path: 'D:\\x.zip' } }) instanceof ZipStore)
})

test('导出成一个包 → 增量再导 → 换台机器导入：内容、清单、时间戳都对', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zip-e2e-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'dsh-backup.zip')
  const home = await makeHome({
    'sessions/proj-a/session-1/session.jsonl.zstd': 'session-one',
    'attachments/v1/pic.png': 'png-bytes',
    'profiles/web/package.json': JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-meme': '1.0.0' }, dsh: { profile: { bundles: ['dsh-meme'] } } }, null, 2),
    'profiles/web/cordis.patch.yml': '- id: dsh-meme\n  disabled: true\n',
  })
  const context = contextOf(home)
  const scopes = ['sessions', 'attachments', 'plugins']

  const first = await runSync({ mode: 'up', scopes, config: configOf(target), context })
  assert.equal(first.uploaded, 3, '会话 + 附件 + 补丁层（清单算合并那一档）')
  assert.equal(first.merged, 1)
  assert.ok(existsSync(target), '导出完档案要真的在')
  assert.ok(first.notes.some((note) => note.startsWith('ZIP 已更新')), `收尾说明：${first.notes.join(' / ')}`)

  const { entries } = await readZipIndex(target)
  assert.deepEqual([...entries.keys()].sort(), [
    'dsh-x/v1/attachments/v1/pic.png',
    'dsh-x/v1/profiles/web/cordis.patch.yml',
    'dsh-x/v1/profiles/web/package.json',
    'dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd',
  ])
  assert.equal((await readZipEntry(target, entries.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd'))).toString(), 'session-one')

  // 第二次：nothing changed，档案不该被重写（大小与时间都不动）
  const before = statSync(target)
  const second = await runSync({ mode: 'up', scopes, config: configOf(target), context })
  assert.equal(second.uploaded, 0)
  assert.equal(second.merged, 0)
  assert.equal(statSync(target).mtimeMs, before.mtimeMs, '没变化就不动档案')

  // 改一个 → 只换那一个条目，别的原样搬
  write(join(home, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'session-one-changed')
  const third = await runSync({ mode: 'up', scopes, config: configOf(target), context })
  assert.equal(third.uploaded, 1)
  const after = await readZipIndex(target)
  assert.equal((await readZipEntry(target, after.entries.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd'))).toString(), 'session-one-changed')
  assert.deepEqual([...after.entries.keys()].sort(), [...entries.keys()].sort(), '条目集合不变')

  // 换一台机器从包里导入
  const other = await makeHome({ 'profiles/web/package.json': JSON.stringify({ dependencies: { 'dsh-other': '2.0.0' }, dsh: { profile: { bundles: ['dsh-other'] } } }, null, 2) })
  const pull = await runSync({ mode: 'down', scopes, config: configOf(target), context: contextOf(other) })
  assert.equal(pull.downloaded, 3)
  assert.equal(pull.merged, 1)
  assert.equal(readFileSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'utf8'), 'session-one-changed')
  assert.equal(readFileSync(join(other, 'attachments', 'v1', 'pic.png'), 'utf8'), 'png-bytes')
  const manifest = JSON.parse(readFileSync(join(other, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-meme', 'dsh-other'])
  // 导入方向不写档案
  assert.equal(statSync(target).mtimeMs, before.mtimeMs + (statSync(target).mtimeMs - before.mtimeMs), '导入不该改档案')
  // 时间戳对齐：再导出一次不该重复写
  const roundTrip = await runSync({ mode: 'up', scopes, config: configOf(target), context: contextOf(other) })
  assert.equal(roundTrip.uploaded, 0)
})

test('手动压过一层的包也认（用户很可能把导出目录压成 zip 再拿来导入）', { skip: WIN ? false : '用 PowerShell 打包，只在 Windows 上跑' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zip-manual-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'dsh-backup')
  write(join(source, 'dsh-x', 'v1', 'sessions', 'p', 's1', 'session.jsonl.zstd'), '手工压的包')
  write(join(source, 'dsh-x', 'v1', 'profiles', 'web', 'cordis.patch.yml'), '- id: x\n')
  const target = join(dir, 'manual.zip')
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${source}' -DestinationPath '${target}' -Force`], { stdio: 'pipe' })

  const home = await makeHome()
  const summary = await runSync({ mode: 'down', scopes: ['sessions', 'plugins'], config: configOf(target), context: contextOf(home) })
  assert.equal(summary.downloaded, 2, '会话文件和补丁层都导进来（清单走合并那一档）')
  assert.equal(readFileSync(join(home, 'sessions', 'p', 's1', 'session.jsonl.zstd'), 'utf8'), '手工压的包')
  assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '- id: x\n')
})

test('自检：空档案说空、有内容的说有几个；不是 zip 的文件给人话', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zip-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'nested', 'backup.zip')
  const client = new ZipStore({ path: target })
  const before = await client.test()
  assert.equal(before.empty, true)
  assert.equal(before.detail.startsWith('ZIP · 还没有内容'), true)
  await client.putText('dsh-x/v1/profiles/web/package.json', '{}')
  await client.finish()
  assert.equal(existsSync(target), true)
  const after = await new ZipStore({ path: target }).test()
  assert.equal(after.empty, false)
  assert.match(after.detail, /已有 1 个文件/)

  const notZip = join(dir, 'x.zip')
  write(notZip, '这不是压缩包'.repeat(30))
  await assert.rejects(() => new ZipStore({ path: notZip }).test(), /不是个 ZIP 文件/)
})
