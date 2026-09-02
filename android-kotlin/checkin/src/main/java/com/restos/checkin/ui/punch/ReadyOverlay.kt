package com.restos.checkin.ui.punch

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.checkin.data.attendance.AttendanceLookupDto
import com.restos.checkin.ui.theme.CheckinColors
import com.restos.checkin.ui.theme.CheckinRadius
import com.restos.checkin.util.formatClock
import com.restos.checkin.util.formatDuration

/**
 * Экран отметки: человек опознан по PIN, показываем его имя, что именно будет
 * отмечено, и живой видоискатель.
 *
 * Отметка уходит САМА, как только в кадре появляется лицо — нажимать нечего.
 * Кнопка остаётся для случая, когда камера лица не находит (темно, планшет
 * стоит высоко): тогда отметка пройдёт без снимка, и это видно в перекличке.
 */
@Composable
fun ReadyOverlay(
    who: AttendanceLookupDto,
    restaurantName: String?,
    clockLabel: String,
    dateLabel: String,
    faceInFrame: Boolean,
    cameraReady: Boolean,
    busy: Boolean,
    preview: @Composable (Modifier) -> Unit,
    onPunch: () -> Unit,
    onCancel: () -> Unit,
) {
    val isIn = who.nextAction == "in"
    val accent = if (isIn) CheckinColors.ClockIn else CheckinColors.ClockOut

    Surface(modifier = Modifier.fillMaxSize(), color = CheckinColors.Bg) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Шапка: куда привязан планшет и который час. Часы здесь не
            // украшение — по ним сотрудник сверяет время отметки и замечает
            // сбитые часы планшета до того, как они испортят табель.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        restaurantName ?: "RestOS",
                        style = MaterialTheme.typography.titleMedium,
                        color = CheckinColors.TextPrimary,
                    )
                    Text(
                        "$clockLabel · $dateLabel",
                        style = MaterialTheme.typography.labelSmall,
                        color = CheckinColors.TextTertiary,
                    )
                }
            }

            Spacer(Modifier.height(14.dp))

            // Видоискатель во всю ширину: человек должен видеть себя целиком,
            // а не в кружке — иначе непонятно, почему «лица не видно».
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp)
                    .height(326.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(CheckinColors.SurfaceMuted),
                contentAlignment = Alignment.Center,
            ) {
                if (cameraReady) preview(Modifier.fillMaxSize())

                // Овальный контур — куда встать. Без него человек не знает,
                // какую часть кадра занимать, и встаёт слишком далеко.
                Surface(
                    modifier = Modifier.size(width = 186.dp, height = 230.dp),
                    shape = CircleShape,
                    color = Color.Transparent,
                    border = BorderStroke(
                        3.dp,
                        if (faceInFrame) accent.copy(alpha = 0.9f) else Color.White.copy(alpha = 0.55f),
                    ),
                    content = {},
                )

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(14.dp),
                    verticalArrangement = Arrangement.SpaceBetween,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    StatusPill(
                        text = if (cameraReady) "Камера активна" else "Камера недоступна",
                        bg = Color.Black.copy(alpha = 0.33f),
                        fg = Color.White,
                        dot = if (cameraReady) CheckinColors.ClockIn else CheckinColors.Danger,
                    )
                    if (faceInFrame) {
                        StatusPill(
                            text = "Лицо в кадре",
                            bg = CheckinColors.ClockIn,
                            fg = Color.White,
                            icon = Icons.Outlined.CheckCircle,
                        )
                    } else if (cameraReady) {
                        StatusPill(
                            text = "Встаньте в круг",
                            bg = Color.Black.copy(alpha = 0.45f),
                            fg = Color.White,
                        )
                    } else {
                        Spacer(Modifier.height(1.dp))
                    }
                }
            }

            Spacer(Modifier.height(16.dp))

            Text(
                who.userName,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                color = CheckinColors.TextPrimary,
                textAlign = TextAlign.Center,
            )
            if (who.position.isNotBlank()) {
                Text(
                    who.position,
                    style = MaterialTheme.typography.bodyMedium,
                    color = CheckinColors.TextTertiary,
                )
            }

            Spacer(Modifier.height(12.dp))

            Surface(
                shape = RoundedCornerShape(CheckinRadius.pill),
                color = if (isIn) CheckinColors.PrimarySoft else CheckinColors.ClockOutSoft,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (isIn) Icons.AutoMirrored.Outlined.Login else Icons.AutoMirrored.Outlined.Logout,
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.size(8.dp))
                    Text(
                        if (isIn) "Отмечаем приход"
                        else "Уход · на смене ${formatDuration(who.workedMinutes)}",
                        style = MaterialTheme.typography.labelMedium,
                        color = accent,
                    )
                }
            }

            Spacer(Modifier.height(1.dp, ))
            Spacer(Modifier.weight(1f))

            Button(
                onClick = onPunch,
                enabled = !busy,
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp)
                    .height(66.dp),
                shape = RoundedCornerShape(CheckinRadius.button),
                colors = ButtonDefaults.buttonColors(
                    containerColor = accent,
                    contentColor = Color.White,
                    disabledContainerColor = accent.copy(alpha = 0.5f),
                    disabledContentColor = Color.White,
                ),
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Icon(
                        if (isIn) Icons.AutoMirrored.Outlined.Login else Icons.AutoMirrored.Outlined.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(
                        if (isIn) "Отметить приход" else "Отметить уход",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            Spacer(Modifier.height(6.dp))

            TextButton(onClick = onCancel, enabled = !busy) {
                Icon(
                    Icons.Outlined.Refresh,
                    contentDescription = null,
                    tint = CheckinColors.TextSecondary,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    "Это не вы? Начать заново",
                    style = MaterialTheme.typography.labelLarge,
                    color = CheckinColors.TextSecondary,
                )
            }
        }
    }
}

@Composable
private fun StatusPill(
    text: String,
    bg: Color,
    fg: Color,
    dot: Color? = null,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    Surface(shape = RoundedCornerShape(CheckinRadius.pill), color = bg) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (dot != null) {
                Surface(modifier = Modifier.size(8.dp), shape = CircleShape, color = dot, content = {})
                Spacer(Modifier.size(6.dp))
            }
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(15.dp))
                Spacer(Modifier.size(6.dp))
            }
            Text(text, style = MaterialTheme.typography.labelSmall, color = fg, fontWeight = FontWeight.SemiBold)
        }
    }
}
