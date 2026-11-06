/**
 * #87：dsh 的同步启动阶段会把事件循环占住几十秒，握手帧早就写进内核了，connect 回调却排在
 * 定时器后面。preload 的 5 秒计时器不能因此把进程杀掉——真机上的表现是零输出 exit 1。
 * 对照组：启动器根本连不上时，仍然要退出，但必须留下原因（管理器的 failure.tail 不能为空）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import LINK from '../src/compat/instance-link.cjs'

const preload = fileURLToPath(new URL('../src/compat/instance-link.cjs', import.meta.url))
const secret = 'a'.repeat(64)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fixture(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-link-timeout-'))
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, body)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return entry
}

/** 一个只收握手帧、不回话的启动器；返回收到的帧。 */
async function launcher(t) {
  const frames = []
  const sockets = []
  const server = createServer((socket) => {
    sockets.push(socket)
    socket.on('error', () => {})
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        try { frames.push(JSON.parse(line)) } catch { /* 半帧留在 pending 里 */ }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, LINK.host, resolve))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { frames, port: server.address().port }
}

function start(entry, config) {
  const child = spawn(process.execPath, ['--require', preload, entry, config.profile], {
    env: { ...process.env, [LINK.env]: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, read: () => ({ stdout, stderr }) }
}

test('同步启动块超过 connectTimeoutMs 时，preload 不自杀（#87）', async (t) => {
  const link = await launcher(t)
  // 阻塞发生在 preload 排好握手帧之后，等价于 dsh 把事件循环占住；比 5 秒的计时器多 800ms。
  const blockMs = LINK.connectTimeoutMs + 800
  const entry = fixture(t, `
    const end = Date.now() + ${blockMs}
    while (Date.now() < end) {}
    console.log('dsh web: http://127.0.0.1:43210/?token=slow')
    setInterval(() => {}, 1000)
  `)
  const config = { port: link.port, secret, entry, profile: 'web', profileArgIndex: 0 }
  const { child, read } = start(entry, config)
  t.after(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })

  const deadline = Date.now() + blockMs + 10_000
  while (!read().stdout.includes('dsh web:') && Date.now() < deadline) await delay(100)
  assert.match(read().stdout, /dsh web: http:\/\/127\.0\.0\.1:43210\/\?token=slow/, '阻塞结束后应正常打印就绪地址')
  // 再过一小会儿确认计时器没有在事件循环恢复后补刀
  await delay(500)
  assert.equal(child.exitCode, null, '计时器到点不等于失去监管，进程必须还活着')
  assert.doesNotMatch(read().stderr, /实例管道/, '不该走失败退出路径')
  assert.equal(link.frames.length, 2, '握手帧应在阻塞前发出，就绪帧在阻塞后补上')
  assert.equal(link.frames[0].pid, child.pid)
  assert.equal(link.frames[0].secret, secret)
  assert.match(link.frames[1].url, /^http:\/\/127\.0\.0\.1:43210\//)
})

test('启动器连不上时，preload 仍然退出但留下原因', async (t) => {
  // 先占一个端口再关掉，保证 ECONNREFUSED（而不是被防火墙挂住）
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, LINK.host, resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const entry = fixture(t, 'setInterval(() => {}, 1000)')
  const { child, read } = start(entry, { port, secret, entry, profile: 'web', profileArgIndex: 0 })
  t.after(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })
  const exited = await Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal })),
    delay(10_000).then(() => { throw new Error('连不上启动器时 preload 没有退出') }),
  ])
  // Windows 上 SIGTERM 直接结束进程，退出码 1；POSIX 上是真的 SIGTERM 信号
  assert.ok(exited.code === 1 || exited.signal === 'SIGTERM', `应当失败退出，实际 code=${exited.code} signal=${exited.signal}`)
  assert.match(read().stderr, /实例管道/, '失败原因必须写进 stderr，管理器的失败报告才不是空的')
})
