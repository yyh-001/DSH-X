/**
 * 市场重启会把继任进程的输出改到临时日志；独立管道才能把新 token 送回启动器。
 * 只在同一入口、同一 profile 的主线程启用，继承环境的 helper / 工具 / worker 不参与。
 */
'use strict'
const LINK = Object.freeze({
  env: 'DSH_X_INSTANCE_LINK', host: '127.0.0.1', maxFrameBytes: 16384,
  pollMs: 250, connectTimeoutMs: 5000, ready: /dsh web:\s+(https?:\/\/[^\s]+)/,
})
module.exports = LINK

const { isMainThread } = require('node:worker_threads')
const { resolve } = require('node:path')
let config
try { config = JSON.parse(process.env[LINK.env] || 'null') } catch {}
const args = process.argv.slice(2)
const profileAt = args.indexOf('--profile')
const profile = profileAt < 0 ? args[config?.profileArgIndex || 0] : args[profileAt + 1]
if (isMainThread && config && process.argv[1] && resolve(process.argv[1]) === config.entry && profile === config.profile) {
  const { createConnection } = require('node:net')
  const { StringDecoder } = require('node:string_decoder')
  const socket = createConnection({ host: LINK.host, port: config.port })
  // 管道不延长 dsh 的寿命；但失去监管时不能留下一个无人管理、拿不到 token 的进程。
  socket.unref()
  let stopping = false
  const fail = () => {
    if (stopping) return
    stopping = true
    process.kill(process.pid, 'SIGTERM')
    setTimeout(() => process.exit(1), LINK.connectTimeoutMs).unref()
  }
  const timer = setTimeout(fail, LINK.connectTimeoutMs).unref()
  socket.on('error', fail)
  socket.on('close', fail)
  // 先排入握手帧，再包装输出：极快的启动可能在 TCP connect 回调之前就打印 ready。
  socket.write(JSON.stringify({ secret: config.secret, pid: process.pid }) + '\n')
  socket.on('connect', () => clearTimeout(timer))
  socket.on('data', () => {
    // 这里只接收启动器撤销本次启动的指令；晚到的继任进程也必须退出，不能复活已停止的实例。
    fail()
  })
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write
    const decoder = new StringDecoder('utf8')
    let pending = ''
    stream.write = function (chunk, ...rest) {
      const result = write.call(this, chunk, ...rest)
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop().slice(-LINK.maxFrameBytes)
      for (const line of lines) {
        const match = LINK.ready.exec(line)
        if (match) socket.write(JSON.stringify({ url: match[1] }) + '\n')
      }
      return result
    }
  }
}
