/**
 * 起那些被 dsh CLI 在参数解析阶段拒掉的 profile 名（现在只有 `desktop`，官方留给自己的
 * Electron 端）。CLI 的拦截在 `lib/bin.js` 的 `rejectElectronProfile()`，而底下的 boot 层
 * 根本不认这个名字 —— 官方桌面端自己也是直接调 `runProfile` 的，这里走同一条路。
 *
 * 用法与 CLI 的位置参数形式一致：`node reserved-profile-boot.mjs <profile> [app-args...]`，
 * 所以启动器只在「保留名」这个分支上把入口从 `lib/bin.js` 换成它，argv 一个字都不用改。
 *
 * 第一个参数是版本目录里的 `lib/bin.js`：用它当锚点解析出 dsh 包，所以启动器装的版本和
 * 系统里那份 dsh 都能找到各自的那份 profile-boot。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [anchor, ...argv] = process.argv.slice(2)
const args = [...argv]
const profile = args[0] !== undefined && /^[A-Za-z0-9._-]{1,32}$/.test(args[0]) ? args.shift() : ''
if (!anchor || !profile) {
  process.stderr.write('error: usage: reserved-profile-boot.mjs <path/to/lib/bin.js> <profile> [app-args...]\n')
  process.exit(2)
}

const require = createRequire(anchor)
/** 解析一个包，解析不到就用退路（老版本 dsh 没把 profile-boot 写进 exports 表）。 */
const resolveIn = (id, fallback) => {
  try {
    return require.resolve(id)
  } catch {
    return fallback
  }
}
const entry = resolveIn('@deepseek-ai/dsh/profile-boot', join(dirname(anchor), 'profile-boot.js'))
const boot = require.resolve('@deepseek-ai/dsh-app-boot')

const { runProfile } = await import(pathToFileURL(entry).href)
const { loadLayeredEnv } = await import(pathToFileURL(boot).href)

// 与 bin.js 的 profile 分支逐项对齐：同样的 environment、空 patch 列表，app 参数原样透传。
await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args,
})
