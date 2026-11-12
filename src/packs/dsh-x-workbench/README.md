# DSH-X 桌面工作台

DSH-X 的第二套整合包：**把 [dsh-tauri 桌面版](https://github.com/dsh-tauri/deepseek-harness-desktop) 最常用的几项能力，在纯 dsh 生态里凑齐；再把 [ZCode](https://github.com/zai-org/ZCode) 的两份通用技能带过来。** 装它 = 得到一个独立 profile（默认名 `workbench`），和现有环境互不打扰。

> 为什么不是直接装 dsh-tauri 的插件：dsh-tauri 的 12 个内置插件都声明了 `external: ["dsh-tauri/client"]`，依赖 Tauri 宿主桥，在纯 dsh（包括 DSH-X 的 Electron 壳）里加载不到模块。所以这里选的是生态里同能力的独立插件，不是移植。

## 里面有什么

### 插件（装进 `workbench`，可在插件页单独开关）

| 插件 | 干什么 | 对应 dsh-tauri 的 |
|---|---|---|
| [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) | 右侧栏完整工作台：懒加载文件树（Git 状态着色、目录监听、全局搜索、拖拽上传）、CodeMirror 编辑器、终端、Source Control（暂存/提交/提交图）、本会话 AI 改动透镜、子代理 | 可选预设 DSH Better Sidebar |
| [`@cerbur/clutch-dsh-worktree`](https://github.com/Cerbur/clutch-dsh) | 按 Workspace → Worktree → Session 分组的 Git 工作树视图；工作树关系存 Host 自有文件，不改 dsh 的会话元数据 | `dsh-tauri-worktree` |
| [`dsh-plugin-cron-scheduler`](https://github.com/LittleBlackTong/dsh-plugin-cron) | 定时任务：cron 表达式或侧栏表单建任务，到点向新建/固定会话注入一条 user 消息触发完整 agent 轮次；有执行历史、手动运行、并发与错过不补跑保护 | `dsh-tauri-scheduler` |
| [`dsh-archived-conversations`](https://github.com/AKS1st/dsh-archived-conversations) | 设置页里的「已归档对话」列表与只读预览（最近 6 条消息）。dsh 目前没有取消归档 API，所以只读、不恢复 | `dsh-tauri-archive` |
| [`dsh-plugin-notify-sounds`](https://github.com/BillCx330/dsh-plugin-notify-sounds) | 需要你决策或任务完成时的提示音 + 系统通知（点通知跳回窗口），任务栏标题标记「等待你 / 已完成」，看过就安静 | `dsh-tauri-notification` |

### 技能（写到 `~/.dsh/skills`，所有 profile 共用）

| 技能 | 干什么 | 来源 |
|---|---|---|
| `agent-browser` | 浏览器自动化 CLI：导航、填表、点击、截图、抓数据、测 Web 应用；模型按 `agent-browser` 命令驱动 | ZCode 收录自 vercel-labs/agent-browser（Apache-2.0） |
| `electron` | 通过 Chrome DevTools Protocol 驱动 Electron 应用（VS Code、Slack 等）；对 DSH-X 自己的 Electron 壳同样适用 | 同上（ZCode 的 `electron` 技能） |

`agent-browser` / `electron` 需要本机有 CLI：`npm i -g agent-browser`、`brew install agent-browser` 或 `cargo install agent-browser`，也可以直接 `npx agent-browser`。技能目录里附了完整参考文档和脚本模板，模型按需读，不会一次性灌进上下文。

## 和「DSH-X 推荐整合包」的区别

- 推荐包管的是**环境**：配置备份/迁移、记忆、同步、装饰。
- 这个包管的是**干活**：编辑与 Git、工作树、定时任务、归档、通知，外加浏览器/Electron 自动化技能。
- 两者装到不同 profile 可以并存；技能同名时后装的覆盖先装的（安装前会备份）。

## 怎么装

三种方式，任选：

1. **本地文件**：把 `.dspack` 拖进插件页的「整合包」区（或点安装选文件）。
2. **直链**：填这个包的下载地址。
3. **GitHub 仓库**：填 `owner/repo`（取最新 Release 里的 `.dspack`）。

装之前会把「要装什么、要改哪些文件、什么不会装」列给你看，确认了才动手；装失败自动回滚。装完在插件页切到 `workbench`、重启 dsh 生效；技能在「技能」页能看到，改完不用重启。

## 需要什么

- dsh `>= 0.2.1-rc.1 < 0.3.0`（`dsh-better-sidebar` 从这个版本起支持）。
- Windows / macOS / Linux；`better-sidebar` 的终端用 dsh 自带的能力，不需要额外 shell 配置。
- 浏览器/Electron 自动化要另装 `agent-browser` CLI，Electron 应用启动时要带 `--remote-debugging-port`。
- 定时任务按 dsh 进程存活计时：进程关着的时间段不补跑。

## 许可与出处

- 整合包本身 MIT。
- `agent-browser`、`electron` 技能：Copyright 2025 Vercel Inc.，Apache-2.0；本副本取自 zai-org/ZCode（Apache-2.0，commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`）。DSH-X 原样收录未修改，每个技能目录里附了 `NOTICE.md` 与许可全文。
- 五个插件各自许可见对应 npm 包。

## 自己打包

```sh
node scripts/make-pack.mjs packs/dsh-x-workbench     # 产出 release/packs/dsh-x-workbench-1.0.0.dspack
```
