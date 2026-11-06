/**
 * dsh 启动加速钩子（只加速，不改行为）。
 *
 * dsh-client-modules 启动时要为浏览器端合成 20MB+ 的客户端 bundle，其中两处纯字符串
 * 操作有明显的实现缺陷（微基准实测，输出逐字节一致）：
 * - newlineCount 用 `for...of` 逐码点遍历整段文本数换行 —— 慢 56 倍；
 * - identitySectionMap 用 Array.from + join 逐项拼 sourcemap 的 mappings —— 慢 273 倍。
 *
 * 字符串加速只匹配已知实现；另在已知 runProfile 入口包一层启动缓存生命周期，
 * 成功或失败后立即清空。上游改写目标片段时自动跳过。
 */
import { patchProfileBoot } from './startup-resolver.mjs'

const TARGET = 'dsh-client-modules/lib/index.js'
const PROFILE_BOOT = /\/dsh\/lib\/profile-boot(?:-[^/]+)?\.js(?:\?.*)?$/
/** Cordis loader：启动账本靠它知道每个 entry 什么时候结算完（只观测，不改行为）。 */
const LOADER = 'cordis-plugin-loader/lib/index.js'
const LOADER_ENTRY = 'async _init() {'
/** `registry.plugin()` 的返回值形状换过一次：1.0.x 是 entry（fiber 在 .ctx.fiber），1.1.0 起直接是 fiber。 */
const LOADER_FIBER_ASSIGN = 'this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)'
const LOADER_FIBER_ANCHORS = [`${LOADER_FIBER_ASSIGN}.ctx.fiber;`, `${LOADER_FIBER_ASSIGN};`]
const LOADER_ENTRY_HOOK = 'async _init() {\n\t\tglobalThis[Symbol.for("dsh-x/plugin-profile")]?.enter(this);'
const LOADER_FIBER_HOOK = '\n\t\tglobalThis[Symbol.for("dsh-x/plugin-profile")]?.imported(this);'

/** 已知的慢实现（用于校验，必须精确匹配才动手）。 */
const SLOW_NEWLINE = 'function newlineCount(value) {\n\tlet count = 0;\n\tfor (const char of value) if (char === "\\n") count += 1;\n\treturn count;\n}'
const FAST_NEWLINE = 'function newlineCount(value) { let count = 0, i = -1; while ((i = value.indexOf("\\n", i + 1)) !== -1) count += 1; return count; }'

const SLOW_MAPPINGS = 'const mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");'
const FAST_MAPPINGS = 'const _lines = newlineCount(source); const mappings = _lines <= 0 ? "" : "AAAA" + ";AACA".repeat(_lines - 1);'

export function load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  const profileBoot = PROFILE_BOOT.test(url)
  const loader = url.includes(LOADER)
  if (!profileBoot && !loader && !url.includes(TARGET)) return result
  if (result.format !== 'module' || result.source === undefined) return result

  let source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source)
  if (profileBoot) {
    const patched = patchProfileBoot(source)
    return patched === source ? result : { ...result, source: patched }
  }
  if (loader) {
    // 两个锚点都在才注入：上游改了 loader 实现就整段跳过，账本自然没有 entry 时间线，启动照旧。
    const fiberAnchor = LOADER_FIBER_ANCHORS.find((anchor) => source.includes(anchor))
    if (!source.includes(LOADER_ENTRY) || !fiberAnchor) return result
    const patched = source.replace(LOADER_ENTRY, LOADER_ENTRY_HOOK).replace(fiberAnchor, fiberAnchor + LOADER_FIBER_HOOK)
    return { ...result, source: patched }
  }
  const applied = []

  // 逐字符校验后才替换：只有长得和实测过的慢实现一模一样才动手
  if (source.includes(SLOW_NEWLINE)) {
    source = source.replace(SLOW_NEWLINE, FAST_NEWLINE)
    applied.push('newlineCount')
  }
  if (source.includes(SLOW_MAPPINGS)) {
    source = source.replace(SLOW_MAPPINGS, FAST_MAPPINGS)
    applied.push('mappings')
  }

  if (process.env.DSH_PERF_DEBUG === '1') {
    console.error(`[perf] 客户端 bundle 合成加速: ${applied.length ? applied.join(' + ') : '未命中（跳过）'}`)
  }
  if (!applied.length) return result
  return { ...result, source }
}
