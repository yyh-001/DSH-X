# AGENTS.md

给在这个仓库里干活的 AI 的说明书，人看也欢迎。**动手前先读「硬规矩」与「关键机制」两节。**

## 这是什么

DSH-X：DeepSeek Harness（`dsh`）的第三方启动器。仓库叫 DSH-X，`package.json` 里的名字是更早的 `dsh-versions`。它启动的是 dsh 官方原版 Web 界面，自己不重做 dsh 的页面。

```
原生外壳   launcher/（Rust）        DSH.exe / DSH-X.app：托盘、窗口、开机自启、单实例
Node 服务  start.js → server.js     管理页后端 + 版本 / 插件 / 整合包 / 同步的全部业务
管理界面   public/index.html        单页手写 HTML + 原生 JS，无框架、无构建步骤
注入钩子   compat/  perf/           被注入 dsh 进程，修补运行时行为（见下）
```

**零第三方运行时依赖**：所有 import 都是 `node:` 内置或相对路径，没有构建步骤。安装包自带 Node 运行时（打包时下载到 `vendor/`），所以不依赖用户机器环境。

## 怎么跑、怎么验

| 命令 | 干什么 |
|---|---|
| `npm start` | 起管理页（开发入口） |
| `npm run server` | 只起网页服务，不开浏览器 |
| `npm test` | 全部用例（`node --test`，41 个文件、300+ 用例，约 16 秒） |
| `node --test test/packs.test.mjs` | 单个用例文件 |
| `npm run dist` | 打安装包（Windows 需 Rust + Inno Setup 6；macOS 需 Rust + Xcode CLT） |
| `node scripts/make-pack.mjs` | 把 `packs/<名字>/` 打成 `.dspack`（产物在 `release/packs/`） |

- **跑测试别把输出接管道**（`| head`、`| tail` 会把输出缓冲成 0 字节，等于白跑）；要留证据就重定向到文件。
- 没有 lint / 格式化配置，**也别加**：风格靠已有代码和这份文档。
- 用例里有三只"假服务器"（`test/fake-s3.mjs`、`fake-webdav.mjs`、`fake-proxy.mjs`），网络相关改动靠它们离线验证。

## 硬规矩

- **改完不要自动 commit、不要自动 `npm run dist`、不要发版。** 改动留在工作区，等用户明确指令；用户习惯自己按功能拆提交。
- commit message 用**中文**。
- README 中英成对改（`README.md` + `README.en.md`）；**改 README 默认是"砍"不是"加"**——用户会周期性说"写得太多"。
- Release notes 照 dsh 官方风格：一行一条、分 2–4 块、挂 `@贡献者`；不写根因、验证过程、安装说明。QQ 群公告压到 400 字符内（只写用户看得见的变化，下载只留落地页一条链接），存一份到 `release/群公告-<版本>.txt`。
- 注释写**为什么**（这个仓库的风格：每个不显然的决定都带一段解释，很多是踩坑记录），用中文；不写逐行翻译代码的注释。
- `release/release-key.pem` 是发版签名私钥：不进仓库、别提交、别把内容打印到日志；动相关流程时提醒用户备份。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `start.js` | 入口：端口与日志、被原生外壳拉起时的窗口信号（`__DSH_SHOW__`） |
| `server.js` | 管理页后端 + 全部业务（最大文件）：HTTP 路由、版本管理、插件安装、整合包、启动失败自愈 |
| `settings.js` | 设置读写；`safe*` 一族是校验函数（端口、路径、代理、语言……都从这过） |
| `registry.js` / `version.js` | dsh 版本发现、pnpm 交互（进度解析）、版本号比较 |
| `plugins.js` | 插件开关：直接改 profile 的 `cordis.patch.yml`，不需要 dsh 在跑 |
| `mcp.js` / `skills.js` | MCP server 与技能的读写、探测、开关 |
| `packs.js` | 整合包：`.dspack`（manifest v5 ZIP）的解析 / 检查 / 安装 / 导出 / 回滚 |
| `zip.js` / `zipfile.js` | zip 的写与读（手写，无依赖） |
| `sync.js` | 同步引擎：S3 / WebDAV / 本地目录 / ZIP 四种后端共用一个"远端"抽象 |
| `proxy.js` | `netFetch`：Node 全局 fetch 不看系统代理，所有外网请求走它 |
| `platform.js` | 平台差异集中地（每用户目录、运行时布局、外壳文件名）；**打包脚本必须跟它保持一致** |
| `plugin-tool.js` | 命令行开关插件（dsh 起不来时的救命工具），有可执行位 |
| `stdio-unblock.cjs` | stdout/stderr 阻塞模式修补（`--require` 注入用） |
| `public/` | 管理界面与看板娘素材（`index.html` 是主体） |
| `scripts/` | 打包（`pack.mjs` / `pack-mac.mjs` / `pack-common.mjs` / `dsh-setup.iss`）、图标（`make-icons.py`）、落地页素材、发版清单与 SBOM |
| `plugins/` `packs/` | 内置插件与内置整合包（见「关键机制」，**两个目录别合并**） |
| `compat/` `perf/` | 注入 dsh 进程的钩子：兼容修补与加速 |
| `launcher/` | Rust 外壳（`main.rs`、托盘 / 窗口 / 自更新） |
| `test/` | 用例与假服务器 |
| `docs/` | GitHub Pages 落地页 + 看板娘设计稿（`mascot-design/`） |
| `assets/` | 图标 master（`icon.png` → `make-icons.py` 出全套） |
| `data/` `release/` `vendor/` | 运行时数据与产物，gitignored，可重建，**不用整理** |

**顶层 .js 平铺是有意的，不是没整理**：安装目录也是平铺的——`scripts/pack-common.mjs` 的 `APP_FILES` 按名字把文件原样拷到安装根，`launcher/main.rs` 也在根上找 `start.js`。要把它们收进 `src/` 得同时改四处（`APP_FILES` 与拷贝目标、`platform.js`/`server.js` 的根路径推导、Rust 的查找路径、`dsh-setup.iss`）并重新打包验证，别只挪文件。

## 关键机制

### 版本、实例与数据

- 每个 dsh 版本装在数据目录（默认 `%APPDATA%\DSH\data`，设置里可改）的 `versions/<版本>/`。
- **一个「版本 × profile」一个实例**，可以同时跑，各占各的端口：默认给会起 web 的 profile 传 `--port 0`，由系统现挑，启动器再从 dsh 打印的地址里读回真实端口。
- 端口也能手工钉死（控制页那个「端口」输入框 → `settings.json` 的 `instancePorts`，键 `版本@profile`）：钉了就传 `--port <它>`，链接每次启动都一样（书签、手机上的地址才留得住）。钉住的组合起不来时（`EADDRINUSE`）报错要点名端口和占用者。**这是 dsh 实例的端口，跟管理页端口（`port`）是两回事，两者不能撞。**
- dsh 本体数据在 `DSH_HOME`（默认 `~/.dsh`，可配），跨版本共享，所以换版本不用重装插件。
- 启动器自己的设置与日志在 `%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`）。

### profile

dsh 的环境隔离单位。模板名（web / headless / acp / sdk / …）会自动初始化，自定义名必须先有 `package.json`，否则 dsh 拒绝启动。插件按 profile 分，会话与记忆共享。启动器提供切换与开关；插件开关就是往 `cordis.patch.yml` 写 `- id: <行> / disabled: true`，删掉该块即恢复。

### 内置插件与内置整合包（两个目录，别合并）

- `plugins/<包名>/` 是**插件实现**（npm 包：`dsh-x-memory`、`dsh-x-sync`）。启动器首次启动把它们复制到 `$DSH_HOME/bundled/<包名>/`，再以 `file:` 依赖装进 profile（`BUNDLED_PLUGINS` 常量 + `ensureBundledPlugin`）。复制到 DSH_HOME 而不是直接指向安装目录，是为了卸载启动器后依赖不断链。
- `packs/dsh-x-recommended/` 是**整合包配方**（`manifest.json` + `dspack.json` + README），**不含代码**；依赖里 `"dsh-x-memory": "bundled"` 会被解析成 `file:$DSH_HOME/bundled/dsh-x-memory`。
- 为什么不能合并：`.dspack` 只认 `overrides/`、`home/`、`profiles/` 与几个根文件，插件源码放进去会被当"不属于整合包"跳过（`packs.js` 的解析）；反过来 `plugins/` 下每个子目录都被当成一个 npm 包。实现只存一份，配方用引用指过来。
- 改了内置插件的代码：**版本号必须跟着变**（复制逻辑按版本判断），而且要重新打包才会更新到用户机器上。

### 注入进 dsh 的钩子（compat / perf）

- `compat/register.mjs`、`perf/register.mjs` 由启动器注入；worker 线程注入的是 `compat/worker-events.cjs`（worker 的 execArgv 是空的，只能靠 NODE_OPTIONS）。
- NODE_OPTIONS 里**只写裸文件名**，目录靠 NODE_PATH 传——NODE_OPTIONS 按空格分词，安装目录带空格会被拆坏。
- dsh 自己的 Node 开关（系统证书库、请求头上限、两个 ESM 补丁钩子）走**命令行参数**，不塞 NODE_OPTIONS：后者会被 dsh 的所有子进程继承，agent 在 shell 里跑的 node 可能是老版本。
- 改会话事件词汇表（`SESSION_TYPES`）要**两处同步**：主线程的 `compat/session-events.mjs` 与 worker 的 `compat/worker-events.cjs` 各有一份副本。

### 打包与安装布局

- `APP_FILES`（`scripts/pack-common.mjs`）= 安装目录里的启动器源码清单；`copyAppFiles` 把它们平铺拷到安装根（macOS 是 `DSH-X.app/Contents/Resources/app/`）。
- 安装目录里还有 `node/`（自带运行时）、`public/`、`assets/`、`compat/`、`perf/`、`plugins/`、`packs/`、`lang.txt`（安装语言）。
- Rust 外壳由 `cargo build` 出 `DSH.exe`，图标走 `build.rs`；Windows 安装包由 Inno Setup（`scripts/dsh-setup.iss`）打。
- 自更新：下载 `DSH-Setup.exe` → 静默安装 → 由安装程序拉起新版。改这条链路时，父进程必须**等安装程序真的起来再退**，否则复刻流程会误判成"更新坏了"。
- 发版产物要一起传：Windows 的 `DSH-Setup.exe` 和 mac 的 dmg（**不传 dmg，mac 的自更新就取不到包**）；清单、签名、SBOM 见 README 的「打包」一节。

### 网络与子进程环境

- 外网请求一律走 `netFetch`（`proxy.js`）：先代理后直连、回环地址不代理。Node 22.19 的全局 fetch 不认代理。
- 给 dsh 子进程的 PATH 末尾追加运行时的 `.bin` 与写死 node 的 shim，但**用户自己的 pnpm 优先**（见 `orderRuntimePaths`：pnpm 主版本不同会导致 store 错配 `ERR_PNPM_UNEXPECTED_STORE`）。
- 可选下载源（镜像 / 官方），要传给 dsh 子进程，让它装插件时用同一个源。

## 改代码时容易踩的

- **Node 22.19：注册过 ESM 钩子后 `error.stack` 变成只读**（`writable: false`）。dsh 的 app-boot 会写 `error.stack = ...`，一写就抛 `TypeError`，把原始错误码顶掉。`compat/session-events.mjs` 已把它包进 try/catch，**别去掉**。
- **插件 import 失败会让 dsh 秒退**（插件树的单点故障）。涉及 profile 依赖、补丁层的改动要格外保守，改完用 `plugin-tool.js list` 或真启动一次验证。
- **Windows 的 junction**：pnpm 用 junction 指向 `.pnpm`，目标被删就悬空，读目录会报 `UNKNOWN ... -4094`；还有一类机器根本读不了 junction。两条退路都在 `server.js`（清理悬空链接、让 pnpm 不用链接），清理时要扫进 `@scope` 一层。
- 管理页端口每次启动可能变（被占用会顺延）：旧链接 401、旧标签页里"插件包加载失败"都是正常现象，不用"修"。
- cookie 堆到 16 KB 会让全站 `HTTP 431`：给 cookie 加内容前先算总量。
- 测试输出别接管道（会说第二遍，因为真有人踩）。
- `data/`、`release/`、`vendor/` 里的东西可以随便清（都是产物），但 `release/release-key.pem` 除外。
