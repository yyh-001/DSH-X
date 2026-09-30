/**
 * 「安全启动」恢复档：把 profile 补丁层整体移出启动路径，并在清单里摘掉第三方 bundle。
 *
 * 语义对齐官方 desktop 的 sanitizeProfile（packages/boot/app-boot/src/profile-sanitize.ts）：
 * 备份即改名（不复制、不解析补丁内容）、已装的包不动、补丁层移走后坏 patch 不再挡启动。
 * 两处刻意不同：①清单 JSON 坏掉时只报 warning、不阻止补丁层改名（救援优先，官方是整单失败）；
 * ②额外支持「还原」（把备份改回来并把摘掉的 bundle 放回清单）——官方没有，DSH-X 的管理页要用。
 *
 * 所有函数都收 profileDir 参数（与 plugins.js 同风格），调用方负责传当前/目标 profile 目录。
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { patchPathOf } from './plugins.js'

/** 第三方 = 不在 @deepseek-ai 官方 scope 下的 bundle。 */
const OFFICIAL_BUNDLE_RE = /^@deepseek-ai\//

/** 备份文件名：`cordis.patch.yml.bak-<毫秒>`，撞名再加 `-序号`（与官方同款）。 */
const BACKUP_NAME_RE = /^cordis\.patch\.yml\.bak-\d+(?:-\d+)?$/
/** 侧车文件记着被摘掉的 bundle 列表，还原时放回去。 */
const sidecarOf = (backupPath) => `${backupPath}.json`

/**
 * profile 写独占：目录里一个存 PID 的 `lock` 文件（`wx` 独占创建；已存在则读 PID 探活，
 * 僵死就清掉重试）。与官方 desktop 的锁同名同语义——将来 dsh 自己也用这个名字时天然互斥。
 * @param operation 同步或异步操作，返回它的结果。
 * @param probe 属主探活（默认 process.kill(pid,0)）；用例注入它就无需真造一个死进程。
 */
export async function withProfileLock(profileDir, operation, probe) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  const lockPath = join(profileDir, 'lock')
  let descriptor
  for (let attempt = 0; ; attempt += 1) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (attempt >= 1) throw new Error('profile 锁被占用，稍后再试')
      if (lockIsActive(lockPath, probe)) throw new Error('另一个 profile 操作正在进行，稍后再试')
      unlinkSync(lockPath) // 僵死锁（属主进程已不在）：清掉再来一次
    }
  }
  try {
    writeFileSync(descriptor, String(process.pid))
    return await operation()
  } finally {
    try { closeSync(descriptor) } catch { /* 已经关了 */ }
    try { unlinkSync(lockPath) } catch { /* 已经被清 */ }
  }
}

/** 锁属主还活着吗；`probe` 可注入，便于用例确定性地走「僵死锁」分支。 */
export function lockIsActive(lockPath, probe = (owner) => process.kill(owner, 0)) {
  let owner
  try {
    const info = lstatSync(lockPath)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('profile 锁不是普通文件')
    owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
  } catch {
    return true // 读不动就当作有人在用，宁可不做也别踩
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return true
  try {
    probe(owner)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/** 生成一个不撞名的备份路径；`now` 可注入，便于用例复现撞名分支。 */
export function nextBackupPath(patchPath, now = Date.now()) {
  const base = `${patchPath}.bak-${now}`
  let candidate = base
  for (let ordinal = 0; existsSync(candidate); ordinal += 1) candidate = `${base}-${ordinal + 1}`
  return candidate
}

/** profile 里现存的补丁层备份（新到旧）。侧车在就带上被摘掉的 bundle 列表。 */
export function listPatchBackups(profileDir) {
  let names
  try {
    names = readdirSync(profileDir)
  } catch {
    return []
  }
  return names
    .filter((name) => BACKUP_NAME_RE.test(name))
    .sort((a, b) => Number(b.slice(b.lastIndexOf('-') + 1)) - Number(a.slice(a.lastIndexOf('-') + 1)) || b.localeCompare(a))
    .map((name) => {
      const path = join(profileDir, name)
      let dropped = null
      try {
        const parsed = JSON.parse(readFileSync(sidecarOf(path), 'utf8'))
        if (Array.isArray(parsed?.dropped)) dropped = parsed.dropped
      } catch { /* 没侧车或坏了：只知道有这份备份 */ }
      return { name, path, dropped }
    })
}

/**
 * 安全启动：补丁层改名备份 + 清单里只留官方 bundle。
 * @returns `{ backup, dropped, warning }`：备份路径（本来就没有补丁层时为 null）、
 * 被摘掉的 bundle、以及清单读不动之类的告警（此时补丁层仍已改名）。
 */
export function sanitizeProfile(profileDir) {
  return withProfileLock(profileDir, () => {
    const patchPath = patchPathOf(profileDir)
    const backupPath = nextBackupPath(patchPath)
    let backup = null
    try {
      renameSync(patchPath, backupPath)
      backup = backupPath
    } catch (error) {
      // 本来就没有补丁层：只需处理 bundles
      if (error?.code !== 'ENOENT') throw error
    }
    let dropped = []
    let warning
    const manifestPath = join(profileDir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const bundles = manifest?.dsh?.profile?.bundles
        if (Array.isArray(bundles)) {
          dropped = bundles.filter((name) => !OFFICIAL_BUNDLE_RE.test(name))
          if (dropped.length) {
            manifest.dsh.profile.bundles = bundles.filter((name) => OFFICIAL_BUNDLE_RE.test(name))
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
          }
        }
      } catch (error) {
        warning = `profile 清单没动（${error instanceof Error ? error.message : error}）；补丁层已备份`
      }
    }
    if (backup) writeFileSync(sidecarOf(backup), `${JSON.stringify({ at: Date.now(), dropped }, null, 2)}\n`)
    return { backup, dropped, warning }
  })
}

/**
 * 还原一份补丁层备份：现役补丁先挪到新备份（不覆盖用户后来改的东西），再把选中的备份改回来，
 * 并按侧车把被摘掉的 bundle 放回清单。
 * @param backupPath 备份文件名或路径，必须在 profile 目录里、且符合备份命名。
 */
export function restoreProfileBackup(profileDir, backupPath) {
  const name = basename(String(backupPath ?? ''))
  if (!BACKUP_NAME_RE.test(name)) throw new Error('只认 profile 目录里的补丁层备份（cordis.patch.yml.bak-<时间戳>）')
  return withProfileLock(profileDir, () => {
    const target = join(profileDir, name)
    if (!existsSync(target)) throw new Error(`${name} 不在了`)
    const patchPath = patchPathOf(profileDir)
    let movedAside = null
    if (existsSync(patchPath)) {
      movedAside = nextBackupPath(patchPath)
      renameSync(patchPath, movedAside)
    }
    renameSync(target, patchPath)
    let restoredBundles = []
    const sidecar = sidecarOf(target)
    if (existsSync(sidecar)) {
      try {
        const { dropped } = JSON.parse(readFileSync(sidecar, 'utf8'))
        if (Array.isArray(dropped) && dropped.length) {
          const manifestPath = join(profileDir, 'package.json')
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          const profile = manifest?.dsh?.profile
          if (profile && typeof profile === 'object') {
            const bundles = Array.isArray(profile.bundles) ? profile.bundles : (profile.bundles = [])
            for (const droppedName of dropped) if (!bundles.includes(droppedName)) bundles.push(droppedName)
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
            restoredBundles = dropped
          }
        }
      } catch { /* 侧车或清单坏了：补丁层已经还原，bundle 列表手工改 */ }
      try { unlinkSync(sidecar) } catch { /* 已经不在 */ }
    }
    return { restored: name, movedAside, restoredBundles }
  })
}
