import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBundleUrls } from '../server.js'

// issue #24 的附带发现：dsh 0.1.7 起页面里写的是**相对地址**（`plugins/…`），而启动器的
// 页面自检原来只认带前导斜杠的 `/plugins/…`，于是 0.1.7 上一条都抓不到，还报「0 个全部正常」——
// 既没检到东西又盖住了真正的加载失败。两种引用方式都要认。

test('绝对与相对地址都认，并统一成绝对路径', () => {
  const absolute = '<script type="module" src="/plugins/??base.js,app.js"></script>'
  const relative = '<script type="module" src="plugins/??base.js,app.js"></script>'
  assert.deepEqual(pageBundleUrls(absolute), ['/plugins/??base.js,app.js'])
  assert.deepEqual(pageBundleUrls(relative), ['/plugins/??base.js,app.js'], '0.1.7 的相对地址不能被漏掉')
})

test('带 ./ 的写法也能认', () => {
  assert.deepEqual(pageBundleUrls(`<link href='./plugins/app.css'>`), ['/plugins/app.css'])
})

test('去重，并还原 HTML 实体', () => {
  const html = `<script src="plugins/a.js"></script><script src="/plugins/a.js"></script><script src="plugins/b.js?x=1&amp;y=2"></script>`
  assert.deepEqual(pageBundleUrls(html), ['/plugins/a.js', '/plugins/b.js?x=1&y=2'])
})

test('不误抓名字里带 plugins 的其它路径', () => {
  assert.deepEqual(pageBundleUrls('<img src="myplugins/a.png">'), [])
  assert.deepEqual(pageBundleUrls('<a href="/x/plugins/a.js">'), [], '只有在边界上的 plugins/ 才算')
})

test('页面里没有插件引用时返回空数组（上层据此如实报告，而不是说「全部正常」）', () => {
  assert.deepEqual(pageBundleUrls('<html><body>hi</body></html>'), [])
})
