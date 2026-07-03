package com.restos.kds.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Токены KDS-доски (тёмная тема фастфуд-дисплея) — из макета Pencil.
object KdsColors {
    val Bg = Color(0xFF0E1116)
    val Bar = Color(0xFF161B23)
    val ColBg = Color(0xFF12161E)
    val Card = Color(0xFF1B2130)
    val CardLine = Color(0xFF2A3242)
    val TextHi = Color(0xFFF7FAFC)
    val TextMid = Color(0xFF9AA6B8)
    val TextDim = Color(0xFF64748B)

    val New = Color(0xFF3B82F6)
    val NewSoft = Color(0xFF16233B)
    val Cooking = Color(0xFFF59E0B)
    val CookingSoft = Color(0xFF2E2411)
    val Ready = Color(0xFF22C55E)
    val ReadySoft = Color(0xFF122A1C)
    val Urgent = Color(0xFFEF4444)
    val OnSolid = Color(0xFFFFFFFF)

    // Станции.
    val StHot = Color(0xFFFB923C)
    val StCold = Color(0xFF38BDF8)
    val StGrill = Color(0xFFC084FC)
    val StFry = Color(0xFFFBBF24)
}

private val KdsScheme = darkColorScheme(
    primary = KdsColors.New,
    background = KdsColors.Bg,
    surface = KdsColors.Card,
    onBackground = KdsColors.TextHi,
    onSurface = KdsColors.TextHi,
    error = KdsColors.Urgent,
)

@Composable
fun KdsTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = KdsScheme, content = content)
}
