package com.dshx.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
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
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "DshxNative",
    permissions = {
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class DshxNativePlugin extends Plugin {
    private SecureTokenStore tokenStore;

    @Override
    public void load() {
        tokenStore = new SecureTokenStore(getContext());
        NoticeSyncService.ensureChannels(getContext());
    }

    @PluginMethod
    public void getPlatformInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        call.resolve(ret);
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
