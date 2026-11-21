import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 改动补丁层或技能文件前顺手留一份 .bak 备份；失败不阻塞主流程。 */
export function backupOnce(file) {
  try {
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  } catch {
    // 备份失败不阻塞开关/写入本身
  }
}

/** 同步原子写 JSON：写同目录临时文件再改名，Windows 遇短暂句柄占用短退避重试，失败清理临时文件。 */
export function writeJsonAtomicSync(file, value, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const payload = `${JSON.stringify(value, null, 2)}\n`
    if (mode !== undefined) writeFileSync(temp, payload, { mode })
    else writeFileSync(temp, payload)
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temp, file)
        return
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) throw error
        // 同步路径极少撞锁，用极短忙等退避避免半截文件或失败
        const end = Date.now() + 15 * (attempt + 1)
        while (Date.now() < end) { /* wait for AV/reader handle release */ }
      }
    }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
}

/** 统一把未知异常转成人可读的消息串。 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
