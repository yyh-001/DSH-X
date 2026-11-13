/**
 * 读取 ~/.ssh/config，给「从 SSH config 导入」下拉用。
 *
 * 只取 DSH-X 能真正用上的四项：HostName / Port / User / IdentityFile。
 * 支持 Include（递归、glob、%d）和 Host 的多个别名；通配 Host 不算可导入的别名。
 * 有 ssh.exe 时再用 `ssh -G` 补一次有效值（它会按 OpenSSH 自己的规则合并 Include/默认值）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const MAX_ALIASES = 200
const MAX_DEPTH = 8

function expandTilde(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** 只展开常见的 OpenSSH 占位符，未知的保持原样。 */
function expandTokens(value, { host = '', user = '' } = {}) {
  return String(value || '')
    .replace(/%d/g, homedir())
    .replace(/%h/g, host)
    .replace(/%r/g, user)
    .replace(/%u/g, process.env.USERNAME || process.env.USER || '')
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '')
}

function expandInclude(pattern) {
  const text = expandTilde(expandTokens(pattern))
  if (!text) return []
  const dir = dirname(text)
  const name = basename(text)
  if (!existsSync(dir)) return []
  if (name === text || !/[*?]/.test(name)) return existsSync(text) ? [text] : []
  const matcher = globToRegExp(name)
  try {
    return readdirSync(dir).filter((entry) => matcher.test(entry)).map((entry) => join(dir, entry))
  } catch { return [] }
}

function parseConfigFile(file, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH || seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const blocks = []
  let current = { patterns: [], options: {} }
  const push = () => { if (current.patterns.length) blocks.push(current) }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      push()
      current = { patterns: value.split(/\s+/).filter(Boolean), options: {} }
    } else if (key === 'match') {
      push()
      current = { patterns: [], options: {} }
    } else if (key === 'include') {
      for (const included of expandInclude(value)) {
        for (const block of parseConfigFile(included, depth + 1, seen)) blocks.push(block)
      }
    } else if (current.patterns.length && !(key in current.options)) {
      current.options[key] = value
    }
  }
  push()
  return blocks
}

/** 把 blocks 合并成「别名 → 有效字段」；后面的 Host 块覆盖前面的。 */
function collectAliases(blocks) {
  const aliases = new Map()
  for (const block of blocks) {
    for (const alias of block.patterns) {
      if (!alias || /[*?!]/.test(alias)) continue
      const previous = aliases.get(alias) || {}
      aliases.set(alias, { ...previous, ...block.options })
      if (aliases.size >= MAX_ALIASES) return aliases
    }
  }
  return aliases
}

function sshConfigPath() {
  return join(homedir(), '.ssh', 'config')
}

function queryOpenSsh(alias, configPath) {
  if (!existsSync(configPath)) return null
  const candidates = process.platform === 'win32'
    ? ['ssh.exe', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe']
    : ['ssh']
  for (const exe of candidates) {
    const result = spawnSync(exe, ['-G', '-F', configPath, '-o', 'BatchMode=yes', alias], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    })
    if (result.error || result.status !== 0) continue
    const values = {}
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = /^(\S+)\s+(.*)$/.exec(line.trim())
      if (match) values[match[1].toLowerCase()] = match[2].trim()
    }
    const host = values.hostname || ''
    if (!host) continue
    return {
      host,
      port: Number(values.port) || 22,
      username: values.user || '',
      privateKeyPath: expandTilde(values.identityfile || ''),
    }
  }
  return null
}

/**
 * @returns {{ aliases: Array<{alias:string,host:string,port:number,username:string,privateKeyPath:string}>, configPath: string, error?: string }}
 */
export function listSshConfigAliases({ configPath = sshConfigPath() } = {}) {
  const aliases = collectAliases(parseConfigFile(configPath))
  const out = []
  for (const [alias, options] of aliases) {
    const host = expandTokens(options.hostname || alias, { host: alias })
    const port = Number(options.port) || 22
    const username = expandTokens(options.user || '', { host, user: '' })
    const privateKeyPath = expandTilde(expandTokens(options.identityfile || '', { host, user: username }))
    // 本地有 ssh.exe 时优先用它解析出的有效值（会合并 Include、默认端口等）。
    // 只有默认的 ~/.ssh/config 才问 ssh -G；自定义路径它不一定认 -F，混进用户真实配置反而更糟。
    const effective = configPath === sshConfigPath() ? queryOpenSsh(alias, configPath) : null
    out.push({
      alias,
      host: effective?.host || host,
      port: effective?.port || port,
      username: effective?.username || username,
      privateKeyPath: effective?.privateKeyPath || privateKeyPath,
    })
    if (out.length >= MAX_ALIASES) break
  }
  return { aliases: out, configPath, ...(existsSync(configPath) ? {} : { error: '没有找到 ~/.ssh/config' }) }
}

export { expandTilde, expandTokens }
