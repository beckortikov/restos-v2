package com.restos.zakup.ui.theme

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
 * Токены приложения закупщика — извлечены ТОЧЬ-В-ТОЧЬ из макета
 * design/app_zakup.pen (значения посчитаны по экспорту каждого узла, не на глаз).
 *
 * Идентичность модуля — эмеральд-акцент (#0E9F6E) поверх нейтрального грейскейла
 * продукта: страница #F4F5F7, карточки #FFFFFF, текст #15171C. Семантика статусов:
 * danger #E5484D (долг/нет остатка), warn #E8880C (мало), success = эмеральд.
 * Шрифт — Inter (в системе подменяется на дефолтный sans, начертания сохранены).
 */
object ZakupColors {
    // Поверхности
    val Bg = Color(0xFFF4F5F7)          // фон страницы
    val Surface = Color(0xFFFFFFFF)     // карточки
    val SurfaceMuted = Color(0xFFF7F8FA) // инпуты, вторичные плитки, клавиши
    val Border = Color(0xFFEBEDF1)      // разделители, обводки

    // Текст
    val TextPrimary = Color(0xFF15171C)
    val TextSecondary = Color(0xFF6B7280)
    val TextTertiary = Color(0xFF9AA2AE) // плейсхолдеры, подписи

    // Акцент (эмеральд)
    val Primary = Color(0xFF0E9F6E)
    val PrimarySoft = Color(0xFFE6F6EF)
    val OnPrimary = Color(0xFFFFFFFF)

    // Статус: долг / нет остатка
    val Danger = Color(0xFFE5484D)
    val DangerSoft = Color(0xFFFCEBEC)
    val DangerText = Color(0xFFA03236)

    // Статус: мало / низкий остаток
    val Warn = Color(0xFFE8880C)
    val WarnSoft = Color(0xFFFCF0DD)
    val WarnText = Color(0xFF9A6410)

    // Информационный (редко, напр. чипы категорий)
    val Info = Color(0xFF3F7EF2)
    val InfoSoft = Color(0xFFEAF1FD)
    val InfoText = Color(0xFF2A5AB8)

    // Цвет тени карточек (используется с низкой альфой: 0x0A…0x0F)
    val Shadow = Color(0xFF0E1724)
}

/**
 * Радиусы из макета: карточка 20, кнопка 14, плитка 12, чип/пилюля 11,
 * мелкое 10/8, бейдж 7. Нижний лист сверху 26.
 */
object ZakupRadius {
    val card = 20.dp
    val button = 14.dp
    val tile = 12.dp
    val pill = 11.dp
    val chip = 10.dp
    val small = 8.dp
    val badge = 7.dp
    val sheet = 26.dp
}

object ZakupSpacing {
    val screenH = 20.dp   // горизонтальный отступ экрана
    val gap = 12.dp       // типовой промежуток между карточками
}

private val ZakupShapes = Shapes(
    extraSmall = RoundedCornerShape(ZakupRadius.small),
    small = RoundedCornerShape(ZakupRadius.chip),
    medium = RoundedCornerShape(ZakupRadius.tile),
    large = RoundedCornerShape(ZakupRadius.card),
    extraLarge = RoundedCornerShape(ZakupRadius.card),
)

// Типографика из макета (Inter). Размеры кластеризованы по экспорту:
// метрика 22, заголовок 18, подзаголовок 16, тело 14.5, вторичное 12.5-13,
// подпись 11-12. Начертания: 700 (bold), 600 (semibold), 500 (medium).
private val ZakupType = Typography(
    // Крупная метрика («12», «4.85 млн»)
    headlineMedium = TextStyle(fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary),
    // Заголовок экрана («Обзор закупок», «Склад»)
    headlineSmall = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary),
    // Подзаголовок / крупная кнопка
    titleLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary),
    // Название строки в списке
    titleMedium = TextStyle(fontSize = 14.5.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary),
    // Основной текст
    bodyLarge = TextStyle(fontSize = 14.5.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, color = ZakupColors.TextPrimary),
    // Вторичный текст (подписи под названием)
    bodyMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, color = ZakupColors.TextSecondary),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, color = ZakupColors.TextSecondary),
    // Подписи/лейблы (табы, бейджи, метки секций)
    labelLarge = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary),
    labelMedium = TextStyle(fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextTertiary),
)

private val ZakupColorScheme = lightColorScheme(
    primary = ZakupColors.Primary,
    onPrimary = ZakupColors.OnPrimary,
    primaryContainer = ZakupColors.PrimarySoft,
    onPrimaryContainer = ZakupColors.Primary,
    background = ZakupColors.Bg,
    onBackground = ZakupColors.TextPrimary,
    surface = ZakupColors.Surface,
    onSurface = ZakupColors.TextPrimary,
    surfaceVariant = ZakupColors.SurfaceMuted,
    onSurfaceVariant = ZakupColors.TextSecondary,
    outline = ZakupColors.Border,
    outlineVariant = ZakupColors.Border,
    error = ZakupColors.Danger,
    onError = ZakupColors.OnPrimary,
    errorContainer = ZakupColors.DangerSoft,
    onErrorContainer = ZakupColors.DangerText,
)

@Composable
fun ZakupTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ZakupColorScheme,
        typography = ZakupType,
        shapes = ZakupShapes,
        content = content,
    )
}
