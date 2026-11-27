import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allowedUrl, apply, isLoopbackRequest, openerCommand, resolveTarget } from '../lib/index.js'

test('外链：只放行 http/https', () => {
  assert.equal(allowedUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(allowedUrl('  http://127.0.0.1:3780/x  '), 'http://127.0.0.1:3780/x')
  assert.equal(allowedUrl('javascript:alert(1)'), '')
  assert.equal(allowedUrl('file:///C:/Windows/System32/calc.exe'), '')
  assert.equal(allowedUrl('data:text/html,<script>'), '')
  assert.equal(allowedUrl(''), '')
  assert.equal(allowedUrl('not a url'), '')
  assert.equal(allowedUrl(undefined), '')
  assert.equal(allowedUrl(123), '')
  assert.equal(allowedUrl(`https://example.com/${'a'.repeat(4096)}`), '')
})

test('路径：只认存在的绝对路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xcm-'))
  try {
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'x')
    assert.deepEqual(resolveTarget(dir), { path: dir, kind: 'directory' })
    assert.deepEqual(resolveTarget(file), { path: file, kind: 'file' })
    assert.equal(resolveTarget(join(dir, 'missing')), null)
    assert.equal(resolveTarget('relative/path'), null)
    assert.equal(resolveTarget(''), null)
    assert.equal(resolveTarget(null), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('打开命令：三个平台各自的写法', () => {
  assert.deepEqual(
    openerCommand('url', { url: 'https://example.com' }, 'win32'),
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://example.com'], fireAndForget: true },
  )
  assert.deepEqual(
    openerCommand('reveal', { path: 'C:\\work', kind: 'directory' }, 'win32'),
    { command: 'explorer.exe', args: ['C:\\work'], fireAndForget: true },
  )
  assert.deepEqual(
    openerCommand('reveal', { path: 'C:\\work\\a.txt', kind: 'file' }, 'win32'),
    { command: 'explorer.exe', args: ['/select,C:\\work\\a.txt'], fireAndForget: true },
  )
  assert.deepEqual(
    openerCommand('reveal', { path: '/tmp/x', kind: 'directory' }, 'darwin'),
    { command: 'open', args: ['-R', '/tmp/x'], fireAndForget: false },
  )
  assert.deepEqual(
    openerCommand('url', { url: 'https://example.com' }, 'linux'),
    { command: 'xdg-open', args: ['https://example.com'], fireAndForget: false },
  )
  assert.equal(openerCommand('url', {}, 'win32'), null)
  assert.equal(openerCommand('reveal', {}, 'linux'), null)
})

test('路由只认环回', () => {
  const request = (address, host) => ({ socket: { remoteAddress: address }, headers: { host } })
  assert.equal(isLoopbackRequest(request('127.0.0.1', '127.0.0.1:3780')), true)
  assert.equal(isLoopbackRequest(request('::1', 'localhost:3780')), true)
  assert.equal(isLoopbackRequest(request('::ffff:127.0.0.1', '[::1]:3780')), true)
  assert.equal(isLoopbackRequest(request('192.168.1.9', '127.0.0.1:3780')), false)
  assert.equal(isLoopbackRequest(request('127.0.0.1', 'evil.example.com')), false)
  assert.equal(isLoopbackRequest({}), false)
  // 局域网代理从回环连进来、Host 也是回环，只有 X-Forwarded-For 认得出来
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3780', 'x-forwarded-for': '192.168.1.9' } }), false)
})

test('UNC 路径不解析（不去连那台机器）', () => {
  assert.equal(resolveTarget('\\\\evil.example\\share\\x'), null)
  assert.equal(resolveTarget('//evil.example/share/x'), null)
})

// ---- 路由层：有外壳走 Electron 桥，没外壳退回本机 ----

/** 只实现本插件用到的 cordis 面：effect / get / webServer.register。 */
function fakeContext({ bridge = null, rejection = undefined } = {}) {
  const routes = new Map()
  return {
    routes,
    connection: { requestRejection: () => rejection },
    effect(run) {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
    get(name) {
      if (name === 'dshDesktop') return bridge
      return null
    },
  }
}

/** 调一条已注册的路由，返回 { status, payload }。 */
function callRoute(ctx, path, body, { address = '127.0.0.1', host = '127.0.0.1:3981', method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    const handler = ctx.routes.get(path)
    assert.ok(handler, `路由没注册：${path}`)
    const req = new EventEmitter()
    req.method = method
    req.socket = { remoteAddress: address }
    req.headers = { host, ...headers }
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        let payload = null
        try {
          payload = JSON.parse(Buffer.from(chunk).toString('utf8'))
        } catch {
          payload = null
        }
        resolve({ status: this.status, payload })
      },
    }
    handler(req, res)
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 1)
  })
}

test('有外壳：reveal 走 dshDesktop，不自己拉窗口', async () => {
  const seen = []
  const ctx = fakeContext({ bridge: { reveal: async (path) => { seen.push(path); return { ok: true, shown: true } } } })
  apply(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'xcm-bridge-'))
  try {
    const result = await callRoute(ctx, '/api/x-context-menu/reveal', { path: dir })
    assert.equal(result.status, 200)
    assert.equal(result.payload.via, 'desktop')
    assert.deepEqual(seen, [dir])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('外壳说没有桌面能力：退回本机启动（试运行）', async (t) => {
  const before = process.env.DSH_X_CONTEXT_MENU_DRY_RUN
  process.env.DSH_X_CONTEXT_MENU_DRY_RUN = '1'
  t.after(() => {
    if (before === undefined) delete process.env.DSH_X_CONTEXT_MENU_DRY_RUN
    else process.env.DSH_X_CONTEXT_MENU_DRY_RUN = before
  })
  const ctx = fakeContext({ bridge: { reveal: async () => ({ ok: false, reason: 'no-desktop' }) } })
  apply(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'xcm-fallback-'))
  try {
    const result = await callRoute(ctx, '/api/x-context-menu/reveal', { path: dir })
    assert.equal(result.status, 200)
    assert.equal(result.payload.via, undefined)
    assert.equal(result.payload.dryRun, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('外壳抛错：不把异常冒给页面，退回本机（试运行）', async (t) => {
  const before = process.env.DSH_X_CONTEXT_MENU_DRY_RUN
  process.env.DSH_X_CONTEXT_MENU_DRY_RUN = '1'
  t.after(() => {
    if (before === undefined) delete process.env.DSH_X_CONTEXT_MENU_DRY_RUN
    else process.env.DSH_X_CONTEXT_MENU_DRY_RUN = before
  })
  const ctx = fakeContext({ bridge: { open: async () => { throw new Error('bridge down') } } })
  apply(ctx)
  const result = await callRoute(ctx, '/api/x-context-menu/open-url', { url: 'https://example.com' })
  assert.equal(result.status, 200)
  assert.equal(result.payload.dryRun, true)
})

test('路由级环回判定：外网来源 403', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'xcm-lan-'))
  try {
    const result = await callRoute(ctx, '/api/x-context-menu/reveal', { path: dir }, { address: '192.168.1.9', host: '127.0.0.1:3981' })
    assert.equal(result.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路由要过 dsh 的连接鉴权：没登录 / 跨站 / 局域网代理 / 非 POST 都进不来', async () => {
  const body = { url: 'https://example.com/' }
  const path = '/api/x-context-menu/open-url'

  const unauthenticated = fakeContext({ rejection: 401 })
  apply(unauthenticated)
  assert.equal((await callRoute(unauthenticated, path, body)).status, 401)

  const crossSite = fakeContext({ rejection: 403 })
  apply(crossSite)
  assert.equal((await callRoute(crossSite, path, body)).status, 403)

  const ctx = fakeContext({ bridge: { open: async () => ({ ok: true }) } })
  apply(ctx)
  assert.equal((await callRoute(ctx, path, body, { headers: { 'x-forwarded-for': '192.168.1.9' } })).status, 403)
  assert.equal((await callRoute(ctx, path, body, { method: 'GET' })).status, 405)
  assert.equal((await callRoute(ctx, path, body)).status, 200)
})
