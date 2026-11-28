import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncWeb } from './sync-web.mjs'

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(MOBILE_DIR, '..')
const ANDROID_DIR = join(MOBILE_DIR, 'android')
const OVERLAY_ANDROID = join(MOBILE_DIR, 'native', 'android')
const APP_ICON_SRC = join(REPO_ROOT, 'src', 'public', 'icon.png')

const ZXING_DEP = "    implementation 'com.journeyapps:zxing-android-embedded:4.3.0'"

/**
 * 将 semver 版本号（如 `0.1.27-rc.7` 或 `1.2.3`）确定性映射为单调递增的 Android versionCode。
 * 格式：major * 1_000_000 + minor * 10_000 + patch * 100 + preOffset（正式版 99，rc/alpha/beta 0..98）。
 */
export function computeVersionCode(versionStr) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(versionStr || '').trim())
  if (!m) return 100
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  let preOffset = 99
  if (m[4]) {
    const numMatch = /(\d+)$/.exec(m[4])
    preOffset = numMatch ? Math.min(98, Math.max(0, Number(numMatch[1]))) : 0
  }
  return major * 1_000_000 + minor * 10_000 + patch * 100 + preOffset
}

/** 幂等修补 AndroidManifest.xml：声明相机权限、允许局域网明文流量、挂载 DshWebViewActivity。 */
export function patchManifest(rawXml) {
  let xml = String(rawXml || '')

  if (!xml.includes('android.permission.CAMERA')) {
    xml = xml.replace(
      '<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />',
    )
  }

  for (const perm of [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'android.permission.REQUEST_INSTALL_PACKAGES',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'android.permission.SYSTEM_ALERT_WINDOW',
  ]) {
    if (!xml.includes(perm)) {
      xml = xml.replace(
        '<uses-permission android:name="android.permission.CAMERA" />',
        `<uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="${perm}" />`,
      )
    }
  }

  if (!xml.includes('android.hardware.camera.any')) {
    xml = xml.replace(
      '</manifest>',
      '    <uses-feature android:name="android.hardware.camera.any" android:required="false" />\n</manifest>',
    )
  }

  if (!xml.includes('android:networkSecurityConfig=')) {
    xml = xml.replace(
      '<application',
      '<application\n        android:networkSecurityConfig="@xml/network_security_config"\n        android:usesCleartextTraffic="true"',
    )
  }

  if (!xml.includes('.DshWebViewActivity')) {
    const activityBlock = [
      '        <activity',
      '            android:name=".DshWebViewActivity"',
      '            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"',
      '            android:theme="@style/Theme.AppCompat.Light.NoActionBar"',
      '            android:exported="false" />',
      '',
    ].join('\n')
    xml = xml.replace('        <provider', `${activityBlock}\n        <provider`)
  }

  if (!xml.includes('.QrScanActivity')) {
    const qrBlock = [
      '        <activity',
      '            android:name=".QrScanActivity"',
      '            android:screenOrientation="portrait"',
      '            android:stateNotNeeded="true"',
      '            android:theme="@style/Theme.AppCompat.NoActionBar"',
      '            android:exported="false" />',
      '',
    ].join('\n')
    xml = xml.replace('        <provider', `${qrBlock}\n        <provider`)
  }

  if (!xml.includes('.NoticeSyncService')) {
    const svcBlock = [
      '        <service',
      '            android:name=".NoticeSyncService"',
      '            android:exported="false"',
      '            android:foregroundServiceType="dataSync" />',
      '',
    ].join('\n')
    xml = xml.replace('        <provider', `${svcBlock}\n        <provider`)
  }

  // 悬浮球是普通 Service（靠可见的 overlay 窗口与前台通知服务保活），
  // 不声明就会 startService 失败，表现就是「打开悬浮窗什么也没有」。
  if (!xml.includes('.FloatingWindowService')) {
    const floatBlock = [
      '        <service',
      '            android:name=".FloatingWindowService"',
      '            android:exported="false"',
      '            android:stopWithTask="false" />',
      '',
    ].join('\n')
    xml = xml.replace('        <provider', `${floatBlock}\n        <provider`)
  }

  return xml
}

/** 幂等修补 app/build.gradle：版本号、ZXing 扫码依赖、Release 签名环境变量块、ABI 过滤与 16KB 打包选项。 */
export function patchAppBuildGradle(rawGradle, { versionName = '0.1.0', versionCode = 10000 } = {}) {
  let gradle = String(rawGradle || '')

  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`)

  if (!gradle.includes('com.journeyapps:zxing-android-embedded')) {
    gradle = gradle.replace(
      "    implementation project(':capacitor-android')",
      `    implementation project(':capacitor-android')\n${ZXING_DEP}`,
    )
  }

  if (!gradle.includes('DSHX_RELEASE_ABI_FILTER')) {
    gradle = gradle.replace(
      '        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',
      [
        '        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"',
        "        if (System.getenv('DSHX_RELEASE_ABI_FILTER') == '1') {",
        '            ndk {',
        "                abiFilters 'arm64-v8a', 'armeabi-v7a'",
        '            }',
        '        }',
      ].join('\n'),
    )
  }

  if (!gradle.includes('DSHX_ANDROID_KEYSTORE')) {
    const signingBlock = [
      '    signingConfigs {',
      '        release {',
      "            def ksPath = System.getenv('DSHX_ANDROID_KEYSTORE')",
      '            if (ksPath) {',
      '                storeFile file(ksPath)',
      "                storePassword System.getenv('DSHX_ANDROID_KEYSTORE_PASSWORD')",
      "                keyAlias System.getenv('DSHX_ANDROID_KEY_ALIAS')",
      "                keyPassword(System.getenv('DSHX_ANDROID_KEY_PASSWORD') ?: System.getenv('DSHX_ANDROID_KEYSTORE_PASSWORD'))",
      '                enableV1Signing true',
      '                enableV2Signing true',
      '                enableV3Signing true',
      '            }',
      '        }',
      '    }',
      '    buildTypes {',
    ].join('\n')
    gradle = gradle.replace('    buildTypes {', signingBlock)
  }

  if (!gradle.includes("signingConfigs.release")) {
    gradle = gradle.replace(
      '        release {\n            minifyEnabled false',
      [
        '        release {',
        "            if (System.getenv('DSHX_ANDROID_KEYSTORE')) {",
        '                signingConfig signingConfigs.release',
        '            }',
        '            minifyEnabled false',
      ].join('\n'),
    )
  }

  return gradle
}

function runCapacitor(args, cwd) {
  const capBin = join(MOBILE_DIR, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor')
  const res = spawnSync(process.execPath, [capBin, ...args], {
    cwd,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    throw new Error(`Capacitor command failed (${res.status}): cap ${args.join(' ')}`)
  }
}

export function prepareAndroid() {
  syncWeb()

  if (!existsSync(ANDROID_DIR)) {
    runCapacitor(['add', 'android'], MOBILE_DIR)
  } else {
    runCapacitor(['sync', 'android'], MOBILE_DIR)
  }

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const versionName = String(pkg.version || '0.1.0')
  const versionCode = computeVersionCode(versionName)

  // 复制原生 Java 类
  const javaDestDir = join(ANDROID_DIR, 'app', 'src', 'main', 'java', 'com', 'dshx', 'mobile')
  const javaSrcDir = join(OVERLAY_ANDROID, 'java', 'com', 'dshx', 'mobile')
  mkdirSync(javaDestDir, { recursive: true })
  for (const name of [
    'MainActivity.java',
    'SecureTokenStore.java',
    'DshWebViewActivity.java',
    'QrScanActivity.java',
    'NoticeSyncService.java',
    'DshxNativePlugin.java',
    'FloatingWindowService.java',
  ]) {
    copyFileSync(join(javaSrcDir, name), join(javaDestDir, name))
  }

  // 复制网络安全配置
  const xmlDestDir = join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'xml')
  mkdirSync(xmlDestDir, { recursive: true })
  copyFileSync(
    join(OVERLAY_ANDROID, 'res', 'xml', 'network_security_config.xml'),
    join(xmlDestDir, 'network_security_config.xml'),
  )

  // 用 DSH-X 图标替换 Capacitor 默认图标，并移除 adaptive xml 避免显示默认机器人图标
  if (existsSync(APP_ICON_SRC)) {
    const resDir = join(ANDROID_DIR, 'app', 'src', 'main', 'res')
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const mipDir = join(resDir, `mipmap-${density}`)
      if (existsSync(mipDir)) {
        copyFileSync(APP_ICON_SRC, join(mipDir, 'ic_launcher.png'))
        copyFileSync(APP_ICON_SRC, join(mipDir, 'ic_launcher_round.png'))
        copyFileSync(APP_ICON_SRC, join(mipDir, 'ic_launcher_foreground.png'))
      }
    }
    for (const stale of [
      join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
      join(resDir, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'),
      join(resDir, 'drawable-v24', 'ic_launcher_foreground.xml'),
    ]) {
      rmSync(stale, { force: true })
    }
  }

  // 修补 AndroidManifest.xml 与 app/build.gradle
  const manifestPath = join(ANDROID_DIR, 'app', 'src', 'main', 'AndroidManifest.xml')
  writeFileSync(manifestPath, patchManifest(readFileSync(manifestPath, 'utf8')), 'utf8')

  const gradlePath = join(ANDROID_DIR, 'app', 'build.gradle')
  writeFileSync(
    gradlePath,
    patchAppBuildGradle(readFileSync(gradlePath, 'utf8'), { versionName, versionCode }),
    'utf8',
  )

  return { androidDir: ANDROID_DIR, versionName, versionCode }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = prepareAndroid()
  console.log(`Prepared Android project at ${info.androidDir} (${info.versionName}, code=${info.versionCode})`)
}
