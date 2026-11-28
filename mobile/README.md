# DSH-X Mobile App Shell

DSH-X 原生手机壳（基于 Capacitor 8，Android 优先并兼容后续 iOS 构建），直接复用 [src/public/mobile/](../src/public/mobile/) 的控制台 UI，并通过原生桥接层补齐：

- **无混合内容限制的多链路测速**：在 App 内可同时探测局域网 HTTP、Tailscale 与 Cloudflare HTTPS 链路；
- **原生扫码与硬件密钥库**：内置 ZXing 扫码配对，设备凭证经 `AndroidKeyStore`（AES-256-GCM）加密保存；
- **原版 DSH WebView 会话注入**：打开任意 DSH 实例前静默调用 `POST /_dshx/api/session/bootstrap` 写入 `HttpOnly` Cookie，再直达原版 DSH 页面，无需修改 DSH 前端源码。

## 目录结构

- `web-overlay/native-bridge.js`：仅在 Capacitor 原生容器内激活的 `window.DSHXNative` 桥接层；
- `native/android/`：Android 原生覆盖层（`DshxNativePlugin`、`DshWebViewActivity`、`SecureTokenStore`、`network_security_config.xml`）；
- `scripts/sync-web.mjs`：将 `../src/public/mobile/` 同步并改写至 `www/`；
- `scripts/prepare-android.mjs`：生成并幂等修补 `android/` 工程（`android/` 与 `www/` 均为构建产物，不入库）。

## 本地开发与校验

```sh
cd mobile
npm ci
npm test
npm run prepare:android
```

在已配置 Android SDK 的环境下构建 Release APK：

```sh
cd mobile/android
./gradlew assembleRelease --no-daemon
```
