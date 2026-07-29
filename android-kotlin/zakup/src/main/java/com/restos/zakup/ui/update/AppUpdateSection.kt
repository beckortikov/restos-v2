package com.restos.zakup.ui.update

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.theme.ZakupColors

/** Секция обновления в «Ещё»: версия + проверка/установка новой с кассы. */
@Composable
fun AppUpdateRow(viewModel: AppUpdateViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val check = state.check
    val hasUpdate = check?.updateAvailable == true

    ZakupCard(Modifier.fillMaxWidth().padding(horizontal = 20.dp), padding = 16) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Версия приложения", fontSize = 14.5.sp, color = ZakupColors.TextPrimary, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.size(2.dp))
                    val sub = when {
                        hasUpdate -> "Доступно обновление ${check?.serverVersionName}"
                        check != null -> "Установлена ${state.installedName} · актуальная"
                        else -> "Установлена ${state.installedName}"
                    }
                    Text(sub, fontSize = 12.5.sp, color = if (hasUpdate) ZakupColors.Primary else ZakupColors.TextTertiary)
                }
                when {
                    state.downloading -> Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(strokeWidth = 2.dp, color = ZakupColors.Primary, modifier = Modifier.size(20.dp))
                    }
                    state.checking -> Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(strokeWidth = 2.dp, color = ZakupColors.TextTertiary, modifier = Modifier.size(20.dp))
                    }
                    hasUpdate -> ActionPill("Обновить") { viewModel.update() }
                    else -> ActionPill("Проверить", subtle = true) { viewModel.check() }
                }
            }
            if (state.needPermissionHint) {
                Spacer(Modifier.height(8.dp))
                Text("Разрешите установку из этого источника и повторите.", fontSize = 12.sp, color = ZakupColors.Warn)
            }
            if (state.error != null) {
                Spacer(Modifier.height(8.dp))
                Text(state.error!!, fontSize = 12.sp, color = ZakupColors.Danger)
            }
        }
    }
}

@Composable
private fun ActionPill(label: String, subtle: Boolean = false, onClick: () -> Unit) {
    androidx.compose.material3.Surface(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(com.restos.zakup.ui.theme.ZakupRadius.chip),
        color = if (subtle) ZakupColors.SurfaceMuted else ZakupColors.Primary,
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            label,
            color = if (subtle) ZakupColors.TextSecondary else ZakupColors.OnPrimary,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}
