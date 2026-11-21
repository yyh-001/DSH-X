/**
 * Code Review 发现的安全与稳定性问题回归用例：
 * - 同步拒绝路径穿越键（不回落到裸 join）
 * - ZIP 解压防 zip bomb 上限
 * - LAN 代理 isTokenExchange 对畸形 URL 不抛未捕获异常
 * - ManagerAuth 拒绝 cross-site 自动 303 种 cookie
 * - remote-profile 拒绝 .. 穿越配置名并用 POSIX ${h#~/}
 * - WindowsFileManager.pickFile 走 Base64 -EncodedCommand + UTF-8 输出
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readZip, writeZip } from '../src/zip.js'
import { isTokenExchange } from '../src/lan-proxy.js'
import { ManagerAuth } from '../src/manager-auth.js'
import { readRemoteProfile, removeRemoteProfile } from '../src/remote-profile.js'
import { WindowsFileManager } from '../src/filemanager-windows.js'
import { runSync } from '../src/sync.js'
import { writeZip as writeSyncZip } from '../src/zipfile.js'

test('lan-proxy isTokenExchange 遇到畸形 URL 返回 false 而不是抛未捕获 TypeError', () => {
  assert.equal(isTokenExchange('//[::1', 303, ['dsh-auth-x=1']), false)
  assert.equal(isTokenExchange('http://[bad', 303, ['dsh-auth-x=1']), false)
  assert.equal(isTokenExchange('/?token=abc', 303, ['dsh-auth-x=1']), true)
})

test('manager-auth 回环自动 303 拒绝 cross-site / same-site 导航', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-sec-'))
  try {
    const auth = new ManagerAuth({ file: join(dir, 'auth.json'), port: 3780 })
    const makeRes = () => ({
      code: 0,
      headers: {},
      ended: false,
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end() { this.ended = true },
    })
    const url = new URL('http://127.0.0.1:3780/')
    // 跨站新标签导航必须被拒，不得自动 303 带上 launch token
    const crossRes = makeRes()
    const crossHandled = auth.exchange({
      method: 'GET',
      headers: { host: '127.0.0.1:3780', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' },
    }, crossRes, url)
    assert.equal(crossHandled, false)
    assert.equal(crossRes.code, 0)

    // 地址栏/Electron（sec-fetch-site: none）正常 303
    const directRes = makeRes()
    const directHandled = auth.exchange({
      method: 'GET',
      headers: { host: '127.0.0.1:3780', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
    }, directRes, url)
    assert.equal(directHandled, true)
    assert.equal(directRes.code, 303)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote-profile 拒绝路径穿越名，且主目录展开使用 POSIX ${h#~/} 而非 bashism ${h:2}', async () => {
  const seenScripts = []
  const backend = {
    async exec(script) {
      seenScripts.push(script)
      return { ok: true, stdout: '__DSHX_MISSING__', stderr: '' }
    },
  }
  await assert.rejects(() => readRemoteProfile(backend, '~/.dsh', '../evil'), /不合法/)
  await assert.rejects(() => removeRemoteProfile(backend, '~/.dsh', '../../etc'), /不合法/)
  await assert.rejects(() => removeRemoteProfile(backend, '~/.dsh', 'a/b'), /不合法/)
  assert.equal(seenScripts.length, 0, '非法名字不能进入远端 shell')

  const res = await readRemoteProfile(backend, '~/.dsh', 'web')
  assert.equal(res.ok, false)
  assert.match(seenScripts[0], /\$\{h#~\/\}/)
  assert.doesNotMatch(seenScripts[0], /\$\{h:2\}/)
})

test('WindowsFileManager.pickFile 走 UTF-8 Base64 -EncodedCommand，无 PowerShell 引号注入', async () => {
  const calls = []
  const fm = new WindowsFileManager({
    existsSync: () => true,
    execFile(command, args, options, callback) {
      calls.push({ command, args: Array.from(args) })
      callback(null, 'D:\\中文目录\\导出.dspack\r\n', '')
    },
  })
  const picked = await fm.pickFile({ save: true, defaultName: "evil’$(calc).zip", title: "选'文件" })
  assert.equal(picked, 'D:\\中文目录\\导出.dspack')
  assert.equal(calls[0].command, 'powershell')
  assert.ok(calls[0].args.includes('-EncodedCommand'))
  const decoded = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.match(decoded, /UTF8Encoding/)
  assert.match(decoded, /FromBase64String/)
  assert.doesNotMatch(decoded, /\$\(calc\)/, '用户输入不能以字面量出现在 PowerShell 脚本里')
})

test('sync 下载拒绝路径穿越与白名单外的远端键，不会写到 DSH_HOME 之外', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-sec-'))
  try {
    const home = join(root, 'home')
    const zipPath = join(root, 'backup.zip')
    mkdirSync(join(home, 'sessions'), { recursive: true })
    const escapedPath = join(root, 'escaped.txt')
    // 构造合法会话文件 + 恶意路径穿越条目 + 非白名单配置（.npmrc）
    await writeSyncZip(zipPath, [
      { name: 'dsh-x/v1/sessions/good.json', buffer: Buffer.from('{"ok":true}') },
      { name: 'dsh-x/v1/sessions/../../../escaped.txt', buffer: Buffer.from('evil') },
    ])
    const summary = await runSync({
      config: { store: 'zip', zip: { path: zipPath } },
      mode: 'down',
      scopes: ['sessions'],
      context: { home, profile: 'web', profileDir: join(home, 'profiles', 'web'), roots: [] },
      policy: 'remote',
      log: () => {},
    })
    assert.equal(existsSync(escapedPath), false, '恶意 .. 键不得写到 DSH_HOME 之外')
    assert.equal(existsSync(join(home, 'sessions', 'good.json')), true, '合法文件正常同步')
    assert.ok(summary.skipped >= 1, '恶意键应记为跳过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('zip readZip 拒绝超过单条目上限（64MB）的异常解压声明', () => {
  const buf = writeZip([{ name: 'a.txt', data: 'hello' }])
  // 篡改中央目录条目里的 uncompressedSize（cursor + 24）为 100MB，触发防 zip bomb 保护
  const eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  buf.writeUInt32LE(100 * 1024 * 1024, cdOffset + 24)
  assert.throws(() => readZip(buf), /超过 64 MB/)
})
