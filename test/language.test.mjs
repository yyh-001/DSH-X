import assert from 'node:assert/strict'
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
// 运行时在 src/，安装包里的核心是摊平的：按打包后的样子复制到临时安装目录。
for (const file of readdirSync(new URL('../src', import.meta.url))) {
  if (/\.(js|mjs|cjs)$/.test(file)) copyFileSync(new URL(`../src/${file}`, import.meta.url), join(install, file))
}
// compat 是真实安装布局的一部分，核心模块加载时也会引用其中的共享协议。
cpSync(new URL('../src/compat', import.meta.url), join(install, 'compat'), { recursive: true })
copyFileSync(new URL('../package.json', import.meta.url), join(install, 'package.json'))
mkdirSync(join(install, 'public'))
copyFileSync(new URL('../src/public/index.html', import.meta.url), join(install, 'public', 'index.html'))
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
const { systemLang } = await import(pathToFileURL(join(install, 'settings.js')))
let origin

test.after(async () => {
  await server.stopAll()
  rmSync(root, { recursive: true, force: true })
})

const saved = () => JSON.parse(readFileSync(settingsFile, 'utf8'))
/**
 * 管理页要会话 cookie：先用 launch token 换一次，再带着 cookie 读页面。
 * Node 的 fetch 没有 cookie 罐，redirect 跟过去的那一下也不会把 Set-Cookie 留给下一次请求。
 */
async function managerPage() {
  const exchange = await fetch(server.managerUrlWithToken(), { redirect: 'manual' })
  const cookie = String(exchange.headers.get('set-cookie') || '').split(';')[0]
  assert.match(cookie, /^dsh-x-manager-/, '换 cookie 失败，后面的页面断言没有意义')
  return (await fetch(origin, { headers: { cookie } })).text()
}

async function checkLanguage(expected) {
  const response = await fetch(`${origin}/api/settings`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).lang, expected, '设置页回填使用已选择的语言')
  const html = await managerPage()
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

test('系统语言只有中文环境选 zh，其余（含 C / POSIX / 空值）回退 en', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_CN.UTF-8', 'zh-Hant-TW']) {
    assert.equal(systemLang(locale), 'zh', locale)
  }
  for (const locale of ['en-US', 'en_GB.UTF-8', 'ja-JP', 'C', 'C.UTF-8', 'POSIX', '', null]) {
    assert.equal(systemLang(locale), 'en', String(locale))
  }
})

test('用户语言未设置且安装语言缺失或无效时，跟随系统语言', async () => {
  const expected = systemLang()
  for (const installed of [null, 'invalid']) {
    await server.stopAll()
    writeFileSync(settingsFile, JSON.stringify({ ...initial, lang: '' }))
    if (installed === null) rmSync(languageFile, { force: true })
    else writeFileSync(languageFile, installed)
    origin = await server.startServer()
    await checkLanguage(expected)
  }
})

test('界面语言默认是「系统默认」，显式选择后跟随系统语言并写进设置', async () => {
  await server.stopAll()
  writeFileSync(settingsFile, JSON.stringify(initial))
  rmSync(languageFile, { force: true })
  origin = await server.startServer()
  const expected = systemLang()

  // 没选过语言：下拉框回显「系统默认」，实际语言跟随系统
  let data = await (await fetch(`${origin}/api/settings`)).json()
  assert.equal(data.langPref, 'system', '默认选项是系统默认')
  assert.equal(data.lang, expected, '没选过语言时按系统语言显示')

  const response = await fetch(`${origin}/api/settings`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ lang: 'system' }),
  })
  assert.equal(response.status, 200)
  data = await response.json()
  assert.equal(data.langPref, 'system')
  assert.equal(data.lang, expected)
  assert.equal(saved().lang, 'system', '显式选「系统默认」要写进设置，不能当成没设')

  // 重启后仍是系统默认，不会被旧安装器的 lang.txt 改写
  await server.stopAll()
  writeFileSync(languageFile, expected === 'en' ? 'zh' : 'en')
  origin = await server.startServer()
  data = await (await fetch(`${origin}/api/settings`)).json()
  assert.equal(data.langPref, 'system', '重启后仍回显系统默认')
  assert.equal(data.lang, expected, '系统默认始终跟随系统语言，而不是 lang.txt')
})

test('另一个实例改了 settings.json 后，运行时语言跟着文件走，不再和下拉打架', async () => {
  await server.stopAll()
  writeFileSync(settingsFile, JSON.stringify({ ...initial, lang: 'zh' }))
  origin = await server.startServer()
  let data = await (await fetch(`${origin}/api/settings`)).json()
  assert.equal(data.lang, 'zh')

  // 模拟安装版 / 另一个窗口直接改设置文件（不经过本进程的保存接口）
  writeFileSync(settingsFile, JSON.stringify({ ...initial, lang: 'en' }))
  data = await (await fetch(`${origin}/api/settings`)).json()
  assert.equal(data.langPref, 'en', '下拉回显文件里的偏好')
  assert.equal(data.lang, 'en', '读设置时把运行时语言对齐到文件，不能一个英文一个中文')
  assert.match(await managerPage(), /data-lang="en"/, '下一次页面渲染也用文件里的语言')
})
