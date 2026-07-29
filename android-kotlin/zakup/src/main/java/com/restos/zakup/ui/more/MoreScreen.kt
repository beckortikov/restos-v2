package com.restos.zakup.ui.more

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.CompareArrows
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sell
import androidx.compose.material.icons.outlined.Warehouse
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.core.auth.MeData
import com.restos.zakup.ui.components.IconTile
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius

/** Экран 13 «Ещё» — профиль, операции, справочники, настройки, выход.
 *  В Ф0 пункты-заглушки (навигация подключается в Ф3+), выход — рабочий. */
@Composable
fun MoreScreen(
    me: MeData?,
    onLogout: () -> Unit,
    onOperation: (String) -> Unit = {},
    onOpenSuppliers: () -> Unit = {},
    onResetServer: () -> Unit = {},
) {
    var confirmResetServer by remember { mutableStateOf(false) }

    if (confirmResetServer) {
        AlertDialog(
            onDismissRequest = { confirmResetServer = false },
            title = { Text("Пересканировать сервер?", fontWeight = FontWeight.SemiBold) },
            text = { Text("Привязка к кассе и текущая сессия будут сброшены. Нужно будет заново подключиться (QR / IP).") },
            confirmButton = {
                TextButton(onClick = {
                    confirmResetServer = false
                    onResetServer()
                }) { Text("Сканировать", color = ZakupColors.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmResetServer = false }) { Text("Отмена") } },
        )
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
    ) {
        ZakupScreenHeader(title = "Ещё")

        ProfileCard(me)

        Section("ОПЕРАЦИИ") {
            MoreRow(Icons.AutoMirrored.Outlined.Assignment, "Инвентаризации") { onOperation(MoreOps.INVENTORY) }
            MoreRow(Icons.Outlined.DeleteOutline, "Списания") { onOperation(MoreOps.WRITEOFF) }
            MoreRow(Icons.AutoMirrored.Outlined.KeyboardReturn, "Возвраты поставщикам") { onOperation(MoreOps.RETURNS) }
            MoreRow(Icons.AutoMirrored.Outlined.CompareArrows, "Движения склада") { onOperation(MoreOps.MOVEMENTS) }
            MoreRow(Icons.Outlined.CleaningServices, "Расход хозтоваров") { onOperation(MoreOps.SUPPLY_EXPENSE) }
            MoreRow(Icons.Outlined.Inbox, "Начальный остаток", last = true) { onOperation(MoreOps.OPENING_BALANCE) }
        }

        Section("СПРАВОЧНИКИ") {
            MoreRow(Icons.Outlined.Warehouse, "Склады") { onOperation(MoreOps.WAREHOUSES) }
            MoreRow(Icons.Outlined.Sell, "Категории ингредиентов") { onOperation(MoreOps.CATEGORIES) }
            MoreRow(Icons.Outlined.LocalShipping, "Все поставщики", last = true) { onOpenSuppliers() }
        }

        Section("ПРИЛОЖЕНИЕ") {
            MoreRow(Icons.Outlined.Notifications, "Уведомления")
            MoreRow(Icons.Outlined.Language, "Язык", trailing = "Русский")
            MoreRow(Icons.Outlined.QrCodeScanner, "Сканировать сервер заново", last = true) { confirmResetServer = true }
        }

        Spacer(Modifier.size(12.dp))
        com.restos.zakup.ui.update.AppUpdateRow()

        Spacer(Modifier.size(16.dp))

        // Выйти из аккаунта
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .clickable(onClick = onLogout),
            shape = RoundedCornerShape(ZakupRadius.card),
            color = ZakupColors.Surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
        ) {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconTile(icon = Icons.AutoMirrored.Outlined.Logout, tint = ZakupColors.Danger, bg = ZakupColors.DangerSoft, size = 36)
                Spacer(Modifier.size(12.dp))
                Text("Выйти из аккаунта", color = ZakupColors.Danger, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        Spacer(Modifier.size(16.dp))
        Text(
            "RestOS Закупки · v1.0.0",
            color = ZakupColors.TextTertiary,
            fontSize = 12.sp,
            modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun ProfileCard(me: MeData?) {
    val name = me?.user?.displayName ?: "—"
    val restaurant = me?.restaurant?.name ?: "RestOS"
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.Surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
    ) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                modifier = Modifier.size(52.dp),
                shape = RoundedCornerShape(15.dp),
                color = ZakupColors.PrimarySoft,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(initials(name), color = ZakupColors.Primary, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
            }
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(name, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
                Spacer(Modifier.size(2.dp))
                Text("Закупщик · $restaurant", fontSize = 13.sp, color = ZakupColors.TextSecondary)
            }
        }
    }
}

@Composable
private fun Section(label: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            label,
            color = ZakupColors.TextTertiary,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 24.dp, top = 20.dp, bottom = 8.dp),
        )
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(ZakupRadius.card),
            color = ZakupColors.Surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
        ) {
            Column { content() }
        }
    }
}

object MoreOps {
    const val INVENTORY = "inventory"
    const val WRITEOFF = "writeoff"
    const val RETURNS = "returns"
    const val MOVEMENTS = "movements"
    const val SUPPLY_EXPENSE = "supply-expense"
    const val OPENING_BALANCE = "opening-balance"
    const val WAREHOUSES = "warehouses"
    const val CATEGORIES = "categories"
}

@Composable
private fun MoreRow(
    icon: ImageVector,
    title: String,
    trailing: String? = null,
    last: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(icon = icon, tint = ZakupColors.TextSecondary, bg = ZakupColors.SurfaceMuted, size = 36)
        Spacer(Modifier.size(12.dp))
        Text(title, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Text(trailing, fontSize = 13.5.sp, color = ZakupColors.TextTertiary)
            Spacer(Modifier.size(6.dp))
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = ZakupColors.TextTertiary, modifier = Modifier.size(20.dp))
    }
    if (!last) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(ZakupColors.Border))
    }
}

private fun initials(name: String): String {
    val parts = name.trim().split(" ").filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "—"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> (parts[0].take(1) + parts[1].take(1)).uppercase()
    }
}
