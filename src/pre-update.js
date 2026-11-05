import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPlugins } from './plugins.js'

const COMPATIBILITY = Object.freeze({
  packageName: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
  runtimePeer: /^@deepseek-ai\/dsh(?:-|$)/,
  workspacePeers: new Set(['workspace:^', 'workspace:~', 'workspace:*']),
})

function objectOf(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value
}

/** 与 Harness 的声明优先级一致：engines.dsh 独占，否则检查所有 dsh peer；不导入插件代码。 */
function requirementsOf(manifest) {
  const engines = Object.hasOwn(manifest, 'engines') ? objectOf(manifest.engines, 'engines') : {}
  if (Object.hasOwn(engines, 'dsh')) {
    if (typeof engines.dsh !== 'string') throw new Error('engines.dsh must be a string')
    return { 'engines.dsh': engines.dsh }
  }
  const peers = Object.hasOwn(manifest, 'peerDependencies') ? objectOf(manifest.peerDependencies, 'peerDependencies') : {}
  for (const range of Object.values(peers)) {
    if (typeof range !== 'string') throw new Error('peerDependencies ranges must be strings')
  }
  return Object.fromEntries(Object.entries(peers).filter(([name]) => COMPATIBILITY.runtimePeer.test(name)))
}

/**
 * 只读检查 profile 中已安装的全部直接插件（含已禁用项）。satisfiesRange 由已装 Harness
 * 提供 semver，并启用 includePrerelease；目标版本无需安装。不完整的扫描单独返回 errors，
 * 不能把缺失/损坏的清单或断链当成「全部兼容」。
 */
export function checkPluginCompatibility(profileDir, version, satisfiesRange) {
  const result = { version, plugins: [], incompatible: [], errors: [] }
  try {
    const manifest = objectOf(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')), 'profile manifest')
    if (Object.hasOwn(manifest, 'dependencies')) objectOf(manifest.dependencies, 'profile dependencies')
  } catch (error) {
    result.errors.push({ name: 'Profile', error: error.message })
    return result
  }
  for (const installed of listPlugins(profileDir).plugins) {
    try {
      if (!COMPATIBILITY.packageName.test(installed.name)) throw new Error('Invalid plugin package name')
      const manifest = objectOf(JSON.parse(readFileSync(join(profileDir, 'node_modules', installed.name, 'package.json'), 'utf8')), 'plugin manifest')
      if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Missing installed plugin version')
      const requirements = requirementsOf(manifest)
      const plugin = { name: installed.name, version: manifest.version, requirements }
      result.plugins.push(plugin)
      const unmet = Object.fromEntries(Object.entries(requirements).filter(([field, range]) => {
        if (field !== 'engines.dsh' && COMPATIBILITY.workspacePeers.has(range)) return false
        return !range.trim() || !satisfiesRange(version, range)
      }))
      if (Object.keys(unmet).length) result.incompatible.push({ ...plugin, requirements: unmet })
    } catch (error) {
      result.errors.push({ name: installed.name, error: error.message })
    }
  }
  return result
}
