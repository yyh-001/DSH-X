/**
 * 版本管理里的磁盘占用：每个受管版本目录的逻辑大小 + 总计。
 * 只统计 DATA/versions 下、带 @deepseek-ai/dsh 入口的版本；符号链接跳过（由 directoryBytes 负责）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('版本管理返回每个版本的目录占用和总计', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-version-sizes-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })

  const bin = '// bin\n'
  const makeVersion = (version, payloadBytes) => {
    const dir = join(data, 'versions', version)
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), bin)
    writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(payloadBytes))
    return dir
  }
  makeVersion('0.1.0', 1024)
  makeVersion('0.2.0', 2048)
  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: ['0.1.0', '0.2.0'] }))
  writeFileSync(join(app, 'settings.json'), JSON.stringify({
    dataDir: data, dshHome: home, profile: 'web', seedMarket: false, systemPath: false,
  }))
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

  const res = await fetch(base + '/api/versions/sizes', { headers: { origin: base } })
  assert.equal(res.status, 200)
  const result = await res.json()
  const unit = bin.length
  assert.equal(result.versions['0.1.0'], unit + 1024)
  assert.equal(result.versions['0.2.0'], unit + 2048)
  assert.equal(result.total, unit * 2 + 1024 + 2048)
})
