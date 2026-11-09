/**
 * 启动失败该不该算「这个核心坏了」。
 *
 * 首启下载的核心会写 `core/pending`，外壳在 startServer 失败时据此回退并把这个版本拉黑。
 * 但目录不可写、磁盘满、权限不足这类问题与核心好坏无关：按坏核心处理会把一个有效版本删掉、
 * 永久跳过，用户把目录修好也回不来。
 */

/** 这些错误码表示「环境/文件系统」问题，不是核心本身的运行错误。 */
const ENVIRONMENT_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR', 'ENOENT',
  'EMFILE', 'ENFILE', 'EBUSY', 'EIO',
])

/**
 * 环境错误判定。ENOENT/EACCES 要看落在哪：数据目录/用户目录里是环境问题；
 * 落在核心目录里则更像核心文件缺失或不可读，仍按坏核心处理（否则坏核心永远不会被换掉）。
 */
export function isEnvironmentStartupError(error, coreDir = '') {
  const code = String(error?.code || '')
  if (!ENVIRONMENT_ERROR_CODES.has(code)) return false
  const path = String(error?.path || '').toLowerCase()
  const core = String(coreDir || '').toLowerCase()
  if (path && core && (path === core || path.startsWith(`${core}\\`) || path.startsWith(`${core}/`))) return false
  return true
}
