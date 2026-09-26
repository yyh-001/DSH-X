import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { currentRegistry } from '../registry.js'
import { dshEnv } from '../server.js'
import { DEFAULTS, DEFAULT_SOURCE, DEFAULT_UPDATE_SOURCE, DOWNLOAD_SOURCES, migrateUpdateSource, safeDownloadSource, safeUpdateSource, updateUrlCandidates } from '../settings.js'

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

test('dsh 子进程也拿到当前源：插件安装/升级跟着设置一起走', () => {
  // 插件安装/升级是 dsh 自己跑 pnpm，注册表由 pnpm 配置决定；不把源透下去的话，
  // 「检查更新」看的是设置里的源、真正装包却走 pnpm 自己的源（多数机器上是官方默认），
  // 两边不一致。这条钉住「查版本 / 下 dsh / 装插件」用的是同一个源。
  assert.equal(dshEnv('0.0.0-test').npm_config_registry, currentRegistry(), '子进程的 registry 与当前源一致')
  const before = process.env.npm_config_registry
  try {
    process.env.npm_config_registry = 'https://example.test/npm/'
    assert.equal(dshEnv('0.0.0-test').npm_config_registry, 'https://example.test/npm', '手动设的环境变量仍然最高优先')
  } finally {
    if (before === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = before
  }
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
  assert.match(html, /镜像源下载较快/, '镜像源的代价要写出来')
  assert.match(html, /官方源更新及时/, '官方源的代价也要写出来')
})

// 启动器自更新的下载源：默认「国内加速」——它不是「只走镜像」，候选顺序永远是
// 「先直连、失败才按前缀走镜像」，所以能直连的网络一次都碰不到镜像，只是多一条退路；
// 而「直连」在国内等于没有退路（市场索引的域名被 DNS 污染、release 资产的 443 连不上）。
test('更新下载源：默认国内加速，但候选永远是「直连排第一、失败才走镜像」', () => {
  const url = 'https://github.com/yyh-001/DSH-X/releases/latest/download/DSH-Setup.exe'
  assert.equal(DEFAULT_UPDATE_SOURCE, 'mirror', '默认国内加速')
  assert.equal(DEFAULTS.updateSource, 'mirror')
  assert.deepEqual(updateUrlCandidates(url, 'direct'), [url], '只直连时没有镜像候选')
  const mirror = updateUrlCandidates(url, 'mirror')
  assert.equal(mirror[0], url, '直连排第一，成功就不用镜像')
  assert.ok(mirror.length > 1, '国内加速要带上镜像候选')
  for (const candidate of mirror.slice(1)) {
    assert.ok(candidate.endsWith(url), `镜像应该是「前缀 + 原地址」，实际：${candidate}`)
  }
  // 脏值不能把源弄丢，也不该抛错
  assert.deepEqual(updateUrlCandidates(url, '瞎填的'), mirror, '脏值回默认（国内加速）')
  assert.deepEqual(updateUrlCandidates('', 'mirror'), [])
  assert.equal(safeUpdateSource('mirror'), 'mirror')
  assert.equal(safeUpdateSource('瞎填的'), 'mirror', '脏值回新的默认')
})

// 老配置里存着老默认值「直连」的用户迁移到「国内加速」；用户自己选过的源不许动
test('老配置迁移：仍是老默认「直连」的改成国内加速，打过标记的就不动', () => {
  assert.deepEqual(
    migrateUpdateSource({ updateSource: 'direct' }),
    { updateSource: 'mirror', updateSourceMigrated: true },
    '老默认值一次性改成新默认',
  )
  assert.equal(migrateUpdateSource({ updateSource: 'direct', updateSourceMigrated: true }), null, '迁移过就不再动')
  assert.equal(migrateUpdateSource({ updateSource: 'mirror', updateSourceMigrated: true }), null)
  assert.deepEqual(migrateUpdateSource({ updateSource: 'mirror' }), { updateSourceMigrated: true }, '已经是新默认，只补标记')
  assert.deepEqual(migrateUpdateSource({}), { updateSource: 'mirror', updateSourceMigrated: true }, '没存过这个字段的也算老配置')
  assert.equal(migrateUpdateSource(null), null)
  // ensureSettings 里要真接上这条迁移，否则老用户永远停在「直连」
  const settings = read('settings.js')
  assert.match(settings, /const migration = migrateUpdateSource\(stored\)/)
  assert.match(settings, /if \(migration\) Object\.assign\(patch, migration\)/)
})
