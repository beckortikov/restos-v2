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
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.LocalShipping
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Warehouse
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restos.core.auth.MeData
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
) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
    ) {
        ZakupScreenHeader(title = "Ещё")

        ProfileCard(me)

        Section("ОПЕРАЦИИ") {
            MoreRow(Icons.Outlined.Inventory2, "Инвентаризация") { onOperation(MoreOps.INVENTORY) }
            MoreRow(Icons.Outlined.RemoveCircleOutline, "Списание") { onOperation(MoreOps.WRITEOFF) }
            MoreRow(Icons.Outlined.CleaningServices, "Расход хозтоваров") { onOperation(MoreOps.SUPPLY_EXPENSE) }
            MoreRow(Icons.Outlined.Inbox, "Начальный остаток", last = true) { onOperation(MoreOps.OPENING_BALANCE) }
        }

        Section("СПРАВОЧНИКИ") {
            MoreRow(Icons.Outlined.Warehouse, "Склады", trailing = "3")
            MoreRow(Icons.Outlined.Category, "Категории ингредиентов")
            MoreRow(Icons.Outlined.LocalShipping, "Все поставщики", last = true)
        }

        Section("ПРИЛОЖЕНИЕ") {
            MoreRow(Icons.Outlined.Notifications, "Уведомления")
            MoreRow(Icons.Outlined.Language, "Язык", trailing = "Русский")
            MoreRow(Icons.Outlined.Info, "О приложении", trailing = "v1.0", last = true)
        }

        Spacer(Modifier.size(16.dp))

        // Выйти из аккаунта
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .clickable(onClick = onLogout),
            shape = RoundedCornerShape(ZakupRadius.card),
            color = ZakupColors.Surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
        ) {
            Row(
                Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null, tint = ZakupColors.Danger, modifier = Modifier.size(20.dp))
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
            .padding(horizontal = 20.dp),
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.Surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
    ) {
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                modifier = Modifier.size(48.dp),
                shape = RoundedCornerShape(ZakupRadius.tile),
                color = ZakupColors.PrimarySoft,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(initials(name), color = ZakupColors.Primary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                }
            }
            Spacer(Modifier.size(12.dp))
            Column {
                Text(name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary)
                Spacer(Modifier.size(2.dp))
                Text("Закупщик · $restaurant", fontSize = 13.sp, color = ZakupColors.TextTertiary)
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
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            modifier = Modifier.padding(start = 24.dp, top = 20.dp, bottom = 8.dp),
        )
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
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
    const val SUPPLY_EXPENSE = "supply-expense"
    const val OPENING_BALANCE = "opening-balance"
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
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = ZakupColors.TextSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(12.dp))
        Text(title, fontSize = 14.5.sp, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
        if (trailing != null) {
            Text(trailing, fontSize = 13.sp, color = ZakupColors.TextTertiary)
            Spacer(Modifier.size(6.dp))
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = ZakupColors.TextTertiary, modifier = Modifier.size(20.dp))
    }
    if (!last) {
        Box(
            Modifier
                .fillMaxWidth()
                .padding(start = 48.dp)
                .height(1.dp)
                .background(ZakupColors.Border),
        )
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
