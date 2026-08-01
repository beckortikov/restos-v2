package com.restos.kiosk.ui.theme

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
 * Токены терминала самозаказа — стиль Drinkit (drinkit.ru): индиго-акцент
 * поверх нейтрального грейскейла, крупные пилюли/скругления, много воздуха.
 * В отличие от :app/:zakup (телефон сотрудника) это тач-экран, на который
 * гость смотрит с расстояния вытянутой руки — размеры текста и плиток
 * заметно крупнее.
 */
object KioskColors {
    // Поверхности
    val Bg = Color(0xFFF7F7FB)          // фон экрана
    val Surface = Color(0xFFFFFFFF)     // карточки
    val SurfaceMuted = Color(0xFFF1F1F7) // плейсхолдеры изображений, поле картинки
    val Border = Color(0xFFE7E7F0)      // разделители, обводки

    // Текст
    val TextPrimary = Color(0xFF16151F)
    val TextSecondary = Color(0xFF6B6B78)
    val TextTertiary = Color(0xFF9E9EAC)

    // Акцент (индиго, Drinkit)
    val Primary = Color(0xFF4F46E5)
    val PrimarySoft = Color(0xFFEEEDFE)
    val OnPrimary = Color(0xFFFFFFFF)

    // Статус: ошибка
    val Danger = Color(0xFFE5484D)
    val DangerSoft = Color(0xFFFCEBEC)
    val DangerText = Color(0xFFA03236)

    // Успех (подтверждение заказа)
    val Success = Color(0xFF0E9F6E)
    val SuccessSoft = Color(0xFFE6F6EF)

    val Shadow = Color(0xFF0E1724)
}

/** Радиусы заметно крупнее, чем в телефонных приложениях — тач-плитки/карточки. */
object KioskRadius {
    val card = 24.dp
    val button = 18.dp
    val tile = 20.dp
    val pill = 999.dp
    val chip = 16.dp
    val small = 10.dp
}

object KioskSpacing {
    val screenH = 24.dp
    val gap = 16.dp
}

private val KioskShapes = Shapes(
    extraSmall = RoundedCornerShape(KioskRadius.small),
    small = RoundedCornerShape(KioskRadius.chip),
    medium = RoundedCornerShape(KioskRadius.tile),
    large = RoundedCornerShape(KioskRadius.card),
    extraLarge = RoundedCornerShape(KioskRadius.card),
)

// Крупнее, чем в :zakup/:app — экран смотрят с расстояния вытянутой руки.
private val KioskType = Typography(
    headlineMedium = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold, color = KioskColors.TextPrimary),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, color = KioskColors.TextPrimary),
    titleLarge = TextStyle(fontSize = 19.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, color = KioskColors.TextPrimary),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, color = KioskColors.TextPrimary),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, color = KioskColors.TextPrimary),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, color = KioskColors.TextSecondary),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, color = KioskColors.TextSecondary),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, color = KioskColors.TextPrimary),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.Bold, color = KioskColors.TextPrimary),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, color = KioskColors.TextTertiary),
)

private val KioskColorScheme = lightColorScheme(
    primary = KioskColors.Primary,
    onPrimary = KioskColors.OnPrimary,
    primaryContainer = KioskColors.PrimarySoft,
    onPrimaryContainer = KioskColors.Primary,
    background = KioskColors.Bg,
    onBackground = KioskColors.TextPrimary,
    surface = KioskColors.Surface,
    onSurface = KioskColors.TextPrimary,
    surfaceVariant = KioskColors.SurfaceMuted,
    onSurfaceVariant = KioskColors.TextSecondary,
    outline = KioskColors.Border,
    outlineVariant = KioskColors.Border,
    error = KioskColors.Danger,
    onError = KioskColors.OnPrimary,
    errorContainer = KioskColors.DangerSoft,
    onErrorContainer = KioskColors.DangerText,
)

@Composable
fun KioskTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = KioskColorScheme,
        typography = KioskType,
        shapes = KioskShapes,
        content = content,
    )
}
