/**
 * WSL 里那半截脚本（wsl-scripts.js 的 agent、wsl.js 的安装脚本）真拿 bash 跑一遍：
 * 字符串断言盯不住竞态和收尸逻辑。用临时 HOME + 假 dsh，不需要 WSL，macOS / Linux 都能跑；
 * Windows 上没有 bash 就跳过（CI 的 Linux job 会覆盖）。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WSL_AGENT_SCRIPT } from '../src/wsl-scripts.js'
import { buildAgentInstallScript } from '../src/wsl.js'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'exit 0']).status === 0
const skip = hasBash ? false : '需要 bash'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dshx-wsl-agent-'))
  const script = join(root, 'dsh-x-wsl.sh')
  writeFileSync(script, WSL_AGENT_SCRIPT, { mode: 0o755 })
  const log = join(root, 'dsh.log')
  const dsh = join(root, 'fake-dsh')
  // 假 dsh：记一笔「我被启动了」，然后 exec 成长寿进程，PID 不变——和真 dsh 被 exec 时一样。
  writeFileSync(dsh, `#!/bin/bash\necho "$$ $*" >> ${JSON.stringify(log)}\necho ready\nexec sleep 30\n`, { mode: 0o755 })
  const env = { ...process.env, HOME: root, DSH_X_WSL_STATE_DIR: join(root, 'state') }
  const runDir = join(root, 'state', 'run')
  const children = []
  const run = (...args) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 15000 })
  const startBg = (id, profile, home = '') => {
    const child = spawn('bash', [script, 'start', id, profile, home, '', '0', dsh], { env, stdio: 'ignore' })
    children.push(child)
    return child
  }
  const cleanup = () => {
    for (const child of children) { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
    rmSync(root, { recursive: true, force: true })
  }
  return { root, script, log, dsh, env, runDir, run, startBg, cleanup, children }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function waitFor(check, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

async function deadPid() {
  const child = spawn('bash', ['-c', 'exit 0'])
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid
}

test('停止先于启动到达：start 看到停止标记就不再 exec dsh，WSL 里不留孤儿', { skip }, () => {
  const box = sandbox()
  try {
    assert.equal(box.run('stop', 'aaa', '').status, 0)
    assert.ok(existsSync(join(box.runDir, 'aaa.stop')), '没读到 pidfile 时要留下停止标记')
    const started = box.run('start', 'aaa', 'web', '', '', '0', box.dsh)
    assert.equal(started.status, 0)
    assert.match(started.stderr, /已收到停止请求/)
    assert.equal(existsSync(box.log), false, 'dsh 不该被启动')
    assert.deepEqual(readdirSync(box.runDir), [], 'pidfile / meta / 标记都清掉')
  } finally {
    box.cleanup()
  }
})

test('启动后马上停止：pidfile 在 exec 前已写好，stop 精确杀掉 dsh 本体', { skip }, async () => {
  const box = sandbox()
  try {
    const child = box.startBg('bbb', 'web')
    assert.ok(await waitFor(() => existsSync(box.log)), 'dsh 应该起来')
    const pid = Number(readFileSync(join(box.runDir, 'bbb.pid'), 'utf8'))
    assert.equal(pid, child.pid, 'pidfile 里就是 exec 之后的 dsh')
    const meta = readFileSync(join(box.runDir, 'bbb.meta'), 'utf8')
    assert.match(meta, /^profile=web$/m)
    assert.match(meta, /^start=.+$/m, '记下启动时刻，防 PID 复用误杀')
    assert.equal(box.run('stop', 'bbb', '').status, 0)
    assert.ok(await waitFor(() => !alive(pid)), 'dsh 要被停掉')
    assert.deepEqual(readdirSync(box.runDir), [])
  } finally {
    box.cleanup()
  }
})

test('reap：同 Profile + DSH_HOME 的遗留 dsh 被停掉；保留名单、别的 Profile、别的 DSH_HOME 不碰', { skip }, async () => {
  const box = sandbox()
  try {
    const orphan = box.startBg('0rphan', 'web')
    const kept = box.startBg('cafe01', 'web')
    const other = box.startBg('beef02', 'acp')
    const otherHome = box.startBg('dead03', 'web', join(box.root, 'other-home'))
    assert.ok(await waitFor(() => ['0rphan', 'cafe01', 'beef02', 'dead03'].every((id) => existsSync(join(box.runDir, `${id}.pid`)))))
    // 等四个都真正 exec 成 dsh 再收，免得在 bash 阶段就被杀、看不出效果
    assert.ok(await waitFor(() => existsSync(box.log) && readFileSync(box.log, 'utf8').trim().split('\n').length === 4))
    const result = box.run('reap', 'web', '~/.dsh', 'cafe01')
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /遗留的 dsh/)
    assert.ok(await waitFor(() => !alive(orphan.pid)), '遗留的同 Profile dsh 要停掉')
    assert.equal(existsSync(join(box.runDir, '0rphan.pid')), false)
    assert.ok(alive(kept.pid), '启动器还管着的实例不能杀')
    assert.ok(alive(other.pid), '别的 Profile 不碰')
    assert.ok(alive(otherHome.pid), '别的 DSH_HOME 不碰')
  } finally {
    box.cleanup()
  }
})

test('启动时清掉死记录和 PID 已被复用的记录，但不杀活着的 dsh', { skip }, async () => {
  const box = sandbox()
  try {
    mkdirSync(box.runDir, { recursive: true })
    const gone = await deadPid()
    writeFileSync(join(box.runDir, 'old1.pid'), `${gone}\n`)
    writeFileSync(join(box.runDir, 'old1.meta'), 'profile=web\nhome=/x\nstart=1\n')
    // PID 还活着（就是测试进程自己），但启动时刻对不上：不是当初那个 dsh
    writeFileSync(join(box.runDir, 'old2.pid'), `${process.pid}\n`)
    writeFileSync(join(box.runDir, 'old2.meta'), `profile=web\nhome=${box.root}/.dsh\nstart=never\n`)
    const live = box.startBg('live01', 'web')
    assert.ok(await waitFor(() => existsSync(box.log)))
    const next = box.startBg('next01', 'web')
    assert.ok(await waitFor(() => readFileSync(box.log, 'utf8').trim().split('\n').length === 2))
    const left = readdirSync(box.runDir).sort()
    assert.deepEqual(left, ['live01.meta', 'live01.pid', 'next01.meta', 'next01.pid'])
    assert.ok(alive(live.pid) && alive(next.pid), 'start 只清死记录，杀不杀由启动器的 reap 决定')
    assert.ok(alive(process.pid))
  } finally {
    box.cleanup()
  }
})

test('stop 遇到 PID 被复用（启动时刻对不上）不杀那个进程', { skip }, () => {
  const box = sandbox()
  const victim = spawn('sleep', ['30'])
  try {
    mkdirSync(box.runDir, { recursive: true })
    writeFileSync(join(box.runDir, 'reuse.pid'), `${victim.pid}\n`)
    writeFileSync(join(box.runDir, 'reuse.meta'), 'profile=web\nhome=/x\nstart=never\n')
    assert.equal(box.run('stop', 'reuse', '').status, 0)
    assert.ok(alive(victim.pid))
    assert.equal(existsSync(join(box.runDir, 'reuse.pid')), false)
  } finally {
    victim.kill('SIGKILL')
    box.cleanup()
  }
})

function installBox() {
  const root = mkdtempSync(join(tmpdir(), 'dshx-wsl-install-'))
  const env = { ...process.env, HOME: root }
  const bin = join(root, '.dsh-x', 'bin')
  const lock = join(bin, '.dsh-x-wsl.sh.lock')
  const script = buildAgentInstallScript('#!/bin/bash\necho hi\n')
  return { root, env, bin, lock, script, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('安装锁：排队等锁的进程被打断时，不会删掉别人手里的锁', { skip }, async () => {
  const box = installBox()
  try {
    mkdirSync(box.lock, { recursive: true })
    // 持锁者是活着的测试进程自己
    const holder = `${process.pid}-feedface-1`
    writeFileSync(join(box.lock, 'owner'), `${holder}\n`)
    const waiter = spawn('bash', ['-c', box.script], { env: box.env, stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    waiter.kill('SIGTERM')
    await new Promise((resolve) => waiter.once('exit', resolve))
    assert.ok(existsSync(box.lock), '锁还在')
    assert.equal(readFileSync(join(box.lock, 'owner'), 'utf8').trim(), holder, '还是原来那个持锁者')
    assert.equal(existsSync(join(box.bin, 'dsh-x-wsl.sh')), false, '没拿到锁就不能写')
  } finally {
    box.cleanup()
  }
})

test('安装锁：持锁者已经死了就接管；写完只删自己的锁', { skip }, async () => {
  const box = installBox()
  try {
    mkdirSync(box.lock, { recursive: true })
    writeFileSync(join(box.lock, 'owner'), `${await deadPid()}-0-0\n`)
    const result = spawnSync('bash', ['-c', box.script], { env: box.env, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(box.bin, 'dsh-x-wsl.sh'), 'utf8'), '#!/bin/bash\necho hi\n')
    assert.equal(existsSync(box.lock), false, '自己的锁用完删掉')
    assert.deepEqual(readdirSync(box.bin).filter((name) => name.includes('.stale.') || name.includes('.tmp.')), [])
  } finally {
    box.cleanup()
  }
})

test('安装锁：几个安装同时跑都成功，结束后不留锁', { skip }, async () => {
  const box = installBox()
  try {
    const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const child = spawn('bash', ['-c', box.script], { env: box.env, stdio: 'ignore' })
      child.once('exit', (code) => resolve(code))
    }))
    assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0])
    assert.equal(existsSync(box.lock), false)
    assert.equal(readFileSync(join(box.bin, 'dsh-x-wsl.sh'), 'utf8'), '#!/bin/bash\necho hi\n')
  } finally {
    box.cleanup()
  }
})
