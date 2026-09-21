/**
 * 技能管理：dsh 的本地技能就是技能根目录下的 `<name>/SKILL.md`（目录包）或 `<name>.md`
 * （平文件），发现深度只有一层（嵌套子目录里的 SKILL.md 不算）。
 *
 * frontmatter 规则对齐 @deepseek-ai/dsh-skill-filesystem（0.1.6-alpha.2）：
 * - 必填 `name`（还得是 kebab-case）与 `description`（不能是空串），缺一个整个技能带警告丢弃；
 * - 可选 `whenToUse`、`metadata`、`disable-model-invocation`（对模型隐藏，即这里的"停用"）、
 *   `user-invocable`（对人机命令隐藏）；
 * - 两个调用键只认 true/false、yes/no、on/off、1/0（大小写不敏感），写别的整个技能被丢弃；
 * - 首行必须是干净的 `---`（带 UTF-8 BOM 的文件 dsh 认不出来，会当没有 frontmatter）。
 *
 * 扫描根（dsh 那边 rank 从高到低）：项目根 `.dsh/skills`(100) / `.agents/skills`(200) ——
 * 项目根启动器不碰；`~/.dsh/skills`(400，`$DSH_HOME` 可改) 与 `~/.agents/skills`(500，
 * `DSH_AGENTS_HOME` 可改) 是这里管的两层。`.system` 只会在 `~/.dsh/skills` 下被跳过，
 * 别的点开头条目 dsh 照收，所以这里也只跳 `.system`。provider 会 watch 目录，改完不用重启。
 *
 * 管理只做文本手术，用户手写的 YAML 永远不重排、换行风格也不换：
 * - 开关 = 只改 frontmatter 里 disable-model-invocation 那一行（没有就插一行）；
 * - 删除 = 删整个技能目录/平文件（顶层条目，防路径穿越）。
 *
 * web 模板把 host 层的 `skill-filesystem` / `tool-skill` patch 成 disabled，那是为了让
 * **agent 预设**自己挂这两个行（官方注释写的是 "presets own local discovery"）——本地技能
 * 默认就在工作。所以这里那两行覆盖只是"host 层强制启用"的高级开关，不是本地技能的总闸。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { patchPathOf, readPatchState, forceRowId } from './plugins.js'

const BOOL_TRUE = new Set(['true', 'yes', 'on', '1'])
const BOOL_FALSE = new Set(['false', 'no', 'off', '0'])
const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
/** dsh 对 frontmatter `name` 的要求：kebab-case。 */
const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 老写法（驼峰）会让 dsh 直接丢掉整个技能。 */
const LEGACY_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/** 覆盖行：host 层这两个 loader 行被 web 模板关掉，用户补丁层可以强制启用。 */
export const LOCAL_SKILL_ROWS = ['skill-filesystem', 'tool-skill']
/** 老版本误当成"本地技能三件套"的一员，跟本地技能无关，关闭时顺手清掉残留覆盖。 */
export const LEGACY_SKILL_ROWS = ['skill-badge']

/** 技能根目录（受管的两层，项目根不归启动器管）。 */
export function skillRoots(dshHome) {
  const agentsHome = process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
  return [
    { key: 'dsh', dir: join(dshHome, 'skills') },
    { key: 'agents', dir: join(agentsHome, 'skills') },
  ]
}

export function rootDirOf(roots, key) {
  const root = roots.find((item) => item.key === key)
  if (!root) throw new Error('未知的技能目录')
  return root.dir
}

/**
 * 宽容地定位 frontmatter：`---` 开头、下一个 `---` 收尾。
 * 返回正文起点和 frontmatter 区间（原文偏移，供字节级手术用），没有则 null。
 */
function locateFrontmatter(text) {
  const open = /^---[ \t]*\r?\n/.exec(text)
  if (!open) return null
  const rest = text.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  if (!close) return null
  return {
    fmStart: open[0].length,
    fmEnd: open[0].length + close.index,
    bodyAt: open[0].length + close.index + close[0].length,
  }
}

/** 解析 frontmatter 顶层字段：认识单行标量和折叠块（>/|-），嵌套结构只当展示用不着，跳过。 */
function parseFields(front) {
  const fields = {}
  let currentKey = ''
  const folded = []
  const flush = () => {
    if (currentKey && folded.length) fields[currentKey] = folded.join(' ').trim()
    currentKey = ''
    folded.length = 0
  }
  for (const line of front.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (match) {
      flush()
      currentKey = match[1]
      const raw = match[2].trim()
      if (raw === '' || /^[|>][+-\d]*$/.test(raw)) continue
      fields[match[1]] = unquote(raw)
      currentKey = ''
    } else if (currentKey && /^\s+\S/.test(line)) {
      folded.push(line.trim())
    }
  }
  flush()
  return fields
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/** 照 dsh 的校验说明这个技能为什么会被丢弃（空串 = 没问题）。 */
function describeFrontmatterIssue(fields, hasFrontmatter) {
  if (!hasFrontmatter) return '没有 YAML frontmatter（首行必须是 ---，带 BOM 的文件 dsh 认不出来）'
  const name = String(fields.name ?? '')
  if (!name) return 'frontmatter 缺 name'
  if (!KEBAB_NAME_RE.test(name)) return `name「${name}」不是 kebab-case（只能小写字母、数字和连字符，如 my-skill）`
  if (!String(fields.description ?? '').trim()) return 'frontmatter 缺 description'
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    const raw = fields[key]
    if (raw === undefined) continue
    const value = String(raw).toLowerCase()
    if (!BOOL_TRUE.has(value) && !BOOL_FALSE.has(value)) {
      return `${key} 的值「${raw}」不是合法布尔，dsh 会丢弃整个技能`
    }
  }
  for (const legacy of LEGACY_KEYS) {
    if (fields[legacy] !== undefined) {
      return `${legacy} 是旧写法，dsh 会丢弃整个技能（要写 disable-model-invocation / user-invocable）`
    }
  }
  return ''
}

function parseSkillFile(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { readError: error instanceof Error ? error.message : String(error) }
  }
  const fm = locateFrontmatter(text)
  const fields = fm ? parseFields(text.slice(fm.fmStart, fm.fmEnd)) : {}
  const dmi = String(fields['disable-model-invocation'] ?? '').toLowerCase()
  const issue = describeFrontmatterIssue(fields, Boolean(fm))
  return {
    name: String(fields.name || ''),
    description: String(fields.description || ''),
    whenToUse: String(fields.whenToUse || ''),
    disableModelInvocation: BOOL_TRUE.has(dmi),
    userInvocable: !BOOL_FALSE.has(String(fields['user-invocable'] ?? '').toLowerCase()),
    frontmatterOk: issue === '',
    frontmatterIssue: issue,
  }
}

/** 列出所有技能根下的本地技能（不动文件）。 */
export function listSkills(roots) {
  const skills = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // dsh 只跳过 user-dsh 根下的 .system；其它点开头条目照常会被发现，所以这里也照收
      if (entry.name === '.system' && root.key === 'dsh') continue
      if (entry.isDirectory()) {
        const file = join(root.dir, entry.name, 'SKILL.md')
        if (!existsSync(file)) continue
        skills.push({
          root: root.key,
          dirName: entry.name,
          kind: 'dir',
          relPath: `${entry.name}/SKILL.md`,
          file,
          ...parseSkillFile(file),
        })
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const file = join(root.dir, entry.name)
        skills.push({
          root: root.key,
          dirName: entry.name.replace(/\.md$/i, ''),
          kind: 'flat',
          relPath: entry.name,
          file,
          ...parseSkillFile(file),
        })
      }
    }
  }
  skills.sort((a, b) => (a.root + a.dirName).localeCompare(b.root + b.dirName))
  return skills
}

/**
 * 路径白名单：只接受 `name/SKILL.md` 或 `name.md`（扩展名不区分大小写，跟列表口径一致），
 * 解析后必须落在受管根里。
 */
function safeSkillFile(rootDir, relPath) {
  const match = /^([A-Za-z0-9_-]{1,64})(?:\/SKILL\.md|\.md)$/i.exec(String(relPath || ''))
  if (!match) throw new Error('不支持的技能路径')
  const rootResolved = resolve(rootDir)
  const file = resolve(rootDir, String(relPath))
  if (!file.toLowerCase().startsWith((rootResolved + sep).toLowerCase())) throw new Error('路径越界')
  if (!existsSync(file)) throw new Error('技能文件不存在')
  return file
}

function backupOnce(file) {
  try {
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  } catch {
    // 备份失败不阻塞开关本身
  }
}

/**
 * 只改 frontmatter 里的一个布尔行：有就原位替换，没有就在收尾前插一行。
 * 换行风格跟着原文件走（CRLF 文件别被写成混合换行）。
 */
function setFrontmatterBool(text, key, value) {
  const fm = locateFrontmatter(text)
  if (!fm) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const head = text.slice(0, fm.fmStart)
  const front = text.slice(fm.fmStart, fm.fmEnd)
  const tail = text.slice(fm.fmEnd)
  const lineRe = new RegExp(`^${key}:[^\\r\\n]*`, 'm')
  if (lineRe.test(front)) {
    return head + front.replace(lineRe, `${key}: ${value}`) + tail
  }
  const sep = front === '' || front.endsWith('\n') ? '' : eol
  return `${head}${front}${sep}${key}: ${value}${eol}${tail}`
}

/** 启用/停用一个技能（enabled=false 即写 disable-model-invocation: true）。 */
export function setSkillEnabled(rootDir, relPath, enabled) {
  const file = safeSkillFile(rootDir, relPath)
  const text = readFileSync(file, 'utf8')
  const next = setFrontmatterBool(text, 'disable-model-invocation', enabled === false)
  if (next === null) throw new Error('SKILL.md 没有 YAML frontmatter（文件要以 --- 开头，且第一行不能有 BOM），无法开关')
  if (next === text) return { ok: true, changed: false }
  backupOnce(file)
  writeFileSync(file, next)
  return { ok: true, changed: true }
}

/**
 * host 层技能行的覆盖状态。
 *
 * 注意语义：dsh-web-app 把 host 层的 skill-filesystem / tool-skill 关掉，是因为这两个行
 * 交给 agent 预设挂了（官方注释：presets own local discovery）——本地技能默认就在工作，
 * 页面不需要开这个开关。这里只是如实报出"补丁层里有没有那两行覆盖"。
 */
export function localSkillsEnabled(profileDir) {
  const { forced } = readPatchState(patchPathOf(profileDir))
  const rows = LOCAL_SKILL_ROWS.filter((row) => forced.includes(row))
  return {
    enabled: rows.length === LOCAL_SKILL_ROWS.length,
    rows,
    legacy: LEGACY_SKILL_ROWS.filter((row) => forced.includes(row)),
  }
}

/** host 层覆盖开关：写/删那两行的 `disabled: false`；老版本留下的 skill-badge 覆盖顺手清掉。 */
export function setLocalSkillsEnabled(profileDir, enabled) {
  let changed = false
  for (const row of LOCAL_SKILL_ROWS) {
    const result = forceRowId(profileDir, row, enabled !== false)
    changed = changed || result.changed
  }
  for (const row of LEGACY_SKILL_ROWS) {
    const result = forceRowId(profileDir, row, false)
    changed = changed || result.changed
  }
  return { ok: true, changed }
}
