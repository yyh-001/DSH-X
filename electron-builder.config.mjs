import { join } from 'node:path'

/**
 * electron-builder 配置：外壳/Electron 的自更新交给 electron-updater。
 *
 * 安装包拆成两层：
 * - resources/app（release/shell-stage）：外壳，版本 = shell/package.json
 * - resources/core（release/core-stage）：基线核心，版本 = package.json
 *
 * 两个通道各自更新自己那层：
 * - 外壳/Electron：electron-updater（NSIS/dmg），换整个安装包
 * - 核心：npm（core-npm.js），换用户目录的 core/current（外壳启动时优先加载它）
 *
 * asar: false：dsh 子进程和 compat/perf 钩子要按真实路径读文件，asar 里读不到。
 * 签名：Windows 暂不签名（SmartScreen 会警告）；macOS 没有 Developer ID 时用 ad-hoc 签名
 * （identity: '-'），否则未签名的 arm64 包会被 Gatekeeper 判成「已损坏」，连启动都不行。
 * mac 只出 dmg，不打包 zip（也就没有 latest-mac.yml）；以后拿到 Developer ID，把 zip 目标
 * 加回来，并放开 shell/updater.mjs 里的 mac 限制。
 */
export default {
  appId: 'io.github.yyh-001.dsh-x',
  productName: 'DSH-X',
  copyright: 'Copyright (C) 2026 yyh',
  directories: {
    app: 'release/shell-stage',
    output: 'release/eb',
    buildResources: 'assets',
  },
  asar: false,
  npmRebuild: false,
  files: ['**/*'],
  extraResources: [
    // 基线核心：首次启动 / 用户目录里的核心坏掉时用它
    { from: 'release/core-stage', to: 'core' },
  ],
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
    icon: join('assets', 'dsh.ico'),
    executableName: 'DSH',
    artifactName: 'DSH-Setup-${version}.${ext}',
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
    installerIcon: join('assets', 'dsh.ico'),
    uninstallerIcon: join('assets', 'dsh.ico'),
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: join('assets', 'icon.png'),
    category: 'public.app-category.developer-tools',
    executableName: 'DSH',
    artifactName: 'DSH-X-${version}-${arch}.${ext}',
    // 没有固定证书时用 ad-hoc 签名（'-'）；有证书的 tag 构建交给 electron-builder 自动发现
    identity: process.env.DSH_MAC_IDENTITY || (process.env.DSH_MAC_REQUIRE_SIGNED === '1' ? undefined : '-'),
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: 'DSH-X',
    artifactName: 'DSH-X-${version}-${arch}.${ext}',
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    icon: join('assets', 'icon.png'),
    category: 'Development',
    executableName: 'DSH',
    artifactName: 'DSH-X-${version}-${arch}.${ext}',
    synopsis: 'DeepSeek Harness launcher',
    description: 'DeepSeek Harness 轻量桌面启动器',
  },
}
