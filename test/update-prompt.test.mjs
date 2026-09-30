import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('../public/launcher.css', import.meta.url)), 'utf8')
const start = readFileSync(fileURLToPath(new URL('../start.js', import.meta.url)), 'utf8')

// dsh 是第三方插件的宿主：新版本可能让插件失效（插件市场就出过），所以升级必须先确认。
const RISK = '升级会先停掉正在运行的 dsh，再下载安装新版本。插件由第三方维护、通常滞后于 dsh，新版本可能让插件失效或页面打不开（插件市场就出过这种情况）。已装的其他版本会保留，随时可以切回。'

test('启动时不再自动弹更新弹窗', () => {
  // 页面不再读 /api/pending：那个接口是「启动时先问一句」的老路
  assert.ok(!html.includes("/api/pending'"), '页面不该再去读 /api/pending')
  assert.match(html, /let askBlocking = false/, '弹窗没打开时不该拦着启动')
  assert.match(html, /function showAsk\(update\) \{[\s\S]{0,40}?askBlocking = true/, '弹窗打开时才置位')
  // 启动器那一侧也不再带着 ?ask 打开页面、不再预查更新
  assert.ok(!start.includes('?ask=update'), '启动时不该带 ?ask 打开页面')
  assert.ok(!start.includes('pendingUpdate'), '启动时不该预查有没有更新')
})

test('首页的更新按钮只弹确认，不直接升级', () => {
  assert.match(
    html,
    /updateEl\.onclick = \(\) => \{[\s\S]{0,400}?showAsk\(\{ dsh: \{ current: selected\(\) \|\| latest, latest \} \}\)/,
    '更新按钮打开确认弹窗',
  )
  assert.ok(!/updateEl\.onclick = async/.test(html), '更新按钮不该再直接跑升级')
  // 真正的升级动作挪进弹窗，由确认按钮触发
  assert.match(html, /async function updateToLatest\(latest\)/)
  assert.match(html, /await updateToLatest\(update\.dsh\.latest\)/)
})

test('dsh 升级确认里写明了风险', () => {
  assert.ok(html.includes(`'${RISK}'`), '风险说明要作为 dsh 那一行的提示传进去')
  assert.ok(html.includes('"Upgrading stops the running dsh'), '英文界面要有对应文案')
  assert.match(css, /\.ask-risk \{/, '风险块要有自己的样式')
  assert.match(html, /t\('更新到 \{latest\}', \{ latest: update\.dsh\.latest \}\)/, '按钮文案用「更新到 x」')
})

test('启动器自更新仍然点按钮才弹', () => {
  assert.match(html, /selfUpdateEl\.onclick = \(\) => \{[\s\S]{0,300}?showAsk\(\{ dsh: null, self:/)
})
