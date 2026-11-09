import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

// 这些原生错误描述权限、设备或资源限制，重新下载同一份核心不能修好它们。
// 不按错误文案匹配，也不把 ERR_MODULE_NOT_FOUND 等模块/代码错误混进来。
const RESOURCE_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOMEM', 'EIO', 'ENODEV', 'ENXIO', 'EBUSY', 'ESTALE'])
const PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP'])
const LISTEN_ERRORS = new Set(['EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'])

/** 外壳必须兼容旧核心直接抛出的 Node 系统错误，不能依赖新核心才有的错误标记。 */
export function isEnvironmentStartupError(error, coreDir) {
  if (!error || typeof error.syscall !== 'string' || !error.syscall) return false
  if (RESOURCE_ERRORS.has(error.code)) return true
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
export function createCoreRecovery({ appDir, relaunch, log = console.log }) {
  const activeCore = join(appDir, 'core', 'current')
  const previousCore = join(appDir, 'core', 'previous')
  const pending = join(appDir, 'core', 'pending')
  const failedMark = join(appDir, 'core', 'bootstrap.json')

  function failedCoreVersions() {
    try {
      const mark = JSON.parse(readFileSync(failedMark, 'utf8'))
      const list = Array.isArray(mark?.failed) ? mark.failed : [mark?.version]
      return list.map((item) => String(item || '')).filter(Boolean)
    } catch { return [] }
  }

  function recoverCore(coreDir, { pendingOnly = false, error } = {}) {
    if (coreDir !== activeCore) return false
    if (pendingOnly && !existsSync(pending)) return false
    if (isEnvironmentStartupError(error, coreDir)) return false
    // 保留原来的坏核心保护：首次下载/更新留下的 pending 才能把版本加入黑名单。
    // 列表避免两个坏版本来回切换；旧格式只有 version 一项，读取时继续兼容。
    try {
      const version = String(JSON.parse(readFileSync(pending, 'utf8')).version || '')
      if (version) {
        const failed = [...new Set([...failedCoreVersions(), version])].slice(-20)
        writeFileSync(failedMark, JSON.stringify({ version, failed, at: Date.now() }))
      }
    } catch { /* 没有 pending 就不记 */ }
    try { rmSync(activeCore, { recursive: true, force: true }) } catch { /* ignore */ }
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

  return { failedCoreVersions, recoverCore }
}
