# macOS 固定签名

[#30](https://github.com/yyh-001/DSH-X/issues/30) 报告：添加工作区的目录选择器偶发 AppleEvent `-1712`，授权后重启仍可能复现。之前每次打包用 `codesign -s -`，签名身份随应用内容改变；现在正式 macOS 构建要求两种架构共用同一张代码签名证书。证书必须跨版本保留，不能在 CI 每次重新生成。

## 准备证书

优先使用 Apple 的 **Developer ID Application** 证书。暂时没有开发者账号时，可按 [Apple 的证书助手步骤](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)在 macOS「钥匙串访问 → 证书助理 → 创建证书」生成 `Self Signed Root`、`Code Signing` 类型的证书。自签名证书只能提供跨版本一致的签名要求，**不能通过 Gatekeeper，也不能公证**；Apple 不建议把这种证书签的应用公开分发。因此这只是针对 #30 的临时验证方案，不能当成 Developer ID 的替代品。

在「钥匙串访问 → 我的证书」中，连同**私钥**导出为带密码的 `.p12`。把 `.p12` 和密码分别离线备份；丢失私钥或换证书后，旧签名身份无法再复用，用户此前的隐私授权可能需要重新确认。不要把 `.p12`、密码或私钥提交到仓库，也不要放入 Release 附件。

运行 `security find-identity -v -p codesigning`，记录证书的 40 位 SHA-1 指纹。两种架构和后续版本必须使用同一个指纹。本地构建时，在已导入该证书的 Mac 上运行：

```sh
DSH_MAC_SIGNING_IDENTITY=<40位SHA-1指纹> DSH_MAC_REQUIRE_SIGNED=1 npm run dist
codesign --verify --deep --strict --verbose=2 release/DSH-X.app
codesign -dv --verbose=4 release/DSH-X.app
```

不设置 `DSH_MAC_SIGNING_IDENTITY` 的本地/手动 CI 构建仍可用 ad-hoc 签名做开发测试。`v*` tag 触发的 CI 构建会拒绝这种降级。

## GitHub Actions 配置

在仓库中配置以下两个 **Secrets** 和一个 **Variable**：

| 名称 | 内容 |
| --- | --- |
| `DSH_MAC_CERT_P12_BASE64` | `.p12` 文件的单行 Base64；macOS 可用 `base64 -i <文件.p12> | tr -d '\n'` 生成 |
| `DSH_MAC_CERT_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `DSH_MAC_SIGNING_SHA1` | 固定证书的 40 位 SHA-1 指纹（Repository Variable） |

CI 把 `.p12` 导入临时钥匙串，核对指纹，分别签内置 Node 和外层 `.app`，再严格校验签名。缺少任一配置、指纹不匹配或签名校验失败时，tag 构建中止，不上传 dmg。现有 `DSH_RELEASE_KEY` 是**发布清单**的 Ed25519 私钥，与 macOS 代码签名证书无关。

## 真机验证 #30

把新 dmg 中的应用拖入「应用程序」，从那里启动。若是自签名包，首次打开仍需按 macOS 的隐私与安全性提示放行。先通过启动器「设置 → 浏览…」触发目录授权，再在 dsh 页面添加工作区；退出、重启和更新到另一个**同证书签名**的版本后重复。检查 `codesign -d -r- /Applications/DSH-X.app` 所示的签名要求是否一致，并记录 `-1712` 是否仍出现。这个错误也可能受 AppleScript 前台状态影响，固定签名本身不能证明已彻底修复。
