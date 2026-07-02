package com.restos.kds

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Surface
import com.restos.kds.ui.KdsRoot
import com.restos.kds.ui.theme.KdsColors
import com.restos.kds.ui.theme.KdsTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Кухонный дисплей всегда включён.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            KdsTheme {
                Surface(color = KdsColors.Bg) {
                    KdsRoot()
                }
            }
        }
    }
}
