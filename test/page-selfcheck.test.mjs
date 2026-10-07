import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

import { checkWebPage, pageBundleUrls } from '../server.js'

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

test('页面自检逐块读完脚本，仍识别截断和 HTTP 错误且沿用认证 cookie', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/?token=')) {
      res.writeHead(302, { location: '/', 'set-cookie': 'session=fake; HttpOnly' })
      res.end()
    } else if (req.headers.cookie !== 'session=fake') {
      res.writeHead(403).end()
    } else if (req.url === '/') {
      res.end('<script src="plugins/ok.js"></script><script src="plugins/broken.js"></script><script src="plugins/missing.js"></script>')
    } else if (req.url === '/plugins/ok.js') {
      res.write('first chunk')
      setImmediate(() => res.end('last chunk'))
    } else if (req.url === '/plugins/broken.js') {
      res.writeHead(200, { 'content-length': '4096' })
      res.write('incomplete')
      setTimeout(() => res.destroy(), 30)
    } else {
      res.writeHead(404).end('missing')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const original = globalThis.fetch
  globalThis.fetch = async (...args) => {
    const response = await original(...args)
    response.arrayBuffer = () => { throw new Error('自检不该把整个 bundle 缓存在内存里') }
    return response
  }
  try {
    const result = await checkWebPage(`http://127.0.0.1:${server.address().port}`, 'fake')
    assert.equal(result.total, 3)
    assert.equal(result.ok, 1)
    assert.deepEqual(result.failed.map(({ url, status }) => ({ url, status })), [
      {url:'/plugins/broken.js', status:0}, {url:'/plugins/missing.js', status:404},
    ])
  } finally {
    globalThis.fetch = original
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
