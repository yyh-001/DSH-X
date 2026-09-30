import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

function setup() {
  const pending = new Map()
  let next = 0
  let renders = 0
  let content = ''
  const node = { scrollHeight: 2000, clientHeight: 200, scrollTop: 1800,
    get textContent() { return content },
    set textContent(value) { content = value; renders += 1 },
  }
  const context = { window: {}, setTimeout: (fn) => { pending.set(++next, fn); return next }, clearTimeout: (id) => pending.delete(id) }
  vm.runInNewContext(readFileSync(new URL('../public/log-view.js', import.meta.url), 'utf8'), context)
  return { node, pending, renders: () => renders, view: context.window.createLogView(node),
    flush: () => { for (const [id, fn] of pending) { pending.delete(id); fn() } },
  }
}

test('日志爆发时只刷新一次，并限制最近行数与单行长度', () => {
  const box = setup()
  for (let i = 0; i < 700; i += 1) box.view.append([String(i)])
  assert.equal(box.pending.size, 1)
  assert.equal(box.renders(), 0)
  box.flush()
  assert.equal(box.renders(), 1)
  const lines = box.node.textContent.split('\n')
  assert.equal(lines.length, 400)
  assert.equal(lines[0], '300')
  assert.equal(lines.at(-1), '699')
  box.view.append(['x'.repeat(10_000)])
  box.flush()
  assert.equal(box.node.textContent.split('\n').at(-1).length, 4001)
})

test('清空同时取消待刷新内容，新日志仍能继续显示', () => {
  const box = setup()
  box.view.append(['old'])
  box.view.clear()
  box.flush()
  assert.equal(box.node.textContent, '')
  assert.equal(box.pending.size, 0)
  box.view.append(['new'])
  box.flush()
  assert.equal(box.node.textContent, 'new')
})

test('向上翻日志不跳到底部，已经在底部才自动跟随', () => {
  const box = setup()
  box.node.scrollTop = 100
  box.view.append(['one'])
  box.flush()
  assert.equal(box.node.scrollTop, 100)
  box.node.scrollTop = 1800
  box.view.append(['two'])
  box.flush()
  assert.equal(box.node.scrollTop, 2000)
})
