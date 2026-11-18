/**
 * dsh-x-computer-use 主机侧插件。
 *
 * 原则：
 * 1. 只在 DSH-X 桌面外壳启动（`DSH_X_DESKTOP=1`）且用户在设置里开启「电脑操作」时，
 *    才向模型注册 `@deepseek-ai/dsh-cua` 的 `cua` 工具；
 * 2. 非 DSH-X 启动或默认关闭时静默降级（不注册任何工具），但保留 `/dsh-x-computer-use/status`
 *    路由，让插件页能说明当前未启用的原因；
 * 3. `ctx.computerUse` 槽位已被其他 provider（如 macOS 官方 `dsh-cua`）占用时主动让位。
 */
import { createComputerDesktopClient } from './desktop.js'
import { createDshXBackend } from './backend.js'

export const name = 'dsh-x-computer-use'
export const inject = []

const STATUS_PATH = '/dsh-x-computer-use/status'

const CUA_METHODS = Object.freeze([
  'getCapabilities', 'listApps', 'findApps', 'getApp',
  'activate', 'show', 'listWindows', 'getState',
  'listActions', 'performAction', 'invoke',
  'mouseMove', 'click', 'setValue', 'selectText',
  'typeText', 'paste', 'pressKey', 'sendKeyEvent',
  'scroll', 'drag', 'screenshot',
])

const CUA_NUMERIC_FIELDS = new Set([
  'windowId', 'x', 'y', 'fromX', 'fromY', 'toX', 'toY',
  'deltaLinesX', 'deltaLinesY', 'clickCount', 'holdMs',
  'maxElements', 'maxDepth',
])

const CUA_BOOLEAN_FIELDS = new Set([
  'relative', 'includeMenus', 'details', 'useSystemPointer',
])

/**
 * 兼容 OpenAI/Ark 严格模式与 `@deepseek-ai/dsh-tools` 校验子集的 `cua` 工具参数 schema：
 * 上游 `dsh-cua` 默认把 Zod `toJSONSchema(Request)` 直接挂到 `parameters`（带 `$schema`、
 * `$defs` 与顶层 `type + oneOf` 且缺少顶层 `properties`），不仅过不了 `dsh-tools` 的
 * `assertSupportedJsonSchema`，部分模型还因此把 `params` 序列化成 JSON 字符串。
 */
export const CUA_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['method', 'params'],
  properties: {
    method: {
      type: 'string',
      enum: [...CUA_METHODS],
      description: 'CUA operation method name.',
    },
    params: {
      type: 'object',
      additionalProperties: true,
      description: 'Parameters JSON object (never a string, never include delivery_mode/options/pid): getCapabilities({}), listApps({}), findApps({query}), getApp({selector}), activate({appHandle}), show({appHandle,windowId?}), listWindows({appHandle}), getState({appHandle,windowId?,includeMenus?,details?,maxElements?,maxDepth?}), screenshot({appHandle,windowId}), click({appHandle,windowId,x,y}|{appHandle,snapshotId,elementId}), mouseMove({appHandle,windowId,x,y,useSystemPointer?}), scroll({appHandle,windowId,x,y,deltaLinesX,deltaLinesY}), drag({appHandle,windowId,fromX,fromY,toX,toY}), typeText({appHandle,windowId?,text}), paste({appHandle,windowId?,text}), pressKey({appHandle,windowId?,key,modifiers?}).',
    },
  },
})

const CUA_METHOD_ALIASES = Object.freeze({
  getAccessibilityTree: 'getState',
  getWindows: 'listWindows',
  getScreenshot: 'screenshot',
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function tryParseJsonObject(text) {
  const trimmed = text.trim()
  if (!trimmed) return {}
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 归一化模型传给 `cua` 的入参：
 * 1. `params` 为 JSON 字符串（或空串）时解回对象；
 * 2. 缺省 `params` 时补 `{}`（并把扁平顶层参数收进 `params`）；
 * 3. 对数值/布尔坐标字段兼容字符串形态，不动 `text` / `value` / `selector` 等文本字段。
 */
export function normalizeCuaToolArgs(args) {
  let root = args
  if (typeof root === 'string') {
    const parsed = tryParseJsonObject(root)
    if (!parsed) return args
    root = parsed
  }
  if (!isPlainObject(root)) return args

  const out = { ...root }
  if (typeof out.method === 'string' && Object.hasOwn(CUA_METHOD_ALIASES, out.method)) {
    out.method = CUA_METHOD_ALIASES[out.method]
  }
  if (typeof out.params === 'string') {
    const parsedParams = tryParseJsonObject(out.params)
    if (parsedParams) out.params = parsedParams
  } else if (out.params === undefined && typeof out.method === 'string') {
    const extra = {}
    for (const [key, value] of Object.entries(out)) {
      if (key === 'method' || key === 'params') continue
      extra[key] = value
      delete out[key]
    }
    out.params = extra
  }

  if (isPlainObject(out.params)) {
    const params = { ...out.params }
    // 外壳会自动在 background -> foreground 间升级；模型若幻觉出这些路由键会触发严格 Zod 报错。
    delete params.delivery_mode
    delete params.deliveryMode
    delete params.options
    if (out.method === 'screenshot') delete params.pid
    if ((out.method === 'click' || out.method === 'mouseMove') && isPlainObject(params.target)) {
      if (params.x === undefined && params.target.x !== undefined) params.x = params.target.x
      if (params.y === undefined && params.target.y !== undefined) params.y = params.target.y
      if (params.windowId === undefined && params.target.windowId !== undefined) params.windowId = params.target.windowId
      delete params.target
    }
    if (typeof params.modifiers === 'string') {
      const trimmed = params.modifiers.trim()
      if (trimmed.startsWith('[')) {
        try {
          const parsedMods = JSON.parse(trimmed)
          if (Array.isArray(parsedMods)) params.modifiers = parsedMods
        } catch { /* keep original so schema reports exact error */ }
      }
    }
    for (const key of CUA_NUMERIC_FIELDS) {
      if (typeof params[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(params[key].trim())) {
        const num = Number(params[key].trim())
        if (Number.isFinite(num)) params[key] = num
      }
    }
    for (const key of CUA_BOOLEAN_FIELDS) {
      if (params[key] === 'true') params[key] = true
      else if (params[key] === 'false') params[key] = false
    }
    out.params = params
  }
  return out
}

export function wrapCuaToolDefinition(definition) {
  if (!definition || definition.name !== 'cua' || typeof definition.execute !== 'function') {
    return definition
  }
  const origExecute = definition.execute
  return {
    ...definition,
    parameters: CUA_TOOL_PARAMETERS,
    execute(args, execution) {
      return origExecute.call(this, normalizeCuaToolArgs(args), execution)
    },
  }
}

function wrapScopeToolsForCua(scopeCtx) {
  if (!scopeCtx?.tools) return scopeCtx
  const toolsProxy = new Proxy(scopeCtx.tools, {
    get(target, prop) {
      if (prop === 'register') {
        return (definition, options) => target.register(wrapCuaToolDefinition(definition), options)
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(scopeCtx, {
    get(target, prop) {
      if (prop === 'tools') return toolsProxy
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function writeJson(res, statusCode, body) {
  if (res.destroyed === true || res.writableEnded === true) return
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 探测当前运行态决定是否挂载 CUA 工具（纯函数可单测）。
 * @param {object} client - `createComputerDesktopClient()` 实例。
 * @param {object} [existingProvider] - 已占用 `ctx.computerUse.providerName` 的值。
 */
export async function probeComputerUseEligibility(client, existingProvider) {
  if (!client.enabled) {
    return { eligible: false, reason: 'no-desktop', detail: '当前不是由 DSH-X 桌面外壳启动的实例' }
  }
  const info = await client.info()
  if (!info?.available || !Array.isArray(info.capabilities) || !info.capabilities.includes('computer')) {
    return { eligible: false, reason: 'unsupported', detail: '当前 DSH-X 外壳不支持电脑操作能力' }
  }
  if (info.computer?.enabled !== true) {
    return { eligible: false, reason: 'disabled', detail: '电脑操作在 DSH-X 设置中默认关闭，开启并重启实例后可用' }
  }
  if (existingProvider !== undefined) {
    return {
      eligible: false,
      reason: 'slot-occupied',
      provider: String(existingProvider),
      detail: `电脑操作槽位已被 "${existingProvider}" 占用`,
    }
  }
  return { eligible: true, reason: 'ok', computer: info.computer }
}

export async function apply(ctx, config = {}) {
  const client = createComputerDesktopClient()
  let state = {
    active: false,
    reason: client.enabled ? 'checking' : 'no-desktop',
    provider: '',
    detail: '',
    desktopAvailable: client.enabled,
  }

  // 挂状态接口给 client.js：无论启用与否都回 JSON，方便插件页解释原因
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          writeJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        const live = client.enabled ? await client.computer({ op: 'status' }, { requestTimeoutMs: 3000 }).catch(() => null) : null
        writeJson(res, 200, {
          ...state,
          live: live && typeof live === 'object' && !live.error ? live : null,
        })
      },
    }), 'dsh-x-computer-use: status route')
  })

  const initial = await probeComputerUseEligibility(client, ctx.get('computerUse')?.providerName)
  if (!initial.eligible) {
    state = {
      active: false,
      reason: initial.reason,
      provider: initial.provider || '',
      detail: initial.detail,
      desktopAvailable: client.enabled,
    }
    ctx.logger?.info?.(`dsh-x-computer-use: 未挂载 CUA 工具（${initial.reason}）`)
    return
  }

  let cuaMod
  let computerUseMod
  let guidanceMod
  try {
    ;[cuaMod, computerUseMod, guidanceMod] = await Promise.all([
      import('@deepseek-ai/dsh-cua'),
      import('@deepseek-ai/dsh-computer-use'),
      import('@deepseek-ai/dsh-cua/guidance'),
    ])
  } catch (error) {
    state = {
      active: false,
      reason: 'missing-dsh-cua',
      provider: '',
      detail: `需要 dsh 0.2.2 及以上内置的 @deepseek-ai/dsh-cua：${error instanceof Error ? error.message : String(error)}`,
      desktopAvailable: client.enabled,
    }
    ctx.logger?.warn?.(`dsh-x-computer-use: ${state.detail}`)
    return
  }

  // 若 profile 没有独立挂载 dsh-computer-use 注册表，这里顺手补一个，避免冲突时仍保留已有服务
  if (!ctx.get('computerUse') && computerUseMod?.ComputerUseRegistry) {
    await ctx.plugin(computerUseMod.ComputerUseRegistry)
  }

  ctx.inject(['tools', 'systemPrompt', 'agents', 'computerUse'], (scopeCtx) => {
    if (scopeCtx.computerUse.providerName !== undefined) {
      state = {
        active: false,
        reason: 'slot-occupied',
        provider: String(scopeCtx.computerUse.providerName),
        detail: `电脑操作槽位已被 "${scopeCtx.computerUse.providerName}" 占用`,
        desktopAvailable: client.enabled,
      }
      scopeCtx.logger?.warn?.(`dsh-x-computer-use: ${state.detail}`)
      return
    }

    const cuaConfig = cuaMod.CuaConfig({
      agentPreset: false,
      ...(config && typeof config === 'object' ? config : {}),
    })
    const backend = createDshXBackend({
      client,
      commonGuidance: guidanceMod?.COMMON_GUIDANCE || '',
    })

    try {
      cuaMod.installCua(wrapScopeToolsForCua(scopeCtx), cuaConfig, backend)
      state = {
        active: true,
        reason: 'ok',
        provider: String(scopeCtx.computerUse.providerName || 'dsh-cua'),
        detail: '已通过 DSH-X 桌面外壳就绪',
        desktopAvailable: client.enabled,
      }
    } catch (error) {
      state = {
        active: false,
        reason: 'install-failed',
        provider: '',
        detail: error instanceof Error ? error.message : String(error),
        desktopAvailable: client.enabled,
      }
      scopeCtx.logger?.warn?.(`dsh-x-computer-use: 挂载失败（${state.detail}）`)
    }
  })
}
