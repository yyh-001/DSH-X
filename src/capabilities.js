import { NPM_MODE } from './platform.js'

/**
 * 运行时能力：同一份核心既跑在 Electron 外壳里（桌面模式），也跑在纯 Node 里（web 模式）。
 *
 * 判断依据只有两个来源——外壳启动时 `setHost()` 注入的钩子，和外壳设的那几个环境变量。
 * 别在路由里散着读 `host.desktop` / `process.env.DSH_APP_WINDOW`：加一个桌面功能时要能
 * 在一处回答「web 模式下它是什么样」。
 *
 * web 模式的定义就是「这些全是 false」：没有桌面通知、没有内置浏览器、实例页开在外部
 * 浏览器里、设置页里那组系统开关整组禁用。核心本身不 import electron（src/ 里没有
 * electron 依赖，只有 shell/ 有），所以纯 Node 起来就是完整可用的管理页。
 *
 * @param {{ host?: object, env?: NodeJS.ProcessEnv }} [context]
 */
export function detectCapabilities({ host = {}, env = process.env } = {}) {
  const windowHost = env.DSH_APP_WINDOW === '1'
  return Object.freeze({
    /** 桌面通知 / 系统对话框 / 剪贴板 / 在文件管理器里显示（GET /api/desktop 的能力清单）。 */
    desktop: Boolean(host.desktop),
    /** 内置浏览器（右侧栏）的数据清理；只有带浏览器分区的 Electron 外壳才有。 */
    browser: Boolean(host.browser),
    /** 管理页装在外壳窗口里（DSH_APP_WINDOW）；false = 浏览器标签页。 */
    windowHost,
    /** 实例页可以放进外壳的内嵌标签；旧外壳只认独立窗口。 */
    internalTabs: windowHost && env.DSH_INTERNAL_TABS === '1',
    /** 外壳认「关闭窗口时隐藏到托盘」这类系统开关；旧外壳不认，页面据此提示更新。 */
    shellPrefs: env.DSH_SHELL_PREFS === '1',
    /** 外壳自己的更新器（electron-updater）。 */
    shellUpdate: Boolean(host.shellUpdate),
    /** 核心自己的更新来源：npm 版走 npm，安装包走核心增量更新，源码运行没有。 */
    updater: NPM_MODE ? 'npm' : host.shellUpdate ? 'electron-updater' : 'none',
  })
}
