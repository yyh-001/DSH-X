/**
 * 仓库里那份「DSH-X 推荐整合包」必须过得了启动器自己的解析器。
 *
 * 这层保障的意义：包是发出去给别人装的，格式错了对方会看到一句「不是整合包」，
 * 而我们这边什么都发现不了。所以清单字段、层栈、依赖都在这里钉一遍；
 * 顺手把 .dspack 产物也打一次并回读（打包脚本与解析器之间的约定同样在漂移风险里）。
 *
 * 配方现在是「内置环境」：导入时只取 DSH 版本和插件清单建一个环境，不再整包装进某个 Profile，
 * 所以这里验的是「能不能变成一个完整的环境」，而不是往 Profile 里写什么。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { environmentFromPack, hasProfileData } from '../src/environment-pack.js'
import { parsePackArchive, parsePackDir } from '../src/packs.js'
import { writeZip } from '../src/zip.js'

const PACK_DIR = fileURLToPath(new URL('../src/packs/dsh-x-recommended', import.meta.url))
const WORKBENCH_DIR = fileURLToPath(new URL('../src/packs/dsh-x-workbench', import.meta.url))
const OFFICIAL = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

test('推荐整合包：清单合法、层栈与依赖对得上、装的是那份配置管理插件', () => {
  const pack = parsePackDir(PACK_DIR)
  assert.deepEqual(pack.errors, [], '清单不能有错')
  assert.equal(pack.ok, true)
  assert.equal(pack.fields.name, 'dsh-x-recommended')
  assert.equal(pack.fields.type, 'profile')
  // 环境只锁直接依赖，缺 package.json 快照、缺补丁层都不再提示；配方自己的包一条警告都不该有
  assert.deepEqual(pack.warnings, [], '配方解析不能有警告')
  // 每个 bundle 都必须在 dependencies 里有对应版本，否则 dsh 装不出来
  for (const bundle of pack.fields.bundles) {
    assert.ok(pack.fields.dependencies[bundle], `${bundle} 在 bundles 里，dependencies 里也要有它`)
  }
  assert.ok(pack.fields.dependencies['dsh-config-manager'], '配置管理插件是这份包的核心成员')
  assert.match(pack.fields.dependencies['dsh-config-manager'], /^\^\d+\.\d+\.\d+$/, '版本要钉范围，别写 latest')
  // 人看的说明与包内自述都要在
  assert.ok((pack.displayName || pack.fields.name).length > 0)
  assert.ok(readFileSync(join(PACK_DIR, 'README.md'), 'utf8').includes('dsh-config-manager'))
})

test('推荐整合包：能变成一个环境——插件清单完整、官方组件在前，没有要导进 Profile 的配置', () => {
  const pack = parsePackDir(PACK_DIR)
  const env = environmentFromPack(pack)
  assert.equal(env.ok, true, env.errors.join('；'))
  assert.equal(env.packId, 'dsh-x-recommended')
  assert.ok(env.dshVersion, '配方写了 DSH 版本要求，导入时据此挑版本')
  // 老配方的 bundles 只列插件：变成环境后官方组件（Profile 骨架那两个）要补在最前面，dsh 才起得来
  assert.deepEqual(env.list.bundles.slice(0, 2), OFFICIAL)
  assert.deepEqual(env.list.dependencies, pack.fields.dependencies, '插件和版本原样进环境')
  for (const name of pack.fields.bundles) assert.ok(env.list.bundles.includes(name), `${name} 要挂载，否则 dsh 不加载`)
  assert.equal(env.offline.length, 0, '配方全从 npm 装，没有离线文件')
  assert.equal(hasProfileData(env.profileData), false, '推荐配方不带配置，导入时没有「导进 Profile」这一项')
})

test('桌面工作台：两份技能是 Profile 的数据，导入时单列成可选项，不进环境', () => {
  const env = environmentFromPack(parsePackDir(WORKBENCH_DIR))
  assert.equal(env.ok, true, env.errors.join('；'))
  assert.equal(hasProfileData(env.profileData), true, '技能要能选着导进 Profile')
  for (const skill of ['agent-browser', 'electron']) {
    assert.ok(env.profileData.home.some((path) => path.startsWith(`skills/${skill}/`)), `技能 ${skill} 要列在配置里`)
  }
  assert.ok(!Object.keys(env.list.dependencies).some((name) => name.includes('skills')), '技能不是插件，不进插件清单')
})

test('推荐整合包：打成 .dspack 之后仍然能被认出来（打包脚本的约定）', () => {
  const pack = parsePackDir(PACK_DIR)
  const archive = writeZip([
    { name: 'manifest.json', data: readFileSync(join(PACK_DIR, 'manifest.json')) },
    { name: 'dspack.json', data: readFileSync(join(PACK_DIR, 'dspack.json')) },
    { name: 'README.md', data: readFileSync(join(PACK_DIR, 'README.md')) },
  ])
  const back = parsePackArchive(archive)
  assert.equal(back.ok, true, back.errors.join('；'))
  assert.equal(back.fields.name, pack.fields.name)
  assert.deepEqual(back.fields.bundles, pack.fields.bundles)
  assert.deepEqual(back.fields.dependencies, pack.fields.dependencies)
})

test('打包脚本在仓库里，且能把包目录打成产物', () => {
  const script = fileURLToPath(new URL('../scripts/make-pack.mjs', import.meta.url))
  assert.ok(existsSync(script), 'scripts/make-pack.mjs 要在（README 教用户用它）')
})
