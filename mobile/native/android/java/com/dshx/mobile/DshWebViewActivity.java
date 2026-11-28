package com.dshx.mobile;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowInsetsControllerCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 原版 DSH Web 界面全屏承载页：
 * 1. 携带 Bearer Token 请求 `POST /_dshx/api/session/bootstrap` 为当前链路种下 HttpOnly Cookie
 *    （遇 `< 0.2.1` 旧版内核返回 HTTP 404 时自动回落写入同源 `dsh-x-device` Cookie），
 *    再加载 `/_dshx/open/<instanceKey>` 进入原版 DSH；
 * 2. 页面之上悬浮一枚可拖动的实例胶囊（设置里可关闭）：点按弹出底部抽屉式多实例切换器，
 *    支持在当前 WebView 内原地无重启秒切其他运行中实例，也能一键返回控制台。
 */
public class DshWebViewActivity extends AppCompatActivity {
    public static final String EXTRA_ORIGIN = "origin";
    public static final String EXTRA_INSTANCE_KEY = "instanceKey";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_DARK_THEME = "darkTheme";
    public static final String EXTRA_FLOATING_PILL = "floatingPill";

    private static final String NATIVE_UA_MARKER = "DSHXNativeApp/1";
    private static final String PILL_PREFS = "dshx_webview_pill";

    private static final int ICON_CHEVRON_DOWN = 2;
    private static final int ICON_REFRESH = 3;
    private static final int ICON_CHECK = 5;
    private static final int ICON_CHEVRON_RIGHT = 6;
    private static final int ICON_ALERT = 7;

    private static final class InstanceItem {
        final String key;
        final String displayTitle;
        final String targetLabel;
        final boolean ready;

        InstanceItem(String key, String displayTitle, String targetLabel, boolean ready) {
            this.key = key;
            this.displayTitle = displayTitle;
            this.targetLabel = targetLabel;
            this.ready = ready;
        }
    }

    /** 24×24 几何矢量绘制图标，避免各机型的 Unicode 字体基线歪斜与锯齿。 */
    private static final class VectorIconView extends View {
        private final int kind;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final RectF oval = new RectF();
        private float strokeDp = 1.9f;

        VectorIconView(Context context, int kind, int color, float strokeDp) {
            super(context);
            this.kind = kind;
            this.strokeDp = strokeDp;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setColor(color);
        }

        void setIconColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float w = getWidth();
            float h = getHeight();
            if (w <= 0 || h <= 0) {
                return;
            }
            float s = Math.min(w, h) / 24f;
            float ox = (w - 24f * s) * 0.5f;
            float oy = (h - 24f * s) * 0.5f;
            paint.setStrokeWidth(strokeDp * getResources().getDisplayMetrics().density * 0.85f);

            canvas.save();
            canvas.translate(ox, oy);
            path.reset();

            switch (kind) {
                case ICON_CHEVRON_DOWN:
                    path.moveTo(7f * s, 10f * s);
                    path.lineTo(12f * s, 15f * s);
                    path.lineTo(17f * s, 10f * s);
                    canvas.drawPath(path, paint);
                    break;
                case ICON_REFRESH:
                    oval.set(4.5f * s, 4.5f * s, 19.5f * s, 19.5f * s);
                    path.addArc(oval, -20f, 295f);
                    path.moveTo(19.5f * s, 5f * s);
                    path.lineTo(19.5f * s, 9.8f * s);
                    path.lineTo(14.7f * s, 9.8f * s);
                    canvas.drawPath(path, paint);
                    break;
                case ICON_CHECK:
                    path.moveTo(5.5f * s, 12.8f * s);
                    path.lineTo(10f * s, 17.2f * s);
                    path.lineTo(18.5f * s, 7.5f * s);
                    canvas.drawPath(path, paint);
                    break;
                case ICON_CHEVRON_RIGHT:
                    path.moveTo(9.5f * s, 7f * s);
                    path.lineTo(14.5f * s, 12f * s);
                    path.lineTo(9.5f * s, 17f * s);
                    canvas.drawPath(path, paint);
                    break;
                case ICON_ALERT:
                    canvas.drawCircle(12f * s, 12f * s, 9f * s, paint);
                    path.moveTo(12f * s, 8f * s);
                    path.lineTo(12f * s, 12.8f * s);
                    canvas.drawPath(path, paint);
                    Paint dotPaint = new Paint(paint);
                    dotPaint.setStyle(Paint.Style.FILL);
                    canvas.drawCircle(12f * s, 16.2f * s, 1.15f * s, dotPaint);
                    break;
                default:
                    break;
            }
            canvas.restore();
        }
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final List<InstanceItem> cachedInstances = new ArrayList<>();

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout floatingPill;
    private TextView switcherLabel;
    private TextView switcherCount;
    private LinearLayout errorOverlay;
    private TextView errorMessageView;
    private Dialog switcherDialog;
    private LinearLayout sheetListContainer;
    private TextView sheetStatusView;

    private ValueCallback<Uri[]> pendingFileCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private String targetOrigin = "";
    private String instanceKey = "";
    private String instanceTitle = "";
    private String bearerToken = "";
    private boolean darkTheme = false;
    private boolean floatingPillEnabled = true;
    private boolean pillPositionApplied = false;
    private boolean fetchingInstances = false;
    private String instancesFetchError = "";

    @Override
    protected void onStart() {
        super.onStart();
        NoticeSyncService.onActivityStarted();
    }

    @Override
    protected void onStop() {
        NoticeSyncService.onActivityStopped();
        super.onStop();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        targetOrigin = safeTrim(getIntent().getStringExtra(EXTRA_ORIGIN));
        instanceKey = safeTrim(getIntent().getStringExtra(EXTRA_INSTANCE_KEY));
        instanceTitle = safeTrim(getIntent().getStringExtra(EXTRA_TITLE));
        bearerToken = safeTrim(getIntent().getStringExtra(EXTRA_TOKEN));
        floatingPillEnabled = !getIntent().hasExtra(EXTRA_FLOATING_PILL)
            || getIntent().getBooleanExtra(EXTRA_FLOATING_PILL, true);

        if (getIntent().hasExtra(EXTRA_DARK_THEME)) {
            darkTheme = getIntent().getBooleanExtra(EXTRA_DARK_THEME, false);
        } else {
            int mask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            darkTheme = mask == Configuration.UI_MODE_NIGHT_YES;
        }

        applySystemBarColors();

        fileChooserLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (pendingFileCallback == null) {
                    return;
                }
                Uri[] uris = WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData());
                pendingFileCallback.onReceiveValue(uris);
                pendingFileCallback = null;
            }
        );

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(colorBg());

        FrameLayout contentWrap = new FrameLayout(this);

        webView = new WebView(this);
        contentWrap.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(ColorStateList.valueOf(colorAccent()));
        progressBar.setProgressBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(2)
        );
        progressParams.gravity = Gravity.TOP;
        contentWrap.addView(progressBar, progressParams);

        errorOverlay = buildErrorOverlay();
        errorOverlay.setVisibility(View.GONE);
        contentWrap.addView(errorOverlay, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // 悬浮胶囊最后加：盖在错误页之上，页面挂了也还能切换实例或返回控制台。
        if (floatingPillEnabled) {
            floatingPill = buildFloatingPill();
            FrameLayout.LayoutParams pillParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(36)
            );
            pillParams.leftMargin = 0;
            pillParams.topMargin = dp(10);
            contentWrap.addView(floatingPill, pillParams);
        }

        root.addView(contentWrap, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        setContentView(root);
        configureWebView();
        updateSwitcherHeaderText();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setResult(RESULT_OK);
                    finish();
                }
            }
        });

        if (targetOrigin.isEmpty() || instanceKey.isEmpty() || bearerToken.isEmpty()) {
            showError("Missing host origin, instance key, or device token.");
            return;
        }
        bootstrapAndOpen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 首次拿到焦点时布局已经完成，此时恢复胶囊位置才拿得到真实宽高。
        if (hasFocus && !pillPositionApplied && floatingPill != null && floatingPill.getParent() instanceof View) {
            pillPositionApplied = true;
            restorePillPosition(floatingPill, (View) floatingPill.getParent());
        }
    }

    private void applySystemBarColors() {
        Window window = getWindow();
        if (window == null) {
            return;
        }
        int barColor = colorBarBg();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setStatusBarColor(barColor);
            window.setNavigationBarColor(colorBg());
        }
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!darkTheme);
        controller.setAppearanceLightNavigationBars(!darkTheme);
    }

    /**
     * 悬浮实例胶囊：48dp 宽的自适应明暗胶囊（状态点 + 实例名 + 运行中数量），
     * 可拖动，点按打开底部实例切换抽屉；位置按内容区比例持久化。
     */
    private LinearLayout buildFloatingPill() {
        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp(11), 0, dp(9), 0);
        int bg = darkTheme ? Color.argb(214, 24, 26, 32) : Color.argb(228, 255, 255, 255);
        pill.setBackground(makeRippleDrawable(bg, dp(999), dp(1), colorDivider()));
        pill.setElevation(dp(6));
        pill.setClickable(true);
        pill.setFocusable(true);
        pill.setContentDescription("切换实例");

        View dot = makeGlowingDot(colorGreen());
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(8), dp(8));
        dotParams.rightMargin = dp(6);
        pill.addView(dot, dotParams);

        switcherLabel = new TextView(this);
        switcherLabel.setTextColor(colorText());
        switcherLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        switcherLabel.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        switcherLabel.setSingleLine(true);
        switcherLabel.setEllipsize(TextUtils.TruncateAt.END);
        switcherLabel.setMaxWidth(dp(132));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        labelParams.rightMargin = dp(2);
        pill.addView(switcherLabel, labelParams);

        switcherCount = new TextView(this);
        switcherCount.setTextColor(colorAccent());
        switcherCount.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f);
        switcherCount.setTypeface(Typeface.DEFAULT_BOLD);
        switcherCount.setPadding(dp(5), dp(1), dp(5), dp(1));
        switcherCount.setBackground(makeRoundedRect(colorAccentSoft(), 0, 0, dp(999)));
        switcherCount.setVisibility(View.GONE);
        LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        countParams.leftMargin = dp(5);
        pill.addView(switcherCount, countParams);

        VectorIconView caret = new VectorIconView(this, ICON_CHEVRON_DOWN, colorMuted(), 2.0f);
        LinearLayout.LayoutParams caretParams = new LinearLayout.LayoutParams(dp(13), dp(13));
        caretParams.leftMargin = dp(3);
        pill.addView(caret, caretParams);

        pill.setOnClickListener(v -> showInstanceSwitcherSheet());
        // 顶部栏去掉后，长按胶囊保留「重载页面」这个动作。
        pill.setOnLongClickListener(v -> {
            if (webView != null) {
                errorOverlay.setVisibility(View.GONE);
                progressBar.setVisibility(View.VISIBLE);
                webView.reload();
            }
            return true;
        });
        attachPillDrag(pill);
        return pill;
    }

    /** 触摸拖动：越过 touchSlop 才进入拖动，松手时按内容区宽高比例记下位置。 */
    private void attachPillDrag(View pill) {
        final float[] down = new float[2];
        final int[] start = new int[2];
        final boolean[] dragging = { false };
        final int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        pill.setOnTouchListener((v, event) -> {
            if (!(v.getLayoutParams() instanceof FrameLayout.LayoutParams)) {
                return false;
            }
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) v.getLayoutParams();
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    down[0] = event.getRawX();
                    down[1] = event.getRawY();
                    start[0] = lp.leftMargin;
                    start[1] = lp.topMargin;
                    dragging[0] = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = event.getRawX() - down[0];
                    float dy = event.getRawY() - down[1];
                    if (!dragging[0] && Math.abs(dx) < slop && Math.abs(dy) < slop) {
                        return true;
                    }
                    dragging[0] = true;
                    View parent = (View) v.getParent();
                    if (parent == null) {
                        return true;
                    }
                    int maxX = Math.max(0, parent.getWidth() - v.getWidth());
                    int maxY = Math.max(0, parent.getHeight() - v.getHeight());
                    lp.leftMargin = Math.max(0, Math.min(maxX, start[0] + Math.round(dx)));
                    lp.topMargin = Math.max(0, Math.min(maxY, start[1] + Math.round(dy)));
                    v.setLayoutParams(lp);
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (dragging[0]) {
                        savePillPosition(v);
                    } else if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                        v.performClick();
                    }
                    return true;
                default:
                    return false;
            }
        });
    }

    private void savePillPosition(View pill) {
        View parent = (View) pill.getParent();
        if (parent == null || !(pill.getLayoutParams() instanceof FrameLayout.LayoutParams)) {
            return;
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) pill.getLayoutParams();
        float maxX = Math.max(1, parent.getWidth() - pill.getWidth());
        float maxY = Math.max(1, parent.getHeight() - pill.getHeight());
        getSharedPreferences(PILL_PREFS, MODE_PRIVATE)
            .edit()
            .putFloat("x", lp.leftMargin / maxX)
            .putFloat("y", lp.topMargin / maxY)
            .apply();
    }

    private void restorePillPosition(View pill, View parent) {
        if (!(pill.getLayoutParams() instanceof FrameLayout.LayoutParams) || parent.getWidth() <= 0) {
            return;
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) pill.getLayoutParams();
        int maxX = Math.max(0, parent.getWidth() - pill.getWidth());
        int maxY = Math.max(0, parent.getHeight() - pill.getHeight());
        SharedPreferences prefs = getSharedPreferences(PILL_PREFS, MODE_PRIVATE);
        if (prefs.contains("x") && prefs.contains("y")) {
            lp.leftMargin = Math.max(0, Math.min(maxX, Math.round(prefs.getFloat("x", 1f) * maxX)));
            lp.topMargin = Math.max(0, Math.min(maxY, Math.round(prefs.getFloat("y", 0f) * maxY)));
        } else {
            lp.leftMargin = Math.max(0, maxX - dp(8));
            lp.topMargin = dp(10);
        }
        pill.setLayoutParams(lp);
    }

    private FrameLayout makeIconTapTarget(int iconKind, int boxPx, int iconPx, int tintColor, String contentDesc) {
        FrameLayout wrap = new FrameLayout(this);
        wrap.setBackground(makeRippleDrawable(Color.TRANSPARENT, dp(10), 0, 0));
        wrap.setClickable(true);
        wrap.setFocusable(true);
        wrap.setContentDescription(contentDesc);

        VectorIconView icon = new VectorIconView(this, iconKind, tintColor, 1.9f);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(iconPx, iconPx);
        lp.gravity = Gravity.CENTER;
        wrap.addView(icon, lp);
        return wrap;
    }

    private void updateSwitcherHeaderText() {
        if (switcherLabel == null) {
            return;
        }
        String matchedTitle = "";
        synchronized (cachedInstances) {
            for (InstanceItem item : cachedInstances) {
                if (item.key.equals(instanceKey)) {
                    matchedTitle = item.displayTitle;
                    break;
                }
            }
            if (switcherCount != null) {
                int count = cachedInstances.size();
                if (count > 1) {
                    switcherCount.setText(String.valueOf(count));
                    switcherCount.setVisibility(View.VISIBLE);
                } else {
                    switcherCount.setVisibility(View.GONE);
                }
            }
        }
        String display = !matchedTitle.isEmpty()
            ? matchedTitle
            : (!instanceTitle.isEmpty() ? instanceTitle : instanceKey);
        switcherLabel.setText(display.isEmpty() ? "DSH" : display);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        String baseUa = settings.getUserAgentString();
        if (baseUa != null && !baseUa.contains(NATIVE_UA_MARKER)) {
            settings.setUserAgentString(baseUa + " " + NATIVE_UA_MARKER);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                }
            }

            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = filePathCallback;
                try {
                    Intent chooser = fileChooserParams.createIntent();
                    fileChooserLauncher.launch(chooser);
                    return true;
                } catch (Exception ex) {
                    pendingFileCallback = null;
                    return false;
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request != null ? request.getUrl() : null;
                if (uri == null) {
                    return false;
                }
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    openExternal(uri);
                    return true;
                }
                String reqOrigin = buildOrigin(uri);
                if (reqOrigin.equalsIgnoreCase(targetOrigin)) {
                    String path = uri.getPath() != null ? uri.getPath() : "";
                    if (path.equals("/_dshx/m") || path.startsWith("/_dshx/m/")) {
                        setResult(RESULT_OK);
                        finish();
                        return true;
                    }
                    if (path.startsWith("/_dshx/open/")) {
                        String nextKey = decodeKeyFromPath(path);
                        if (!nextKey.isEmpty() && !nextKey.equals(instanceKey)) {
                            instanceKey = nextKey;
                            instanceTitle = "";
                            updateSwitcherHeaderText();
                        }
                    }
                    return false;
                }
                if (request.isForMainFrame()) {
                    openExternal(uri);
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    String desc = error != null && error.getDescription() != null
                        ? error.getDescription().toString()
                        : "Failed to load DSH page";
                    showError(desc);
                }
            }
        });
    }

    private void bootstrapAndOpen() {
        errorOverlay.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(targetOrigin + "/_dshx/api/session/bootstrap");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
                conn.setRequestProperty("Accept", "application/json");
                conn.setFixedLengthStreamingMode(0);

                int code = conn.getResponseCode();
                CookieManager cookieManager = CookieManager.getInstance();
                if (code == HttpURLConnection.HTTP_NOT_FOUND) {
                    // 兼容 < 0.2.1-rc.1 的旧版电脑端核心（尚无 /_dshx/api/session/bootstrap 接口）：
                    // 直接将设备 Bearer Token 写入同源 dsh-x-device 会话 Cookie 后继续进入 /_dshx/open/<key>
                    StringBuilder fallbackCookie = new StringBuilder();
                    fallbackCookie.append("dsh-x-device=").append(bearerToken).append("; Path=/; SameSite=Lax");
                    if (targetOrigin.toLowerCase().startsWith("https://")) {
                        fallbackCookie.append("; Secure");
                    }
                    cookieManager.setCookie(targetOrigin, fallbackCookie.toString());
                    cookieManager.flush();
                } else if (code < 200 || code >= 300) {
                    throw new IllegalStateException("Session bootstrap failed (HTTP " + code + ")");
                } else {
                    for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                        if (entry.getKey() != null && entry.getKey().equalsIgnoreCase("Set-Cookie") && entry.getValue() != null) {
                            for (String cookieVal : entry.getValue()) {
                                cookieManager.setCookie(targetOrigin, cookieVal);
                            }
                        }
                    }
                    cookieManager.flush();
                }

                String encodedKey = URLEncoder.encode(instanceKey, StandardCharsets.UTF_8.name()).replace("+", "%20");
                String openUrl = targetOrigin + "/_dshx/open/" + encodedKey;
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        webView.loadUrl(openUrl);
                        fetchRunningInstancesAsync(null);
                    }
                });
            } catch (Exception ex) {
                String msg = ex.getMessage() != null ? ex.getMessage() : "Connection failed";
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        showError(msg);
                    }
                });
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    private void fetchRunningInstancesAsync(@Nullable Runnable onDone) {
        if (targetOrigin.isEmpty() || bearerToken.isEmpty()) {
            return;
        }
        fetchingInstances = true;
        instancesFetchError = "";
        executor.execute(() -> {
            List<InstanceItem> parsed = new ArrayList<>();
            String fetchError = "";
            HttpURLConnection conn = null;
            try {
                URL url = new URL(targetOrigin + "/_dshx/api/instances");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(6_000);
                conn.setReadTimeout(6_000);
                conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
                conn.setRequestProperty("Accept", "application/json");

                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("HTTP " + code);
                }

                String body = readResponseBody(conn.getInputStream());
                JSONObject json = new JSONObject(body);
                JSONArray arr = json.optJSONArray("instances");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item == null) {
                            continue;
                        }
                        String key = safeTrim(item.optString("key", ""));
                        if (key.isEmpty()) {
                            continue;
                        }
                        String ver = safeTrim(item.optString("version", ""));
                        String profile = safeTrim(item.optString("profile", ""));
                        String name = safeTrim(item.optString("name", ""));
                        String title = (!ver.isEmpty() && !profile.isEmpty())
                            ? (ver + " · " + profile)
                            : (!name.isEmpty() ? name : key);
                        String targetLabel = formatTargetBadge(item.opt("target"));
                        boolean ready = item.optBoolean("ready", true);
                        parsed.add(new InstanceItem(key, title, targetLabel, ready));
                    }
                }
            } catch (Exception ex) {
                fetchError = ex.getMessage() != null ? ex.getMessage() : "加载失败";
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }

            final String finalErr = fetchError;
            runOnUiThread(() -> {
                fetchingInstances = false;
                instancesFetchError = finalErr;
                if (finalErr.isEmpty()) {
                    synchronized (cachedInstances) {
                        cachedInstances.clear();
                        cachedInstances.addAll(parsed);
                    }
                }
                updateSwitcherHeaderText();
                renderSwitcherSheetContent();
                if (onDone != null) {
                    onDone.run();
                }
            });
        });
    }

    private void showInstanceSwitcherSheet() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        if (switcherDialog != null && switcherDialog.isShowing()) {
            return;
        }

        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        float radius = dp(22);
        GradientDrawable sheetBg = new GradientDrawable();
        sheetBg.setColor(colorCard());
        sheetBg.setCornerRadii(new float[] { radius, radius, radius, radius, 0f, 0f, 0f, 0f });
        sheet.setBackground(sheetBg);
        sheet.setPadding(dp(16), dp(10), dp(16), dp(24));

        View handle = new View(this);
        handle.setBackground(makeRoundedRect(colorDivider(), 0, 0, dp(999)));
        LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(36), dp(4));
        handleParams.gravity = Gravity.CENTER_HORIZONTAL;
        handleParams.bottomMargin = dp(12);
        sheet.addView(handle, handleParams);

        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setGravity(Gravity.CENTER_VERTICAL);
        headerRow.setPadding(dp(2), 0, dp(2), dp(12));

        TextView titleView = new TextView(this);
        titleView.setText("切换实例");
        titleView.setTextColor(colorText());
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        titleView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        headerRow.addView(titleView, new LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f
        ));

        FrameLayout refreshSheetBtn = makeIconTapTarget(ICON_REFRESH, dp(32), dp(16), colorMuted(), "刷新实例");
        refreshSheetBtn.setOnClickListener(v -> {
            renderSwitcherSheetLoading();
            fetchRunningInstancesAsync(null);
        });
        headerRow.addView(refreshSheetBtn, new LinearLayout.LayoutParams(dp(32), dp(32)));

        TextView consoleBtn = new TextView(this);
        consoleBtn.setText("控制台");
        consoleBtn.setTextColor(colorText());
        consoleBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        consoleBtn.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        consoleBtn.setPadding(dp(12), dp(6), dp(12), dp(6));
        consoleBtn.setBackground(makeRippleDrawable(colorPillBg(), dp(999), dp(1), colorDivider()));
        consoleBtn.setClickable(true);
        consoleBtn.setFocusable(true);
        consoleBtn.setOnClickListener(v -> {
            dismissSwitcherDialog();
            setResult(RESULT_OK);
            finish();
        });
        LinearLayout.LayoutParams consoleParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        consoleParams.leftMargin = dp(6);
        headerRow.addView(consoleBtn, consoleParams);

        sheet.addView(headerRow);

        sheetStatusView = new TextView(this);
        sheetStatusView.setTextColor(colorMuted());
        sheetStatusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        sheetStatusView.setGravity(Gravity.CENTER);
        sheetStatusView.setPadding(dp(8), dp(20), dp(8), dp(20));
        sheet.addView(sheetStatusView);

        ScrollView scroll = new ScrollView(this);
        sheetListContainer = new LinearLayout(this);
        sheetListContainer.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(sheetListContainer, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        sheet.addView(scroll, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        dialog.setContentView(sheet);
        Window win = dialog.getWindow();
        if (win != null) {
            win.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            win.setGravity(Gravity.BOTTOM);
            win.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            win.setDimAmount(0.42f);
        }
        dialog.setOnDismissListener(d -> {
            switcherDialog = null;
            sheetListContainer = null;
            sheetStatusView = null;
        });

        switcherDialog = dialog;
        renderSwitcherSheetContent();
        dialog.show();

        // 每次打开抽屉时静默同步最新实例状态，确保刚启停的实例实时可见
        fetchRunningInstancesAsync(null);
    }

    private void renderSwitcherSheetLoading() {
        if (sheetStatusView == null || sheetListContainer == null) {
            return;
        }
        sheetListContainer.removeAllViews();
        sheetStatusView.setText("正在同步运行中实例…");
        sheetStatusView.setVisibility(View.VISIBLE);
    }

    private void renderSwitcherSheetContent() {
        if (switcherDialog == null || !switcherDialog.isShowing() || sheetListContainer == null || sheetStatusView == null) {
            return;
        }
        List<InstanceItem> items;
        synchronized (cachedInstances) {
            items = new ArrayList<>(cachedInstances);
        }
        sheetListContainer.removeAllViews();

        if (items.isEmpty()) {
            sheetStatusView.setVisibility(View.VISIBLE);
            if (fetchingInstances) {
                sheetStatusView.setText("正在同步运行中实例…");
            } else if (!instancesFetchError.isEmpty()) {
                sheetStatusView.setText("读取失败：" + instancesFetchError);
            } else {
                sheetStatusView.setText("暂无其他运行中的实例");
            }
            return;
        }

        sheetStatusView.setVisibility(View.GONE);
        for (int i = 0; i < items.size(); i++) {
            InstanceItem item = items.get(i);
            boolean isCurrent = item.key.equals(instanceKey);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(14), dp(12), dp(14), dp(12));
            int rowBg = isCurrent ? colorAccentSoft() : colorPillBg();
            int rowBorder = isCurrent ? colorAccent() : colorDivider();
            row.setBackground(makeRippleDrawable(rowBg, dp(14), dp(1), rowBorder));
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(v -> {
                dismissSwitcherDialog();
                if (!isCurrent) {
                    switchToInstance(item.key, item.displayTitle);
                }
            });

            View dot = makeGlowingDot(item.ready ? colorGreen() : Color.parseColor("#D97706"));
            LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(11), dp(11));
            dotParams.rightMargin = dp(11);
            row.addView(dot, dotParams);

            LinearLayout info = new LinearLayout(this);
            info.setOrientation(LinearLayout.VERTICAL);

            TextView nameView = new TextView(this);
            nameView.setText(item.displayTitle);
            nameView.setTextColor(colorText());
            nameView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
            nameView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            nameView.setSingleLine(true);
            nameView.setEllipsize(TextUtils.TruncateAt.END);
            info.addView(nameView);

            TextView subView = new TextView(this);
            subView.setText(item.targetLabel + " · " + (item.ready ? "运行中" : "启动中"));
            subView.setTextColor(colorMuted());
            subView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            info.addView(subView);

            row.addView(info, new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
            ));

            VectorIconView trailing = new VectorIconView(
                this,
                isCurrent ? ICON_CHECK : ICON_CHEVRON_RIGHT,
                isCurrent ? colorAccent() : colorMuted(),
                2.0f
            );
            LinearLayout.LayoutParams trailParams = new LinearLayout.LayoutParams(dp(17), dp(17));
            trailParams.leftMargin = dp(8);
            row.addView(trailing, trailParams);

            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            if (i > 0) {
                rowParams.topMargin = dp(8);
            }
            sheetListContainer.addView(row, rowParams);
        }
    }

    private void switchToInstance(String nextKey, String nextTitle) {
        if (nextKey == null || nextKey.trim().isEmpty() || webView == null) {
            return;
        }
        instanceKey = nextKey.trim();
        instanceTitle = nextTitle != null ? nextTitle.trim() : "";
        updateSwitcherHeaderText();
        errorOverlay.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);
        try {
            String encodedKey = URLEncoder.encode(instanceKey, StandardCharsets.UTF_8.name()).replace("+", "%20");
            webView.loadUrl(targetOrigin + "/_dshx/open/" + encodedKey);
        } catch (Exception ex) {
            showError(ex.getMessage() != null ? ex.getMessage() : "切换实例失败");
        }
    }

    private void dismissSwitcherDialog() {
        if (switcherDialog != null && switcherDialog.isShowing()) {
            switcherDialog.dismiss();
        }
    }

    private LinearLayout buildErrorOverlay() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(colorBg());
        int outerPad = dp(24);
        layout.setPadding(outerPad, outerPad, outerPad, outerPad);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setBackground(makeRoundedRect(colorCard(), dp(1), colorDivider(), dp(20)));
        card.setPadding(dp(24), dp(28), dp(24), dp(24));
        card.setElevation(dp(2));

        FrameLayout badge = new FrameLayout(this);
        badge.setBackground(makeCircle(colorDangerSoft()));
        VectorIconView alertIcon = new VectorIconView(this, ICON_ALERT, colorDanger(), 1.9f);
        FrameLayout.LayoutParams iconLp = new FrameLayout.LayoutParams(dp(24), dp(24));
        iconLp.gravity = Gravity.CENTER;
        badge.addView(alertIcon, iconLp);
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(dp(52), dp(52));
        badgeParams.bottomMargin = dp(16);
        card.addView(badge, badgeParams);

        TextView titleView = new TextView(this);
        titleView.setText("无法连接到实例");
        titleView.setTextColor(colorText());
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f);
        titleView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        titleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        titleParams.bottomMargin = dp(6);
        card.addView(titleView, titleParams);

        TextView hintView = new TextView(this);
        hintView.setText("电脑端可能已重启、更换端口，或当前网络不可达。");
        hintView.setTextColor(colorMuted());
        hintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        hintView.setLineSpacing(0f, 1.35f);
        hintView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        hintParams.bottomMargin = dp(14);
        card.addView(hintView, hintParams);

        errorMessageView = new TextView(this);
        errorMessageView.setBackground(makeRoundedRect(colorPillBg(), 0, 0, dp(10)));
        errorMessageView.setPadding(dp(12), dp(9), dp(12), dp(9));
        errorMessageView.setTextColor(colorMuted());
        errorMessageView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        errorMessageView.setTypeface(Typeface.MONOSPACE);
        errorMessageView.setMaxLines(3);
        errorMessageView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        errorMessageView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msgParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        msgParams.bottomMargin = dp(20);
        card.addView(errorMessageView, msgParams);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);

        TextView backBtn = new TextView(this);
        backBtn.setText("返回控制台");
        backBtn.setTextColor(colorText());
        backBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        backBtn.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        backBtn.setGravity(Gravity.CENTER);
        backBtn.setSingleLine(true);
        backBtn.setClickable(true);
        backBtn.setFocusable(true);
        backBtn.setBackground(makeRippleDrawable(colorPillBg(), dp(12), dp(1), colorDivider()));
        backBtn.setOnClickListener(v -> {
            setResult(RESULT_OK);
            finish();
        });
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(0, dp(42), 1f);
        backParams.rightMargin = dp(5);
        btnRow.addView(backBtn, backParams);

        TextView retryBtn = new TextView(this);
        retryBtn.setText("重试");
        retryBtn.setTextColor(colorPrimaryBtnFg());
        retryBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        retryBtn.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        retryBtn.setGravity(Gravity.CENTER);
        retryBtn.setSingleLine(true);
        retryBtn.setClickable(true);
        retryBtn.setFocusable(true);
        retryBtn.setBackground(makeRippleDrawable(colorPrimaryBtnBg(), dp(12), 0, 0));
        retryBtn.setOnClickListener(v -> bootstrapAndOpen());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(0, dp(42), 1f);
        retryParams.leftMargin = dp(5);
        btnRow.addView(retryBtn, retryParams);

        LinearLayout.LayoutParams btnRowParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        card.addView(btnRow, btnRowParams);

        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        layout.addView(card, cardParams);
        return layout;
    }

    private TextView makeActionPill(String label, int fillColor, int textColor, int strokePx, int strokeColor) {
        TextView btn = new TextView(this);
        btn.setText(label);
        btn.setTextColor(textColor);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        btn.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        btn.setGravity(Gravity.CENTER);
        btn.setMinHeight(dp(40));
        btn.setPadding(dp(20), 0, dp(20), 0);
        btn.setBackground(makeRippleDrawable(fillColor, dp(999), strokePx, strokeColor));
        btn.setClickable(true);
        btn.setFocusable(true);
        return btn;
    }

    private View makeGlowingDot(int dotColor) {
        FrameLayout wrap = new FrameLayout(this);
        View halo = new View(this);
        halo.setBackground(makeCircle(Color.argb(46, Color.red(dotColor), Color.green(dotColor), Color.blue(dotColor))));
        wrap.addView(halo, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        View core = new View(this);
        core.setBackground(makeCircle(dotColor));
        FrameLayout.LayoutParams coreLp = new FrameLayout.LayoutParams(dp(7), dp(7));
        coreLp.gravity = Gravity.CENTER;
        wrap.addView(core, coreLp);
        return wrap;
    }

    private void showError(String message) {
        progressBar.setVisibility(View.GONE);
        errorMessageView.setText(message);
        errorOverlay.setVisibility(View.VISIBLE);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
        }
    }

    private Drawable makeRippleDrawable(int fillColor, int radiusPx, int strokeWidthPx, int strokeColor) {
        GradientDrawable content = makeRoundedRect(fillColor, strokeWidthPx, strokeColor, radiusPx);
        GradientDrawable mask = makeRoundedRect(Color.WHITE, 0, 0, radiusPx);
        int rippleColor = darkTheme ? Color.argb(38, 255, 255, 255) : Color.argb(26, 15, 23, 42);
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), content, mask);
    }

    private GradientDrawable makeRoundedRect(int fillColor, int strokeWidthPx, int strokeColor, int radiusPx) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(radiusPx);
        if (strokeWidthPx > 0) {
            drawable.setStroke(strokeWidthPx, strokeColor);
        }
        return drawable;
    }

    private GradientDrawable makeCircle(int fillColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(fillColor);
        return drawable;
    }

    private int colorBg() {
        return darkTheme ? Color.parseColor("#0F1014") : Color.parseColor("#F4F6FB");
    }

    private int colorBarBg() {
        return darkTheme ? Color.parseColor("#121318") : Color.parseColor("#FFFFFF");
    }

    private int colorCard() {
        return darkTheme ? Color.parseColor("#181A20") : Color.parseColor("#FFFFFF");
    }

    private int colorPillBg() {
        return darkTheme ? Color.parseColor("#20232C") : Color.parseColor("#F3F6FA");
    }

    private int colorText() {
        return darkTheme ? Color.parseColor("#F4F4F6") : Color.parseColor("#0F172A");
    }

    private int colorMuted() {
        return darkTheme ? Color.parseColor("#8F94A3") : Color.parseColor("#64748B");
    }

    private int colorDivider() {
        return darkTheme ? Color.parseColor("#22252F") : Color.parseColor("#EAECEF");
    }

    private int colorAccent() {
        return darkTheme ? Color.parseColor("#60A5FA") : Color.parseColor("#2563EB");
    }

    private int colorAccentSoft() {
        return darkTheme ? Color.argb(38, 96, 165, 250) : Color.argb(24, 37, 99, 235);
    }

    private int colorPrimaryBtnBg() {
        return darkTheme ? Color.parseColor("#F4F4F6") : Color.parseColor("#2563EB");
    }

    private int colorPrimaryBtnFg() {
        return darkTheme ? Color.parseColor("#0F1014") : Color.parseColor("#FFFFFF");
    }

    private int colorGreen() {
        return darkTheme ? Color.parseColor("#4ADE80") : Color.parseColor("#16A34A");
    }

    private int colorDanger() {
        return darkTheme ? Color.parseColor("#FB7185") : Color.parseColor("#E11D48");
    }

    private int colorDangerSoft() {
        return darkTheme ? Color.argb(34, 251, 113, 133) : Color.argb(24, 225, 29, 72);
    }

    private static String formatTargetBadge(@Nullable Object targetObj) {
        String rawType = "local";
        String extra = "";
        if (targetObj instanceof String) {
            rawType = ((String) targetObj).trim().toLowerCase();
        } else if (targetObj instanceof JSONObject) {
            JSONObject obj = (JSONObject) targetObj;
            rawType = obj.optString("type", obj.optString("kind", "local")).trim().toLowerCase();
            extra = safeTrim(obj.optString("label", obj.optString("name", obj.optString("distro", ""))));
        }
        if (rawType.contains("wsl")) {
            return extra.isEmpty() ? "WSL" : ("WSL · " + extra);
        }
        if (rawType.contains("ssh") || rawType.contains("remote")) {
            return extra.isEmpty() ? "SSH" : ("SSH · " + extra);
        }
        return "本机";
    }

    private static String decodeKeyFromPath(String path) {
        if (path == null || !path.startsWith("/_dshx/open/")) {
            return "";
        }
        String rest = path.substring("/_dshx/open/".length());
        int slashIdx = rest.indexOf('/');
        String encoded = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
        try {
            return safeTrim(URLDecoder.decode(encoded, StandardCharsets.UTF_8.name()));
        } catch (Exception ex) {
            return safeTrim(encoded);
        }
    }

    private static String readResponseBody(InputStream in) throws Exception {
        if (in == null) {
            return "{}";
        }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        }
        return sb.toString();
    }

    private static String buildOrigin(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) {
            return "";
        }
        int port = uri.getPort();
        if (port == -1 || ("http".equalsIgnoreCase(scheme) && port == 80) || ("https".equalsIgnoreCase(scheme) && port == 443)) {
            return scheme + "://" + host;
        }
        return scheme + "://" + host + ":" + port;
    }

    private static String safeTrim(String value) {
        return value == null ? "" : value.trim();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        dismissSwitcherDialog();
        executor.shutdownNow();
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
