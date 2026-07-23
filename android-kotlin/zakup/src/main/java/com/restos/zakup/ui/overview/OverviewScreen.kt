package com.restos.zakup.ui.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.CompareArrows
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CleaningServices
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import com.restos.zakup.ui.components.BadgeKind
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.IconTile
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.SectionHeader
import com.restos.zakup.ui.components.RowDivider
import com.restos.zakup.ui.components.StatusBadge
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.receipts.ReceiptRow
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatCompactMoney
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import java.math.BigDecimal

/** Экран 02 «Обзор закупок» — метрики, «Что закупить», последние приёмки. */
@Composable
fun OverviewScreen(
    restaurantName: String?,
    onNewReceipt: () -> Unit = {},
    onOpenToBuy: () -> Unit = {},
    onOpenHistory: () -> Unit = {},
    onOpenSuppliers: () -> Unit = {},
    onOpenNotifications: () -> Unit = {},
    onOpenMovements: () -> Unit = {},
    viewModel: OverviewViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        OverviewHeader(
            dateLabel = todayLabel(),
            restaurantName = restaurantName,
            onOpenNotifications = onOpenNotifications,
        )

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        MetricCard(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Outlined.ShoppingCart,
                            tint = ZakupColors.Warn,
                            bg = ZakupColors.WarnSoft,
                            value = state.lowCount.toString(),
                            label = "позиций ниже мин.",
                            onClick = onOpenToBuy,
                        )
                        MetricCard(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Outlined.AccountBalanceWallet,
                            tint = ZakupColors.Danger,
                            bg = ZakupColors.DangerSoft,
                            value = formatCompactMoney(state.totalDebt),
                            label = "поставщикам, с.",
                            onClick = onOpenSuppliers,
                        )
                    }
                }

                item { NewReceiptButton(onClick = onNewReceipt) }

                item {
                    SectionHeader(
                        title = "Что закупить",
                        actionLabel = if (state.lowCount > 0) "Все ${state.lowCount}" else null,
                        onAction = onOpenToBuy,
                    )
                    Spacer(Modifier.height(2.dp))
                }
                if (state.toBuy.isEmpty()) {
                    item { InfoCard("Все позиции выше минимума 👍") }
                } else {
                    item {
                        ZakupCard(Modifier.fillMaxWidth()) {
                            Column {
                                state.toBuy.forEachIndexed { i, row ->
                                    ToBuyRowView(row)
                                    if (i < state.toBuy.lastIndex) RowDivider()
                                }
                            }
                        }
                    }
                }

                item {
                    Spacer(Modifier.height(4.dp))
                    SectionHeader(title = "Последние приёмки", actionLabel = "История", onAction = onOpenHistory)
                    Spacer(Modifier.height(2.dp))
                }
                if (state.recent.isEmpty()) {
                    item { InfoCard("Приёмок пока нет") }
                } else {
                    item {
                        ZakupCard(Modifier.fillMaxWidth()) {
                            Column {
                                state.recent.forEachIndexed { i, row ->
                                    RecentReceiptRow(row)
                                    if (i < state.recent.lastIndex) RowDivider()
                                }
                            }
                        }
                    }
                }

                item {
                    Spacer(Modifier.height(4.dp))
                    SectionHeader(title = "Последние операции", actionLabel = "Все", onAction = onOpenMovements)
                    Spacer(Modifier.height(2.dp))
                }
                if (state.recentOps.isEmpty()) {
                    item { InfoCard("Операций пока нет") }
                } else {
                    item {
                        ZakupCard(Modifier.fillMaxWidth()) {
                            Column {
                                state.recentOps.forEachIndexed { i, row ->
                                    RecentOpRow(row)
                                    if (i < state.recentOps.lastIndex) RowDivider()
                                }
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

@Composable
private fun OverviewHeader(dateLabel: String, restaurantName: String?, onOpenNotifications: () -> Unit) {
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(dateLabel, fontSize = 12.5.sp, color = ZakupColors.TextTertiary, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text("Обзор закупок", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
        }
        Surface(
            onClick = onOpenNotifications,
            shape = androidx.compose.foundation.shape.CircleShape,
            color = ZakupColors.Surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
            modifier = Modifier.size(42.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Notifications, contentDescription = "Уведомления", tint = ZakupColors.TextPrimary, modifier = Modifier.size(20.dp))
            }
        }
        Spacer(Modifier.size(10.dp))
        if (!restaurantName.isNullOrBlank()) {
            com.restos.zakup.ui.components.Avatar(com.restos.zakup.util.initialsOf(restaurantName), size = 40)
        }
    }
}

private val monthsGen = listOf(
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)
private val weekdays = listOf("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")

private fun todayLabel(): String {
    val d = java.time.LocalDate.now()
    val wd = weekdays[d.dayOfWeek.value - 1]
    return "$wd, ${d.dayOfMonth} ${monthsGen[d.monthValue - 1]}"
}

@Composable
private fun MetricCard(
    modifier: Modifier,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: androidx.compose.ui.graphics.Color,
    bg: androidx.compose.ui.graphics.Color,
    value: String,
    label: String,
    onClick: (() -> Unit)? = null,
) {
    ZakupCard(if (onClick != null) modifier.clickable(onClick = onClick) else modifier, padding = 16) {
        Column {
            IconTile(icon = icon, tint = tint, bg = bg, size = 34)
            Spacer(Modifier.height(12.dp))
            Text(value, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.height(2.dp))
            Text(label, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
    }
}

@Composable
private fun NewReceiptButton(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(ZakupRadius.button),
        color = ZakupColors.Primary,
        modifier = Modifier.fillMaxWidth().height(56.dp),
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = ZakupColors.OnPrimary)
            Spacer(Modifier.size(8.dp))
            Text("Новая приёмка", color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun ToBuyRowView(row: ToBuyRow) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        val danger = row.urgency == BuyUrgency.Out
        IconTile(
            icon = Icons.Outlined.ShoppingCart,
            tint = if (danger) ZakupColors.Danger else ZakupColors.Warn,
            bg = if (danger) ZakupColors.DangerSoft else ZakupColors.WarnSoft,
            size = 38,
        )
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.size(2.dp))
            val left = if (row.qty.signum() <= 0) "Остаток 0" else "Осталось ${formatQty(row.qty, null)}"
            Text("$left · мин ${formatQty(row.minQty, row.unit)}", fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
        if (danger) StatusBadge("Нет", BadgeKind.Danger)
        else StatusBadge("Мало", BadgeKind.Warn)
    }
}

@Composable
private fun RecentReceiptRow(row: ReceiptRow) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        IconTile(icon = Icons.Outlined.ReceiptLong, tint = ZakupColors.TextSecondary, bg = ZakupColors.SurfaceMuted, size = 38)
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(row.supplierName, style = MaterialTheme.typography.titleMedium, maxLines = 1)
            Spacer(Modifier.size(2.dp))
            Text(row.dateLabel, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(formatMoney(row.amount, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.size(4.dp))
            StatusBadge(row.status.label, row.status.kind)
        }
    }
}

@Composable
private fun RecentOpRow(row: com.restos.zakup.ui.ops.MovementRow) {
    val icon = when (row.kindLabel) {
        "Списание" -> Icons.Outlined.DeleteOutline
        "Возврат поставщику" -> Icons.AutoMirrored.Outlined.KeyboardReturn
        "Инвентаризация" -> Icons.AutoMirrored.Outlined.Assignment
        "Начальный остаток" -> Icons.Outlined.Inbox
        "Расход хозтоваров" -> Icons.Outlined.CleaningServices
        "Перемещение" -> Icons.AutoMirrored.Outlined.CompareArrows
        else -> Icons.Outlined.ReceiptLong
    }
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        IconTile(icon = icon, tint = ZakupColors.TextSecondary, bg = ZakupColors.SurfaceMuted, size = 38)
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(row.title, style = MaterialTheme.typography.titleMedium, maxLines = 1)
            Spacer(Modifier.size(2.dp))
            Text("${row.kindLabel} · ${row.dateLabel}", fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
        Text(
            row.qtyText,
            fontSize = 14.5.sp,
            fontWeight = FontWeight.Bold,
            color = if (row.positive) ZakupColors.Primary else ZakupColors.Danger,
        )
    }
}

@Composable
private fun InfoCard(text: String) {
    ZakupCard(Modifier.fillMaxWidth(), padding = 16) {
        Text(text, fontSize = 13.sp, color = ZakupColors.TextTertiary)
    }
}
