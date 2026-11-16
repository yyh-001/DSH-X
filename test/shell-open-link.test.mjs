import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../shell/main.mjs', import.meta.url), 'utf8')
const functionSource = name => {
  const start = source.indexOf(`function ${name}(`)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}

for (const mode of ['internal', 'window']) {
  test(`管理页弹窗和导航的 ${mode} 迁移拒绝只提示一次，不逃出事件处理器`, () => {
    const contents = new EventEmitter(), errors = [], calls = [], external = []
    const message = '当前平台暂不支持已有页面跨窗迁移，请先关闭此标签后重新打开'
    const target = { id: 'existing-page', url: 'http://127.0.0.1:1234/' }
    contents.setWindowOpenHandler = handler => { contents.popup = handler }
    const context = vm.createContext({
      state: { lang: 'zh', instances: [target] }, mainWindow: { isDestroyed: () => false }, tabs: { kind: 'internal', alive: true },
      managerUrl: () => 'http://127.0.0.1:4321/',
      sameOrigin: (a, b) => new URL(a).origin === new URL(b).origin,
      isWebUrl: url => /^https?:/.test(url), internalMode: () => mode === 'internal', windowMode: () => mode === 'window',
      legacyWindowTarget: () => target,
      instanceViews: { presentInstance: (...args) => { calls.push(args); throw Error(message) } },
      shell: { openExternal: url => external.push(url) },
      dialog: { showErrorBox: (...args) => errors.push(args) },
    })
    vm.runInContext(['openInternalTab', 'openDshWindow', 'openLink', 'guardManager'].map(functionSource).join('\n'), context)
    context.guardManager(contents)
    assert.equal(contents.popup({ url: target.url }).action, 'deny')
    let prevented = 0
    assert.doesNotThrow(() => contents.emit('will-navigate', { preventDefault: () => prevented++ }, target.url))
    assert.equal(prevented, 1)
    assert.equal(calls.length, 2)
    assert.equal(errors.length, 2)
    assert.ok(errors.every(args => args[1] === message))
    assert.equal(external.length, 0)
    context.instanceViews.presentInstance = (...args) => calls.push(args)
    assert.equal(contents.popup({ url: target.url }).action, 'deny')
    assert.equal(calls.length, 3)
    assert.equal(errors.length, 2, '成功打开不提示错误')
    contents.popup({ url: 'https://example.com/' })
    assert.deepEqual(external, ['https://example.com/'])
  })
}
