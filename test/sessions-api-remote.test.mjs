import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

/**
 * 「数据」页的远端用户目录接口：WSL / SSH 目录的登记与合并，以及批量操作的路由边界。
 * 这里不起真远端（远端 core 全程连不上），只验证登记 / 归并 / 错误文案，以及
 * 「一批操作只能落在一个目录上」这条护栏——它挡的是把本机会话当成远端路径转发的错误。
 */
test('远端用户目录：登记 / 归并 / 重命名 / 移除与批量操作的设备边界', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-homes-'))
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
  process.env.PORT = String(port)
  const localHome = join(root, 'local-home')
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: join(root, 'data'), dshHome: localHome, profile: 'web', seedMarket: false,
  }))
  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(() => server.stopAll())
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, {
      method,
      headers: { origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response, data: await response.json() }
  }

  const wslConn = await call('/api/connections', 'POST', { kind: 'wsl', name: 'Ubuntu 开发机', wslDistro: 'Ubuntu', wslUser: 'alice' })
  const sshConn = await call('/api/connections', 'POST', {
    kind: 'ssh', name: '生产机', host: '127.0.0.1', port: 1, username: 'root', authType: 'password',
  })
  assert.equal(wslConn.response.status, 200)
  assert.equal(sshConn.response.status, 200)

  // 登记：合成键与页面 sshHomeKeyOf / wslHomeKey 同格式，显示名一起存下来
  const addedWsl = await call('/api/dsh-homes/add', 'POST', { kind: 'wsl', connectionId: wslConn.data.connection.id, remoteHome: '~/.dsh', name: 'Ubuntu 主目录' })
  assert.equal(addedWsl.response.status, 200, JSON.stringify(addedWsl.data))
  assert.equal(addedWsl.data.home, 'wsl://Ubuntu/~%2F.dsh')
  assert.equal(addedWsl.data.remoteDshHomes.length, 1)
  assert.equal(addedWsl.data.remoteDshHomes[0].name, 'Ubuntu 主目录')
  const addedSsh = await call('/api/dsh-homes/add', 'POST', { kind: 'ssh', connectionId: sshConn.data.connection.id, remoteHome: '/srv/dsh' })
  const sshKey = addedSsh.data.home
  assert.match(sshKey, /^ssh:\/\/[a-f0-9]{16}\/%2Fsrv%2Fdsh$/)

  // 同一设备同一目录只留一条；没有对应连接的远端目录直接报错
  const again = await call('/api/dsh-homes/add', 'POST', { kind: 'wsl', connectionId: wslConn.data.connection.id, remoteHome: '~/.dsh' })
  assert.equal(again.data.remoteDshHomes.length, 2, '去重后仍是两条（WSL + SSH）')
  const noConn = await call('/api/dsh-homes/add', 'POST', { kind: 'ssh', connectionId: '0123456789abcdef', remoteHome: '~/.dsh' })
  assert.ok(noConn.data.error && /连接/.test(noConn.data.error), '不存在的连接被拒：' + JSON.stringify(noConn.data))

  // /api/sessions 把远端目录并进列表，但不静态扫描它（计数留空，由页面按需拉）
  const listed = await call('/api/sessions')
  const remotes = listed.data.homes.filter((h) => h.deviceKind !== 'local')
  assert.deepEqual(remotes.map((h) => h.home).sort(), ['ssh://' + sshKey.slice(6), 'wsl://Ubuntu/~%2F.dsh'].sort())
  for (const home of remotes) {
    assert.equal(home.sessionCount, null)
    assert.equal(home.registered, true)
    assert.ok(home.label, '有显示名')
    assert.ok(home.displayPath, '有展示用路径')
  }
  assert.ok(remotes.some((h) => h.deviceKind === 'wsl' && h.deviceName === 'Ubuntu 开发机'))
  assert.ok(listed.data.homes.some((h) => h.deviceKind === 'local' && h.home === localHome), '本机目录照旧')

  // 远端连不上时给可读错误，不把栈吐给页面
  for (const path of ['/api/sessions/remote?home=' + encodeURIComponent(sshKey), '/api/sessions/home-stats?home=' + encodeURIComponent(sshKey)]) {
    const res = await call(path)
    assert.equal(res.response.status, 400, path)
    assert.ok(res.data.error, path)
  }
  const unknown = await call('/api/sessions/remote?home=' + encodeURIComponent('wsl://Nope/~%2F.dsh'))
  assert.equal(unknown.response.status, 400)
  assert.match(unknown.data.error, /未登记/)

  // 一批操作只能落在一个目录上：本机 + 远端、或两台设备混批都整批拒绝
  const mixed = await call('/api/sessions/state', 'POST', {
    action: 'archive',
    items: [{ home: localHome, sessionId: 'x' }, { home: sshKey, sessionId: 'y', remoteRawHome: '/srv/dsh' }],
  })
  assert.equal(mixed.response.status, 400, JSON.stringify(mixed.data))
  assert.match(mixed.data.error, /一次只能操作一个用户目录/)
  const twoDevices = await call('/api/sessions/delete-preview', 'POST', {
    items: [
      { home: 'wsl://Ubuntu/~%2F.dsh', sessionId: 'y', remoteRawHome: '~/.dsh' },
      { home: sshKey, sessionId: 'z', remoteRawHome: '/srv/dsh' },
    ],
  })
  assert.equal(twoDevices.response.status, 400, JSON.stringify(twoDevices.data))
  assert.match(twoDevices.data.error, /一次只能操作一个用户目录/)

  // 本机批照旧交给本地引擎（未知会话只会被跳过）
  const localBatch = await call('/api/sessions/state', 'POST', { action: 'archive', items: [{ home: localHome, sessionId: 'not-a-real-session' }] })
  assert.equal(localBatch.response.status, 200, JSON.stringify(localBatch.data))
  assert.ok(Array.isArray(localBatch.data.failed))

  // 重命名：按合成键改的是 remoteDshHomes 里的显示名
  const renamed = await call('/api/dsh-homes/rename', 'POST', { home: sshKey, name: '生产数据卷' })
  assert.equal(renamed.response.status, 200, JSON.stringify(renamed.data))
  assert.equal(renamed.data.remoteDshHomes.find((item) => item.kind === 'ssh').name, '生产数据卷')

  // 移除登记不动磁盘，也不影响本机目录
  const removed = await call('/api/dsh-homes/remove', 'POST', { home: sshKey })
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data))
  assert.equal(removed.data.remoteDshHomes.length, 1)
  const after = await call('/api/sessions')
  assert.equal(after.data.homes.some((h) => h.home === sshKey), false)
  assert.ok(after.data.homes.some((h) => h.home === localHome))
  const stored = JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8'))
  assert.equal(stored.remoteDshHomes.length, 1)

  // 本机目录：登记时顺手存显示名，移除时清掉登记（显示名按设计保留，另有 forget-name 收拾）
  const extra = join(root, 'another-home')
  mkdirSync(join(extra, 'sessions'), { recursive: true })
  const localAdd = await call('/api/dsh-homes/add', 'POST', { home: extra, name: '本地别名' })
  assert.equal(localAdd.response.status, 200, JSON.stringify(localAdd.data))
  assert.equal(localAdd.data.dshHomeNames[extra], '本地别名')
  const localRemove = await call('/api/dsh-homes/remove', 'POST', { home: extra })
  assert.equal(localRemove.response.status, 200, JSON.stringify(localRemove.data))
  assert.deepEqual(localRemove.data.dshHomes, [])
})
