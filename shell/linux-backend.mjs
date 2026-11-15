/** Electron 44 在应用脚本之前缓存 Ozone 后端；这里只准备下次进程的参数，不能用 appendSwitch 假装切换成功。 */
export function linuxBackendLaunch(args, env = {}, platform = process.platform) {
  if (platform !== 'linux') return { args, preferX11: false, message: '' }
  const switches = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
  const explicit = switches.some(arg => /^--ozone-platform(?:-hint)?(?:=|$)/.test(arg))
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY
  if (explicit) return { args, preferX11: false, message: '' }
  if (!wayland) return { args, preferX11: false, message: '' }
  if (!env.DISPLAY?.trim()) return {
    args, preferX11: false,
    message: 'DSH-X: 未提供 DISPLAY，无法请求 XWayland。保留当前后端；原生 Wayland 仅支持同窗排序和菜单拆分/合并。完整拖动需要可连接的 XWayland。',
  }
  // 放在 -- 之前，避免把后端选项变成应用的普通位置参数；其余启动请求保持原顺序。
  const next = [...args]
  next.splice(switches.length, 0, '--ozone-platform=x11')
  return {
    args: next, preferX11: true,
    message: 'DSH-X: 请求 X11/XWayland 以启用无修饰键标签拖出/回并（尚未验证 DISPLAY 连接）。若启动报 X server / DISPLAY 错误，请检查 XWayland、DISPLAY 与认证，或以 --ozone-platform=wayland 启动，保留排序和菜单拆分/合并。',
  }
}

/** AppImage 重启外层文件；其余入口保留 Electron/应用路径和全部原始参数。 */
export function shellRelaunchOptions(args, env = {}) {
  return { args, ...(env.APPIMAGE ? { execPath: env.APPIMAGE } : {}) }
}

export function restartLinuxBackend(app, { args = process.argv.slice(1), env = process.env, platform = process.platform, warn = console.warn } = {}) {
  const launch = linuxBackendLaunch(args, env, platform)
  if (launch.message) warn(launch.message)
  if (!launch.preferX11 || app.commandLine.getSwitchValue('ozone-platform') === 'x11') return false
  // 下一次原始 argv 已有显式 x11，不会再次走自动选择；当前进程不取锁、不启动核心、不建窗口。
  app.relaunch(shellRelaunchOptions(launch.args, env))
  app.exit(0)
  return true
}
