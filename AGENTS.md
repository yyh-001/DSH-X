# AGENTS.md

给在这个仓库里干活的 AI 的说明书，人看也欢迎。**动手前先读「硬规矩」与「关键机制」两节。**

## 这是什么

DSH-X：DeepSeek Harness（`dsh`）的第三方启动器。`package.json` 的 `name` 是 `dsh-x`——deb 的包名取的就是它，别改回早先那个 `dsh-versions`。它启动的是 dsh 官方原版 Web 界面，自己不重做 dsh 的页面。

```
Windows/macOS 外壳  shell/（Electron）  DSH.exe / DSH-X.app：Chromium 窗口与内部标签页、托盘、菜单栏、单实例；服务跑在同一进程里
Node 服务  src/start.js → src/server.js   管理页后端 + 版本 / 插件 / 整合包 / 同步的全部业务
管理界面   src/public/index.html          单页手写 HTML + 原生 JS，无框架、无构建步骤
启动进度页 src/public/booting.html        点「启动」后新开的窗口：轮询 /api/state 显示阶段与安装进度，dsh 就绪后自己跳进去
注入钩子   src/compat/  src/perf/         被注入 dsh 进程，修补运行时行为（见下）
```

**零第三方运行时依赖**：服务与页面的 import 都是 `node:` 内置或相对路径，没有构建步骤。安装包不依赖用户机器环境：dsh 子进程默认用 Electron 自带的 Node（打包时只把 npm / pnpm 抄进 `node/`），旧安装包里的 `node/node.exe` 继续兼容；设置里可以改成系统装的 Node（`settings.json` 的 `nodeRuntime` / `systemNodePath`，`shell/env.mjs` 在 `platform.js` 求值前定好 `DSH_RUNTIME_NODE`，换档要重启启动器）。
唯一的例外在**打包期**：三个平台的外壳都要 `electron` 与 `electron-builder`（`devDependencies`，打安装包前先 `npm install`）。`shell/` 之外的代码别 import 它们；`npm start` / `npm test` 不需要装。

## 怎么跑、怎么验

| 命令 | 干什么 |
|---|---|
| `npm start` | 起管理页（开发入口） |
| `npm run server` | 只起网页服务，不开浏览器 |
| `npm test` | 全部用例（`node --test`，300+ 用例，约 16 秒） |
| `node --test test/packs.test.mjs` | 单个用例文件 |
| `npm run electron` | 用 Electron 外壳从源码起（Windows / macOS / Linux，先 `npm install`） |
| `npm run dev:core` / `dev:shell` / `dev:app` | 不打包的验收实例：安装版外壳+本地核心 / 源码外壳 / 伪安装；见 `scripts/dev.mjs` |
| `npm run dist` | 打安装包（都先 `npm install`；macOS 还要 Xcode CLT） |
| `npm run stage:core` | 只组装核心层 `release/core-stage`（给 `pack-core.mjs` 打 npm 包），不出安装包 |
| `node scripts/make-pack.mjs` | 把 `src/packs/<名字>/` 打成 `.dspack`（产物在 `release/packs/`） |

- **跑测试别把输出接管道**（`| head`、`| tail` 会把输出缓冲成 0 字节，等于白跑）；要留证据就重定向到文件。
- **日常验收不用每次打包**：`dev:core` 用已安装外壳 + `release/core-stage`，临时数据目录，可与正式版并行；`dev:shell` 跑源码外壳（先退出已安装的 DSH-X，共用真实数据目录）；`dev:app` 把 `shell/` 同步进 `release/dev-app`（`app.isPackaged=true`，验打包后行为）。三者都支持 `--fresh` / `--no-stage` / `--dry-run`；只有验安装器、更新清单、平台产物时才需要 `npm run dist`。
- 没有 lint / 格式化配置，**也别加**：风格靠已有代码和这份文档。
- **界面图标统一走 Lucide**（ISC）：源 SVG 在 `scripts/icons/lucide-1.69.0/`，`npm run icons` 生成 `src/public/icons.svg`；页面只写 `<svg><use href="/icons.svg#lucide-x"/></svg>`，不要再手写图标路径。新增图标先放源文件再生成。窗口按钮、下拉小三角、实心 Star、播放是自绘的少数例外；许可证随雪碧图发（`src/public/icons-LICENSE.txt`）。
- 用例里有三只"假服务器"（`test/fake-s3.mjs`、`fake-webdav.mjs`、`fake-proxy.mjs`），网络相关改动靠它们离线验证。

## 硬规矩

- **改完不要自动 commit、不要自动 `npm run dist`、不要发版。** 改动留在工作区，等用户明确指令；用户习惯自己按功能拆提交。
- commit message 用**中文**，格式 `类型: 说明`。类型只有四个，和发版说明的四块一一对应：`feat`（新增功能）/ `perf`（体验优化）/ `fix`（问题修复）/ `chore`（其他变更）。`node scripts/release-notes.mjs` 按前缀拆块生成草稿。
- README 中英成对改（`README.md` + `README.en.md`）；**改 README 默认是"砍"不是"加"**——用户会周期性说"写得太多"。
- Release notes 按 `docs/releases/TEMPLATE.md` 写进 `docs/releases/v<版本>.md`（**入库**，中英同篇、四块固定、一行一条、挂 `@贡献者`）；不写根因、验证过程、安装说明。预发布（rc / alpha）在 GitHub 上勾 Pre-release。QQ 群公告压到 400 字符内（只写用户看得见的变化，下载只留落地页一条链接），存一份到 `release/群公告-<版本>.txt`。
- 注释写**为什么**（这个仓库的风格：每个不显然的决定都带一段解释，很多是踩坑记录），用中文；不写逐行翻译代码的注释。
- `release/release-key.pem` 是发版签名私钥：不进仓库、别提交、别把内容打印到日志；动相关流程时提醒用户备份。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `src/` | 核心运行时，打成 npm 核心包 `dsh-x-core`（安装包里不带，第一次启动由外壳下载）；下面带 `src/` 前缀的行都在这里 |
| `src/start.js` | 入口：端口与日志（`server.js` 在 Electron 外壳里被直接 import，不再经过它） |
| `src/server.js` | 管理页后端 + 全部业务（最大文件）：HTTP 路由、版本管理、插件安装、整合包、启动失败自愈 |
| `src/settings.js` | 设置读写；`safe*` 一族是校验函数（端口、路径、代理、语言……都从这过） |
| `src/registry.js` / `src/version.js` | dsh 版本发现、pnpm 交互（进度解析）、版本号比较；装版本失败时把 npm 的收尾报错换成具体提示（`describeNpmFailure`：ETARGET 发版不齐 / 404 没有这个包） |
| `src/plugins.js` | 插件开关：直接改 profile 的 `cordis.patch.yml`，不需要 dsh 在跑 |
| `src/mcp.js` / `src/skills.js` | MCP server 与技能的读写、探测、开关 |
| `src/packs.js` | 整合包：`.dspack`（manifest v5 ZIP）的解析 / 检查 / 安装 / 导出 / 回滚 |
| `src/zip.js` / `src/zipfile.js` | zip 的写与读（手写，无依赖） |
| `src/sync.js` | 同步引擎：S3 / WebDAV / 本地目录 / ZIP 四种后端共用一个"远端"抽象 |
| `src/proxy.js` | `netFetch`：Node 全局 fetch 不看系统代理，所有外网请求走它 |
| `src/platform.js` | 平台常量与「Electron 本体当 node 用」的推导（`RUNTIME_NODE` / `RUNTIME_NODE_ENV`）；只有常量，没有行为 |
| `src/filemanager.js` | 按平台挑一套文件管理实现，导出 `fileManager` 与 `APP_DIR`；业务代码只认它 |
| `src/filemanager-base.js` | 那个接口本身：契约、默认实现、其他 POSIX 平台的 xdg-open 兜底（`PosixFileManager`） |
| `src/filemanager-windows.js` / `-mac.js` / `-linux.js` | 三套实现类，都随跨平台核心包发，运行时按平台动态 import |
| `src/plugin-tool.js` | 命令行开关插件（dsh 起不来时的救命工具），有可执行位 |
| `src/stdio-unblock.cjs` | stdout/stderr 阻塞模式修补（`--require` 注入用） |
| `src/public/` | 管理界面与看板娘素材（`index.html` 是主体；`booting.html` 是启动进度页，由 `/booting` 渲染） |
| `src/compat/` `src/perf/` | 注入 dsh 进程的钩子：兼容修补与加速 |
| `src/assets/` | 图标 master（`icon.png` → `make-icons.py` 出全套） |
| `src/packs/` | 随安装包发的整合包配方（插件页「内置整合包」就地安装） |
| `plugins/` | 插件实现的源码与发布源（发 npm，不随安装包）；**别和 `src/packs/` 合并** |
| `scripts/` | 打包（`pack.mjs` / `pack-mac.mjs` / `pack-common.mjs` / `electron-prune.mjs`）、图标（`make-icons.py`）、落地页素材、发版说明草稿（`release-notes.mjs`，按 commit 前缀拆块）、发版清单与 SBOM |
| `skills/` | 给 AI 用的技能源码（随仓库分发，不进安装包）：`dsh-x-selfcheck` 只读自检 DSH-X 环境（环境/管理页/数据目录/DSH_HOME/profile/实例/插件/技能/同步/日志），`node skills/dsh-x-selfcheck/scripts/selfcheck.mjs`，零依赖；用例见 `test/selfcheck-skill.test.mjs` |
| `shell/` | Windows / macOS / Linux 的 Electron 外壳（`main.mjs` 窗口 / 托盘 / 菜单，`tabs.mjs` 内部标签页，`preload.cjs` 页面桥，`updater.mjs` electron-updater）；`package.json` 是外壳版本，核心版本在根 `package.json` |
| `test/` | 用例与假服务器 |
| `docs/` | GitHub Pages 落地页 + 看板娘设计稿（`mascot-design/`）+ `releases/`（入库的发版说明，格式见 `TEMPLATE.md`） |
| `data/` `release/` `vendor/` | 运行时数据与产物，gitignored，可重建，**不用整理** |

**运行时收在 `src/`，打包时摊平**：`scripts/pack-common.mjs` 的 `APP_FILES` 把 `src/` 里的文件拷到 `release/core-stage` 根，`public/` `assets/` `compat/` `perf/` `packs/` 同样从 `src/` 拷过去；`pack-core.mjs` 再把这一层打成 npm 的 `dsh-x-core`（npm tarball 里统一在 `package/` 下，解包时剥掉）。安装包只有外壳（`resources/app`），核心第一次启动下载到用户目录的 `core/current`。`package.json` 留在仓库根，打包时单独抄一份进核心；`src/server.js` 先找核心自己的 `package.json`，找不到再回退到 `../package.json`，源码运行不用复制。**新增运行时文件要同时放进 `src/` 和 `APP_FILES`，别只挪文件不改编排。**

## 关键机制

### 版本、实例与数据

- 每个 dsh 版本装在数据目录（默认 `%APPDATA%\DSH\data`，设置里可改）的 `versions/<版本>/`。
- **一个「版本 × profile」一个实例**，可以同时跑，各占各的端口：默认给会起 web 的 profile 传 `--port 0`，由系统现挑，启动器再从 dsh 打印的地址里读回真实端口。
- 端口也能手工钉死（控制页那个「端口」输入框 → `settings.json` 的 `instancePorts`，键 `版本@profile`）：钉了就传 `--port <它>`，链接每次启动都一样（书签、手机上的地址才留得住）。钉住的组合起不来时（`EADDRINUSE`）报错要点名端口和占用者。**这是 dsh 实例的端口，跟管理页端口（`port`）是两回事，两者不能撞。**
- dsh 本体数据在 `DSH_HOME`（默认 `~/.dsh`，可配），跨版本共享，所以换版本不用重装插件。
- 启动器自己的设置与日志在 `%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`）。

### profile

dsh 的环境隔离单位。模板名（web / headless / acp / sdk / …）会自动初始化，自定义名必须先有 `package.json`，否则 dsh 拒绝启动。插件按 profile 分，会话与记忆共享。启动器提供切换与开关；插件开关就是往 `cordis.patch.yml` 写 `- id: <行> / disabled: true`，删掉该块即恢复。

恢复档（`recovery.js`，官方 desktop `sanitizeProfile` 的同款语义）：`POST /api/recover` 把补丁层**改名**成 `cordis.patch.yml.bak-<时间戳>`（备份即改名、不解析补丁内容），再按侧车记录摘掉清单里非 `@deepseek-ai/*` 的 bundle；`POST /api/recover/restore` 把备份改回来、现役补丁先挪到新备份、并按侧车放回被摘的 bundle。改补丁层/清单前都过 `withProfileLock`（profile 目录里一个存 PID 的 `lock` 文件，`wx` 独占创建、属主僵死才清理）——与官方锁同名同语义。这是逐行自动禁用都失效时的最后手段；清单 JSON 坏掉时只告警、补丁层照样移走（救援优先，官方是整单失败）。

### 插件与整合包（两个目录，别合并）

- `plugins/<包名>/` 是**插件实现的源码与发布源**（npm 包：`dsh-x-memory`、`dsh-x-sync`、`dsh-x-aquarium`），**不随安装包发**：插件都发到 npm，用户从插件页 / 整合包装，装完能看远程版本、能更新。改了这里的代码要 `npm publish`（版本号记得加）。
- `packs/dsh-x-recommended/` 是**整合包配方**（`manifest.json` + `dspack.json` + README），**不含代码**，随安装包发；依赖一律写 npm 版本号。
- 没有「内置插件」这条路：预置到当前 profile 的开关、随包发插件的复制逻辑、整合包里的 `"…": "bundled"` 依赖解析都已撤（`planInstall` 见到 `bundled` 会直接报错）。
- 为什么不能合并：`.dspack` 只认 `overrides/`、`home/`、`profiles/` 与几个根文件，插件源码放进去会被当"不属于整合包"跳过（`packs.js` 的解析）；反过来 `plugins/` 下每个子目录都被当成一个 npm 包。

### 文件管理：一个接口，三套实现

每用户目录与安装布局、路径大小写、目录链接类型、系统文件对话框、在资源管理器 / 访达 / 文件管理器里打开或定位、交给系统默认程序打开地址、登录自启——这些**全部**走 `filemanager.js` 导出的 `fileManager`，业务代码里不再写 `process.platform === 'win32' ? … : …`。

- 契约在 `filemanager-base.js` 的 `FileManager` 上，每个方法的注释就是规范（失败怎么抛、取消返回什么、哪些错误可以当成成功）。
- `filemanager.js` 用**动态 import** 只加载当前平台那一套：三套实现都随跨平台核心包发，静态 import 会把另外两套也拉进来。它有顶层 await，所以实现类静态 import 的是 `filemanager-base.js` 而不是它——反过来 import 会死锁（Node 报 unsettled top-level await），这也是基类单独一个文件的唯一理由。
- 实现类的外部依赖（`execFile`、`statSync`、`existsSync`、`env`、`home`、`root`）都从构造函数注进去，所以 `test/filemanager.test.mjs` 能在一台机器上把三套实现跑在同一组断言上，不按平台 skip。
- `platform.js` 只剩常量与 `RUNTIME_NODE` 那套推导：打包脚本要在任何一台机器上 import 它，不能被平台判断牵连；`launchArgs()` 也用 `RUNTIME_NODE`，Electron 里它就是 Electron 本体。
- **Linux**：`filemanager-linux.js` 用 `$XDG_CONFIG_HOME/DSH`（默认 `~/.config/DSH`）、`xdg-open`、zenity/kdialog 对话框和 XDG autostart（`~/.config/autostart/dsh-x.desktop`）；AppImage 的启动项用 `APPIMAGE` 本身，避免挂载目录每次变化。
- 还留在 `server.js` 里的平台判断是**另一摊事**，故意没收进来：pnpm 子进程怎么起、`killTree`、GB18030 解码、Chromium 的安装位置、自更新包的名字。它们不是文件管理，而且本来就按参数传平台、能直接测。

### 注入进 dsh 的钩子（compat / perf）

- `compat/register.mjs`、`perf/register.mjs` 由启动器注入；worker 线程注入的是 `compat/worker-events.cjs`（worker 的 execArgv 是空的，只能靠 NODE_OPTIONS）。
- NODE_OPTIONS 里的路径走 `nodeOptionsPath()`（`server.js`）：反斜杠换正斜杠、含空白才包引号——**引号会吃反斜杠**，所以不能只加引号。**别退回「NODE_PATH 传目录 + 裸文件名」**：Electron 主进程不消费 NODE_PATH，会把应用顶死。
- dsh 自己的 Node 开关（系统证书库、请求头上限、两个 ESM 补丁钩子）走**命令行参数**，不塞 NODE_OPTIONS：后者会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 可能是老版本。
- 改会话事件词汇表（`SESSION_TYPES`）要**两处同步**：主线程的 `compat/session-events.mjs` 与 worker 的 `compat/worker-events.cjs` 各有一份副本。
- `perf/plugin-profile.mjs` 是**插件体检**：正常启动时用 V8 采样（CPU 1ms / 堆分配 64KB）按包统计启动期开销，稳定后写到 `<APP_DIR>/plugin-profile/<版本>@<profile>.json`；管理页实例行的「明细」读它。
  它靠 `perf/patch-hooks.mjs` 给 Cordis loader 的两个锚点注入 `enter/imported`（缺一个就整段跳过，启动不受影响）；只给 `bootOnce` 拉起的实例启用，插件命令 / AI 修复不写报告。

### 桌面端系统开关（设置页「常规 → 系统」）

- 六个键（`hardwareAcceleration` / `autoUpdate` / `taskNotifications` / `notificationSound` / `closeToTray` / `keepAwake`）存在 `settings.json`，**外壳直接读文件**（`shell/prefs.mjs`），不走管理页接口：外壳和核心分开更新，读同一份文件避免协议版本问题。默认值在 `settings.js` 的 `DEFAULTS` 与 `prefs.mjs` 的 `PREF_DEFAULTS` 两处，**必须一致**。
- `hardwareAcceleration` 在 `app.disableHardwareAcceleration()` 前读，必须在 app ready 之前决定（改完重启启动器才生效）；其余开关由每 1.5s 的托盘轮询按 mtime 重读后实时应用。
- `DSH_SHELL_PREFS=1` 由 `shell/env.mjs` 写入，`/api/settings` 的 `shellPrefs` 据此告诉页面外壳认不认这组键（旧外壳不认，页面把整组禁用并提示更新）。
- 任务通知：`server.js` 在实例启动失败 / 意外退出时调 `host.notify`（结构化字段），文案、`Notification`、提示音都在外壳里；**正常启动不发通知**（点了启动就看得到窗口，不必再响一声）。**这个开关只管外壳自己的提醒**：插件通知（`/api/desktop/notify`）不再受它控制，插件要不要提醒由 dsh 插件页里那个插件自己的开关决定。本机页面的 `notifications` 权限仍按 `taskNotifications` 放行。通知不带 `icon`：Windows 会把 icon 画成正文里的大方图，应用图标只留在标题栏。
- 自动更新：**只下载，不安装**（`autoUpdate` 打开时）。外壳层走 electron-updater（预览版通道跟着当前外壳版本：预发布版继续收预发布，正式版只收正式版），核心层由外壳调 `/api/self/app-download`；下完发一次「点首页更新安装」提醒。安装是用户动作：首页「更新」→ 核心 `/api/self/app-apply` / 外壳 `host.shellUpdate.install`；安装会让启动器退出重启，正在跑的 dsh 会跟着停。两个下载/应用接口都做了并发护栏（`appDownloadInFlight` / `appApplyStarted`），连点或两个页面同时触发也只会执行一次。
- 这组功能是**外壳**能力：只改核心不会到达用户，发包时要 bump `shell/package.json` 并重打安装包。

### 内置浏览器控制（设置页「浏览器控制」）

- 两个键（`browserControl` / `browserIgnoreCertificate`）同样是「核心写 `settings.json`、外壳直接读」，默认值在 `settings.js` 与 `shell/prefs.mjs` 两处**保持一致**。
- `browserControl` 管的是 agent 那一半：开着时 `ensureDesktopPlugins` 会补装首方插件 `dsh-x-sidebar-browser`，关掉时不再补装、并在启动补丁里给已装的插件补一行 `disabled: true`（见 `server.js` 的 `sidebarBrowserPatchArgs`）。**侧栏 Browser 本身不受影响**——`ui-sidebar-browser` 始终放开，用户手动看网页照旧；改完要重启 dsh 实例才生效。
- `browserIgnoreCertificate` 只作用于右侧栏浏览器的 guest 分区（`shell/browser-guests.mjs` 的 `applyCertificatePolicy`）：开着时 `callback(0)` 全放过，关掉时 `callback(-3)` 交回 Chromium 默认校验。**只在分区第一次创建时套一次，不跟外壳轮询**——改完重启启动器才生效。管理页和 dsh 页面始终正常校验。
- 清理按钮（`POST /api/browser/clear-cache` / `clear-data`）由核心转给 `host.browser`（`shell/main.mjs` 的 `clearBrowserData`）：分区名是 `persist:dsh-sidebar-browser-*`，进程里和磁盘（`userData/Partitions`）上的都要扫；清缓存只动 Cache Storage / Service Worker / HTTP 缓存，清全部连 Cookie、站点数据一起删。`/api/settings` 的 `browserHost` 表示当前外壳有没有这层能力，页面据此禁用按钮。
- 这是**外壳 + 核心**两层功能：发布时两个版本都要 bump。

### 插件桌面 API（`/api/desktop`）

- 插件跑在 dsh 子进程里，拿不到 Electron。能力走本机 HTTP：插件 → `server.js` 的 `/api/desktop/*` → `host.desktop`（`shell/main.mjs`）→ Electron。协议、请求形状和可复制的客户端封装见 `docs/desktop-api.md`。
- 环境变量由 `dshEnv()` 注入：`DSH_X_MANAGER_URL`（管理页实际端口，每次启动可能顺延）总会给；`DSH_X_DESKTOP=1` 只有 `host.desktop` 存在时才给（浏览器模式 / 旧外壳没有），插件按它静默降级。
- 请求校验在 `desktop.js`（核心纯函数，可单测）；外壳侧门控在 `shell/desktop.mjs`（通知开关 / 声音 / 500ms 节流 / 对话框选项）。**核心不许 import Electron 或 shell/，外壳不许 import 核心模块**（拆包后互不存在），`test/shell-desktop.test.mjs` 会检查。
- 插件通知与外壳自己的任务通知共用 `taskNotifications` / `notificationSound`：插件只能传 `silent: true` 关小声，不能打开用户关掉的提示音。点击地址只认 `http(s)`，本机地址仍走 `openLink`（内部标签 / 独立窗口）。
- `reveal` 只收绝对且真实存在的路径（这条路由没有鉴权，不能变成任意路径的文件管理器入口）；对话框父窗口只在管理页可见时挂。
- 这是**外壳 + 核心**两层功能：发布时两个版本都要 bump。只发核心 → 旧外壳返回 503；只发外壳 → 旧核心没有路由（404）。

### 桌面增强（设置里一键安装）

- 三个首方插件 `dsh-x-desktop-notify` / `dsh-x-context-menu` / `dsh-x-sidebar-browser` **不在安装包里，也不随启动自动装**：设置 → 常规 → 桌面增强 右侧「一键安装」才装。清单和版本门槛在 `desktop-plugins.js`（dsh ≥ 0.2.0，侧栏浏览器 ≥ 0.2.1-rc.2，同版本预发布算满足）；安装走 `POST /api/desktop-enhance/install`，复用插件页的 `addPlugin`（pnpm add + 写 `dsh.profile.bundles`）。
- 只装当前 profile 里缺的：已经在 `dependencies` 里（registry / `link:` / `file:`）算装过，不换版本；装完在 dsh 插件页单独开关，启动器不再插手。
- 内核版本低于插件下限时那一项跳过并在响应里给原因，不影响另外两个。
- 设置接口的 `desktopEnhance`（installed / total）驱动按钮显示「一键安装 / 已安装」。
- 发布时三个包要发到 npm（`0.1.1` 已发，`desktop-plugins.js` 的 `spec` 钉精确版本：首发会先出 `0.0.0-stage` 占位，`latest` 会装到空壳；升级由插件页做）。发版前先 bump 版本、把 `spec` 一起改，并确认三个包都有 `meta.title` + `locale/{zh,en}.json`（插件页的名字来自这两个位置，缺了会显示裸包名）。测试里的假 dsh 需要认 `plugin` 参数直接退出（`multi-instance` / `launch-project` / `profile-delete` / `plugin-market` 都这么改过）。

### 核心更新（core-npm.js / apply-update.mjs）

- 发布侧：核心作为一个跨平台 npm 包发版：`dsh-x-core`（Windows / mac / Linux 共用；三套 filemanager 和 node 包装都在包里，运行时按平台选）。`scripts/pack-core.mjs` 把 `release/core-stage` 打成 tarball，包里的 `package.json` 的 `main` 是 `server.js`，并带 `dshX.electron`（构建所用的 Electron 版本）；CI 的 `core-package` job（ubuntu，`pack.mjs --stage-only` 只组装核心层）用 `NPM_TOKEN` 按版本通道发到 `latest` / `rc` / `alpha`，和三个平台的安装包 job 互不依赖。
- **版本分两套**：根 `package.json` 是核心版本（npm 核心包 `dsh-x-core`；安装包里不再带核心），`shell/package.json` 是外壳版本（electron-builder 的安装包、`latest.yml`、npm CLI 包）。UI/服务端改动只 bump 核心版本，外壳版本不动，所以不会触发 100MB+ 的安装包更新；只有 Electron/主进程/托盘/更新器变化才 bump 外壳版本。
- **纯核心发版不出安装包**：CI 的 `prepare` 用 `shell_changed` 判断——`shell/`、外壳/安装包图标、Electron 版本、`electron-builder.config.mjs`、打包脚本都没变时，windows/macos/linux 三个 job 只跑测试、不打包（测试仍覆盖 Windows + Linux，mac job 整个跳过）；Release 标 `--latest=false`（发布页的 Latest 和 electron-updater 的 `/releases/latest` 继续指向上一次外壳发版），预发布通道还会把上次的 `latest.yml` 复制过去，免得 electron-updater 在最新 tag 上找不到清单。
- **bump 规则**：只改核心 → 只 bump 根 `package.json`；只改外壳/Electron → 只 bump `shell/package.json`；Electron 升级时两个都 bump（核心包要按新 Electron 重发，npm 不允许覆盖同版本）。外壳层有改动却没 bump 外壳版本时 CI 直接报错（包发给谁都是同一个版本号，等于发不出去）；只改核心时 npm CLI 包版本不变，CI 的 `npm view` 检查会跳过重复发布。
- **迁移**：旧 0.1.20 外壳只认 `dsh-x-core-win` / `dsh-x-core-mac`，不会看到新的 `dsh-x-core`，所以先发新核心包也不会被旧外壳的 `app-apply` 拿去换 `resources/app`。旧安装要先 bump `shell/package.json` 发一次新外壳（electron-updater 会拉），之后新外壳/CLI 才走 `dsh-x-core`；旧的平台包保持原样，不再发新版本。
- 客户端：`/api/self` 的 `app` 来自 npm registry 的 dist-tags（按核心版本所在通道选），`/api/self/app-download` 下载 tarball、校验 npm 的 `dist.integrity`（sha512）、解到暂存目录，`/api/self/app-apply` 负责切换。registry 默认官方/镜像跟着设置里的下载源走，`DSH_CORE_REGISTRY` 可以覆盖（本地演示用）。
- **安装布局**：`resources/app` 只有外壳（Electron main/tray/updater/preload/tabs + `electron-updater` 依赖），安装包里没有核心。mac 是 `Contents/Resources/app`；Linux AppImage 是 `AppDir/resources/app`。外壳启动时按 `DSH_CORE_DIR` → `%APPDATA%\DSH\core\current`（mac `~/Library/Application Support/DSH/core/current`，Linux `$XDG_CONFIG_HOME/DSH/core/current`，默认 `~/.config/DSH/core/current`）选核心，两者都没有时由 `shell/core-fetch.mjs` 从 npm 下载（挑和当前 Electron 兼容的最新版本）；核心声明 `dshX.electron` 和当前外壳不一致时也重新下载，旧的留一份 `core/previous` 用于回滚。
- 核心切换：
  - 首次启动 / 核心缺失 → `setupCore()` 直接下载到 `core/current`（`installCore`，旧目录先挪到 `core/previous`）；起不来时 `recoverCore` 把 previous 换回来，没有可回滚的就下次启动重新下载。
  - 已经在 `core/current` → 替换助手 `apply-update.mjs`（等父进程退出 → 备份 → 换目录 → 重启 → 45 秒内等不到启动标记 `<APP_DIR>/update-ok` 就回滚）。
  - 核心在用户目录里，不在签名的 .app 内，mac 不需要重签；旧版换 `Resources/app` + `MAC_APP_SWAP_SCRIPT` 的代码只为兼容旧安装包保留，核心更新不再走它。
- **外壳/Electron 升级**：`shell/updater.mjs` 用 electron-updater（electron-builder 的 NSIS/dmg/AppImage + `latest.yml`/`latest-linux.yml` + blockmap）。主进程把 `shellUpdate` 状态/操作挂在 host 上，页面走 `/api/shell-update/check|download|install`，进度是 SSE `shellUpdate`。安装时先停 dsh、退出，再静默安装并拉起新版。mac 的包用 ad-hoc 签名（`identity: '-'`；未签名的 arm64 包会被 Gatekeeper 判成「已损坏」），装不上更新包，所以只出 dmg、不发 zip/latest-mac.yml，`updater.mjs` 在 mac 上直接当不支持（`DSH_UPDATE_FEED` 仍可本地演练）；拿到 Developer ID 后加回 zip 目标并放开那里的平台限制。Linux 的 AppImage 自更新要求从 AppImage 启动（`APPIMAGE` 环境变量存在）；deb 装出来的进程没有这个变量，`updater.mjs` 直接当不支持，用户去发布页换包（核心那层照旧走 npm）。
- **核心升级**：核心包声明 `dshX.electron`，和当前进程不一致时 `checkAppUpdate` 返回 `reason: 'electron'`，页面提示先更新外壳；核心更新只换核心目录，不动 Electron。
- **首启取核心**：安装包里没有核心，`start()` 在 `resolveCoreDir()` 返回空时用 `setupCore()` 从 npm 取一份——镜像优先、失败退回官方，校验 npm 的 `dist.integrity`（sha512），解压用系统自带的 tar；下载期间显示带进度的启动页。**第一次启动需要联网**（和 npm 版一致）。这时还没有核心、读不到设置里的下载源和代理，所以网络走 Electron 的 `net.fetch`（跟随系统代理），registry 可用 `DSH_CORE_REGISTRY` 覆盖。挑版本时跳过起不来的版本（`recoverCore` 写进 `<APP_DIR>/core/bootstrap.json`），防止「下载 → 起不来 → 回退 → 再下载」循环；外壳很久不更新、核心已按新 Electron 构建时，会往下找最近一个还能跑的版本，而不是直接报错。
- 边界：源码运行、npm 版（`NPM_MODE`）、npm 上还没有对应平台包时都不提供核心更新；拆包后的核心模式（`DSH_CORE=1`）关掉 GitHub 安装包自更新检查，由外壳的 electron-updater 负责。
- 快捷方式图标：electron-builder 的快捷方式指向 `DSH.exe`，图标随外壳安装包更新；核心模式不再调 `refreshShortcuts`。
- 本地验收：`npm run stage:core && npm run dist && node scripts/update-flow-demo.mjs` 用 `release/core-stage` 造一份比当前高一个版本的假核心和假 npm registry，复制 `release/eb/win-unpacked` 到 `release/test-install` 并预置 `core/current`，按打印的命令（`APPDATA` 指到 `test-install/userdata`、带 `DSH_CORE_REGISTRY`）启动，点更新即可走「替换 core/current → 重启外壳」；外壳更新用 `DSH_UPDATE_FEED` 指到本地 latest.yml 目录。

### npm 版（npm-package/）

- `npm-package/` 是 `@yyh001/dsh-x` CLI 包：`npm i -g @yyh001/dsh-x` 后 `dsh-x` 启动。包里有 `shell/` 和图标（`assets/icon.png`、`tray.ico`、`tray.png`），版本跟 `shell/package.json` 走；依赖 `electron`（版本跟根 `package.json` 的 devDependencies 对齐），核心从 npm 拉跨平台的 `dsh-x-core` 到用户缓存（Windows `%LOCALAPPDATA%\dsh-x`、mac `~/Library/Caches/dsh-x`、Linux `~/.cache/dsh-x`），然后 `spawn(electron, [包根])` 启动外壳，并用 `DSH_CORE_DIR` 指向缓存核心。
- CLI 设置 `DSH_NPM=1`、`DSH_CORE_DIR` 和 `DSH_ELECTRON_BIN`；核心的 `NPM_MODE` 会关掉安装包/核心自更新，设置页「关于」提示用 `npm update -g @yyh001/dsh-x`。`node/` 包装脚本优先用 `DSH_ELECTRON_BIN`，没有就读核心写在 `core/` 旁边的 `electron-bin` 标记（核心启动时写；dsh 插件管理器的 service 路径会剥掉 `DSH_*` 变量，#102），再回退安装版的 `DSH.exe` / `Contents/MacOS/DSH` / AppImage 根目录的 `DSH`。
  - 标记位置跟着 `node/` 定：`<core>/../electron-bin`（安装版 `core/electron-bin`、npm 版 `<cache>/core/electron-bin`），核心更新只整目录换 `current`，标记原地留下。写标记和包装脚本模板都在 `src/electron-bin.js`，`pack.mjs` 只负责落盘。
- `scripts/pack-npm.mjs` 打包/发布 CLI（含外壳）；CI 的 `npm-package` job 在三个平台构建后发 `dsh-x`（需要 `NPM_TOKEN` 和 npm 上的包名）。npm 版没有快捷方式、卸载项和开机自启；数据目录与安装版共用。

### 打包与安装布局

- 文件管理的实现类不在 `APP_FILES` 里，`copyAppFiles` 把三套都拷进核心包（`FILE_MANAGERS`）；运行时 `filemanager.js` 按平台动态 import 只加载一套。核心包跨平台，所以不能再按平台只带一套；外壳才按平台分开。
- `APP_FILES`（`scripts/pack-common.mjs`）= 核心源码清单；`copyAppFiles` 把它们平铺拷进 `release/core-stage`（npm 核心包的内容），**不打 asar**：dsh 子进程要按真实路径读 `compat/`、`perf/`。核心的 `package.json` 的 `main` 是 `server.js`，由外壳动态 import。
- 核心目录里还有 `node/`（运行时目录：只有 npm / pnpm 的 JS 包和 `node` / `node.cmd` 包装，**没有 node.exe**——dsh 子进程用 Electron 自带的 Node）、`public/`、`assets/`、`compat/`、`perf/`、`packs/`。
- **Windows / macOS / Linux 外壳都是 Electron**：`npm run dist` 只组装 `release/shell-stage`（`shell/` + 图标 + `electron-updater` 依赖，版本 = `shell/package.json`）再交给 electron-builder（`electron-builder.config.mjs`）出 NSIS/dmg/AppImage/deb；安装包里没有核心。`npm run stage:core` 单独组装 `release/core-stage`（`APP_FILES` + `node/`，版本 = 根 `package.json`）给 `pack-core.mjs` 打 npm 包。`asar: false` 保持真实文件路径。早先的 Rust 安装引擎与 Inno 安装脚本已删，三个平台的安装包全由 electron-builder 出。
- **Electron 版本钉死 44.7.0，别随手升**：dsh 的 `node-addon-require-builtin` 只给几个 Electron 版本留了预编译（43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6），版本对不上时 dsh 一启动就报 `unsupported Electron runtime fingerprint`（见 `dsh: host preparation failed`）。升级 Electron 前先看 dsh 那边的支持列表，改完在打包版里真启动一个实例验证。
- 三个平台和服务同进程（Electron 外壳），用 `setHost({ onWake, openTab, openWindow, exit, relaunch, shellUpdate })` 直接接管；`relaunch` 供核心更新后重启外壳（`app.relaunch()`，避免单实例锁把新进程顶掉）。旧 Rust 外壳读 stdout 标记行的路径已经退役。
- dsh / npm / pnpm 子进程一律用 `platform.js` 的 `RUNTIME_NODE`，**别用 `process.execPath` 自己拼**：Electron 里 `RUNTIME_NODE` 就是 Electron 本体，拉子进程时必须同时展开 `RUNTIME_NODE_ENV`（里面是 `ELECTRON_RUN_AS_NODE=1`），否则会当 GUI 打开；`withBundledRuntime` / `orderRuntimePaths` 负责把 `node/` 里的 `node` / `node.cmd` 包装放进 PATH。
- 自更新（Windows）：electron-updater 下载 NSIS 安装包 → 静默安装 → 由安装程序拉起新版；Linux 用 `latest-linux.yml` + AppImage（从 AppImage 启动时 `APPIMAGE` 环境变量存在，electron-updater 才能替换）。macOS 目前不提供外壳自更新：临时签名装不上 zip 更新包，发布页只发 dmg 供手动安装。electron-builder 的 `latest.yml` / `latest-linux.yml` 和 `.blockmap` 必须一起上传，否则差分/更新取不到包。
- 发版产物要一起传：有外壳改动的版本才传 Windows 的 `DSH-Setup-<外壳版本>.exe` + `.blockmap` + `latest.yml`、mac 的 dmg（外壳自更新暂不提供，所以不发 zip/latest-mac.yml）、Linux 的 AppImage + deb + `latest-linux.yml`（deb 不进这个 yml）；核心 npm 包（`<核心版本>`）每次都由 `core-package` job 单独发。纯核心发版没有安装包资产，`latest*.yml` 和「Latest」都停在上一次外壳发版。

### 网络与子进程环境

- 外网请求一律走 `netFetch`（`proxy.js`）：先代理后直连、回环地址不代理。Node 22.19 的全局 fetch 不认代理。
- 给 dsh 子进程的 PATH 末尾追加运行时的 `.bin` 与写死 node 的 shim，但**用户自己的 pnpm 优先**（见 `orderRuntimePaths`）。store 主版本跟着 pnpm 主版本走（8→v3 / 10→v10 / 11、12→v11），拿错版本去动 profile 会 `ERR_PNPM_UNEXPECTED_STORE`，所以**插件命令**会先按 profile 的 `node_modules/.modules.yaml` 记的 store 挑一次 pnpm（`preferredPnpmDir`/`pickPnpmDir`，挑不出来才回退「系统优先」，并把两边的 store 版本写进日志）。便携兜底那份是 pnpm 11.27.1，版本钉在 `pack-common.mjs` 的 `PNPM_VERSION`，打包时按版本号校验缓存（`vendor/pnpm`）。
- dsh CLI 在参数解析阶段就拒掉保留 profile 名（`desktop`，官方留给自家 Electron 端），两个入口各有一套绕法（`CLI_BLOCKED_PROFILES`）：
  - **启动**：入口换成 `reserved-profile-boot.mjs`（直接调 boot 层，argv 形状与 CLI 一致）。
  - **插件命令**：CLI 只按名字找 profile，所以给原件在同目录建一个目录链接别名（`.dsh-alias-desktop` → `desktop`，`ensureProfileAlias`，Windows 用 junction），命令改指别名 —— 一份目录两个名字，不复制也不漂移。别名以点开头，`listProfiles` 会跳过，界面里只看得到 `desktop`。
  - 两者的理由与边界：真名 `desktop` 永远留给官方桌面端（别去改它的目录内容），启动器只是换入口/换名字去用同一份数据。
- 可选下载源（镜像 / 官方），要传给 dsh 子进程，让它装插件时用同一个源。

## 改代码时容易踩的

- **Node 22.19：注册过 ESM 钩子后 `error.stack` 变成只读**（`writable: false`）。dsh 的 app-boot 会写 `error.stack = ...`，一写就抛 `TypeError`，把原始错误码顶掉。`compat/session-events.mjs` 已把它包进 try/catch，**别去掉**。
- **插件 import 失败会让 dsh 秒退**（插件树的单点故障）。涉及 profile 依赖、补丁层的改动要格外保守，改完用 `plugin-tool.js list` 或真启动一次验证。
- **Windows 的 junction**：pnpm 用 junction 指向 `.pnpm`，目标被删就悬空，读目录会报 `UNKNOWN ... -4094`；还有一类机器根本读不了 junction。两条退路都在 `server.js`（清理悬空链接、让 pnpm 不用链接），清理时要扫进 `@scope` 一层。
- 管理页端口每次启动可能变（被占用会顺延）：旧链接 401、旧标签页里"插件包加载失败"都是正常现象，不用"修"。
- cookie 堆到 16 KB 会让全站 `HTTP 431`：给 cookie 加内容前先算总量。
- 测试输出别接管道（会说第二遍，因为真有人踩）。
- `data/`、`release/`、`vendor/` 里的东西可以随便清（都是产物），但 `release/release-key.pem` 除外。
