package com.dshx.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 后台通知同步服务：
 * 定时从已配对主机拉取 `/_dshx/api/notices`（与电脑端 `dsh-x-desktop-notify` 联动），
 * 区分「等你确认」高优通道与「任务完成与提醒」默认通道弹出系统原生通知，点击直达对应实例。
 */
public class NoticeSyncService extends Service {
    public static final String CHANNEL_APPROVAL = "dshx_approval";
    public static final String CHANNEL_DONE = "dshx_done";
    public static final String CHANNEL_BG_SYNC = "dshx_bg_sync";

    private static final String PREFS_NAME = "dshx_notice_sync";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_HOST_ID = "hostId";
    private static final String KEY_HOST_NAME = "hostName";
    private static final String KEY_ORIGINS = "origins";
    private static final String KEY_CURSOR_BOOT = "cursorBoot";
    private static final String KEY_CURSOR_SEQ = "cursorSeq";

    private static final int FOREGROUND_ID = 1001;
    private static final long POLL_INTERVAL_SECONDS = 8L;
    private static final AtomicInteger NEXT_NOTIFY_ID = new AtomicInteger(2000);

    private ScheduledExecutorService scheduler;
    private SecureTokenStore tokenStore;

    /**
     * 前台 Activity 计数：App 自己在前台时不需要那条「后台通知连接」常驻通知，
     * 切到后台（计数归零）再重新进入前台服务，保证锁屏后仍能收通知。
     */
    private static final AtomicInteger STARTED_ACTIVITIES = new AtomicInteger();
    private static volatile NoticeSyncService instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        tokenStore = new SecureTokenStore(this);
        ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!isEnabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (isAppVisible()) {
            hideForegroundNotice();
        } else {
            showForegroundNoticeSafe();
        }
        startPolling();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopPolling();
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    /** App 是否有可见界面（MainActivity / DshWebViewActivity / QrScanActivity 任一在前台）。 */
    public static boolean isAppVisible() {
        return STARTED_ACTIVITIES.get() > 0;
    }

    public static void onActivityStarted() {
        if (STARTED_ACTIVITIES.incrementAndGet() == 1) {
            NoticeSyncService svc = instance;
            if (svc != null) {
                svc.hideForegroundNotice();
            }
        }
    }

    public static void onActivityStopped() {
        if (STARTED_ACTIVITIES.decrementAndGet() > 0) {
            return;
        }
        STARTED_ACTIVITIES.set(0);
        NoticeSyncService svc = instance;
        if (svc != null) {
            svc.showForegroundNoticeSafe();
        }
    }

    private void showForegroundNoticeSafe() {
        if (!isEnabled(this)) {
            return;
        }
        try {
            startAsForeground();
        } catch (Exception ignored) {
            // Android 12+ 后台启动前台服务受限：退化成普通后台服务继续轮询，下次进前台再恢复。
        }
    }

    private void hideForegroundNotice() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startAsForeground() {
        SharedPreferences prefs = prefs(this);
        String hostName = prefs.getString(KEY_HOST_NAME, "");
        String contentText = hostName.isEmpty()
            ? "正在接收电脑端任务与确认提醒"
            : ("正在接收 " + hostName + " 的任务提醒");

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // 尽量做到「隐形」：安静、不进锁屏、不占 badge、可一键划掉；
        // App 打开时由 hideForegroundNotice() 直接撤掉，只有退到后台才会重新出现。
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_BG_SYNC)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("DSH-X 后台通知")
            .setContentText(contentText)
            .setOngoing(false)
            .setAutoCancel(false)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setContentIntent(pendingIntent)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FOREGROUND_ID, notification);
        }
    }

    private synchronized void startPolling() {
        if (scheduler != null && !scheduler.isShutdown()) {
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleWithFixedDelay(this::pollOnceSafe, 1L, POLL_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    private synchronized void stopPolling() {
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }
    }

    private void pollOnceSafe() {
        try {
            pollOnce();
        } catch (Exception ignored) {
        }
    }

    private void pollOnce() {
        SharedPreferences prefs = prefs(this);
        if (!prefs.getBoolean(KEY_ENABLED, false)) {
            return;
        }
        String hostId = prefs.getString(KEY_HOST_ID, "");
        if (hostId.isEmpty()) {
            return;
        }
        String token = tokenStore.getToken(hostId);
        if (token.isEmpty()) {
            return;
        }
        List<String> origins = readOrigins(prefs);
        if (origins.isEmpty()) {
            return;
        }

        String boot = prefs.getString(KEY_CURSOR_BOOT, "");
        long since = prefs.getLong(KEY_CURSOR_SEQ, 0L);
        String query = boot.isEmpty()
            ? "/_dshx/api/notices?init=1"
            : ("/_dshx/api/notices?boot=" + boot + "&since=" + since);

        for (String origin : origins) {
            JSONObject resp = fetchJson(origin + query, token);
            if (resp == null || !resp.optBoolean("ok", false)) {
                continue;
            }
            String nextBoot = resp.optString("boot", "");
            long nextSeq = resp.optLong("seq", since);
            JSONArray notices = resp.optJSONArray("notices");
            if (notices != null && !boot.isEmpty()) {
                for (int i = 0; i < notices.length(); i++) {
                    JSONObject item = notices.optJSONObject(i);
                    if (item != null) {
                        showNotice(this, origin, token, item);
                    }
                }
            }
            if (!nextBoot.isEmpty()) {
                prefs.edit()
                    .putString(KEY_CURSOR_BOOT, nextBoot)
                    .putLong(KEY_CURSOR_SEQ, nextSeq)
                    .apply();
            }
            return;
        }
    }

    public static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) {
            return;
        }
        NotificationChannel approval = new NotificationChannel(
            CHANNEL_APPROVAL,
            "等你确认",
            NotificationManager.IMPORTANCE_HIGH
        );
        approval.setDescription("工具请求确认与需要人工决定的提醒");
        approval.enableVibration(true);

        NotificationChannel done = new NotificationChannel(
            CHANNEL_DONE,
            "任务完成与提醒",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        done.setDescription("会话轮次完成、失败或阻断提醒");

        NotificationChannel bgSync = new NotificationChannel(
            CHANNEL_BG_SYNC,
            "后台通知连接",
            NotificationManager.IMPORTANCE_MIN
        );
        bgSync.setDescription("保持手机接收电脑端通知的静默后台状态");
        bgSync.setShowBadge(false);
        bgSync.setSound(null, null);
        bgSync.enableVibration(false);
        bgSync.setLockscreenVisibility(Notification.VISIBILITY_SECRET);

        nm.createNotificationChannel(approval);
        nm.createNotificationChannel(done);
        nm.createNotificationChannel(bgSync);
    }

    public static void saveConfig(Context context, boolean enabled, String hostId, String hostName, List<String> origins) {
        SharedPreferences prefs = prefs(context);
        String prevHostId = prefs.getString(KEY_HOST_ID, "");
        JSONArray arr = new JSONArray();
        if (origins != null) {
            for (String item : origins) {
                if (item != null && !item.trim().isEmpty()) {
                    arr.put(item.trim());
                }
            }
        }
        SharedPreferences.Editor editor = prefs.edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putString(KEY_HOST_ID, hostId != null ? hostId : "")
            .putString(KEY_HOST_NAME, hostName != null ? hostName : "")
            .putString(KEY_ORIGINS, arr.toString());
        if (!enabled || (hostId != null && !hostId.equals(prevHostId))) {
            editor.remove(KEY_CURSOR_BOOT).remove(KEY_CURSOR_SEQ);
        }
        editor.apply();
    }

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    private static void showNotice(Context context, String origin, String token, JSONObject item) {
        ensureChannels(context);
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) {
            return;
        }

        String kind = item.optString("kind", "done");
        String channelId = "approval".equals(kind) ? CHANNEL_APPROVAL : CHANNEL_DONE;
        String title = item.optString("title", "DSH-X");
        String body = item.optString("body", "");
        String instanceKey = item.optString("instanceKey", "");
        String instanceName = item.optString("instanceName", "");
        boolean silent = item.optBoolean("silent", false);

        String displayTitle = instanceName.isEmpty() ? title : (title + " · " + instanceName);
        int notifyId = NEXT_NOTIFY_ID.incrementAndGet();

        Intent tapIntent;
        if (!instanceKey.isEmpty() && !origin.isEmpty() && !token.isEmpty()) {
            tapIntent = new Intent(context, DshWebViewActivity.class);
            tapIntent.putExtra(DshWebViewActivity.EXTRA_ORIGIN, origin);
            tapIntent.putExtra(DshWebViewActivity.EXTRA_INSTANCE_KEY, instanceKey);
            tapIntent.putExtra(DshWebViewActivity.EXTRA_TOKEN, token);
            tapIntent.putExtra(DshWebViewActivity.EXTRA_TITLE, instanceName);
        } else {
            tapIntent = new Intent(context, MainActivity.class);
        }
        tapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            notifyId,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(displayTitle)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setSilent(silent)
            .setPriority("approval".equals(kind) ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent);

        nm.notify(notifyId, builder.build());
    }

    private static JSONObject fetchJson(String urlStr, String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4_000);
            conn.setReadTimeout(4_000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) {
                return null;
            }
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                }
                return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static List<String> readOrigins(SharedPreferences prefs) {
        List<String> list = new ArrayList<>();
        String raw = prefs.getString(KEY_ORIGINS, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String val = arr.optString(i, "").trim();
                if (!val.isEmpty()) {
                    list.add(val);
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
