package com.dshx.mobile;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原版 DSH Web 界面全屏承载页：
 * 先携带 Bearer Token 请求 `POST /_dshx/api/session/bootstrap` 为当前链路种下 HttpOnly Cookie，
 * 再跳转 `/_dshx/open/<instanceKey>` 进入原版 DSH（并保留网页悬浮胶囊的「返回控制台」出口）。
 */
public class DshWebViewActivity extends AppCompatActivity {
    public static final String EXTRA_ORIGIN = "origin";
    public static final String EXTRA_INSTANCE_KEY = "instanceKey";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_TITLE = "title";

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

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        targetOrigin = safeTrim(getIntent().getStringExtra(EXTRA_ORIGIN));
        instanceKey = safeTrim(getIntent().getStringExtra(EXTRA_INSTANCE_KEY));
        bearerToken = safeTrim(getIntent().getStringExtra(EXTRA_TOKEN));

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

        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(3)
        );
        progressParams.gravity = Gravity.TOP;
        root.addView(progressBar, progressParams);

        errorOverlay = buildErrorOverlay();
        errorOverlay.setVisibility(View.GONE);
        root.addView(errorOverlay, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
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
        layout.setBackgroundColor(Color.parseColor("#F5F7FC"));
        int pad = dp(24);
        layout.setPadding(pad, pad, pad, pad);

        errorMessageView = new TextView(this);
        errorMessageView.setTextColor(Color.parseColor("#16233D"));
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
        retryBtn.setText("Retry");
        retryBtn.setOnClickListener(v -> bootstrapAndOpen());
        btnRow.addView(retryBtn);

        Button backBtn = new Button(this);
        backBtn.setText("Back");
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
