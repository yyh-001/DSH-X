# 实例页面与窗口

一个受管理实例默认对应一个页面；页面可以由主窗口标签或独立窗口承载。关闭独立窗口只隐藏，停止实例仍由核心负责。改变打开设置不自动搬动现有页面；用户再次点普通「打开」时遵循当前设置，必要时迁移原视图。下拉「在新窗口打开」只影响这次打开，不改变下次普通打开的方式。

## 核心与外壳

- `setHost({ presentInstance(target, { presentation, explicit }), onStateChanged })` 是可选能力。`presentation` 为 `internal` 或 `window`；`explicit` 表示允许迁移现有页面，核心的普通打开和指定开窗均传 true，单纯聚焦已有宿主另用 `focusInstance()`。`onStateChanged()` 让外壳立即重读 `trayStateText()`，避免短暂的 stopping 被轮询漏掉。
- `target` 沿用 `internalTabTarget()` 的 `id/title/url/status/managed`，附加 `home/profile/version/homeName` 供等待页和标题使用。URL 可能带认证信息，只在内存中传递，不用于持久身份、标题或日志。
- 本地页面身份是 `[home, version, profile]`；WSL 延续 `[合成 home, "", profile]`。托盘 `instanceId` 是操作校验键，`viewId` 才是页面身份。不要互换。
- `POST /api/open` 接受 `{ url, presentation?: "window" }`；显式请求失败返回 400，不自动打开浏览器。等待页仅识别当前管理服务的 `/booting`，运行目标从实例列表解析。
- `/api/settings.instanceWindows` 是只读能力位。旧外壳缺少新 hook 时继续 `openTab(target)` / `openWindow(url)`；旧核心传 URL 时，外壳仅从可信等待页或当前实例认领身份。

## 页面生命周期和迁移

`InstanceViews` 持有页面记录和 WebContents；`BrowserTabs`、`InstanceWindow` 负责容器、布局与焦点。

```js
const record = views.presentInstance(target, { presentation: 'internal' })
views.presentInstance(target, { presentation: 'window', explicit: true })
views.transferView(record.viewId, destinationHost, { index: 0, activate: true })
views.focusInstance(target.id)
views.disposeView(record.viewId)
```

宿主接口为 `attach(record, options)`、`detach(record)`、`reveal(record)`、`changed(record)`，以及可选 `disposeEmpty()`。`detach` 返回回滚所需的原位置和选中状态，不关闭 WebContents。迁移同步完成；附加失败回挂源容器，不重新加载页面。

标签关闭先标记 retired，替代页面呈现后由登记器释放。迁移不能进入 retired 队列；呈现序号和页面 epoch 使旧回执、异步采色失效。所有页面事件按 viewId 查当前宿主，guest 的 owner 始终是原 WebContents。宿主迁空只释放空窗口。

后续标签拖出功能调用 `transferView`，只需处理拖拽命中、目的宿主和插入位置。快捷方式功能先按启动项 ID 解析或启动实例，再调用统一打开接口；不保存端口或认证 URL。

## 验证

`instance-views.test.mjs` 验证迁移、回滚、关闭、重启及 IPC 归属；`instance-window-api.test.mjs` 验证能力检测、身份和新旧协议；`instance-window-ui.test.mjs` 验证 SSE 更新后能力保留、入口禁用与错误回退。原生验收还需检查草稿、滚动、焦点、侧栏 guest、窗口召回和平台关闭行为；假视图测试不能替代这些检查。
