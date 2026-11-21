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
      // post 会把服务端报错过一遍词典 t()；这里只验错误原样透出，给个原样返回的 t
      t: (text) => text,
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

test('启动项卡片不再附带「更多打开方式」下拉菜单，打开方式统一放在设置 → 常规的 #openMode 中', () => {
  assert.doesNotMatch(html, /launch-open-toggle|launch-open-menu|data-window-id|data-open-menu/)
  assert.match(html, /打开 dsh 的方式[\s\S]{0,400}?<select id="openMode"><\/select>/)
})
