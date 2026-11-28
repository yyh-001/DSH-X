import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { syncWeb, transformIndexHtml } from '../scripts/sync-web.mjs'
import { computeVersionCode, patchAppBuildGradle, patchManifest } from '../scripts/prepare-android.mjs'

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(MOBILE_DIR, '..')

test('transformIndexHtml: 将 /_dshx/m/ 重写为相对路径并在 app.js 前注入 native-bridge.js', () => {
  const input = [
    '<link rel="stylesheet" href="/_dshx/m/style.css" />',
    '<link rel="icon" type="image/png" href="/_dshx/m/icon.png" />',
    '<script type="module" src="/_dshx/m/app.js"></script>',
  ].join('\n')

  const once = transformIndexHtml(input)
  assert.equal(once.includes('/_dshx/m/'), false)
  assert.ok(once.includes('./style.css'))
  assert.ok(once.includes('./icon.png'))

  const bridgeIdx = once.indexOf('<script src="./native-bridge.js"></script>')
  const appIdx = once.indexOf('<script type="module" src="./app.js"></script>')
  assert.ok(bridgeIdx >= 0 && appIdx > bridgeIdx, 'native-bridge.js 必须在 app.js 之前加载')

  // 重复执行必须幂等，不重复注入 script 标签
  const twice = transformIndexHtml(once)
  assert.equal(twice, once)
})

test('syncWeb: 完整复制手机端控制台资源与原生桥接脚本到目标目录', () => {
  const tempOut = mkdtempSync(join(tmpdir(), 'dshx-mobile-www-'))
  try {
    syncWeb({ outDir: tempOut })
    for (const file of ['index.html', 'style.css', 'app.js', 'manifest.json', 'icon.png', 'native-bridge.js']) {
      assert.equal(existsSync(join(tempOut, file)), true, `应生成 ${file}`)
    }
    const html = readFileSync(join(tempOut, 'index.html'), 'utf8')
    assert.ok(html.includes('./native-bridge.js'))
    assert.equal(html.includes('/_dshx/m/style.css'), false)
  } finally {
    rmSync(tempOut, { recursive: true, force: true })
  }
})

test('computeVersionCode: 为正式版与 rc 预发布版生成单调递增 versionCode', () => {
  const rc1 = computeVersionCode('0.1.27-rc.1')
  const rc7 = computeVersionCode('0.1.27-rc.7')
  const stable = computeVersionCode('0.1.27')
  const next = computeVersionCode('0.1.28-rc.1')

  assert.ok(rc7 > rc1)
  assert.ok(stable > rc7)
  assert.ok(next > stable)
})

test('patchManifest 与 patchAppBuildGradle: 幂等注入权限、WebView Activity、ZXing 与签名配置', () => {
  const rawManifest = [
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <application android:label="@string/app_name">',
    '        <provider android:name="androidx.core.content.FileProvider" />',
    '    </application>',
    '    <uses-permission android:name="android.permission.INTERNET" />',
    '</manifest>',
  ].join('\n')

  const patchedManifestOnce = patchManifest(rawManifest)
  assert.ok(patchedManifestOnce.includes('android.permission.CAMERA'))
  assert.ok(patchedManifestOnce.includes('android.permission.POST_NOTIFICATIONS'))
  assert.ok(patchedManifestOnce.includes('android.permission.FOREGROUND_SERVICE'))
  assert.ok(patchedManifestOnce.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'))
  assert.ok(patchedManifestOnce.includes('android.hardware.camera.any'))
  assert.ok(patchedManifestOnce.includes('android:networkSecurityConfig="@xml/network_security_config"'))
  assert.ok(patchedManifestOnce.includes('android:usesCleartextTraffic="true"'))
  assert.ok(patchedManifestOnce.includes('.DshWebViewActivity'))
  assert.ok(patchedManifestOnce.includes('.QrScanActivity'))
  assert.ok(patchedManifestOnce.includes('android:screenOrientation="portrait"'))
  assert.ok(patchedManifestOnce.includes('.NoticeSyncService'))
  assert.ok(patchedManifestOnce.includes('foregroundServiceType="dataSync"'))
  assert.equal(patchManifest(patchedManifestOnce), patchedManifestOnce, 'patchManifest 必须幂等')

  const rawGradle = [
    'android {',
    '    defaultConfig {',
    '        versionCode 1',
    '        versionName "1.0"',
    '        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',
    '    }',
    '    buildTypes {',
    '        release {',
    '            minifyEnabled false',
    '        }',
    '    }',
    '}',
    'dependencies {',
    "    implementation project(':capacitor-android')",
    '}',
  ].join('\n')

  const patchedGradleOnce = patchAppBuildGradle(rawGradle, { versionName: '0.1.27-rc.7', versionCode: 12707 })
  assert.ok(patchedGradleOnce.includes('versionCode 12707'))
  assert.ok(patchedGradleOnce.includes('versionName "0.1.27-rc.7"'))
  assert.ok(patchedGradleOnce.includes('com.journeyapps:zxing-android-embedded:4.3.0'))
  assert.ok(patchedGradleOnce.includes('DSHX_ANDROID_KEYSTORE'))
  assert.ok(patchedGradleOnce.includes('signingConfigs.release'))
  assert.ok(patchedGradleOnce.includes('DSHX_RELEASE_ABI_FILTER'))
  assert.equal(
    patchAppBuildGradle(patchedGradleOnce, { versionName: '0.1.27-rc.7', versionCode: 12707 }),
    patchedGradleOnce,
    'patchAppBuildGradle 必须幂等',
  )
})

test('Android 原生 Java 覆盖层与桥接脚本结构完整', () => {
  const javaDir = join(MOBILE_DIR, 'native', 'android', 'java', 'com', 'dshx', 'mobile')
  const mainJava = readFileSync(join(javaDir, 'MainActivity.java'), 'utf8')
  const pluginJava = readFileSync(join(javaDir, 'DshxNativePlugin.java'), 'utf8')
  const webViewJava = readFileSync(join(javaDir, 'DshWebViewActivity.java'), 'utf8')
  const qrJava = readFileSync(join(javaDir, 'QrScanActivity.java'), 'utf8')
  const noticeJava = readFileSync(join(javaDir, 'NoticeSyncService.java'), 'utf8')
  const storeJava = readFileSync(join(javaDir, 'SecureTokenStore.java'), 'utf8')
  const bridgeJs = readFileSync(join(MOBILE_DIR, 'web-overlay', 'native-bridge.js'), 'utf8')
  const mobileAppJs = readFileSync(join(REPO_ROOT, 'src', 'public', 'mobile', 'app.js'), 'utf8')

  assert.ok(mainJava.includes('registerPlugin(DshxNativePlugin.class)'))
  assert.ok(pluginJava.includes('@CapacitorPlugin'))
  assert.ok(pluginJava.includes('scanQr'))
  assert.ok(pluginJava.includes('QrScanActivity'))
  assert.ok(pluginJava.includes('configureNotifications'))
  assert.ok(pluginJava.includes('openDshInstance'))
  assert.ok(qrJava.includes('TRY_HARDER'))
  assert.ok(qrJava.includes('MIXED_SCAN'))
  assert.ok(qrJava.includes('FocusMode.CONTINUOUS'))
  assert.ok(noticeJava.includes('/_dshx/api/notices'))
  assert.ok(noticeJava.includes('dshx_approval'))
  assert.ok(noticeJava.includes('DshWebViewActivity'))
  assert.ok(webViewJava.includes('/_dshx/api/session/bootstrap'))
  assert.ok(webViewJava.includes('/_dshx/open/'))
  assert.ok(storeJava.includes('AndroidKeyStore'))
  assert.ok(bridgeJs.includes('window.DSHXNative'))
  assert.ok(bridgeJs.includes('configureNotifications'))
  assert.ok(mobileAppJs.includes('getNativeBridge'))
  assert.ok(mobileAppJs.includes('openNativeDshInstance'))
  assert.ok(mobileAppJs.includes('syncNativeNotifications'))

  const gitignore = readFileSync(join(MOBILE_DIR, '.gitignore'), 'utf8')
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim())
  assert.ok(lines.includes('/android/'), 'mobile/.gitignore 必须锚定 /android/，防止误忽略 native/android/')
  assert.equal(lines.includes('android/'), false, 'mobile/.gitignore 不能包含未锚定的 android/')
})
