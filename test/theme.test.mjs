import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, safeTheme, safePanelTransparency } from '../settings.js'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

test('外观默认跟随系统，历史错误值退回系统主题', () => {
  assert.equal(DEFAULTS.theme, 'system')
  assert.equal(safeTheme('system'), 'system')
  assert.equal(safeTheme('light'), 'light')
  assert.equal(safeTheme('dark'), 'dark')
  assert.equal(safeTheme('other'), 'system')
})

test('外观页提供三种主题，选择后立即应用并自动提交', () => {
  assert.match(html, /data-theme="__APP_THEME__"/)
  assert.match(html, /href="\/theme\.css(?:\?[^"\s]*)?"/)
  for (const value of ['system', 'light', 'dark']) {
    assert.match(html, new RegExp(`name="theme" value="${value}"`))
  }
  assert.match(html, /window\.setLauncherTheme\(input\.value\)/)
  assert.match(html, /queueSetting\('theme', input\.value\)/)
  assert.match(html, /systemDark\.addEventListener\('change'/)
})

test('悬浮窗透明度限制在 0-100，外观页即时预览并自动保存', () => {
  assert.equal(DEFAULTS.panelTransparency, 0)
  assert.equal(safePanelTransparency(-5), 0)
  assert.equal(safePanelTransparency(43.6), 44)
  assert.equal(safePanelTransparency(120), 100)
  assert.equal(safePanelTransparency('bad'), 0)
  assert.match(html, /id="panelTransparency" type="range" min="0" max="100"/)
  assert.match(html, /window\.setPanelTransparency\(value\)/)
  assert.match(html, /queueSetting\('panelTransparency', transparency\)/)
})
