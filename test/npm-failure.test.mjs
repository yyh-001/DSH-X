/**
 * 装 dsh 新版本失败时，页面上原本只剩 npm 的收尾语「A complete log of this run can be found in: …」，
 * 看不出所以然。describeNpmFailure 改成**直接用 npm 自己说的那句话**（只滤掉那两句套话），
 * 具体缺哪个包、哪个源 404 它的报错里本来就写着。用例取自真实踩到的那次（0.2.0-rc.2 装不上）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeNpmFailure } from '../registry.js'

const ETARGET = `npm error code ETARGET
npm error notarget No matching version found for @deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.2.
npm error notarget In most cases you or one of your dependencies are requesting
npm error notarget a package version that doesn't exist.
npm error A complete log of this run can be found in: C:\\Users\\yyh\\AppData\\Local\\npm-cache\\_logs\\2026-09-29T10_26_17_976Z-debug-0.log`

test('上游发版不齐：把 npm 实际那句话显示出来，缺哪个包一目了然', () => {
  const message = describeNpmFailure(ETARGET)
  assert.match(message, /No matching version found for @deepseek-ai\/dsh-client-ui-settings-account@0\.2\.0-rc\.2\./)
  assert.ok(!message.includes('A complete log'), `别把收尾语当报错：${message}`)
  assert.ok(!message.includes('In most cases'), `套话也别带上：${message}`)
})

test('registry 上没有这个包：404 那两行原样带出来', () => {
  const text = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@scope%2fnope - Not found
npm error 404  '@scope/nope@*' is not in this registry.`
  const message = describeNpmFailure(text)
  assert.match(message, /404 Not Found - GET https:\/\/registry\.npmjs\.org\/@scope%2fnope/)
  assert.match(message, /is not in this registry/)
})

test('没有 npm 的报错行就不瞎猜，交给调用方用最后一行', () => {
  assert.equal(describeNpmFailure('some random output'), '')
  assert.equal(describeNpmFailure(''), '')
})

test('光秃秃的 code 行不留（真正的原因在它下面那句）', () => {
  assert.equal(describeNpmFailure('npm error code ETARGET'), '')
  assert.equal(describeNpmFailure('npm error EACCES'), 'EACCES', '别的行原样带出来')
})
