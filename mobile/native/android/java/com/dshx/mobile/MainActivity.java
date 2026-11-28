package com.dshx.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshxNativePlugin.class);
        super.onCreate(savedInstanceState);
        // 用 Application 的生命周期回调统计前后台，避免覆写 BridgeActivity 的 onStart/onStop。
        NoticeSyncService.ensureLifecycleTracking(this);
    }
}
