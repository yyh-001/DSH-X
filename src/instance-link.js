import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import LINK from './compat/instance-link.cjs'

/** ESRCH 才能证明已退出；权限错误不能把仍占着 profile 的进程变成「已停止」。 */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/**
 * detached 继任进程不再是我们的 OS 子进程，但 attachProcess 仍需要相同的输出/退出契约。
 * 退出事件以 PID 消失为准，不能把 TCP 断线当成进程死亡；exitCode/signalCode 明确以 null 表示存活。
 */
class LinkedProcess extends EventEmitter {
  exitCode = null
  signalCode = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  constructor(pid, socket) {
    super()
    this.pid = pid
    this.socket = socket
    this.timer = setInterval(() => this.checkExit(), LINK.pollMs).unref()
  }
  checkExit() {
    if (this.exitCode !== null || alive(this.pid)) return
    clearInterval(this.timer)
    this.exitCode = 0
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', this.exitCode, this.signalCode)
  }
  kill(signal) {
    this.checkExit()
    if (this.exitCode !== null) return false
    try { process.kill(this.pid, signal); return true } catch { return false }
  }
}

/**
 * 一次启动的私有能力：入口/profile 在 preload 侧限定，随机密钥在本机管道侧限定。
 * 原进程退出后保留一个启动预算，市场 helper 才有机会回连；显式停止则立即撤销，
 * 晚到的 helper 继任进程会因连接失败自行退出，不会在后台复活。
 */
export async function createInstanceLink({ entry, profile, profileArgIndex = 0, timeoutMs, onSuccessor, onDispose }) {
  const secret = randomBytes(32).toString('hex')
  const sockets = new Map()
  const disconnectedPids = new Set()
  let current
  let nativePid
  let revoked = false
  let expiry
  let candidate
  const server = createServer(socket => {
    sockets.set(socket, null)
    let pending = ''
    let child
    // 只清掉「连上却一直不发握手帧」的连接：握手帧在 preload 里立刻写出，但两边的同步启动
    // 都可能把事件循环占住一阵，用短的墙钟超时在这里抢先断线会误杀正常启动（见 #87）。
    socket.setTimeout(LINK.handshakeTimeoutMs, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', chunk => {
      pending += chunk.toString('utf8')
      if (pending.length > LINK.maxFrameBytes) { socket.destroy(); return }
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        let frame
        try { frame = JSON.parse(line) } catch { socket.destroy(); return }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { socket.destroy(); return }
        if (!child) {
          if (disconnectedPids.has(frame.pid) || (revoked && frame.pid !== current?.pid) || frame.secret !== secret || !Number.isSafeInteger(frame.pid) || frame.pid <= 0 || !alive(frame.pid)) {
            socket.destroy(); return
          }
          socket.setTimeout(0)
          if (frame.pid === current?.pid) child = current
          else {
            if (candidate) { socket.destroy(); return }
            child = new LinkedProcess(frame.pid, socket)
            candidate = child
            // 继任者可以先连上，但旧实例仍活着时不能交出同一 profile 的所有权。
            const adopt = () => {
              if (revoked || child.exitCode !== null) return
              if (current && alive(current.pid)) return
              clearInterval(child.adoptionTimer)
              clearTimeout(child.adoptionDeadline)
              clearTimeout(expiry)
              current = child
              candidate = null
              onSuccessor(child)
              if (child.readyLine) child.stdout.write(child.readyLine + '\n')
            }
            child.adoptionTimer = setInterval(adopt, LINK.pollMs).unref()
            child.adoptionDeadline = setTimeout(() => {
              clearInterval(child.adoptionTimer)
              socket.destroy()
            }, timeoutMs).unref()
            child.once('exit', () => {
              clearInterval(child.adoptionTimer)
              clearTimeout(child.adoptionDeadline)
              if (candidate === child) candidate = null
              if (revoked) onDispose?.()
            })
            adopt()
          }
          sockets.set(socket, child)
        } else if (typeof frame.url === 'string' && LINK.ready.test('dsh web: ' + frame.url)) {
          // token 只走这条私有内存通路，不写设置或额外日志。
          child.readyLine = 'dsh web: ' + frame.url
          if (child === current && child.pid !== nativePid) child.stdout.write(child.readyLine + '\n')
        }
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LINK.host, resolve)
  })
  server.unref()
  // Windows 要靠仍存活的根进程发现整棵树；关闭管道会让 preload 自杀，不能用它抢先停根。
  // 先撤销继任者入场，已接管进程的管道由 terminateProcess 在尝试树终止后逐个断开。
  const revokeAdmission = () => {
    if (revoked) return
    revoked = true
    clearTimeout(expiry)
    clearInterval(candidate?.adoptionTimer)
    clearTimeout(candidate?.adoptionDeadline)
    // preload 可能尚未 connect：此时关闭监听也会让活根收到 ECONNREFUSED 并抢先自杀。
    if (!current || !alive(current.pid)) server.close()
    if (!candidate) onDispose?.()
  }
  const disconnect = child => {
    disconnectedPids.add(child.pid)
    if (revoked && child.pid === current?.pid) server.close()
    for (const [socket, owner] of sockets) if (owner?.pid === child.pid) socket.destroy()
  }
  const revoke = () => {
    revokeAdmission()
    server.close()
    for (const socket of sockets.keys()) socket.destroy()
  }
  return {
    env: { [LINK.env]: JSON.stringify({ port: server.address().port, secret, entry, profile, profileArgIndex }) },
    bind(child) { current = child; nativePid = child.pid },
    pending() { return candidate ? [candidate] : [] },
    exited(child) {
      if (revoked || current !== child) return
      clearTimeout(expiry)
      expiry = setTimeout(revoke, timeoutMs).unref()
    },
    revokeAdmission,
    disconnect,
    revoke,
  }
}
