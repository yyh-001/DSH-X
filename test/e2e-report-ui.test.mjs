/**
 * 2026-11-21 管理页巡检（docs/bug-hunt-2026-11-21.md）里的 S1–S4、S6、S8、S9：
 * 都是页面脚本的结构问题，这里直接读源码钉住，免得以后改回去。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const html = read('../src/public/index.html')
const enJs = read('../src/public/i18n-en.js')
const mcpSkillsJs = read('../src/public/mcp-skills-page.js')
const envPage = read('../src/public/environments-page.js')
const css = read('../src/public/launcher.css')
const markup = html.slice(html.indexOf('<body'), html.indexOf('<script src="/log-view.js"'))
const EN_KEYS = new Set([...enJs.matchAll(/^ {2}"((?:[^"\\]|\\.)+)":/gm)].map((match) => match[1]))

test('S1：配置名的 pattern 在浏览器的 v 模式下能编译，真的拦得住坏名字', () => {
  const statics = [...html.matchAll(/id="profileName"[^>]*pattern="([^"]+)"/g)].map((match) => match[1])
  const dynamics = [...html.matchAll(/profileNameEl\.pattern = '([^']+)'/g)].map((match) => match[1].replace(/\\\\/g, '\\'))
  assert.equal(statics.length, 1)
  assert.equal(dynamics.length, 1)
  for (const pattern of [...statics, ...dynamics]) {
    // 浏览器按 ^(?:pattern)$ 加 v 标志编译；编译失败时 validity 永远是 valid
    const regex = new RegExp(`^(?:${pattern})$`, 'v')
    assert.equal(regex.test('my-work'), true)
    assert.equal(regex.test('a.b_c-1'), true)
    assert.equal(regex.test('bad name!!'), false)
    assert.equal(regex.test('-lead'), false)
  }
})

test('S2：历史、MCP 弹窗能按 Esc 关；下拉没展开时不吞 Esc；焦点丢了也有兜底', () => {
  assert.match(html, /trapPackDialog\(backupDialogEl, closeProfileBackups\)/)
  assert.match(mcpSkillsJs, /trapPackDialog\(mcpDialogEl, closeMcpDialog\)/)
  assert.match(html, /if \(event\.key === 'Escape'\) \{ if \(openUiSelect === item\) \{ closeUiSelect\(\); event\.stopPropagation\(\) \} return \}/)
  assert.doesNotMatch(html, /if \(event\.key === 'Escape'\) \{ closeUiSelect\(\); event\.stopPropagation\(\); return \}/)
  // 关闭按钮挪位置会失焦（焦点落回 body，弹窗的 keydown 就收不到 Esc）
  assert.doesNotMatch(html, /\.append\(document\.getElementById\('launchPluginsClose'\)\)/)
  assert.match(html, /function moveKeepingFocus\(parent, element\)/)
  assert.match(html, /escDialogClosers\.set\(launchPluginsDialogEl, closeLaunchPlugins\)/)
  assert.match(html, /document\.activeElement === document\.body\) \{[\s\S]{0,300}escDialogClosers/)
})

test('S3：切语言之后重画动态列表（两处改语言的地方都调）', () => {
  const calls = [...html.matchAll(/lang = data\.lang === 'en' \? 'en' : 'zh'\r?\n\s+applyLang\(\)\r?\n\s+repaintForLang\(\)/g)]
  assert.equal(calls.length, 2)
  const body = html.slice(html.indexOf('function repaintForLang()'), html.indexOf('// ---- 版本下拉'))
  for (const painter of ['paintLaunchHome', 'renderMcp', 'renderSkillList', 'renderPackGrid', 'environmentState.repaint']) {
    assert.ok(body.includes(painter), `重画 ${painter}`)
  }
  assert.match(envPage, /environmentState\.repaint = \(\) => paint\(\)/)
})

test('S4：静态结构里的中文 title / aria-label 都带翻译标记，且都有英文', () => {
  // 这些按钮的 title 由 applyLang 的 id 清单、齿轮或首页重画按状态动态写
  const dynamic = new Set(['launchManageVersions', 'update', 'remove', 'launchRecover', 'mcpAdd', 'mcpProbe', 'mcpRefresh', 'versionManageCheck', 'settingsEntry', 'launchAdd'])
  const missing = []
  for (const [tag] of markup.matchAll(/<[a-zA-Z][^<>]*>/g)) {
    const id = /\sid="([^"]*)"/.exec(tag)?.[1]
    if (id && dynamic.has(id)) continue
    for (const [attr, marker] of [['title', 'data-i18n-title'], ['aria-label', 'data-i18n-aria-label']]) {
      const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1]
      if (value && /[一-鿿]/.test(value) && !tag.includes(marker)) missing.push(`${attr}=${value}`)
    }
  }
  assert.deepEqual(missing, [])
  const untranslated = [...html.matchAll(/data-i18n-(?:title|aria-label)="([^"]+)"/g)].map((match) => match[1]).filter((key) => !EN_KEYS.has(key))
  assert.deepEqual([...new Set(untranslated)], [])
  const mascot = read('../src/public/mascot.js')
  assert.match(mascot, /data-i18n-aria-label="互动看板娘"/)
  assert.ok(EN_KEYS.has('互动看板娘'))
})

test('S6：市场分类芯片行被裁时两头渐隐', () => {
  assert.match(envPage, /function syncCategoryFade\(\)/)
  assert.match(envPage, /addEventListener\?\.\('scroll', syncCategoryFade/)
  assert.match(css, /\.plugin-market-tabs\.fade-end \{[^}]*mask-image/)
  assert.match(css, /\.plugin-market-tabs\.fade-start \{[^}]*mask-image/)
})

test('S7：没有可备份内容时页面说明原因', () => {
  assert.match(html, /data\.reason === 'uninitialized' \? t\('这个配置还没有可备份的内容/)
  assert.ok(EN_KEYS.has('这个配置还没有可备份的内容：启动一次实例后才会生成配置文件。'))
})

test('S8：打开方式下拉放得下英文选项名，提示与选中值说的是同一件事', () => {
  assert.match(css, /\.set-control \.ui-select:has\(#openMode\) \{ width: 220px; \}/)
  assert.match(html, /t\('已选「DSH-X 内部标签页」；这个管理页开在浏览器里/)
  assert.doesNotMatch(html, /内部标签页需使用新版 DSH-X 桌面端；当前使用浏览器标签页/)
})

test('S9：从实例打开的历史弹窗写实例名', () => {
  assert.match(envPage, /openProfileBackupsForInstance\?\.\(env\?\.targetProfile \|\| 'web', env\?\.targetHome \|\| '', env\?\.name \|\| ''\)/)
  assert.match(html, /function openProfileBackups\(profile, home = '', instanceName = ''\)/)
  assert.ok(EN_KEYS.has('实例「{name}」（配置 {profile}）的配置层快照 · 最多保留 10 份 / 30 天'))
})
