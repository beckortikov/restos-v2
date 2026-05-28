package com.restos.waiter;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Opt OUT of edge-to-edge layout. Android 15 (API 35) makes
        // setDecorFitsSystemWindows(true) the only way to keep the WebView
        // anchored below the status bar — without this the content slides
        // under the camera punch-hole on devices like Samsung A55.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        // Make the status-bar background match our app's white surface so
        // the seam is invisible. Light icons on dark/white toggle handled
        // by the StatusBar plugin (setStyle Light) on the JS side.
        try {
            getWindow().setStatusBarColor(Color.WHITE);
            getWindow().setNavigationBarColor(Color.WHITE);
            WindowInsetsControllerCompat controller =
                    new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        } catch (Exception ignored) {}

        // Older Android (pre-30) — clear FLAG_LAYOUT_NO_LIMITS that some
        // splash themes set, which would otherwise let the WebView extend
        // under system bars.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        }
    }
}
