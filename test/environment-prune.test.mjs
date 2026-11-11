/**
 * 环境钉住的 DSH 版本不被自动清理（系统测试）：进程内真服务 + 离线假 npm registry（DSH 能真装上）。
 *
 * 需求（只按需求写预期，不读实现）：
 *   N10 环境钉的 DSH 版本（精确版本，不是 auto）在装了别的 DSH 版本、触发自动清理时不被删——哪怕没有任何启动项用这个环境
 *       （导入环境时自动装上的 DSH，在还没有启动项用它之前就被清掉，下次启动又得重装）
 *
 * 为什么单独一个文件：自动清理会删已装版本，改的是整个进程的已装版本表；和导出用例放一起会把它们要的版本删掉。
 * 设计：对照组——同样没人用的旧版本要被清掉（证明清理确实跑了），被环境钉住的那个留下；auto 的环境不钉任何版本。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'
import { recordingBin } from './environments-fixture.mjs'
import { dshTarball, npmUnavailableReason, startNpmRegistry } from './environment-pack-fixture.mjs'

const NO_NPM = npmUnavailableReason()
const PUBLISHED = ['1.0.0', '1.1.0', '1.2.0', '1.3.0']
const env = await startChannelServer({
  prefix: 'dsh-env-prune-',
  packument: packumentOf({ latest: '1.3.0' }, PUBLISHED),
  installed: ['1.0.0', '1.1.0', '1.2.0'],
  bin: recordingBin,
})
const registry = await startNpmRegistry({
  '@deepseek-ai/dsh': { tags: { latest: '1.3.0' }, versions: PUBLISHED, tarballs: { '1.3.0': dshTarball('1.3.0', recordingBin('1.3.0')) } },
})
process.env.npm_config_registry = registry.url
test.after(async () => {
  await env.cleanup()
  await registry.close()
})

async function okPost(path, body) {
  const result = await env.call(path, body)
  assert.ok(result.ok, `${path} 失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  return result.data
}
const versionBin = (version) => join(env.data, 'versions', version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

test('N10 装了新版本触发自动清理：环境钉的 1.0.0 留下（没有启动项用它），没人钉的旧版本被清掉', { skip: NO_NPM }, async () => {
  // 只保留 1 个：除了刚装的和被钉住的，旧版本都该清
  await okPost('/api/settings', { autoCleanVersions: true, keepVersions: 1, downloadSource: 'official', proxyMode: 'off' })
  const { environment } = await okPost('/api/environments/create', { name: '钉 1.0.0', dshVersion: '1.0.0' })
  await okPost('/api/environments/create', { name: '跟最新', dshVersion: 'auto' })
  assert.deepEqual((env.stored().launchPresets || []).filter((item) => item.environment === environment.id), [], '前置条件：没有启动项用这个环境')

  await okPost('/api/install', { version: '1.3.0' })
  assert.ok(existsSync(versionBin('1.3.0')), '前置条件：新版本装上了')
  const removed = ['1.1.0', '1.2.0'].filter((version) => !existsSync(versionBin(version)))
  assert.ok(removed.length > 0, '前置条件：自动清理确实跑了（没人钉的旧版本被清掉）')
  assert.ok(existsSync(versionBin('1.0.0')), '环境钉的 1.0.0 不能被清掉')
})
