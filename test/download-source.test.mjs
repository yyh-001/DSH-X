import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { currentRegistry } from '../registry.js'
import { DEFAULTS, DEFAULT_SOURCE, DOWNLOAD_SOURCES, safeDownloadSource } from '../settings.js'

const read = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
const html = read('public/index.html')
const server = read('server.js')
const registry = read('registry.js')

// 下载源：镜像源同步官方有延迟（「检查到更新却装不上」就是这么来的），所以给用户一个
// 切官方源的开关。这几条钉的是「切了真的全链路都换源」和「脏值不会把源弄丢」。

test('下载源只认内置选项，脏值回默认镜像', () => {
  assert.equal(DEFAULT_SOURCE, 'mirror')
  assert.equal(DEFAULTS.downloadSource, 'mirror')
  assert.equal(safeDownloadSource('official'), 'official')
  assert.equal(safeDownloadSource('mirror'), 'mirror')
  for (const bad of ['', null, undefined, 'npmjs', 'https://registry.npmjs.org', 42, {}]) {
    assert.equal(safeDownloadSource(bad), 'mirror', JSON.stringify(bad))
  }
  assert.equal(DOWNLOAD_SOURCES.mirror, 'https://registry.npmmirror.com')
  assert.equal(DOWNLOAD_SOURCES.official, 'https://registry.npmjs.org')
})

test('当前源：环境变量优先，否则落到设置里的源', () => {
  const before = process.env.npm_config_registry
  try {
    process.env.npm_config_registry = 'https://example.test/npm/'
    assert.equal(currentRegistry(), 'https://example.test/npm', '环境变量优先，且去掉末尾斜杠')
    delete process.env.npm_config_registry
    assert.ok(
      Object.values(DOWNLOAD_SOURCES).includes(currentRegistry()),
      `没设环境变量时应落到设置里的源（拿到的是 ${currentRegistry()}）`,
    )
  } finally {
    if (before === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = before
  }
})

test('registry.js 里不再有写死的源，缓存和 .npmrc 都跟着当前源', () => {
  assert.doesNotMatch(registry, /^export const REGISTRY =/m, '写死的 REGISTRY 常量应该没有了')
  assert.match(registry, /export function currentRegistry\(\)/)
  // 缓存按源分开：切源之后不能读到另一个源的旧结果
  assert.match(registry, /const cacheKey = `\$\{registry\}\/\$\{name\}`/)
  assert.match(registry, /registry=\$\{currentRegistry\(\)\}/, '安装目录的 .npmrc 每次现写当前源')
  assert.match(registry, /npm_config_registry: currentRegistry\(\)/, '下载时把源透给 npm')
})

test('服务端把可选项给页面，切源顺手作废更新检查缓存', () => {
  assert.match(server, /downloadSources: \[\s*\{ id: 'mirror', label: '镜像源' \},\s*\{ id: 'official', label: '官方源' \},/)
  assert.match(server, /\('downloadSource' in body \? \{ downloadSource: safeDownloadSource\(body\.downloadSource\) \}/, '保存时校验')
  assert.match(
    server,
    /if \('downloadSource' in body\) \{\s*remoteCache = \{ at: 0, data: null \}/,
    '更新检查有 60s 缓存，切源要立刻作废，否则新源要等一分钟才生效',
  )
})

test('设置页有下载源选择器：改动即保存，并说明两种源各自的代价', () => {
  assert.match(html, /<span class="set-name" data-i18n="下载源">下载源<\/span>[\s\S]{0,400}?<select id="downloadSource">/)
  assert.match(html, /sourceEl\.onchange = \(\) => \{[\s\S]{0,120}?queueSetting\('downloadSource', sourceEl\.value\)/, '改动跟着自动保存提交')
  assert.match(html, /sourceEl\.value = String\(data\.downloadSource \|\| 'mirror'\)/, '读设置时回填')
  assert.match(html, /sourceHint\.textContent = describeSource\(sourceEl\.value\)/, '提示行跟着当前源变化')
  assert.match(html, /镜像源：国内下载快/, '镜像源的代价要写出来')
  assert.match(html, /官方源：新版本发布即可安装/, '官方源的代价也要写出来')
})
