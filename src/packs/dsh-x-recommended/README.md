# DSH-X 推荐实例

DSH-X 挑出来的一套开箱可用插件。导入后是一个**实例**（装好这四件插件的 DSH），在启动项里选它、再选一个配置就能启动。

## 里面有什么

| 插件 | 干什么 | 为什么选它 |
|---|---|---|
| [`dsh-config-manager`](https://github.com/xiajiajun516/dsh-config-manager) | 配置的备份 / 恢复 / 导出 / 导入 / 迁移 / 多机同步：设置、插件清单、MCP server、技能、Agent 预设、工作区，凭据可选且加密；通道支持 S3 兼容存储、WebDAV、私有 git 仓库、本地 ZIP | 这类插件里覆盖最全、维护最活跃（月下载一万多），有独立的设置页入口 |
| [`dsh-x-memory`](https://www.npmjs.com/package/dsh-x-memory) | 文件式长期记忆：一条事实一个 Markdown 文件 + `MEMORY.md` 索引，按工作区分开存放，会话开始时把索引注入上下文；模型用六个 `memory_*` 工具读写，设置页里能直接看、改、删 | DSH-X 自己的那件；文件就是记忆本体，随时可看可改可进 git |
| [`dsh-x-sync`](https://www.npmjs.com/package/dsh-x-sync) | 会话、附件、插件配置、技能、记忆同步到 S3 兼容存储 / WebDAV / 本地目录 / 单个 ZIP：与 DSH-X 启动器共用同一只桶、同一套目录结构，双向并集合并、不丢插件 | DSH-X 自己的那件；插件跑在 dsh 里管日常，dsh 起不来时用启动器那条路，两边同一只桶 |
| [`dsh-x-aquarium`](https://www.npmjs.com/package/dsh-x-aquarium) | dsh 网页里的水面与看板娘：一块纯装饰的固定背景层（WebGL 水面 + 漂浮的看板娘），深浅色自适应，不碰任何界面功能 | DSH-X 自己的那件；纯装饰、`pointer-events: none` 不挡操作，不想要就在插件页关掉 |

> 一句话：四件合起来就是「界面好看、记忆在本地、同步到远端、配置可迁移」。**四件都从 npm 装**，装完在插件页能看到远程版本、随时更新。

## 怎么导入

实例页里列着它（内置，点开导入）。别的来源三选一：

1. **本地文件**：在实例页点「导入…」选 `.dspack`。
2. **直链**：填这个包的下载地址。
3. **GitHub 仓库**：填 `owner/repo`（取最新 Release 里的 `.dspack`）；DSH-X 仓库的 Release 里也带一份。

导入前会列出要用的 DSH 版本和插件，确认了才动手；包里的配置默认不导。

## 想往里加插件

改 `manifest.json` 两个地方就行：`dependencies` 加一行「包名 → 版本」，`bundles` 加一行包名（`bundles` 决定 dsh 会不会加载它——包自身必须声明 `dsh.bundle`，否则 dsh 起不来）。版本钉 `^x.y.z`，别写 `latest`。

## 自己打包

```sh
node scripts/make-pack.mjs packs/dsh-x-recommended     # 产出 release/packs/<name>-<version>.dspack
```
