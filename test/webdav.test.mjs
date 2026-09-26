/**
 * WebDAV 这一侧：纯函数的解析/配置单测 + 拿假 WebDAV 跑整条链路。
 * 假服务器故意混用命名空间前缀、href 带百分号编码、PUT 到不存在的父目录返回 409，
 * 就是为了让这里的用例盯住这些坑。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  Webdav,
  parsePropfindXml,
  runSync,
  safeStoreType,
  safeWebdavConfig,
  storeClient,
  storeConfigured,
  storeDisplayUrl,
  storeLabel,
  storeMissing,
  webdavConfigured,
  webdavDisplayUrl,
  webdavMissing,
  webdavErrorMessage,
} from '../sync.js'
import { startFakeWebdav } from './fake-webdav.mjs'

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

async function makeHome(files = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-dav-home-'))
  for (const [rel, text] of Object.entries(files)) write(join(home, ...rel.split('/')), text)
  return home
}

const contextOf = (home, profile = 'web') => ({ home, profile, profileDir: join(home, 'profiles', profile), roots: [] })
const configOf = (dav) => ({
  store: 'webdav',
  webdav: { url: dav.url, username: 'davuser', password: 'dav-pass', prefix: '' },
})

test('PROPFIND 解析：命名空间前缀混用、href 编码、集合与文件都认', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/notes/</D:href>
    <D:propstat><d:prop xmlns:d="DAV:"><d:resourcetype><d:collection/></d:resourcetype></d:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/notes/%E4%BC%9A%E8%AF%9D/a%20b.jsonl.zstd</D:href>
    <D:propstat>
      <d:prop xmlns:d="DAV:">
        <resourcetype/>
        <d:getcontentlength>412</d:getcontentlength>
        <d:getlastmodified>Mon, 01 Sep 2025 10:00:00 GMT</d:getlastmodified>
      </d:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/notes/sessions/</D:href>
    <D:propstat><d:prop xmlns:d="DAV:"><d:resourcetype><d:collection/></d:resourcetype></d:prop></D:propstat>
  </D:response>
</D:multistatus>`
  const entries = parsePropfindXml(xml, '/dav/notes/')
  assert.deepEqual(entries.map((entry) => [entry.path, entry.isCollection]), [
    ['', true],
    ['会话/a b.jsonl.zstd', false],
    ['sessions', true],
  ])
  assert.equal(entries[1].size, 412)
  assert.equal(entries[1].lastModifiedMs, Date.parse('2025-09-01T10:00:00Z'))
  // 空响应、坏 XML 都不该炸
  assert.deepEqual(parsePropfindXml('', '/dav/'), [])
  assert.deepEqual(parsePropfindXml('<not-xml', '/dav/'), [])
})

test('配置：地址/用户名/密码的校验与回显，脏值不认', () => {
  assert.deepEqual(safeWebdavConfig({ url: ' https://dav.example.com/dav/xx ', username: ' a ', password: ' p ' }), {
    url: 'https://dav.example.com/dav/xx',
    username: 'a',
    password: 'p',
    prefix: '',
    insecure: false,
  })
  assert.equal(safeWebdavConfig({ prefix: '/a/b/' }).prefix, 'a/b')
  assert.throws(() => safeWebdavConfig({ url: 'dav.example.com/dav' }), /要像 https/)
  assert.throws(() => safeWebdavConfig({ prefix: '../x' }), /前缀/)
  assert.equal(webdavConfigured({ url: 'https://x', username: 'a', password: 'b' }), true)
  assert.equal(webdavConfigured({ url: 'https://x', username: 'a' }), false)
  assert.deepEqual(webdavMissing({}), ['WebDAV 地址', '用户名', '密码'])
  assert.equal(webdavDisplayUrl({ url: 'https://x/dav/me/', prefix: 'laptop' }), 'https://x/dav/me/laptop/dsh-x/v1')
})

test('存储类型：默认 S3，脏值回 S3，两种后端各拿各的配置', () => {
  assert.equal(safeStoreType(undefined), 's3')
  assert.equal(safeStoreType('webdav'), 'webdav')
  assert.equal(safeStoreType('ftp'), 's3')
  assert.equal(storeLabel({ store: 'webdav' }), 'WebDAV')
  assert.equal(storeLabel({}), 'S3 兼容存储')
  const dav = { url: 'https://dav.example.com/dav/x', username: 'u', password: 'p' }
  assert.ok(storeClient({ store: 'webdav', webdav: dav }) instanceof Webdav)
  assert.equal(storeConfigured({ store: 'webdav', webdav: dav }), true)
  assert.deepEqual(storeMissing({ store: 'webdav', webdav: { url: dav.url } }), ['用户名', '密码'])
  assert.equal(storeDisplayUrl({ store: 'webdav', webdav: dav }), 'https://dav.example.com/dav/x/dsh-x/v1')
})

test('状态码翻人话', () => {
  assert.match(webdavErrorMessage(401), /用户名或密码不对/)
  assert.match(webdavErrorMessage(404), /远端没有这个路径/)
  assert.match(webdavErrorMessage(507), /空间不足/)
  assert.match(webdavErrorMessage(418, '<d:error xmlns:d="DAV:"><d:message>我是茶壶</d:message></d:error>'), /我是茶壶/)
})

test('整条链路：上传自动建目录 → 增量 → 换机器下载 → 清单合并', async (t) => {
  const dav = await startFakeWebdav()
  t.after(() => dav.close())
  const home = await makeHome({
    'sessions/proj-a/session-1/session.jsonl.zstd': 'session-one',
    'attachments/v1/pic.png': 'png-bytes',
    'profiles/web/package.json': JSON.stringify({ name: 'dsh-profile-web', dependencies: { 'dsh-meme': '1.0.0' }, dsh: { profile: { bundles: ['dsh-meme'] } } }, null, 2),
    'profiles/web/cordis.patch.yml': '- id: dsh-meme\n  disabled: true\n',
  })
  const context = contextOf(home)
  const scopes = ['sessions', 'attachments', 'plugins']
  const first = await runSync({ mode: 'up', scopes, config: configOf(dav), context })
  assert.equal(first.uploaded, 3, '会话 + 附件 + 补丁层（清单算合并那一档）')
  assert.equal(first.merged, 1)
  // 目录是一级级 MKCOL 建出来的（PUT 之前必须先有父集合）
  assert.deepEqual(dav.mkcols, [
    'dsh-x', 'dsh-x/v1',
    'dsh-x/v1/sessions', 'dsh-x/v1/sessions/proj-a', 'dsh-x/v1/sessions/proj-a/session-1',
    'dsh-x/v1/attachments', 'dsh-x/v1/attachments/v1',
    'dsh-x/v1/profiles', 'dsh-x/v1/profiles/web',
  ])
  assert.equal(dav.files.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd').body.toString(), 'session-one')
  assert.ok(![...dav.files.keys()].some((key) => key.includes('.npmrc')), '.npmrc 是有意不同步的')

  // 再传一次：没变化就别动
  const second = await runSync({ mode: 'up', scopes, config: configOf(dav), context })
  assert.equal(second.uploaded, 0)
  assert.equal(second.merged, 0)

  // 本机改一个（大小变了）
  write(join(home, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'session-one-changed')
  const third = await runSync({ mode: 'up', scopes, config: configOf(dav), context })
  assert.equal(third.uploaded, 1)
  assert.equal(dav.files.get('dsh-x/v1/sessions/proj-a/session-1/session.jsonl.zstd').body.toString(), 'session-one-changed')

  // 换一台机器拉回来
  const other = await makeHome({ 'profiles/web/package.json': JSON.stringify({ dependencies: { 'dsh-other': '2.0.0' }, dsh: { profile: { bundles: ['dsh-other'] } } }, null, 2) })
  const pull = await runSync({ mode: 'down', scopes, config: configOf(dav), context: contextOf(other) })
  assert.equal(pull.downloaded, 3)
  assert.equal(readFileSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd'), 'utf8'), 'session-one-changed')
  assert.equal(readFileSync(join(other, 'attachments', 'v1', 'pic.png'), 'utf8'), 'png-bytes')
  const manifest = JSON.parse(readFileSync(join(other, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-meme', 'dsh-other'])
  // 拉下来的文件 mtime 对齐成远端的时间 → 再上传不该重复传
  const remoteAt = [...dav.files.values()].find((file) => file.body.toString() === 'session-one-changed').at
  assert.ok(Math.abs(statSync(join(other, 'sessions', 'proj-a', 'session-1', 'session.jsonl.zstd')).mtimeMs - remoteAt) < 2000)
  const roundTrip = await runSync({ mode: 'up', scopes, config: configOf(dav), context: contextOf(other) })
  assert.equal(roundTrip.uploaded, 0)
})

test('一次 503 会重试（同步常跑在不稳的网络上）', async (t) => {
  const dav = await startFakeWebdav({ failFirstWrites: 1 })
  t.after(() => dav.close())
  const home = await makeHome({ 'sessions/proj/s1/session.jsonl.zstd': 'retry-me' })
  const summary = await runSync({ mode: 'up', scopes: ['sessions'], config: configOf(dav), context: contextOf(home) })
  assert.equal(summary.uploaded, 1)
  assert.equal(dav.files.get('dsh-x/v1/sessions/proj/s1/session.jsonl.zstd').body.toString(), 'retry-me')
})

test('认证错了说人话，且不动本机文件', async (t) => {
  const dav = await startFakeWebdav()
  t.after(() => dav.close())
  const home = await makeHome({ 'sessions/proj/s1/session.jsonl.zstd': 'x' })
  await assert.rejects(
    () => runSync({
      mode: 'up',
      scopes: ['sessions'],
      config: { store: 'webdav', webdav: { ...configOf(dav).webdav, password: 'wrong' } },
      context: contextOf(home),
    }),
    /用户名或密码不对/,
  )
  await assert.rejects(
    () => runSync({
      mode: 'up',
      scopes: ['sessions'],
      config: { store: 'webdav', webdav: { url: 'http://127.0.0.1:1/dav', username: 'u', password: 'p' } },
      context: contextOf(home),
    }),
    /连不上|超时/,
  )
  await assert.rejects(
    () => runSync({ mode: 'up', scopes: ['sessions'], config: { store: 'webdav', webdav: {} }, context: contextOf(home) }),
    /还没填完/,
  )
})

test('连接自检：空目录说空，有内容说有内容', async (t) => {
  const dav = await startFakeWebdav()
  t.after(() => dav.close())
  const client = new Webdav(configOf(dav).webdav)
  const before = await client.test()
  assert.equal(before.empty, true)
  assert.equal(before.namespace, 'dsh-x/v1')
  await client.putText('dsh-x/v1/profiles/web/package.json', '{}')
  const after = await new Webdav(configOf(dav).webdav).test()
  assert.equal(after.empty, false)
})
