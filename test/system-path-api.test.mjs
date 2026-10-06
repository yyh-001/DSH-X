import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'

// Windows 的注册表是实际用户状态；这里只测不会写 shell 配置的手动模式。
test('macOS/Linux PATH API：重复开关、持久化与进程重启，shell 文件不变', { skip: process.platform === 'win32', timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-path-api-'))
  const app = process.platform === 'darwin' ? join(root, 'Library', 'Application Support', 'DSH') : join(root, 'DSH')
  await mkdir(app, { recursive: true })
  const settingsFile = join(app, 'settings.json')
  await writeFile(settingsFile, JSON.stringify({ dataDir: join(root, 'data'), dshHome: join(root, '.dsh'), systemPath: false, seedMarket: false }))
  const names = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']
  for (const name of names) await writeFile(join(root, name), `# untouched ${name}\n`)
  let child
  async function stop() {
    if (!child || child.exitCode !== null) return
    const ended = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await ended
    clearTimeout(force)
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }) })
  const port = await new Promise((resolve, reject) => {
    const probe = createServer().on('error', reject).listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  async function start() {
    const script = `import {startServer,stopAll} from ${JSON.stringify(new URL('../server.js', import.meta.url).href)}; process.on('SIGTERM',()=>stopAll().finally(()=>process.exit(0))); console.log('READY '+await startServer());`
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: root, APPDATA: root, DSH_VERSIONS_DATA: join(root, 'data'), DSH_HOME: join(root, '.dsh'), PORT: String(port), PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stderr.on('data', (b) => { errors += b })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`启动超时：${errors}`)), 4000)
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`启动退出 ${code}: ${errors}`)) })
      child.stdout.on('data', (b) => {
        output += b
        const match = output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
    })
  }
  let origin = await start()
  async function call(enabled) {
    const res = await fetch(`${origin}/api/settings`, enabled === undefined ? { signal: AbortSignal.timeout(3000) } : { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ systemPath: enabled }), signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    assert.equal(res.status, 200, JSON.stringify(data))
    assert.equal(data.systemPathMode, 'manual')
    return data
  }
  assert.equal((await call()).systemPath, false)
  for (const enabled of [true, true, false, false, true]) {
    const data = await call(enabled)
    assert.equal(data.systemPath, enabled)
    assert.equal(data.systemPathResult.ok, false, '设置保存不等于已改 PATH')
    assert.match(data.systemPathResult.message, enabled ? /手动添加/ : /移除添加/)
    if (!enabled) assert.doesNotMatch(data.systemPathResult.message, /export PATH=/)
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).systemPath, enabled)
  }
  await stop()
  origin = await start()
  assert.equal((await call()).systemPath, true, '新的 Node 进程从磁盘读回开启状态')
  await call(false)
  await stop()
  origin = await start()
  assert.equal((await call()).systemPath, false, '关闭也能跨进程保留')
  for (const name of names) assert.equal(await readFile(join(root, name), 'utf8'), `# untouched ${name}\n`)
  const log = await readFile(join(app, 'manager.log'), 'utf8')
  assert.match(log, /系统 PATH 未改：如曾手动添加/)
})
