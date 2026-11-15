# 实例页面与窗口

一个受管理实例默认对应一个页面，由主窗口标签或独立窗口承载。关闭独立窗口只隐藏，停止实例仍由核心负责。改变打开设置不自动搬动现有页面；再次普通打开遵循当前设置，必要时迁移原视图。「在新窗口打开」只影响这次打开。Linux 当前禁止已有页面跨窗迁移：切换打开方式时提示先关闭标签再重新打开，首次直接开独立窗口不受影响。

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
- Windows/macOS 开放无修饰键拖出与回并。当前固定 Electron 44.7.0，Linux（包括 X11/XWayland/Wayland）暂不交付跨窗拆合，能力位 `supported/drag/merge/deferred` 均关闭，标签菜单与原生菜单也不能搬动页面，登记器再次拒绝已有视图重挂载。同窗排序与首次独立开窗保留。Linux 迁移沿用 `tabMigrationSupported()` 的运行时门槛（44.7.1），拖动另要求实际 X11 后端；升级前仍须通过 DSH 原生模块兼容及产品验收。新版顶栏按显示帧发送源页面局部坐标，主进程根据源窗口内容原点及页面缩放换成 DIP，再做受管窗口命中。
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

不再为了标签拆合自动请求 XWayland，也不在启动时为此重启。安装版、源码外壳按 Electron 默认选择后端；npm CLI 原样透传启动参数。普通核心重启保留原始参数，AppImage 仍重启外层文件。二次启动只唤出现有实例，切换后端须先退出启动器。

显式 `--ozone-platform=x11` / `wayland` 原样保留，其有效性和连接由 Electron 处理；本功能不增加持久设置或修改系统配置。选择 X11 也不会重新开放跨窗迁移。

Electron 保持仓库基线 44.7.0：44.7.1 虽修复 Linux 迁移后的原生视图不绘制，但 DSH 当前原生模块不支持该运行时，不能仅为窗口效果升级。未来恢复 Linux 拆合需同时通过原生模块兼容、打包态真实 DSH 启动及迁移后内容呈现验收。

## 验证

原生兼容对照：官方 `@deepseek-ai/dsh@0.2.2-rc.1`～`rc.3` 依赖 `node-addon-require-builtin@^0.1.9`，而 0.1.9 用 Node + V8 精确指纹匹配运行时（表里只有 43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6）。Windows x64、`ELECTRON_RUN_AS_NODE=1` 调用其 `requireBuiltin('internal/modules/cjs/loader')`：44.7.1 实际报 `unsupported Electron runtime fingerprint`；回退 44.7.0 后返回有效的 `Module` 函数。此对照验证原生接口，不代表完整 DSH 或安装包验收。升级前须确认上游 `runtime_profile.cc` 支持新版本，并通过打包态真实 DSH 启动；`test/electron-native-compat.test.mjs` 锁住支持列表与打包兜底版本。

`instance-views.test.mjs` 覆盖唯一归属、回滚、关闭、重启及 IPC，并检查禁用迁移时不摘出视图、不创建空目标。`instance-window-api.test.mjs` 和 `instance-window-ui.test.mjs` 覆盖新旧协议及界面能力。`tab-drag-session.test.mjs` 覆盖一次性事务、epoch 失效和失败回挂；`tab-drag-regressions.test.mjs` 将真实顶栏消息接到主进程函数，检查提交、取消与生命周期（DOM/假原生对象）。`internal-tabs-drag.test.mjs` 和 `tab-detach.test.mjs` 覆盖输入脚本、平台门控及坐标规则；`platform-launch.test.mjs` 检查主入口不自动切换后端、CLI 参数透传、重启参数保留及两类宿主能力与迁移门控的接线。

`electron scripts/verify-tab-detach.mjs` 使用本地页面、真实预加载/IPC/WCV/guest，断言页面身份、租约、草稿、滚动、历史和失败回挂；数据与结果在 `.paseo-local/runtime/tab-detach-native`，不启动 DSH。合成指针不代表系统捕获通过。

`electron scripts/verify-tab-groups.mjs` 仅允许 Windows，导入应用前检查配置、userData、sessionData、单实例锁隔离。它通过真实外壳/核心、菜单和 Electron sendInputEvent 验证按住不迁移、Escape 零迁移、松手提交、窗口复用、原页面草稿/滚动、键盘与明暗主题。该输入层不等同于 OS 跨窗口拖动。默认结果在 `.paseo-local/runtime/tab-groups-native`；`--output-dir` 指定工作区内新证据目录；`--drag` 额外等待人工将下方窗口第一张标签拖到启动器空标签栏后松手。

最终平台验收还须独立记录真实输入层、桌面松手、跨窗指定位置、Esc、隐藏/最小化后恢复、焦点菜单/快捷键、退出和 guest 保留。Linux 最小探针或 Node 通过不能代替产品快照验收，混合 DPI、多屏与外部应用遮挡也需明确验证边界。
