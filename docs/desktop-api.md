# 插件桌面 API（`/api/desktop`）

DSH-X 的 Electron 外壳把几个桌面能力借给 dsh 插件：系统原生通知、系统对话框、剪贴板、
打开链接、在文件管理器中定位文件。

插件跑在 dsh 子进程里，拿不到 Electron；所以链路是：

```
插件（dsh 子进程） --本机 HTTP--> 管理服务（server.js） --函数调用--> 外壳（host.desktop） --> Electron
```

只有**由 DSH-X 启动**的 dsh 实例才有这条路。用户自己 `dsh` 起来的环境里没有这些环境变量，
插件应当静默降级。

## 发现能力

`dshEnv()` 会给每个 dsh 子进程注入：

| 变量 | 含义 |
|---|---|
| `DSH_X_MANAGER_URL` | 管理页根地址，如 `http://127.0.0.1:3780`。端口每次启动可能顺延，**别硬编码 3780** |
| `DSH_X_DESKTOP` | 只有真外壳接上桌面能力时才是 `'1'`；浏览器模式、旧外壳没有这个变量 |

也可以直接问接口（`available: false` 时不要重试）：

```http
GET /api/desktop
```

```json
{
  "api": 1,
  "available": true,
  "platform": "win32",
  "capabilities": ["notify", "open", "reveal", "clipboard", "dialog", "computer"],
  "notifications": { "enabled": true, "sound": true },
  "computer": { "available": true, "enabled": false, "halted": false, "running": false },
  "theme": "dark",
  "versions": { "core": "0.1.22", "shell": "0.1.22", "electron": "44.7.0" }
}
```

`notifications.enabled` 就是设置页的「任务通知」开关。关掉时通知接口仍会回 200，但
`shown: false, reason: "disabled"`——插件可以退回页面内提示。

## 接口

所有动作都是 `POST`，JSON 正文；响应统一带 `ok: true`。本机进程调用即可，不需要鉴权头。

### 通知

```http
POST /api/desktop/notify
{ "title": "同步完成", "body": "3 个会话已上传", "url": "http://127.0.0.1:9716/#/settings", "silent": false }
```

```json
{ "ok": true, "shown": true }
{ "ok": true, "shown": false, "reason": "disabled" }
{ "ok": true, "shown": false, "reason": "throttled" }
{ "ok": true, "shown": false, "reason": "unsupported" }
```

- `title` 最多 120 字、`body` 最多 800 字；两个都空返回 400。
- `url` 只认 `http(s)`，点击通知时按外壳的打开方式处理：指向正在运行的 dsh 实例的地址进
  内部标签页 / 独立窗口，其他本机地址和外部地址交给系统浏览器。不传则点击回到管理页。
- `silent: true` 只是把这条通知关小声；用户关掉「通知声音」时插件不能把它打开。
- 500ms 内重复请求会被节流（`reason: "throttled"`），别拿通知当日志。

### 打开链接

```http
POST /api/desktop/open
{ "url": "https://example.com/docs" }
```

本机地址（`127.0.0.1` / `localhost` / `[::1]`）里，属于正在运行的 dsh 实例的按设置进标签页或
独立窗口；其余（包括其他本机服务）和外部地址一样交给系统浏览器。`file:`、`javascript:`、
`data:` 一律 400。

### 在文件管理器中显示

```http
POST /api/desktop/reveal
{ "path": "C:\\Users\\me\\Downloads\\dsh-backup.zip" }
```

路径必须是绝对路径且真实存在（否则 400）；只定位，不打开。

### 剪贴板

```http
POST /api/desktop/clipboard
{ "text": "要复制的内容" }
```

最多 100000 个字符；`text` 必须是字符串（空串可以，用来清空）。

### 系统对话框

一条路由，用 `kind` 区分：

```http
POST /api/desktop/dialog
{ "kind": "open", "title": "选择备份", "multiple": true,
  "filters": [{ "name": "ZIP", "extensions": ["zip"] }] }
```

```json
{ "ok": true, "canceled": false, "paths": ["C:\\backup.zip"] }
```

```http
{ "kind": "save", "title": "导出到", "defaultPath": "dsh-backup.zip",
  "filters": [{ "name": "ZIP", "extensions": ["zip"] }] }
```

```json
{ "ok": true, "canceled": false, "path": "C:\\Users\\me\\dsh-backup.zip" }
```

```http
{ "kind": "message", "type": "question", "message": "现在同步吗？",
  "detail": "会覆盖远端较旧的记录。", "buttons": ["同步", "取消"], "defaultId": 0, "cancelId": 1 }
```

```json
{ "ok": true, "response": 0 }
```

- `open`：`directory: true` 选目录；`multiple: true` 多选（目录多选需要系统支持）。
  `filters` 的扩展名带不带点都行（会归一化），每个最多 10 项、总共 8 组。
- `save`：`defaultPath` 可以只是个文件名。
- `message`：`type` 是 `info` / `warning` / `error` / `question` / `none`；按钮最多 4 个、
  每个最多 40 字；`defaultId` / `cancelId` 越界时回落到第一个 / 最后一个按钮。
- 对话框要等用户操作，客户端别设太短的超时。管理页窗口不可见时对话框不挂父窗口。

### 电脑操作（Computer Use）

由外壳持有桌面操作权限、急停开关与审计日志（默认关闭；只有 `capabilities` 含 `computer` 且 `computer.enabled === true` 时才可用）：

```http
POST /api/desktop/computer
{ "op": "rpc", "sessionId": "0.2.2-rc.4@web:agent-1", "id": "req-1", "method": "listApps", "params": {}, "instance": "0.2.2-rc.4@web" }
```

- `op`: `status` / `rpc` / `cancel` / `closeSession`。
- 外壳未开启电脑操作或用户触发急停时，`rpc` 返回 `{ "ok": true, "error": { "code": "COMPUTER_USE_DISABLED" | "COMPUTER_USE_STOPPED", "message": "..." } }`。
- 审计日志只记录时间、实例、应用、动作类型与结果，绝不记录输入的正文。

## 错误与降级

| 状态 | 什么时候 |
|---|---|
| 400 | 正文校验失败（空通知、非 http(s) 地址、相对路径、超长内容……），`error` 是中文原因 |
| 404 | 没有这个能力（`/api/desktop/xxx`） |
| 405 | 方法不对（动作只收 POST） |
| 503 | 当前不是 DSH-X 桌面外壳（浏览器模式 / 旧外壳），带 `available: false` |
| 500 | 外壳执行失败（例如系统对话框起不来），`error` 带原因 |

建议的调用姿势：

```js
const base = process.env.DSH_X_MANAGER_URL || ''
export const desktop = process.env.DSH_X_DESKTOP === '1' && base ? { base } : null

export async function desktopNotify(payload) {
  if (!desktop) return { ok: false, shown: false, reason: 'no-desktop' }
  try {
    const res = await fetch(`${desktop.base}/api/desktop/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    return await res.json()
  } catch {
    return { ok: false, shown: false, reason: 'unreachable' }
  }
}
```

浏览器面板（插件注入进 dsh 页面的那部分）不在这条链路上：面板里直接用浏览器
`Notification` API 即可，外壳已按「任务通知」开关放行本机页面的通知权限。

## 兼容与安全

- `api: 1` 是协议版本；以后加能力会先出现在 `capabilities` 里。
- 这是**外壳 + 核心**两层的功能：旧外壳没有 `host.desktop`（503），旧核心没有这些路由
  （404）。两层都更新后插件才能用。
- 接口只监听回环地址，改状态的请求还要求本机来源（跨站 `Origin` 一律 403），
  信任模型和其余管理接口一致：**本机进程可信**，网页不可信。
