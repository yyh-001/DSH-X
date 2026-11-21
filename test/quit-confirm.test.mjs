/**
 * 退出前「还有实例在运行」的确认：外壳数实例、管理页弹框、回答再交给管理服务收尾。
 * 三层分别在三个文件里，这里把接缝看住（页面里的弹框复用 appConfirm，不用系统原生框）。
 */
import assert from 'node:assert/strict'
import { readEnDict } from './helpers/frontend-source.mjs'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { liveInstances } from '../shell/model.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

test('退出前只把 running / starting 的实例算作「在跑」', () => {
  const list = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'starting' },
    { id: 'c', status: 'stopping' },
    { id: 'd', status: 'stopped' },
    null,
  ]
  assert.deepEqual(liveInstances(list).map((item) => item.id), ['a', 'b'], '正在停的不该再拦一次')
  assert.deepEqual(liveInstances(null), [])
})

test('还有实例在跑时，退出先让管理页确认，不再直接把它们杀掉', () => {
  const main = read('shell/main.mjs')
  // 1.5s 轮询到的状态可能慢一拍，能同步问核心时取最新的
  assert.match(main, /liveInstances\(parseTrayState\(server\.trayStateText\(\)\)\.instances\)/, '实例数取核心的最新状态')
  assert.match(main, /async function quit\(\)[\s\S]{0,400}?await confirmQuitWithInstances\(\)/, 'quit 先问再收尾')
  assert.match(main, /action: 'confirm-quit'/, '发到管理页的询问带着实例数')
  assert.match(main, /value\?\.action === 'quit-confirm'/, '管理页的回答走同一条 IPC 通道')
  assert.match(main, /showManager\(\)/, '窗口藏着或停在标签页上时先叫回管理页，确认框才看得见')
  assert.match(main, /QUIT_CONFIRM_TIMEOUT_MS/, '页面卡死不能把退出永远吊住')
})

test('管理页用样式化确认框回答外壳，换过的按钮文案会还原', () => {
  const html = read('src/public/index.html')
  assert.match(html, /ipc\.onMessage\?\.\(/, '页面装了外壳消息的监听')
  assert.match(html, /askQuitWithInstances/, '退出询问走页面自己的确认框')
  assert.match(html, /title: t\('退出 DSH-X'\), okText: t\('停止并退出'\), cancelText: t\('保留运行'\)/, '按钮说清「停止并退出 / 保留运行」')
  assert.match(html, /ipc\.postMessage\(JSON\.stringify\(\{ action: 'quit-confirm'/, '回答带回主进程')
  // appConfirm 的按钮默认吃 data-i18n；调用方换过文案后，下一次调用要回到默认（取消 / 确定）
  assert.match(html, /okButton\.textContent = okText \|\| t\(okButton\.dataset\.i18n \|\| '确定'\)/)
  // 确认框正被别的操作占着时先等它关掉，别抢走那个操作的回答
  assert.match(html, /while \(!confirmDialogEl\.hidden\) await new Promise/)
  const dict = readEnDict()
  for (const text of ['退出 DSH-X', '停止并退出', '保留运行', '还有 1 个实例在运行，退出会先停止它。', '还有 {count} 个实例在运行，退出会先停止它们。']) {
    assert.ok(dict[text], `「${text}」缺英文`)
  }
})

test('预加载把外壳 → 页面的消息通道接出来，两边通道名一致', () => {
  const preload = read('shell/preload.cjs')
  const main = read('shell/main.mjs')
  assert.match(preload, /const SHELL_CHANNEL = 'dsh-x:shell'/)
  assert.match(main, /const SHELL_CHANNEL = 'dsh-x:shell'/)
  assert.match(preload, /onMessage\(handler\)/, '页面能订阅外壳消息')
  assert.match(preload, /ipcRenderer\.on\(SHELL_CHANNEL/, '订阅挂在外壳通道上')
})
