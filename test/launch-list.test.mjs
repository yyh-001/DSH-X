import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/launch-list.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const saveCode = html.slice(html.indexOf('    launchFormEl.onsubmit = async'), html.indexOf('    launchDeleteEl.onclick = async'))
const deleteCode = html.slice(html.indexOf('    launchDeleteEl.onclick = async'), html.indexOf('    function render()'))

function harness({ ready = true, reduced = false } = {}) {
  const calls = [], listeners = new Set()
  let observe
  const root = { dataset: { reduceMotion: String(reduced) }, classList: { contains: () => ready } }
  class Node {
    constructor(key, html = key) {
      this.dataset = key ? { launchKey: key } : {}
      this.innerHTML = html
      this.children = []
      this.parent = null
      this.scrollTop = 0
      this.inert = false
      this.style = { removeProperty() {} }
      this.classList = { remove() {} }
    }
    get firstElementChild() { return this.children[0] || null }
    get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null }
    insertBefore(node, cursor) {
      node.remove()
      const index = cursor ? this.children.indexOf(cursor) : this.children.length
      this.children.splice(index, 0, node)
      node.parent = this
    }
    remove() {
      if (!this.parent) return
      this.parent.children.splice(this.parent.children.indexOf(this), 1)
      this.parent = null
    }
    getClientRects() { return [{}] }
    height() { return this.parent?.dataset.launchCount === '1' ? 40 : 68 }
    getBoundingClientRect() {
      if (!this.parent) return { top: 100, width: 400, height: this.children.filter((row) => row.style.position !== 'absolute').reduce((sum, row) => sum + row.height(), 0) }
      let top = 100
      for (const row of this.parent.children) {
        if (row === this) break
        if (row.style.position !== 'absolute') top += row.height()
      }
      return { top, height: this.height(), width: 400 }
    }
    animate(frames, options) {
      let resolve, reject
      const call = { node: this, frames, options, canceled: false, complete: () => resolve() }
      calls.push(call)
      return { finished: new Promise((yes, no) => { resolve = yes; reject = no }), cancel() { call.canceled = true; reject(new Error('cancel')) } }
    }
  }
  const container = new Node()
  const context = vm.createContext({
    document: {
      documentElement: root,
      createElement: () => ({ content: { children: [] }, set innerHTML(value) { this.content.children = JSON.parse(value).map((item) => new Node(item.id, item.text || item.id)) } }),
    },
    matchMedia: () => ({ matches: false, addEventListener: (_, handler) => listeners.add(handler) }),
    MutationObserver: class { constructor(handler) { observe = handler } observe() {} },
    getComputedStyle: (node) => ({ paddingTop: node.parent.dataset.launchCount === '1' ? '0px' : '14px', paddingBottom: node.parent.dataset.launchCount === '1' ? '0px' : '14px', borderBottomWidth: '1px' }),
  })
  vm.runInContext(source, context)
  return {
    container, calls,
    update: (items) => context.launcherLaunchList.update(container, JSON.stringify(items.map((item) => typeof item === 'string' ? { id: item } : item))),
    reduce() { root.dataset.reduceMotion = 'true'; observe() },
    async finish() { for (const call of calls) if (!call.canceled) call.complete(); await Promise.resolve(); await Promise.resolve() },
  }
}

test('新增只播放新项入场，旧项保持节点，卡片高度同步展开且没有缩放', async () => {
  const h = harness()
  h.update(['a'])
  assert.equal(h.calls.length, 0, '首次列表交给开场动画')
  const original = h.container.children[0]
  h.update(['a', 'b'])
  assert.equal(h.container.children[0], original)
  const entry = h.calls.find((call) => call.node.dataset.launchKey === 'b')
  assert.equal(entry.frames[0].opacity, 0)
  assert.equal(entry.frames[0].transform, 'translateY(20px)')
  assert.ok(h.calls.every((call) => !JSON.stringify(call.frames).includes('scale')))
  const height = h.calls.find((call) => call.node === h.container)
  assert.equal(height.frames[0].height, '40px')
  assert.equal(height.frames[1].height, '136px')
  await h.finish()
  assert.ok(h.calls.every((call) => call.canceled), '结束后恢复自然布局，不保留固定高度')
})

test('删除项淡出并禁止点击，其余项目平滑补位，完成后清除删除节点', async () => {
  const h = harness()
  h.update(['a', 'b', 'c'])
  const deleted = h.container.children[0], survivor = h.container.children[1]
  h.update(['b', 'c'])
  assert.equal(deleted.inert, true)
  assert.equal(deleted.style.position, 'absolute')
  const exit = h.calls.find((call) => call.node === deleted)
  assert.equal(exit.frames[1].opacity, 0)
  const shift = h.calls.find((call) => call.node === survivor)
  assert.equal(shift.frames[0].transform, 'translateY(68px)')
  await h.finish()
  assert.deepEqual(h.container.children.map((row) => row.dataset.launchKey), ['b', 'c'])
})

test('删除到只剩一项时按真实数量收起边距，不受暂留的删除节点影响', async () => {
  const h = harness()
  h.update(['a', 'b'])
  h.update(['a'])
  assert.equal(h.container.dataset.launchCount, '1')
  assert.equal(h.container.children[0].dataset.launchLast, 'true')
  const height = h.calls.find((call) => call.node === h.container)
  assert.equal(height.frames[1].height, '40px')
  await h.finish()
  assert.equal(h.container.children.length, 1)
})

test('状态刷新及编辑内容不重播增删动画，并保留其他项目', () => {
  const h = harness()
  h.update(['a', 'b'])
  const nodes = [...h.container.children]
  h.update([{ id: 'a', text: '启动中' }, 'b'])
  assert.equal(h.calls.length, 0)
  assert.equal(h.container.children[0], nodes[0])
  assert.equal(h.container.children[1], nodes[1])
  assert.equal(nodes[0].innerHTML, '启动中')
})

test('连续增删会清理旧占位，途中开启减少动画也立即恢复最终列表', () => {
  const h = harness()
  h.update(['a', 'b'])
  h.update(['a'])
  h.update(['a', 'b', 'c'])
  assert.deepEqual(h.container.children.map((row) => row.dataset.launchKey), ['a', 'b', 'c'])
  h.update(['c'])
  h.reduce()
  assert.deepEqual(h.container.children.map((row) => row.dataset.launchKey), ['c'])
  assert.ok(h.calls.every((call) => call.canceled))
})

test('减少动画和控制台尚未就绪时直接更新列表', () => {
  for (const options of [{ reduced: true }, { ready: false }]) {
    const h = harness(options)
    h.update(['a', 'b']); h.update(['a']); h.update(['a', 'c'])
    assert.deepEqual(h.container.children.map((row) => row.dataset.launchKey), ['a', 'c'])
    assert.equal(h.calls.length, 0)
  }
})

function editor({ fail = false, confirm = true } = {}) {
  let release
  const closing = new Promise((resolve) => { release = resolve })
  const calls = []
  const context = vm.createContext({
    launchFormEl: {}, launchSaveEl: { disabled: false }, launchDeleteEl: { disabled: false },
    editingLaunchId: 'b', DEFAULT_LAUNCH_ID: 'a', state: { launchPresets: [{ id: 'a' }, { id: 'b' }] },
    launchNameEl: { value: '新增项' }, launchIcon: 'terminal', versionValue: 'auto', launchProfile: 'web',
    launchPortEl: { value: '' }, launchDshHomeEl: { value: '' },
    t: (text) => text, appConfirm: async () => confirm,
    post: async (path) => {
      calls.push(path)
      if (fail) throw new Error('保存失败')
      return { entry: { id: 'c' } }
    },
    launchEntries: () => context.state.launchPresets,
    closeLaunchEditor: async () => { calls.push('close'); await closing; calls.push('closed') },
    render: () => calls.push('render'), notify: (message) => calls.push(message),
  })
  vm.runInContext(saveCode + deleteCode, context)
  return { context, calls, release }
}

test('添加与删除成功后等待编辑弹窗退场，再渲染列表动效', async () => {
  for (const kind of ['save', 'delete']) {
    const h = editor()
    const work = kind === 'save' ? h.context.launchFormEl.onsubmit({ preventDefault() {} }) : h.context.launchDeleteEl.onclick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(h.calls.includes('close'))
    assert.ok(!h.calls.includes('render'), '弹窗尚在退出，不让列表动效被遮住')
    h.release()
    await work
    assert.ok(h.calls.indexOf('render') > h.calls.indexOf('closed'))
    assert.equal(h.context.launchSaveEl.disabled, false)
    assert.equal(h.context.launchDeleteEl.disabled, false)
  }
})

test('请求失败或取消删除保留启动项，不关闭编辑弹窗', async () => {
  for (const kind of ['save', 'delete']) {
    const h = editor({ fail: true })
    if (kind === 'save') await h.context.launchFormEl.onsubmit({ preventDefault() {} })
    else await h.context.launchDeleteEl.onclick()
    assert.deepEqual(h.context.state.launchPresets.map((entry) => entry.id), ['a', 'b'])
    assert.ok(h.calls.includes('保存失败'))
    assert.ok(!h.calls.includes('close'))
  }
  const canceled = editor({ confirm: false })
  await canceled.context.launchDeleteEl.onclick()
  assert.deepEqual(canceled.calls, [])
})
