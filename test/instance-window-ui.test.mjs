import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const openSource = html.slice(html.indexOf('    async function openInstance('), html.indexOf('\n    }', html.indexOf('    async function openInstance(')) + 6)

test('显式窗口失败展示错误，普通打开失败仍按原来的浏览器回退', async () => {
  const calls = [], errors = [], browser = []
  const failure = Error('迁移失败')
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
