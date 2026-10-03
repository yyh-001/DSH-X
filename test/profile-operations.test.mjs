import assert from 'node:assert/strict'
import { isolateUserHome } from './isolated-home.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readPackState, rememberPack } from '../packs.js'

test('环境操作保护：多实例、写锁、恢复目标与托盘状态', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-ops-'))
  const app = isolateUserHome(root)
  const home = join(root, 'home')
  const data = join(root, 'data')
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  mkdirSync(app, { recursive: true })
  function makeProfile(name) {
    const dir = join(home, 'profiles', name)
    mkdirSync(join(dir, 'node_modules', 'demo-plugin'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'demo-plugin': '1.0.0' }, dsh: { profile: { bundles: ['demo-plugin'] } } }))
    writeFileSync(join(dir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'node_modules', 'demo-plugin', 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-plugin\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: demo\n  disabled: false\n')
    return dir
  }
  const web = makeProfile('web')
  const guarded = makeProfile('guarded')
  const recoverable = makeProfile('recoverable')
  const versions = ['0.1.6', '0.1.7']
  for (const version of versions) {
    const lib = join(data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'bin.js'), `import { createServer } from 'node:http'
const server = createServer((req, res) => res.end('<!doctype html><html><body>ok</body></html>'))
setTimeout(() => server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake')), 300)
`)
  }
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, profile: 'web', seedMarket: false, seedBundled: false }))
  process.env.APPDATA = root
  process.env.PORT = String(port)
  process.env.DSH_VERSIONS_DATA = data
  const server = await import('../server.js')
  const base = await server.startServer()
  t.after(async () => {
    await server.stopAll()
    // Windows 子进程退出后文件句柄可能稍晚释放，不让临时目录清理盖过断言结果。
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统临时目录清理 */ }
  })
  async function api(path, body) {
    const res = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error)
    return result
  }

  await t.test('默认选择之外，启动中与多版本运行的环境都不能删除或卸载', async () => {
    rememberPack(data, { name: 'demo', profile: 'guarded', createdProfile: true, files: [] })
    const launching = api('/api/start', { version: versions[0], profile: 'guarded' })
    // 等到子进程已注册但尚未就绪，确定性地覆盖 starting 分支。
    const deadline = Date.now() + 5000
    while (!(await api('/api/state')).instances.some((item) => item.profile === 'guarded')) {
      assert.ok(Date.now() < deadline, '假实例应进入启动状态')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await assert.rejects(api('/api/packs/remove-profile', { profile: 'guarded' }), /请先停止/)
    await launching
    await api('/api/start', { version: versions[1], profile: 'guarded' })
    assert.equal((await api('/api/state')).profile, 'web')
    const manifest = readFileSync(join(guarded, 'package.json'), 'utf8')
    for (const removeProfile of [false, true]) {
      await assert.rejects(api('/api/packs/uninstall', { name: 'demo', profile: 'guarded', removeProfile }), /请先停止/)
    }
    assert.equal(readFileSync(join(guarded, 'package.json'), 'utf8'), manifest)
    assert.equal(readPackState(data).packs.length, 1)
    await api('/api/stop', { version: versions[0], profile: 'guarded' })
    await assert.rejects(api('/api/packs/remove-profile', { profile: 'guarded' }), /请先停止/)
    await api('/api/stop', { version: versions[1], profile: 'guarded' })
    const result = await api('/api/packs/uninstall', { name: 'demo', profile: 'guarded', removeProfile: true })
    assert.equal(result.removedProfile, true)
    assert.equal(result.busy, false, '响应发送前已经释放环境操作占用')
    assert.equal(existsSync(guarded), false)
    assert.equal(readPackState(data).packs.length, 0)
  })

  await t.test('插件、批量开关、MCP 与本地技能遵守同一份 profile 锁', async () => {
    const patch = join(web, 'cordis.patch.yml')
    const before = readFileSync(patch, 'utf8')
    const lock = join(web, 'lock')
    writeFileSync(lock, String(process.pid))
    for (const [path, body] of [
      ['/api/plugins/toggle', { name: 'demo-plugin', enabled: false }],
      ['/api/packs/toggle', { profile: 'web', enabled: false }],
      ['/api/mcp/save', { serverName: 'demo', transport: 'stdio', command: 'node' }],
      ['/api/mcp/toggle', { serverName: 'demo', enabled: false }],
      ['/api/mcp/remove', { serverName: 'demo' }],
      ['/api/skills/local', { enabled: true }],
    ]) {
      await assert.rejects(api(path, body), /profile.*操作|profile.*锁/, path)
      assert.equal(readFileSync(patch, 'utf8'), before)
      assert.equal(existsSync(lock), true)
    }
    unlinkSync(lock)
    await api('/api/plugins/toggle', { name: 'demo-plugin', enabled: false })
    assert.match(readFileSync(patch, 'utf8'), /disabled: true/)
    assert.equal(existsSync(lock), false)
  })

  await t.test('恢复结果按目标环境读取，其他环境不借用这份备份', async () => {
    await api('/api/recover', { profile: 'recoverable' })
    const own = await api('/api/recover?profile=recoverable')
    assert.equal(own.profile, 'recoverable')
    assert.ok(own.last.backup)
    assert.deepEqual(own.last.dropped, ['demo-plugin'])
    assert.equal((await api('/api/recover?profile=web')).last, null)
    assert.equal(existsSync(join(recoverable, 'cordis.patch.yml')), false)
    await api('/api/recover/restore', { profile: 'recoverable', backup: own.last.backup })
    assert.ok(existsSync(join(recoverable, 'cordis.patch.yml')))
  })

  await t.test('轻量托盘仍返回已安装状态与真实实例地址', async () => {
    await api('/api/start', { version: versions[0], profile: 'web' })
    const state = await api('/api/state')
    const text = await (await fetch(base + '/api/tray')).text()
    assert.match(text, /status=running/)
    assert.match(text, /installed=1/)
    assert.ok(text.includes(`url=${state.running.url}`))
    await api('/api/stop', {})
    assert.match(await (await fetch(base + '/api/tray')).text(), /status=stopped/)
  })

  await t.test('静态资源可条件重用，首页与 API 仍不缓存', async () => {
    for (const file of ['/launcher.css', '/log-view.js']) {
      const first = await fetch(base + file)
      assert.equal(first.status, 200)
      const etag = first.headers.get('etag')
      assert.ok(etag)
      assert.equal(first.headers.get('cache-control'), 'no-cache')
      await first.text()
      const unchanged = await fetch(base + file, { headers: { 'if-none-match': etag } })
      assert.equal(unchanged.status, 304)
      assert.equal(await unchanged.text(), '')
      const different = await fetch(base + file, { headers: { 'if-none-match': 'W/"old-version"' } })
      assert.equal(different.status, 200)
      await different.text()
    }
    for (const file of ['/', '/api/state']) {
      const res = await fetch(base + file)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('etag'), null)
      await res.text()
    }
  })
})
