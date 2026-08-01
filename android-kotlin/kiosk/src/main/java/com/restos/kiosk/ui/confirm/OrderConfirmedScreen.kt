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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.kiosk.ui.theme.KioskColors
import com.restos.kiosk.ui.theme.KioskRadius
import kotlinx.coroutines.delay

/**
 * Заказ создан, НО не оплачен — киоск не принимает оплату. Гость идёт платить
 * на кассу, называет номер заказа. Печать чека (касса, по закрытию/оплате
 * заказа) и печать бегунка на кухню (при создании — либо, если у ресторана
 * "фастфуд"/kitchen_on_pay, тоже по оплате) уже автоматика общего пайплайна
 * заказов — kiosk ничего печатать сам не должен и не может.
 *
 * Через паузу терминал САМ возвращается на стартовый экран для следующего
 * гостя (никто не должен нажимать «выход»).
 */
@Composable
fun OrderConfirmedScreen(
    orderNumber: Int?,
    onDone: () -> Unit,
) {
    LaunchedEffect(Unit) {
        delay(8_000)
        onDone()
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

            if (orderNumber != null) {
                Surface(
                    shape = RoundedCornerShape(KioskRadius.tile),
                    color = KioskColors.PrimarySoft,
                ) {
                    Text(
                        "№ $orderNumber",
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

            Spacer(Modifier.weight(1f))

            Button(
                onClick = onDone,
                modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).height(56.dp),
                shape = RoundedCornerShape(KioskRadius.button),
                colors = ButtonDefaults.buttonColors(
                    containerColor = KioskColors.Primary,
                    contentColor = KioskColors.OnPrimary,
                ),
            ) {
                Text("Готово", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}
