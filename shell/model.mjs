/**
 * Electron 外壳里与 Electron 无关的那一半：地址判定、/api/tray 的解析、标签页消息校验、
 * 托盘启动项菜单的可用性。全部是纯函数，node --test 直接测（见 test/shell-model.test.mjs）。
 *
 * 规则逐条照搬旧的 Windows Rust 外壳（launcher/main.rs、tabs.rs、tray.rs；已退役，现只剩安装引擎），
 * 两边语义要一致：管理服务对两个外壳说的是同一套协议。
 */

/** 本机地址的主机名：dsh 的界面、管理页都在回环上；别的一律算外部网页。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 管理页传来的布局高度只认这个范围（逻辑像素），防止脏值把内容区挤没。 */
export const HEADER_HEIGHT_RANGE = { min: 36, max: 256 }
/** 标签页标题的长度上限：标题来自远端页面，不能无限长地塞进菜单栏。 */
export const PAGE_TITLE_MAX = 160

/** 地址的 host（没有 http(s) scheme 时返回 null）。只做判定用，不规范化。 */
export function urlHost(url) {
  const text = String(url)
  const rest = text.startsWith('http://') ? text.slice(7) : text.startsWith('https://') ? text.slice(8) : null
  if (rest === null) return null
  const authority = rest.split(/[/?#]/)[0].split('@').at(-1)
  // IPv6 字面量：[::1]:9716 → ::1
  if (authority.startsWith('[')) return authority.slice(1).split(']')[0]
  return authority.split(':')[0]
}

export function isLoopbackUrl(url) {
  return LOOPBACK_HOSTS.has(urlHost(url))
}

export function isWebUrl(url) {
  return /^https?:\/\//.test(String(url))
}

/**
 * 真正的外部网页：http(s) 且不是本机。只有这种才交给系统浏览器——about:/data:/blob:
 * 是页面自己的东西，交给系统只会弹「用什么应用打开」的对话框。
 */
export function isExternalWebUrl(url) {
  return isWebUrl(url) && !isLoopbackUrl(url)
}

function originOf(url) {
  const match = /^([^:/?#]+):\/\/([^/?#]+)/.exec(String(url))
  return match ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}` : null
}

/**
 * 这是不是启动进度页（/booting）。那张页自己轮询实例状态、就绪后 location.replace 跳进去，
 * 所以它还在标签里的时候，外壳不能按实例列表去重画这个标签。
 */
export function isBootingUrl(url) {
  try {
    const { pathname } = new URL(String(url))
    return pathname === '/booting' || pathname === '/booting/'
  } catch {
    return false
  }
}

/** 两个地址的 scheme://authority 是否相同——认出「这个链接就是 dsh 自己」。 */
export function sameOrigin(a, b) {
  const left = originOf(a)
  return left !== null && left === originOf(b)
}

/**
 * 标签条这一轮要不要动这个标签页（BrowserTabs.follow 的决策，抽出来单独测）。
 *
 * 只有一种情况放着不管：标签上开着启动进度页（/booting），而实例还在起、地址还没打印出来
 * （url 为空）。那张页自己轮询 /api/state、就绪后 location.replace 跳进去；外壳要是按
 * 「url 为空 = 实例停了」把它换成停止页，进度页就活不过一轮 1.5 秒的轮询。
 *
 * @param {{ booting: boolean, loaded: string }} tab 标签当前状态
 * @param {{ url: string }} next 实例列表里对应的那一项（没有就是 null）
 * @returns {'leave' | 'adopt' | 'load'}
 *   leave — 什么都不做，让进度页自己走；
 *   adopt — 页面已经自己跳到这台实例了，只把 loaded 记下来，不再 loadURL；
 *   load  — 按 follow 的老规矩重画（换地址 / 换停止页）。
 */
export function followAction(tab, next, currentUrl = '') {
  const url = next && (next.status === 'running' || next.status === 'starting') ? next.url : ''
  if (!url) return tab.booting ? 'leave' : 'load'
  // 进度页自己跳进这台实例了（同源）：认下地址。实例地址带 token、页面 303 之后不带，不能逐字比。
  if (tab.booting && sameOrigin(url, currentUrl)) return 'adopt'
  return tab.loaded === url ? 'leave' : 'load'
}

/** 标签页的目标（一个 dsh 实例）。外部地址一律拒收：认证地址只能指向本机。 */
export function parseTabTarget(value) {
  if (!value || typeof value !== 'object') return null
  const { id, url } = value
  if (typeof id !== 'string' || !id || typeof url !== 'string') return null
  if (url && !isLoopbackUrl(url)) return null
  return {
    id,
    url,
    title: typeof value.title === 'string' ? value.title : 'DSH',
    status: typeof value.status === 'string' ? value.status : 'running',
    managed: typeof value.managed === 'boolean' ? value.managed : true,
  }
}

/** 启动项（托盘子菜单的一行），对应 /api/tray 的 launches=。 */
export function parseLaunchEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null
  if (typeof value.name !== 'string' || typeof value.status !== 'string') return null
  return {
    id: value.id,
    instanceId: typeof value.instanceId === 'string' ? value.instanceId : '',
    name: value.name,
    status: value.status,
    installed: value.installed === true,
    busy: value.busy === true,
    target: parseTabTarget(value.target),
  }
}

function parseJsonList(text, parse) {
  try {
    const items = JSON.parse(text)
    return Array.isArray(items) ? items.map(parse).filter(Boolean) : []
  } catch {
    return []
  }
}

/** /api/tray 的纯文本 key=value（见 server.js）→ 外壳状态。读不到的字段留默认值。 */
export function parseTrayState(text) {
  const state = { status: '', url: '', installed: false, lang: '', openmode: '', shell: false, theme: '', instances: [], launches: [] }
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key === 'installed' || key === 'shell') state[key] = value === '1'
    else if (key === 'instances') state.instances = parseJsonList(value, parseTabTarget)
    else if (key === 'launches') state.launches = parseJsonList(value, parseLaunchEntry)
    else if (key in state) state[key] = value
  }
  return state
}

/**
 * 说得上「在跑」的实例：起来中或已经跑起来（正在停的不算）。
 * 退出前的确认框数的是这一群——stopping 的实例本来就快停了，不该再拦一次。
 */
export function liveInstances(instances) {
  return (Array.isArray(instances) ? instances : [])
    .filter((item) => item && (item.status === 'running' || item.status === 'starting'))
}

/** 设置里选了「桌面窗口」且确实由外壳托管：dsh 的界面开进独立窗口。 */
export function windowMode(state) {
  return state.openmode === 'window' && state.shell
}

/** 设置里选了「DSH-X 内部标签页」且确实由外壳托管：dsh 的界面开进主窗口的标签页。 */
export function internalMode(state) {
  return state.openmode === 'internal' && state.shell
}

/** 至少要有这么大一块落在某块屏的工作区里，才算"用户看得见"——一条缝不算。 */
const MIN_VISIBLE = { width: 160, height: 48 }

/**
 * 唤出窗口时该把窗口摆到哪：`null` 表示现在的摆位能看见，不用动。
 *
 * 两种摆位必须救：整个落在所有显示器工作区之外（换过显示器、改过分辨率，或者被写成
 * Windows 给最小化窗口的 `(-32000,-32000)`），尺寸塌到正常窗口的一半以下（`160×28`
 * 那种最小化矩形）。Electron 的 `show()` 只是按原摆位显示，摆位坏掉的话用户照样找不到窗口。
 */
export function recenterBounds(bounds, displays, primary, size) {
  const workArea = primary?.workArea
  if (!workArea) return null
  const visible = displays.some((display) => {
    const area = display.workArea
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return width >= MIN_VISIBLE.width && height >= MIN_VISIBLE.height
  })
  // 正常窗口最小 720×520，缩不到设定尺寸的一半以下：到这一步就是脏数据
  const tiny = bounds.width * 2 < size.width || bounds.height * 2 < size.height
  if (visible && !tiny) return null
  // 按主屏工作区夹一下：主屏比默认窗口还小的机器上，硬摆 1100×760 会压到任务栏
  const width = Math.min(size.width, Math.max(workArea.width, MIN_VISIBLE.width))
  const height = Math.min(size.height, Math.max(workArea.height, MIN_VISIBLE.height))
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  }
}

const isRequestSerial = (value) => Number.isSafeInteger(value) && value >= 0

/**
 * 管理页发来的标签页操作（JSON 字符串）→ { action, … }；不认识或字段不合法返回 null。
 * 远端 dsh 页面根本拿不到这条通道（预加载只装在管理页上），这里再校验一遍是防管理页自己的脏数据。
 */
export function parseTabAction(body) {
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  switch (value.action) {
    case 'select':
      if (typeof value.id !== 'string') return null
      if (!('request' in value)) return { action: 'select', id: value.id }
      return isRequestSerial(value.request) ? { action: 'select', id: value.id, request: value.request } : null
    case 'close-tab':
      return typeof value.id === 'string' ? { action: 'close-tab', id: value.id } : null
    case 'reorder': {
      const { ids } = value
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id)) return null
      if (new Set(ids).size !== ids.length || !isRequestSerial(value.request)) return null
      return { action: 'reorder', ids, request: value.request }
    }
    case 'reload':
    case 'next':
    case 'close-active':
      return { action: value.action }
    case 'layout': {
      const { height } = value
      if (typeof height !== 'number' || height < HEADER_HEIGHT_RANGE.min || height > HEADER_HEIGHT_RANGE.max) return null
      return { action: 'layout', height }
    }
    case 'present':
      return isRequestSerial(value.serial) ? { action: 'present', serial: value.serial } : null
    case 'overlay':
      return typeof value.open === 'boolean' ? { action: 'overlay', open: value.open } : null
    default:
      return null
  }
}

/**
 * 按管理页给的顺序重排：已经关掉的 id 忽略，新开的留在末尾。只排已有对象，不重建视图。
 * 拖动与开关标签可能交错，所以不能假设两边的集合一致。
 */
export function reorderBy(items, ids, idOf) {
  const ranks = new Map(ids.map((id, rank) => [id, rank]))
  return items
    .map((item, index) => ({ item, index, rank: ranks.has(idOf(item)) ? ranks.get(idOf(item)) : ids.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item)
}

/** 托盘里每个启动项的四个操作，顺序即菜单顺序。 */
export const LAUNCH_ACTIONS = [
  { action: 'start', zh: '启动', en: 'Start' },
  { action: 'open', zh: '打开', en: 'Open' },
  { action: 'restart', zh: '重启', en: 'Restart' },
  { action: 'stop', zh: '停止', en: 'Stop' },
]

/** 这一项此刻能不能做这个操作（和旧外壳 tray.rs 的 enabled 一致）。 */
export function launchActionEnabled(entry, action) {
  if (entry.busy || entry.status === 'stopping') return false
  switch (action) {
    case 'start': return entry.installed && entry.status === 'stopped'
    case 'open': return entry.status === 'running' && Boolean(entry.target?.url)
    case 'restart': return entry.installed && entry.status === 'running'
    case 'stop': return entry.status === 'running' || entry.status === 'starting'
    default: return false
  }
}

const LAUNCH_STATUS = {
  running: { zh: '运行中', en: 'Running' },
  starting: { zh: '启动中…', en: 'Starting…' },
  stopping: { zh: '停止中…', en: 'Stopping…' },
}

/** 托盘子菜单的标题：「名称 · 状态」。macOS 菜单不把 & 当快捷键标记，不用转义。 */
export function launchLabel(entry, en) {
  const known = LAUNCH_STATUS[entry.status]
  const status = known ? known[en ? 'en' : 'zh']
    : !entry.installed ? (en ? 'Not installed' : '未安装')
      : (en ? 'Stopped' : '未运行')
  return `${entry.name} · ${status}`
}

/** 托盘点了某一项的某个操作 → 发给 /api/tray/action 的正文。 */
export function launchActionRequest(entry, action) {
  if (!launchActionEnabled(entry, action)) return null
  return { id: entry.id, instanceId: entry.instanceId, action, targetId: entry.target?.id || '' }
}

/**
 * 采样到的底色对应的标签字色：按相对亮度取深/浅两档，和主题无关。
 * 亮底（比如浅色主题的 dsh 页面）用深字，暗底用浅字 —— 否则暗色主题下遇到白标签，字就糊了。
 */
export function surfaceInk(surface) {
  const match = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(String(surface || ''))
  if (!match) return ''
  const linear = (value) => { const v = Number(value) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const luminance = 0.2126 * linear(match[1]) + 0.7152 * linear(match[2]) + 0.0722 * linear(match[3])
  return luminance > 0.45 ? '#1b2434' : '#f2f4f8'
}
