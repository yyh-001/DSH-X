import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

// 可指向验证基线，让同一组断言同时保留修前失败与修后通过的证据。
const root = process.env.DSH_PATH_TEST_ROOT || resolve(import.meta.dirname, '..')
const server = await import(pathToFileURL(resolve(root, 'server.js')))
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8')
const showStart = html.indexOf('    function showSystemPathSettings(data) {')
const showEnd = html.indexOf('    const openModeEl', showStart)
const translate = (text, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), text)
function ui() {
  assert.notEqual(showStart, -1, '开关旁有持久化结果显示逻辑')
  const context = { savedSystemPath: false, systemPathEl: {}, systemPathHint: {}, t: translate }
  vm.runInNewContext(html.slice(showStart, showEnd), context)
  return context
}

for (const enabled of [true, false]) {
  test(`手动 PATH ${enabled ? '开启' : '关闭'}：指引符合操作方向`, () => {
    assert.equal(typeof server.manualPathMessage, 'function')
    const message = server.manualPathMessage(enabled, '/tmp/Test Home/bin')
    assert.match(message, /不会修改 shell 配置/)
    assert.match(message, enabled ? /手动添加：export PATH=/ : /移除添加 \/tmp\/Test Home\/bin 的 PATH 配置/)
    if (!enabled) assert.doesNotMatch(message, /export PATH=/)
  })
}

test('手动添加指令：空格、单引号、$ 和反引号按字面处理，用户命令优先', { skip: process.platform === 'win32' }, () => {
  assert.equal(typeof server.manualPathCommand, 'function')
  for (const dir of ['/tmp/Test Home/bin', "/tmp/it's/$HOME/`echo bad`/bin"]) {
    const out = execFileSync('/bin/sh', ['-c', `${server.manualPathCommand(dir)}; printf '%s' "$PATH"`], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 2000 })
    assert.equal(out, `/usr/bin:/bin:${dir}`)
  }
})

test('手动模式：首次加载、重复开关、重载后始终有相应说明', () => {
  const c = ui()
  for (const enabled of [false, true, true, false, false, true]) {
    c.showSystemPathSettings({ systemPath: enabled, systemPathMode: 'manual', systemBinDir: '/tmp/Test Home/bin', systemPathCommand: 'export PATH=fixture' })
    assert.equal(c.systemPathEl.checked, enabled)
    assert.match(c.systemPathHint.textContent, enabled ? /手动添加：export PATH=fixture/ : /移除添加/)
    assert.doesNotMatch(c.systemPathHint.textContent, /已写入|已从用户 PATH 移除/)
  }
})

test('自动模式决策表：只有真实写入成功才显示成功，失败不误报', () => {
  const c = ui()
  for (const enabled of [true, false]) for (const ok of [true, false]) {
    c.showSystemPathSettings({ systemPath: enabled, systemPathMode: 'automatic', systemPathResult: { ok } })
    assert.equal(c.systemPathEl.checked, enabled)
    assert.match(c.systemPathHint.textContent, ok ? (enabled ? /已写入/ : /已从用户 PATH 移除/) : /未能修改/)
  }
  c.showSystemPathSettings({ systemPath: true, systemPathMode: 'automatic', systemBinDir: 'fixture' })
  assert.equal(c.systemPathHint.textContent, 'shim 目录：fixture')
})

test('保存按服务器响应显示，较新的待保存点击不被旧响应覆盖；失败恢复已保存值', async () => {
  const c = ui()
  Object.assign(c, { settingSaveRunning: false, pendingSettings: new Map([['systemPath', true]]), settingsHint: {}, visualSettings: [], document: {}, post: async () => ({ systemPath: true, systemPathMode: 'manual', systemPathCommand: 'fixture' }) })
  const start = html.indexOf('    async function flushSettings() {')
  const end = html.indexOf('    function queueSetting(', start)
  vm.runInNewContext(html.slice(start, end), c)
  await c.flushSettings()
  assert.match(c.systemPathHint.textContent, /手动添加/)
  // 模拟先发开启、请求返回前又关闭；第二个请求必须完成最终关闭。
  c.pendingSettings.set('systemPath', true)
  let calls = 0
  c.post = async () => { if (++calls === 1) { c.pendingSettings.set('systemPath', false); return { systemPath: true } } return { systemPath: false, systemPathMode: 'manual', systemBinDir: 'fixture' } }
  await c.flushSettings()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2)
  assert.equal(c.systemPathEl.checked, false)
  assert.match(c.systemPathHint.textContent, /移除/)
  c.systemPathEl.checked = true
  c.pendingSettings.set('systemPath', true)
  c.post = async () => { throw new Error('fixture 保存失败') }
  await c.flushSettings()
  assert.equal(c.systemPathEl.checked, false)
  assert.equal(c.systemPathHint.textContent, 'fixture 保存失败')
})

for (const initial of [false, true]) {
  test(`连续切换：${initial ? 'ON→OFF→ON' : 'OFF→ON→OFF'}，首次成功、第二次失败回滚到首次已保存状态`, async () => {
    const c = ui()
    c.showSystemPathSettings({ systemPath: initial, systemPathMode: 'manual', systemBinDir: 'fixture', systemPathCommand: 'fixture' })
    const confirmed = !initial
    let serverState = initial
    let calls = 0
    Object.assign(c, { settingSaveRunning: false, pendingSettings: new Map([['systemPath', confirmed]]), settingsHint: {}, visualSettings: [], document: {} })
    c.systemPathEl.checked = confirmed
    c.post = async (url, patch) => {
      if (++calls === 1) {
        assert.equal(patch.systemPath, confirmed)
        serverState = confirmed
        // 第一个请求未返回时用户又切回初始状态，不应覆盖此时的 UI 意图。
        c.systemPathEl.checked = initial
        c.systemPathHint.textContent = '正在保存…'
        c.pendingSettings.set('systemPath', initial)
        return { systemPath: serverState, systemPathMode: 'manual', systemBinDir: 'fixture', systemPathCommand: 'fixture' }
      }
      assert.equal(patch.systemPath, initial)
      assert.equal(c.systemPathEl.checked, initial, '第一次成功响应不覆盖更新的点击')
      assert.equal(c.systemPathHint.textContent, '正在保存…')
      throw new Error('第二次保存失败')
    }
    const start = html.indexOf('    async function flushSettings() {')
    const end = html.indexOf('    function queueSetting(', start)
    vm.runInNewContext(html.slice(start, end), c)
    await c.flushSettings()
    await new Promise((r) => setImmediate(r))
    assert.equal(calls, 2)
    assert.equal(serverState, confirmed)
    assert.equal(c.savedSystemPath, confirmed, '快照保留最近的成功响应')
    assert.equal(c.systemPathEl.checked, serverState, '第二次失败回滚到服务器实际保存值')
    assert.equal(c.systemPathHint.textContent, '第二次保存失败')
    assert.equal(c.settingSaveRunning, false)
    assert.equal(c.pendingSettings.size, 0)
  })
}
