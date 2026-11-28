package com.dshx.mobile;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
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
import android.widget.Button;
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
 * 1. 携带 Bearer Token 请求 `POST /_dshx/api/session/bootstrap` 为当前链路种下 HttpOnly Cookie，
 *    再加载 `/_dshx/open/<instanceKey>` 进入原版 DSH；
 * 2. 顶部内置极简可收起控制条（返回控制台 / 当前实例切换胶囊 / 刷新 / 收起），点击胶囊即可从
 *    `GET /_dshx/api/instances` 拉取全部运行中实例并在当前 WebView 内原地秒切，无需重建 Activity。
 */
public class DshWebViewActivity extends AppCompatActivity {
    public static final String EXTRA_ORIGIN = "origin";
    public static final String EXTRA_INSTANCE_KEY = "instanceKey";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_DARK_THEME = "darkTheme";

    private static final String NATIVE_UA_MARKER = "DSHXNativeApp/1";

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

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final List<InstanceItem> cachedInstances = new ArrayList<>();

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout topBar;
    private TextView switcherLabel;
    private TextView switcherCount;
    private TextView restoreBarChip;
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
    private boolean fetchingInstances = false;
    private String instancesFetchError = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        targetOrigin = safeTrim(getIntent().getStringExtra(EXTRA_ORIGIN));
        instanceKey = safeTrim(getIntent().getStringExtra(EXTRA_INSTANCE_KEY));
        instanceTitle = safeTrim(getIntent().getStringExtra(EXTRA_TITLE));
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

        topBar = buildTopBar();
        root.addView(topBar, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(44)
        ));

        View divider = new View(this);
        divider.setBackgroundColor(colorDivider());
        root.addView(divider, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            1
        ));

        FrameLayout contentWrap = new FrameLayout(this);

        webView = new WebView(this);
        contentWrap.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(2)
        );
        progressParams.gravity = Gravity.TOP;
        contentWrap.addView(progressBar, progressParams);

        restoreBarChip = buildRestoreBarChip();
        restoreBarChip.setVisibility(View.GONE);
        FrameLayout.LayoutParams restoreParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            dp(30)
        );
        restoreParams.gravity = Gravity.TOP | Gravity.END;
        restoreParams.setMargins(0, dp(8), dp(10), 0);
        contentWrap.addView(restoreBarChip, restoreParams);

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

    private LinearLayout buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(colorBarBg());
        bar.setPadding(dp(8), dp(4), dp(8), dp(4));

        TextView backBtn = makeBarButton("‹", dp(34));
        backBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f);
        backBtn.setContentDescription("返回控制台");
        backBtn.setOnClickListener(v -> {
            setResult(RESULT_OK);
            finish();
        });
        bar.addView(backBtn, new LinearLayout.LayoutParams(dp(36), dp(34)));

        LinearLayout centerSlot = new LinearLayout(this);
        centerSlot.setOrientation(LinearLayout.HORIZONTAL);
        centerSlot.setGravity(Gravity.CENTER);
        centerSlot.setPadding(dp(6), 0, dp(6), 0);

        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp(11), 0, dp(10), 0);
        pill.setBackground(makeRoundedRect(colorPillBg(), dp(1), colorDivider(), dp(999)));
        pill.setClickable(true);
        pill.setFocusable(true);
        pill.setOnClickListener(v -> showInstanceSwitcherSheet());

        View greenDot = new View(this);
        greenDot.setBackground(makeCircle(colorGreen()));
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(7), dp(7));
        dotParams.rightMargin = dp(7);
        pill.addView(greenDot, dotParams);

        switcherLabel = new TextView(this);
        switcherLabel.setTextColor(colorText());
        switcherLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        switcherLabel.setTypeface(Typeface.DEFAULT_BOLD);
        switcherLabel.setSingleLine(true);
        switcherLabel.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f
        );
        pill.addView(switcherLabel, labelParams);

        switcherCount = new TextView(this);
        switcherCount.setTextColor(colorAccent());
        switcherCount.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        switcherCount.setTypeface(Typeface.DEFAULT_BOLD);
        switcherCount.setPadding(dp(6), dp(1), dp(6), dp(1));
        switcherCount.setBackground(makeRoundedRect(colorAccentSoft(), 0, 0, dp(999)));
        switcherCount.setVisibility(View.GONE);
        LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        countParams.leftMargin = dp(6);
        pill.addView(switcherCount, countParams);

        TextView caret = new TextView(this);
        caret.setText("▾");
        caret.setTextColor(colorMuted());
        caret.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        LinearLayout.LayoutParams caretParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        caretParams.leftMargin = dp(5);
        pill.addView(caret, caretParams);

        centerSlot.addView(pill, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            dp(32)
        ));
        bar.addView(centerSlot, new LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.MATCH_PARENT,
            1f
        ));

        TextView reloadBtn = makeBarButton("↻", dp(34));
        reloadBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        reloadBtn.setContentDescription("刷新页面");
        reloadBtn.setOnClickListener(v -> {
            if (webView != null) {
                errorOverlay.setVisibility(View.GONE);
                webView.reload();
            }
        });
        bar.addView(reloadBtn, new LinearLayout.LayoutParams(dp(34), dp(34)));

        TextView collapseBtn = makeBarButton("⌃", dp(34));
        collapseBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        collapseBtn.setContentDescription("收起顶部栏");
        collapseBtn.setOnClickListener(v -> setTopBarVisible(false));
        LinearLayout.LayoutParams collapseParams = new LinearLayout.LayoutParams(dp(34), dp(34));
        collapseParams.leftMargin = dp(2);
        bar.addView(collapseBtn, collapseParams);

        return bar;
    }

    private TextView makeBarButton(String text, int heightPx) {
        TextView btn = new TextView(this);
        btn.setText(text);
        btn.setGravity(Gravity.CENTER);
        btn.setTextColor(colorText());
        btn.setBackground(makeRoundedRect(Color.TRANSPARENT, 0, 0, dp(8)));
        btn.setMinimumHeight(heightPx);
        btn.setClickable(true);
        btn.setFocusable(true);
        return btn;
    }

    private TextView buildRestoreBarChip() {
        TextView chip = new TextView(this);
        chip.setText("⇄ 切换");
        chip.setTextColor(colorText());
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        chip.setTypeface(Typeface.DEFAULT_BOLD);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(10), 0, dp(10), 0);
        int bg = darkTheme ? Color.argb(215, 24, 26, 32) : Color.argb(225, 255, 255, 255);
        chip.setBackground(makeRoundedRect(bg, dp(1), colorDivider(), dp(999)));
        chip.setOnClickListener(v -> {
            setTopBarVisible(true);
            showInstanceSwitcherSheet();
        });
        return chip;
    }

    private void setTopBarVisible(boolean visible) {
        if (topBar != null) {
            topBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        }
        if (restoreBarChip != null) {
            restoreBarChip.setVisibility(visible ? View.GONE : View.VISIBLE);
        }
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
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("Session bootstrap failed (HTTP " + code + ")");
                }

                CookieManager cookieManager = CookieManager.getInstance();
                for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                    if (entry.getKey() != null && entry.getKey().equalsIgnoreCase("Set-Cookie") && entry.getValue() != null) {
                        for (String cookieVal : entry.getValue()) {
                            cookieManager.setCookie(targetOrigin, cookieVal);
                        }
                    }
                }
                cookieManager.flush();

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
        float radius = dp(20);
        GradientDrawable sheetBg = new GradientDrawable();
        sheetBg.setColor(colorCard());
        sheetBg.setCornerRadii(new float[] { radius, radius, radius, radius, 0f, 0f, 0f, 0f });
        sheet.setBackground(sheetBg);
        sheet.setPadding(dp(16), dp(10), dp(16), dp(22));

        View handle = new View(this);
        handle.setBackground(makeRoundedRect(colorDivider(), 0, 0, dp(999)));
        LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(36), dp(4));
        handleParams.gravity = Gravity.CENTER_HORIZONTAL;
        handleParams.bottomMargin = dp(12);
        sheet.addView(handle, handleParams);

        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setGravity(Gravity.CENTER_VERTICAL);
        headerRow.setPadding(dp(2), 0, dp(2), dp(10));

        TextView titleView = new TextView(this);
        titleView.setText("切换运行中实例");
        titleView.setTextColor(colorText());
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        headerRow.addView(titleView, new LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f
        ));

        TextView refreshSheetBtn = new TextView(this);
        refreshSheetBtn.setText("刷新");
        refreshSheetBtn.setTextColor(colorAccent());
        refreshSheetBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        refreshSheetBtn.setTypeface(Typeface.DEFAULT_BOLD);
        refreshSheetBtn.setPadding(dp(10), dp(6), dp(10), dp(6));
        refreshSheetBtn.setBackground(makeRoundedRect(colorAccentSoft(), 0, 0, dp(8)));
        refreshSheetBtn.setOnClickListener(v -> {
            renderSwitcherSheetLoading();
            fetchRunningInstancesAsync(null);
        });
        headerRow.addView(refreshSheetBtn);

        TextView consoleBtn = new TextView(this);
        consoleBtn.setText("控制台");
        consoleBtn.setTextColor(colorText());
        consoleBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        consoleBtn.setTypeface(Typeface.DEFAULT_BOLD);
        consoleBtn.setPadding(dp(10), dp(6), dp(10), dp(6));
        consoleBtn.setBackground(makeRoundedRect(colorPillBg(), dp(1), colorDivider(), dp(8)));
        consoleBtn.setOnClickListener(v -> {
            dismissSwitcherDialog();
            setResult(RESULT_OK);
            finish();
        });
        LinearLayout.LayoutParams consoleParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        consoleParams.leftMargin = dp(8);
        headerRow.addView(consoleBtn, consoleParams);

        sheet.addView(headerRow);

        sheetStatusView = new TextView(this);
        sheetStatusView.setTextColor(colorMuted());
        sheetStatusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        sheetStatusView.setGravity(Gravity.CENTER);
        sheetStatusView.setPadding(dp(8), dp(18), dp(8), dp(18));
        sheet.addView(sheetStatusView);

        ScrollView scroll = new ScrollView(this);
        sheetListContainer = new LinearLayout(this);
        sheetListContainer.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(sheetListContainer, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        scroll.setLayoutParams(scrollParams);
        sheet.addView(scroll);

        dialog.setContentView(sheet);
        Window win = dialog.getWindow();
        if (win != null) {
            win.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            win.setGravity(Gravity.BOTTOM);
            win.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
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
            row.setPadding(dp(12), dp(12), dp(12), dp(12));
            int rowBg = isCurrent ? colorAccentSoft() : colorPillBg();
            int rowBorder = isCurrent ? colorAccent() : colorDivider();
            row.setBackground(makeRoundedRect(rowBg, dp(1), rowBorder, dp(12)));
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(v -> {
                dismissSwitcherDialog();
                if (!isCurrent) {
                    switchToInstance(item.key, item.displayTitle);
                }
            });

            View dot = new View(this);
            dot.setBackground(makeCircle(item.ready ? colorGreen() : Color.parseColor("#D97706")));
            LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(8), dp(8));
            dotParams.rightMargin = dp(10);
            row.addView(dot, dotParams);

            LinearLayout info = new LinearLayout(this);
            info.setOrientation(LinearLayout.VERTICAL);

            TextView nameView = new TextView(this);
            nameView.setText(item.displayTitle);
            nameView.setTextColor(colorText());
            nameView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
            nameView.setTypeface(Typeface.DEFAULT_BOLD);
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

            TextView tag = new TextView(this);
            tag.setText(isCurrent ? "当前" : "切换 →");
            tag.setTextColor(isCurrent ? colorAccent() : colorMuted());
            tag.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            tag.setTypeface(Typeface.DEFAULT_BOLD);
            row.addView(tag);

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
        int pad = dp(24);
        layout.setPadding(pad, pad, pad, pad);

        errorMessageView = new TextView(this);
        errorMessageView.setTextColor(colorText());
        errorMessageView.setTextSize(15f);
        errorMessageView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msgParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        msgParams.bottomMargin = dp(16);
        layout.addView(errorMessageView, msgParams);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);

        Button retryBtn = new Button(this);
        retryBtn.setText("重试");
        retryBtn.setOnClickListener(v -> bootstrapAndOpen());
        btnRow.addView(retryBtn);

        Button backBtn = new Button(this);
        backBtn.setText("返回控制台");
        LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        backParams.leftMargin = dp(12);
        backBtn.setOnClickListener(v -> {
            setResult(RESULT_OK);
            finish();
        });
        btnRow.addView(backBtn, backParams);

        layout.addView(btnRow);
        return layout;
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
        return darkTheme ? Color.parseColor("#16181E") : Color.parseColor("#FFFFFF");
    }

    private int colorCard() {
        return darkTheme ? Color.parseColor("#181A20") : Color.parseColor("#FFFFFF");
    }

    private int colorPillBg() {
        return darkTheme ? Color.parseColor("#22252E") : Color.parseColor("#F1F5F9");
    }

    private int colorText() {
        return darkTheme ? Color.parseColor("#F4F4F6") : Color.parseColor("#0F172A");
    }

    private int colorMuted() {
        return darkTheme ? Color.parseColor("#989AA6") : Color.parseColor("#64748B");
    }

    private int colorDivider() {
        return darkTheme ? Color.parseColor("#2A2D37") : Color.parseColor("#E2E8F0");
    }

    private int colorAccent() {
        return darkTheme ? Color.parseColor("#60A5FA") : Color.parseColor("#2563EB");
    }

    private int colorAccentSoft() {
        return darkTheme ? Color.argb(38, 96, 165, 250) : Color.argb(26, 37, 99, 235);
    }

    private int colorGreen() {
        return darkTheme ? Color.parseColor("#4ADE80") : Color.parseColor("#16A34A");
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
