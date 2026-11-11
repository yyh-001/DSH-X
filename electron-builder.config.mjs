import { join } from 'node:path'

/**
 * electron-builder 配置：外壳/Electron 的自更新交给 electron-updater。
 *
 * 安装包里只有外壳：
 * - resources/app（release/shell-stage）：外壳，版本 = shell/package.json
 * 核心（dsh-x-core）不在安装包里：第一次启动由外壳从 npm 取到用户目录的 core/current
 * （见 shell/core-fetch.mjs），所以外壳可以很久不发版、核心照发。
 *
 * 两个通道各自更新自己那层：
 * - 外壳/Electron：electron-updater（NSIS/dmg），换整个安装包
 * - 核心：npm（core-npm.js），换用户目录的 core/current
 *
 * asar: false：dsh 子进程和 compat/perf 钩子要按真实路径读文件，asar 里读不到。
 * 签名：Windows 暂不签名（SmartScreen 会警告）；macOS 没有 Developer ID 时用 ad-hoc 签名
 * （identity: '-'），否则未签名的 arm64 包会被 Gatekeeper 判成「已损坏」，连启动都不行。
 * mac 只出 dmg，不打包 zip（也就没有 latest-mac.yml）；以后拿到 Developer ID，把 zip 目标
 * 加回来，并放开 shell/updater.mjs 里的 mac 限制。
 *
 * 发布资产统一命名：DSH-X-<版本>-<平台>-<架构>.<扩展名>，架构一律用 Node 的 x64 / arm64。
 * electron-builder 的 ${arch} 在 AppImage 上展开成 x86_64、deb 上展开成 amd64，同一份 x64 包
 * 会出现两种写法；Linux 目标本来就按打包机架构出包（见 linux.target 的注释），
 * 直接用 process.arch 当标签，两种格式就一致了。交叉编译（--arm64 跑在 x64 上）不支持，
 * 配置里也没有任何 target 钉架构，所以 process.arch 就是实际产出的架构。
 */
const LINUX_ARCH = process.arch

export default {
  appId: 'io.github.yyh-001.dsh-x',
  productName: 'DSH-X',
  copyright: 'Copyright (C) 2026 yyh',
  directories: {
    app: 'release/shell-stage',
    output: 'release/eb',
    buildResources: 'src/assets',
  },
  asar: false,
  npmRebuild: false,
  files: ['**/*'],
  publish: [
    {
      provider: 'github',
      owner: 'yyh-001',
      repo: 'DSH-X',
      releaseType: 'release',
    },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: join('src', 'assets', 'dsh.ico'),
    executableName: 'DSH',
    artifactName: 'DSH-X-${version}-win-x64.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DSH-X',
    uninstallDisplayName: 'DSH-X',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    installerIcon: join('src', 'assets', 'dsh.ico'),
    uninstallerIcon: join('src', 'assets', 'dsh.ico'),
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: join('src', 'assets', 'icon.png'),
    category: 'public.app-category.developer-tools',
    // Electron 44（Chromium 152）起 macOS 12 不再受支持；显式对齐，别只靠 Electron 自带
    // Info.plist 里的值——换 Electron 版本时这里会直接提醒改 README 和发版说明。
    minimumSystemVersion: '13.0',
    executableName: 'DSH',
    artifactName: 'DSH-X-${version}-mac-${arch}.${ext}',
    // 没有固定证书时用 ad-hoc 签名（'-'）；有证书的 tag 构建交给 electron-builder 自动发现
    identity: process.env.DSH_MAC_IDENTITY || (process.env.DSH_MAC_REQUIRE_SIGNED === '1' ? undefined : '-'),
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: 'DSH-X',
    artifactName: 'DSH-X-${version}-mac-${arch}.${ext}',
  },
  linux: {
    // 不写 arch：electron-builder 按打包机的架构出包。CI 的 linux job 在 x64 与原生 arm64
    // runner 上各跑一次，各出各的；写死 ['x64', 'arm64'] 会让每台机器都交叉打另一份，
    // 两个 job 上传同名资产互相 clobber（mac dmg 踩过）。文件名里的 LINUX_ARCH 让两种架构
    // 互不重名，更新清单 electron-builder 自己按架构命名：x64 是 latest-linux.yml，
    // arm64 是 latest-linux-arm64.yml，electron-updater 也按 process.arch 去找。
    target: [
      // AppImage：单个文件、全发行版通用，也是 electron-updater 在 Linux 上唯一认的形态
      // （它靠 APPIMAGE 环境变量找到要替换的那个文件）。
      { target: 'AppImage' },
      // deb：给 Debian / Ubuntu 系一个装进系统、能从菜单启动、能被 apt 卸干净的包。
      // 代价是自更新断掉——deb 装出来的进程没有 APPIMAGE 变量，updater.mjs 那边会当不支持，
      // 用户得手动换包；核心那层（core/current）照旧走 npm，不受影响。
      { target: 'deb' },
    ],
    icon: join('src', 'assets', 'icon.png'),
    category: 'Development',
    executableName: 'DSH',
    artifactName: `DSH-X-\${version}-linux-${LINUX_ARCH}.\${ext}`,
    synopsis: 'DeepSeek Harness launcher',
    description: 'DeepSeek Harness 桌面启动器',
    // deb 的 Maintainer 字段是必填的，不填 electron-builder 直接报错。
    // 用 GitHub 的 noreply 地址，不把真实邮箱写进包元信息。
    maintainer: 'yyh <yyh@users.noreply.github.com>',
  },
  deb: {
    // 不写就是 Section: default；devel 让它在 apt 里归到开发工具，和 .desktop 的
    // Categories（linux.category: Development）对上。
    packageCategory: 'devel',
  },
}
