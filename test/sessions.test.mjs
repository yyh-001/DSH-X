import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  analyzeHomeData,
  clearSessionScanCache,
  decodeSessionSegment,
  deleteSessions,
  encodeSessionSegment,
  indexAllSessions,
  mutateSessionsState,
  previewDeleteSessions,
  readProjectionCache,
  readSessionHeaderFast,
  removeWorkspace,
  scanHomeSessions,
} from '../src/sessions.js'
import { safeRemoteDshHomes } from '../src/settings.js'

function makeTempHome(prefix = 'dsh-sessions-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, 'storages'), { recursive: true })
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return dir
}

/** 写一个真实的多帧 zstd v4 会话日志：第 1 帧为 header，第 2 帧为事件。 */
function writeMultiFrameSession(home, projectKey, sessionId, header, events = []) {
  const dir = join(home, 'sessions', projectKey, encodeSessionSegment(sessionId))
  mkdirSync(dir, { recursive: true })
  const frame0 = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sessionId, ...header })}\n`, 'utf8'))
  const frames = [frame0]
  if (events.length > 0) {
    const body = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n'
    frames.push(zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(frames))
  return { dir, file }
}

function writeProjCacheV7(home, sessionId, record) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${encodeSessionSegment(sessionId)}.json`), JSON.stringify({ version: 7, record }, null, 2))
}

function writeWorkspaceJson(home, { workspaceIds = [], archivedSessionIds = [], pinnedSessionIds = [], workspaces = {} } = {}) {
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds,
      archivedSessionIds,
      pinnedSessionIds,
    },
    tables: { workspaces },
  }, null, 2))
}

test('encodeSessionSegment 与 decodeSessionSegment 支持特殊字符与路径穿越防御', () => {
  for (const sample of ['session-abc', '.', '..', 'a/b\\c~中文', 'botharness-123']) {
    const encoded = encodeSessionSegment(sample)
    assert.ok(!encoded.includes('/') && !encoded.includes('\\'))
    assert.notEqual(encoded, '.')
    assert.notEqual(encoded, '..')
    assert.equal(decodeSessionSegment(encoded), sample)
  }
})

test('readSessionHeaderFast 只解压多帧 zstd 首帧即可提取完整 header，并兼容明文与坏文件', async () => {
  clearSessionScanCache()
  const home = makeTempHome()
  try {
    const { file } = writeMultiFrameSession(home, '--proj--', 'session-child-1', {
      createdAt: 1790000000000,
      cwd: 'C:\\work\\alpha',
      parentSession: 'session-parent-1',
      origin: 'subagent',
      delegationDepth: 1,
    }, [
      { seq: 1, type: 'user/message', content: 'x'.repeat(20000) },
    ])

    const header = await readSessionHeaderFast(file, true)
    assert.equal(header.id, 'session-child-1')
    assert.equal(header.cwd, 'C:\\work\\alpha')
    assert.equal(header.parentSession, 'session-parent-1')
    assert.equal(header.origin, 'subagent')
    assert.equal(header.delegationDepth, 1)

    // 明文 jsonl 回退
    const plain = join(home, 'sessions', '--proj--', 'plain.jsonl')
    writeFileSync(plain, `${JSON.stringify({ type: 'session', version: 2, id: 'plain-1', createdAt: 1700000000000, cwd: '/tmp/p' })}\n{"seq":1}\n`)
    const plainHeader = await readSessionHeaderFast(plain, false)
    assert.equal(plainHeader.id, 'plain-1')
    assert.equal(plainHeader.cwd, '/tmp/p')

    // 损坏文件静默返回 null 不抛错
    const broken = join(home, 'sessions', '--proj--', 'broken.zstd')
    writeFileSync(broken, Buffer.from('not-a-zstd-frame'))
    assert.equal(await readSessionHeaderFast(broken, true), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readProjectionCache 优先读 v7 单文件目录、兼容回退 v3 单文件，并跳过临时与损坏文件', async () => {
  const home = makeTempHome()
  try {
    writeProjCacheV7(home, 's-1', {
      identity: { createdAt: 1790000001000, cwd: '/proj/a' },
      rows: {
        title: { ver: 1, seq: 10, val: '来自 v7 的新标题' },
        titleInput: { ver: 3, seq: 10, val: { first: { seq: 1, text: '首条提问' } } },
        sessionListMetadata: { ver: 1, seq: 10, val: { blank: false, lastPromptAt: 1790000005000 } },
        sessionStats: { ver: 1, seq: 10, val: { turns: 4, steps: 9 } },
        tokenUsage: { ver: 2, seq: 10, val: { totals: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } } },
      },
    })
    // 临时文件和坏 JSON 必须被忽略
    writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 's-tmp.json.tmp'), '{"broken')
    writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 's-bad.json'), '{bad json')

    // 旧版 v3 单文件：包含 s-1（应被 v7 覆盖）和 s-legacy（应被补齐）
    writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          's-1': { identity: { createdAt: 1780000000000 }, rows: { title: { ver: 1, seq: 1, val: '旧 v3 标题' } } },
          's-legacy': { identity: { createdAt: 1780000002000, cwd: '/proj/old' }, rows: { sessionListMetadata: { ver: 1, seq: 2, val: { blank: true, lastPromptAt: null } } } },
        },
      },
    }))

    const cache = await readProjectionCache(home)
    assert.equal(cache.get('s-1')?.explicitTitle, '来自 v7 的新标题')
    assert.equal(cache.get('s-1')?.firstPrompt, '首条提问')
    assert.equal(cache.get('s-1')?.turns, 4)
    assert.equal(cache.get('s-1')?.totalTokens, 350)
    assert.equal(cache.get('s-legacy')?.blank, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('indexAllSessions 跨多 home 归并会话、孤儿、子会话及疑似闲置工作区', async () => {
  clearSessionScanCache()
  const homeA = makeTempHome('dsh-home-a-')
  const homeB = makeTempHome('dsh-home-b-')
  const realWsDir = mkdtempSync(join(tmpdir(), 'dsh-ws-real-'))
  const now = 1800000000000
  const oldTs = now - 100 * 24 * 60 * 60 * 1000
  try {
    writeWorkspaceJson(homeA, {
      workspaceIds: ['ws-1', 'ws-stale'],
      archivedSessionIds: ['s-arch'],
      pinnedSessionIds: ['s-pin', 's-arch'], // 已归档的不能算置顶
      workspaces: {
        'ws-1': {
          path: realWsDir,
          title: 'ActiveProj',
          sessionIds: ['s-pin', 's-blank', 's-arch'],
          createdAt: new Date(now - 3600_000).toISOString(),
          updatedAt: new Date(now - 1000).toISOString(),
        },
        'ws-stale': {
          path: join(homeA, 'does-not-exist-dir'),
          title: 'GoneProj',
          sessionIds: [],
          createdAt: new Date(oldTs).toISOString(),
          updatedAt: new Date(oldTs).toISOString(),
        },
      },
    })

    writeMultiFrameSession(homeA, '--active--', 's-pin', { createdAt: now - 5000, cwd: realWsDir }, [{ seq: 1, type: 'user/message' }])
    writeMultiFrameSession(homeA, '--active--', 's-blank', { createdAt: now - 4000, cwd: realWsDir })
    writeMultiFrameSession(homeA, '--active--', 's-arch', { createdAt: now - 3000, cwd: realWsDir })
    writeMultiFrameSession(homeA, '--active--', 's-sub', { createdAt: now - 2000, cwd: realWsDir, parentSession: 's-pin', origin: 'subagent', delegationDepth: 1 })
    writeMultiFrameSession(homeA, '--orphan--', 's-orphan', { createdAt: now - 1000, cwd: realWsDir }, [{ seq: 1, type: 'user/message', content: 'orphan-body-'.repeat(80) }])
    writeProjCacheV7(homeA, 's-pin', {
      identity: { createdAt: now - 5000, cwd: realWsDir },
      rows: {
        title: { ver: 1, seq: 2, val: '核心任务' },
        sessionListMetadata: { ver: 1, seq: 2, val: { blank: false, lastPromptAt: now - 1000 } },
      },
    })
    writeProjCacheV7(homeA, 's-blank', {
      identity: { createdAt: now - 4000, cwd: realWsDir },
      rows: {
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: true, lastPromptAt: null } },
      },
    })

    writeMultiFrameSession(homeB, '--b--', 's-b1', { createdAt: now - 2000, cwd: realWsDir }, [{ seq: 1, type: 'user/message', content: 'home-b-body-'.repeat(80) }])

    const indexed = await indexAllSessions([
      { home: homeA, label: '主目录', running: true },
      { home: homeB, label: '工作目录', running: false },
    ], { now })

    assert.equal(indexed.homes.length, 2)
    assert.equal(indexed.summary.total, 6)
    assert.equal(indexed.summary.pinned, 1)
    assert.equal(indexed.summary.archived, 1)
    assert.equal(indexed.summary.blank, 1)
    assert.equal(indexed.summary.subagent, 1)

    const sPin = indexed.sessions.find((s) => s.sessionId === 's-pin')
    assert.equal(sPin.pinned, true)
    assert.equal(sPin.homeRunning, true)
    assert.deepEqual(sPin.childIds, ['s-sub'])

    const sArch = indexed.sessions.find((s) => s.sessionId === 's-arch')
    assert.equal(sArch.archived, true)
    assert.equal(sArch.pinned, false)

    const sOrphan = indexed.sessions.find((s) => s.sessionId === 's-orphan')
    assert.equal(sOrphan.orphan, true)

    const wsStale = indexed.workspaces.find((w) => w.id === 'ws-stale')
    assert.equal(wsStale.stale, true)
    assert.ok(wsStale.staleReasons.includes('missing_dir'))
    assert.ok(wsStale.staleReasons.includes('empty'))
    assert.ok(wsStale.staleReasons.includes('inactive_90d'))
  } finally {
    rmSync(homeA, { recursive: true, force: true })
    rmSync(homeB, { recursive: true, force: true })
    rmSync(realWsDir, { recursive: true, force: true })
  }
})

test('mutateSessionsState 遵守运行中拦截、置顶归档互斥，并保留原工作区槽位与备份', async () => {
  const home = makeTempHome()
  try {
    writeWorkspaceJson(home, {
      workspaceIds: ['ws-1'],
      archivedSessionIds: [],
      pinnedSessionIds: ['s-1'],
      workspaces: {
        'ws-1': { path: '/p', title: 'P', sessionIds: ['s-1', 's-2'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      },
    })

    // 1. 运行中实例必须拦截且不写盘
    const blocked = await mutateSessionsState({
      items: [{ home, sessionId: 's-1' }],
      action: 'archive',
      isHomeRunning: () => true,
    })
    assert.equal(blocked.failed.length, 1)
    assert.equal(blocked.failed[0].reason, 'running_home')
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).global.archivedSessionIds, [])

    // 2. 停机后归档 s-1：自动取消置顶，但保留 ws-1.sessionIds 槽位
    const archRes = await mutateSessionsState({
      items: [{ home, sessionId: 's-1' }],
      action: 'archive',
      isHomeRunning: () => false,
    })
    assert.equal(archRes.succeeded.length, 1)
    const afterArch = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(afterArch.global.archivedSessionIds, ['s-1'])
    assert.deepEqual(afterArch.global.pinnedSessionIds, [])
    assert.deepEqual(afterArch.tables.workspaces['ws-1'].sessionIds, ['s-1', 's-2'])
    assert.ok(readdirSync(join(home, 'storages')).some((f) => f.startsWith('workspace.json.bak-')))

    // 3. 已归档会话禁止置顶
    const pinFail = await mutateSessionsState({
      items: [{ home, sessionId: 's-1' }],
      action: 'pin',
      isHomeRunning: () => false,
    })
    assert.equal(pinFail.failed.length, 1)
    assert.equal(pinFail.failed[0].reason, 'archived_cannot_pin')

    // 4. 取消归档后再置顶
    const unarch = await mutateSessionsState({
      items: [{ home, sessionId: 's-1' }],
      action: 'unarchive',
      isHomeRunning: () => false,
    })
    assert.equal(unarch.succeeded.length, 1)
    const pinOk = await mutateSessionsState({
      items: [{ home, sessionId: 's-1' }],
      action: 'pin',
      isHomeRunning: () => false,
    })
    assert.equal(pinOk.succeeded.length, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).global.pinnedSessionIds, ['s-1'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('previewDeleteSessions 与 deleteSessions 精确识别子会话、拦截运行中实例、且绝不误删工作区/记忆/附件', async () => {
  clearSessionScanCache()
  const home = makeTempHome()
  const projectDir = mkdtempSync(join(tmpdir(), 'dsh-user-code-'))
  try {
    writeFileSync(join(projectDir, 'README.md'), 'do-not-delete')
    mkdirSync(join(home, 'memory'), { recursive: true })
    writeFileSync(join(home, 'memory', 'memory.db'), 'keep-memory')
    mkdirSync(join(home, 'attachments', 'v1', 'objects', 'ab'), { recursive: true })
    writeFileSync(join(home, 'attachments', 'v1', 'objects', 'ab', 'abcdef'), 'keep-attachment')

    writeWorkspaceJson(home, {
      workspaceIds: ['ws-1'],
      archivedSessionIds: ['s-parent'],
      pinnedSessionIds: [],
      workspaces: {
        'ws-1': { path: projectDir, title: 'UserCode', sessionIds: ['s-parent', 's-keep'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      },
    })
    const parent = writeMultiFrameSession(home, '--user-code--', 's-parent', { createdAt: 1790000001000, cwd: projectDir })
    const child = writeMultiFrameSession(home, '--user-code--', 's-child', { createdAt: 1790000002000, cwd: projectDir, parentSession: 's-parent', origin: 'subagent', delegationDepth: 1 })
    const keep = writeMultiFrameSession(home, '--user-code--', 's-keep', { createdAt: 1790000003000, cwd: projectDir })
    writeProjCacheV7(home, 's-parent', { identity: { createdAt: 1790000001000, cwd: projectDir }, rows: { title: { ver: 1, seq: 1, val: '父会话' } } })

    // 预检：实例运行中时应标为 blocked(running_home)，同时仍报告子会话
    const previewRunning = await previewDeleteSessions({
      items: [{ home, sessionId: 's-parent' }],
      includeChildren: true,
      requireArchived: true,
      homeEntries: [{ home, label: '默认目录' }],
      isHomeRunning: () => true,
    })
    assert.equal(previewRunning.targets.length, 0)
    assert.equal(previewRunning.blocked.length, 1)
    assert.equal(previewRunning.blocked[0].reason, 'running_home')
    assert.equal(previewRunning.children.length, 1)
    assert.equal(previewRunning.children[0].sessionId, 's-child')

    // 停机后预检并执行删除（含子会话）
    const previewIdle = await previewDeleteSessions({
      items: [{ home, sessionId: 's-parent' }],
      includeChildren: true,
      requireArchived: true,
      homeEntries: [{ home, label: '默认目录' }],
      isHomeRunning: () => false,
    })
    assert.equal(previewIdle.targets.length, 1)
    assert.equal(previewIdle.children.length, 1)
    assert.equal(previewIdle.totalDeleteCount, 2)
    assert.ok(previewIdle.excluded.includes('workspace_files'))
    assert.ok(previewIdle.excluded.includes('memory'))
    assert.ok(previewIdle.excluded.includes('attachments'))

    const delRes = await deleteSessions({
      items: [{ home, sessionId: 's-parent' }],
      includeChildren: true,
      requireArchived: true,
      isHomeRunning: () => false,
    })
    assert.equal(delRes.succeeded.length, 2)
    assert.ok(delRes.freedBytes > 0)
    assert.equal(existsSync(parent.dir), false)
    assert.equal(existsSync(child.dir), false)
    assert.equal(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 's-parent.json')), false)
    assert.equal(existsSync(keep.dir), true)
    // 工作区代码、记忆、附件完好无损
    assert.equal(readFileSync(join(projectDir, 'README.md'), 'utf8'), 'do-not-delete')
    assert.equal(readFileSync(join(home, 'memory', 'memory.db'), 'utf8'), 'keep-memory')
    assert.equal(readFileSync(join(home, 'attachments', 'v1', 'objects', 'ab', 'abcdef'), 'utf8'), 'keep-attachment')

    // workspace.json 已一致摘除引用
    const wsAfter = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(wsAfter.global.archivedSessionIds, [])
    assert.deepEqual(wsAfter.tables.workspaces['ws-1'].sessionIds, ['s-keep'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
})

test('removeWorkspace 明确区分「仅从侧栏移除」与「移除并删除会话数据」，且绝不删除用户代码目录', async () => {
  clearSessionScanCache()
  const home = makeTempHome()
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-ws-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-ws-b-'))
  try {
    writeFileSync(join(dirB, 'keep.txt'), 'safe')
    writeWorkspaceJson(home, {
      workspaceIds: ['ws-a', 'ws-b'],
      workspaces: {
        'ws-a': { path: dirA, title: 'A', sessionIds: ['sa-1'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
        'ws-b': { path: dirB, title: 'B', sessionIds: ['sb-1'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      },
    })
    const sa = writeMultiFrameSession(home, '--a--', 'sa-1', { createdAt: 1790000001000, cwd: dirA })
    const sb = writeMultiFrameSession(home, '--b--', 'sb-1', { createdAt: 1790000002000, cwd: dirB })

    // 仅移除侧栏：会话文件仍在磁盘
    await removeWorkspace({ home, workspaceId: 'ws-a', deleteData: false, isHomeRunning: () => false })
    assert.equal(existsSync(sa.dir), true)
    const wsMid = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(Object.hasOwn(wsMid.tables.workspaces, 'ws-a'), false)

    // 移除并删除会话数据：会话目录与变空的项目目录均已清理，但用户项目 dirB 原封不动
    const resB = await removeWorkspace({ home, workspaceId: 'ws-b', deleteData: true, isHomeRunning: () => false })
    assert.equal(resB.removed, true)
    assert.equal(resB.deleted.succeeded.length, 1)
    assert.equal(existsSync(sb.dir), false)
    assert.equal(existsSync(join(home, 'sessions', '--b--')), false)
    assert.equal(readFileSync(join(dirB, 'keep.txt'), 'utf8'), 'safe')

    // 扫描确认 sa-1 现为孤儿会话
    const after = await scanHomeSessions(home)
    assert.equal(after.sessions.length, 1)
    assert.equal(after.sessions[0].sessionId, 'sa-1')
    assert.equal(after.sessions[0].orphan, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('analyzeHomeData 准确区分用户数据层与实例运行时/缓存层，并拆解 Profile 依赖与配置', async () => {
  clearSessionScanCache()
  const home = makeTempHome('dsh-ana-')
  try {
    writeWorkspaceJson(home, {
      workspaceIds: ['ws-1'],
      archivedSessionIds: ['s-2'],
      workspaces: {
        'ws-1': { path: home, title: 'Demo', sessionIds: ['s-1', 's-2'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      },
    })
    writeMultiFrameSession(home, '--demo--', 's-1', { createdAt: 1790000001000, cwd: home }, [{ seq: 1, type: 'user/message', content: 'hello' }])
    writeMultiFrameSession(home, '--demo--', 's-2', { createdAt: 1790000002000, cwd: home })

    // 用户数据：附件、记忆、插件数据、根凭据
    mkdirSync(join(home, 'attachments', 'v1', 'objects', 'aa'), { recursive: true })
    writeFileSync(join(home, 'attachments', 'v1', 'objects', 'aa', 'hash1'), Buffer.alloc(1024))
    mkdirSync(join(home, 'memory'), { recursive: true })
    writeFileSync(join(home, 'memory', 'memory.db'), Buffer.alloc(2048))
    mkdirSync(join(home, 'botharness'), { recursive: true })
    writeFileSync(join(home, 'botharness', 'data.db'), Buffer.alloc(4096))
    writeFileSync(join(home, '.credentials.yaml'), 'secret: 1\n')

    // 运行时层：profiles/web（node_modules vs 配置）+ cache + logs
    mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"name":"web"}')
    writeFileSync(join(home, 'profiles', 'web', 'node_modules', 'pkg', 'index.js'), Buffer.alloc(8192))
    mkdirSync(join(home, 'cache'), { recursive: true })
    writeFileSync(join(home, 'cache', 'item.bin'), Buffer.alloc(512))
    mkdirSync(join(home, 'logs'), { recursive: true })
    writeFileSync(join(home, 'logs', 'app.log'), Buffer.alloc(256))

    const stats = await analyzeHomeData(home, {
      homeLabel: '测试卷',
      homeRunning: false,
      isDefault: true,
      presets: [{ id: 'p1', name: '主启动项', profile: 'web', environmentName: 'web-env', running: false }],
    })

    assert.equal(stats.label, '测试卷')
    assert.equal(stats.userData.attachments.bytes, 1024)
    assert.equal(stats.userData.memory.bytes, 2048)
    assert.equal(stats.userData.pluginData.length, 1)
    assert.equal(stats.userData.pluginData[0].name, 'botharness')
    assert.equal(stats.userData.pluginData[0].bytes, 4096)
    assert.equal(stats.userData.sessions.total, 2)
    assert.equal(stats.userData.sessions.archived, 1)

    assert.equal(stats.runtimeData.profiles.length, 1)
    assert.equal(stats.runtimeData.profiles[0].name, 'web')
    assert.equal(stats.runtimeData.profiles[0].depsBytes, 8192)
    assert.ok(stats.runtimeData.profiles[0].configBytes > 0)
    assert.equal(stats.runtimeData.profiles[0].linkedPresets[0].environmentName, 'web-env')
    assert.equal(stats.runtimeData.cache.bytes, 512)
    assert.equal(stats.runtimeData.logs.bytes, 256)
    assert.equal(stats.totalBytes, stats.userDataBytes + stats.runtimeBytes)
    assert.ok(stats.categories.some((c) => c.key === 'sessions' && c.layer === 'user'))
    assert.ok(stats.categories.some((c) => c.key === 'profiles' && c.layer === 'runtime'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('打包清单、页面入口与英文翻译完整接入', () => {
  const packCommon = readFileSync(new URL('../scripts/pack-common.mjs', import.meta.url), 'utf8')
  assert.match(packCommon, /'sessions\.js'/)

  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
  assert.match(html, /data-pane="sessions"/)
  assert.match(html, /id="pane-sessions"/)
  assert.match(html, /id="sessDeviceFilterBar"/)
  assert.match(html, /id="sessHomeGrid"/)
  assert.match(html, /id="sessDetailView"/)
  assert.match(html, /id="sessTabAnalytics"/)
  assert.match(html, /id="sessionAddHomeDialog"/)
  assert.match(html, /id="sessAddDeviceTrigger"/)
  assert.match(html, /id="sessionHomeRenameDialog"/)
  assert.match(html, /id="sessionDeleteDialog"/)
  assert.match(html, /\/sessions-page\.js/)

  const en = readFileSync(new URL('../src/public/i18n-en.js', import.meta.url), 'utf8')
  assert.match(en, /"归档中心":\s*"Archive center"/)
  assert.match(en, /"数据分析":\s*"Data analysis"/)
  assert.match(en, /"清理空白会话":\s*"Clean blank sessions"/)
  assert.match(en, /"全部设备":\s*"All devices"/)
  assert.match(en, /"目录名称":\s*"Directory name"/)

  const pageJs = readFileSync(new URL('../src/public/sessions-page.js', import.meta.url), 'utf8')
  assert.match(pageJs, /data-home="/)
  assert.match(pageJs, /querySelectorAll\('\[data-home\]'\)/)
  assert.match(pageJs, /\/api\/sessions\/remote\?home=/)
  assert.match(pageJs, /sessAddDevicePanel/)
})

test('safeRemoteDshHomes 正确校验与去重 WSL / SSH 远端用户目录配置', () => {
  const idWsl = '0123456789abcdef'
  const idSsh = 'fedcba9876543210'
  const cleaned = safeRemoteDshHomes([
    { kind: 'wsl', connectionId: idWsl, wslDistro: 'Ubuntu', wslUser: 'alice', remoteHome: '~/.dsh', name: 'Ubuntu 主目录' },
    // 相同 kind + connectionId + remoteHome 应去重（保留前者）
    { kind: 'wsl', connectionId: idWsl, wslDistro: 'Ubuntu', remoteHome: '~/.dsh', name: '重复条目' },
    { kind: 'ssh', connectionId: idSsh, remoteHome: '/data/dsh-prod', name: '生产机' },
    // 无效条目：SSH 缺少或非法 connectionId / 非法相对路径 / 未知 kind
    { kind: 'ssh', remoteHome: '~/.dsh' },
    { kind: 'ssh', connectionId: 'not-a-hex-id', remoteHome: '~/.dsh' },
    { kind: 'wsl', wslDistro: 'Ubuntu', remoteHome: 'relative/path' },
    { kind: 'local', remoteHome: '~/.dsh' },
    null,
  ])
  assert.equal(cleaned.length, 2)
  assert.equal(cleaned[0].kind, 'wsl')
  assert.equal(cleaned[0].connectionId, idWsl)
  assert.equal(cleaned[0].wslDistro, 'Ubuntu')
  assert.equal(cleaned[0].wslUser, 'alice')
  assert.equal(cleaned[0].remoteHome, '~/.dsh')
  assert.equal(cleaned[0].name, 'Ubuntu 主目录')
  assert.equal(cleaned[1].kind, 'ssh')
  assert.equal(cleaned[1].connectionId, idSsh)
  assert.equal(cleaned[1].remoteHome, '/data/dsh-prod')
  assert.equal(cleaned[1].name, '生产机')
})
