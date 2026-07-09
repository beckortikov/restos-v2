package com.restos.kds

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.restos.kds.ui.KdsRoot
import com.restos.kds.ui.theme.KdsColors
import com.restos.kds.ui.theme.KdsTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Фуллскрин-киоск: рисуем под системные панели (edge-to-edge) и прячем их.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()
        setContent {
            KdsTheme {
                Surface(color = KdsColors.Bg, modifier = Modifier.fillMaxSize()) {
                    // Панели скрыты (киоск), поэтому отступаем ТОЛЬКО под вырез камеры —
                    // доска занимает всю высоту планшета. imePadding — чтобы клавиатура
                    // на экране PIN не перекрывала поле ввода.
                    Box(
                        Modifier.fillMaxSize()
                            .windowInsetsPadding(WindowInsets.displayCutout)
                            .imePadding(),
                    ) {
                        KdsRoot()
                    }
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Панели могут вернуться после диалогов/шторки — прячем снова.
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
