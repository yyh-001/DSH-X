# DSH-X Wallpaper Engine Implementation Plan

**Goal:** 将启动器主界面的水面和互动看板娘制作成可离线运行的 Wallpaper Engine 展示壁纸。

**Architecture:** 独立网页入口，只复用现有水面与看板娘素材，不连接启动器后端。导出脚本将所需文件复制到专用目录，附加 Wallpaper Engine 属性、暂停与帧率适配；不改变启动器页面。

**Tech Stack:** 原生 HTML/CSS/JavaScript、现有 WebGL 水面、Node 内置文件 API。

---

### Task 1: 独立展示入口
- 新建 `wallpaper/index.html`、`wallpaper/wallpaper.css`、`wallpaper/wallpaper.js`、`wallpaper/project.json`。
- 保留浅色水面、原有分层角色与鼠标交互，移除管理控件；支持深浅主题、角色大小、标识与动画开关。
- 通过 `wallpaperPropertyListener` 响应暂停、恢复和全局 FPS；减少动态效果偏好仍有效。
- 主题默认按本机时间自动切换：07:00（含）至 19:00（不含）为浅色，每分钟检查，恢复可见或宿主恢复播放时立即纠正；保留手动配色和系统主题模式。
- 右上方标识下显示本机 24 小时时间，整分钟刷新并在恢复时纠正；时间和标识支持独立开关，均不拦截鼠标交互。
- 时钟下方增加 32 段系统音频频谱，直接注册 Wallpaper Engine 音频回调，将左右声道按频率合并、限幅、平滑；静音、停止回调、暂停、隐藏时归零。提供独立显示开关及灵敏度设置，普通浏览器不模拟音频。

### Task 2: 专用导出包
- 新建 `scripts/export-wallpaper.mjs`，只复制八张正在使用的角色素材、静态兜底及必要脚本。
- 对导出的动画副本适配帧率，不修改启动器动画源码。
- 默认水面和角色均以最高 60 FPS 运作，服从宿主帧率；帧间判断保留半毫秒余量，避免刷新时间戳误差导致跳帧。
- 生成到 `release/wallpaper/DSH-X/`，附使用说明；支持任意工作目录调用。
- 不自动提交、不打启动器安装包、不发布创意工坊。

### Task 3: 验证和交付
- `node scripts/export-wallpaper.mjs`，确认文件与相对资源路径齐全。
- 用 Edge/Playwright 通过本地文件验证 1920×1080、2560×1440、3440×1440、竖屏。
- 检查资源加载、无后端或网络请求、主题切换、交互、暂停/恢复、减弱动画与低 FPS。
- 保存浏览器截图及缩略图，打包 ZIP；说明浏览器验证和 Wallpaper Engine 实测的边界。
