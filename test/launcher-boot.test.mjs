import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/launcher-boot.js', import.meta.url), 'utf8')

function boot({ reduced = false, systemReduced = false, lang = 'zh' } = {}) {
  const classes = () => {
    const values = new Set()
    return { add: (...items) => items.forEach((item) => values.add(item)), remove: (...items) => items.forEach((item) => values.delete(item)), contains: (item) => values.has(item) }
  }
  const root = { classList: classes(), dataset: { reduceMotion: String(reduced), lang } }
  const screen = { hidden: true, classList: classes() }, status = { textContent: '正在加载控制台…' }
  const rows = Array.from({ length: 8 }, () => {
    const properties = new Map()
    return { classList: classes(), style: { setProperty: (key, value) => properties.set(key, value), removeProperty: (key) => properties.delete(key), getPropertyValue: (key) => properties.get(key) } }
  })
  const documentEvents = new Map(), motionEvents = new Set(), timers = new Map()
  let observerCallback, observed = false, now = 0, nextId = 1
  const motion = {
    matches: systemReduced,
    addEventListener: (_, handler) => motionEvents.add(handler),
    removeEventListener: (_, handler) => motionEvents.delete(handler),
  }
  const context = vm.createContext({
    document: { documentElement: root, getElementById: (id) => id === 'launcherBoot' ? screen : status, querySelectorAll: () => rows, addEventListener: (name, handler) => documentEvents.set(name, handler) },
    matchMedia: () => motion,
    MutationObserver: class {
      constructor(handler) { observerCallback = handler }
      observe() { observed = true }
      disconnect() { observed = false }
    },
    setTimeout(handler, delay) { const id = nextId++; timers.set(id, { handler, at: now + delay }); return id },
    clearTimeout: (id) => timers.delete(id),
  })
  vm.runInContext(source, context)
  return {
    root, screen, status, timers, rows,
    ready: (part) => context.launcherBoot.markReady(part),
    dom: () => documentEvents.get('DOMContentLoaded')?.(),
    reduce() { root.dataset.reduceMotion = 'true'; if (observed) observerCallback() },
    systemReduce() { motion.matches = true; for (const handler of [...motionEvents]) handler() },
    tick(ms) {
      const end = now + ms
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at; timers.delete(due[0]); due[1].handler()
      }
      now = end
    },
  }
}

test('等本地状态、设置和 DOM 都就绪才退场，不等待远程版本，也不强制播放完整开场', () => {
  const b = boot()
  assert.equal(b.screen.hidden, false)
  b.ready('state'); b.dom(); b.tick(1000)
  assert.equal(b.screen.hidden, false)
  assert.equal(b.screen.classList.contains('is-leaving'), false)
  b.ready('settings')
  assert.equal(b.screen.classList.contains('is-leaving'), true)
  b.tick(300)
  assert.equal(b.screen.hidden, true)
  assert.equal(b.root.classList.contains('launcher-entering'), true)
  assert.equal(b.rows[0].classList.contains('launcher-preset-enter'), true)
  assert.equal(b.rows[0].style.getPropertyValue('--launcher-entry-delay'), '0ms')
  assert.equal(b.rows[1].style.getPropertyValue('--launcher-entry-delay'), '100ms')
  assert.equal(b.rows[7].style.getPropertyValue('--launcher-entry-delay'), '700ms', '每一项都保持顺序入场')
  b.tick(1150)
  assert.equal(b.rows[7].classList.contains('launcher-preset-enter'), true, '最后一项仍在入场，不提前移除动画')
  b.tick(150)
  assert.equal(b.root.classList.contains('launcher-entering'), false)
  assert.ok(b.rows.every((row) => !row.classList.contains('launcher-preset-enter')))
  assert.ok(b.rows.every((row) => !row.style.getPropertyValue('--launcher-entry-delay')))
  b.ready('state'); b.ready('settings'); b.dom()
  assert.equal(b.root.classList.contains('launcher-entering'), false, '状态推送不会重播开场')
  assert.equal(b.timers.size, 0)
})

test('主脚本或请求卡住时释放界面，不保留加载遮罩', () => {
  const b = boot()
  b.ready('state'); b.dom(); b.tick(6000)
  assert.equal(b.screen.hidden, true)
  assert.equal(b.root.classList.contains('launcher-loading'), false)
  assert.equal(b.root.classList.contains('launcher-entering'), false)
  assert.equal(b.timers.size, 0)
})

test('设置与系统的减少动画都跳过开场，加载中切换也立即释放界面', () => {
  for (const options of [{ reduced: true }, { systemReduced: true }]) {
    const b = boot(options)
    assert.equal(b.screen.hidden, true)
    assert.equal(b.timers.size, 0)
  }
  for (const method of ['reduce', 'systemReduce']) {
    const b = boot()
    b[method]()
    assert.equal(b.screen.hidden, true)
    assert.equal(b.timers.size, 0)
  }
})

test('入场途中切换减少动画，会取消位移并清理定时器', () => {
  for (const method of ['reduce', 'systemReduce']) {
    const b = boot()
    b.dom(); b.ready('settings'); b.ready('state'); b.tick(300)
    assert.equal(b.root.classList.contains('launcher-entering'), true)
    b[method]()
    assert.equal(b.root.classList.contains('launcher-entering'), false)
    assert.ok(b.rows.every((row) => !row.classList.contains('launcher-preset-enter')))
    assert.equal(b.timers.size, 0)
  }
})

test('英文控制台的加载文案随语言切换', () => {
  assert.equal(boot({ lang: 'en' }).status.textContent, 'Loading console…')
})
