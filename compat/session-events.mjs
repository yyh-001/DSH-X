/**
 * 会话事件词汇兼容补丁。
 *
 * 问题：第三方插件会往会话日志里写自己的事件类型（如 `filesnap/point`）。dsh 的读取器
 * 遇到不认识的事件类型会**拒绝读取整份日志**——除非该事件写入时带了 `ignorable`
 * 标记，而 dsh 的 `Session.append` 目前不提供这个开关（插件只能靠"把自己塞进 dsh 已知
 * 集合"绕过，卸载即失效）。filesnap 作者在源码注释里明确写过这个代价：
 * "uninstalling the plugin strands those sessions"。
 *
 * 本补丁让 dsh 重新认识这些**纯日志性质**的事件类型，从而读出那些会话。
 * 事件本身仍原样保留在日志里（不删改任何数据），只是不再让读取器拒绝整份日志。
 *
 * 覆盖四层校验（都靠 KNOWN_SESSION_EVENT_TYPES 判"认不认识"）：
 *   1. dsh-session 的 KNOWN_SESSION_EVENT_TYPES —— 事件词汇表；
 *   2. v0 历史格式的冻结词汇表 RELEASED_V0_EVENT_DISPOSITIONS —— 旧日志迁移用；
 *   3. 该格式的语义校验 switch —— 未知类型会落到 default 抛错；
 *   4. dsh-session-persistence 的 validateStoredEvents —— 迁移完成后落库前再查一次词汇表
 *      （这一层查的是迁移后的 seq，旧日志经过打包行折叠会重新编号）。
 *
 * 除了事件词汇表，这里还兜一个 dsh 的健壮性缺口（见 appBootStackPatch 的注释）。
 *
 * 安全：只在源码结构匹配时替换，dsh 升级导致代码变化即自动跳过（不改坏任何东西）。
 */
const SESSION_TYPES = ['filesnap/point', 'filesnap/rewound', 'filesnap/redone']

/** 带载荷字段的类型 —— 字段声明为可选，避免键校验把它们当多余字段拒绝。 */
const PAYLOAD_KEYS = {
  'filesnap/point': ['turn', 'point', 'manifest', 'reused', 'hashed', 'dropped'],
  'filesnap/rewound': [],
  'filesnap/redone': [],
}

function knownSetPatch(source) {
  const anchor = 'const KNOWN_SESSION_EVENT_TYPES = new Set(['
  if (!source.includes(anchor)) return null
  const injected = SESSION_TYPES.map((type) => JSON.stringify(type)).join(',')
  return source.replace(anchor, `${anchor}${injected},`)
}

function dispositionsPatch(source) {
  const anchor = 'const RELEASED_V0_EVENT_DISPOSITIONS = Object.freeze({'
  if (!source.includes(anchor)) return null
  const entries = SESSION_TYPES
    .map((type) => `${JSON.stringify(type)}: defineReleasedPayloadDisposition([],${JSON.stringify(PAYLOAD_KEYS[type] ?? [])},[])`)
    .join(',')
  return source.replace(anchor, `${anchor}${entries},`)
}

function semanticsPatch(source) {
  const anchor = 'default: throw new SessionFormatError(`released payload validator is missing event'
  if (!source.includes(anchor)) return null
  const cases = SESSION_TYPES.map((type) => `case ${JSON.stringify(type)}:`).join(' ')
  // 这些是纯日志事件：没有需要校验的语义，直接放行
  return source.replace(anchor, `${cases} return;\n\t\t${anchor}`)
}

/**
 * dsh-app-boot 改写错误 stack 的两处要能容错。
 *
 * 注册过任意 ESM loader 钩子时（我们的 perf/ 与 compat/ 就是），Node 22.19 会把解析错误
 * 的 stack 变成只读的自有属性（实测 `writable: false`）。而 app-boot 为了把报错里的
 * importer 路径还原成真实调用方，会执行 `error.stack = ...` —— 这一写直接抛
 * `TypeError: Cannot assign to read only property 'stack'`，把原来的错误码
 * （`ERR_PACKAGE_PATH_NOT_EXPORTED` 之类）顶掉。dsh 0.1.7 新增的插件元数据读取
 * （`readPluginMeta` 会探测 `<包>/locale/en.json`）正好走这条路，于是「设置 → 内置插件」
 * 大面积报错（issue #24：188 条里 179 条带 meta.error）。
 *
 * 这里只把赋值本身包进 try/catch：写得进去行为不变；写不进去就放弃改写 stack，
 * 保住原始错误码。dsh 升级改掉这两行就会自动跳过。
 */
export function appBootStackPatch(source) {
  const assignments = [
    'if (stack !== void 0) error.stack = stack.replace(originalMessage, message);',
    'if (stack !== void 0) error.stack = stack.replace(originalMessage, error.message);',
  ]
  let out = source
  let patched = 0
  for (const line of assignments) {
    if (!out.includes(line)) continue
    const guarded = line.replace(
      /^if \(stack !== void 0\) (error\.stack = .*);$/,
      'if (stack !== void 0) { try { $1; } catch { /* stack 只读（注册过 ESM 钩子时 Node 会这样）：放弃改写，保留原始错误码 */ } }',
    )
    if (guarded === line) continue
    out = out.replace(line, guarded)
    patched += 1
  }
  return patched ? out : null
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (result.format !== 'module' || result.source === undefined) return result

  let source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source)
  const before = source.length
  const applied = []

  if (url.includes('dsh-session/lib/index.js')) {
    const next = knownSetPatch(source)
    if (next !== null) { source = next; applied.push('事件词汇表') }
  }
  if (url.includes('dsh-app-boot/lib/index.js')) {
    const next = appBootStackPatch(source)
    if (next !== null) { source = next; applied.push('错误 stack 安全写') }
  }
  if (url.includes('dsh-session-format-v0-to-v1/lib/index.js')) {
    const a = dispositionsPatch(source)
    if (a !== null) { source = a; applied.push('v0 词汇表') }
    const b = semanticsPatch(source)
    if (b !== null) { source = b; applied.push('v0 语义校验') }
  }

  if (process.env.DSH_PERF_DEBUG === '1' && applied.length) {
    console.error(`[compat] 会话事件兼容: ${applied.join(' + ')}`)
  }
  if (source.length === before) return result
  return { ...result, source }
}
