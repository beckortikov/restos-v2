package com.restos.waiter.ui.lan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.waiter.data.net.NetworkStatus

/**
 * Оборачивает контент. Пока NetworkProbe ещё не знает статуса — показывает
 * splash. Если Offline — блокирующий экран «Не в сети ресторана» с кнопкой
 * «Повторить». На Online рендерит content().
 */
@Composable
fun LanGuard(
    viewModel: LanGuardViewModel = hiltViewModel(),
    content: @Composable () -> Unit,
) {
    val status by viewModel.status.collectAsStateWithLifecycle()

    when (status) {
        NetworkStatus.Online -> content()
        NetworkStatus.Offline -> OfflineScreen(onRetry = viewModel::probeNow)
        NetworkStatus.Unknown -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
    }
}

@Composable
private fun OfflineScreen(onRetry: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Surface(
                modifier = Modifier.size(96.dp),
                shape = CircleShape,
                color = MaterialTheme.colorScheme.errorContainer
                    .copy(alpha = 0.4f),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.WifiOff,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(48.dp),
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
            Text(
                "Не в сети ресторана",
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Приложение работает только в локальной сети заведения. " +
                    "Подключитесь к Wi-Fi ресторана и попробуйте снова.",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
            Button(
                onClick = onRetry,
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Text("Повторить попытку", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Маленькая «онлайн-точка» для шапки. */
@Composable
fun NetworkStatusDot(status: NetworkStatus, modifier: Modifier = Modifier) {
    val color = when (status) {
        NetworkStatus.Online -> Color(0xFF10B981)
        NetworkStatus.Offline -> Color(0xFFEF4444)
        NetworkStatus.Unknown -> Color(0xFFFBBF24)
    }
    Surface(
        modifier = modifier.size(8.dp),
        shape = CircleShape,
        color = color,
        content = {},
    )
}
