/**
 * Profile 配置层备份：快照去重、列表、回退和参数校验。
 * 备份的是 profile 目录里的配置文件（package.json / cordis.patch.yml / .npmrc 等），
 * node_modules 不进来；回退前服务端会先把当前状态再存一份，所以退错了还能再退回来。
 */
import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('Profile 配置层备份：快照去重、列表、回退与参数校验', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-backups-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: demo\n  disabled: false\n')
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  const server = await import('../src/server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })
  async function api(path, body) {
    const res = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await res.json()
    return { status: res.status, ...result }
  }

  let firstId = ''
  await t.test('第一次快照落盘，重复快照按内容去重', async () => {
    const first = await api('/api/profile-backups/snapshot', { profile: 'web' })
    assert.ok(first.backup, '第一次快照应该生成备份')
    firstId = first.backup.id
    assert.ok(first.backup.files.some((file) => file.name === 'cordis.patch.yml'))
    assert.ok(first.backup.files.some((file) => file.name === 'package.json'))
    assert.equal(first.backup.files.some((file) => /node_modules/.test(file.name)), false, 'node_modules 不进备份')
    const again = await api('/api/profile-backups/snapshot', { profile: 'web' })
    assert.equal(again.backup, null, '内容没变时不该堆新备份')
    const list = await api('/api/profile-backups?profile=web')
    assert.equal(list.backups.length, 1)
    assert.equal(list.backups[0].id, firstId)
  })

  await t.test('自动清理：打开列表 / 内容没变时都清掉超过 30 天的备份，最新一份再旧也留着', async () => {
    const [stamp] = readdirSync(join(data, 'backups', 'profiles'))
    const root = join(data, 'backups', 'profiles', stamp, 'web')
    // 伪造一份 2020 年的备份：内容哈希对不上当前配置也不要紧，清理只看 createdAt
    const writeStale = (id) => {
      mkdirSync(join(root, id))
      writeFileSync(join(root, id, 'manifest.json'), JSON.stringify({
        profile: 'web', home, createdAt: new Date('2020-01-01T00:00:00Z').getTime(), signature: 'stale',
        files: [{ name: 'package.json', size: 1 }],
      }))
    }
    // 打开备份窗（列列表）就清一次
    writeStale('20200101-000000')
    const listed = await api('/api/profile-backups?profile=web')
    assert.ok(!listed.backups.some((item) => item.id === '20200101-000000'), '打开列表时过期备份就被清掉')
    assert.equal(existsSync(join(root, '20200101-000000')), false)
    // 配置没变（和最新那份一样）走「不需要新备份」分支，过期清理也得照跑
    writeStale('20200102-000000')
    const again = await api('/api/profile-backups/snapshot', { profile: 'web' })
    assert.equal(again.backup, null, '内容没变，不该新建备份')
    assert.equal(existsSync(join(root, '20200102-000000')), false, '去重分支里也清过期备份')
    // 只剩的那份就是最新（也是唯一）一份：改成 60 天前，再触发一次去重快照，它不能被清
    const manifestPath = join(root, firstId, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const originalAt = manifest.createdAt
    manifest.createdAt = Date.now() - 60 * 24 * 60 * 60 * 1000
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await api('/api/profile-backups/snapshot', { profile: 'web' })
    assert.ok((await api('/api/profile-backups?profile=web')).backups.some((item) => item.id === firstId), '最新一份再旧也留着，回退入口不能消失')
    // 恢复原时间：后面还要拿它当「旧备份」，不能被下一次真正的新快照按 30 天规则清掉
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdAt: originalAt }))
  })

  await t.test('改坏配置后生成新快照，回退能把旧内容改回来', async () => {
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: demo\n  disabled: true\n')
    const snapshot = await api('/api/profile-backups/snapshot', { profile: 'web' })
    assert.ok(snapshot.backup)
    const list = await api('/api/profile-backups?profile=web')
    assert.equal(list.backups.length, 2)
    const restored = await api('/api/profile-backups/restore', { profile: 'web', id: firstId })
    assert.equal(restored.restored, firstId)
    assert.ok(restored.backup, '回退前应该先把当前（坏）状态存一份')
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '- id: demo\n  disabled: false\n')
    const after = await api('/api/profile-backups?profile=web')
    assert.ok(after.backups.length >= 3, '回退前应先把当前（坏）状态也存一份')
  })

  await t.test('手动删除备份：只删指定那份', async () => {
    const before = await api('/api/profile-backups?profile=web')
    const target = before.backups[before.backups.length - 1]
    const removed = await api('/api/profile-backups/delete', { profile: 'web', id: target.id })
    assert.equal(removed.ok, true)
    assert.equal(removed.deleted, target.id)
    const after = await api('/api/profile-backups?profile=web')
    assert.equal(after.backups.length, before.backups.length - 1)
    assert.ok(!after.backups.some((item) => item.id === target.id), '删掉的那份不在列表里')
  })

  await t.test('非法 profile / id 不会碰目录，也不炸服务', async () => {
    assert.equal((await api('/api/profile-backups?profile=../web')).status, 400)
    assert.equal((await api('/api/profile-backups?profile=web&id=../../x')).status, 400)
    assert.equal((await api('/api/profile-backups/snapshot', { profile: '' })).status, 400)
    assert.equal((await api('/api/profile-backups/restore', { profile: 'web', id: '20000101-000000' })).status, 404)
    assert.equal((await api('/api/profile-backups/restore', { profile: 'web', id: '../x' })).status, 400)
    assert.equal((await api('/api/profile-backups/delete', { profile: 'web', id: '../x' })).status, 400)
    assert.equal((await api('/api/profile-backups/delete', { profile: 'web', id: '20000101-000000' })).status, 404)
  })
})
