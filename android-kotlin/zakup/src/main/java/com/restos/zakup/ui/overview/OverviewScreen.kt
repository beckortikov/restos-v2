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
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Add
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
    viewModel: OverviewViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        OverviewHeader(dateLabel = todayLabel(), restaurantName = restaurantName)

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
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
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

@Composable
private fun OverviewHeader(dateLabel: String, restaurantName: String?) {
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(dateLabel, fontSize = 12.5.sp, color = ZakupColors.TextTertiary, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(2.dp))
            Text("Обзор закупок", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
        }
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
            IconTile(icon = icon, tint = tint, bg = bg, size = 36)
            Spacer(Modifier.height(14.dp))
            Text(value, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
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
        Column(Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.size(2.dp))
            val left = if (row.qty.signum() <= 0) "Остаток 0" else "Осталось ${formatQty(row.qty, null)}"
            Text("$left · мин ${formatQty(row.minQty, row.unit)}", fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
        if (row.urgency == BuyUrgency.Out) StatusBadge("Нет", BadgeKind.Danger)
        else StatusBadge("Мало", BadgeKind.Warn)
    }
}

@Composable
private fun RecentReceiptRow(row: ReceiptRow) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
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
private fun InfoCard(text: String) {
    ZakupCard(Modifier.fillMaxWidth(), padding = 16) {
        Text(text, fontSize = 13.sp, color = ZakupColors.TextTertiary)
    }
}
