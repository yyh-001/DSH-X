// 打包时由 pack-npm.mjs 改为包内的 ../shell；CLI 与安装版共用同一套 Linux 启动选择。
export { linuxBackendLaunch } from '../../shell/linux-backend.mjs'
