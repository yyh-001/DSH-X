/**
 * 本地目录这一侧（手动导出 / 导入）：纯函数 + 拿真实临时目录跑整条链路。
 * 这条路不联网，所以不用假服务器——目标目录就是真的目录。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  LocalDir,
  folderConfigured,
  folderDisplayUrl,
  folderMissing,
  runSync,
  safeFolderConfig,
  safeStoreType,
  storeClient,
  storeConfigured,
  storeDisplayUrl,
  storeLabel,
  storeMissing,
} from '../sync.js'

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

async function makeHome(files = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-folder-home-'))
  for (const [rel, text] of Object.entries(files)) write(join(home, ...rel.split('/')), text)
  return home
}

const contextOf = (home, profile = 'web') => ({ home, profile, profileDir: join(home, 'profiles', profile), roots: [] })
const configOf = (target) => ({ store: 'folder', folder: { path: target } })

test('本地目录配置：只认绝对路径，别的都算没填', () => {
  assert.deepEqual(safeFolderConfig({ path: ' D:\\dsh-backup ' }), { path: 'D:\\dsh-backup' })
  assert.deepEqual(safeFolderConfig({}), { path: '' })
  assert.throws(() => safeFolderConfig({ path: 'backup' }), /绝对路径/)
  assert.equal(folderConfigured({ path: 'D:\\x' }), true)
  assert.deepEqual(folderMissing({}), ['导出目录'])
  assert.equal(folderDisplayUrl({ path: 'D:\\dsh-backup' }), 'D:\\dsh-backup')
  assert.equal(safeStoreType('folder'), 'folder')
  assert.equal(storeLabel({ store: 'folder' }), '本地目录')
  assert.equal(storeConfigured({ store: 'folder', folder: { path: 'D:\\x' } }), true)
  assert.deepEqual(storeMissing({ store: 'folder', folder: {} }), ['导出目录'])
  assert.equal(storeDisplayUrl({ store: 'folder', folder: { path: 'D:\\x' } }), 'D:\\x')
  assert.ok(storeClient({ store: 'folder', folder: { path: 'D:\\x' } }) instanceof LocalDir)
})

test('导出 → 增量 → 从目录导入：内容、时间戳、清单合并都对得上', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'dsh-export-'))
  t.after(() => { /* 临时目录交给系统回收 */ })
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
  const exported = join(target, 'dsh-x', 'v1', 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd')
  assert.equal(readFileSync(exported, 'utf8'), 'session-one')
  assert.equal(readFileSync(join(target, 'dsh-x', 'v1', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '- id: dsh-meme\n  disabled: true\n')
  // 导出就是把文件拷过去：时间戳跟着源文件，下一轮比对才不会以为「本机更新了」
  assert.ok(Math.abs(statSync(exported).mtimeMs - statSync(join(home, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd')).mtimeMs) < 1500)

  // 再导出一次：没变化就别动
  const second = await runSync({ mode: 'up', scopes, config: configOf(target), context })
  assert.equal(second.uploaded, 0)
  assert.equal(second.merged, 0)

  // 本机改一个 → 只导出那一个
  write(join(home, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'session-one-changed')
  const third = await runSync({ mode: 'up', scopes, config: configOf(target), context })
  assert.equal(third.uploaded, 1)
  assert.equal(readFileSync(exported, 'utf8'), 'session-one-changed')

  // 换一台机器从目录导入
  const other = await makeHome({ 'profiles/web/package.json': JSON.stringify({ dependencies: { 'dsh-other': '2.0.0' }, dsh: { profile: { bundles: ['dsh-other'] } } }, null, 2) })
  const pull = await runSync({ mode: 'down', scopes, config: configOf(target), context: contextOf(other) })
  assert.equal(pull.downloaded, 3)
  assert.equal(pull.merged, 1)
  assert.equal(readFileSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'utf8'), 'session-one-changed')
  assert.equal(readFileSync(join(other, 'attachments', 'v1', 'pic.png'), 'utf8'), 'png-bytes')
  const manifest = JSON.parse(readFileSync(join(other, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-meme', 'dsh-other'])
  // 导进来的文件时间戳跟导出目录里的一致 → 反过来再导出不该重复写
  assert.ok(Math.abs(statSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd')).mtimeMs - statSync(exported).mtimeMs) < 1500)
  const roundTrip = await runSync({ mode: 'up', scopes, config: configOf(target), context: contextOf(other) })
  assert.equal(roundTrip.uploaded, 0)

  // 导出目录里我们自己写的临时文件/冲突副本不会被当成内容
  write(join(target, 'dsh-x', 'v1', 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd.remote-20260926-0930'), 'x')
  const listed = await new LocalDir({ path: target }).list('dsh-x/v1/sessions')
  assert.ok(![...listed.keys()].some((key) => key.includes('.remote-')))
})

test('导出目录不能放在会被同步的目录里（会自己套自己）', async (t) => {
  const home = await makeHome({ 'sessions/proj/s1/session.jsonl.zstd': 'x' })
  await assert.rejects(
    () => runSync({ mode: 'up', scopes: ['sessions'], config: configOf(join(home, 'backup')), context: contextOf(home) }),
    /不能放在会被同步的目录里/,
  )
  // 放在 home 外面就行
  const outside = await mkdtemp(join(tmpdir(), 'dsh-export-ok-'))
  const summary = await runSync({ mode: 'up', scopes: ['sessions'], config: configOf(outside), context: contextOf(home) })
  assert.equal(summary.uploaded, 1)
})

test('自检：目录能建能写，空目录说空', async (t) => {
  const target = join(await mkdtemp(join(tmpdir(), 'dsh-export-test-')), 'nested', 'backup')
  const client = new LocalDir({ path: target })
  const info = await client.test()
  assert.equal(info.empty, true)
  assert.equal(info.detail, '本地目录')
  assert.equal(info.host, target)
  assert.equal(existsSync(target), true, '自检会把目录建出来')
  assert.equal(existsSync(join(target, '.dsh-sync-probe')), false, '探针文件不留下来')
  await client.putText('dsh-x/v1/profiles/web/package.json', '{}')
  assert.equal((await new LocalDir({ path: target }).test()).empty, false)
})
