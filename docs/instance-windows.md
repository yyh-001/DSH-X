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

标签拖出调用 `transferView(viewId, host, { preservePage: true })`，连停止页也不重新导航。实时拖动另传 `focus: false`，展示目标页面但不切换键盘焦点，以保留源顶栏的鼠标捕获。普通打开方式切换仍按宿主更新本地占位页。快捷方式功能先按启动项 ID 解析或启动实例，再调用统一打开接口；不保存端口或认证 URL。

## 标签拆分与合并

- 鼠标移动 5 CSS px 后开始拖动；进入其他窗口的标签栏即迁移原视图，按住鼠标可继续调整顺序或并入第三个窗口。离开当前标签栏上下 24 CSS px 或窗口左右 24 CSS px 后实时拆出，浮动窗口跟随鼠标；水平滚动到列表首尾不会误拆窗。
- 窗口位置按“鼠标 DIP 坐标 − 抓取偏移”计算，拖动中不夹紧工作区、不跨屏缩放窗口。抓取点来自 pointerdown 的标签内 CSS 坐标，随 `tab-drag.grab` 发送并校验，目标标签宽度变化时保持相对比例，再按目标页面缩放换成 DIP；复用原单标签窗口保留原窗口内抓取点。松手聚焦传 `preserveBounds` 保留用户落点；菜单新开窗口及托盘召回仍使用工作区可见性保护。这借鉴 [Chromium TabDragController](https://chromium.googlesource.com/chromium/src.git/+/4784cc5db44a2699bc25250ed1b786d504da15d7/chrome/browser/ui/views/tabs/dragging/tab_drag_controller.cc) 的偏移定位与显示前布局处理，并非移植其原生 RunMoveLoop。
- 松手确认当前归属；Escape、失焦、失去指针捕获、pointercancel 或页面关闭会取消。撤销恢复源位置及各目标窗口选中状态，同时保留期间新增的标签，不复活已关闭页面。触摸继续排序，拆窗使用菜单。
- `LiveTabDrag` 只持有一次手势的回滚快照和临时宿主引用，不另建页面登记器。普通独立窗口最后一张标签直接复用原窗口跟随鼠标，撤销恢复原窗口位置；多标签或最大化/全屏窗口才另建宿主。源顶栏把 pointer capture 绑定在列表而非会被移除的标签节点上。空源窗口在 Windows/macOS 上透明并退出任务栏，保留捕获到松手后销毁；Linux 的透明度 API 无效，空源外壳仍保留到松手，需平台验收。结束后释放引用并关闭空壳，启动器窗口保留首页。不保存窗口布局。
- 标签操作按钮、右键、Shift+F10 / 菜单键共用原生菜单，可选择新窗口、其他已有窗口或启动器；macOS Window 菜单也可移动活动标签。旧核心在主窗口顶栏右键可移动当前标签。
- 各平台主窗口和独立窗口使用 DSH-X 自绘标题栏与标签栏；最小化、最大化、关闭仍调用原生窗口操作。关闭独立窗口隐藏整组，关闭标签只释放该页面，不停止实例。
- Ctrl/⌘+Tab 向后切换，增加 Shift 向前切换。标签获得键盘焦点后，方向键与 Home/End 移动焦点，Enter/空格激活；Alt+左右键调整顺序。独立窗口只在自己的标签间循环，启动器窗口还包含管理首页。
- Wayland 保留菜单拆分/合并和标签排序，窗口位置交给合成器；Windows/macOS/X11 使用主进程取得的 DIP 落点和显示器工作区，不重复应用 DPI 倍率。跨窗口命中将 DIP 换成目标顶栏的 CSS 坐标；仅在已登记的应用窗口内判断遮挡，外部应用遮挡仍需平台实测。
- 页面状态中的 `detach: { supported, drag, merge, live }` 是能力位；旧外壳不提供时隐藏入口并保留排序。`live` 缺失时沿用松手迁移。`detach-tab` 只传 `id/request/source`，`tab-menu` 只传 `id/request`；外壳验证已登记顶栏的 WebContents、顶层 frame 和页面来源，结果由 `detachResult` 回传。`tab-strip` 上报 CSS 区域，`tab-drag` 的 `active/live/cancel` 开始或结束手势；手势仍只接受原发送方及相同标签 ID，目标窗口由主进程命中，不接受页面传入原生窗口身份。
- 新外壳搭配旧核心时，独立窗口使用外壳内置简化顶栏，支持选择标签与菜单迁移；完整拖动、主题和统一样式依赖新核心的 `tab-window.html` 与共用标签脚本。
- 目标宿主同步创建，不重新加载 DSH 页面或等待 `ready-to-show`；新窗口先等本地顶栏上报标签区域，按真实抓取点定位后才显示。按住期间最多等待 5 秒；尚未定位就松手或取消时立即回挂，不显示未定位窗口。创建、附加、标题或聚焦失败回挂原容器；后台源窗口的 `present` 回执不得抢走新窗口焦点。

## 顶栏反馈与开销

- 拖出提示覆盖在顶栏内，不参与列表布局；合并时直接展示标签，不绘制蓝色插入线或顶栏边缘高亮。标签操作保持固定占位，在活动、悬停、键盘聚焦或触摸时显示；关闭按钮命中区为 24px。
- 排序按显示帧合并 pointermove，松手同步处理最终坐标。仅边缘仍可滚动时连续续帧，静止、首尾、取消或拖出候选状态不保持空转 rAF。标签重排先批量读取位置，再启动动画。
- 主进程仅在实时拖动期间以 16ms 间隔检测落点（旧版松手迁移仍为 40ms），窗口坐标不变不重复 setBounds，提示只发送给状态有变化的源/目标窗口，结束后释放定时器与引用。窗口跟随鼠标不额外做缓动，避免追赶光标；条内排序保留过渡。应用现有的「减少动画」设置与系统偏好都生效，独立窗口通过外壳原有设置读取机制跟随，不增加 HTTP 轮询。
- Windows/macOS 分离窗口使用 140ms 淡入、合并空壳使用 90ms 淡出；复用已显示窗口时从 86% 不透明度轻微恢复，避免闪灭。快速反向拖动接续当前透明度，页面所有权仍立即移交；松手后只等淡出空壳释放，不延迟页面操作。取消、销毁和退出清理动画定时器。「减少动画」、系统减少动态效果或不支持窗口透明度的平台直接应用终态。标签入场只淡入，不缩放抓取区域。
- 单测记录布局读取、待执行帧和提示消息数量。这些验证工作量的变化，不等同于真实设备的 CPU 百分比或帧率测量。

## 验证

`instance-views.test.mjs` 验证迁移、回滚、关闭、重启及 IPC 归属；`instance-window-api.test.mjs` 验证能力检测、身份和新旧协议；`instance-window-ui.test.mjs` 验证 SSE 更新后能力保留、入口禁用与错误回退。原生验收还需检查草稿、滚动、焦点、侧栏 guest、窗口召回和平台关闭行为；假视图测试不能替代这些检查。

`internal-tabs-drag.test.mjs` 执行真实标签脚本，验证手势阈值、取消、排序、菜单和回执；`tab-detach.test.mjs` 验证协议、发送方和坐标规则。`electron scripts/verify-tab-detach.mjs` 用本地页面运行标签脚本 → 预加载 → IPC → 迁移与失败回滚，断言 WebContents、guest、租约、草稿、滚动和历史保留，以及迁移后的 guest 输入和链接回调；数据与结果固定在 `.paseo-local/runtime/tab-detach-native`，不启动 DSH。脚本的合成指针事件不代表系统鼠标跨窗口捕获已验收；真实 DSH、混合 DPI 多屏和各平台菜单/焦点仍需手工检查。

`electron scripts/verify-tab-groups.mjs` 目前仅允许 Windows 运行，导入应用前校验配置、userData、sessionData 与单实例锁隔离；其他平台直接拒绝。它使用真实外壳和本地核心服务，通过顶栏 IPC 与菜单回调验证拆分、合并、移回启动器、空窗口销毁及应用退出，检查页面身份、草稿与滚动。实时拖动使用 Electron 注入鼠标事件并控制测试全局坐标：断言松手前迁移、捕获仍有效、多次转移、重新拆出和 Escape 回滚；这不等同于真实 OS 跨窗口鼠标捕获已验收。还验证原生键盘切换、减少动画设置、拖出时布局稳定，并保存明暗主题在 720/1180px 窗口下的顶栏截图。数据和结果默认位于 `.paseo-local/runtime/tab-groups-native`，`--output-dir` 可指定工作区 `.paseo-local` 下的新证据目录；加 `--drag` 默认改用 `tab-groups-drag` 目录，等待将下方窗口第一张标签拖到上方启动器空标签栏后松手，随后继续检查并退出。该模式需要人工鼠标操作。
