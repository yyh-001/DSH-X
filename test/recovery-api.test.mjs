/**
 * 连续两次安全启动（同一管理器进程）：页面/接口必须指向最早那份备份（用户真正的配置），
 * 还原后整串侧车标 settled，旧提示不再冒出来。
 *
 * 单独一个文件：server.js 是模块单例，每个测试文件独立进程才能拿到干净的端口与设置。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isolateUserHome } from './isolated-home.mjs'

test('连续安全启动：接口指向最早那份，还原后整串收掉', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recovery-chain-'))
  const home = join(root, 'home')
  const app = isolateUserHome(root)
  mkdirSync(app, { recursive: true })
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  process.env.PORT = String(port)
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: join(root, 'data'), dshHome: home, profile: 'web', seedMarket: false, systemPath: false,
  }))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const patch = join(profile, 'cordis.patch.yml')
  const manifest = join(profile, 'package.json')
  writeFileSync(patch, '# user-config-1\n')
  writeFileSync(manifest, JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'plugin-a'] } } }))

  const server = await import('../src/server.js')
  const origin = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })
  const call = async (path, body) => {
    const response = await fetch(origin + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    } : { headers: { origin } })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return data
  }

  const first = await call('/api/recover', { profile: 'web' })
  assert.equal(first.recovery.last.backup, first.backup)
  // 中间 dsh 自己重建了补丁层，用户又装了 plugin-b，再安全启动一次
  writeFileSync(patch, '# user-config-2\n')
  writeFileSync(manifest, JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'plugin-b'] } } }))
  const second = await call('/api/recover', { profile: 'web' })
  assert.notEqual(second.backup, first.backup)

  const view = await call('/api/recover?profile=web')
  assert.equal(view.last.backup, first.backup, '同一管理器进程里也要指向最早那份（用户真正的配置）')
  assert.deepEqual([...view.last.dropped].sort(), ['plugin-a', 'plugin-b'], '两次摘掉的 bundle 合起来')

  const restored = await call('/api/recover/restore', { profile: 'web', backup: view.last.backup })
  assert.equal(readFileSync(patch, 'utf8'), '# user-config-1\n')
  assert.deepEqual([...restored.restoredBundles].sort(), ['plugin-a', 'plugin-b'])
  const bundles = JSON.parse(readFileSync(manifest, 'utf8')).dsh.profile.bundles
  assert.deepEqual([...bundles].sort(), ['@deepseek-ai/dsh-web-app', 'plugin-a', 'plugin-b'])
  assert.equal((await call('/api/recover?profile=web')).last, null, '还原后整串都算处理过了')

  // 被还原的那份变成了现役补丁；剩下的备份侧车标 settled，以后重启管理器也不会把旧备份再顶出来
  assert.equal(existsSync(first.backup), false, '已还原的备份被改回现役补丁')
  assert.equal(JSON.parse(readFileSync(`${second.backup}.json`, 'utf8')).settled, true)
})
