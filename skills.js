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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { crc32, readZipEntry, readZipIndex } from './zipfile.js'
import { netFetch } from './proxy.js'
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
  return parseSkillText(text)
}

function parseSkillText(text) {
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

/**
 * 链接（符号链接 / Windows junction）在 readdir 的 dirent 里既不是 file 也不是 dir，
 * 光看 entry.isDirectory() 会把手链进来的技能整条漏掉。dsh 自己是跟链走的
 * （dsh-skill-filesystem 的 nodeEntryKind 会 stat 一次），这里照做；断链就跳过。
 */
function statOrNull(path) {
  try {
    return statSync(path)
  } catch {
    return null
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
      const followed = entry.isSymbolicLink() ? statOrNull(join(root.dir, entry.name)) : null
      if (entry.isDirectory() || followed?.isDirectory() === true) {
        const file = join(root.dir, entry.name, 'SKILL.md')
        if (!existsSync(file)) continue
        skills.push({
          root: root.key,
          dirName: entry.name,
          kind: 'dir',
          linked: entry.isSymbolicLink(),
          relPath: `${entry.name}/SKILL.md`,
          file,
          ...parseSkillFile(file),
        })
      } else if ((entry.isFile() || followed?.isFile() === true) && /\.md$/i.test(entry.name)) {
        const file = join(root.dir, entry.name)
        skills.push({
          root: root.key,
          dirName: entry.name.replace(/\.md$/i, ''),
          kind: 'flat',
          linked: entry.isSymbolicLink(),
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
  // 安装器常把版本放进目录名（如 1password-1.0.1），不能只允许 frontmatter 的 kebab-case。
  const match = /^([A-Za-z0-9_.-]{1,128})(?:\/SKILL\.md|\.md)$/i.exec(String(relPath || ''))
  if (!match || ['.', '..'].includes(match[1])) throw new Error('不支持的技能路径')
  const rootResolved = resolve(rootDir)
  const file = resolve(rootDir, String(relPath))
  if (!file.toLowerCase().startsWith((rootResolved + sep).toLowerCase())) throw new Error('路径越界')
  if (!existsSync(file)) throw new Error('技能文件不存在')
  return file
}

/** 详情按需读取，沿用开关的路径白名单；正文只作为文本展示，不执行其中的指令。 */
export function readSkill(rootDir, relPath) {
  const file = safeSkillFile(rootDir, relPath)
  return { ...parseSkillFile(file), file, content: readFileSync(file, 'utf8') }
}

/** 新技能单独建目录，先校验再落盘；同名平文件或目录也不能被覆盖。 */
export function createSkill(rootDir, { name, description, content } = {}) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || !KEBAB_NAME_RE.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error('技能名称只支持小写字母、数字和连字符，最多 64 个字符，如 my-skill')
  }
  if (typeof description !== 'string' || !description.trim() || description.length > 4096 || description.includes('\0')) {
    throw new Error('请填写技能说明（最多 4096 个字符）')
  }
  if (typeof content !== 'string' || !content.trim() || content.length > 262144 || content.includes('\0')) {
    throw new Error('请填写技能正文（最多 256K 个字符）')
  }
  mkdirSync(rootDir, { recursive: true })
  const key = name.toLowerCase()
  if (readdirSync(rootDir).some((entry) => entry.toLowerCase() === key || entry.toLowerCase() === `${key}.md`)) {
    throw new Error('同名技能已存在')
  }
  const dir = join(rootDir, name)
  // mkdir 不用 recursive，外部程序抢先创建同名目录时也不能写进它的目录。
  mkdirSync(dir)
  try {
    const summary = description.trim().replace(/\s+/g, ' ')
    // 折叠块避免说明中的引号、冒号被 YAML 当成结构。
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${summary}\n---\n\n${content.trim()}\n`, { flag: 'wx' })
  } catch (error) {
    // 只清理仍为空的目录，避免删掉其它程序并发放入的文件。
    try { rmdirSync(dir) } catch { /* 保留非空目录供用户检查 */ }
    throw error
  }
  return { relPath: `${name}/SKILL.md` }
}

/** 普通技能删整个目录；链接技能只摘顶层链接，保留原始目录和资源。 */
export function removeSkill(rootDir, relPath) {
  safeSkillFile(rootDir, relPath)
  const target = join(rootDir, String(relPath).split('/')[0])
  const linked = lstatSync(target).isSymbolicLink()
  if (linked) unlinkSync(target)
  else rmSync(target, { recursive: lstatSync(target).isDirectory() })
  return { linked }
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

const SKILL_IMPORT_LIMIT = 16 * 1024 * 1024
const SKILL_FILE_LIMIT = 2 * 1024 * 1024

/** 技能可以自带脚本与资源，但文件名必须在各平台上都能安全落盘。 */
function importPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\')) throw new Error('技能文件路径无效')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('技能文件路径无效')
  return value
}

/** 检测完整目录包，预览时不执行脚本，也不修改受管目录。 */
export function previewSkillFiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 2000) throw new Error('请选择技能文件夹或 ZIP（最多 2000 个文件）')
  const files = new Map(), seen = new Set()
  let total = 0
  for (const item of input) {
    const path = importPath(item.path)
    if (path.split('/').some((part) => part === '.git' || part === 'node_modules')) continue
    if (seen.has(path.toLowerCase())) throw new Error('技能包有重名文件')
    seen.add(path.toLowerCase())
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(String(item.base64 || ''), 'base64')
    total += data.length
    if (data.length > SKILL_FILE_LIMIT || total > SKILL_IMPORT_LIMIT) throw new Error('技能包过大：单文件最多 2 MB，总计最多 16 MB')
    files.set(path, data)
  }
  const skills = []
  for (const [path, data] of files) {
    if (path !== 'SKILL.md' && !path.endsWith('/SKILL.md')) continue
    const detail = parseSkillText(data.toString('utf8'))
    if (detail.name.length > 64 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(detail.name)) detail.frontmatterIssue = '技能名称无效'
    const prefix = path.slice(0, -'SKILL.md'.length)
    const resources = [...files].filter(([file]) => file.startsWith(prefix)).map(([file, buffer]) => ({ path: file.slice(prefix.length), data: buffer }))
    skills.push({ id: path, name: detail.name || prefix.split('/').filter(Boolean).at(-1) || 'skill', description: detail.description,
      issue: detail.frontmatterIssue, fileCount: resources.length, files: resources })
  }
  if (!skills.length) throw new Error('没有找到 SKILL.md，请选择完整技能文件夹或包含技能的 ZIP')
  return skills
}

/** GitHub 的 tree 链接可直接指向技能；仓库名默认取其默认分支。 */
export function parseSkillGithub(source, refOverride = '') {
  const text = String(source || '').trim()
  if (/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(text)) throw new Error('技能目录路径无效')
  let parts
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) parts = text.split('/')
  else {
    let url
    try { url = new URL(text) } catch { throw new Error('请填写 GitHub 仓库或技能目录链接') }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw new Error('请使用 https://github.com 的技能目录链接')
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  }
  const [owner, rawRepo, type, branch, ...path] = parts
  const repo = String(rawRepo || '').replace(/\.git$/, '')
  if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo) || (type && type !== 'tree')) throw new Error('请填写仓库或 tree 目录链接，不能使用文件链接')
  const ref = String(refOverride || branch || '').trim()
  if (ref && (!/^[\w./-]+$/.test(ref) || ref.includes('..'))) throw new Error('分支名称无效')
  return { owner, repo, ref, path: path.length ? importPath(path.join('/')) : '' }
}

/** 限量下载，沿用启动器代理；仓库档案只读取选中目录，避免解压整个项目。 */
export async function prepareSkillImport(body, fetcher = netFetch) {
  if (body.files) return previewSkillFiles(body.files)
  let bytes, selected = ''
  if (body.zip) {
    if (typeof body.zip !== 'string' || body.zip.length > 45 * 1024 * 1024) throw new Error('ZIP 最大 32 MB')
    bytes = Buffer.from(body.zip, 'base64')
  } else {
    const source = parseSkillGithub(body.source, body.ref)
    if (!source.ref) {
      const response = await fetcher(`https://api.github.com/repos/${source.owner}/${source.repo}`, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'dsh-x' } })
      if (!response.ok) throw new Error(`读取 GitHub 仓库失败（${response.status}），请确认仓库公开可访问`)
      source.ref = (await response.json()).default_branch
      if (!source.ref) throw new Error('仓库没有默认分支')
    }
    const response = await fetcher(`https://codeload.github.com/${source.owner}/${source.repo}/zip/${encodeURIComponent(source.ref)}`, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`下载 GitHub 技能失败（${response.status}）`)
    const chunks = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 32 * 1024 * 1024) throw new Error('仓库 ZIP 超过 32 MB，请改为导入技能文件夹')
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks)
    selected = source.path
  }
  if (bytes.length > 32 * 1024 * 1024) throw new Error('ZIP 最大 32 MB')
  const temp = mkdtempSync(join(tmpdir(), 'dsh-skill-import-'))
  try {
    const zip = join(temp, 'source.zip'); writeFileSync(zip, bytes)
    const { entries } = await readZipIndex(zip)
    const names = [...entries.keys()]
    // GitHub 档案有统一顶层目录，本地 ZIP 也允许把一个技能包在文件夹里。
    const first = names[0]?.split('/')[0]
    const wrapper = first && names.every((name) => name.startsWith(first + '/')) ? first + '/' : ''
    const files = []; let total = 0
    for (const [name, entry] of entries) {
      const path = name.slice(wrapper.length)
      if (selected && path !== selected + '/SKILL.md' && !path.startsWith(selected + '/')) continue
      importPath(path)
      if (path.split('/').some((part) => part === '.git' || part === 'node_modules')) continue
      if (entry.size > SKILL_FILE_LIMIT || total + entry.size > SKILL_IMPORT_LIMIT || files.length >= 2000) throw new Error('技能包过大：单文件最多 2 MB，总计最多 16 MB，2000 个文件')
      const chunks = []; let size = 0
      await readZipEntry(zip, entry, (chunk) => {
        size += chunk.length
        if (size > SKILL_FILE_LIMIT || total + size > SKILL_IMPORT_LIMIT) throw new Error('技能文件解压后过大')
        chunks.push(chunk)
      })
      const data = Buffer.concat(chunks)
      if (size !== entry.size || crc32(data) !== entry.crc32) throw new Error('技能 ZIP 文件校验失败')
      total += size; files.push({ path, data })
    }
    return previewSkillFiles(files)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

/** 先验证整批目标，再落盘；拒绝覆盖已有技能，失败时撤回本批新建目录。 */
export function installSkillPackages(rootDir, packages, selected) {
  if (!Array.isArray(selected) || !selected.length) throw new Error('请至少选择一个技能')
  const chosen = selected.map((id) => packages.find((item) => item.id === id))
  if (chosen.some((item) => !item || item.issue)) throw new Error('选中的技能无效，请检查 SKILL.md')
  const names = chosen.map((item) => item.name.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('选中的技能名称重复')
  mkdirSync(rootDir, { recursive: true })
  const existing = readdirSync(rootDir).map((name) => name.toLowerCase())
  for (const name of names) if (existing.includes(name) || existing.includes(name + '.md')) throw new Error(`同名技能 ${name} 已存在`)
  const created = []
  try {
    for (const item of chosen) {
      const dir = join(rootDir, item.name); mkdirSync(dir); created.push(dir)
      for (const file of item.files) {
        const target = join(dir, importPath(file.path))
        mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, file.data, { flag: 'wx' })
        if (file.data.subarray(0, 2).toString() === '#!') chmodSync(target, 0o755)
      }
    }
  } catch (error) {
    for (const dir of created) rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { installed: chosen.map((item) => item.name) }
}
