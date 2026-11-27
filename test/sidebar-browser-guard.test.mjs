// 右侧栏浏览器不能开到管理页：管理页没有鉴权，guest 里的同源脚本能装插件、起 MCP 进程。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isManagerUrl, normalizeUrl } from '../plugins/dsh-x-sidebar-browser/index.js'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const env = { DSH_X_MANAGER_URL: 'http://127.0.0.1:3780' }

test('插件：管理页端口上的本机地址一律拒绝，别的本机端口照常', () => {
  for (const url of ['http://127.0.0.1:3780/', 'http://localhost:3780/api/state', 'http://[::1]:3780/', 'http://0.0.0.0:3780/', 'http://x.localhost:3780/']) {
    assert.equal(isManagerUrl(url, env), true, url)
    assert.throws(() => normalizeUrl(url, env), /management page/)
  }
  assert.throws(() => normalizeUrl('127.0.0.1:3780', { DSH_X_MANAGER_URL: 'https://127.0.0.1:3780' }), /management page/)
  assert.equal(normalizeUrl('http://localhost:5173/', env), 'http://localhost:5173/')
  assert.equal(normalizeUrl('example.com', env), 'https://example.com')
  assert.equal(normalizeUrl('http://127.0.0.1:3780/', {}), 'http://127.0.0.1:3780/', '不在 DSH-X 里跑时没有管理页')
  assert.throws(() => normalizeUrl('file:///etc/passwd', env), /only http/)
})

test('外壳：guest 的禁区里有管理页 origin', () => {
  assert.match(read('shell/main.mjs'), /for \(const url of \[managerBase, \.\.\.state\.instances/)
})

test('管理页响应不许被嵌进 iframe', () => {
  assert.match(read('src/server.js'), /'x-frame-options': 'DENY'/)
})
