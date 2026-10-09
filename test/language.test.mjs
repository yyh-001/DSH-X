import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { isolateUserHome } from './isolated-home.mjs'

// lang.txt 属于安装目录，复制服务到临时安装目录，避免测试改动真实安装语言或用户设置。
const root = mkdtempSync(join(tmpdir(), 'dsh-language-'))
const install = join(root, 'install'), app = isolateUserHome(join(root, 'user'))
mkdirSync(install, { recursive: true })
mkdirSync(app, { recursive: true })
for (const file of readdirSync(new URL('../', import.meta.url))) {
  if (/\.(js|mjs|cjs)$/.test(file) || file === 'package.json') copyFileSync(new URL(`../${file}`, import.meta.url), join(install, file))
}
mkdirSync(join(install, 'public'))
copyFileSync(new URL('../public/index.html', import.meta.url), join(install, 'public', 'index.html'))
const settingsFile = join(app, 'settings.json'), languageFile = join(install, 'lang.txt')
const initial = { dataDir: join(root, 'data'), dshHome: join(root, 'home'), seedMarket: false }
writeFileSync(settingsFile, JSON.stringify(initial))
process.env.PORT = String(await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
}))
const server = await import(pathToFileURL(join(install, 'server.js')))
let origin

test.after(async () => {
  await server.stopAll()
  rmSync(root, { recursive: true, force: true })
})

const saved = () => JSON.parse(readFileSync(settingsFile, 'utf8'))
async function checkLanguage(expected) {
  const response = await fetch(`${origin}/api/settings`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).lang, expected, '设置页回填使用已选择的语言')
  const html = await (await fetch(origin)).text()
  assert.match(html, new RegExp(`data-lang="${expected}"`), '重新打开页面仍使用已选择的语言')
}

test('首次启动采用安装语言；设置页更改语言后，重启或升级不会覆盖用户选择', async () => {
  writeFileSync(languageFile, 'en')
  origin = await server.startServer()
  await checkLanguage('en')
  assert.equal(saved().lang, 'en', '安装语言只初始化一次用户设置')

  for (const [language, installed] of [['zh', 'en'], ['en', 'zh']]) {
    const response = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ lang: language }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).lang, language)
    assert.equal(saved().lang, language)
    await checkLanguage(language)
    await server.stopAll()
    writeFileSync(languageFile, installed)
    origin = await server.startServer()
    await checkLanguage(language)
    assert.equal(saved().lang, language, '重启后持久化设置不能被安装语言改写')
  }
})

test('用户语言未设置且安装语言缺失或无效时，默认中文', async () => {
  for (const installed of [null, 'invalid']) {
    await server.stopAll()
    writeFileSync(settingsFile, JSON.stringify({ ...initial, lang: '' }))
    if (installed === null) rmSync(languageFile, { force: true })
    else writeFileSync(languageFile, installed)
    origin = await server.startServer()
    await checkLanguage('zh')
  }
})
