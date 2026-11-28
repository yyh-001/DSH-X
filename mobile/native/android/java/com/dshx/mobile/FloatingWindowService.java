package com.dshx.mobile;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.Toast;

/**
 * 系统级悬浮窗（悬浮球）：
 * 1. 走 `SYSTEM_ALERT_WINDOW` 的 `TYPE_APPLICATION_OVERLAY`，App 切到后台甚至回到桌面后仍能显示；
 * 2. 直径 44dp 的圆形小球（应用图标 + 在线绿点），可拖动、位置记忆，点按回到 DSH-X；
 * 3. 默认关闭，需要用户在设置里打开并授予「显示在其他应用上层」权限（长按小球也会关闭）。
 */
public class FloatingWindowService extends Service {
    public static final String PREFS_NAME = "dshx_floating_window";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_X = "x";
    private static final String KEY_Y = "y";
    private static final int BUBBLE_DP = 44;

    private WindowManager windowManager;
    private FrameLayout bubble;
    private WindowManager.LayoutParams params;

    public static boolean canDrawOverlays(Context context) {
        if (context == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        return Settings.canDrawOverlays(context);
    }

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply();
    }

    /** 只有在已授权时才真的起服务，避免用户拒绝权限后反复弹系统页。 */
    public static void start(Context context) {
        if (!isEnabled(context) || !canDrawOverlays(context)) {
            return;
        }
        try {
            context.startService(new Intent(context, FloatingWindowService.class));
        } catch (Exception ignored) {
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, FloatingWindowService.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!canDrawOverlays(this)) {
            setEnabled(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        showBubble();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        removeBubble();
        super.onDestroy();
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void showBubble() {
        if (bubble != null) {
            return;
        }
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        if (windowManager == null) {
            stopSelf();
            return;
        }

        bubble = buildBubble();

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
            dp(BUBBLE_DP),
            dp(BUBBLE_DP),
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        params.x = prefs.getInt(KEY_X, 0);
        params.y = prefs.getInt(KEY_Y, dp(140));
        clampToScreen();

        try {
            windowManager.addView(bubble, params);
        } catch (Exception ex) {
            stopSelf();
        }
    }

    private FrameLayout buildBubble() {
        FrameLayout container = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.argb(232, 22, 24, 30));
        bg.setStroke(dp(1), Color.argb(46, 255, 255, 255));
        container.setBackground(bg);
        container.setElevation(dp(6));
        container.setContentDescription("DSH-X 悬浮窗");

        ImageView icon = new ImageView(this);
        try {
            icon.setImageDrawable(getPackageManager().getApplicationIcon(getPackageName()));
        } catch (Exception ignored) {
        }
        FrameLayout.LayoutParams iconParams = new FrameLayout.LayoutParams(dp(26), dp(26));
        iconParams.gravity = Gravity.CENTER;
        container.addView(icon, iconParams);

        View dot = new View(this);
        GradientDrawable dotBg = new GradientDrawable();
        dotBg.setShape(GradientDrawable.OVAL);
        dotBg.setColor(Color.parseColor("#22C55E"));
        dot.setBackground(dotBg);
        FrameLayout.LayoutParams dotParams = new FrameLayout.LayoutParams(dp(9), dp(9));
        dotParams.gravity = Gravity.BOTTOM | Gravity.END;
        dotParams.setMargins(0, 0, dp(3), dp(3));
        container.addView(dot, dotParams);

        container.setOnClickListener(v -> openApp());
        container.setOnLongClickListener(v -> {
            setEnabled(this, false);
            Toast.makeText(this, "已关闭悬浮窗", Toast.LENGTH_SHORT).show();
            stopSelf();
            return true;
        });
        container.setOnTouchListener(new View.OnTouchListener() {
            private float downRawX;
            private float downRawY;
            private int startX;
            private int startY;
            private boolean dragging;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downRawX = event.getRawX();
                        downRawY = event.getRawY();
                        startX = params.x;
                        startY = params.y;
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - downRawX;
                        float dy = event.getRawY() - downRawY;
                        int slop = ViewConfiguration.get(FloatingWindowService.this).getScaledTouchSlop();
                        if (!dragging && Math.abs(dx) < slop && Math.abs(dy) < slop) {
                            return true;
                        }
                        dragging = true;
                        params.x = startX + Math.round(dx);
                        params.y = startY + Math.round(dy);
                        clampToScreen();
                        try {
                            windowManager.updateViewLayout(bubble, params);
                        } catch (Exception ignored) {
                        }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (dragging) {
                            savePosition();
                        } else if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                            view.performClick();
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });
        return container;
    }

    private void clampToScreen() {
        if (params == null) {
            return;
        }
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        int maxX = Math.max(0, metrics.widthPixels - dp(BUBBLE_DP));
        int maxY = Math.max(0, metrics.heightPixels - dp(BUBBLE_DP));
        params.x = Math.max(0, Math.min(maxX, params.x));
        params.y = Math.max(0, Math.min(maxY, params.y));
    }

    private void savePosition() {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putInt(KEY_X, params.x)
            .putInt(KEY_Y, params.y)
            .apply();
    }

    private void openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            startActivity(intent);
        } catch (Exception ignored) {
        }
    }

    private void removeBubble() {
        if (bubble != null && windowManager != null) {
            try {
                windowManager.removeView(bubble);
            } catch (Exception ignored) {
            }
        }
        bubble = null;
    }
}
