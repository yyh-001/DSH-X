// dsh-x-memory 的路由守卫：环回 + dsh 连接鉴权 + 写路由只收 POST。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inject, isLoopbackRequest } from '../lib/index.js'

const source = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('局域网代理转来的请求不算环回', () => {
  const request = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:9716', ...headers } })
  assert.equal(isLoopbackRequest(request({})), true)
  assert.equal(isLoopbackRequest(request({ 'x-forwarded-for': '192.168.1.9' })), false)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.9' }, headers: { host: '127.0.0.1:9716' } }), false)
})

// apply() 要 import @deepseek-ai/dsh-tools，仓库里没装，所以守卫的接线按源码查。
test('每条路由都先过 connection.requestRejection，写路由只收 POST', () => {
  assert.ok(inject.includes('connection'))
  assert.match(source, /ctx\.connection\.requestRejection\(req\)/)
  assert.match(source, /WRITE_ROUTES\.has\(route\.path\) && req\.method !== 'POST'/)
  for (const name of ['config', 'save', 'update', 'delete']) {
    assert.match(source, new RegExp(`WRITE_ROUTES = new Set\\(\\[[^\\]]*'/api/x-memory/${name}'`))
  }
})
