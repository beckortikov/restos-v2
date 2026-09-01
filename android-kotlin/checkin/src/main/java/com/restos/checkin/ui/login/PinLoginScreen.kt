package com.restos.checkin.ui.login

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.checkin.R
import com.restos.checkin.ui.theme.CheckinColors
import com.restos.checkin.ui.theme.CheckinRadius

/**
 * Активация терминала учёта времени по PIN.
 *
 * Раскладка повторяет PIN-экран официанта и киоска (точки-индикаторы + крупный
 * цифровой блок) — сотрудник, который уже видел эти экраны, вводит PIN не
 * задумываясь.
 */
@Composable
fun PinLoginScreen(
    onLoggedIn: () -> Unit,
    onResetServer: () -> Unit = {},
    viewModel: PinLoginViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val restaurantName by viewModel.restaurantName.collectAsStateWithLifecycle()
    var confirmReset by remember { mutableStateOf(false) }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Сбросить сервер?", fontWeight = FontWeight.SemiBold) },
            text = { Text("Привязка к кассе и текущая активация будут сброшены. Нужно будет заново подключиться (QR / IP).") },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    viewModel.resetServer(onResetServer)
                }) { Text("Сбросить", color = CheckinColors.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Отмена") } },
        )
    }

    Surface(modifier = Modifier.fillMaxSize(), color = CheckinColors.Bg) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(56.dp))

            Surface(
                modifier = Modifier
                    .size(72.dp)
                    .shadow(
                        elevation = 10.dp,
                        shape = RoundedCornerShape(CheckinRadius.card),
                        ambientColor = CheckinColors.Primary.copy(alpha = 0.27f),
                        spotColor = CheckinColors.Primary.copy(alpha = 0.27f),
                    ),
                shape = RoundedCornerShape(CheckinRadius.card),
                color = CheckinColors.Primary,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.Schedule,
                        contentDescription = null,
                        tint = CheckinColors.OnPrimary,
                        modifier = Modifier.size(34.dp),
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            Text(
                stringResource(R.string.pin_login_title),
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = CheckinColors.TextPrimary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                stringResource(R.string.pin_login_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = CheckinColors.TextSecondary,
                textAlign = TextAlign.Center,
            )
            // Куда привязан планшет — видно до ввода PIN, иначе легко активировать
            // терминал на соседний филиал и заметить это только по пустому табелю.
            restaurantName?.let { name ->
                Spacer(Modifier.height(10.dp))
                Surface(
                    shape = RoundedCornerShape(CheckinRadius.pill),
                    color = CheckinColors.PrimarySoft,
                ) {
                    Text(
                        name,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = CheckinColors.Primary,
                    )
                }
            }

            Spacer(Modifier.height(28.dp))

            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp),
                shape = RoundedCornerShape(CheckinRadius.card),
                color = CheckinColors.Surface,
                border = BorderStroke(1.dp, CheckinColors.Border),
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    PinDots(length = state.pin.length, max = PinLoginViewModel.MAX_PIN)

                    Spacer(Modifier.height(20.dp))

                    // Место под ошибку зарезервировано, но растёт: отказ по роли —
                    // это три строки текста, а не одна, и он не должен прыгать
                    // клавиатурой вниз.
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 20.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (state.error != null) {
                            Text(
                                state.error.orEmpty(),
                                color = CheckinColors.Danger,
                                style = MaterialTheme.typography.bodySmall,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    Keypad(
                        onDigit = viewModel::appendDigit,
                        onClear = viewModel::clear,
                        onBackspace = viewModel::backspace,
                        enabled = !state.loading,
                    )

                    Spacer(Modifier.height(20.dp))

                    Button(
                        onClick = { viewModel.submit(onLoggedIn) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp)
                            .shadow(
                                elevation = 10.dp,
                                shape = RoundedCornerShape(CheckinRadius.button),
                                ambientColor = CheckinColors.Primary.copy(alpha = 0.27f),
                                spotColor = CheckinColors.Primary.copy(alpha = 0.27f),
                            ),
                        enabled = !state.loading && state.pin.length >= PinLoginViewModel.MIN_PIN_SUBMIT,
                        shape = RoundedCornerShape(CheckinRadius.button),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = CheckinColors.Primary,
                            contentColor = CheckinColors.OnPrimary,
                            disabledContainerColor = CheckinColors.Primary.copy(alpha = 0.4f),
                            disabledContentColor = CheckinColors.OnPrimary,
                        ),
                    ) {
                        if (state.loading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                color = CheckinColors.OnPrimary,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(Icons.AutoMirrored.Outlined.Login, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Активировать", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { confirmReset = true }, enabled = !state.loading) {
                Text("Сбросить сервер", color = CheckinColors.TextTertiary)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun PinDots(length: Int, max: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        repeat(max) { i ->
            val filled = i < length
            Surface(
                shape = CircleShape,
                color = if (filled) CheckinColors.Primary else Color.Transparent,
                border = if (filled) null else BorderStroke(2.dp, CheckinColors.TextTertiary),
                modifier = Modifier.size(16.dp),
                content = {},
            )
        }
    }
}

@Composable
private fun Keypad(
    onDigit: (Char) -> Unit,
    onClear: () -> Unit,
    onBackspace: () -> Unit,
    enabled: Boolean,
) {
    val rows = listOf(
        listOf('1', '2', '3'),
        listOf('4', '5', '6'),
        listOf('7', '8', '9'),
    )
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        rows.forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                row.forEach { c ->
                    Key(Modifier.weight(1f), enabled = enabled, onClick = { onDigit(c) }) {
                        Text(c.toString(), fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextPrimary)
                    }
                }
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Key(Modifier.weight(1f), enabled = enabled, onClick = onClear) {
                Text("Очистить", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextSecondary)
            }
            Key(Modifier.weight(1f), enabled = enabled, onClick = { onDigit('0') }) {
                Text("0", fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = CheckinColors.TextPrimary)
            }
            Key(Modifier.weight(1f), enabled = enabled, onClick = onBackspace) {
                Icon(
                    Icons.AutoMirrored.Outlined.Backspace,
                    contentDescription = stringResource(R.string.pin_backspace),
                    tint = CheckinColors.TextSecondary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

@Composable
private fun Key(
    modifier: Modifier,
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.height(66.dp),
        shape = RoundedCornerShape(CheckinRadius.tile),
        color = CheckinColors.SurfaceMuted,
        onClick = onClick,
        enabled = enabled,
    ) {
        Box(contentAlignment = Alignment.Center) { content() }
    }
}
