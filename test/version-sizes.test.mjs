/**
 * 版本管理里的磁盘占用：每个受管版本目录的逻辑大小 + 总计。
 * 只统计 DATA/versions 下、带 @deepseek-ai/dsh 入口的版本；符号链接跳过（由 directoryBytes 负责）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

  // 指纹缓存：node_modules 里多了文件、但安装器的标记没变 → 直接用上次的结果，不重走
  const sizes = async () => (await (await fetch(base + '/api/versions/sizes', { headers: { origin: base } })).json()).versions['0.1.0']
  const modules = join(data, 'versions', '0.1.0', 'node_modules')
  writeFileSync(join(modules, '@deepseek-ai', 'dsh', 'lib', 'extra.bin'), Buffer.alloc(4096))
  assert.equal(await sizes(), unit + 1024, '标记没变：沿用缓存')
  // 安装器写了 .modules.yaml（pnpm 每次装/删都会写）→ 指纹变了，重新统计
  writeFileSync(join(modules, '.modules.yaml'), 'layoutVersion: 5\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(join(modules, '.modules.yaml'), later, later)
  assert.equal(await sizes(), unit + 1024 + 4096 + 'layoutVersion: 5\n'.length, '标记变了：重新走一遍')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(existsSync(join(app, 'size-cache.json')), '结果落盘，管理器重启后照样命中')
})
