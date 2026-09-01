package com.restos.checkin.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Токены терминала учёта времени. Планшет висит у служебного входа, на него
 * смотрят стоя и мельком — размеры как в :kiosk (крупные плитки, много
 * воздуха), но палитра своя: изумруд вместо индиго, чтобы сотрудник с порога
 * отличал «отметиться» от терминала самозаказа в зале.
 *
 * Приход и уход — два противоположных действия, каждому свой цвет:
 * зелёный In / янтарный Out. Они уже здесь, хотя экран отметок появится
 * следующей фазой, — чтобы палитра сложилась целиком, а не по кускам.
 */
object CheckinColors {
    // Поверхности
    val Bg = Color(0xFFF6F8F7)           // фон экрана
    val Surface = Color(0xFFFFFFFF)      // карточки
    val SurfaceMuted = Color(0xFFEFF3F1) // клавиши, плейсхолдеры
    val Border = Color(0xFFE1E8E5)       // разделители, обводки

    // Текст
    val TextPrimary = Color(0xFF12201B)
    val TextSecondary = Color(0xFF64756E)
    val TextTertiary = Color(0xFF97A6A0)

    // Акцент (изумруд)
    val Primary = Color(0xFF0E9F6E)
    val PrimarySoft = Color(0xFFE4F5EE)
    val OnPrimary = Color(0xFFFFFFFF)

    // Приход / уход
    val ClockIn = Color(0xFF0E9F6E)
    val ClockOut = Color(0xFFE08A00)
    val ClockOutSoft = Color(0xFFFDF3E0)

    // Статус: ошибка
    val Danger = Color(0xFFE5484D)
    val DangerSoft = Color(0xFFFCEBEC)
    val DangerText = Color(0xFFA03236)

    val Shadow = Color(0xFF0E1724)
}

/** Радиусы как в :kiosk — тач-плитки/карточки, а не телефонный UI. */
object CheckinRadius {
    val card = 24.dp
    val button = 18.dp
    val tile = 20.dp
    val pill = 999.dp
    val chip = 16.dp
    val small = 10.dp
}

object CheckinSpacing {
    val screenH = 24.dp
    val gap = 16.dp
}

private val CheckinShapes = Shapes(
    extraSmall = RoundedCornerShape(CheckinRadius.small),
    small = RoundedCornerShape(CheckinRadius.chip),
    medium = RoundedCornerShape(CheckinRadius.tile),
    large = RoundedCornerShape(CheckinRadius.card),
    extraLarge = RoundedCornerShape(CheckinRadius.card),
)

private val CheckinType = Typography(
    headlineMedium = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold, color = CheckinColors.TextPrimary),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, color = CheckinColors.TextPrimary),
    titleLarge = TextStyle(fontSize = 19.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextPrimary),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextPrimary),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, color = CheckinColors.TextPrimary),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, color = CheckinColors.TextSecondary),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, color = CheckinColors.TextSecondary),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextPrimary),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.Bold, color = CheckinColors.TextPrimary),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, color = CheckinColors.TextTertiary),
)

private val CheckinColorScheme = lightColorScheme(
    primary = CheckinColors.Primary,
    onPrimary = CheckinColors.OnPrimary,
    primaryContainer = CheckinColors.PrimarySoft,
    onPrimaryContainer = CheckinColors.Primary,
    background = CheckinColors.Bg,
    onBackground = CheckinColors.TextPrimary,
    surface = CheckinColors.Surface,
    onSurface = CheckinColors.TextPrimary,
    surfaceVariant = CheckinColors.SurfaceMuted,
    onSurfaceVariant = CheckinColors.TextSecondary,
    outline = CheckinColors.Border,
    outlineVariant = CheckinColors.Border,
    error = CheckinColors.Danger,
    onError = CheckinColors.OnPrimary,
    errorContainer = CheckinColors.DangerSoft,
    onErrorContainer = CheckinColors.DangerText,
)

@Composable
fun CheckinTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = CheckinColorScheme,
        typography = CheckinType,
        shapes = CheckinShapes,
        content = content,
    )
}
