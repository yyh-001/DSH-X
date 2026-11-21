import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

// 这些原生错误描述权限、设备或资源限制，重新下载同一份核心不能修好它们。
// 不按错误文案匹配，也不把 ERR_MODULE_NOT_FOUND 等模块/代码错误混进来。
// 后四个是踩过的坑：Windows 读不了 junction 时 libuv 报 UNKNOWN（errno -4094）、跨盘 rename 是 EXDEV、
// 某些文件系统/杀软拦截给 EINVAL、数据目录在网络盘上会 ETIMEDOUT——都不是核心坏了，按「核心坏」处理
// 会把一个个兼容版本删掉拉黑，再无限重启下载下一个。
const RESOURCE_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO', 'ENODEV', 'ENXIO', 'EBUSY', 'ESTALE', 'UNKNOWN', 'EINVAL', 'EXDEV', 'ETIMEDOUT'])
/** Windows 上 UNKNOWN 的 errno；有的路径只给 errno、code 被包装层改掉，两样都认。 */
const UV_UNKNOWN = -4094
/** 自动恢复（删核心 → 重启）在这个时间窗里最多做几次；再多就停下报错，别在重启和下载之间打转。 */
export const RECOVERY_RELAUNCH_LIMIT = 2
export const RECOVERY_WINDOW_MS = 10 * 60 * 1000
/** 黑名单最多记几个版本：只防「两个坏版本来回切」，成功启动后会整个清掉。 */
const FAILED_LIMIT = 20
const PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP'])
const LISTEN_ERRORS = new Set(['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'])

/** 外壳必须兼容旧核心直接抛出的 Node 系统错误，不能依赖新核心才有的错误标记。 */
export function isEnvironmentStartupError(error, coreDir) {
  if (!error || typeof error.syscall !== 'string' || !error.syscall) return false
  if (RESOURCE_ERRORS.has(error.code) || error.errno === UV_UNKNOWN) return true
  if (error.syscall === 'listen' && LISTEN_ERRORS.has(error.code)) return true
  if (!PATH_ERRORS.has(error.code)) return false
  // mkdir 创建的是启动所需目录；即使用户把 DATA 放进 core/current，创建失败也不能删数据。
  if (error.syscall === 'mkdir') return true
  if (typeof error.path !== 'string' || !isAbsolute(error.path)) return false
  // 核心自身缺文件仍可回退；用户目录的文件/路径出错则保留核心，等用户修复环境后重试。
  // relative 避免把 current-other 当成 current 的子目录，也照顾 Windows 路径大小写。
  const path = relative(coreDir, error.path)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

/** 把恢复边界和落盘动作放在一起，任何入口都先排除环境错误，才允许删核心或记坏版本。 */
export function createCoreRecovery({ appDir, relaunch, log = console.log, now = Date.now }) {
  const activeCore = join(appDir, 'core', 'current')
  const previousCore = join(appDir, 'core', 'previous')
  const pending = join(appDir, 'core', 'pending')
  const failedMark = join(appDir, 'core', 'bootstrap.json')

  function readMark() {
    try {
      const mark = JSON.parse(readFileSync(failedMark, 'utf8'))
      return mark && typeof mark === 'object' ? mark : {}
    } catch { return {} }
  }

  function failedCoreVersions() {
    const mark = readMark()
    const list = Array.isArray(mark.failed) ? mark.failed : [mark.version]
    return list.map((item) => String(item || '')).filter(Boolean)
  }

  /** 时间窗里已经自动重启过几次；时间戳记在 bootstrap.json 的 relaunches 里，跨进程才数得清。 */
  function recentRelaunches(at = now()) {
    const { relaunches } = readMark()
    const list = Array.isArray(relaunches) ? relaunches : []
    return list.map(Number).filter((time) => Number.isFinite(time) && time <= at && at - time < RECOVERY_WINDOW_MS)
  }

  /**
   * 核心成功启动后调用：清掉黑名单和重启计数。黑名单只该挡住「这一轮」起不来的版本——
   * 不清的话，一次误判（环境问题被当成核心坏）会把兼容版本永久拉黑，之后每次重新下载都绕开它们。
   */
  function markHealthy() {
    try { rmSync(failedMark, { force: true }) } catch { /* 删不掉只是少了一次清理 */ }
  }

  function recoverCore(coreDir, { pendingOnly = false, error } = {}) {
    if (coreDir !== activeCore) return false
    if (pendingOnly && !existsSync(pending)) return false
    if (isEnvironmentStartupError(error, coreDir)) return false
    // 先看重启次数再动文件：短时间里已经自动恢复过几次还起不来，多半是没认出来的环境问题，
    // 再删再拉黑只会把剩下的兼容版本也赔进去。留着现场，交给调用方把错误摆给用户看。
    const at = now()
    const relaunches = recentRelaunches(at)
    if (relaunches.length >= RECOVERY_RELAUNCH_LIMIT) {
      log(`核心 ${Math.round(RECOVERY_WINDOW_MS / 60000)} 分钟内已自动恢复 ${relaunches.length} 次仍起不来，停止自动重启`)
      return false
    }
    let version = ''
    try { version = String(JSON.parse(readFileSync(pending, 'utf8')).version || '') } catch { /* 没有 pending 就不记 */ }
    // 先删核心再记坏版本：删不掉说明是权限/文件占用之类的环境问题（不是核心本身），
    // 这时候记进黑名单会永久跳过一个有效版本，还会在「下载 → 删不掉 → 重启」之间循环。
    try {
      rmSync(activeCore, { recursive: true, force: true })
    } catch {
      log('核心删不掉（权限或文件占用），不按坏核心处理')
      return false
    }
    // 保留原来的坏核心保护：首次下载/更新留下的 pending 才能把版本加入黑名单。
    // 列表避免两个坏版本来回切换；旧格式只有 version 一项，读取时继续兼容。
    // 重启时间戳和黑名单写在同一个文件里：没有 pending 的那条路也要计数。
    try {
      const failed = [...new Set([...failedCoreVersions(), version].filter(Boolean))].slice(-FAILED_LIMIT)
      writeFileSync(failedMark, JSON.stringify({ version: version || readMark().version || '', failed, relaunches: [...relaunches, at], at }))
    } catch { /* 写不进去只是少了跳过坏版本和限制重启的保护 */ }
    try { rmSync(pending, { force: true }) } catch { /* ignore */ }
    let restored = false
    try {
      if (existsSync(previousCore)) {
        renameSync(previousCore, activeCore)
        restored = true
      }
    } catch { /* 换不回来就下次启动重新下载 */ }
    log(restored ? '核心启动失败，回退到上一份核心' : '核心启动失败，下次启动重新下载')
    relaunch()
    return true
  }

  return { failedCoreVersions, markHealthy, recentRelaunches, recoverCore }
}
