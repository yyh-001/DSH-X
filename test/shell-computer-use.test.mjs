/**
 * 外壳 Computer Use 控制器（shell/computer-use.mjs）单测：
 * 用注入的假 CuaDriver 覆盖协议映射、应用识别、快照失效、急停（1 秒内中断在途操作）、
 * 审计脱敏（不落输入正文）和分层依赖边界。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createComputerUseHost, mapDriverFailure, summarizeAuditDetail } from '../shell/computer-use.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

function makeFakeDriver(overrides = {}) {
  const calls = []
  let shutdownCount = 0
  let destroyCount = 0
  const driver = {
    async callTool(name, argsJson, opts) {
      const args = JSON.parse(argsJson || '{}')
      calls.push({ name, args })
      if (overrides.onCall) {
        const res = overrides.onCall(name, args, opts)
        if (res !== undefined) return res
      }
      switch (name) {
        case 'check_permissions':
          return { rawJson: JSON.stringify({ content: [], structuredContent: { elevated: false, uia: true, post_message: true } }) }
        case 'health_report':
          return { rawJson: JSON.stringify({ content: [], structuredContent: { checks: [{ name: 'screen_capture_capability', status: 'pass' }] } }) }
        case 'list_apps':
          return {
            rawJson: JSON.stringify({
              content: [],
              structuredContent: {
                apps: [
                  { name: 'Notepad', pid: 4321, running: true, launch_path: 'C:\\Windows\\notepad.exe' },
                  { name: 'Calculator', pid: 0, running: false, bundle_id: 'Microsoft.WindowsCalculator!App' },
                ],
                processes: [],
              },
            }),
          }
        case 'list_windows':
          return {
            rawJson: JSON.stringify({
              content: [],
              structuredContent: {
                windows: [{ window_id: 1001, app_name: 'Notepad', title: 'Untitled - Notepad', bounds: { x: 10, y: 20, width: 800, height: 600 }, is_on_screen: true }],
              },
            }),
          }
        case 'get_window_state':
          if (args.include_screenshot) {
            return {
              rawJson: JSON.stringify({
                content: [{ type: 'image', data: 'iVBORw0KGgo=' }],
                structuredContent: {
                  screenshot_width: 800,
                  screenshot_height: 600,
                  window_bounds: { x: 10, y: 20, width: 800, height: 600 },
                },
              }),
            }
          }
          return {
            rawJson: JSON.stringify({
              content: [],
              structuredContent: {
                snapshot_id: 's00000001',
                tree_markdown: '[1] Window "Untitled - Notepad"\n  [2] Button "Save"',
                truncated: false,
              },
            }),
          }
        default:
          return { rawJson: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok' } }) }
      }
    },
    async shutdown() { shutdownCount += 1 },
    uniffiDestroy() { destroyCount += 1 },
  }
  return {
    calls,
    counts: () => ({ shutdownCount, destroyCount }),
    loadDriver: async () => ({ CuaDriver: { create: () => driver } }),
  }
}

test('默认关闭：未启用时拒绝 RPC，也不加载原生驱动', async () => {
  let loaded = 0
  const host = createComputerUseHost({
    platform: 'win32',
    loadDriver: async () => { loaded += 1; return {} },
  })
  assert.equal(host.status().enabled, false)
  const res = await host.rpc({ sessionId: 's1', id: '1', method: 'listApps', params: {} })
  assert.equal(res.error.code, 'COMPUTER_USE_DISABLED')
  assert.equal(loaded, 0)
})

test('完整协议流：应用识别、权限检查、树、截图、元素点击与相对坐标滚动', async () => {
  const fake = makeFakeDriver()
  const host = createComputerUseHost({
    platform: 'win32',
    pid: 9999,
    execPath: 'C:\\DSH\\DSH.exe',
    loadDriver: fake.loadDriver,
    getFileIcon: async () => 'data:image/png;base64,AA==',
  })
  host.setEnabled(true)

  const perm = await host.rpc({ sessionId: 's1', id: '1', method: 'permissionStatus', params: {} })
  assert.equal(perm.result.platform, 'win32')
  assert.equal(perm.result.captureAvailable, true)
  assert.equal(perm.result.elevated, false)
  assert.equal(perm.result.helper.pid, 9999)

  const missing = await host.rpc({ sessionId: 's1', id: '2', method: 'getApp', params: { selector: 'NoSuchApp' } })
  assert.equal(missing.error.code, 'APP_NOT_FOUND')

  const selected = await host.rpc({ sessionId: 's1', id: '3', method: 'getApp', params: { selector: 'Notepad' } })
  assert.equal(selected.result.name, 'Notepad')
  assert.equal(selected.result.running, true)
  assert.match(selected.result.authorization.id, /^[a-f0-9]{64}$/)
  assert.equal(selected.result.applicationIcon, 'data:image/png;base64,AA==')
  const appHandle = selected.result.appHandle

  const state = await host.rpc({ sessionId: 's1', id: '4', method: 'getState', params: { appHandle } })
  assert.equal(state.result.windowId, 1001)
  assert.match(state.result.tree, /\[2\] Button "Save"/)

  const invoked = await host.rpc({
    sessionId: 's1',
    id: '5',
    method: 'invoke',
    params: { appHandle, windowId: 1001, snapshotId: state.result.snapshotId, elementId: '2' },
  })
  assert.equal(invoked.result.dispatched, true)
  assert.equal(fake.calls.at(-1).args.element_token, 's00000001:2')

  const stale = await host.rpc({
    sessionId: 's1',
    id: '6',
    method: 'invoke',
    params: { appHandle, windowId: 1001, snapshotId: 'stale-id', elementId: '2' },
  })
  assert.equal(stale.error.code, 'STALE_SNAPSHOT')

  const shot = await host.rpc({ sessionId: 's1', id: '7', method: 'screenshot', params: { appHandle, windowId: 1001 } })
  assert.equal(shot.result.mimeType, 'image/png')
  assert.equal(shot.result.data, 'iVBORw0KGgo=')
  assert.equal(shot.result.pixelWidth, 800)

  await host.rpc({
    sessionId: 's1',
    id: '8',
    method: 'scroll',
    params: { appHandle, windowId: 1001, relative: true, x: 500, y: 250, deltaLinesX: 0, deltaLinesY: -3 },
  })
  assert.equal(fake.calls.at(-1).name, 'scroll')
  assert.equal(fake.calls.at(-1).args.x, 400)
  assert.equal(fake.calls.at(-1).args.y, 150)
  assert.equal(fake.calls.at(-1).args.direction, 'down')
  assert.equal(fake.calls.at(-1).args.amount, 3)
})

test('审计脱敏：输入文本、粘贴与按键正文绝不进入审计日志', async () => {
  const fake = makeFakeDriver()
  const host = createComputerUseHost({ platform: 'win32', loadDriver: fake.loadDriver })
  host.setEnabled(true)
  const app = await host.rpc({ sessionId: 's1', id: '1', method: 'getApp', params: { selector: 'Notepad' } })
  const appHandle = app.result.appHandle

  await host.rpc({ sessionId: 's1', id: '2', method: 'typeText', params: { appHandle, text: 'SUPER_SECRET_PASSWORD_123' } })
  await host.rpc({ sessionId: 's1', id: '3', method: 'paste', params: { appHandle, text: 'TOKEN_XYZ_999', format: 'text' } })
  await host.rpc({ sessionId: 's1', id: '4', method: 'pressKey', params: { appHandle, key: 'p' } })

  const serialized = JSON.stringify(host.auditLog())
  assert.equal(serialized.includes('SUPER_SECRET_PASSWORD_123'), false)
  assert.equal(serialized.includes('TOKEN_XYZ_999'), false)
  assert.match(serialized, /len=25/)
  assert.match(serialized, /len=13/)
})

test('急停开关：1 秒内中止在途操作、销毁旧句柄并拒绝后续请求，直到显式恢复', async () => {
  let aborted = false
  const fake = makeFakeDriver({
    onCall: (name, _args, opts) => {
      if (name === 'list_apps') {
        return { rawJson: JSON.stringify({ content: [], structuredContent: { apps: [{ name: 'Notepad', pid: 4321, running: true }], processes: [] } }) }
      }
      if (name === 'click') {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          }, { once: true })
        })
      }
      return { rawJson: JSON.stringify({ content: [], structuredContent: {} }) }
    },
  })
  const host = createComputerUseHost({ platform: 'win32', loadDriver: fake.loadDriver })
  host.setEnabled(true)
  const app = await host.rpc({ sessionId: 's1', id: '1', method: 'getApp', params: { selector: 'Notepad' } })
  const appHandle = app.result.appHandle

  const startedAt = Date.now()
  const inflight = host.rpc({ sessionId: 's1', id: '2', method: 'click', params: { appHandle, windowId: 1, x: 10, y: 10 } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(host.status().running, true)

  await host.stop('shortcut')
  const settled = await inflight
  assert.ok(Date.now() - startedAt < 1000, '急停必须在 1 秒内中断在途操作')
  assert.equal(aborted, true)
  assert.ok(settled.error)
  assert.equal(host.status().halted, true)
  assert.equal(fake.counts().shutdownCount, 1)
  assert.equal(fake.counts().destroyCount, 1)

  const blocked = await host.rpc({ sessionId: 's1', id: '3', method: 'listApps', params: {} })
  assert.equal(blocked.error.code, 'COMPUTER_USE_STOPPED')

  host.resume()
  assert.equal(host.status().halted, false)
  // 急停前颁发的旧 appHandle 必须失效
  const oldHandle = await host.rpc({ sessionId: 's1', id: '4', method: 'listWindows', params: { appHandle } })
  assert.equal(oldHandle.error.code, 'APP_ACCESS_REQUIRED')
})

test('驱动失败码映射与分层依赖检查', () => {
  assert.equal(mapDriverFailure({ structuredContent: { refusal: { code: 'background_unavailable', message: 'no' } } }).code, 'FOREGROUND_REQUIRED')
  assert.equal(mapDriverFailure({ content: [{ type: 'text', text: 'Access is denied (0x80070005)' }] }).code, 'ELEVATED_WINDOW_BLOCKED')
  assert.equal(mapDriverFailure({ content: [{ type: 'text', text: 'Workstation is locked' }] }).code, 'SESSION_LOCKED')
  assert.equal(summarizeAuditDetail('typeText', { text: 'abcde' }), 'len=5')

  const src = read('shell/computer-use.mjs').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(src, /from '\.\.\//, '外壳模块不能反向 import 核心 src/')
  assert.doesNotMatch(src, /from 'electron'/, 'computer-use 控制层不能顶层依赖 electron，以便纯 Node 单测')
})

test('closeSession 按实例前缀清理子会话句柄，不影响其他实例', async () => {
  const fake = makeFakeDriver()
  const host = createComputerUseHost({ platform: 'win32', loadDriver: fake.loadDriver })
  host.setEnabled(true)

  const appA = await host.rpc({ sessionId: '0.2.2-rc.4@web:uuid-1', id: '1', method: 'getApp', params: { selector: 'Notepad' } })
  const appB = await host.rpc({ sessionId: '0.2.2-rc.4@other:uuid-2', id: '2', method: 'getApp', params: { selector: 'Notepad' } })
  assert.ok(appA.result.appHandle)
  assert.ok(appB.result.appHandle)

  host.closeSession('0.2.2-rc.4@web')
  const afterA = await host.rpc({ sessionId: '0.2.2-rc.4@web:uuid-1', id: '3', method: 'listWindows', params: { appHandle: appA.result.appHandle } })
  const afterB = await host.rpc({ sessionId: '0.2.2-rc.4@other:uuid-2', id: '4', method: 'listWindows', params: { appHandle: appB.result.appHandle } })
  assert.equal(afterA.error.code, 'APP_ACCESS_REQUIRED')
  assert.ok(Array.isArray(afterB.result))
  assert.equal(afterB.result.length, 1)
})

test('screenshot 注册可落点捕获且遇到 background_unavailable 自动升级 foreground', async () => {
  const attempts = []
  const fake = makeFakeDriver({
    onCall: (name, args) => {
      if (name === 'press_key') {
        attempts.push(args.delivery_mode || 'background')
        if (args.delivery_mode !== 'foreground') {
          return {
            rawJson: JSON.stringify({
              isError: true,
              content: [{ type: 'text', text: 'Chromium drops background input' }],
              structuredContent: { refusal: { code: 'background_unavailable', message: 'retry with foreground' } },
            }),
          }
        }
      }
      return undefined
    },
  })
  const host = createComputerUseHost({ platform: 'win32', loadDriver: fake.loadDriver })
  host.setEnabled(true)
  const app = await host.rpc({ sessionId: 's1', id: '1', method: 'getApp', params: { selector: 'Notepad' } })
  const appHandle = app.result.appHandle

  await host.rpc({ sessionId: 's1', id: '2', method: 'screenshot', params: { appHandle, windowId: 1001 } })
  const shotCall = fake.calls.findLast((item) => item.name === 'get_window_state')
  assert.notEqual(shotCall.args.display_only, true)

  const keyRes = await host.rpc({
    sessionId: 's1',
    id: '3',
    method: 'pressKey',
    params: { appHandle, windowId: 1001, key: 'l', modifiers: ['control'] },
  })
  assert.equal(keyRes.result.dispatched, true)
  assert.deepEqual(attempts, ['background', 'foreground'])
})
