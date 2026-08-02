package com.restos.kiosk.ui.confirm

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.kiosk.ui.theme.KioskColors
import com.restos.kiosk.ui.theme.KioskRadius

/**
 * Заказ создан, НО не оплачен — киоск не принимает оплату. Гость идёт платить
 * на кассу, называет номер заказа. Печать чека (касса, по закрытию/оплате
 * заказа) и печать бегунка на кухню (при создании — либо, если у ресторана
 * "фастфуд"/kitchen_on_pay, тоже по оплате) уже автоматика общего пайплайна
 * заказов — kiosk ничего печатать сам не должен и не может.
 *
 * Экран держится, ПОКА кассир реально не закроет/оплатит заказ (поллинг
 * статуса в ConfirmViewModel) — не по таймеру, иначе гость может уйти
 * раньше, чем каждый его чек и кухонный бегунок точно готовы. «Готово» —
 * ручной оверрайд на случай сетевого сбоя поллинга, не основной путь.
 */
@Composable
fun OrderConfirmedScreen(
    onDone: () -> Unit,
    viewModel: ConfirmViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(state.closed) {
        if (state.closed) onDone()
    }

    Surface(modifier = Modifier.fillMaxSize(), color = KioskColors.Bg) {
        Column(
            modifier = Modifier.fillMaxSize().systemBarsPadding().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))

            Box(
                modifier = Modifier.size(96.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.AutoMirrored.Outlined.ReceiptLong,
                    contentDescription = null,
                    tint = KioskColors.Primary,
                    modifier = Modifier.size(72.dp),
                )
            }

            Spacer(Modifier.height(24.dp))
            Text("Оплатите заказ на кассе", style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))

            if (state.orderNumber != null) {
                Surface(
                    shape = RoundedCornerShape(KioskRadius.tile),
                    color = KioskColors.PrimarySoft,
                ) {
                    Text(
                        "№ ${state.orderNumber}",
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 10.dp),
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                        color = KioskColors.Primary,
                    )
                }
                Spacer(Modifier.height(16.dp))
            }

            Text(
                "Назовите кассиру номер заказа и оплатите его — чек напечатается на кассе.",
                style = MaterialTheme.typography.bodyLarge,
                color = KioskColors.TextSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 420.dp),
            )

            Spacer(Modifier.height(28.dp))
            CircularProgressIndicator(color = KioskColors.Primary, modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
            Spacer(Modifier.height(10.dp))
            Text(
                "Ждём оплату на кассе…",
                style = MaterialTheme.typography.bodySmall,
                color = KioskColors.TextTertiary,
            )

            Spacer(Modifier.weight(1f))

            OutlinedButton(
                onClick = onDone,
                modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).height(52.dp),
                shape = RoundedCornerShape(KioskRadius.button),
            ) {
                Text("Готово", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = KioskColors.TextSecondary)
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}
