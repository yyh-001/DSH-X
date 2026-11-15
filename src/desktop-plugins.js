/**
 * DSH-X 桌面增强：设置 → 常规 里「一键安装」装进当前 profile 的首方插件。
 *
 * 它们是普通的 dsh 插件（host / client 分开），不在安装包里、也不随启动自动补装：
 * 用户在设置里点一下才装。装法复用插件页那条链路（`dsh plugin add` + 写
 * `dsh.profile.bundles`），所以从 npm 装、能在插件页更新，装完也能在插件页单独开关。
 *
 * 纯函数（不读盘、不起进程），单测见 test/desktop-plugins.test.mjs；真正的安装留在
 * server.js 的 addPlugin。
 */

/**
 * 首方插件清单。
 *
 * 右键菜单插件已经从这一组撤掉：dsh 0.2.2 起自带右键菜单（`contextMenus` 服务），
 * 再装一套只会两套菜单同时出现（issue #110）。包里不再引用它，装过的用户在插件页
 * 单独卸载即可；以后也不再挂回来。
 *
 * `spec` 钉精确版本：核心的 safeSpec 不接受 `^`；也不用 `latest`——新包首发会先出一个
 * `0.0.0-stage` 占位版本，`@latest` 在那段时间装到的是空壳。升级交给插件页（它按
 * registry 上的最新版本 add），这里只负责把缺的装上。
 *
 * `minDsh` 是插件 dsh.compatibility.dsh 的下限；同一版本的预发布（0.2.1-rc.4）算满足。
 */
/** 插件页里把这一组装成「整合包」显示时用的 id / 名字（没有真实安装记录）。 */
export const DESKTOP_ENHANCE_ID = 'dsh-x-desktop-enhance'
export const DESKTOP_ENHANCE_NAME = '桌面增强'

export const DESKTOP_PLUGINS = Object.freeze([
  { name: 'dsh-x-desktop-notify', spec: '0.1.1', label: '原生通知', minDsh: '0.2.0' },
  { name: 'dsh-x-sidebar-browser', spec: '0.1.1', label: '侧栏浏览器', minDsh: '0.2.1-rc.2' },
])

/**
 * `x.y.z` / `x.y.z-rc.1` → `[x, y, z]`；认不出来返回 null。
 * @param {string} text - dsh 版本。
 * @returns {number[] | null} 主次修订三个数字。
 */
export function parseDshVersion(text) {
  const match = String(text ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 版本够不够插件要求的下限。
 *
 * 只比主次修订：同一版本的预发布（`0.2.1-rc.4` 对 `0.2.1-rc.2`）算满足——插件的
 * compatibility 写的是「从哪个版本开始有这些接口」，预发布同样有。
 *
 * @param {string} version - 要启动的 dsh 版本。
 * @param {string} min - 插件要求的最低版本。
 * @returns {boolean} 够不够；任一边认不出来都算不够（宁可不装，也不装坏一个 profile）。
 */
export function versionAtLeast(version, min) {
  const left = parseDshVersion(version)
  const right = parseDshVersion(min)
  if (!left || !right) return false
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return true
    if (left[i] < right[i]) return false
  }
  return true
}
