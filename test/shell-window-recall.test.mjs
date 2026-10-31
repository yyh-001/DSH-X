/**
 * 唤出窗口：托盘、程序坞、二次启动都走 shell/main.mjs 的 revealWindow。窗口摆位跑出所有
 * 显示器时，show() 只会把它显示在屏幕外——现场就是"点了没反应，窗口明明还在"（Windows
 * 给最小化窗口的坐标是 (-32000,-32000)，矩形是 160×28）。
 * 纯规则在 shell/model.mjs 的 recenterBounds，这里两头都看住：规则本身 + 主进程有没有真的用上。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { recenterBounds } from '../shell/model.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const display = (x, y, width, height) => ({ bounds: { x, y, width, height }, workArea: { x, y, width, height } })
const primary = display(0, 0, 1600, 860)
const size = { width: 1100, height: 760 }

test('摆位跑出屏幕的窗口搬回主屏中央', () => {
  // 现场：Windows 给最小化窗口的坐标 + 最小化矩形
  assert.deepEqual(
    recenterBounds({ x: -32000, y: -32000, width: 160, height: 28 }, [primary], primary, size),
    { x: 250, y: 50, width: 1100, height: 760 },
  )
  // 位置还在屏里，尺寸被写成 0×0
  assert.ok(recenterBounds({ x: 250, y: 50, width: 0, height: 0 }, [primary], primary, size))
  // 尺寸正常、整个跑到屏幕外（比如副屏被拔掉之后）
  assert.ok(recenterBounds({ x: 5000, y: 5000, width: 1100, height: 760 }, [primary], primary, size))
  // 没有主屏信息时不要乱动
  assert.equal(recenterBounds({ x: -32000, y: -32000, width: 160, height: 28 }, [primary], null, size), null)
})

test('看得见的摆位不动', () => {
  assert.equal(recenterBounds({ x: 250, y: 50, width: 1100, height: 760 }, [primary], primary, size), null)
  // 压到左边一点也算看得见
  assert.equal(recenterBounds({ x: -120, y: 12, width: 1100, height: 760 }, [primary], primary, size), null)
  // 用户把窗口缩到最小尺寸
  assert.equal(recenterBounds({ x: 250, y: 50, width: 720, height: 520 }, [primary], primary, size), null)
  // 副屏在主屏左边，坐标是负的，但整块都在副屏里
  const left = display(-1920, 0, 1920, 1080)
  assert.equal(recenterBounds({ x: -1500, y: 100, width: 1100, height: 760 }, [primary, left], primary, size), null)
})

test('主屏比默认窗口小时按工作区夹一下', () => {
  const small = display(0, 0, 1280, 700)
  assert.deepEqual(
    recenterBounds({ x: -32000, y: -32000, width: 160, height: 28 }, [small], small, size),
    { x: 90, y: 0, width: 1100, height: 700 },
  )
})

test('唤出窗口先退出最小化，显示之后再兜摆位', () => {
  const main = read('shell/main.mjs')
  assert.match(main, /function revealWindow\(window, size\)/, '叫窗口收成一个函数')
  assert.match(main, /if \(window\.isMinimized\(\)\) window\.restore\(\)[\s\S]{0,200}?window\.show\(\)/, '先退出最小化再显示')
  assert.match(main, /window\.show\(\)[\s\S]{0,200}?recenterBounds\(window\.getBounds\(\)/, '显示之后按实际摆位兜底')
  assert.match(main, /function showManager\(\)[\s\S]{0,300}?revealWindow\(mainWindow, MAIN_WINDOW\)/, '托盘 / 二次启动走同一条路')
  assert.match(main, /tabs\.open\(target\)[\s\S]{0,120}?revealWindow\(mainWindow, MAIN_WINDOW\)/, '内部标签页也叫同一个函数')
  assert.match(main, /revealWindow\(dshWindow, DSH_WINDOW\)/, '独立 DSH 窗口同样兜底')
})
