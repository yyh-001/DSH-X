/**
 * 仓库里那份「DSH-X 推荐整合包」必须过得了启动器自己的解析器。
 *
 * 这层保障的意义：包是发出去给别人装的，格式错了对方会看到一句「不是整合包」，
 * 而我们这边什么都发现不了。所以清单字段、层栈、依赖都在这里钉一遍；
 * 顺手把 .dspack 产物也打一次并回读（打包脚本与解析器之间的约定同样在漂移风险里）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePackArchive, parsePackDir, planInstall, packSummary } from '../packs.js'
import { writeZip } from '../zip.js'

const PACK_DIR = fileURLToPath(new URL('../packs/dsh-x-recommended', import.meta.url))

test('推荐整合包：清单合法、层栈与依赖对得上、装的是那份配置管理插件', () => {
  const pack = parsePackDir(PACK_DIR)
  assert.deepEqual(pack.errors, [], '清单不能有错')
  assert.equal(pack.ok, true)
  assert.equal(pack.fields.name, 'dsh-x-recommended')
  assert.equal(pack.fields.type, 'profile')
  assert.equal(pack.fields.profileName, 'dshx', '默认装进独立 profile（dshx），不动现有环境')
  for (const warning of pack.warnings) {
    // 只允许「没有 package.json 快照 / 没有补丁层」这两条我们已经知道的提示
    assert.match(warning, /没有 package\.json 快照|没有补丁层/, `不该有别的警告：${warning}`)
  }
  // 每个 bundle 都必须在 dependencies 里有对应版本，否则 dsh 装不出来
  for (const bundle of pack.fields.bundles) {
    assert.ok(pack.fields.dependencies[bundle], `${bundle} 在 bundles 里，dependencies 里也要有它`)
  }
  assert.ok(pack.fields.dependencies['dsh-config-manager'], '配置管理插件是这份包的核心成员')
  assert.match(pack.fields.dependencies['dsh-config-manager'], /^\^\d+\.\d+\.\d+$/, '版本要钉范围，别写 latest')
  // 人看的说明与包内自述都要在
  const summary = packSummary(pack, { lang: 'zh' })
  assert.ok((summary.displayName || summary.name).length > 0)
  assert.ok(readFileSync(join(PACK_DIR, 'README.md'), 'utf8').includes('dsh-config-manager'))
})

test('推荐整合包：装到一份新 profile 的计划说得清、不碰别的目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pack-plan-'))
  const pack = parsePackDir(PACK_DIR)
  const plan = planInstall(pack, { home, profile: 'dshx' })
  assert.equal(plan.ok, true, plan.errors.join('；'))
  assert.equal(plan.createsProfile, true, '新 profile 是包自建的（卸载时可以连目录一起删）')
  const text = JSON.stringify(plan)
  assert.match(text, /dsh-config-manager/, '计划里要能看到这个插件')
  // 写入都落在 profile 目录里（rel 是相对 home 的路径）；凭据、.npmrc、settings.yaml 一律不落盘
  assert.ok(plan.writes.length, '至少要写一份 package.json')
  for (const write of plan.writes) {
    const full = join(home, write.rel)
    assert.ok(full.startsWith(plan.profileDir), `写到 profile 外面了：${write.rel}`)
    assert.doesNotMatch(String(write.rel), /\.credentials\.yaml|\.npmrc|settings\.yaml/)
  }
  const noted = JSON.stringify(plan.notes)
  assert.match(noted, /dsh-config-manager/, '计划里要点出装了哪一层')
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
