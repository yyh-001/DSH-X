// dsh-x npm 版的运行核心：从 npm 拉跨平台的 dsh-x-core，解到用户缓存目录。
//
// 下载 / 校验 / 解压的实现在 shell/core-fetch.mjs——安装版外壳第一次启动时也用它，
// 两边只维护一份。注意这一行的路径只在仓库里成立（npm-package/lib → ../../shell）；
// scripts/pack-npm.mjs 打包时会把它重写成包内的 ../shell/core-fetch.mjs。

export * from '../../shell/core-fetch.mjs'
