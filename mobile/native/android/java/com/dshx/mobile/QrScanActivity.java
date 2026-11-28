package com.dshx.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.DecodeHintType;
import com.google.zxing.ResultPoint;
import com.google.zxing.client.android.Intents;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;
import com.journeyapps.barcodescanner.Size;
import com.journeyapps.barcodescanner.camera.CameraSettings;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 竖屏二维码扫描页：
 * 替代 zxing-android-embedded 默认锁死横屏的 CaptureActivity，开启 TRY_HARDER、
 * MIXED_SCAN 与连续自动对焦，针对手机对着电脑屏幕拍码场景优化识别率。
 */
public class QrScanActivity extends AppCompatActivity {
    public static final String EXTRA_QR_RESULT = "qrResult";

    private DecoratedBarcodeView barcodeView;
    private boolean torchOn = false;
    private boolean handled = false;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NoticeSyncService.ensureLifecycleTracking(this);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setFitsSystemWindows(true);

        barcodeView = new DecoratedBarcodeView(this);
        configureScanner();
        root.addView(barcodeView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(14);
        topBar.setPadding(pad, pad, pad, pad);

        Button backBtn = buildOverlayButton("返回");
        backBtn.setOnClickListener(v -> {
            setResult(Activity.RESULT_CANCELED);
            finish();
        });
        topBar.addView(backBtn);

        LinearLayout spacer = new LinearLayout(this);
        LinearLayout.LayoutParams spacerParams = new LinearLayout.LayoutParams(0, 1, 1f);
        topBar.addView(spacer, spacerParams);

        Button torchBtn = buildOverlayButton("手电筒");
        torchBtn.setOnClickListener(v -> {
            torchOn = !torchOn;
            if (torchOn) {
                barcodeView.setTorchOn();
                torchBtn.setText("关闭照明");
            } else {
                barcodeView.setTorchOff();
                torchBtn.setText("手电筒");
            }
        });
        topBar.addView(torchBtn);

        FrameLayout.LayoutParams topParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        topParams.gravity = Gravity.TOP;
        root.addView(topBar, topParams);

        setContentView(root);

        barcodeView.decodeSingle(new BarcodeCallback() {
            @Override
            public void barcodeResult(BarcodeResult result) {
                if (handled || result == null || result.getText() == null || result.getText().isEmpty()) {
                    return;
                }
                handled = true;
                Intent data = new Intent();
                data.putExtra(EXTRA_QR_RESULT, result.getText());
                setResult(Activity.RESULT_OK, data);
                finish();
            }

            @Override
            public void possibleResultPoints(List<ResultPoint> resultPoints) {
            }
        });
    }

    private void configureScanner() {
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");

        barcodeView.getBarcodeView().setDecoderFactory(
            new DefaultDecoderFactory(
                Collections.singletonList(BarcodeFormat.QR_CODE),
                hints,
                null,
                Intents.Scan.MIXED_SCAN
            )
        );

        CameraSettings settings = barcodeView.getBarcodeView().getCameraSettings();
        settings.setAutoFocusEnabled(true);
        settings.setContinuousFocusEnabled(true);
        settings.setFocusMode(CameraSettings.FocusMode.CONTINUOUS);

        DisplayMetrics dm = getResources().getDisplayMetrics();
        int framePx = Math.round(Math.min(dm.widthPixels, dm.heightPixels) * 0.72f);
        barcodeView.getBarcodeView().setFramingRectSize(new Size(framePx, framePx));
        barcodeView.setStatusText("对准电脑端 DSH-X 配对二维码");
    }

    private Button buildOverlayButton(String text) {
        Button btn = new Button(this);
        btn.setText(text);
        btn.setAllCaps(false);
        btn.setTextColor(Color.WHITE);
        btn.setBackgroundColor(Color.parseColor("#88000000"));
        int hPad = dp(14);
        int vPad = dp(8);
        btn.setPadding(hPad, vPad, hPad, vPad);
        return btn;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (barcodeView != null) {
            barcodeView.resume();
        }
    }

    @Override
    protected void onPause() {
        if (barcodeView != null) {
            barcodeView.pause();
        }
        super.onPause();
    }
}
