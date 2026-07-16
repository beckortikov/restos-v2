package com.restos.waiter.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.SystemUpdateAlt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.roundToInt

/**
 * Секция «Обновление приложения» в профиле официанта: показывает текущую
 * версию, сверяет с кассой при открытии и даёт кнопку обновления в один тап
 * (скачивание по LAN + системная установка).
 */
@Composable
fun AppUpdateSection(viewModel: AppUpdateViewModel = hiltViewModel()) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.check() }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Текущая версия",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                )
                Text(
                    "v${s.installedName.ifBlank { "—" }}",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (s.checking) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }

        val check = s.check
        when {
            s.error != null -> {
                Text(s.error!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                OutlinedButton(onClick = viewModel::check, modifier = Modifier.fillMaxWidth()) {
                    Text("Повторить")
                }
            }

            s.downloading -> {
                LinearProgressIndicator(
                    progress = { s.progress },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Загрузка обновления… ${(s.progress * 100).roundToInt()}%",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }

            check?.updateAvailable == true -> {
                if (s.needPermissionHint) {
                    Text(
                        "Разрешите установку из этого источника и нажмите «Обновить» снова.",
                        color = Color(0xFF92400E),
                        fontSize = 12.sp,
                    )
                }
                Button(
                    onClick = viewModel::update,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Icon(Icons.Outlined.SystemUpdateAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("Обновить до v${check.serverVersionName}", fontWeight = FontWeight.SemiBold)
                }
            }

            check?.available == true -> {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Icon(
                        Icons.Outlined.CheckCircle,
                        contentDescription = null,
                        tint = Color(0xFF10B981),
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.size(6.dp))
                    Text(
                        "Установлена последняя версия",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                    )
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = viewModel::check) { Text("Проверить") }
                }
            }

            check != null -> {
                // available == false — на кассе ещё не загрузили APK.
                Text(
                    "На кассе не загружен APK для обновления.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
        }
    }
}
