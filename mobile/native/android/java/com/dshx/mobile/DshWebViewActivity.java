package com.dshx.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原版 DSH Web 界面全屏承载页：
 * 1. 携带 Bearer Token 请求 `POST /_dshx/api/session/bootstrap` 为当前链路种下 HttpOnly Cookie
 *    （遇 `< 0.2.1` 旧版内核返回 HTTP 404 时自动回落写入同源 `dsh-x-device` Cookie），
 *    再加载 `/_dshx/open/<instanceKey>` 进入原版 DSH；
 * 2. 顶部导航条已移除，页面全屏显示；返回控制台交给系统返回手势与错误页按钮，
 *    常驻入口改为系统级悬浮球（FloatingWindowService）。
 */
public class DshWebViewActivity extends AppCompatActivity {
    public static final String EXTRA_ORIGIN = "origin";
    public static final String EXTRA_INSTANCE_KEY = "instanceKey";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_DARK_THEME = "darkTheme";

    private static final String NATIVE_UA_MARKER = "DSHXNativeApp/1";

    private static final int ICON_ALERT = 7;

    /** 24×24 几何矢量绘制图标，避免各机型的 Unicode 字体基线歪斜与锯齿。 */
    private static final class VectorIconView extends View {
        private final int kind;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
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

        @Override        protected void onDraw(Canvas canvas) {
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

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorOverlay;
    private TextView errorMessageView;

    private ValueCallback<Uri[]> pendingFileCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;

    private String targetOrigin = "";
    private String instanceKey = "";
    private String bearerToken = "";
    private boolean darkTheme = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NoticeSyncService.ensureLifecycleTracking(this);

        targetOrigin = safeTrim(getIntent().getStringExtra(EXTRA_ORIGIN));
        instanceKey = safeTrim(getIntent().getStringExtra(EXTRA_INSTANCE_KEY));
        bearerToken = safeTrim(getIntent().getStringExtra(EXTRA_TOKEN));

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

        root.addView(contentWrap, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        setContentView(root);
        configureWebView();

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
