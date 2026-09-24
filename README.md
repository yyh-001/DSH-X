<p align="center">
  <img src="docs/hero.png" alt="DSH-X" width="880" />
</p>

<p align="center">
  <a href="https://yyh-001.github.io/DSH-X/">主页</a>
  ·
  <a href="https://github.com/yyh-001/DSH-X/releases/latest/download/DSH-Setup.exe">下载</a>
  ·
  <a href="https://github.com/yyh-001/DSH-X">Star</a>
  ·
  <a href="README.en.md">English</a>
</p>

DeepSeek Harness 轻量启动器。选一个版本，在系统浏览器中启动 DSH Web。

> [!IMPORTANT]
> **DSH-X 启动的是 DeepSeek Harness 官方原版 Web 页面，不是桌面端。**  
> 它只负责版本安装、启动和插件管理，不内嵌 WebView，不修改或重做 DSH 的网页界面。DSH-X 本身是社区开源项目，并非 DeepSeek 官方产品。

## 功能

- **选版本即用**：启动 / 停止 / 重启 / 更新 / 卸载
- **支持 macOS**：原生 `.app` 与 dmg 安装包（Apple Silicon / Intel 各一份），自更新、开机自启、选目录都用系统原生方式
- **插件页**：列出已装插件一键开关，可检查并更新插件（单个 / 全部），profile 也在这里切换
- **兼容模式**：启动失败按报错自动禁用出问题的插件（可一键恢复）；启动后自检页面引用的客户端插件包，管理页给出结论（区分实例问题和旧标签页）
- **深色外观**：跟随系统或手动指定，另有悬浮窗透明度与看板娘开关
- **启动加速**：在 bundle 合成处挂等价快实现（约省 1–2 秒），dsh 升级后自动跳过
- **插件跟官方走**：数据在用户目录 `.dsh`，换版本不用重装插件
- **更新留旧版**：只保留最新的和最近装的一个（回退够用），更旧的装完自动清理
- **常驻后台**：关掉网页不退出（Windows 托盘 / macOS 菜单栏图标），界面走系统浏览器
- **自带 Node / npm / pnpm**：安装包里有便携运行时与镜像源 npmmirror，插件安装不依赖系统环境
- **同时只跑一个版本**：避免不同版本争用端口和数据
- **首次安装可预装市场**：可自动安装 `dshmarket`

交流 / 反馈：**QQ 群 [993579665](https://qm.qq.com/q/7AD2g70HqS)**（[点击加入](https://qm.qq.com/q/7AD2g70HqS)）

## 界面预览

<p align="center">
  <img src="docs/screenshot-home.png" alt="DSH-X 控制页" width="820" />
</p>

<p align="center">
  <img src="docs/screenshot-plugins.png" alt="DSH-X 插件页" width="820" />
</p>

<p align="center">
  <img src="docs/screenshot-settings.png" alt="DSH-X 设置页" width="820" />
</p>

## 杀软误报

启动器没有代码签名，行为又和启发式里的「下载器」有几分像（会拉起 `cmd` / `powershell`、能写开机自启、自带 Node 运行时、自更新时下载安装包），所以偶尔会被 Windows Defender 或其他杀软拦下。

被拦了：把安装目录（默认 `%LOCALAPPDATA%\Programs\DSH`）加进排除项；误报可以提交给[微软](https://www.microsoft.com/en-us/wdsi/filesubmission)（选「软件开发者」，上传 `DSH-Setup.exe`），一般 1–2 天撤销，国内杀软（360、火绒等）同理。下载后 SmartScreen 提示「未知发布者」是正常的，点「仍要运行」。

## 使用

Windows：[下载 DSH-Setup.exe](https://github.com/yyh-001/DSH-X/releases/latest) 安装，从桌面打开 **DSH-X**。

macOS：打开 `DSH-X-mac-arm64.dmg`（Apple Silicon）或 `DSH-X-mac-x64.dmg`（Intel），把 **DSH-X** 拖进「应用程序」。应用没做公证，第一次打开要右键选「打开」；自更新也要求放在这种可写目录里。设置和日志在 `~/Library/Application Support/DSH`。

管理页和 dsh 的界面都在系统浏览器里打开，管理页默认 `http://127.0.0.1:3780/`（端口可在设置页改）。想让手机或其他电脑访问 dsh：设置页 → 高级设置 → **Web 绑定**选「局域网」，下次启动 dsh 生效。

核对下载到的包（可选）：Release 页面每个文件旁边有 sha256，本地对一下即可 —— Windows `certutil -hashfile DSH-Setup.exe SHA256`，macOS `shasum -a 256 DSH-X-mac-arm64.dmg`。

## 开发

本机需要 Node.js 22.18+。`npm install` 之后 `npm start`；只起网页用 `npm run server`。

## 打包

```sh
npm run dist
```

Windows（需要 Rust 与 Inno Setup 6）产出 `release/DSH/` 便携目录和 `release/DSH-Setup.exe`；macOS（需要 Rust 与 Xcode 命令行工具）产出 `release/DSH-X.app` 和 `release/DSH-X-mac-<arch>.dmg`（Intel 版：`DSH_MAC_ARCH=x64 npm run dist`）。

打包还会顺带生成 SBOM 与发布清单（自查用，不上传 Release）。发版时先过两道闸门，再把安装包和 dmg 一起传上去：

```sh
node scripts/release-manifest.mjs check-tag v0.1.14   # tag 必须与 package.json 的版本一致
node scripts/release-manifest.mjs verify              # 逐个产物核对哈希（有私钥时一并验签）
gh release create v0.1.14 release/DSH-Setup.exe release/mac/DSH-X-mac-*.dmg --latest
```

私钥在 `release/release-key.pem`（已被忽略、不进仓库，**务必备份**）。`scripts/release-manifest.mjs` 的头部注释里有 keygen、单独核对某个目录等其余用法。

