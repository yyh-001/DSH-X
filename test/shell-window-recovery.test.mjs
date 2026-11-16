/**
 * #117：Windows 笔记本合盖休眠、唤醒后启动器窗口没了，点托盘弹原生错误框
 * 「A JavaScript error occurred in the main process / TypeError: Object has been destroyed」。
 *
 * 现场是窗口已经被系统销毁，而 mainWindow / tabs 还留着引用；showManager 走
 * select → layout → tabBounds，对已销毁窗口调 getContentBounds() 直接抛。
 * 这里两头都看住：标签容器不再碰已销毁的原生对象；外壳把「窗口被销毁」当成可恢复状态，
 * 托盘 / 二次启动 / 程序坞再叫窗口时重建，而不是把异常抛给用户。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { InstanceViews } from '../shell/instance-views.mjs'
import { BrowserTabs } from '../shell/tabs.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

/** 窗口被系统销毁后，原生对象的 getter 和方法都抛这一句。 */
function destroyed() {
  const boom = () => { throw new TypeError('Object has been destroyed') }
  return {
    isDestroyed: () => true,
    getContentBounds: boom,
    getBounds: boom,
    webContents: { getZoomFactor: boom },
    contentView: { addChildView: boom },
  }
}

test('窗口被系统销毁后，标签容器不再碰原生对象', () => {
  const window = destroyed()
  const tabs = new BrowserTabs(window, {})
  assert.equal(tabs.alive, false)
  assert.equal(tabs.tabBounds(), null, '没有窗口就没有布局，返回 null 让调用方跳过')
  assert.doesNotThrow(() => tabs.layout(), '托盘唤出的 layout 不能再抛给主进程')
  tabs.tabs.push({ view: { setBackgroundColor: window.getBounds, setBounds: window.getBounds }, target: { id: 'tab' } })
  assert.doesNotThrow(() => tabs.paintBackgrounds(), '主题刷新也要先判活')
  assert.doesNotThrow(() => tabs.preferences(false, 'zh', 'system'), '状态轮询每次都会走到这里')
  assert.throws(() => tabs.attach({ view: {}, target: { id: '' } }), /管理页窗口已销毁/, '挂不上去就明确报错，不把 null 传给原生 setBounds')
})

test('宿主窗口没了只清它名下的视图登记，独立窗口不受影响', () => {
  const registry = new InstanceViews({ createView() {}, createHost() {} })
  const internal = { kind: 'internal' }
  const standalone = { kind: 'window' }
  for (const [id, host] of [['a', internal], ['b', standalone]]) {
    registry.views.set(id, { host, target: { id } })
    registry.targets.set(id, registry.views.get(id))
  }
  registry.dropHost(internal)
  assert.deepEqual([...registry.views.keys()], ['b'], '随窗口销毁的视图只剩登记要清')
  assert.deepEqual([...registry.targets.keys()], ['b'])
  assert.equal(registry.views.get('b').host, standalone)
})

test('管理页窗口被系统销毁后，托盘 / 二次启动重建窗口而不是抛异常', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /function showManager\(\) \{[\s\S]{0,400}?if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{[\s\S]{0,160}?if \(managerBase\) createMainWindow\(\)/, '托盘、二次启动、通知都走 showManager：窗口没了先重建')
  assert.match(main, /if \(managerBase\) createMainWindow\(\)[\s\S]{0,40}?return/, '核心还没起来（下载/启动阶段）不能提前建窗口，start() 最后会自己建')
  assert.match(main, /function openInternalTab\(target\) \{[\s\S]{0,400}?if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) showManager\(\)/, '内部标签页也要先重建宿主，别退回系统浏览器')
  assert.match(main, /window\.on\('closed', \(\) => \{[\s\S]{0,600}?instanceViews\?\.dropHost\(host\)[\s\S]{0,40}?\}/, '窗口销毁时清引用，只清它名下的视图登记')
  assert.match(main, /instanceViews \?\?= new InstanceViews\(/, '登记器只建一次：重建窗口不能把独立窗口里的视图丢掉')
  assert.match(main, /shellLog\(`管理页窗口已销毁/, '销毁事件落日志，下次有人报同样问题能对上时间')
})

test('休眠 / 唤醒留痕：日志里能看出窗口是在挂起前还是唤醒后消失的', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /function shellLog\(line\)[\s\S]{0,240}?appendFileSync\(join\(APP_DIR, 'manager\.log'\)/, '安装版没有控制台，外壳日志写进核心那份 manager.log')
  assert.match(main, /powerMonitor\.on\('suspend', \(\) => shellLog\('系统挂起'\)\)/)
  assert.match(main, /powerMonitor\.on\('resume', \(\) => \{[\s\S]{0,240}?mainWindow\.isDestroyed\(\) \? '已销毁' : '还在'/, '唤醒时把窗口状态一起记下来')
})
