/**
 * 启动项日志的「空间构成」：版本目录 + profile 目录，按插件 / 运行时 / 其它依赖 / 配置与数据分类。
 * pnpm 的 .pnpm 虚拟目录按包名合并，符号链接跳过。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('空间构成接口把传递依赖归到插件，并拆开插件依赖/运行时依赖', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-storage-breakdown-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })

  const bin = '// bin\n'
  const version = join(data, 'versions', '0.2.0')
  mkdirSync(join(version, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), bin)
  writeFileSync(join(version, 'node_modules', '@deepseek-ai', 'dsh', 'runtime.bin'), Buffer.alloc(100))
  mkdirSync(join(version, 'node_modules', 'other-dep'), { recursive: true })
  writeFileSync(join(version, 'node_modules', 'other-dep', 'payload.bin'), Buffer.alloc(50))

  const profile = join(home, 'profiles', 'web')
  const pluginPkg = join(profile, 'node_modules', '.pnpm', 'demo-plugin@1.0.0', 'node_modules', 'demo-plugin')
  const transitivePkg = join(profile, 'node_modules', '.pnpm', 'transitive@2.0.0', 'node_modules', 'transitive')
  mkdirSync(pluginPkg, { recursive: true })
  mkdirSync(transitivePkg, { recursive: true })
  writeFileSync(join(pluginPkg, 'index.js'), Buffer.alloc(300))
  writeFileSync(join(transitivePkg, 'index.js'), Buffer.alloc(80))
  // 依赖图：demo-plugin → transitive，用来验证传递依赖归到插件头上
  const pluginJson = JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dependencies: { transitive: '2.0.0' } })
  const transitiveJson = JSON.stringify({ name: 'transitive', version: '2.0.0' })
  writeFileSync(join(pluginPkg, 'package.json'), pluginJson)
  writeFileSync(join(transitivePkg, 'package.json'), transitiveJson)
  const pluginBytes = 300 + pluginJson.length
  const transitiveBytes = 80 + transitiveJson.length
  const manifest = JSON.stringify({ dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } } })
  writeFileSync(join(profile, 'package.json'), manifest)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')

  writeFileSync(join(data, 'config.json'), JSON.stringify({ versions: ['0.2.0'] }))
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

  const res = await fetch(base + '/api/storage/breakdown?version=0.2.0&profile=web', { headers: { origin: base } })
  assert.equal(res.status, 200)
  const result = await res.json()
  const bytesOf = (key) => result.segments.find((segment) => segment.key === key)?.bytes || 0
  assert.equal(bytesOf('plugin'), pluginBytes, '插件本体')
  assert.equal(bytesOf('plugin-deps'), transitiveBytes, '插件的传递依赖')
  assert.equal(bytesOf('runtime'), bin.length + 100)
  assert.equal(bytesOf('runtime-deps'), 50, '版本目录里非官方的依赖')
  assert.equal(bytesOf('data'), manifest.length + '[]\n'.length)
  assert.equal(result.total, bin.length + 100 + 50 + pluginBytes + transitiveBytes + manifest.length + 3)
  assert.equal(result.plugins.find((plugin) => plugin.name === 'demo-plugin')?.bytes, pluginBytes + transitiveBytes, '插件的总占用含它带进来的依赖')
  assert.equal(result.items[0].name, 'demo-plugin', '最大的包排第一')
  assert.equal(result.items[0].plugin, true, '直接依赖标记成插件')
  assert.equal(result.items.find((item) => item.name === 'other-dep')?.plugin, false)
})
