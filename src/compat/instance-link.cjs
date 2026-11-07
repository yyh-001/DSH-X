/**
 * 市场重启会把继任进程的输出改到临时日志；独立管道才能把新 token 送回启动器。
 * 只在同一入口、同一 profile 的主线程启用，继承环境的 helper / 工具 / worker 不参与。
 */
'use strict'
const LINK = Object.freeze({
  env: 'DSH_X_INSTANCE_LINK', host: '127.0.0.1', maxFrameBytes: 16384,
  pollMs: 250, connectTimeoutMs: 5000, exitGraceMs: 2000,
  // 服务端收到连接后等第一帧的上限。客户端把握手帧排进内核后可能被 dsh 的同步启动
  // 占住事件循环几十秒，管理器自己的循环也可能忙；5 秒那条线不能拿来判断对方还活着。
  handshakeTimeoutMs: 60_000,
  ready: /dsh web:\s+(https?:\/\/[^\s]+)/,
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
  const { writeSync } = require('node:fs')
  const socket = createConnection({ host: LINK.host, port: config.port })
  // 管道不延长 dsh 的寿命；但失去监管时不能留下一个无人管理、拿不到 token 的进程。
  socket.unref()
  let stopping = false
  const fail = (reason) => {
    if (stopping) return
    stopping = true
    // 失败原因必须落进管理器的 failure.tail：直接同步写 fd 2，不经过下面被包装的
    // stdout/stderr，也不会在随后被 SIGNAL 终止时丢掉（否则失败页面只有「零输出 exit 1」）。
    try { writeSync(2, `dsh-x: 实例管道${reason}，退出以免留下没人接管的进程\n`) } catch { /* fd 2 不可写也不影响退出 */ }
    process.kill(process.pid, 'SIGTERM')
    setTimeout(() => process.exit(1), LINK.exitGraceMs).unref()
  }
  // 这条计时器只兜「连接真的没建立」，不能当成握手截止时间：dsh 的同步启动阶段会把事件
  // 循环占住几十秒，TCP 连接其实早已完成，只是 connect 回调排在定时器后面。让这一轮 poll
  // 先跑完再判断——连上了就不算失去监管（见 #87）。
  const timer = setTimeout(() => {
    setImmediate(() => {
      if (socket.readyState === 'open') return
      fail('没有连上启动器（连接超时）')
    })
  }, LINK.connectTimeoutMs).unref()
  socket.on('error', (error) => fail(`出错（${error?.code || error?.message || '连接失败'}）`))
  socket.on('close', () => fail('已断开（启动器退出或撤销了这次启动）'))
  // 先排入握手帧，再包装输出：极快的启动可能在 TCP connect 回调之前就打印 ready。
  socket.write(JSON.stringify({ secret: config.secret, pid: process.pid }) + '\n')
  socket.on('connect', () => clearTimeout(timer))
  socket.on('data', () => {
    // 这里只接收启动器撤销本次启动的指令；晚到的继任进程也必须退出，不能复活已停止的实例。
    fail('收到了撤销指令')
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
