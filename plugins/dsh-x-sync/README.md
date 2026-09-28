# dsh-x-sync

把 dsh 的数据同步到 S3 兼容存储 / WebDAV / 本地目录 / 单个 ZIP —— **和 DSH-X 启动器共用同一只桶、同一套目录结构**。

[English](README.en.md) · [DSH-X 启动器](https://github.com/yyh-001/DSH-X)

## 它做什么

- **同步内容**：会话记录、附件、插件配置（当前 profile 的清单与补丁层）、技能、记忆 —— 每类都能单独开关。
- **四种远端**：S3 兼容对象存储（AWS / R2 / MinIO / 阿里 OSS / 腾讯 COS…）、WebDAV（坚果云 / Nextcloud / 群晖 / Alist…）、本地目录（导出 / 导入）、单个 ZIP 文件（导出 / 导入）。
- **两边都合并不覆盖**：只做新增与更新、不传播删除；插件清单双向做**并集合并**（同名依赖取版本号大的），两台机器各装的插件都不会丢，拉下来还会自动把依赖装齐。
- **两种用法**：设置页里一块面板点着用；或者直接跟 agent 说「同步一下」——`sync_status` / `sync_now` 两个工具。

和 DSH-X 启动器**共用同一只桶**：桶里布局是固定的 `dsh-x/v1/…`，所以启动器（dsh 起不来时的最后防线）和这个插件可以交替使用，看到的是同一份数据。

## 安装

**DSH-X 用户不需要手动装**：安装包自带这件插件（仓库里的 `plugins/dsh-x-sync`），启动时由启动器预置进当前 profile —— 设置页 → dsh 分组里的「内置插件」开关控制（默认开，和记忆插件一起）。也可以装 DSH-X 的推荐整合包（`packs/dsh-x-recommended`）：它把记忆与同步一起装进一个独立环境。

手动装（任何 dsh 环境）：拿到本仓库里的 `plugins/dsh-x-sync`（clone 或下载），然后

```sh
dsh plugin --profile web add -w file:D:\path\to\dsh-x-sync --config.auto-install-peers=false
```

装完重启 dsh，设置页里会多一块「同步」。

## 配置

在设置页那块面板里填，或者直接改当前 profile 目录下的 `dsh-x-sync.json`（明文存密钥，和别的插件一个口径；密钥不会进会话日志，工具也**不接受**密钥参数）：

```json
{
  "store": "s3",
  "s3": { "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "my-bucket", "accessKeyId": "…", "secretAccessKey": "…" },
  "scopes": ["sessions", "attachments", "plugins"],
  "policy": "skip"
}
```

`store` 也可以是 `webdav` / `folder` / `zip`，各自一段配置（`webdav` / `folder` / `zip`），互不干扰、切换不用重填。`policy` 决定「两边都有但内容不同」时怎么办：`skip`（保留本机，默认）/ `overwrite`（用远端覆盖）/ `duplicate`（两份都留，另存 `.remote-日期`）。

## 与启动器的分工

| | 插件（这个） | DSH-X 启动器 |
|---|---|---|
| 跑在哪 | dsh 进程里 | 进程外 |
| dsh 起不来时 | 用不了 | **能用**（它是那套代码的用武之地） |
| 触发 | 设置页面板 / agent 工具 | 管理页那块面板 |
| 数据 | 同一只桶、同一套布局、同一套合并语义 | 同左 |

## 开发

```sh
npm test              # 主机侧：配置、工具、对着假 S3 真跑一遍、客户端包注册
npm run sync-engine   # 从 DSH-X 仓库重新拷引擎（默认 ../strategies，可用 DSH_X_REPO 指过去）
```

同步引擎（`lib/engine/`）是从 DSH-X 仓库拷过来的三只零依赖文件，**别在这里改**：改那边、再跑 `npm run sync-engine`。

## 许可

MIT
