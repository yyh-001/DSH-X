import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * profile 配置层备份（每次启动前快照，出事了能回退）。
 * 只备份几十 KB 的配置层文件（补丁层、依赖清单、锁文件、npmrc），不碰几百 MB 的 node_modules。
 */
export const PROFILE_BACKUP_FILES = ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', '.npmrc']
const PROFILE_BACKUP_KEEP = 10
const PROFILE_BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const PROFILE_BACKUP_ID = /^\d{8}-\d{6}(?:-\d+)?$/

function profileBackupTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function readBackupManifest(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    if (!manifest || !Array.isArray(manifest.files)) return null
    return manifest
  } catch { return null }
}

function profileConfigSnapshot(profileDirPath) {
  const files = []
  for (const name of PROFILE_BACKUP_FILES) {
    const file = join(profileDirPath, name)
    if (!existsSync(file)) continue
    try { files.push({ name, content: readFileSync(file) }) } catch { /* 读不了就跳过，别拦启动 */ }
  }
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.name).update('\0').update(file.content)
  return { files, signature: hash.digest('hex') }
}

export function createProfileBackups({
  isWindows,
  getDataDir,
  homeDir,
  defaultHome,
  getDefaultProfile,
  safeProfile,
  profileDirOf,
  profileKey,
  startingProfiles,
  instanceList,
  samePath,
  pushLog,
  isPluginBusy,
  setPluginBusy,
  pluginCommandVersion,
  runProfileInstall,
}) {
  function homeStamp(home = homeDir()) {
    return createHash('sha1').update(isWindows ? home.toLowerCase() : home).digest('hex').slice(0, 12)
  }

  function profileBackupRoot(profile, home = homeDir()) {
    return join(getDataDir(), 'backups', 'profiles', homeStamp(home), safeProfile(profile))
  }

  /** 最近的排前面。目录名是时间戳，但 createdAt 才是权威（手改目录名也不会乱序）。 */
  function listProfileBackups(profile, home = homeDir()) {
    const root = profileBackupRoot(profile, home)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_BACKUP_ID.test(entry.name))
      .map((entry) => ({ id: entry.name, ...readBackupManifest(join(root, entry.name)) }))
      .filter((item) => item.files && item.createdAt)
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
  }

  async function rotateProfileBackups(profile, home = homeDir()) {
    const root = profileBackupRoot(profile, home)
    const backups = listProfileBackups(profile, home)
    const expiredBefore = Date.now() - PROFILE_BACKUP_MAX_AGE_MS
    const stale = backups.filter((item, index) => index >= PROFILE_BACKUP_KEEP || (index > 0 && item.createdAt < expiredBefore))
    for (const item of stale) await rm(join(root, item.id), { recursive: true, force: true })
  }

  /** 给 profile 的配置层拍一份快照；内容跟最近一份一样就不重复存（force 用于回退前）。 */
  async function snapshotProfileConfig(profile, { force = false } = {}) {
    const name = safeProfile(profile || getDefaultProfile())
    const dir = profileDirOf(name)
    if (!existsSync(join(dir, 'package.json'))) return null
    const { files, signature } = profileConfigSnapshot(dir)
    if (!files.length) return null
    const home = homeDir()
    const root = profileBackupRoot(name, home)
    const latest = listProfileBackups(name, home)[0]
    if (!force && latest?.signature === signature) {
      await rotateProfileBackups(name, home)
      return null
    }
    await mkdir(root, { recursive: true })
    const stamp = profileBackupTimestamp()
    let id = stamp
    for (let index = 2; existsSync(join(root, id)); index += 1) id = `${stamp}-${index}`
    const target = join(root, id)
    await mkdir(target)
    for (const file of files) await writeFile(join(target, file.name), file.content)
    const manifest = { profile: name, home, createdAt: Date.now(), signature, files: files.map((file) => ({ name: file.name, size: file.content.length })) }
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await rotateProfileBackups(name, home)
    return { id, ...manifest }
  }

  /** 回退到某份配置快照：先给当前状态再存一份，所以回退本身也能再退回来。 */
  async function restoreProfileConfig(profile, id) {
    const name = safeProfile(profile || getDefaultProfile())
    if (!PROFILE_BACKUP_ID.test(String(id || ''))) throw new Error('备份编号不对')
    const home = homeDir()
    const root = profileBackupRoot(name, home)
    const source = join(root, String(id))
    const manifest = readBackupManifest(source)
    if (!manifest) throw new Error('找不到这份备份')
    if (!manifest.files.some((file) => file.name === 'package.json')) throw new Error('这份备份里没有 package.json，回退会让配置起不来')
    const busy = startingProfiles.has(profileKey(name))
      || instanceList().some((proc) => proc.profile === name && samePath(proc.home || defaultHome(), home) && ['starting', 'running', 'stopping'].includes(proc.status))
    if (busy) throw new Error('请先停止这个配置的实例再回退')
    const dir = profileDirOf(name)
    const saved = await snapshotProfileConfig(name, { force: true })
    for (const file of PROFILE_BACKUP_FILES) {
      const target = join(dir, file)
      const included = manifest.files.some((entry) => entry.name === file)
      if (included) await writeFile(target, readFileSync(join(source, file)))
      else if (existsSync(target)) await rm(target, { force: true })
    }
    pushLog(`[备份] 配置 ${name} 回退到 ${id}${saved ? `（回退前已存一份 ${saved.id}）` : ''}`)
    return { ok: true, restored: String(id), backup: saved }
  }

  async function deleteProfileBackup(profile, id) {
    const name = safeProfile(profile || getDefaultProfile())
    const backupId = String(id || '')
    if (!PROFILE_BACKUP_ID.test(backupId)) throw new Error('备份编号不对')
    const target = join(profileBackupRoot(name, homeDir()), backupId)
    if (!readBackupManifest(target)) throw new Error('找不到这份备份')
    await rm(target, { recursive: true, force: true })
    pushLog(`[备份] 配置 ${name} 删除备份 ${backupId}`)
    return { ok: true, deleted: backupId }
  }

  /** 配置层回退之后按清单重装依赖，让 node_modules 与还原后的 package.json 对齐。 */
  async function reinstallAfterRollback(profile) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(profileDirOf(profile), 'package.json'), 'utf8'))
    } catch {
      return { ok: true, skipped: true }
    }
    const dependencies = manifest?.dependencies
    if (!dependencies || typeof dependencies !== 'object' || !Object.keys(dependencies).length) return { ok: true, skipped: true }
    if (isPluginBusy()) return { ok: false, error: '正在装插件或整合包，跳过依赖重装' }
    let version
    try {
      version = await pluginCommandVersion(profile)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (isPluginBusy()) return { ok: false, error: '正在装插件或整合包，跳过依赖重装' }
    setPluginBusy(true)
    try {
      await runProfileInstall(version, { profile })
      pushLog(`[备份] 配置 ${profile} 回退后已重装依赖`)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`[备份] 配置 ${profile} 回退后重装依赖失败：${message}`)
      return { ok: false, error: message }
    } finally {
      setPluginBusy(false)
    }
  }

  return {
    listProfileBackups,
    rotateProfileBackups,
    snapshotProfileConfig,
    restoreProfileConfig,
    deleteProfileBackup,
    reinstallAfterRollback,
  }
}
