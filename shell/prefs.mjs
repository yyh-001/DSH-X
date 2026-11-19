import { readFileSync } from 'node:fs'

/**
 * 桌面端系统开关（设置页「常规 → 系统」那一组）。
 *
 * 外壳直接读核心的 settings.json，不走管理页接口：外壳和核心是分开更新的两层，
 * 接口协议一变就得两边同步发版；读同一份文件则旧核心 + 新外壳也能用（新核心 + 旧外壳
 * 只是外壳不认这些键，页面会按 DSH_SHELL_PREFS 提示）。
 *
 * 纯函数部分单独放在这里，node --test 能直接测（见 test/shell-prefs.test.mjs）。
 */

/** 缺字段 / 脏值时的默认值：和 settings.js 的 DEFAULTS 保持一致。 */
export const PREF_DEFAULTS = Object.freeze({
  // Chromium 硬件加速（关掉后重启生效）
  hardwareAcceleration: true,
  // 发现更新就下载，空闲时直接安装
  autoUpdate: false,
  // 实例启动完成 / 失败时发桌面通知
  taskNotifications: true,
  // 通知带提示音
  notificationSound: true,
  // 关窗口隐藏到托盘（关掉 = 真退出）
  closeToTray: true,
  // 阻止系统空闲休眠
  keepAwake: false,
  // 独立窗口也跟随已有的「减少动画」设置，不再单独查询管理服务。
  reduceMotion: false,
  // 内置浏览器：管 agent 插件（dsh-x-sidebar-browser）的补装与停用，主要是核心在用；
  // 外壳保留这个键只是为了两边默认值一致，不拿它拦侧栏 Browser 本身
  // 内置浏览器忽略 HTTPS 证书错误（自签名站点）
  browserIgnoreCertificate: false,
  // 电脑操作（Computer Use）：默认开启，由 DSH-X 启动且装有插件的实例可向模型暴露桌面操作工具
  computerUse: true,
})

/** 从设置对象里挑出外壳要用的字段：只认布尔语义，缺字段回默认。 */
export function parsePrefs(stored) {
  const source = stored && typeof stored === 'object' ? stored : {}
  return {
    hardwareAcceleration: source.hardwareAcceleration !== false,
    autoUpdate: source.autoUpdate === true,
    taskNotifications: source.taskNotifications !== false,
    notificationSound: source.notificationSound !== false,
    closeToTray: source.closeToTray !== false,
    keepAwake: source.keepAwake === true,
    reduceMotion: source.reduceMotion === true,
    browserIgnoreCertificate: source.browserIgnoreCertificate === true,
    computerUse: source.computerUse !== false,
  }
}

/** 读 settings.json；文件不存在、正在被替换或内容坏了都回默认值，不抛。 */
export function readPrefs(file) {
  try {
    return parsePrefs(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...PREF_DEFAULTS }
  }
}
