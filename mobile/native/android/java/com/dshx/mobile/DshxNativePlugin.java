package com.dshx.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "DshxNative",
    permissions = {
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class DshxNativePlugin extends Plugin {
    private static final String UPDATE_APK_FILENAME = "dsh-x-update.apk";
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private SecureTokenStore tokenStore;

    @Override
    public void load() {
        tokenStore = new SecureTokenStore(getContext());
        NoticeSyncService.ensureChannels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        updateExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getPlatformInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        call.resolve(ret);
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
            ret.put("versionName", info.versionName != null ? info.versionName : "");
            ret.put("versionCode", versionCode);
        } catch (Exception ex) {
            ret.put("versionName", "");
            ret.put("versionCode", 0);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String rawUrl = call.getString("url", "");
        String clean = rawUrl != null ? rawUrl.trim() : "";
        if (!clean.startsWith("https://") && !clean.startsWith("http://")) {
            call.reject("Invalid URL scheme");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(clean));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception ex) {
            call.reject("Failed to open URL: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String rawUrl = call.getString("url", "");
        String cleanUrl = rawUrl != null ? rawUrl.trim() : "";
        if (!cleanUrl.startsWith("https://")) {
            call.reject("APK download URL must use HTTPS");
            return;
        }
        String rawSha = call.getString("expectedSha256", "");
        String expectedSha256 = normalizeSha256(rawSha);

        updateExecutor.execute(() -> {
            File cacheDir = getContext().getCacheDir();
            File tmpFile = new File(cacheDir, UPDATE_APK_FILENAME + ".part");
            File targetFile = new File(cacheDir, UPDATE_APK_FILENAME);
            HttpURLConnection conn = null;
            try {
                if (tmpFile.exists()) {
                    tmpFile.delete();
                }

                String currentUrl = cleanUrl;
                for (int redirect = 0; redirect < 6; redirect++) {
                    URL url = new URL(currentUrl);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15_000);
                    conn.setReadTimeout(30_000);
                    conn.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream");
                    conn.setRequestProperty("User-Agent", "DSH-X-Mobile");
                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        conn = null;
                        if (location == null || location.trim().isEmpty()) {
                            throw new IllegalStateException("Redirect missing Location");
                        }
                        URL next = new URL(url, location.trim());
                        if (!"https".equalsIgnoreCase(next.getProtocol())) {
                            throw new IllegalStateException("Refusing non-HTTPS APK redirect");
                        }
                        currentUrl = next.toString();
                        continue;
                    }
                    break;
                }

                if (conn == null) {
                    throw new IllegalStateException("Failed to open APK connection");
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("Download failed (HTTP " + code + ")");
                }

                long totalBytes = conn.getContentLengthLong();
                long downloaded = 0L;
                long lastEmitAt = 0L;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");

                emitProgress("downloading", 0L, totalBytes);
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(tmpFile)) {
                    byte[] buf = new byte[16 * 1024];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                        digest.update(buf, 0, read);
                        downloaded += read;
                        long now = System.currentTimeMillis();
                        if (now - lastEmitAt >= 200) {
                            lastEmitAt = now;
                            emitProgress("downloading", downloaded, totalBytes);
                        }
                    }
                    out.flush();
                }

                emitProgress("verifying", downloaded, totalBytes > 0 ? totalBytes : downloaded);
                String actualSha256 = toHexLower(digest.digest());
                if (!expectedSha256.isEmpty() && !expectedSha256.equals(actualSha256)) {
                    tmpFile.delete();
                    call.reject("APK 校验失败，请重新下载");
                    return;
                }

                if (targetFile.exists()) {
                    targetFile.delete();
                }
                if (!tmpFile.renameTo(targetFile)) {
                    throw new IllegalStateException("Failed to finalize downloaded APK");
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent permIntent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                    );
                    permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(permIntent);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("needsPermission", true);
                    ret.put("apkReady", true);
                    ret.put("sha256", actualSha256);
                    call.resolve(ret);
                    return;
                }

                Uri apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    targetFile
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(installIntent);

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("installing", true);
                ret.put("needsPermission", false);
                ret.put("sha256", actualSha256);
                call.resolve(ret);
            } catch (Exception ex) {
                if (tmpFile.exists()) {
                    tmpFile.delete();
                }
                call.reject(ex.getMessage() != null ? ex.getMessage() : "APK download failed", ex);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    private void emitProgress(String phase, long downloaded, long total) {
        int percent = total > 0 ? (int) Math.max(0, Math.min(100, (downloaded * 100L) / total)) : -1;
        JSObject data = new JSObject();
        data.put("phase", phase);
        data.put("downloaded", downloaded);
        data.put("total", total);
        data.put("percent", percent);
        notifyListeners("apkDownloadProgress", data);
    }

    private static String normalizeSha256(String raw) {
        if (raw == null) {
            return "";
        }
        String clean = raw.trim().toLowerCase(Locale.ROOT);
        if (clean.startsWith("sha256:")) {
            clean = clean.substring("sha256:".length()).trim();
        }
        return clean.matches("[0-9a-f]{64}") ? clean : "";
    }

    private static String toHexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    @PluginMethod
    public void saveHostToken(PluginCall call) {
        String hostId = call.getString("hostId", "");
        String token = call.getString("token", "");
        if (hostId == null || hostId.isEmpty() || token == null || token.isEmpty()) {
            call.reject("Missing hostId or token");
            return;
        }
        try {
            tokenStore.saveToken(hostId, token);
            call.resolve();
        } catch (Exception ex) {
            call.reject("Failed to store token securely: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void getHostToken(PluginCall call) {
        String hostId = call.getString("hostId", "");
        JSObject ret = new JSObject();
        ret.put("token", tokenStore.getToken(hostId));
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteHostToken(PluginCall call) {
        String hostId = call.getString("hostId", "");
        tokenStore.deleteToken(hostId);
        call.resolve();
    }

    @PluginMethod
    public void scanQr(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        launchQrScanner(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            launchQrScanner(call);
        } else {
            call.reject("Camera permission is required to scan QR codes");
        }
    }

    private void launchQrScanner(PluginCall call) {
        Intent intent = new Intent(getContext(), QrScanActivity.class);
        startActivityForResult(call, intent, "handleQrResult");
    }

    @ActivityCallback
    private void handleQrResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            ret.put("text", "");
            call.resolve(ret);
            return;
        }
        String text = result.getData().getStringExtra(QrScanActivity.EXTRA_QR_RESULT);
        JSObject ret = new JSObject();
        ret.put("cancelled", false);
        ret.put("text", text != null ? text : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void openDshInstance(PluginCall call) {
        String origin = call.getString("origin", "");
        String instanceKey = call.getString("instanceKey", "");
        String token = call.getString("token", "");
        String instanceTitle = call.getString("instanceTitle", "");
        Boolean darkTheme = call.getBoolean("darkTheme");
        if (origin == null || origin.isEmpty() || instanceKey == null || instanceKey.isEmpty() || token == null || token.isEmpty()) {
            call.reject("Missing origin, instanceKey, or token");
            return;
        }
        Intent intent = new Intent(getContext(), DshWebViewActivity.class);
        intent.putExtra(DshWebViewActivity.EXTRA_ORIGIN, origin);
        intent.putExtra(DshWebViewActivity.EXTRA_INSTANCE_KEY, instanceKey);
        intent.putExtra(DshWebViewActivity.EXTRA_TOKEN, token);
        intent.putExtra(DshWebViewActivity.EXTRA_TITLE, instanceTitle != null ? instanceTitle : "");
        if (darkTheme != null) {
            intent.putExtra(DshWebViewActivity.EXTRA_DARK_THEME, darkTheme);
        }
        startActivityForResult(call, intent, "handleWebViewClosed");
    }

    @ActivityCallback
    private void handleWebViewClosed(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        JSObject ret = new JSObject();
        ret.put("closed", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getNotificationState(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject ret = new JSObject();
        ret.put("enabled", NoticeSyncService.isEnabled(getContext()));
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void configureNotifications(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        if (enabled
            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        applyNotificationConfig(call, enabled);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
        if (!granted) {
            JSObject ret = new JSObject();
            ret.put("enabled", false);
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        applyNotificationConfig(call, Boolean.TRUE.equals(call.getBoolean("enabled", false)));
    }

    private void applyNotificationConfig(PluginCall call, boolean enabled) {
        String hostId = call.getString("hostId", "");
        String hostName = call.getString("hostName", "");
        List<String> origins = new ArrayList<>();
        JSArray arr = call.getArray("origins");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String val = arr.optString(i, "").trim();
                if (!val.isEmpty()) {
                    origins.add(val);
                }
            }
        }

        NoticeSyncService.saveConfig(getContext(), enabled, hostId, hostName, origins);
        Intent serviceIntent = new Intent(getContext(), NoticeSyncService.class);
        if (enabled && hostId != null && !hostId.isEmpty() && !origins.isEmpty()) {
            ContextCompat.startForegroundService(getContext(), serviceIntent);
        } else {
            getContext().stopService(serviceIntent);
        }

        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject ret = new JSObject();
        ret.put("enabled", enabled && granted);
        ret.put("granted", granted);
        call.resolve(ret);
    }
}
