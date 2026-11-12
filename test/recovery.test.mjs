import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { latestRecovery, listPatchBackups, lockIsActive, nextBackupPath, restoreProfileBackup, sanitizeProfile, withProfileLock } from '../src/recovery.js'

/** 一份最小 profile：清单（bundles）+ 可选的补丁层。 */
function makeProfile({ bundles, patch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
  if (bundles) writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'web', dsh: { profile: { bundles } } }, null, 2)}\n`)
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const bundlesOf = (dir) => manifestOf(dir).dsh.profile.bundles
const patchOf = (dir) => join(dir, 'cordis.patch.yml')

test('安全启动：补丁层改名备份、第三方 bundle 摘掉、官方条目保留、侧车记下被摘的', async () => {
  const dir = makeProfile({
    bundles: ['@deepseek-ai/dsh-web-app', '@modusensus/dsh-mneme', 'dsh-x-memory', '@deepseek-ai/dsh-schedule'],
    patch: '[]\n',
  })
  const result = await sanitizeProfile(dir)
  assert.match(result.backup, /cordis\.patch\.yml\.bak-\d+$/, '备份名带时间戳')
  assert.equal(existsSync(patchOf(dir)), false, '补丁层被改名移走，不再挡启动')
  assert.equal(readFileSync(result.backup, 'utf8'), '[]\n', '备份内容就是原补丁层')
  assert.deepEqual(bundlesOf(dir), ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-schedule'], '只留官方 bundle')
  assert.deepEqual(result.dropped, ['@modusensus/dsh-mneme', 'dsh-x-memory'], '返回被摘掉的清单')
  const sidecar = JSON.parse(readFileSync(`${result.backup}.json`, 'utf8'))
  assert.deepEqual(sidecar.dropped, result.dropped)
  assert.equal(result.warning, undefined)
})

test('安全启动：本来就没有补丁层也照常摘 bundle', async () => {
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-web-app', 'third-party-plugin'] })
  const result = await sanitizeProfile(dir)
  assert.equal(result.backup, null)
  assert.deepEqual(bundlesOf(dir), ['@deepseek-ai/dsh-web-app'])
})

test('安全启动：清单坏掉时补丁层照样备份，只是不动 bundles 并给出告警', async () => {
  const dir = makeProfile({ patch: '[]\n' })
  writeFileSync(join(dir, 'package.json'), '{ 这不是 JSON')
  const result = await sanitizeProfile(dir)
  assert.match(result.backup, /\.bak-\d+$/)
  assert.equal(existsSync(patchOf(dir)), false)
  assert.match(result.warning, /清单没动/)
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{ 这不是 JSON', '坏清单原样留着')
})

test('备份撞名：同一毫秒的第二次备份加序号', () => {
  const dir = makeProfile({})
  const patch = patchOf(dir)
  writeFileSync(patch, 'x')
  const first = nextBackupPath(patch, 1000)
  writeFileSync(first, 'x')
  const second = nextBackupPath(patch, 1000)
  writeFileSync(second, 'x')
  assert.equal(first, `${patch}.bak-1000`)
  assert.equal(second, `${patch}.bak-1000-1`)
  assert.equal(nextBackupPath(patch, 1000), `${patch}.bak-1000-2`)
})

test('还原：补丁层回到原位，被摘的 bundle 放回清单，侧车清掉', async () => {
  const dir = makeProfile({
    bundles: ['@deepseek-ai/dsh-web-app', 'third-party-plugin'],
    patch: '[]\n',
  })
  const { backup, dropped } = await sanitizeProfile(dir)
  const result = await restoreProfileBackup(dir, backup)
  assert.equal(result.restored, backup.split(/[\\/]/).pop())
  assert.equal(readFileSync(patchOf(dir), 'utf8'), '[]\n', '补丁层原样回来')
  assert.deepEqual(bundlesOf(dir), ['@deepseek-ai/dsh-web-app', 'third-party-plugin'])
  assert.deepEqual(result.restoredBundles, dropped)
  assert.equal(existsSync(`${backup}.json`), false, '侧车用完就删')
  assert.deepEqual(listPatchBackups(dir), [], '还原后没有可还原的备份了')
})

test('还原：现役补丁先挪到新备份，不覆盖用户后来改的东西', async () => {
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-web-app', 'third-party-plugin'], patch: '[]\n' })
  const { backup } = await sanitizeProfile(dir)
  writeFileSync(patchOf(dir), '[] # 安全启动之后用户又改过\n')
  const result = await restoreProfileBackup(dir, backup)
  // 快机器可能在同一毫秒完成恢复；撞名加序号仍是合法的新备份。
  assert.match(result.movedAside, /\.bak-\d+(?:-\d+)?$/)
  assert.notEqual(result.movedAside, backup, '不能覆盖原备份')
  assert.equal(readFileSync(result.movedAside, 'utf8'), '[] # 安全启动之后用户又改过\n')
  assert.equal(readFileSync(patchOf(dir), 'utf8'), '[]\n')
})

test('还原：只认 profile 目录里的备份命名，别的一律拒绝', async () => {
  const dir = makeProfile({ patch: '[]\n' })
  writeFileSync(join(dir, 'cordis.patch.yml.bak'), 'x')
  for (const bad of ['../../etc/passwd', 'cordis.patch.yml.bak', 'other.yml', '', null]) {
    // 名字校验是同步抛的，包一层 async 才能交给 assert.rejects 校验
    await assert.rejects(async () => restoreProfileBackup(dir, bad), /只认 profile 目录里的补丁层备份/, String(bad))
  }
  await assert.rejects(async () => restoreProfileBackup(dir, 'cordis.patch.yml.bak-123'), /不在了/)
})

test('备份列表：新到旧、忽略侧车文件、带上被摘清单', async () => {
  const dir = makeProfile({})
  writeFileSync(join(dir, 'cordis.patch.yml.bak-1000'), 'a')
  writeFileSync(join(dir, 'cordis.patch.yml.bak-2000'), 'b')
  writeFileSync(join(dir, 'cordis.patch.yml.bak-2000.json'), JSON.stringify({ at: 2000, dropped: ['x'] }))
  writeFileSync(join(dir, 'cordis.patch.yml.bak'), 'old')
  const list = listPatchBackups(dir)
  assert.deepEqual(list.map((item) => item.name), ['cordis.patch.yml.bak-2000', 'cordis.patch.yml.bak-1000'])
  assert.deepEqual(list[0].dropped, ['x'])
  assert.equal(list[0].at, 2000)
  assert.equal(list[1].dropped, null)
  assert.equal(list[1].at, null)
})

test('最近一次安全启动：管理器重启后仍能从侧车认出来，还原后消失', async () => {
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-web-app', 'third-party-plugin'], patch: '[]\n' })
  assert.equal(latestRecovery(dir), null, '什么都没做过时没有恢复档')
  const { backup, dropped } = await sanitizeProfile(dir)
  const found = latestRecovery(dir)
  assert.equal(found.backup, backup)
  assert.deepEqual(found.dropped, dropped)
  assert.ok(Number.isFinite(found.at), '侧车里的时间要带出来')
  // 普通改名（还原前挪开的现役补丁）没有侧车，不能被当成「安全启动」的恢复档
  const moved = nextBackupPath(patchOf(dir))
  writeFileSync(moved, 'newer')
  assert.equal(latestRecovery(dir).backup, backup, '新但没有侧车的备份不参与')
  await restoreProfileBackup(dir, backup)
  assert.equal(latestRecovery(dir), null, '还原后入口跟着收掉')
})

test('profile 锁：同步/异步操作都能拿返回值，用完就放锁', async () => {
  const dir = makeProfile({})
  assert.equal(await withProfileLock(dir, () => 'sync'), 'sync')
  assert.equal(await withProfileLock(dir, async () => 'async'), 'async')
  assert.equal(existsSync(join(dir, 'lock')), false, '锁文件用完就删')
})

test('profile 锁：有人在用就拒绝，僵死锁清掉重来', async () => {
  const dir = makeProfile({})
  const lockPath = join(dir, 'lock')
  writeFileSync(lockPath, String(process.pid))
  await assert.rejects(() => withProfileLock(dir, () => 'never'), /另一个 profile 操作正在进行/)
  assert.equal(existsSync(lockPath), true, '活锁不动它')
  assert.equal(lockIsActive(lockPath), true, '自己这个进程当然活着')
  const gone = () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error }
  assert.equal(lockIsActive(lockPath, gone), false, '探针说属主没了 → 僵死')
  // 僵死锁：清掉重来，操作照常跑完，锁用完释放
  assert.equal(await withProfileLock(dir, () => 'ok', gone), 'ok')
  assert.equal(existsSync(lockPath), false)
})

test('连着安全启动两次：提示指向最早那份（用户真正的配置），还原后整串收掉，不会冒出旧的', async () => {
  const dir = makeProfile({ bundles: ['@deepseek-ai/dsh-web-app', 'plugin-a'], patch: 'user-config\n' })
  const first = await sanitizeProfile(dir)
  // 中间 dsh 自己重建了补丁层，用户又装了一个插件，再安全启动一次
  writeFileSync(patchOf(dir), '[]\n')
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', 'plugin-b'] } } }, null, 2)}\n`)
  const second = await sanitizeProfile(dir)
  assert.notEqual(first.backup, second.backup)
  const found = latestRecovery(dir)
  assert.equal(found.backup, first.backup, '最早那份里才是用户的补丁层')
  assert.deepEqual(found.dropped.sort(), ['plugin-a', 'plugin-b'], '两次摘掉的 bundle 合起来')
  const result = await restoreProfileBackup(dir, found.backup)
  assert.equal(readFileSync(patchOf(dir), 'utf8'), 'user-config\n')
  assert.deepEqual(result.restoredBundles.sort(), ['plugin-a', 'plugin-b'])
  assert.deepEqual(bundlesOf(dir).sort(), ['@deepseek-ai/dsh-web-app', 'plugin-a', 'plugin-b'])
  assert.equal(latestRecovery(dir), null, '还原了一份，这一串都算处理过了')
})

test('备份列表：同一毫秒撞名的 -1 序号按时间排在原备份之后（更新），不沉到最旧', () => {
  const dir = makeProfile({ patch: '[]\n' })
  const patch = patchOf(dir)
  writeFileSync(`${patch}.bak-1000`, 'a')
  writeFileSync(`${patch}.bak-2000`, 'b')
  writeFileSync(`${patch}.bak-2000-1`, 'c')
  assert.deepEqual(listPatchBackups(dir).map((item) => item.name), [
    'cordis.patch.yml.bak-2000-1', 'cordis.patch.yml.bak-2000', 'cordis.patch.yml.bak-1000',
  ])
})
