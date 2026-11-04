import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolateUserHome } from './isolated-home.mjs'

test('真实管道分块不截断中文与就绪地址，SSE 批次和日志导出都不丢行', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-output-'))
  const app = isolateUserHome(root), data = join(root, 'data'), home = join(root, 'home')
  const binary = join(data, 'versions', '9.9.9', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(binary, { recursive: true })
  mkdirSync(app, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(app, 'settings.json'), JSON.stringify({ dataDir: data, dshHome: home, seedMarket: false, downloadSource: 'official', proxyMode: 'off' }))
  writeFileSync(join(binary, 'bin.js'), `
import { createServer } from 'node:http'
const at = process.argv.indexOf('--port')
const server = createServer((req, res) => res.end('real pipe'))
server.listen(Number(process.argv[at + 1]), '127.0.0.1', () => {
  const chinese = Buffer.from('跨块中文🙂\\n')
  process.stdout.write(chinese.subarray(0, 4))
  setTimeout(() => {
    process.stdout.write(chinese.subarray(4))
    for (let index = 0; index < 350; index++) console.log('event-' + index)
    process.stdout.write('dsh web: http://127.0.0.1:')
    setTimeout(() => console.log(server.address().port + '/?token=split'), 20)
  }, 10)
})
`)
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  process.env.PORT = String(probe.address().port)
  await new Promise((resolve) => probe.close(resolve))
  const { startServer, stopAll } = await import('../src/server.js')
  const origin = await startServer()
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await stopAll()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const api = async (path, body) => {
    const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  const events = await fetch(origin + '/api/events', { signal: controller.signal })
  const received = []
  let initialized = false, logEvents = 0
  const reading = (async () => {
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of events.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (frame.startsWith('event: state')) initialized = true
        if (!frame.startsWith('event: log')) continue
        const data = JSON.parse(frame.split('\ndata: ')[1])
        received.push(...(data.lines || [data.line]))
        logEvents++
      }
    }
  })().catch((error) => { if (error.name !== 'AbortError') throw error })
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(predicate(), '等待 SSE 日志超时')
  }
  await waitFor(() => initialized)
  const { url } = await api('/api/start', { version: '9.9.9', profile: 'web' })
  assert.equal(await (await fetch(url)).text(), 'real pipe', '就绪地址必须完整，不能在端口号到达前返回半条 URL')
  const exported = await (await fetch(origin + '/api/logs/export')).text()
  assert.ok(exported.includes('跨块中文🙂'))
  assert.equal([...exported.matchAll(/event-\d+/g)].length, 350)
  // ready 的认证地址留在实例状态中，不能因日志分块重组而泄漏到 SSE / 导出。
  assert.equal(new URL(url).searchParams.get('token'), 'split')
  assert.equal((await api('/api/state')).instances[0].url, url)
  await waitFor(() => received.some((line) => line.includes('token=***')))
  assert.ok(!exported.includes('token=split'), '导出不能泄漏真实 token')
  assert.ok(!received.some(line => line.includes('token=split')), 'SSE 不能泄漏真实 token')
  assert.ok(exported.includes('token=***'), '导出保留脱敏后的完整 ready 行')
  assert.equal(received.filter((line) => /event-\d+/.test(line)).length, 350)
  assert.ok(logEvents < 20, '日志风暴不能生成几百个 EventSource 回调')
  await api('/api/stop', {})
  controller.abort()
  await reading
  await stopAll()
  assert.ok(readFileSync(join(app, 'manager.log'), 'utf8').includes('已退出'), '退出前冲刷最后一批日志')
})
