import assert from 'node:assert/strict'
import test from 'node:test'
import { TabDragSession } from '../shell/tab-drag-session.mjs'
import { harness } from './helpers/tab-drag-hosts.mjs'

test('原生拖放直到有效投放才迁移，令牌只能消费一次，原页面不重新导航', () => {
  const { registry, source, records: [record], createHost } = harness()
  const destination = createHost()
  const contents = record.view.webContents, loads = [...contents.loads]
  const drag = new TabDragSession(registry)
  const token = drag.begin(source, 'a')
  assert.equal(typeof token, 'string')
  assert.equal(record.host, source)
  assert.deepEqual(source.tabs.map(tab => tab.target.id), ['a', 'b', 'c'])
  assert.equal(drag.drop(destination, 'forged', 0), false)
  assert.equal(record.host, source)
  assert.equal(drag.drop(destination, token, 0), true)
  assert.equal(record.host, destination)
  assert.equal(record.view.webContents, contents)
  assert.deepEqual(contents.loads, loads)
  assert.equal(drag.drop(source, token, 0), false)
  assert.equal(record.host, destination)
  assert.equal(drag.cancel(source, token), true)
  assert.equal(source.dragHold, false)
})

test('取消只接受原宿主和当前令牌，无需反向迁移或恢复窗口', () => {
  const { registry, source, records: [record], createHost } = harness()
  const drag = new TabDragSession(registry), other = createHost()
  const first = drag.begin(source, 'a'), second = drag.begin(source, 'b')
  assert.notEqual(first, second)
  assert.equal(drag.cancel(source, first), false)
  assert.equal(drag.cancel(other, second), false)
  assert.equal(drag.cancel(source, second), true)
  assert.equal(drag.drop(other, second, 0), false)
  assert.equal(record.host, source)
  assert.deepEqual(source.tabs.map(tab => tab.target.id), ['a', 'b', 'c'])
})

test('同窗投放按当前存活标签插入，保留期间新增与关闭的结果', () => {
  const { registry, source } = harness()
  const drag = new TabDragSession(registry), token = drag.begin(source, 'a')
  registry.disposeView(registry.targets.get('b').viewId)
  registry.presentInstance({ id: 'd', title: 'd', url: 'http://127.0.0.1:4444/d', status: 'running', managed: false })
  assert.equal(drag.drop(source, token, 1), true)
  assert.deepEqual(source.tabs.map(tab => tab.target.id), ['c', 'a', 'd'])
})

test('关闭、外部迁移、源隐藏、目标弹窗与退出不能提交旧拖动', () => {
  for (const change of ['close', 'transfer', 'roundtrip', 'hide', 'overlay', 'quit', 'forget']) {
    const { registry, source, records: [record], createHost } = harness()
    const destination = createHost()
    let quitting = false
    const drag = new TabDragSession(registry, { quitting: () => quitting })
    const token = drag.begin(source, 'a')
    if (change === 'close') {
      registry.disposeView(record.viewId)
      registry.presentInstance(record.target)
    }
    if (change === 'transfer') registry.transferView(record.viewId, createHost(), { preservePage: true })
    if (change === 'roundtrip') {
      registry.transferView(record.viewId, createHost(), { preservePage: true })
      registry.transferView(record.viewId, source, { preservePage: true })
    }
    if (change === 'hide') source.window.hide()
    if (change === 'overlay') destination.overlay = true
    if (change === 'quit') quitting = true
    if (change === 'forget') drag.forget(source)
    assert.equal(drag.drop(destination, token, 0), false, change)
    assert.equal(destination.tabs.length, 0, change)
  }
})

test('投放附加失败沿用登记器回挂，令牌失效且页面不重建', () => {
  const { registry, source, records: [record], createHost } = harness()
  const destination = createHost(), contents = record.view.webContents, loads = [...contents.loads]
  const drag = new TabDragSession(registry), token = drag.begin(source, 'a')
  destination.attach = () => { throw new Error('attach failed') }
  assert.throws(() => drag.drop(destination, token, 0), /attach failed/)
  assert.equal(record.host, source)
  assert.equal(record.view.webContents, contents)
  assert.deepEqual(contents.loads, loads)
  assert.deepEqual(source.tabs.map(tab => tab.target.id), ['a', 'b', 'c'])
  assert.equal(drag.drop(destination, token, 0), false)
  assert.equal(drag.cancel(source, token), true)
  assert.equal(drag.session, null)
})

test('单标签窗口投放后保留源原生循环，dragend 再释放空窗口', () => {
  const { registry, source, records: [record], createHost } = harness()
  const origin = createHost()
  registry.transferView(record.viewId, origin, { preservePage: true })
  const drag = new TabDragSession(registry), token = drag.begin(origin, 'a')
  assert.equal(drag.drop(source, token, 1), true)
  assert.equal(record.host, source)
  assert.equal(origin.tabs.length, 0)
  assert.equal(origin.window.isDestroyed(), false)
  assert.equal(drag.cancel(origin, token), true)
  assert.equal(origin.window.isDestroyed(), true)
  assert.equal(record.host, source, '结束已投放的手势不撤销已确认的落点')
})
