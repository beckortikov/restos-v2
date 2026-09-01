package com.restos.checkin.ui.punch

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.checkin.data.attendance.AttendanceLookupDto
import com.restos.checkin.data.attendance.AttendancePunchDto
import com.restos.checkin.data.attendance.OnShiftRowDto
import com.restos.checkin.ui.components.Keypad
import com.restos.checkin.ui.components.PinDots
import com.restos.checkin.ui.theme.CheckinColors
import com.restos.checkin.ui.theme.CheckinRadius
import com.restos.checkin.util.formatClock
import com.restos.checkin.util.formatDuration
import com.restos.checkin.util.formatToday
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * Главный экран терминала: сотрудник вводит свой PIN и отмечает приход или
 * уход. Три состояния сменяют друг друга на одном экране — ввод,
 * подтверждение с именем, крупный итог, который гаснет сам.
 */
@Composable
fun PunchScreen(
    onLoggedOut: () -> Unit,
    viewModel: PunchViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val restaurantName by viewModel.restaurantName.collectAsStateWithLifecycle()
    var confirmLogout by remember { mutableStateOf(false) }

    // Часы на терминале — не украшение: сотрудник сверяет по ним, во сколько
    // отметился, и замечает сбитое время планшета до того, как оно испортит
    // табель.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = Instant.now()
            delay(1_000)
        }
    }
    // Список «на смене» обновляем сами: соседний терминал или менеджер в
    // веб-табеле могли что-то изменить.
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            viewModel.refreshOnShift()
        }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Деактивировать терминал?", fontWeight = FontWeight.SemiBold) },
            text = { Text("Планшет перестанет принимать отметки, пока его не активируют PIN-ом заново. Привязка к кассе сохранится.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    viewModel.logout(onLoggedOut)
                }) { Text("Деактивировать", color = CheckinColors.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Отмена") } },
        )
    }

    Surface(modifier = Modifier.fillMaxSize(), color = CheckinColors.Bg) {
        Box(Modifier.fillMaxSize()) {
            PinPad(
                state = state,
                nowLabel = formatClock(now),
                dateLabel = formatToday(now),
                restaurantName = restaurantName,
                onDigit = viewModel::appendDigit,
                onClear = viewModel::clear,
                onBackspace = viewModel::backspace,
                onSettings = { confirmLogout = true },
            )

            // Подтверждение и итог перекрывают экран целиком: у входа на
            // планшет смотрят секунду и издалека, поэтому важное — во весь
            // экран, а не карточкой поверх клавиатуры.
            AnimatedVisibility(
                visible = state.step is PunchStep.Confirm,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                (state.step as? PunchStep.Confirm)?.let { step ->
                    ConfirmOverlay(
                        who = step.who,
                        loading = state.loading,
                        onConfirm = viewModel::confirm,
                        onCancel = viewModel::cancel,
                    )
                }
            }
            AnimatedVisibility(
                visible = state.step is PunchStep.Done,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                (state.step as? PunchStep.Done)?.let { step ->
                    ResultOverlay(result = step.result, onDismiss = viewModel::dismissResult)
                }
            }
        }
    }
}

// ─── Экран ввода ───────────────────────────────────────────────────────────

@Composable
private fun PinPad(
    state: PunchUiState,
    nowLabel: String,
    dateLabel: String,
    restaurantName: String?,
    onDigit: (Char) -> Unit,
    onClear: () -> Unit,
    onBackspace: () -> Unit,
    onSettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(restaurantName ?: "RestOS", style = MaterialTheme.typography.labelMedium, color = CheckinColors.TextSecondary)
            }
            IconButton(onClick = onSettings) {
                Icon(
                    Icons.Outlined.MoreHoriz,
                    contentDescription = "Настройки терминала",
                    tint = CheckinColors.TextTertiary,
                )
            }
        }

        Text(
            nowLabel,
            fontSize = 64.sp,
            fontWeight = FontWeight.Bold,
            color = CheckinColors.TextPrimary,
        )
        Text(
            dateLabel.replaceFirstChar { it.uppercase() },
            style = MaterialTheme.typography.bodyMedium,
            color = CheckinColors.TextSecondary,
        )

        Spacer(Modifier.height(18.dp))

        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 440.dp),
            shape = RoundedCornerShape(CheckinRadius.card),
            color = CheckinColors.Surface,
            border = BorderStroke(1.dp, CheckinColors.Border),
        ) {
            Column(
                modifier = Modifier.padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Введите свой PIN", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(16.dp))

                Box(contentAlignment = Alignment.Center, modifier = Modifier.height(24.dp)) {
                    if (state.loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            color = CheckinColors.Primary,
                            strokeWidth = 2.dp,
                        )
                    } else {
                        PinDots(length = state.pin.length, max = PunchViewModel.PIN_LENGTH, dotSize = 18.dp)
                    }
                }

                Spacer(Modifier.height(12.dp))

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 22.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    state.error?.let {
                        Text(
                            it,
                            color = CheckinColors.Danger,
                            style = MaterialTheme.typography.bodySmall,
                            textAlign = TextAlign.Center,
                        )
                    }
                }

                Spacer(Modifier.height(8.dp))

                Keypad(
                    onDigit = onDigit,
                    onClear = onClear,
                    onBackspace = onBackspace,
                    enabled = !state.loading,
                    keyHeight = 72.dp,
                    digitSize = 26.sp,
                )
            }
        }

        Spacer(Modifier.height(18.dp))

        OnShiftStrip(rows = state.onShift, modifier = Modifier.widthIn(max = 440.dp))
    }
}

/**
 * «Сейчас на смене» — не украшение: это единственный способ для сотрудника
 * заметить, что его вчерашний уход не отметился, до того как это всплывёт
 * при расчёте зарплаты.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OnShiftStrip(rows: List<OnShiftRowDto>, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            if (rows.isEmpty()) "Сейчас никого на смене" else "Сейчас на смене · ${rows.size}",
            style = MaterialTheme.typography.labelSmall,
            color = CheckinColors.TextTertiary,
        )
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            rows.forEach { row ->
                Surface(
                    shape = RoundedCornerShape(CheckinRadius.pill),
                    color = CheckinColors.PrimarySoft,
                ) {
                    Text(
                        "${row.userName} · ${formatClock(row.clockIn)}",
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = CheckinColors.Primary,
                    )
                }
            }
        }
    }
}

// ─── Подтверждение ─────────────────────────────────────────────────────────

@Composable
private fun ConfirmOverlay(
    who: AttendanceLookupDto,
    loading: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    val isIn = who.nextAction == "in"
    val accent = if (isIn) CheckinColors.ClockIn else CheckinColors.ClockOut

    Surface(modifier = Modifier.fillMaxSize(), color = CheckinColors.Bg) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                who.userName,
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold,
                color = CheckinColors.TextPrimary,
                textAlign = TextAlign.Center,
            )
            if (who.position.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(who.position, style = MaterialTheme.typography.bodyMedium, color = CheckinColors.TextSecondary)
            }

            Spacer(Modifier.height(14.dp))

            if (!isIn) {
                Surface(shape = RoundedCornerShape(CheckinRadius.pill), color = CheckinColors.ClockOutSoft) {
                    Text(
                        "На смене с ${formatClock(who.onShiftSince)} · ${formatDuration(who.workedMinutes)}",
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = CheckinColors.ClockOut,
                    )
                }
            }

            Spacer(Modifier.height(36.dp))

            Button(
                onClick = onConfirm,
                enabled = !loading,
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp)
                    .height(84.dp),
                shape = RoundedCornerShape(CheckinRadius.button),
                colors = ButtonDefaults.buttonColors(
                    containerColor = accent,
                    contentColor = Color.White,
                    disabledContainerColor = accent.copy(alpha = 0.5f),
                    disabledContentColor = Color.White,
                ),
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = Color.White,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Icon(
                        if (isIn) Icons.AutoMirrored.Outlined.Login else Icons.AutoMirrored.Outlined.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(26.dp),
                    )
                    Spacer(Modifier.size(12.dp))
                    Text(
                        if (isIn) "Отметить приход" else "Отметить уход",
                        fontSize = 22.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }

            Spacer(Modifier.height(12.dp))

            OutlinedButton(
                onClick = onCancel,
                enabled = !loading,
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp)
                    .height(56.dp),
                shape = RoundedCornerShape(CheckinRadius.button),
                border = BorderStroke(1.dp, CheckinColors.Border),
            ) {
                Text("Это не я", color = CheckinColors.TextSecondary, fontSize = 17.sp)
            }
        }
    }
}

// ─── Итог ──────────────────────────────────────────────────────────────────

@Composable
private fun ResultOverlay(result: AttendancePunchDto, onDismiss: () -> Unit) {
    val isIn = result.action == "in"
    val accent = if (isIn) CheckinColors.ClockIn else CheckinColors.ClockOut

    Surface(modifier = Modifier.fillMaxSize(), color = accent) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                Icons.Outlined.CheckCircle,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(72.dp),
            )
            Spacer(Modifier.height(18.dp))
            Text(
                if (isIn) "Приход отмечен" else "Уход отмечен",
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                result.userName,
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
                color = Color.White.copy(alpha = 0.92f),
            )
            Spacer(Modifier.height(18.dp))
            Text(
                formatClock(result.at),
                fontSize = 56.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
            if (!isIn && result.workedMinutes > 0) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Смена: ${formatDuration(result.workedMinutes)}",
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color.White.copy(alpha = 0.92f),
                )
            }

            // Автозакрытая вчерашняя смена — единственный шанс сказать об этом
            // сотруднику, пока он стоит у планшета.
            if (result.closedStaleEntryId.isNotBlank()) {
                Spacer(Modifier.height(20.dp))
                Surface(
                    shape = RoundedCornerShape(CheckinRadius.tile),
                    color = Color.White.copy(alpha = 0.16f),
                    modifier = Modifier.widthIn(max = 420.dp),
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Outlined.WarningAmber,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.size(10.dp))
                        Text(
                            "Прошлая смена осталась незакрытой — уход не был отмечен. Скажите управляющему, чтобы поправил табель.",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color.White,
                        )
                    }
                }
            }

            Spacer(Modifier.height(28.dp))

            TextButton(onClick = onDismiss) {
                Text("Готово", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
