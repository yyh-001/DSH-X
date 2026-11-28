package com.dshx.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DshxNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

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
}
