import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const openSource = html.slice(html.indexOf('    async function openInstance('), html.indexOf('\n    }', html.indexOf('    async function openInstance(')) + 6)

test('服务端拒绝普通或显式打开时展示原错误，不再弹窗重试', async () => {
  const postSource = html.match(/    const post =[\s\S]*?\r?\n    \}\)\r?\n/)[0]
  for (const presentation of [undefined, 'window']) {
    const errors = [], browser = [], requests = []
    const message = '当前平台暂不支持已有页面跨窗迁移，请先关闭此标签后重新打开'
    const context = vm.createContext({
      fetch: async (...args) => { requests.push(args); return { ok: false, status: 400, json: async () => ({ error: message }) } },
      apiScopeHeaders: () => ({}), notifyError: error => errors.push(error), window: { open: (...args) => browser.push(args) },
    })
    vm.runInContext(postSource + '\n' + openSource, context)
    await vm.runInContext(`openInstance("http://127.0.0.1:1234/", ${JSON.stringify(presentation)})`, context)
    assert.equal(requests.length, 1)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, message)
    assert.equal(browser.length, 0)
  }
})

test('仅网络失败的普通打开保留浏览器回退，显式打开仍展示错误', async () => {
  const calls = [], errors = [], browser = []
  const failure = TypeError('Failed to fetch')
  const context = vm.createContext({
    post: async (...args) => { calls.push(args); throw failure },
    notifyError: (error) => errors.push(error), window: { open: (...args) => browser.push(args) },
  })
  vm.runInContext(openSource, context)
  await vm.runInContext('openInstance("http://127.0.0.1:1234/", "window")', context)
  assert.equal(calls[0][1].presentation, 'window')
  assert.deepEqual(errors, [failure])
  assert.equal(browser.length, 0)
  await vm.runInContext('openInstance("http://127.0.0.1:1234/")', context)
  assert.equal(Object.hasOwn(calls[1][1], 'presentation'), false)
  assert.equal(browser.length, 1)
})

test('SSE 替换实例快照后开窗入口仍存在；旧外壳隐藏，停止与忙碌时禁用', () => {
  const declaration = html.match(/let instanceWindowsAvailable = false/)[0]
  const assignment = html.match(/instanceWindowsAvailable = data\.instanceWindows === true/)[0]
  const template = html.split('\n').find((line) => line.trim().startsWith('${instanceWindowsAvailable ?')).trim()
  const context = vm.createContext({
    state: {}, data: { instanceWindows: true }, entry: { id: 'test' }, name: '工作',
    live: { status: 'running', url: 'http://127.0.0.1:1234/' }, action: '', ownAction: '', busy: false,
    escapeHtml: (text) => text, t: (text) => text,
  })
  vm.runInContext(`${declaration}; ${assignment}; state = { instances: [] }`, context)
  const render = () => vm.runInContext('`' + template + '`', context)
  assert.match(render(), /data-window-id="test"/)
  assert.doesNotMatch(render(), / disabled/)
  context.live.status = 'stopped'
  assert.match(render(), / disabled/)
  context.live.status = 'running'
  context.busy = true
  assert.match(render(), / disabled/)
  context.data = {}
  vm.runInContext(assignment, context)
  assert.equal(render(), '')
})
