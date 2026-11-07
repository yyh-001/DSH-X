/**
 * 插件桌面 API（/api/desktop/*）的请求校验。
 *
 * 插件跑在 dsh 子进程里，拿不到 Electron；能力走本机 HTTP：插件 → 管理服务 → 外壳的
 * host.desktop（见 shell/main.mjs）。这个文件只决定「什么请求能过去、长度上限多少」，
 * 真正执行 Notification / dialog / clipboard 的代码在外壳里。
 *
 * 不许 import Electron，也不许 import shell/：核心和外壳是分开更新的两层，核心目录
 * （用户目录的 core/current）里没有 shell/，外壳目录里也没有核心模块。
 * 外壳侧另有 shell/desktop.mjs 做它自己的门控（通知开关、节流、Electron 对话框选项）。
 */
import { isAbsolute } from 'node:path'

/** 协议版本：插件可以按 GET /api/desktop 的 api 字段决定用哪套接口。 */
export const DESKTOP_API_VERSION = 1

/** 外壳能做的事。没有 Electron 外壳时 GET 会返回空数组。 */
export const DESKTOP_CAPABILITIES = Object.freeze(['notify', 'open', 'reveal', 'clipboard', 'dialog'])

/**
 * 请求上限。通知是给人看的，不是日志通道；剪贴板也不该被拿来做文件传输。
 * 数字写在这里而不是外壳里：校验发生在核心，外壳按拿到的干净数据执行。
 */
export const DESKTOP_LIMITS = Object.freeze({
  title: 120,
  body: 800,
  url: 2048,
  text: 100_000,
  path: 4096,
  filters: 8,
  extensions: 10,
  filterName: 60,
  buttons: 4,
  button: 40,
  message: 500,
  detail: 2000,
})

/** 单行文本：控制字符变空格，连续空白压成一个，别让标题把通知撑成两行。 */
function oneLine(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** 多行文本：保留换行与制表，掉其余控制字符（通知正文可以有多段）。 */
function multiLine(value, max) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)
}

/** 路径文本：只去控制字符和首尾空白，不压空格——路径里的空格是内容，不是格式。 */
function pathText(value, max = DESKTOP_LIMITS.path) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)
}

/** 只认 http(s)：`file:` / `javascript:` / `data:` 都不能进系统浏览器或标签页。 */
function httpUrl(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > DESKTOP_LIMITS.url) return ''
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/** Electron 对话框的筛选器：扩展名不带点、只留字母数字和 `*`（全部文件）。 */
function fileFilters(value) {
  if (!Array.isArray(value)) return []
  const filters = []
  for (const item of value.slice(0, DESKTOP_LIMITS.filters)) {
    if (!item || typeof item !== 'object') continue
    const extensions = (Array.isArray(item.extensions) ? item.extensions : [])
      .slice(0, DESKTOP_LIMITS.extensions)
      .map((ext) => String(ext ?? '').trim().replace(/^\./, '').toLowerCase())
      .filter((ext) => /^[a-z0-9*]+$/.test(ext))
    if (!extensions.length) continue
    filters.push({ name: oneLine(item.name, DESKTOP_LIMITS.filterName) || extensions.join('、'), extensions })
  }
  return filters
}

/** 按钮/默认项的下标：越界或非整数就退回给定的默认值。 */
function boundedIndex(value, length, fallback) {
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < length ? index : fallback
}

function parseNotify(input) {
  const title = oneLine(input.title, DESKTOP_LIMITS.title)
  const body = multiLine(input.body, DESKTOP_LIMITS.body)
  if (!title && !body) throw new Error('通知要有标题或内容')
  const rawUrl = String(input.url ?? '').trim()
  const url = rawUrl ? httpUrl(rawUrl) : ''
  if (rawUrl && !url) throw new Error('通知的点击地址必须是 http(s) 链接')
  return {
    action: 'notify',
    title: title || 'DSH-X',
    body,
    // 插件只能把通知关小声，不能打开用户关掉的提示音；最终静音与否由外壳按设置决定。
    silent: input.silent === true,
    url,
  }
}

function parseOpen(input) {
  const url = httpUrl(input.url)
  if (!url) throw new Error('只能打开 http(s) 链接')
  return { action: 'open', url }
}

function parseReveal(input) {
  const path = pathText(input.path)
  if (!path) throw new Error('要给一个路径')
  if (!isAbsolute(path)) throw new Error('路径必须是绝对路径')
  return { action: 'reveal', path }
}

function parseClipboard(input) {
  if (typeof input.text !== 'string') throw new Error('text 必须是字符串')
  if (input.text.length > DESKTOP_LIMITS.text) throw new Error(`剪贴板内容超过 ${DESKTOP_LIMITS.text} 个字符`)
  return { action: 'clipboard', text: input.text }
}

const MESSAGE_TYPES = new Set(['none', 'info', 'warning', 'error', 'question'])

/**
 * 文件/消息对话框。三种 kind 共用一条路由：插件的用法只有「选 / 存 / 问」三种，
 * 拆成三条只会让客户端多写两个分支。
 */
function parseDialog(input) {
  const kind = String(input.kind ?? '')
  if (kind !== 'open' && kind !== 'save' && kind !== 'message') throw new Error('kind 只能是 open / save / message')
  if (kind === 'message') {
    const message = multiLine(input.message, DESKTOP_LIMITS.message)
    if (!message) throw new Error('对话框要有 message')
    const buttons = (Array.isArray(input.buttons) ? input.buttons : [])
      .slice(0, DESKTOP_LIMITS.buttons)
      .map((label) => oneLine(label, DESKTOP_LIMITS.button))
      .filter(Boolean)
    const options = {
      type: MESSAGE_TYPES.has(input.type) ? input.type : 'info',
      message,
      detail: multiLine(input.detail, DESKTOP_LIMITS.detail),
      buttons,
    }
    if (buttons.length) {
      options.defaultId = boundedIndex(input.defaultId, buttons.length, 0)
      options.cancelId = boundedIndex(input.cancelId, buttons.length, buttons.length - 1)
    }
    return { action: 'dialog', kind: 'message', options }
  }

  const options = {}
  const title = oneLine(input.title, DESKTOP_LIMITS.title)
  if (title) options.title = title
  // 保存对话框的 defaultPath 可以只是个文件名，所以这里不要求绝对路径。
  const defaultPath = pathText(input.defaultPath)
  if (defaultPath) options.defaultPath = defaultPath

  if (kind === 'open') {
    const directory = input.directory === true
    const properties = [directory ? 'openDirectory' : 'openFile']
    if (input.multiple === true) properties.push('multiSelections')
    options.properties = properties
  }
  // 目录选择不吃筛选器；Electron 传了也会忽略，干脆不传。
  const filters = fileFilters(input.filters)
  if (filters.length && !(kind === 'open' && input.directory === true)) options.filters = filters
  return { action: 'dialog', kind, options }
}

const PARSERS = {
  notify: parseNotify,
  open: parseOpen,
  reveal: parseReveal,
  clipboard: parseClipboard,
  dialog: parseDialog,
}

/**
 * 路由里的 action + JSON 正文 → 给外壳的干净请求；不认识的 action 返回 null。
 * 校验失败直接抛（路由转 400），错误文案是给插件作者看的。
 */
export function parseDesktopRequest(action, input) {
  const parser = PARSERS[String(action ?? '')]
  if (!parser) return null
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return parser(body)
}
