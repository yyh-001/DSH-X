# 实例页面与窗口

一个受管理实例默认对应一个页面，由主窗口标签或独立窗口承载。关闭独立窗口只隐藏，停止实例仍由核心负责。改变打开设置不自动搬动现有页面；再次普通打开遵循当前设置，必要时迁移原视图。「在新窗口打开」只影响这次打开。

## 核心与外壳

- `setHost({ presentInstance(target, { presentation, explicit }), onStateChanged })` 是可选能力。`presentation` 为 `internal` 或 `window`；核心普通打开和指定开窗均传 `explicit: true`，单纯聚焦另用 `focusInstance()`。`onStateChanged()` 让外壳立即重读 `trayStateText()`。
- `target` 沿用 `internalTabTarget()` 的 `id/title/url/status/managed`，附加 `home/profile/version/homeName`。URL 可能带认证信息，只在内存中传递，不用于持久身份、标题或日志。
- 本地实例身份是 `[home, version, profile]`；WSL 延续 `[合成 home, "", profile]`。托盘 `instanceId` 是操作校验键，`viewId` 才是页面身份。
- `POST /api/open` 接受 `{ url, presentation?: "window" }`；显式请求失败返回 400。等待页仅识别当前管理服务的 `/booting`，运行目标从实例列表解析。
- `/api/settings.instanceWindows` 是只读能力位。旧外壳继续 `openTab(target)` / `openWindow(url)`；旧核心传 URL 时，外壳仅从可信等待页或当前实例认领身份。

## 页面生命周期和迁移

`InstanceViews` 是唯一页面登记器；`BrowserTabs`、`InstanceWindow` 负责容器、布局与焦点。`transferView(viewId, destinationHost, { index, preservePage: true })` 同步迁移原 WebContentsView。宿主 `detach` 返回回滚所需的原位置和选中状态，不关闭 WebContents；附加失败回挂源容器，不重新加载页面。

标签关闭先标记 retired，替代页面呈现后由登记器释放。迁移不能进入 retired 队列；呈现序号和页面 epoch 使旧回执、异步采色失效。页面事件按 viewId 查当前宿主，guest 的 owner 始终是原 WebContents。拖动保留停止页原样，普通打开方式切换仍按宿主更新本地占位页。快捷方式先按启动项 ID 解析或启动实例，再调用统一打开接口，不保存端口或认证 URL。

## 标签拆分与合并

- 鼠标移动 5 CSS px 后开始拖动。门槛前由原按钮捕获，保留普通单击选择；开始拖动才交给稳定列表，捕获交接不取消手势，取消后的迟到 click 不再激活标签。同窗排序保留让位动画；其他窗口标签栏显示插入标记，离开源标签栏上下或窗口左右 24 CSS px 显示标题预览。上下回到栏边8px内、左右回到视口内才退出拆窗候选，提示与主进程按同一采样和迟滞契约判定。源页面和窗口保持原位，真正 pointerup 时只提交最终落点一次。
- Windows/macOS/X11 使用无修饰键拖出与回并。Linux Wayland 桌面有 `DISPLAY` 且未显式选择 Ozone 后端时，默认请求 XWayland；实际以 X11 后端就绪后才开放跨窗拖动，不因桌面会话为 Wayland 而禁用。Linux 迁移需要带有原生视图重挂载修复的 Electron 44.7.1，44.7.0 可能状态已迁移但内容未显示。新版顶栏按显示帧发送源页面局部坐标，主进程根据源窗口内容原点及页面缩放换成 DIP，再做受管窗口命中。
- 普通独立窗口的唯一标签拖到桌面时复用原窗口，松手才按原抓取偏移改变位置；多标签、最大化或全屏窗口在松手时创建目标宿主。新窗口按显示器工作区保护可见性，不等待目标顶栏完成布局。
- Escape、blur、pointercancel、失去捕获与页面关闭取消手势。取消不需要反向迁移。主进程在 hide/minimize/close/closed、顶栏导航/崩溃/销毁和退出时使事务失效，并请求顶栏释放 pointer capture；顶栏另监听 visibilitychange，show 时再次清理隐藏期间的捕获。原生 hide→show 后能否重新拖动必须单独验收，不能由令牌清零推断。
- 被拖页面的内容 renderer 退出时先取消该页手势，再按原策略恢复崩溃页；其他页的退出回调不直接取消当前页会话，但恢复若造成顶栏真实失焦，仍安全取消，用户需重新拖动。正常迁移不重新导航；崩溃恢复本身会重载，不承诺崩溃前草稿保持。
- `TabDragSession` 仅保存一次手势的源宿主、record、epoch 与一次性 token；唯一登记仍在 `InstanceViews`。提交前检查归属、关闭状态、overlay 与目标可用性，失败沿用登记器回挂原 WCV/guest。结束释放 dragHold，移空的独立窗口关闭，启动器保留首页。没有透明捕获空壳或持久窗口布局。
- 标签按钮、右键、Shift+F10/菜单键共用原生菜单，可移到新窗口、其他窗口或启动器；Window 菜单按焦点宿主分派。关闭独立窗口隐藏整组，quitting 才真正释放页面；关闭单个标签不停止实例。
- Ctrl/⌘+Tab 和 Ctrl/⌘+Shift+Tab 在当前宿主内循环。标签焦点支持方向键、Home/End、Enter/空格和 Alt+左右键排序；触摸继续排序，拆分使用菜单。
- 能力位 `detach: { supported, drag, merge, deferred }` 控制单次提交路径。`tab-drag` 开始/结束，`tab-drag-move` 传有限局部坐标，结束消息可带唯一 id 顺序及 request。外壳核验受管顶栏 WebContents、顶层 frame、页面来源与源标签归属，不接受页面指定原生窗口或 URL。
- 旧核心无 deferred 能力时保留 40ms 落点轮询，仅 `detach-tab` 或旧 live 明确松手消息提交，普通 end 按取消处理；`detachResult` 保留请求回执。新核心仍兼容旧外壳 live 协议。缺少 `tab-window.html` 的旧核心使用外壳内置菜单顶栏。

## 顶栏反馈与开销

- 标题预览是外壳的无焦点、忽略鼠标输入的小窗口，不承载页面；目标插入线与源提示不参与列表布局。结束时清除预览和提示。
- 排序与移动消息按显示帧合并，松手同步最终坐标；每次先上报变化的源栏几何，再发送坐标，避免布局/滚动变化后沿用旧边界。开始消息不提前改变迟滞状态，未绘制的移动不留下隐藏候选。只有列表边缘仍可滚动时续帧；新版主进程不再周期轮询或在按住期间迁移原视图。旧核心低频兼容轮询在结束时清理。
- 条内排序与菜单新窗淡入沿用减少动画设置；单次提交不再维护整窗追随、反复迁移回滚或空源淡出。单测记录消息、迁移和帧数量，不将这些数值称作实机 CPU/帧率测量。

## Linux 启动后端

安装版、源码外壳与 npm CLI 共用 `shell/linux-backend.mjs`。Electron 44 在执行应用脚本前已创建 Ozone 后端，不能在 `ready` 前简单 `appendSwitch` 后就宣称切换成功：安装/源码入口必要时先带 `--ozone-platform=x11` 重启一次，再取单实例锁、启动核心和建窗；npm CLI 在 spawn 前传入这个参数。AppImage 重启外层文件，普通核心重启保留原始参数。二次启动只唤出现有实例，切换后端须先退出启动器。

显式 `--ozone-platform=x11` / `wayland` 原样保留；其他值及旧 `--ozone-platform-hint` 也不擅自改写，其有效性由当前 Electron 决定。Electron 44 已移除旧 hint/`ELECTRON_OZONE_PLATFORM_HINT` 支持，请使用 `--ozone-platform`；本功能不增加持久设置或系统配置。原生 Wayland 不提供这里需要的全局坐标，仍为 `drag=false`，保留同窗排序及菜单拆分/合并，不将 XWayland 通过记为原生 Wayland 通过。

`DISPLAY` 只用于请求连接，不证明 XWayland 可用。缺少它时不自动切换并输出诊断；存在但 socket/认证失效时，X11 初始化可能在应用 JS 执行前退出，原生错误与启动前提示用于排查，安装入口不承诺此时弹出 JS 错误框。npm CLI 自动请求 X11 后若子进程失败，会保留退出码并补充诊断。可完全退出后用 `DSH --ozone-platform=wayland`、`npm run electron -- --ozone-platform=wayland` 或 `dsh-x --ozone-platform=wayland` 使用原生后端；可用的 XWayland 则可显式指定 `x11`。

## 验证

`instance-views.test.mjs` 覆盖唯一归属、回滚、关闭、重启及 IPC；`instance-window-api.test.mjs` 和 `instance-window-ui.test.mjs` 覆盖新旧协议及界面能力。`tab-drag-session.test.mjs` 覆盖一次性事务、epoch 失效和失败回挂；`tab-drag-regressions.test.mjs` 将真实顶栏消息接到主进程函数，检查提交、取消与生命周期（DOM/假原生对象）。`internal-tabs-drag.test.mjs` 和 `tab-detach.test.mjs` 覆盖输入脚本、协议及坐标规则；`linux-backend.test.mjs` 覆盖后端选择、单次重启、参数保留、缺少/失效 DISPLAY 的诊断及 CLI 真实入口（替身进程边界，不等于 XWayland 连接或 OS 手势验收）。

`electron scripts/verify-tab-detach.mjs` 使用本地页面、真实预加载/IPC/WCV/guest，断言页面身份、租约、草稿、滚动、历史和失败回挂；数据与结果在 `.paseo-local/runtime/tab-detach-native`，不启动 DSH。合成指针不代表系统捕获通过。

`electron scripts/verify-tab-groups.mjs` 仅允许 Windows，导入应用前检查配置、userData、sessionData、单实例锁隔离。它通过真实外壳/核心、菜单和 Electron sendInputEvent 验证按住不迁移、Escape 零迁移、松手提交、窗口复用、原页面草稿/滚动、键盘与明暗主题。该输入层不等同于 OS 跨窗口拖动。默认结果在 `.paseo-local/runtime/tab-groups-native`；`--output-dir` 指定工作区内新证据目录；`--drag` 额外等待人工将下方窗口第一张标签拖到启动器空标签栏后松手。

最终平台验收还须独立记录真实输入层、桌面松手、跨窗指定位置、Esc、隐藏/最小化后恢复、焦点菜单/快捷键、退出和 guest 保留。Linux 最小探针或 Node 通过不能代替产品快照验收，混合 DPI、多屏与外部应用遮挡也需明确验证边界。
