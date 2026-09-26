/**
 * 端到端：拿一只假 S3 把整条同步链路跑通——上传、增量、下载、清单合并、冲突策略、停止。
 * 假桶会复算签名，所以「签的和发出去的不是同一个请求」这类错也会在这里露出来。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { runSync } from '../sync.js'
import { startFakeS3 } from './fake-s3.mjs'

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** 造一个「一台机器」的 dsh 用户目录。 */
async function makeHome(files = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-home-'))
  for (const [rel, text] of Object.entries(files)) write(join(home, ...rel.split('/')), text)
  return home
}

const contextOf = (home, profile = 'web') => ({ home, profile, profileDir: join(home, 'profiles', profile), roots: [] })

const configOf = (bucket) => ({
  endpoint: bucket.url,
  region: 'us-east-1',
  bucket: bucket.bucket,
  prefix: '',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-test-key',
  style: 'path',
})

test('上传→增量→换机器下载：内容、时间戳与插件清单都对得上', async (t) => {
  const bucket = await startFakeS3({ pageSize: 2 })   // 逼着走翻页
  t.after(() => bucket.close())
  const home = await makeHome({
    'sessions/proj-a/session-1/session.jsonl.zstd': 'session-one',
    'sessions/proj-a/session-2/session.jsonl.zstd': 'session-two',
    'sessions/proj-b/session-3/session.jsonl.zstd': 'session-three',
    'attachments/v1/pic.png': 'png-bytes',
    'profiles/web/package.json': JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-meme': '1.0.0' }, dsh: { profile: { bundles: ['dsh-meme'] } } }, null, 2),
    'profiles/web/cordis.patch.yml': '- id: dsh-meme\n  disabled: true\n',
    'profiles/web/.npmrc': 'node-linker=hoisted\n',
  })
  const context = contextOf(home)
  const scopes = ['sessions', 'attachments', 'plugins']

  const first = await runSync({ mode: 'up', scopes, config: configOf(bucket), context })
  assert.equal(first.uploaded, 5, '三个会话 + 一个附件 + 补丁层（清单算「合并」那一档）')
  assert.equal(first.merged, 1, '插件清单走的是合并，单独计数')
  assert.equal(first.downloaded, 0)
  assert.deepEqual([...bucket.store.keys()].sort(), [
    'dsh-x/v1/attachments/v1/pic.png',
    'dsh-x/v1/profiles/web/cordis.patch.yml',
    'dsh-x/v1/profiles/web/package.json',
    'dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd',
    'dsh-x/v1/sessions/proj-a/session-2/session.jsonl.zstd',
    'dsh-x/v1/sessions/proj-b/session-3/session.jsonl.zstd',
  ])
  assert.equal(bucket.store.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd').body.toString(), 'session-one')
  // 名单里的 .npmrc 有意不同步（机器相关）
  assert.ok(![...bucket.store.keys()].some((key) => key.includes('.npmrc')))
  assert.ok(bucket.requests.every((item) => !item.badSignature), '每个请求的签名都要和自己对得上')

  // 再传一次：没有变化就不该动任何东西（时间对齐 + 大小相同）
  const second = await runSync({ mode: 'up', scopes, config: configOf(bucket), context })
  assert.equal(second.uploaded, 0, '第二次上传不该重复传')
  const puts = () => bucket.requests.filter((item) => item.method === 'PUT').length
  const afterFirst = puts()
  await runSync({ mode: 'up', scopes, config: configOf(bucket), context })
  assert.equal(puts(), afterFirst, '第三次也不该有任何 PUT')

  // 本机改一个（大小变了）+ 一个只改了时间（大小没变）
  write(join(home, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'session-one-changed')
  const stamp = Date.now() / 1000 + 3600
  utimesSync(join(home, 'sessions', 'proj-b', 'session-3', 'session.jsonl.zstd'), stamp, stamp)
  const third = await runSync({ mode: 'up', scopes, config: configOf(bucket), context })
  assert.equal(third.uploaded, 2, '内容变的和本机更新的各传一个')
  assert.equal(bucket.store.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd').body.toString(), 'session-one-changed')

  // 换一台机器：空 home 从桶里拉回来
  const other = await makeHome({ 'profiles/web/package.json': JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-other': '2.0.0' }, dsh: { profile: { bundles: ['dsh-other'] } } }, null, 2) })
  const otherContext = contextOf(other)
  const pull = await runSync({ mode: 'down', scopes, config: configOf(bucket), context: otherContext })
  assert.equal(pull.downloaded, 5, '四个会话/附件文件 + 补丁层（清单走合并）')
  assert.equal(pull.merged, 1, '插件清单合并算一处变化')
  assert.equal(readFileSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'utf8'), 'session-one-changed')
  assert.equal(readFileSync(join(other, 'attachments', 'v1', 'pic.png'), 'utf8'), 'png-bytes')
  assert.equal(readFileSync(join(other, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '- id: dsh-meme\n  disabled: true\n')
  // 清单合并：两边的插件都在
  const manifest = JSON.parse(readFileSync(join(other, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-meme', 'dsh-other'])
  assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-other', 'dsh-meme'])
  // 拉下来的文件时间戳对齐成桶里的，下一次上传就不该再传一遍
  const remoteAt = bucket.store.get('dsh-x/v1/sessions/proj-b/session-3/session.jsonl.zstd').at
  const localAt = statSync(join(other, 'sessions', 'proj-b', 'session-3', 'session.jsonl.zstd')).mtimeMs
  assert.ok(Math.abs(localAt - remoteAt) < 2000, `下载后 mtime 跟着桶走（本机 ${localAt} vs 桶 ${remoteAt}）`)
  const roundTrip = await runSync({ mode: 'up', scopes, config: configOf(bucket), context: otherContext })
  assert.equal(roundTrip.uploaded, 0, '刚拉下来的文件不该被当成「本机更新」再传一遍')
  // 合并后的清单也要进桶（这台机器的 dsh-other 不能丢）
  assert.deepEqual(Object.keys(JSON.parse(bucket.store.get('dsh-x/v1/profiles/web/package.json').body.toString()).dependencies), ['dsh-meme', 'dsh-other'])
})

test('冲突策略三选一，默认保留本机', async (t) => {
  const bucket = await startFakeS3()
  t.after(() => bucket.close())
  const home = await makeHome({ 'sessions/proj/s1/session.jsonl.zstd': 'local-version' })
  const context = contextOf(home)
  const scopes = ['sessions']
  // 桶里放一份不一样长的同名文件
  bucket.store.set('dsh-x/v1/sessions/proj/s1/session.jsonl.zstd', {
    body: Buffer.from('remote-version-longer'), at: Date.now() - 60_000, etag: 'x',
  })
  const conflict = await runSync({ mode: 'down', scopes, config: configOf(bucket), context, policy: 'skip' })
  assert.deepEqual(conflict.conflicts, ['sessions/proj/s1/session.jsonl.zstd'])
  assert.equal(conflict.downloaded, 0)
  assert.equal(readFileSync(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8'), 'local-version')

  const overwrite = await runSync({ mode: 'down', scopes, config: configOf(bucket), context, policy: 'overwrite' })
  assert.equal(overwrite.downloaded, 1)
  assert.equal(readFileSync(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8'), 'remote-version-longer')

  // 两份都留：本机不动，另存一个 …remote-日期 的副本
  write(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'local-again')
  const both = await runSync({ mode: 'down', scopes, config: configOf(bucket), context, policy: 'duplicate' })
  assert.equal(both.downloaded, 1)
  assert.equal(readFileSync(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'utf8'), 'local-again')
  const copy = readFileSync(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd.remote-' + new Date().getFullYear() + String(new Date().getMonth() + 1).padStart(2, '0') + String(new Date().getDate()).padStart(2, '0') + '-' + String(new Date().getHours()).padStart(2, '0') + String(new Date().getMinutes()).padStart(2, '0')), 'utf8')
  assert.equal(copy, 'remote-version-longer')
})

test('停止：点一下就做完手上那个文件收手，剩下的不再动', async (t) => {
  const bucket = await startFakeS3()
  t.after(() => bucket.close())
  const home = await makeHome({
    'sessions/proj/s1/session.jsonl.zstd': 'a',
    'sessions/proj/s2/session.jsonl.zstd': 'b',
    'sessions/proj/s3/session.jsonl.zstd': 'c',
  })
  let uploads = 0
  const summary = await runSync({
    mode: 'up',
    scopes: ['sessions'],
    config: configOf(bucket),
    context: contextOf(home),
    shouldStop: () => uploads > 0,
    onProgress: (state) => { if (state.phase === 'upload') uploads += 1 },
  })
  assert.equal(summary.stopped, true)
  assert.equal(summary.uploaded, 1, '第一个文件传完就停了')
  assert.equal(bucket.store.size, 1)
})

test('配置错了说人话：密钥不对、桶不对、端点不通', async (t) => {
  const bucket = await startFakeS3()
  t.after(() => bucket.close())
  const home = await makeHome({ 'sessions/proj/s1/session.jsonl.zstd': 'a' })
  const context = contextOf(home)
  const scopes = ['sessions']
  await assert.rejects(
    () => runSync({ mode: 'up', scopes, config: { ...configOf(bucket), secretAccessKey: 'wrong-secret' }, context }),
    /SecretKey 填错了/,
  )
  await assert.rejects(
    () => runSync({ mode: 'up', scopes, config: { ...configOf(bucket), bucket: 'nope' }, context }),
    /桶不存在/,
  )
  await assert.rejects(
    () => runSync({ mode: 'up', scopes, config: { ...configOf(bucket), endpoint: 'http://127.0.0.1:1' }, context }),
    /连不上|超时/,
  )
  await assert.rejects(
    () => runSync({ mode: 'up', scopes, config: { endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' }, context }),
    /还没填/,
  )
  assert.equal(existsSync(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd')), true, '失败不该动本机文件')
})

test('技能与记忆：两个技能根各走各的前缀', async (t) => {
  const bucket = await startFakeS3()
  t.after(() => bucket.close())
  const home = await makeHome({ 'memory/notes.md': 'remember this' })
  const dshSkills = join(home, 'skills')
  const agentsSkills = join(home, 'agents-skills')
  write(join(dshSkills, 'demo', 'SKILL.md'), 'dsh skill')
  write(join(agentsSkills, 'other', 'SKILL.md'), 'agents skill')
  const summary = await runSync({
    mode: 'up',
    scopes: ['skills', 'memory'],
    config: configOf(bucket),
    context: { home, profile: 'web', profileDir: join(home, 'profiles', 'web'), roots: [{ key: 'dsh', dir: dshSkills }, { key: 'agents', dir: agentsSkills }] },
  })
  assert.equal(summary.uploaded, 3)
  assert.deepEqual([...bucket.store.keys()].sort(), [
    'dsh-x/v1/memory/notes.md',
    'dsh-x/v1/skills/agents/other/SKILL.md',
    'dsh-x/v1/skills/dsh/demo/SKILL.md',
  ])
})
