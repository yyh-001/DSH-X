import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

// Linux ARM64 原生出包的黑盒回归：配置（electron-builder）、CI（build.yml 的 linux job）、
// 落地页（docs/index.html 的 assetOf）三处必须对得上——任何一处单独改了，用户要么拿到
// 错架构的包，要么 electron-updater 在 arm64 上找不到 latest-linux-arm64.yml。

const fileUrl = (path) => new URL(`../${path}`, import.meta.url)
const read = (path) => readFileSync(fileURLToPath(fileUrl(path)), 'utf8')

// 发布资产统一叫 DSH-X-<版本>-<平台>-<架构>.<扩展名>，架构一律 x64 / arm64。
// electron-builder 的 ${arch} 在 AppImage 上会展开成 x86_64、deb 上展开成 amd64，所以 Linux
// 的 artifactName 直接按 process.arch 固化架构标签；测试在 x64 / arm64 runner 上都跑，
// 两边分别校验本机产出的名字，配置里写死成某一种架构会立刻挂。
const EXT = { AppImage: 'AppImage', deb: 'deb' }
// x64 的更新清单不带后缀是 electron-updater 的历史约定；arm64 的带 -arm64，updater 按 process.arch 找
const FEED = { x64: 'latest-linux.yml', arm64: 'latest-linux-arm64.yml' }
const RUNNER = { x64: 'ubuntu-latest', arm64: 'ubuntu-24.04-arm' }
const OUTPUT_DIR = 'release/eb'
const LINUX_FORMATS = ['AppImage', 'deb']
const ARCHES = ['x64', 'arm64']
// 正式版和预发布版各一个：预发布版号里自带连字符，`[^-]+` 一类的写法会在这里露馅
const VERSIONS = ['0.2.0', '0.2.0-rc.1']

const linuxFile = (version, arch, format) => `DSH-X-${version}-linux-${arch}.${EXT[format]}`
/** 某一台 runner 打完包后 release/eb 里和 Linux 发版相关的文件（只有本机架构那一份）。 */
const runnerOutputs = (version, arch) => [
  ...LINUX_FORMATS.map((format) => `${OUTPUT_DIR}/${linuxFile(version, arch, format)}`),
  `${OUTPUT_DIR}/${FEED[arch]}`,
]

// ---------- electron-builder 配置 ----------

const loadBuilderConfig = async () => (await import(pathToFileURL(fileURLToPath(fileUrl('electron-builder.config.mjs'))).href)).default
/** target 可以写成字符串或 { target, arch }，统一成对象再判断，避免写法不同导致误判。 */
const normalizeTargets = (targets) => [targets].flat().filter(Boolean).map((t) => (typeof t === 'string' ? { target: t } : t))
/** 按 electron-builder 的优先级取文件名模板：格式级（appImage / deb）覆盖平台级（linux）。 */
const artifactTemplate = (config, format) => {
  const formatKey = format === 'AppImage' ? 'appImage' : format
  return config[formatKey]?.artifactName ?? config.linux?.artifactName
}
const expandArtifactName = (template, { version, arch, format }) =>
  template
    .replaceAll('${productName}', 'DSH-X')
    .replaceAll('${version}', version)
    // mac / win 模板仍用 ${arch}；Linux 模板在配置加载时已按 process.arch 固化
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', EXT[format])

test('electron-builder 配置是纯 ESM 默认导出，只依赖 node:path', async () => {
  const config = await loadBuilderConfig()
  assert.equal(typeof config, 'object', '默认导出必须是配置对象')
  assert.ok(config.linux, '必须有 linux 段')
  const source = read('electron-builder.config.mjs')
  const imports = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  // 打包脚本和测试都在任意一台机器上直接 import 它，多一个依赖就多一个装不上的风险
  assert.deepEqual([...new Set(imports)], ['node:path'], `只允许 import node:path，实际：${imports.join(', ')}`)
})

test('Linux 目标恰好是 AppImage + deb（等价类：格式集合）', async () => {
  const { linux } = await loadBuilderConfig()
  const names = normalizeTargets(linux.target).map((t) => t.target).sort()
  assert.deepEqual(names, [...LINUX_FORMATS].sort())
})

test('Linux 目标不钉架构：每个 target 都不写 arch，按打包机架构出包', async () => {
  const { linux } = await loadBuilderConfig()
  for (const t of normalizeTargets(linux.target)) {
    // 写死 ['x64'] 会让 arm64 runner 交叉打 x64；写成两个都打会让两台 runner 上传同名资产互相覆盖
    assert.equal(t.arch, undefined, `${t.target} 不应带 arch 字段，实际：${JSON.stringify(t.arch)}`)
  }
})

test('Linux 文件名带架构且两种格式写法一致：x64 / arm64 × AppImage / deb 互不冲突', async () => {
  const config = await loadBuilderConfig()
  for (const format of LINUX_FORMATS) {
    const template = artifactTemplate(config, format)
    assert.equal(typeof template, 'string', `${format} 没有 artifactName`)
    // ${arch} 在 AppImage 上会展开成 x86_64、deb 上展开成 amd64，同一份 x64 包两种写法
    assert.doesNotMatch(template, /\$\{arch\}/, `${format} 的 artifactName 不要用 \${arch}（各格式展开结果不同）`)
  }
  for (const version of VERSIONS) {
    // 配置按打包机架构固化标签；本机 runner 的 process.arch 就是实际产出的架构
    const produced = LINUX_FORMATS.map((format) =>
      expandArtifactName(artifactTemplate(config, format), { version, arch: process.arch, format }))
    // 落地页和 workflow 的 glob 按 DSH-X-<v>-linux-<arch>.<ext> 认包，配置改了命名规则三处要一起改
    const expected = LINUX_FORMATS.map((format) => linuxFile(version, process.arch, format))
    assert.deepEqual(produced, expected)
    // 两台 runner 的文件名仍然互不冲突（测试本身在 x64 和 arm64 runner 上各跑一次）
    const both = ARCHES.flatMap((arch) => LINUX_FORMATS.map((format) => linuxFile(version, arch, format)))
    assert.equal(new Set(both).size, both.length, `文件名冲突：${both.join(', ')}`)
  }
})

test('Windows / mac 目标不受影响：win nsis x64，mac dmg arm64 + x64', async () => {
  const { win, mac } = await loadBuilderConfig()
  const winTargets = normalizeTargets(win.target)
  assert.deepEqual(winTargets.map((t) => t.target), ['nsis'])
  assert.deepEqual(winTargets[0].arch, ['x64'])
  const macTargets = normalizeTargets(mac.target)
  assert.deepEqual(macTargets.map((t) => t.target), ['dmg'])
  assert.deepEqual([...macTargets[0].arch].sort(), ['arm64', 'x64'])
})

// ---------- .github/workflows/build.yml 的 linux job（纯文本解析，不引 YAML 依赖） ----------

const WORKFLOW = read('.github/workflows/build.yml')
const indentOf = (line) => line.match(/^ */)[0].length
/** YAML 注释去掉再做「不许出现」类断言：注释里解释「为什么不用 QEMU」是正当的。 */
const stripComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n')
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** 从 `  <name>:` 切到下一个同级 job，拿到整个 job 的文本。 */
function jobBlock(name) {
  const lines = WORKFLOW.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^  ${name}:\\s*(#.*)?$`).test(line))
  assert.ok(start >= 0, `workflow 里找不到 ${name} job`)
  let end = start + 1
  while (end < lines.length && !/^ {2}[\w-]+:\s*(#.*)?$/.test(lines[end]) && !/^\S/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

/** 按 `steps:` 下一级的 `- ` 切出每个 step 的文本。 */
function stepsOf(block) {
  const lines = block.split('\n')
  const at = lines.findIndex((line) => /^\s*steps:\s*$/.test(line))
  assert.ok(at >= 0, 'job 里没有 steps')
  const base = indentOf(lines[at])
  const steps = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && indentOf(line) <= base && !line.trimStart().startsWith('- ')) break
    if (line.trimStart().startsWith('- ') && indentOf(line) <= base + 2) steps.push([line])
    else if (steps.length) steps.at(-1).push(line)
  }
  return steps.map((s) => s.join('\n'))
}

/** matrix.include 里的每一项解析成 { key: value }。 */
function matrixEntries(block) {
  const lines = block.split('\n')
  const at = lines.findIndex((line) => /^\s*include:\s*$/.test(line))
  assert.ok(at >= 0, 'linux job 没有 matrix.include')
  const base = indentOf(lines[at])
  const entries = []
  for (const raw of lines.slice(at + 1)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    if (indentOf(raw) <= base && !raw.trimStart().startsWith('- ')) break
    const line = raw.replace(/\s#.*$/, '')
    const isNew = line.trimStart().startsWith('- ')
    const pair = line.trim().replace(/^- /, '').match(/^([\w-]+):\s*(.*)$/)
    if (isNew) entries.push({})
    if (pair && entries.length) entries.at(-1)[pair[1]] = unquote(pair[2])
  }
  return entries
}

/** `${{ matrix.xxx }}` 按某一项矩阵展开，模拟那台 runner 实际看到的值。 */
const withMatrix = (text, entry) => text.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key) => entry[key] ?? `<missing matrix.${key}>`)
const stepIf = (step) => step.match(/^\s*(?:- )?if:\s*(.+)$/m)?.[1] ?? ''
/** bash / actions glob 都只用到 *、?，转成正则在模拟出来的 release/eb 文件上匹配。 */
const globToRegExp = (glob) => new RegExp(`^${glob.split('').map((ch) =>
  ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`)
const matchesGlob = (glob, file) => globToRegExp(glob).test(file)

/** upload-artifact 的 path（单行或 `|` 多行块）。 */
function artifactPaths(step) {
  const lines = step.split('\n')
  const at = lines.findIndex((line) => /^\s*path:/.test(line))
  assert.ok(at >= 0, 'upload-artifact 没有 path')
  const inline = lines[at].replace(/^\s*path:\s*/, '').replace(/\s#.*$/, '').trim()
  if (inline && inline !== '|' && inline !== '>') return [unquote(inline)]
  const base = indentOf(lines[at])
  const paths = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && indentOf(line) <= base) break
    const value = line.replace(/\s#.*$/, '').trim()
    if (value) paths.push(unquote(value))
  }
  return paths
}

/** `gh release upload <tag> <文件…>` 里的文件参数（续行先拼起来，去掉 tag 和选项）。 */
function ghUploadFiles(step) {
  const script = stripComments(step).replace(/\\\n\s*/g, ' ')
  const line = script.split('\n').find((l) => /gh release upload/.test(l))
  assert.ok(line, '发布 step 里没有 gh release upload')
  const tokens = line.slice(line.indexOf('gh release upload') + 'gh release upload'.length).trim().split(/\s+/).map(unquote)
  return tokens.slice(1).filter((t) => t && !t.startsWith('-'))
}

const LINUX = jobBlock('linux')
const LINUX_STEPS = stepsOf(LINUX)
const findStep = (pattern, label) => {
  const step = LINUX_STEPS.find((s) => pattern.test(s))
  assert.ok(step, `linux job 里找不到「${label}」step`)
  return step
}
const distStep = () => findStep(/npm run dist/, '打包')
const artifactStep = () => findStep(/uses:\s*actions\/upload-artifact/, 'upload-artifact')
const releaseStep = () => findStep(/gh release upload/, '挂到 Release')

test('linux job 是两项矩阵：ubuntu-latest(x64) + 原生 ubuntu-24.04-arm(arm64)，fail-fast: false', () => {
  const entries = matrixEntries(LINUX)
  assert.equal(entries.length, 2, `矩阵应恰好两项，实际：${JSON.stringify(entries)}`)
  for (const arch of ARCHES) {
    const entry = entries.find((e) => e.arch === arch)
    assert.ok(entry, `缺少 arch: ${arch} 的矩阵项`)
    assert.ok(Object.values(entry).includes(RUNNER[arch]), `${arch} 应跑在 ${RUNNER[arch]}，实际：${JSON.stringify(entry)}`)
  }
  // 一台挂了不能把另一台的包也取消掉：x64 是存量用户，arm64 是新增，互不牵连
  assert.match(stripComments(LINUX), /^\s*fail-fast:\s*false\s*$/m)
})

test('runs-on 取自矩阵：每一项展开后正好是自己的 runner', () => {
  const runsOn = stripComments(LINUX).match(/^\s{4}runs-on:\s*(.+)$/m)?.[1]?.trim()
  assert.ok(runsOn, 'linux job 没有 runs-on')
  assert.match(runsOn, /\$\{\{\s*matrix\.[\w-]+\s*\}\}/, `runs-on 必须来自矩阵，实际：${runsOn}`)
  for (const entry of matrixEntries(LINUX)) {
    assert.equal(withMatrix(runsOn, entry), RUNNER[entry.arch])
  }
})

test('不走 QEMU / docker 交叉构建（arm64 靠原生 runner）', () => {
  const code = stripComments(WORKFLOW)
  assert.doesNotMatch(code, /setup-qemu-action/i)
  assert.doesNotMatch(stripComments(LINUX), /qemu|binfmt|docker\/setup-buildx-action/i)
})

test('两台 runner 上传的 workflow artifact 名带矩阵 arch、互不相同', () => {
  const name = artifactStep().match(/^\s*name:\s*(.+)$/m)?.[1]?.replace(/\s#.*$/, '').trim()
  assert.ok(name, 'upload-artifact 没有 name')
  assert.match(name, /\$\{\{\s*matrix\.arch\s*\}\}/, `artifact 名要包含 matrix.arch，实际：${name}`)
  const names = matrixEntries(LINUX).map((entry) => withMatrix(unquote(name), entry))
  // 同名 artifact 在 upload-artifact@v4 下第二个直接报 409，arm64 的包就丢了
  assert.equal(new Set(names).size, names.length, `artifact 名冲突：${names.join(', ')}`)
})

// 决策表：runner 架构 × 版本号 → 该 runner 上的 artifact / Release 上传必须带齐本机三件（AppImage、deb、更新清单）
for (const version of VERSIONS) {
  for (const arch of ARCHES) {
    test(`workflow artifact 在 ${arch} runner 上收齐 AppImage + deb + ${FEED[arch]}（版本 ${version}）`, () => {
      const entry = matrixEntries(LINUX).find((e) => e.arch === arch)
      assert.ok(entry, `没有 ${arch} 矩阵项`)
      const globs = artifactPaths(artifactStep()).map((p) => withMatrix(p, entry))
      for (const file of runnerOutputs(version, arch)) {
        assert.ok(globs.some((g) => matchesGlob(g, file)), `${file} 没被 artifact path 覆盖：${globs.join(' | ')}`)
      }
    })

    test(`gh release upload 在 ${arch} runner 上传齐本机三件，且每个参数都能展开到真实文件（版本 ${version}）`, () => {
      const entry = matrixEntries(LINUX).find((e) => e.arch === arch)
      assert.ok(entry, `没有 ${arch} 矩阵项`)
      const files = runnerOutputs(version, arch)
      const args = ghUploadFiles(releaseStep()).map((a) => withMatrix(a, entry))
      for (const file of files) {
        assert.ok(args.some((g) => matchesGlob(g, file)), `${file} 不在 gh release upload 里：${args.join(' ')}`)
      }
      // bash 里没匹配上的 glob 会原样传给 gh，gh 当成文件找不到直接失败：
      // 所以 x64 机器上不能写死 latest-linux-arm64.yml（反之亦然），得用 latest-linux*.yml 这类 glob
      for (const arg of args) {
        assert.ok(files.some((file) => matchesGlob(arg, file)), `${arch} runner 上「${arg}」匹配不到任何产物，gh 会报文件不存在`)
      }
    })
  }
}

test('两台 runner 合起来，Release 上同时有 latest-linux.yml 与 latest-linux-arm64.yml', () => {
  const uploaded = new Set()
  for (const entry of matrixEntries(LINUX)) {
    const args = ghUploadFiles(releaseStep()).map((a) => withMatrix(a, entry))
    for (const file of runnerOutputs(VERSIONS[0], entry.arch)) {
      if (args.some((g) => matchesGlob(g, file))) uploaded.add(file.slice(OUTPUT_DIR.length + 1))
    }
  }
  for (const feed of Object.values(FEED)) assert.ok(uploaded.has(feed), `Release 缺 ${feed}`)
})

test('打包 / artifact / Release 上传仍受 shell_changed 门控，Release 另要求 tag 构建', () => {
  const gate = /needs\.prepare\.outputs\.shell_changed\s*==\s*'1'/
  for (const [label, step] of [['打包', distStep()], ['upload-artifact', artifactStep()], ['Release 上传', releaseStep()]]) {
    assert.match(stepIf(step), gate, `${label} step 的 if 必须判断 shell_changed == '1'，实际：${stepIf(step)}`)
  }
  assert.match(stepIf(releaseStep()), /refs\/tags\/v/, 'Release 上传只在 tag 构建时做')
  assert.doesNotMatch(stepIf(artifactStep()), /refs\/tags\/v/, 'workflow artifact 手动触发也要有，不能只在 tag 上传')
})

test('状态：纯核心发版（shell_changed=0）两台 runner 仍跑测试，只是不打包', () => {
  // 门控必须落在 step 上而不是 job 上：job 级 if 会让纯核心发版连 Linux 测试一起跳过
  const jobHeader = LINUX.split(/^\s*steps:\s*$/m)[0]
  assert.doesNotMatch(stripComments(jobHeader), /^\s{4}if:.*shell_changed/m, 'linux job 不能整体按 shell_changed 跳过')
  assert.match(stripComments(LINUX), /^\s{4}needs:\s*\[?\s*prepare/m, '仍依赖 prepare 拿 shell_changed')
  const testStep = findStep(/npm test/, '跑测试')
  assert.doesNotMatch(stepIf(testStep), /shell_changed/, '测试 step 不受 shell_changed 影响')
})

// ---------- prepare job：纯核心预发布 tag 上补上一次外壳发版的更新清单 ----------

// 预发布通道的 electron-updater 不看 /releases/latest，而是在最新的 rc/alpha tag 上找自己那份清单；
// 纯核心的 rc tag 没有安装包，清单得从上一次外壳发版抄过来。三份清单各对应一种架构/平台，
// 少抄一份，那个平台的用户在这个 tag 上就会报「找不到 latest*.yml」。
const COPIED_FEEDS = ['latest.yml', FEED.x64, FEED.arm64]

const prepareReleaseStep = () => {
  const step = stepsOf(jobBlock('prepare')).find((s) => /gh release create/.test(s))
  assert.ok(step, 'prepare job 里找不到建 Release 的 step')
  return step
}

/** 抄清单的那段：`for <变量> in <列表>; do` 所在行，连同它外层最近的那条 `if`。 */
function feedCopyBlock() {
  const lines = stripComments(prepareReleaseStep()).split('\n')
  const at = lines.findIndex((line) => /^\s*for\s+\w+\s+in\s+[^;]*latest[^;]*\.yml/.test(line))
  assert.ok(at >= 0, '建 Release 的 step 里找不到遍历更新清单的 for 循环')
  const [, variable, list] = lines[at].match(/^\s*for\s+(\w+)\s+in\s+([^;]+);/) ?? []
  assert.ok(variable, `for 循环写法认不出来：${lines[at].trim()}`)
  let guardAt = at - 1
  while (guardAt >= 0 && !(indentOf(lines[guardAt]) < indentOf(lines[at]) && /^\s*if\s/.test(lines[guardAt]))) guardAt--
  assert.ok(guardAt >= 0, '抄清单的 for 循环外面没有 if 门控')
  let end = at + 1
  while (end < lines.length && !(lines[end].trim() && indentOf(lines[end]) <= indentOf(lines[guardAt]))) end++
  return {
    variable,
    feeds: list.trim().split(/\s+/).map(unquote),
    guard: lines[guardAt].trim(),
    body: lines.slice(at, end).join('\n'),
    createAt: lines.findIndex((line) => /gh release create/.test(line)),
    loopAt: at,
  }
}

test('纯核心预发布 tag 抄的清单齐三份：latest.yml + latest-linux.yml + latest-linux-arm64.yml', () => {
  const { feeds } = feedCopyBlock()
  for (const feed of COPIED_FEEDS) assert.ok(feeds.includes(feed), `抄清单的列表缺 ${feed}，实际：${feeds.join(' ')}`)
  assert.equal(new Set(feeds).size, feeds.length, `清单列表有重复：${feeds.join(' ')}`)
})

test('抄清单的循环真的按每份清单去 download / upload（列表不是摆设）', () => {
  const { variable, body } = feedCopyBlock()
  const ref = `"?\\$\\{?${variable}\\}?"?`
  assert.match(body, new RegExp(`gh release download[^\\n]*--pattern\\s+${ref}`), 'download 要按循环变量取对应那份清单')
  assert.match(body, new RegExp(`gh release upload[^\\n]*${ref}`), 'upload 要把循环变量对应的那份清单传上去')
  // 写死 latest.yml 会让三轮都在抄 Windows 那份，Linux 两份照样缺
  assert.doesNotMatch(body, /--pattern\s+["']?latest\.yml/, 'download 不能写死 latest.yml')
})

test('抄清单只在「预发布 tag 且 shell_changed == 0」时做，且在 Release 建好之后', () => {
  const { guard, createAt, loopAt } = feedCopyBlock()
  // 正式版有 /releases/latest 兜底，外壳发版有自己的新清单：这两种情况再抄旧清单会把新版本号盖回去
  assert.match(guard, /\$\{?tag\}?"?\s*==\s*\*-\*/, `门控要判断 tag 带连字符（预发布），实际：${guard}`)
  assert.match(guard, /shell_changed\s*\}\}"?\s*=\s*"?0"?/, `门控要判断 shell_changed 为 0，实际：${guard}`)
  assert.match(guard, /&&/, `两个条件要同时成立，实际：${guard}`)
  assert.doesNotMatch(guard, /\|\|/, `不能用 || 放宽门控，实际：${guard}`)
  assert.ok(createAt >= 0 && createAt < loopAt, '先 gh release create，再往上面抄清单')
  assert.match(stepIf(prepareReleaseStep()), /refs\/tags\/v/, '建 Release 这一步只在 tag 构建时跑')
})

// ---------- docs/index.html 的 assetOf：落地页按钮挑哪个资产 ----------

const PAGE = read('docs/index.html')

/**
 * 从页面里抠出 `const assetOf = {...}` 的对象字面量放进 vm 求值。
 * 不按括号配对去切：正则里可能有 {1,} 这类花括号，逐个 `}` 试编译，第一次成功的就是完整对象。
 */
function loadAssetOf() {
  const head = PAGE.indexOf('const assetOf = {')
  assert.ok(head >= 0, '落地页里找不到 const assetOf = {')
  const start = PAGE.indexOf('{', head)
  for (let end = PAGE.indexOf('}', start); end >= 0; end = PAGE.indexOf('}', end + 1)) {
    const literal = PAGE.slice(start, end + 1)
    try {
      return vm.runInNewContext(`(${literal})`, {})
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.name !== 'SyntaxError') throw error
    }
  }
  assert.fail('assetOf 对象字面量无法求值')
}

/** Linux 下拉里两项各自用哪个 assetOf 键，读 paintLinks 里的 set(linux[i], "...")。 */
function linuxButtonKinds() {
  const kindAt = (i) => PAGE.match(new RegExp(`set\\(linux\\[${i}\\],\\s*["'](\\w+)["']\\)`))?.[1]
  const kinds = { AppImage: kindAt(0), deb: kindAt(1) }
  assert.ok(kinds.AppImage && kinds.deb, `paintLinks 里找不到 Linux 两个按钮对应的 assetOf 键：${JSON.stringify(kinds)}`)
  return kinds
}

const asset = (name) => ({ name, browser_download_url: `https://github.com/yyh-001/DSH-X/releases/download/v/${name}` })
const macDmg = (version, arch) => `DSH-X-${version}-mac-${arch}.dmg`
/** 一份 release 的资产，Linux 部分按给定架构与顺序排；mac / win / 清单穿插其中，模拟真实列表的杂项。 */
function releaseAssets(version, linuxArches) {
  return [
    `DSH-X-${version}-win-x64.exe`,
    `DSH-X-${version}-win-x64.exe.blockmap`,
    'DSH-Setup.exe',
    'latest.yml',
    macDmg(version, 'arm64'),
    macDmg(version, 'x64'),
    ...linuxArches.flatMap((arch) => [...LINUX_FORMATS.map((format) => linuxFile(version, arch, format)), FEED[arch]]),
  ].map(asset)
}

const assetOf = loadAssetOf()
const pick = (kind, assets) => assetOf[kind](assets)?.name

// 决策表：Linux 资产里有哪些架构 × 排列顺序 × 按钮格式 → 期望结果
// （有 x64 就必须是 x64 那份；没有 x64 就是 undefined，页面回退到发布页，绝不能递给 x64 用户一个 arm64 包）
const PRESENCE = {
  'arm64 在前': ['arm64', 'x64'],
  'x64 在前': ['x64', 'arm64'],
  '只有 x64': ['x64'],
  '只有 arm64': ['arm64'],
  '没有 Linux 资产': [],
}
for (const version of VERSIONS) {
  for (const [label, linuxArches] of Object.entries(PRESENCE)) {
    for (const format of LINUX_FORMATS) {
      const expected = linuxArches.includes('x64') ? linuxFile(version, 'x64', format) : undefined
      test(`落地页 Linux「${format}」按钮：${label} → ${expected ?? 'undefined（回退发布页）'}（版本 ${version}）`, () => {
        const kind = linuxButtonKinds()[format]
        assert.equal(pick(kind, releaseAssets(version, linuxArches)), expected)
        // 整个列表倒过来也一样：结果不能依赖 GitHub API 返回资产的顺序
        assert.equal(pick(kind, releaseAssets(version, linuxArches).reverse()), expected)
      })
    }
  }
}

test('落地页 Linux 按钮在 arm64 资产全部排最前时仍不会拿到 arm64 包（边界：最不利的顺序）', () => {
  const kinds = linuxButtonKinds()
  for (const version of VERSIONS) {
    const all = releaseAssets(version, ['x64', 'arm64'])
    const arm = all.filter((a) => /arm64/.test(a.name))
    const worst = [...arm, ...all.filter((a) => !arm.includes(a))]
    for (const format of LINUX_FORMATS) {
      const picked = pick(kinds[format], worst)
      assert.equal(picked, linuxFile(version, 'x64', format))
      assert.doesNotMatch(picked, /arm64/)
    }
  }
})

test('落地页 mac 按钮不和 Linux arm64 混淆：arm64 AppImage / deb 排在 dmg 前面也照样挑 dmg', () => {
  for (const version of VERSIONS) {
    for (const linuxArches of [['arm64', 'x64'], ['arm64']]) {
      const all = releaseAssets(version, linuxArches)
      const linuxFirst = [...all.filter((a) => /\.(AppImage|deb)$/.test(a.name)), ...all.filter((a) => !/\.(AppImage|deb)$/.test(a.name))]
      for (const assets of [all, linuxFirst, [...linuxFirst].reverse()]) {
        assert.equal(pick('macArm', assets), macDmg(version, 'arm64'))
        assert.equal(pick('macX64', assets), macDmg(version, 'x64'))
        assert.equal(pick('win', assets), `DSH-X-${version}-win-x64.exe`)
      }
    }
  }
})

test('状态：≤0.1.26 的旧命名仍能被认出来（发布列表里还有老版本，下载计数也靠它）', () => {
  const version = '0.1.26'
  const legacy = [
    `DSH-Setup-${version}.exe`,
    `DSH-Setup-${version}.exe.blockmap`,
    'DSH-Setup.exe',
    'latest.yml',
    `DSH-X-${version}-arm64.dmg`,
    `DSH-X-${version}-x64.dmg`,
    `DSH-X-${version}-x86_64.AppImage`,
    `DSH-X-${version}-amd64.deb`,
    `DSH-X-${version}-arm64.AppImage`,
    `DSH-X-${version}-arm64.deb`,
  ].map(asset)
  assert.equal(pick('win', legacy), `DSH-Setup-${version}.exe`)
  assert.equal(pick('macArm', legacy), `DSH-X-${version}-arm64.dmg`)
  assert.equal(pick('macX64', legacy), `DSH-X-${version}-x64.dmg`)
  assert.equal(pick('appImage', legacy), `DSH-X-${version}-x86_64.AppImage`)
  assert.equal(pick('deb', legacy), `DSH-X-${version}-amd64.deb`)
})

test('落地页 Linux 按钮不会被 mac 的 arm64 dmg 或更新清单误配（边界：只有非 Linux 资产）', () => {
  const kinds = linuxButtonKinds()
  const version = VERSIONS[0]
  const noise = [macDmg(version, 'arm64'), macDmg(version, 'x64'), ...Object.values(FEED), 'latest.yml'].map(asset)
  for (const format of LINUX_FORMATS) assert.equal(pick(kinds[format], noise), undefined)
  for (const kind of Object.keys(assetOf)) assert.equal(pick(kind, []), undefined, `${kind} 在空列表上应返回 undefined`)
})

test('状态：API 还没回来（或限流）时，兜底链接不会把用户送回旧版本', () => {
  // GitHub API 未认证 60 次/小时，用完时页面就靠 HTML 里写死的 href。
  // Windows 有稳定的 DSH-Setup.exe 兼容桥；mac / Linux 的资产名带版本，只能回发布页，
  // 不能再写死某个旧版本（之前停在 v0.1.22，限流时用户会悄悄拿到四版之前的包）。
  const win = PAGE.match(/id="download"[^>]*href="([^"]+)"/)?.[1]
  assert.equal(win, 'https://github.com/yyh-001/DSH-X/releases/latest/download/DSH-Setup.exe')
  for (const id of ['macSplit', 'linuxSplit']) {
    const menu = PAGE.match(new RegExp(`id="${id}"[\\s\\S]*?class="split-menu"[\\s\\S]*?<\\/div>`))?.[0]
    assert.ok(menu, `找不到 #${id}`)
    const hrefs = [...menu.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    assert.equal(hrefs.length, 2, `${id} 应有两条下载链接，实际：${hrefs.join(', ')}`)
    for (const href of hrefs) {
      assert.equal(href, 'https://github.com/yyh-001/DSH-X/releases/latest', `${id} 的兜底链接应退回发布页，实际：${href}`)
    }
  }
})
