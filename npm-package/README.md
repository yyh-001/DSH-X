# dsh-x（npm 版）

用 npm 安装的 DSH-X 启动器：Electron 外壳 + 从 npm 拉取的平台核心。

```sh
npm i -g dsh-x
dsh-x
```

首次运行会从 npm registry 下载当前平台的核心包（`dsh-x-core-win` / `dsh-x-core-mac`，约 12 MB），缓存到：

- Windows：`%LOCALAPPDATA%\dsh-x`
- macOS：`~/Library/Caches/dsh-x`

之后用 `dsh-x --update` 更新核心，或用 `npm update -g dsh-x` 更新 CLI 和 Electron 依赖。

## 命令

```sh
dsh-x              # 启动管理器
dsh-x --update     # 更新核心到 npm 最新版
dsh-x --version    # CLI 和核心版本
dsh-x --core       # 核心目录
dsh-x --help
```

## 和安装版的区别

- 安装版（`DSH-Setup.exe` / dmg）自带 Electron 和一份核心，更新走安装包/核心自更新。
- npm 版用 `electron` npm 依赖和缓存里的核心，更新走 npm；没有快捷方式、卸载项和开机自启。
- 两者共用 `%APPDATA%\DSH`（macOS `~/Library/Application Support/DSH`）里的设置和 dsh 版本，单实例锁会让先启动的那个接管。

## 环境变量

- `DSH_CORE_REGISTRY`：覆盖 npm registry（默认 `registry.npmmirror.com`，失败退回 `registry.npmjs.org`）。
- `DSH_CORE_CHANNEL`：`latest` / `rc` / `alpha`。
- `DSH_CORE_PACKAGE`：覆盖核心包名（一般不用）。
- `DSH_NPM_CACHE`：覆盖缓存目录。
- `DSH_ELECTRON_BIN`：覆盖 Electron 可执行文件（测试用）。
