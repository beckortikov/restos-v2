package com.restos.zakup.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

/** Белая карточка r20 с тонкой обводкой — базовая поверхность макета. */
@Composable
fun ZakupCard(
    modifier: Modifier = Modifier,
    padding: Int = 0,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.Surface,
        border = BorderStroke(1.dp, ZakupColors.Border),
    ) {
        if (padding > 0) Box(Modifier.padding(padding.dp)) { content() } else content()
    }
}

/** Топ-бар pushed-экрана: кнопка «назад» + заголовок. */
@Composable
fun ZakupTopBar(title: String, onBack: () -> Unit, action: (@Composable () -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            shape = RoundedCornerShape(ZakupRadius.chip),
            color = Color.Transparent,
            modifier = Modifier.size(40.dp).clickable(onClick = onBack),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = "Назад",
                    tint = ZakupColors.TextPrimary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        Spacer(Modifier.size(4.dp))
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
        if (action != null) action()
    }
}

enum class BadgeKind { Success, Warn, Danger, Neutral }

/** Статус-бейдж (soft-фон + жирный цветной текст), r7 — как в макете. */
@Composable
fun StatusBadge(text: String, kind: BadgeKind) {
    val (bg, fg) = when (kind) {
        BadgeKind.Success -> ZakupColors.PrimarySoft to ZakupColors.Primary
        BadgeKind.Warn -> ZakupColors.WarnSoft to ZakupColors.Warn
        BadgeKind.Danger -> ZakupColors.DangerSoft to ZakupColors.Danger
        BadgeKind.Neutral -> ZakupColors.SurfaceMuted to ZakupColors.TextSecondary
    }
    Surface(shape = RoundedCornerShape(ZakupRadius.badge), color = bg) {
        Text(
            text,
            color = fg,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

/** Заголовок секции + опциональная эмеральд-ссылка справа (напр. «Все 12 ›»). */
@Composable
fun SectionHeader(
    title: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
        if (actionLabel != null) {
            Row(
                Modifier.clickable(enabled = onAction != null) { onAction?.invoke() },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(actionLabel, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.Primary)
                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = ZakupColors.Primary, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/** Круглая иконка-плитка с soft-фоном (для строк списка/метрик). */
@Composable
fun IconTile(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    bg: Color,
    size: Int = 40,
) {
    Surface(shape = RoundedCornerShape(ZakupRadius.chip), color = bg, modifier = Modifier.size(size.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size((size * 0.5).dp))
        }
    }
}

/** Аватар-инициалы (эмеральд-soft подложка). */
@Composable
fun Avatar(initials: String, size: Int = 44) {
    Surface(shape = RoundedCornerShape(ZakupRadius.chip), color = ZakupColors.PrimarySoft, modifier = Modifier.size(size.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Text(initials, color = ZakupColors.Primary, fontWeight = FontWeight.Bold, fontSize = (size * 0.34).sp)
        }
    }
}

/** Тонкий разделитель строк внутри карточки. */
@Composable
fun RowDivider(startIndent: Int = 14) {
    Box(Modifier.fillMaxWidth().padding(start = startIndent.dp).height(1.dp).background(ZakupColors.Border))
}

@Composable
fun LoadingState() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = ZakupColors.Primary)
    }
}

@Composable
fun ErrorState(message: String, onRetry: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(message, color = ZakupColors.TextSecondary, fontSize = 14.sp)
        if (onRetry != null) {
            Spacer(Modifier.size(12.dp))
            Text("Повторить", color = ZakupColors.Primary, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { onRetry() })
        }
    }
}

@Composable
fun EmptyState(message: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) {
        Text(message, color = ZakupColors.TextTertiary, fontSize = 14.sp)
    }
}
