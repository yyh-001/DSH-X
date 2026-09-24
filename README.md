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

启动器没有代码签名，而它的行为和启发式里的「下载器」有几分像：会拉起 `cmd` / `powershell` 打开链接、可以写开机自启项、自带一份 Node 运行时、自更新时会下载安装包。所以偶尔会被 Windows Defender 或其他杀软拦下来。

遇到了这样处理：

- 先在杀软的「保护历史记录」里确认被拦的具体条目；
- 把安装目录（默认 `%LOCALAPPDATA%\Programs\DSH`）加进排除项，可以先恢复使用；
- 把误报提交给微软：<https://www.microsoft.com/en-us/wdsi/filesubmission>（选「软件开发者」，上传 `DSH-Setup.exe`），一般 1–2 天会撤销误报；
- 国内杀软（360、火绒等）各有误报提交入口，同样适用；
- 下载后 SmartScreen 提示「未知发布者」是正常的（没有代码签名），点「仍要运行」即可。

## 使用

Windows 安装 [DSH-Setup.exe](https://github.com/yyh-001/DSH-X/releases/latest) 后，从桌面打开 **DSH-X**。

macOS 打开 `DSH-X-mac-arm64.dmg`（Apple Silicon）或 `DSH-X-mac-x64.dmg`（Intel），把 **DSH-X** 拖进「应用程序」。应用没有经过公证，第一次打开会被拦下：右键点它选「打开」，或到「系统设置 → 隐私与安全性」里放行。设置和日志在 `~/Library/Application Support/DSH`。自更新要求应用放在当前用户能写的目录（比如「应用程序」）。

启动器管理页和 DSH 官方原版 Web 界面都会使用系统默认浏览器打开；管理页地址默认 `http://127.0.0.1:3780/`（设置页可改端口，改完重启启动器生效）。

dsh 的 Web 界面默认只绑在本机（`127.0.0.1`）。想让手机/其他电脑也能访问：设置页 → 高级设置 → **Web 绑定**选「局域网（0.0.0.0）」，下次启动 dsh 生效；远程访问插件的「局域网访问」开关打开时，启动器也会自动按局域网处理（不再注入 `--host`）。

**核对下载到的包（可选）**：Release 页面每个文件旁边就写着 sha256，本地对一下即可 —— Windows `certutil -hashfile DSH-Setup.exe SHA256`，macOS `shasum -a 256 DSH-X-mac-arm64.dmg`。数字一致就说明下载过程没出错、文件没被动过。

## 开发

需要本机 Node.js 22.18+（官方 DSH：`^22.19.0 || >=24`）。

```sh
npm install
npm start
```

只起网页：`npm run server`。

## 打包

需要 Rust 与 Inno Setup 6（没有会尝试下载）。

```sh
npm run dist
```

- `release/DSH/`：便携目录
- `release/DSH-Setup.exe`：安装包（默认 `%LOCALAPPDATA%\Programs\DSH`）

macOS 上同一条命令只需要 Rust 和 Xcode 命令行工具，产出：

- `release/DSH-X.app`：应用本体（ad-hoc 签名）
- `release/DSH-X-mac-<arch>.dmg`：自更新下载的发布资产，每个架构各传一份（Intel 版先 `rustup target add x86_64-apple-darwin`，再 `DSH_MAC_ARCH=x64 npm run dist`）

Windows 打完包还会顺带生成三份自查用的文件（**都不上传到 Release**，发布页只放安装包和 dmg）：`release/dsh-x-<版本>.spdx.json`（SBOM，SPDX 2.3）、`release/release-manifest.json`（发布清单：版本、提交、有没有 tag、产物哈希），有私钥时再写一份 `release/release-manifest.sig`（Ed25519）。

发版时先过一致性闸门，再上传安装包和 dmg：

```sh
node scripts/release-manifest.mjs check-tag v0.1.14   # tag 必须与 package.json 的版本一致
node scripts/release-manifest.mjs verify              # 签名有效 + 逐个产物核对哈希
gh release create v0.1.14 release/DSH-Setup.exe \
  release/mac/DSH-X-mac-arm64.dmg release/mac/DSH-X-mac-x64.dmg --latest
```

第一次签名先跑 `node scripts/release-manifest.mjs keygen`：私钥落在 `release/release-key.pem`（已被忽略、不进仓库，**务必备份**），公钥是仓库里的 `scripts/release-pubkey.pem`。手上有一份清单和签名时（例如自己打的包、或从别处拿到的一套），把安装包、`release-manifest.json`、`release-manifest.sig` 放进同一个目录就能核：

```sh
node scripts/release-manifest.mjs verify <那个目录>
```

