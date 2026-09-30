import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listPatchBackups, lockIsActive, nextBackupPath, restoreProfileBackup, sanitizeProfile, withProfileLock } from '../recovery.js'

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
  assert.match(result.movedAside, /\.bak-\d+$/)
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
  writeFileSync(join(dir, 'cordis.patch.yml.bak-2000.json'), JSON.stringify({ dropped: ['x'] }))
  writeFileSync(join(dir, 'cordis.patch.yml.bak'), 'old')
  const list = listPatchBackups(dir)
  assert.deepEqual(list.map((item) => item.name), ['cordis.patch.yml.bak-2000', 'cordis.patch.yml.bak-1000'])
  assert.deepEqual(list[0].dropped, ['x'])
  assert.equal(list[1].dropped, null)
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
