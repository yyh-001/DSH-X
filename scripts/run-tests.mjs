import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// 最重的集成用例排最前面（Longest-Job-First），避免它们排在字母表末尾拉长整轮测试尾延迟。
const HEAVY_FIRST = [
  'test/multi-instance.test.mjs',
  'test/fixed-port.test.mjs',
  'test/environments-launch.test.mjs',
  'test/self-restart.test.mjs',
  'test/environment-export.test.mjs',
  'test/environment-import.test.mjs',
  'test/lan-instance.test.mjs',
  'test/environment-update-api.test.mjs',
  'test/update-channel-launch.test.mjs',
  'test/stop-reap.test.mjs',
  'test/profile-operations.test.mjs',
  'test/plugin-command-version.test.mjs',
  'test/profile-rename.test.mjs',
  'test/launch-copy-profile.test.mjs',
  'test/update-channel-plans.test.mjs',
  'test/environments-api.test.mjs',
  'test/auto-launch.test.mjs',
  'test/profile-delete.test.mjs',
  'test/system-path-api.test.mjs',
  'test/packs-api.test.mjs',
]

function collectTests() {
  const found = []
  const testDir = join(ROOT, 'test')
  for (const name of readdirSync(testDir)) {
    if (name.endsWith('.test.mjs')) found.push(`test/${name}`)
  }
  const pluginsDir = join(ROOT, 'plugins')
  if (existsSync(pluginsDir)) {
    for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue
      const pTest = join(pluginsDir, plugin.name, 'test')
      if (!existsSync(pTest)) continue
      for (const name of readdirSync(pTest)) {
        if (name.endsWith('.test.mjs')) found.push(`plugins/${plugin.name}/test/${name}`)
      }
    }
  }
  const rank = new Map(HEAVY_FIRST.map((file, index) => [file, index]))
  return found.sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER
    return ra !== rb ? ra - rb : a.localeCompare(b)
  })
}

const extraArgs = process.argv.slice(2)
const hasExplicitFiles = extraArgs.some((arg) => !arg.startsWith('-'))
const hasConcurrency = extraArgs.some((arg) => arg.startsWith('--test-concurrency'))
const cores = availableParallelism()
// Windows 上同时起太多 taskkill / node / npm 子进程会剧烈争抢进程创建锁，把并发收在 8 以内总耗时更短。
const defaultConcurrency = process.platform === 'win32'
  ? Math.min(8, Math.max(4, cores - 2))
  : Math.max(2, cores - 1)

const nodeArgs = [
  '--test',
  ...(hasConcurrency ? [] : [`--test-concurrency=${defaultConcurrency}`]),
  ...extraArgs,
  ...(hasExplicitFiles ? [] : collectTests()),
]

const child = spawn(process.execPath, nodeArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    DSH_SKIP_RSS_PROBE: '1',
    DSH_REGISTRY_RETRY_MS: '40',
    ...process.env,
  },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
