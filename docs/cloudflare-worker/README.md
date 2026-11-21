# DSH-X Cloudflare Tunnel Dispatcher Worker 部署指南

本目录提供开源、零依赖的 Cloudflare Worker 模板（[`worker.js`](./worker.js)），用于为 DSH-X 公网穿透（Worker 模式）按设备自动分配固定 HTTPS 子域名（`https://dshx-<shortId>.<BASE_DOMAIN>`）。

> 架构与国内网络适配思路参考自 [GHSaiMo/antigravity-mobile](https://github.com/GHSaiMo/antigravity-mobile)（MIT License）。

## 工作原理

- Worker **仅负责注册与编排**：当 DSH-X 首次开启隧道（或本地远程网关端口变更）时，按本机稳定的 `machine_id` 幂等创建专属 Tunnel、同步 Ingress 到 `http://127.0.0.1:<target_port>`，并写入 Cloudflare Proxied CNAME 记录。
- **不经过 Worker 中转业务流量**：建连完成后，所有网页与 WebSocket 通信直接走 `本机 cloudflared ↔ Cloudflare 边缘节点 ↔ 手机`，免费额度即可长期稳定使用。

## 准备条件

1. 一个免费的 [Cloudflare](https://dash.cloudflare.com/) 账号。
2. 一个已托管在 Cloudflare DNS 的域名（例如 `example.com` 或子域 `tunnel.example.com`）。

## 第一步：创建最小权限 API Token

进入 Cloudflare Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**：

- **Account → Cloudflare Tunnel → Edit**（选择你的账号）
- **Zone → DNS → Edit**（仅限承载 `BASE_DOMAIN` 的域名 Zone）

创建后复制生成的 Token，以及域名首页右侧栏里的 **Account ID** 与 **Zone ID**。

## 第二步：部署 Worker

### 方式 A：网页控制台直接部署（最简单）

1. 在 Cloudflare Dashboard 打开 **Workers & Pages → Create → Create Worker**。
2. 将本目录的 [`worker.js`](./worker.js) 完整粘贴进代码编辑器并点击 **Deploy**。
3. 进入该 Worker 的 **Settings → Variables and Secrets**，配置环境变量（见下表）。

### 方式 B：使用 Wrangler CLI

在本地目录准备 `wrangler.toml`：

```toml
name = "dsh-x-tunnel-dispatcher"
main = "worker.js"
compatibility_date = "2025-01-01"

[vars]
BASE_DOMAIN = "tunnel.example.com"
TARGET_PORT = "3781"
```

写入敏感密钥并部署：

```bash
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_ZONE_ID
wrangler secret put CF_API_TOKEN
wrangler secret put INVITE_CODE
wrangler deploy
```

## 环境变量说明

| 变量名 | 必填 | 类型建议 | 说明 |
| --- | --- | --- | --- |
| `CF_ACCOUNT_ID` | 是 | Secret | Cloudflare Account ID |
| `CF_ZONE_ID` | 是 | Secret | `BASE_DOMAIN` 所属的 Zone ID |
| `CF_API_TOKEN` | 是 | Secret | 拥有 Tunnel Edit + DNS Edit 权限的 API Token |
| `BASE_DOMAIN` | 是 | Plaintext | 分配子域名的基础域名（如 `tunnel.example.com`，最终生成 `dshx-xxxxxxxxxx.tunnel.example.com`） |
| `INVITE_CODE` | 推荐 | Secret | 共享邀请码；强烈建议设置，防止他人盗用你的域名创建隧道 |
| `TARGET_PORT` | 否 | Plaintext | 默认本地网关端口（未传时默认 `3781`） |
| `LOCK_TARGET_PORT` | 否 | Plaintext | 设为 `"true"` 时锁定使用 `TARGET_PORT`，忽略客户端动态上报的 `target_port` |

## 第三步：在 DSH-X 中启用

1. 若 `*.workers.dev` 在国内被干扰，建议给该 Worker 绑定一个自定义路由域名（如 `dispatch.example.com`）。
2. 在 DSH-X 设置页开启公网穿透，选择 **Worker 模式**，填入 Worker 地址（如 `https://dispatch.example.com`）与 `INVITE_CODE`。
3. 首次启动会自动下载 `cloudflared`、注册隧道并将凭证缓存在 `<APP_DIR>/cf-tunnel.json`（权限 `0600`），此后重启直接复用同一固定域名。

## 接口速览

- `GET /health`：健康检查，返回 `{ "ok": true, "service": "dsh-x-tunnel-dispatcher" }`。
- `POST /api/tunnel/register`：
  - 请求头：`X-Invite-Code: <INVITE_CODE>`（如已配置）
  - 请求体：`{ "machine_id": "<64位hex>", "platform": "win32", "invite_code": "...", "target_port": 3781 }`
  - 响应：`{ "tunnel_id", "token", "subdomain", "hostname", "public_url", "target_port" }`
