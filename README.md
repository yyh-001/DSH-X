<p align="center">
  <img src="docs/hero.png" alt="DSH-X" width="880" />
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 启动器 ——<br />
  启动项与多实例，版本、插件、实例、MCP 和技能管理。
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-0078D6?style=flat-square" />
  <img alt="macOS" src="https://img.shields.io/badge/-macOS-000000?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-FCC624?style=flat-square&logo=linux&logoColor=black" />
</p>

<p align="center">
  <a href="https://github.com/yyh-001/DSH-X/releases">
    <img src="https://img.shields.io/github/v/release/yyh-001/DSH-X?label=Release&color=4D6BFE" alt="Release" />
  </a>
  <a href="https://www.npmjs.com/package/@yyh001/dsh-x">
    <img src="https://img.shields.io/npm/v/%40yyh001%2Fdsh-x?label=npm&color=4D6BFE" alt="npm" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-4D6BFE" alt="License" />
  <br>
  <img src="https://img.shields.io/github/downloads/yyh-001/DSH-X/total?label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/yyh-001/DSH-X?label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/yyh-001/DSH-X?label=contributors&color=4D6BFE" alt="Contributors" />
</p>

<p align="center">
  <samp><a href="https://yyh-001.github.io/DSH-X/">主页</a> · <a href="https://github.com/yyh-001/DSH-X/releases/latest">下载</a> · <a href="docs/releases">更新日志</a> · <a href="CONTRIBUTING.md">参与贡献</a> · <a href="README.en.md">English</a> · <strong>中文</strong></samp>
</p>

> [!IMPORTANT]
> **DSH-X 启动的是 DeepSeek Harness 官方原版 Web 页面。**  
> 它只负责版本安装、启动和插件管理，不修改也不重做 DSH 的网页界面。DSH-X 本身是社区开源项目，并非 DeepSeek 官方产品。

## 功能

- 🚀 **启动项与多实例** — 按项选择用户目录、配置、版本和端口；支持并行启动，运行中也可添加启动项。
- 📦 **版本管理** — 独立管理已安装版本，支持检测新版本、手动安装、卸载、查看磁盘占用和为启动项指定版本。
- 🧩 **插件与实例** — 实例锁定 DSH 版本和插件版本，可导入、导出并跟随上游更新；插件按配置开关，可配置官方自定义插件市场的默认索引源。
- 🖥️ **桌面增强** — 新建启动项时勾一下，把原生通知、右键菜单、侧栏浏览器三个首方插件装进这个启动项用的实例；编辑启动项时还能补装，装完可在插件页单独开关和更新。
- 🛠️ **MCP 与技能** — 配置 MCP 服务器，导入、管理和开关技能。
- 🪟 **多种打开方式** — DSH-X 内部标签页、系统浏览器标签页、浏览器独立窗口或桌面窗口。
- 🎨 **外观** — 浅色 / 深色主题、透明度、开场与启动项动效，以及独立的背景和大肥鱼开关。
- 🔄 **更新与恢复** — 自更新、故障恢复、配置备份与回退，可设置保留数量的旧版本清理；启动项当前与上一次使用的版本额外保留。
- 🔍 **启动排查** — 启动项日志分「原始日志 / 耗时构成 / 空间构成」三个页签，原始日志页带插件诊断：按插件归并启动耗时和依赖，单列原生 / GC 明细，空间占用拆到插件本体、依赖、运行时与配置数据；有插件报错时日志图标点红。
- ⚙️ **桌面系统开关** — 硬件加速、自动下载更新（安装手动确认）、任务通知与提示音、关窗口隐藏到托盘、防休眠。
- 💻 **Windows / macOS / Linux** — 三个平台的安装包，支持托盘 / 菜单栏常驻和开机自启，自带 npm / pnpm 包装。

## 快速开始

从 [Releases](https://github.com/yyh-001/DSH-X/releases/latest) 下载对应平台的安装包：

| 平台 | 系统要求 | 安装包 |
| --- | --- | --- |
| Windows | Windows 10 及以上，x64 | `DSH-X-<版本>-win-x64.exe`（NSIS） |
| macOS | macOS 13 及以上 | `DSH-X-<版本>-mac-arm64.dmg`（Apple Silicon）/ `DSH-X-<版本>-mac-x64.dmg`（Intel） |
| Linux | x64；AppImage 依赖 FUSE | `DSH-X-<版本>-linux-x64.AppImage` / `DSH-X-<版本>-linux-x64.deb` |

> [!NOTE]
> 安装包只带外壳和 Electron，不内置核心。首次启动需要联网，从 npm 下载当前通道的 `dsh-x-core`，窗口里显示实时进度和下载源；之后核心更新同样走 npm。

### Windows

下载 `DSH-X-<版本>-win-x64.exe` 安装，从桌面打开 **DSH-X**。安装包未做 Authenticode 签名，SmartScreen 可能提示「未知发布者」，见[签名与杀软误报](#签名与杀软误报)。

### macOS

打开 dmg，把 **DSH-X** 拖进「应用程序」。目前使用 ad-hoc 签名、未做公证，首次打开可能需要在系统安全提示中手动允许；如果提示「已损坏」或「无法验证开发者」，右键打开，或执行：

```sh
xattr -dr com.apple.quarantine /Applications/DSH-X.app
```

mac 的外壳自更新暂不提供，核心仍走 npm 更新。

### Linux

下载 `DSH-X-<版本>-linux-x64.AppImage`，`chmod +x` 后直接运行；没有 FUSE 时用 `./DSH-X-<版本>-linux-x64.AppImage --appimage-extract-and-run`。

Debian / Ubuntu 也可以装 deb（装到 `/opt/DSH-X`、带菜单项、`apt remove dsh-x` 卸干净），但 **deb 版没有外壳自更新**，换版本要去发布页重新下载：

```sh
sudo apt install ./DSH-X-<版本>-linux-x64.deb
```

配置在 `~/.config/DSH`，核心缓存在 `~/.cache/dsh-x`；两种包的核心更新都走 npm。

### 校验下载

Release 页面每个文件旁边有 sha256，本地对一下即可：

```sh
certutil -hashfile DSH-X-<版本>-win-x64.exe SHA256     # Windows
shasum -a 256 DSH-X-<版本>-mac-arm64.dmg              # macOS
sha256sum DSH-X-<版本>-linux-x64.AppImage             # Linux
```

## 使用

- 在主页添加或编辑启动项，选择实例与配置后启动；编辑启动项时可打开 **版本管理**，手动安装或卸载版本。
- 设置 → 常规 → **打开 dsh 的方式**，可选 DSH-X 内部标签页、浏览器或独立窗口。内部标签页需要使用安装后的桌面端。
- 管理页默认端口为 `3780`，被占用时会顺延。
- 手机或其他电脑访问 dsh：设置 → 高级设置 → **Web 绑定**选「局域网」，下次启动生效。

### 添加启动项

新建启动项先选 **隔离方式**，它决定新配置跟现有的隔多远：

| 隔离方式 | 建在哪 | 共享什么 |
| --- | --- | --- |
| 插件隔离（默认） | 全局 dsh 目录里新建一个配置 | 会话、记忆、技能；插件与配置独立 |
| 会话隔离 | 数据目录 `homes/<名字>` 下的新用户目录 | 什么都不共享：会话、技能、插件全部独立 |
| 自定义 | 手动指定用户目录 + 配置 + 端口 | 由你挑的用户目录和配置决定 |

前两档再选 **配置从哪来**：

- **新建配置**：名字留空就自动取（撞名会顺延），也可以自己填。
- **从已有配置复制**：先选来源（左栏用户目录、中栏配置），新名字预填 `来源-copy`，可以改。

复制的是 **配置**，不是整个用户目录：`package.json`、`cordis.patch.yml`、插件开关与 MCP 等配置会带过去，
依赖按版本范围重新安装（不是原样复制 `node_modules`），用户目录下的 `skills`、Prompt 管理、各插件自己的数据目录和会话历史都不跟过来。
`file:` / `link:` / `portal:` 这类本地依赖会按新位置改写；指向来源目录外面的路径保持原样，所以那份工作区得还在。

### 排查启动问题

启动项的日志弹窗有三个页签，只有采到数据时才出现：**原始日志**常驻，**耗时构成**把启动耗时按插件归并（共用依赖均摊给引用它的插件），**空间构成**把磁盘占用拆成插件本体、插件依赖、运行时、运行时依赖和配置与数据。原始日志页顶部还会显示**插件诊断**：哪个插件不兼容、哪一步失败，以及可以执行的修复方案。有插件报错时，启动项上的日志图标会点红。

### 插件与配置

- 插件页右上角的 **+** 可以直接添加插件：npm 包名、本地绝对路径或 Git 地址；添加和卸载会同步 bundle 层栈与依赖。
- 首页插件弹窗的「更多操作」里有 **配置备份与回退**：每次启动前自动存一份配置层快照，也可以手动「立即备份」；回退会按还原后的清单重装依赖，并需要重启这个配置的实例才生效。

## 界面预览

**多启动项 · 深色主题**

<p align="center">
  <img src="docs/screenshots/screenshot-launches.png" alt="DSH-X v0.1.16 多启动项主页" width="820" />
</p>

<details>
<summary>管理页面 · 深色主题（展开查看）</summary>

**配置列表**

<p align="center">
  <img src="docs/screenshots/screenshot-profiles-dark.jpg" alt="DSH-X v0.1.16 深色配置列表" width="820" />
</p>

**插件管理**

<p align="center">
  <img src="docs/screenshots/screenshot-plugins-dark.jpg" alt="DSH-X v0.1.16 深色插件管理" width="820" />
</p>

**实例市场**

<p align="center">
  <img src="docs/screenshots/screenshot-market-dark.jpg" alt="DSH-X v0.1.16 深色实例市场" width="820" />
</p>

**常规设置**

<p align="center">
  <img src="docs/screenshots/screenshot-settings-dark.jpg" alt="DSH-X v0.1.16 深色常规设置" width="820" />
</p>

</details>

<details>
<summary>管理页面 · 浅色主题（展开查看）</summary>

**启动器主页**

<p align="center">
  <img src="docs/screenshots/screenshot-home.jpg" alt="DSH-X 启动项主页" width="820" />
</p>

**配置列表**

<p align="center">
  <img src="docs/screenshots/screenshot-profiles.jpg" alt="DSH-X 配置列表" width="820" />
</p>

**插件管理**

<p align="center">
  <img src="docs/screenshots/screenshot-plugins.jpg" alt="DSH-X 按配置管理插件" width="820" />
</p>

**实例市场**

<p align="center">
  <img src="docs/screenshots/screenshot-market.jpg" alt="DSH-X 实例市场" width="820" />
</p>

**常规设置**

<p align="center">
  <img src="docs/screenshots/screenshot-settings.jpg" alt="DSH-X 设置页" width="820" />
</p>

</details>

**多标签页 · 深色主题**

<p align="center">
  <img src="docs/screenshots/screenshot-tabs.png" alt="DSH-X v0.1.16 多标签页界面" width="820" />
</p>

## 实例

实例 = 装好插件的 DSH：一个 DSH 版本加上钉住版本的插件。配置就是 dsh 的 profile，只放设置和数据。启动项选一个实例和一个配置，启动前把实例的插件装进配置，插件清单变了才装依赖。格式沿用 [DSH-PackForge](https://github.com/DSH-PackForge/DSH-PackForge) 的 `.dspack`（manifest v5）。

- **导入** — 社区市场、本地文件、目录、直链或 GitHub `owner/repo`；缺的 DSH 版本自动装。包里的配置默认不导，可勾选导进某个配置。
- **导出** — DSH 精确版本 + 钉好的插件（npm 钉版本、github 钉提交、本地插件打成离线文件），不带配置和凭据；单个文件或可直接提交的仓库目录。
- **跟随上游** — 来自 GitHub 仓库的实例会提示新 release；更新时本地改动照留，旧版本可以切回。

仓库中有两套配方，在实例页列为内置实例：

- [推荐实例](src/packs/dsh-x-recommended/manifest.json) — 配置管理、记忆、同步和大肥鱼装饰插件，均从 npm 安装（同步由可选插件 `dsh-x-sync` 提供）。
- [桌面工作台](src/packs/dsh-x-workbench/README.md) — 把 dsh-tauri 桌面版的侧栏工作台、工作树、定时任务、归档和通知在纯 dsh 生态里凑齐，ZCode 的 `agent-browser` 与 `electron` 技能可在导入时选择写进配置。

运行 `node scripts/make-pack.mjs` 可生成 `.dspack`，再作为本地文件导入。

## 桌面增强

「添加启动项」里勾上「安装桌面增强」，保存时把三个首方插件装进这个启动项对应的配置（从 npm 装，不随安装包发；装完在插件页单独开关和更新）。编辑启动项时还能看到装了几个、补装缺的；取消勾选不会卸载。

- [原生通知](https://www.npmjs.com/package/dsh-x-desktop-notify) — 一轮结束、等你确认时发系统通知，并把桌面能力借给其它插件
- [右键菜单](https://www.npmjs.com/package/dsh-x-context-menu) — 会话、工作区、选中文字、链接和输入框的右键菜单，纯网页插件、不依赖桌面外壳
- [侧栏浏览器](https://www.npmjs.com/package/dsh-x-sidebar-browser) — 操作 dsh 官方右栏 Browser：快照、点击、输入、截图

## 动态壁纸

配套的 Wallpaper Engine 壁纸[《DSH-X · 大肥鱼桌面终端》](https://steamcommunity.com/sharedfiles/filedetails/?id=3814706575)：DSH-X 品牌开场、大肥鱼、本机时间与音乐频谱，按时间自动切换深浅配色。源码在 [`wallpaper/`](wallpaper/)，`node scripts/export-wallpaper.mjs` 导出 Wallpaper Engine 工程。

<p align="center">
  <img src="wallpaper/preview.jpg" alt="DSH-X 动态壁纸" width="820" />
</p>

## 签名与杀软误报

发布清单的签名用于校验文件完整性，与 Windows 发布者签名不同。目前 `DSH-X-<版本>-win-x64.exe` 和给 0.1.18 旧更新器用的兼容桥 `DSH-Setup.exe` 都尚未做 Authenticode 签名，可能出现 SmartScreen「未知发布者」提示。杀软误报可向[微软](https://www.microsoft.com/en-us/wdsi/filesubmission)或对应杀软厂商提交安装包申诉。

## 说明

> [!WARNING]
> **上游仍在快速迭代** — dsh 内核与插件生态更新频繁，可能存在破坏性变更；升级前请确认插件兼容性。

> [!NOTE]
> **安全提示** — dsh 具备本地代码执行能力，DSH-X 只负责安装与启动。请仅在可信环境中使用。

## 开发

本机需要 Node.js 22.18+。启动器本身没有第三方依赖：`npm start` 启动管理页，只起服务用 `npm run server`，测试用 `npm test`。外壳是 Electron，`npm run electron` 或打安装包前先 `npm install`。

开发、提交与发版约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 打包

```sh
npm install
npm run dist
```

Windows 产出 `release/eb/DSH-X-<版本>-win-x64.exe`（NSIS）和给 0.1.18 旧更新器用的兼容桥 `release/eb/DSH-Setup.exe`；macOS 产出 `release/eb/DSH-X-<版本>-mac-<arch>.dmg`；Linux 产出 `release/eb/DSH-X-<版本>-linux-x64.AppImage` 和 `.deb`。安装包由 electron-builder 生成，不再需要 Rust / Inno Setup。

安装包只带外壳和 Electron，核心不在包里：首次启动由 `shell/core-fetch.mjs` 从 npm 取到用户目录的 `core/current`，之后核心跟随 npm 更新。

发版前检查版本与产物（发布清单与 SBOM 只在本机自查，不上传 Release）：

```sh
node scripts/release-manifest.mjs check-tag v0.1.22
node scripts/release-manifest.mjs verify
```

GitHub Actions 的 `build` 工作流构建 Windows / macOS / Linux 三个平台的安装包，并在 tag 上发布 npm 核心包与 CLI。macOS 目前只出 dmg（临时签名，外壳自更新暂不提供）；Linux 用 AppImage + `latest-linux.yml`。

发布清单的私钥在 `release/release-key.pem`（已被忽略、不进仓库，**务必备份**）。

## 参与

- 安全问题见 [SECURITY.md](SECURITY.md)，别开公开 issue。
- 每个版本改了什么，见 [docs/releases](docs/releases)。
- 交流 / 反馈：**QQ 群 [993579665](https://qm.qq.com/q/7AD2g70HqS)**（[点击加入](https://qm.qq.com/q/7AD2g70HqS)）
- 插件 2 群（DeepSeek Harness）：[点击链接加入群聊](https://qm.qq.com/q/hCjdOJOjSw)

## 相关项目

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 上游 dsh agent 平台
- [DSH-PackForge](https://github.com/DSH-PackForge/DSH-PackForge) — 整合包 `.dspack` 格式与配方工具
- [deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) — 同生态的 Tauri 桌面版，本仓库的整合包配方参考了它的插件集合

## 许可

[MIT](LICENSE) © 2026 yyh
