/**
 * dsh-x-memory 的记忆库 —— 照 ZCode 那套「文件即记忆」的语义实现。
 *
 * 形状：
 *   <root>/<slug>.md    一条事实一个文件，frontmatter: name / title / description / metadata.type
 *   <root>/MEMORY.md    索引，一行一条：`- [Title](slug.md) — hook`
 *   正文里可以用 [[slug]] 互链（照 ZCode 的写法，链到还不存在的文件也算合法）。
 *
 * 性格（和 ZCode 一致）：
 * - 文件就是记忆本体：随时能打开、手改、删掉、进 git；插件卸载了它们还在；
 * - 索引只放指针，不放正文；
 * - 写入原子（临时文件 + rename），崩在中间不会留下半截文件。
 *
 * 本文件不 import 任何 dsh 包，纯 node，单测直接调。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 四种记忆类型，和 ZCode 的 MEMORY_RECALL_TYPES 一致。 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
export const INDEX_FILE = 'MEMORY.md'
/** 索引硬上限，抄 ZCode 的 index-content.ts（200 行 / 25KB，超了会带一句 WARNING）。 */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25_000
/** 文件名规则：小写 slug。限定字符集，路径穿越在入口就没得谈。 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 单条记忆正文的软上限（超了工具会拒绝并提示拆成多条）。 */
export const MAX_BODY_BYTES = 16_000
const MAX_SCAN_FILES = 2_000

/** 标题 → slug；中文/符号标题退化成 `memory-<8 位哈希>`。 */
export function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '')
  return SLUG_RE.test(slug) ? slug : `memory-${hash8(String(text ?? ''))}`
}

function hash8(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** YAML 值：安全字符原样写，其余用 JSON 引号转义（我们自己写、自己读，够用）。 */
export function yamlValue(value) {
  const text = String(value ?? '')
  if (text !== '' && !/[:#\n"']/.test(text) && text.trim() === text && !text.startsWith('-')) return text
  return JSON.stringify(text)
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

/** 解析一份记忆文件：frontmatter（name/title/description/metadata.type）+ 正文。 */
export function parseMemory(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  const empty = { name: '', title: '', description: '', type: '', body: source.trim() }
  if (!source.startsWith('---\n') && source.trim() !== '---') return empty
  const lines = source.split('\n')
  if (lines[0].trim() !== '---') return empty
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return empty
  const front = { name: '', title: '', description: '', type: '' }
  let inMetadata = false
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\s+$/u, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^metadata\s*:\s*$/u.test(line)) {
      inMetadata = true
      continue
    }
    if (/^\s+/u.test(line)) {
      // metadata 块里的缩进键
      const nested = line.trim().match(/^type\s*:\s*(.*)$/u)
      if (inMetadata && nested) front.type = unquote(nested[1])
      continue
    }
    inMetadata = false
    const matched = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/u)
    if (!matched) continue
    const key = matched[1]
    const value = unquote(matched[2])
    if (key === 'name') front.name = value
    else if (key === 'title') front.title = value
    else if (key === 'description') front.description = value
    else if (key === 'type') front.type = value
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/u, '').replace(/\s+$/u, '')
  return { ...front, body }
}

/** 组装一份记忆文件（写盘用它，保证 round-trip）。 */
export function formatMemory({ name, title, description, type, body }) {
  const lines = ['---', `name: ${yamlValue(name)}`]
  if (title && title !== name) lines.push(`title: ${yamlValue(title)}`)
  lines.push(`description: ${yamlValue(description ?? '')}`)
  lines.push('metadata:', `  type: ${MEMORY_TYPES.includes(type) ? type : 'project'}`)
  lines.push('---', '', String(body ?? '').trim(), '')
  return lines.join('\n')
}

/** 索引一行：ZCode 的形状（`- [Title](file.md) — hook`）。 */
export function formatIndexEntry(entry) {
  const title = entry.title || entry.name
  const hook = String(entry.description ?? '').replace(/\s+/gu, ' ').trim()
  return `- [${title}](${entry.name}.md)${hook ? ` — ${hook}` : ''}`
}

/** 索引正文：条目 + 超限提示（和 ZCode 一样，超限也不静默）。 */
export function formatIndex(entries, { maxLines = INDEX_MAX_LINES, maxBytes = INDEX_MAX_BYTES } = {}) {
  const lines = entries.map(formatIndexEntry)
  let text = lines.join('\n')
  let truncated = false
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    let bytes = 0
    const kept = []
    for (const line of text.split('\n')) {
      const size = Buffer.byteLength(`${line}\n`, 'utf8')
      if (bytes + size > maxBytes - 200) break
      bytes += size
      kept.push(line)
    }
    text = kept.join('\n')
    truncated = true
  }
  if (truncated) {
    text += `\n\n> WARNING: 记忆索引超过 ${maxLines} 行 / ${Math.round(maxBytes / 1024)}KB，只加载了一部分。请把内容拆进主题文件，索引每行保持一句话。`
  }
  return { text, truncated, count: entries.length }
}

/** 类型排序：user → feedback → project → reference，同类按标题。 */
export function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const byType = MEMORY_TYPES.indexOf(left.type) - MEMORY_TYPES.indexOf(right.type)
    if (byType !== 0) return byType
    return String(left.title || left.name).localeCompare(String(right.title || right.name), 'zh-Hans-CN')
  })
}

/** 工作区 → 记忆根目录名：可读前缀 + 路径哈希，换个目录不会撞车。 */
export function workspaceKey(workspacePath) {
  const raw = String(workspacePath ?? '').replace(/[\\/]+$/u, '')
  const base = raw.split(/[\\/]/u).filter(Boolean).pop() ?? 'workspace'
  const prefix = slugify(base).replace(/^memory-[0-9a-f]{8}$/u, 'workspace').slice(0, 32).replace(/-+$/u, '')
  return `${prefix || 'workspace'}-${hash8(raw)}`
}

/** 原子写：先写 .tmp 再 rename，读到的永远是完整文件。 */
function writeAtomic(file, text) {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
}

export class MemoryStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new Error('MemoryStore 需要 rootDir')
    this.rootDir = rootDir
  }

  ensure() {
    mkdirSync(this.rootDir, { recursive: true })
    return this.rootDir
  }

  /** slug → 文件路径；只接受 slug，路径天然关在根目录内。 */
  filePath(name) {
    const slug = String(name ?? '').trim()
    if (!SLUG_RE.test(slug)) throw new Error(`记忆名不合法：${JSON.stringify(name)}（只接受小写 slug：字母/数字/连字符）`)
    return join(this.rootDir, `${slug}.md`)
  }

  /** 扫描全部记忆（不含索引）；坏文件跳过，不让一条坏数据挡住整库。 */
  scan() {
    let names = []
    try {
      names = readdirSync(this.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE)
        .map((entry) => entry.name)
        .slice(0, MAX_SCAN_FILES)
    } catch {
      return []
    }
    const entries = []
    for (const file of names) {
      const path = join(this.rootDir, file)
      try {
        const stat = statSync(path)
        const parsed = parseMemory(readFileSync(path, 'utf8'))
        const name = SLUG_RE.test(parsed.name) ? parsed.name : file.slice(0, -3)
        entries.push({
          name,
          title: parsed.title || name,
          description: parsed.description,
          type: MEMORY_TYPES.includes(parsed.type) ? parsed.type : 'project',
          body: parsed.body,
          file,
          path,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch {
        // 读不了的文件跳过
      }
    }
    return entries
  }

  list({ type } = {}) {
    const entries = this.scan()
    const filtered = MEMORY_TYPES.includes(type) ? entries.filter((entry) => entry.type === type) : entries
    return sortEntries(filtered)
  }

  read(name) {
    const path = this.filePath(name)
    if (!existsSync(path)) return null
    const parsed = parseMemory(readFileSync(path, 'utf8'))
    const stat = statSync(path)
    return {
      name,
      title: parsed.title || name,
      description: parsed.description,
      type: MEMORY_TYPES.includes(parsed.type) ? parsed.type : 'project',
      body: parsed.body,
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  }

  /**
   * 新建一条记忆。同名已存在时不覆盖（除非 overwrite=true）——
   * 对应提示词里那句「先查重，更新已有文件而不是新建重复的」。
   */
  save({ name, title, description = '', type = 'project', body, overwrite = false }) {
    this.ensure()
    const slug = SLUG_RE.test(String(name ?? '')) ? String(name) : slugify(title || name || body)
    if (!MEMORY_TYPES.includes(type)) throw new Error(`记忆类型不合法：${JSON.stringify(type)}（可选 ${MEMORY_TYPES.join(' / ')}）`)
    const text = String(body ?? '').trim()
    if (!text) throw new Error('记忆正文不能为空')
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error(`正文太长了（>${MAX_BODY_BYTES} 字节）：拆成几条更小的记忆`)
    const path = this.filePath(slug)
    const exists = existsSync(path)
    if (exists && !overwrite) return { action: 'exists', name: slug, entry: this.read(slug) }
    writeAtomic(path, formatMemory({ name: slug, title: title || slug, description, type, body: text }))
    this.rebuildIndex()
    return { action: exists ? 'overwritten' : 'created', name: slug, entry: this.read(slug) }
  }

  /** 局部更新：只改传进来的字段，其余保持。 */
  update(name, patch = {}) {
    const current = this.read(name)
    if (!current) return null
    const next = {
      name: current.name,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      type: patch.type ?? current.type,
      body: patch.body ?? current.body,
    }
    if (patch.type !== undefined && !MEMORY_TYPES.includes(patch.type)) throw new Error(`记忆类型不合法：${JSON.stringify(patch.type)}`)
    const text = String(next.body ?? '').trim()
    if (!text) throw new Error('记忆正文不能为空')
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error(`正文太长了（>${MAX_BODY_BYTES} 字节）：拆成几条更小的记忆`)
    writeAtomic(this.filePath(current.name), formatMemory({ ...next, body: text }))
    this.rebuildIndex()
    return this.read(current.name)
  }

  remove(name) {
    const path = this.filePath(name)
    if (!existsSync(path)) return false
    unlinkSync(path)
    this.rebuildIndex()
    return true
  }

  /** 关键词检索：全部词都命中才算，按字段权重打分（标题/名字重、正文轻）。 */
  search(query, { limit = 8 } = {}) {
    const tokens = String(query ?? '').toLowerCase().split(/\s+/u).map((token) => token.trim()).filter(Boolean)
    if (tokens.length === 0) return []
    const hits = []
    for (const entry of this.scan()) {
      const title = String(entry.title ?? '').toLowerCase()
      const description = String(entry.description ?? '').toLowerCase()
      const name = entry.name.toLowerCase()
      const body = String(entry.body ?? '').toLowerCase()
      let score = 0
      let all = true
      for (const token of tokens) {
        let tokenScore = 0
        if (title.includes(token)) tokenScore += 5
        if (name.includes(token)) tokenScore += 4
        if (description.includes(token)) tokenScore += 3
        const occurrences = body.split(token).length - 1
        if (occurrences > 0) tokenScore += 1 + Math.min(occurrences, 4) * 0.5
        if (tokenScore === 0) {
          all = false
          break
        }
        score += tokenScore
      }
      if (!all) continue
      hits.push({ ...entry, score, snippet: snippetFor(entry.body, tokens[0]) })
    }
    return hits.sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs).slice(0, Math.max(1, limit))
  }

  readIndex() {
    try {
      return readFileSync(join(this.rootDir, INDEX_FILE), 'utf8')
    } catch {
      return ''
    }
  }

  /** 重建索引（内容没变就不写盘）。返回 {text, entries, truncated}。 */
  rebuildIndex() {
    this.ensure()
    const entries = sortEntries(this.scan())
    const formatted = formatIndex(entries)
    const header = '# Memory\n\n'
    const text = `${header}${formatted.text}${formatted.text ? '\n' : ''}`
    if (this.readIndex() !== text) writeAtomic(join(this.rootDir, INDEX_FILE), text)
    return { ...formatted, text, entries: entries.map(({ name, title, description, type, file }) => ({ name, title, description, type, file })) }
  }

  /** 注入用：有记忆才给索引文本，空库返回 ''（不往上下文里塞空标题）。 */
  indexForInjection(options) {
    const { entries } = this.rebuildIndex()
    if (entries.length === 0) return ''
    const formatted = formatIndex(entries, options)
    return formatted.text
  }

  stats() {
    const entries = this.scan()
    const byType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0]))
    for (const entry of entries) byType[entry.type] = (byType[entry.type] ?? 0) + 1
    return { total: entries.length, byType, rootDir: this.rootDir, indexBytes: Buffer.byteLength(this.readIndex(), 'utf8') }
  }
}

function snippetFor(body, token) {
  const text = String(body ?? '').replace(/\s+/gu, ' ').trim()
  const at = text.toLowerCase().indexOf(token)
  if (at < 0) return text.slice(0, 140)
  const start = Math.max(0, at - 50)
  const end = Math.min(text.length, at + token.length + 90)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
