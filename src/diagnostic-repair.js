import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { parseVer, cmpVer } from './version.js'
import { RUNTIME_NODE, RUNTIME_NODE_ENV } from './platform.js'

const PACKAGE_MAX_BYTES = 64 * 1024 * 1024
const PACKAGE_MAX_FILES = 4096
const PACKAGE_MAX_DEPTH = 32
const PROBE_TIMEOUT_MS = 30000
const PROBE_MAX_BYTES = 1024 * 1024

/** 只接受可精确比较的完整 semver；不改变全局版本库的宽松兼容行为。 */
export function compatibleUpgrade(current, target) {
  const versions = [current, target].map(value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) {
      return null
    }
    const parsed = parseVer(value)
    if (!parsed || ![parsed.major, parsed.minor, parsed.patch].every(Number.isSafeInteger)) {
      return null
    }
    if (parsed.pre.split('.').some(part => /^\d+$/.test(part) && (!/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part))))) {
      return null
    }
    return parsed
  })
  return Boolean(versions[0] && versions[1] && cmpVer(versions[1], versions[0]) >= 0)
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** 写入路径的每层必须是普通目录，拒绝 junction 把已确认目标转到别处。 */
export function ordinaryPath(path, allowMissing = false) {
  const absolute = resolve(path)
  let cursor = parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part)
    if (!pathExists(cursor) && allowMissing) {
      continue
    }
    const info = lstatSync(cursor)
    if (info.isSymbolicLink() || realpathSync.native(cursor).toLowerCase() !== resolve(cursor).toLowerCase()) {
      throw new Error('linked_path')
    }
  }
  return absolute
}

/** 摘要完整普通包目录；限额或文件变化无法证明安全时禁止自动修复。 */
export function packageFingerprint(directory) {
  ordinaryPath(directory)
  if (!lstatSync(directory).isDirectory()) {
    throw new Error('package_not_directory')
  }
  const hash = createHash('sha256')
  const budget = { bytes: 0, files: 0 }
  function visit(path, label, depth = 0) {
    budget.files += 1
    if (budget.files > PACKAGE_MAX_FILES || depth > PACKAGE_MAX_DEPTH) {
      throw new Error('oversized_package')
    }
    const before = lstatSync(path)
    if (before.isSymbolicLink()) {
      throw new Error('linked_package')
    }
    if (before.isDirectory()) {
      const names = readdirSync(path).sort()
      hash.update(JSON.stringify(['directory', label, names]))
      for (const name of names) {
        visit(join(path, name), `${label}/${name}`, depth + 1)
      }
      const after = lstatSync(path)
      if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || JSON.stringify(names) !== JSON.stringify(readdirSync(path).sort())) {
        throw new Error('changed_package')
      }
      return
    }
    if (!before.isFile()) {
      throw new Error('unverifiable_package')
    }
    budget.bytes += before.size
    if (budget.bytes > PACKAGE_MAX_BYTES || budget.files > PACKAGE_MAX_FILES) {
      throw new Error('oversized_package')
    }
    const descriptor = openSync(path, 'r')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    try {
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, length)
        if (!count) {
          break
        }
        length += count
      }
      for (const after of [fstatSync(descriptor), lstatSync(path)]) {
        if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== before.size) {
          throw new Error('changed_package')
        }
      }
    } finally {
      closeSync(descriptor)
    }
    hash.update(JSON.stringify(['file', label, length, createHash('sha256').update(bytes.subarray(0, length)).digest('hex')]))
  }
  visit(directory, '')
  return hash.digest('hex')
}

/** 沿用 Nexus heal_profile_modules 的逐包 rename 归档，不删除或改写包内容。 */
export function archivePackage(source, backup, expectedDigest) {
  ordinaryPath(source)
  ordinaryPath(backup, true)
  if (pathExists(backup)) {
    throw new Error('backup_exists')
  }
  if (!expectedDigest || packageFingerprint(source) !== expectedDigest) {
    throw new Error('changed_package')
  }
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
  ordinaryPath(dirname(backup))
  renameSync(source, backup)
}

/** 回退只恢复本次原物，目标重新出现或备份变化时拒绝覆盖。 */
export function restorePackage(source, backup, expectedDigest) {
  ordinaryPath(source, true)
  ordinaryPath(backup)
  if (pathExists(source)) {
    throw new Error('target_exists')
  }
  if (!expectedDigest || packageFingerprint(backup) !== expectedDigest) {
    throw new Error('changed_backup')
  }
  mkdirSync(dirname(source), { recursive: true, mode: 0o700 })
  ordinaryPath(dirname(source))
  renameSync(backup, source)
}

/** 正确值取官方 runtime 版本，且必须与实际客户端构建内嵌版本吻合。 */
export function clientVersionEvidence(harnessEntry) {
  const anchor = join(dirname(dirname(harnessEntry)), 'package.json')
  ordinaryPath(anchor)
  const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) {
    throw new Error('unknown_runtime_version')
  }
  const clientFile = join(dirname(dirname(dirname(anchor))), '@deepseek-ai/dsh-client-ui-sidebar/lib/client.js')
  ordinaryPath(clientFile)
  if (lstatSync(clientFile).size > PROBE_MAX_BYTES) {
    throw new Error('unverifiable_client_metadata')
  }
  const client = readFileSync(clientFile, 'utf8')
  const builds = [...client.matchAll(/return `([^`]+)` \+ \(\{\}\.DSH_CLIENT_GIT_DIRTY === "true" \? "-dirty" : ""\);/g)]
  if (builds.length !== 1 || !builds[0][1].startsWith(`${manifest.version}-`) || !/^[a-f0-9]{7,40}$/.test(builds[0][1].slice(manifest.version.length + 1))) {
    throw new Error('unverifiable_client_metadata')
  }
  return {
    anchor,
    version: manifest.version,
    clientFile,
    clientBuild: builds[0][1],
    digest: createHash('sha256').update(JSON.stringify([readFileSync(anchor, 'utf8'), createHash('sha256').update(client).digest('hex')])).digest('hex'),
  }
}

/** 官方解析钩子仅放进隔离子进程；超时/输出超限只导致修复不可用。 */
export function probePackageSources(target, names) {
  return new Promise((resolveProbe, rejectProbe) => {
    const env = {}
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
      if (process.env[name]) {
        env[name] = process.env[name]
      }
    }
    // 不传用户 PATH、NODE_OPTIONS 或凭据；探针不读取这些目录中的配置。
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DSH_HOME', 'TEMP', 'TMP']) {
      env[name] = target.home
    }
    // Electron 打包版里 process.execPath 是 GUI 壳本身，必须走 RUNTIME_NODE + RUNTIME_NODE_ENV（含 ELECTRON_RUN_AS_NODE=1）
    Object.assign(env, RUNTIME_NODE_ENV)
    env.PATH = dirname(RUNTIME_NODE)
    const child = spawn(RUNTIME_NODE, [join(import.meta.dirname, 'repair-probe.mjs')], {
      cwd: target.home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    let size = 0
    let rejected = false
    const timer = setTimeout(() => {
      rejected = true
      child.kill()
      rejectProbe(new Error('probe_timeout'))
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > PROBE_MAX_BYTES) {
        rejected = true
        child.kill()
        rejectProbe(new Error('probe_oversized'))
      } else {
        output += chunk
      }
    })
    child.stderr.resume()
    child.on('error', error => {
      clearTimeout(timer)
      rejectProbe(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (rejected) {
        return
      }
      try {
        if (code !== 0) {
          throw new Error('probe_failed')
        }
        resolveProbe(JSON.parse(output))
      } catch (error) {
        rejectProbe(error)
      }
    })
    child.stdin.on('error', () => {
      // 退出码与 close 统一给出探针失败，避免管道提前关闭再产生未处理异常。
    })
    child.stdin.end(JSON.stringify({ anchor: target.anchor, home: target.home, profile: target.profile, names, acceptedPatchDigest: target.acceptedPatchDigest, runtimeEvidence: target.runtimeEvidence }))
  })
}
