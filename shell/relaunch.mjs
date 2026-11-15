/** AppImage 重启外层文件；其余入口保留 Electron/应用路径和用户显式后端参数。 */
export function shellRelaunchOptions(args, env = {}) {
  return { args, ...(env.APPIMAGE ? { execPath: env.APPIMAGE } : {}) }
}
