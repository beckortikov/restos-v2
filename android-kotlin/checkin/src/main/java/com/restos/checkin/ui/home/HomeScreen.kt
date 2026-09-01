package com.restos.checkin.ui.home

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.checkin.ui.theme.CheckinColors
import com.restos.checkin.ui.theme.CheckinRadius

/**
 * Экран активированного терминала.
 *
 * Заглушка первой фазы: авторизация замкнута, отметки прихода/ухода —
 * следующая фаза (нужны серверные эндпоинты и селфи-фиксация). Показывает,
 * к какому ресторану привязан планшет и кто его активировал, чтобы ошибочную
 * привязку было видно сразу, а не по пустому табелю в конце месяца.
 */
@Composable
fun HomeScreen(
    onLoggedOut: () -> Unit,
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val me by viewModel.me.collectAsStateWithLifecycle()
    var confirmLogout by remember { mutableStateOf(false) }

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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Surface(
                modifier = Modifier.size(76.dp),
                shape = RoundedCornerShape(CheckinRadius.card),
                color = CheckinColors.PrimarySoft,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.CheckCircle,
                        contentDescription = null,
                        tint = CheckinColors.Primary,
                        modifier = Modifier.size(38.dp),
                    )
                }
            }

            Spacer(Modifier.height(20.dp))
            Text("Терминал активирован", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text(
                "Экран отметок прихода и ухода появится в следующей версии.",
                style = MaterialTheme.typography.bodyMedium,
                color = CheckinColors.TextSecondary,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(28.dp))

            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 420.dp),
                shape = RoundedCornerShape(CheckinRadius.card),
                color = CheckinColors.Surface,
                border = BorderStroke(1.dp, CheckinColors.Border),
            ) {
                Column(Modifier.padding(20.dp)) {
                    InfoRow("Ресторан", me?.restaurant?.name ?: "—")
                    Spacer(Modifier.height(12.dp))
                    InfoRow("Активировал", me?.user?.displayName ?: "—")
                }
            }

            Spacer(Modifier.height(16.dp))

            TextButton(onClick = { confirmLogout = true }) {
                Icon(
                    Icons.AutoMirrored.Outlined.Logout,
                    contentDescription = null,
                    tint = CheckinColors.TextTertiary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
                Text("Деактивировать терминал", color = CheckinColors.TextTertiary)
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = CheckinColors.TextSecondary)
        Text(value, style = MaterialTheme.typography.titleMedium)
    }
}
