/** 远端 Profile 的读取/删除：WSL 和 SSH 共用同一段 POSIX 脚本，只是 backend 不同。 */
import { shellQuote } from './remote.js'

function expandHomeScript(home) {
  return [
    `h=${shellQuote(String(home || '').trim() || '~/.dsh')}`,
    // 用 POSIX 参数展开 ${h#~/}，避免 dash/ash 等 /bin/sh 报 bashism Bad substitution
    'case "$h" in "~") h="$HOME" ;; "~/"*) h="$HOME/${h#~/}" ;; esac',
  ].join('\n')
}

function validRemoteProfileName(profile) {
  const name = String(profile || '').trim()
  if (!name) throw new Error('Profile 名称不能为空')
  if (name === '.' || name === '..' || /[/\\]/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Profile 名称不合法：${name}`)
  }
  return name
}

export async function readRemoteProfile(backend, home, profile) {
  const name = validRemoteProfileName(profile)
  const script = [
    'set -e',
    `p=${shellQuote(name)}`,
    expandHomeScript(home),
    'f="$h/profiles/$p/package.json"',
    'if [ ! -f "$f" ]; then echo __DSHX_MISSING__; exit 0; fi',
    'cat "$f"',
  ].join('\n')
  const result = await backend.exec(script, { timeoutMs: 10000 })
  if (!result.ok) throw new Error(result.stderr || result.stdout || '读取远端 Profile 失败')
  const text = String(result.stdout || '').trim()
  if (!text || text === '__DSHX_MISSING__') return { ok: false, profile: name, error: '这个 Profile 还没初始化' }
  let manifest = null
  try { manifest = JSON.parse(text) } catch { return { ok: false, profile: name, error: 'Profile 的 package.json 读不出来' } }
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : null
  const plugins = Object.keys(dependencies).sort().map((plugin) => ({
    name: plugin,
    version: String(dependencies[plugin] || ''),
    mounted: !bundles || bundles.includes(plugin),
  }))
  return { ok: true, profile: name, home: String(home || '').trim() || '~/.dsh', plugins, bundles: bundles || [] }
}

export async function removeRemoteProfile(backend, home, profile) {
  const name = validRemoteProfileName(profile)
  const script = [
    'set -e',
    `p=${shellQuote(name)}`,
    expandHomeScript(home),
    'd="$h/profiles/$p"',
    'if [ ! -d "$d" ]; then echo __DSHX_MISSING__; exit 0; fi',
    'rm -rf -- "$d"',
    'echo __DSHX_REMOVED__',
  ].join('\n')
  const result = await backend.exec(script, { timeoutMs: 10000 })
  if (!result.ok) throw new Error(result.stderr || result.stdout || '删除远端 Profile 失败')
  if (String(result.stdout || '').includes('__DSHX_MISSING__')) return { ok: false, profile: name, error: '这个 Profile 还没初始化' }
  return { ok: true, profile: name }
}
