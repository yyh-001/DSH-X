/**
 * 界面图标统一走 Lucide（ISC）：页面只引用 src/public/icons.svg 里的 symbol，
 * 不再散着手写路径；特别的自绘图形（窗口按钮 / 下拉小三角 / 实心 Star / 播放）保留。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const html = read('src/public/index.html')
const sprite = read('src/public/icons.svg')
const license = read('src/public/icons-LICENSE.txt')

test('常用图标走 Lucide 雪碧图，描边统一 1.8', () => {
  for (const name of ['pencil', 'trash-2', 'plus', 'x', 'settings', 'house', 'folder-plus', 'shield-check', 'refresh-cw']) {
    assert.match(sprite, new RegExp(`<symbol id="lucide-${name}"`), `雪碧图缺 ${name}`)
    assert.match(html, new RegExp(`/icons\\.svg#lucide-${name}`), `页面没引用 ${name}`)
  }
  assert.match(sprite, /stroke-width="1\.8"/, '统一描边宽度')
  assert.match(sprite, /fill="none" stroke="currentColor"/, '颜色跟随文字')
  assert.doesNotMatch(html, /m16 4 4 4M4 20l4-1/, '旧的手写铅笔路径已经清掉')
  assert.doesNotMatch(html, /M3 6h18M9 6V3h6v3/, '旧的手写垃圾桶路径已经清掉')
})

test('页面引用的每个图标都在雪碧图里有源', () => {
  const used = new Set([...html.matchAll(/\/icons\.svg#lucide-([a-z0-9-]+)/g)].map((match) => match[1]))
  assert.ok(used.size > 30, `只引用了 ${used.size} 个图标，像是替换没生效`)
  for (const name of used) {
    assert.match(sprite, new RegExp(`<symbol id="lucide-${name}"`), `页面引用了没有源的 ${name}`)
  }
})

test('自绘图形保留：窗口按钮、下拉小三角、实心 Star、播放', () => {
  assert.match(html, /viewBox="0 0 10 10"/, '窗口按钮是 10×10 自绘')
  assert.match(html, /class="select-caret" viewBox="0 0 12 8"/, '下拉小三角保留')
  assert.match(html, /viewBox="0 0 16 16"[^>]*><path fill="currentColor"/, 'GitHub Star 是实心 16×16')
})

test('标签页的关闭图标也走雪碧图', () => {
  const tabs = read('src/public/internal-tabs.js')
  assert.match(tabs, /\/icons\.svg#lucide-x/, '关闭图标引用雪碧图')
  assert.doesNotMatch(tabs, /<path d="m7 7 10 10/, '不再手写关闭路径')
})

test('许可证跟雪碧图一起发', () => {
  assert.match(license, /ISC License/, 'Lucide 是 ISC')
  assert.match(license, /Lucide/, '写明来源')
})
