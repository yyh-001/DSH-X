/**
 * 插件桌面 API 的外壳侧策略：通知开关、节流、点击目标、Electron 对话框选项。
 *
 * 纯函数，node --test 直接测（见 test/shell-desktop.test.mjs）。真正的 Notification /
 * dialog / clipboard 调用留在 main.mjs——那些必须跑在 Electron 主进程里。
 *
 * 不 import 核心模块：外壳（resources/app）和核心（用户目录的 core/current）是分开更新的两层，
 * 外壳目录里没有核心文件。请求清洗在核心的 desktop.js 里已经做过一遍，这里按外壳
 * 自己的开关和平台习惯再收一道。
 */
import { isWebUrl } from './model.mjs'

/** 插件通知的最小间隔：写坏了的插件不该把用户的通知中心刷满。 */
export const NOTIFY_GAP_MS = 500

/**
 * 插件通知发不发、带不带声。
 *
 * 插件通知不再受「任务通知」开关控制：那个开关只管外壳自己的实例提醒；插件要不要
 * 提醒由 dsh 插件页里那个插件自己的开关决定。声音只能被插件关小、不能被打开——
 * 设置里关掉提示音是用户的决定。
 *
 * @returns {{ enabled: boolean, silent: boolean, reason: '' }}
 */
export function notificationDecision(payload, prefs) {
  return {
    enabled: true,
    silent: prefs?.notificationSound === false || payload?.silent === true,
    reason: '',
  }
}

/**
 * 通知点击后能打开的地址：只认 http(s)。本机地址交给 openLink 决定进标签页还是独立
 * 窗口，外部地址交给系统浏览器；file:/javascript:/data: 一律退回「打开管理页」。
 */
export function clickTarget(url) {
  const text = String(url ?? '').trim()
  return isWebUrl(text) ? text : ''
}

/** 距上一条插件通知不足 gap 毫秒就丢掉这一条（lastAt = 0 表示还没发过）。 */
export function notifyThrottled(lastAt, now, gap = NOTIFY_GAP_MS) {
  return Number(lastAt) > 0 && Number(now) - Number(lastAt) < gap
}

/** Electron 接受的打开/保存对话框属性白名单：核心发来的值只能落在这里面。 */
const OPEN_PROPERTIES = new Set([
  'openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles', 'createDirectory',
  'promptToCreate', 'noResolveAliases', 'treatPackageAsDirectory', 'dontAddToRecent',
])
const MESSAGE_TYPES = new Set(['none', 'info', 'warning', 'error', 'question'])

/**
 * 核心清洗过的 /api/desktop/dialog 请求 → Electron 的 dialog 选项。
 * kind 不认识、options 缺失都返回 null（核心应该已经拦掉，这里是第二道）。
 */
export function dialogOptions(request) {
  const options = request?.options
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null
  // 空字符串 / 空数组不往 Electron 传：Windows 上 filters: [] 会多出一行空筛选。
  const basic = {}
  if (typeof options.title === 'string' && options.title) basic.title = options.title
  if (typeof options.defaultPath === 'string' && options.defaultPath) basic.defaultPath = options.defaultPath
  const filters = Array.isArray(options.filters)
    ? options.filters.filter((item) => item && typeof item.name === 'string' && Array.isArray(item.extensions))
    : []
  if (filters.length) basic.filters = filters
  switch (request.kind) {
    case 'open': {
      const properties = (Array.isArray(options.properties) ? options.properties : [])
        .filter((value) => OPEN_PROPERTIES.has(value))
      return { ...basic, properties: properties.length ? properties : ['openFile'] }
    }
    case 'save':
      return basic
    case 'message': {
      const buttons = (Array.isArray(options.buttons) ? options.buttons : [])
        .filter((label) => typeof label === 'string' && label)
      const box = {
        type: MESSAGE_TYPES.has(options.type) ? options.type : 'info',
        message: typeof options.message === 'string' ? options.message : '',
      }
      if (typeof options.detail === 'string' && options.detail) box.detail = options.detail
      if (buttons.length) {
        box.buttons = buttons
        box.defaultId = Number.isInteger(options.defaultId) ? options.defaultId : 0
        box.cancelId = Number.isInteger(options.cancelId) ? options.cancelId : buttons.length - 1
      }
      return box
    }
    default:
      return null
  }
}
