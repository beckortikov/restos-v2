package com.restos.kiosk.ui.welcome

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ShoppingBasket
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.kiosk.data.orders.OrderType
import com.restos.kiosk.ui.theme.KioskColors
import com.restos.kiosk.ui.theme.KioskRadius

/**
 * Стартовый экран терминала — гость выбирает формат заказа. Крупные плитки на
 * весь экран (тач с расстояния вытянутой руки), стиль Drinkit (индиго-акцент).
 * Долгий тап по лого — служебный выход (недоступен обычному гостю случайно).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WelcomeScreen(
    onSelectOrderType: (String) -> Unit,
    onStaffLogout: () -> Unit,
) {
    var confirmLogout by remember { mutableStateOf(false) }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Выйти из терминала?", fontWeight = FontWeight.SemiBold) },
            text = { Text("Понадобится PIN сотрудника, чтобы активировать терминал заново.") },
            confirmButton = {
                TextButton(onClick = { confirmLogout = false; onStaffLogout() }) {
                    Text("Выйти", color = KioskColors.Danger)
                }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Отмена") } },
        )
    }

    Surface(modifier = Modifier.fillMaxSize(), color = KioskColors.Bg) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))

            Surface(
                modifier = Modifier
                    .size(64.dp)
                    .combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                        onLongClick = { confirmLogout = true },
                    ),
                shape = RoundedCornerShape(KioskRadius.tile),
                color = KioskColors.Primary,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Outlined.Storefront,
                        contentDescription = null,
                        tint = KioskColors.OnPrimary,
                        modifier = Modifier.size(32.dp),
                    )
                }
            }

            Spacer(Modifier.height(24.dp))
            Text(
                "Добро пожаловать",
                style = MaterialTheme.typography.headlineMedium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Выберите, как получить заказ",
                style = MaterialTheme.typography.bodyLarge,
                color = KioskColors.TextSecondary,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(40.dp))

            Column(
                modifier = Modifier.fillMaxWidth().widthIn(max = 480.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                ChoiceTile(
                    title = "В зале",
                    subtitle = "Найдём вас за столиком",
                    icon = Icons.Outlined.TableRestaurant,
                    filled = true,
                    onClick = { onSelectOrderType(OrderType.HALL) },
                )
                ChoiceTile(
                    title = "С собой",
                    subtitle = "Заберёте на стойке выдачи",
                    icon = Icons.Outlined.ShoppingBasket,
                    filled = false,
                    onClick = { onSelectOrderType(OrderType.TAKEAWAY) },
                )
            }

            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun ChoiceTile(
    title: String,
    subtitle: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    filled: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().height(148.dp),
        shape = RoundedCornerShape(KioskRadius.card),
        color = if (filled) KioskColors.Primary else KioskColors.Surface,
        border = if (filled) null else androidx.compose.foundation.BorderStroke(1.5.dp, KioskColors.Border),
        onClick = onClick,
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (filled) KioskColors.OnPrimary else KioskColors.Primary,
                modifier = Modifier.size(40.dp),
            )
            Spacer(Modifier.height(10.dp))
            Text(
                title,
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (filled) KioskColors.OnPrimary else KioskColors.TextPrimary,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                subtitle,
                fontSize = 14.sp,
                color = if (filled) KioskColors.OnPrimary.copy(alpha = 0.85f) else KioskColors.TextSecondary,
            )
        }
    }
}
