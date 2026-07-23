package com.restos.zakup.ui.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.outlined.ShoppingBasket
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.R
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

/** Экран 01 из app_zakup.pen — PIN-вход. */
@Composable
fun PinLoginScreen(
    onLoggedIn: () -> Unit,
    onResetServer: () -> Unit = {},
    viewModel: PinLoginViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var confirmReset by remember { mutableStateOf(false) }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Сбросить сервер?", fontWeight = FontWeight.SemiBold) },
            text = { Text("Привязка к кассе и текущая сессия будут сброшены. Нужно будет заново подключиться (QR / IP).") },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    viewModel.resetServer(onResetServer)
                }) { Text("Сбросить", color = ZakupColors.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Отмена") } },
        )
    }

    Surface(modifier = Modifier.fillMaxSize(), color = ZakupColors.Bg) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(56.dp))

            // Лого-плитка «корзина»
            Surface(
                modifier = Modifier.size(72.dp),
                shape = RoundedCornerShape(ZakupRadius.card),
                color = ZakupColors.Primary,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.ShoppingBasket,
                        contentDescription = null,
                        tint = ZakupColors.OnPrimary,
                        modifier = Modifier.size(36.dp),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(
                stringResource(R.string.pin_login_title),
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                color = ZakupColors.TextPrimary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                stringResource(R.string.pin_login_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = ZakupColors.TextTertiary,
            )

            Spacer(Modifier.height(28.dp))

            // Белая карточка: точки PIN + нампад + «Войти»
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(ZakupRadius.card),
                color = ZakupColors.Surface,
                border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    PinDots(length = state.pin.length, max = PinLoginViewModel.MAX_PIN)

                    Box(
                        modifier = Modifier.fillMaxWidth().height(28.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (state.error != null) {
                            Text(
                                state.error.orEmpty(),
                                color = ZakupColors.Danger,
                                style = MaterialTheme.typography.bodySmall,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }

                    Keypad(
                        onDigit = viewModel::appendDigit,
                        onClear = viewModel::clear,
                        onBackspace = viewModel::backspace,
                        enabled = !state.loading,
                    )

                    Spacer(Modifier.height(16.dp))

                    Button(
                        onClick = { viewModel.submit(onLoggedIn) },
                        modifier = Modifier.fillMaxWidth().height(56.dp),
                        enabled = !state.loading && state.pin.length >= PinLoginViewModel.MIN_PIN_SUBMIT,
                        shape = RoundedCornerShape(ZakupRadius.button),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = ZakupColors.Primary,
                            contentColor = ZakupColors.OnPrimary,
                            disabledContainerColor = ZakupColors.Primary.copy(alpha = 0.4f),
                            disabledContentColor = ZakupColors.OnPrimary,
                        ),
                    ) {
                        if (state.loading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = ZakupColors.OnPrimary,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(Icons.AutoMirrored.Outlined.Login, contentDescription = null, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Войти", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { confirmReset = true }, enabled = !state.loading) {
                Text("Сбросить сервер", color = ZakupColors.TextTertiary)
            }
        }
    }
}

@Composable
private fun PinDots(length: Int, max: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(max) { i ->
            Surface(
                shape = CircleShape,
                color = if (i < length) ZakupColors.Primary else ZakupColors.Border,
                modifier = Modifier.size(12.dp),
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
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        rows.forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                row.forEach { c ->
                    Key(Modifier.weight(1f), enabled = enabled, onClick = { onDigit(c) }) {
                        Text(c.toString(), fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary)
                    }
                }
            }
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Key(Modifier.weight(1f), enabled = enabled, onClick = onClear) {
                Text("Очистить", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = ZakupColors.TextSecondary)
            }
            Key(Modifier.weight(1f), enabled = enabled, onClick = { onDigit('0') }) {
                Text("0", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary)
            }
            Key(Modifier.weight(1f), enabled = enabled, onClick = onBackspace) {
                Icon(
                    Icons.AutoMirrored.Outlined.Backspace,
                    contentDescription = stringResource(R.string.pin_backspace),
                    tint = ZakupColors.TextSecondary,
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
        modifier = modifier.aspectRatio(1.5f),
        shape = RoundedCornerShape(ZakupRadius.tile),
        color = ZakupColors.SurfaceMuted,
        onClick = onClick,
        enabled = enabled,
    ) {
        Box(contentAlignment = Alignment.Center) { content() }
    }
}
