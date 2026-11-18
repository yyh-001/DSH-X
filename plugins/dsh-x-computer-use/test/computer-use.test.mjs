import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerDesktopClient } from '../lib/desktop.js'
import { createDshXChannel } from '../lib/channel.js'
import {
  CUA_TOOL_PARAMETERS,
  normalizeCuaToolArgs,
  probeComputerUseEligibility,
  wrapCuaToolDefinition,
} from '../lib/index.js'

test('非 DSH-X 启动或默认关闭时静默降级，不注册工具', async () => {
  const noDesktop = createComputerDesktopClient({ env: {} })
  assert.equal(noDesktop.enabled, false)
  assert.deepEqual(
    (await probeComputerUseEligibility(noDesktop)).reason,
    'no-desktop',
  )

  const disabledClient = createComputerDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async () => new Response(JSON.stringify({
      available: true,
      capabilities: ['notify', 'computer'],
      computer: { enabled: false },
    }), { status: 200 }),
  })
  assert.equal((await probeComputerUseEligibility(disabledClient)).reason, 'disabled')

  const occupiedClient = createComputerDesktopClient({
    env: { DSH_X_DESKTOP: '1', DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' },
    fetch: async () => new Response(JSON.stringify({
      available: true,
      capabilities: ['notify', 'computer'],
      computer: { enabled: true },
    }), { status: 200 }),
  })
  assert.equal((await probeComputerUseEligibility(occupiedClient, 'cua-driver-native')).reason, 'slot-occupied')
  assert.equal((await probeComputerUseEligibility(occupiedClient, undefined)).eligible, true)
})

test('createDshXChannel 双向 JSONL 往返、取消和关闭', async () => {
  const sent = []
  const client = {
    instance: '0.2.2-rc.4@web',
    async computer(payload, { signal } = {}) {
      sent.push(payload)
      if (payload.op === 'rpc' && payload.method === 'slow') {
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ ok: false, error: { code: 'NATIVE_CANCELLED', message: 'cancelled' } }), { once: true })
        })
      }
      if (payload.op === 'rpc') return { ok: true, result: { apps: ['Notepad'] } }
      return { ok: true }
    },
  }

  const channel = createDshXChannel({ client, sessionPrefix: '0.2.2-rc.4@web' })
  const lines = []
  channel.stdout.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line))
    }
  })

  channel.stdin.write(`${JSON.stringify({ id: 'req-1', method: 'listApps', params: {} })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(lines[0], { id: 'req-1', result: { apps: ['Notepad'] } })

  // 分片写入与 cancel
  channel.stdin.write('{"id":"req-2","method":"sl')
  channel.stdin.write('ow","params":{}}\n')
  await new Promise((resolve) => setTimeout(resolve, 10))
  channel.stdin.write(`${JSON.stringify({ type: 'cancel', id: 'req-2' })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(sent.some((item) => item.op === 'cancel' && item.id === 'req-2'))

  await channel.waitForClose()
  assert.ok(sent.some((item) => item.op === 'closeSession'))
})

test('normalizeCuaToolArgs 与 wrapCuaToolDefinition 兼容字符串化 params 与顶层 schema', async () => {
  assert.equal(CUA_TOOL_PARAMETERS.type, 'object')
  assert.ok(CUA_TOOL_PARAMETERS.properties.method.enum.includes('click'))
  assert.equal(CUA_TOOL_PARAMETERS.properties.params.type, 'object')

  assert.deepEqual(
    normalizeCuaToolArgs({ method: 'getApp', params: '{"selector":"Notepad"}' }),
    { method: 'getApp', params: { selector: 'Notepad' } },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({ method: 'listApps', params: '' }),
    { method: 'listApps', params: {} },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({ method: 'click', params: { appHandle: 'a1', windowId: '42', x: '100', y: '200', relative: 'true' } }),
    { method: 'click', params: { appHandle: 'a1', windowId: 42, x: 100, y: 200, relative: true } },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({ method: 'typeText', params: { appHandle: 'a1', text: '12345' } }),
    { method: 'typeText', params: { appHandle: 'a1', text: '12345' } },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({
      method: 'getAccessibilityTree',
      params: { appHandle: 'a1', options: { deliveryMode: 'foreground' }, delivery_mode: 'foreground' },
    }),
    { method: 'getState', params: { appHandle: 'a1' } },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({
      method: 'screenshot',
      params: { appHandle: 'a1', windowId: 9, pid: 1234 },
    }),
    { method: 'screenshot', params: { appHandle: 'a1', windowId: 9 } },
  )
  assert.deepEqual(
    normalizeCuaToolArgs({
      method: 'click',
      params: { appHandle: 'a1', windowId: 9, target: { x: '120', y: 45 } },
    }),
    { method: 'click', params: { appHandle: 'a1', windowId: 9, x: 120, y: 45 } },
  )

  let received = null
  const wrapped = wrapCuaToolDefinition({
    name: 'cua',
    parameters: { oneOf: [], type: 'object' },
    async execute(args) {
      received = args
      return { ok: true }
    },
  })
  assert.deepEqual(wrapped.parameters, CUA_TOOL_PARAMETERS)
  await wrapped.execute({ method: 'listApps', params: '{}' }, {})
  assert.deepEqual(received, { method: 'listApps', params: {} })
})
