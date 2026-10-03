import { join } from 'node:path'

/** APP_DIR 在导入业务模块时确定；macOS 不看 APPDATA，测试必须同时隔离 HOME 和配置文件位置。 */
export function isolateUserHome(root, appData = root) {
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.APPDATA = appData
  return process.platform === 'darwin'
    ? join(root, 'Library', 'Application Support', 'DSH')
    : join(appData, 'DSH')
}
