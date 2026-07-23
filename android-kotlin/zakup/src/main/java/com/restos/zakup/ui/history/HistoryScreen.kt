package com.restos.zakup.ui.history

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.RowDivider
import com.restos.zakup.ui.components.StatusBadge
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.receipts.ReceiptRow
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatCompactMoney
import com.restos.zakup.util.formatMoney
import java.math.BigDecimal

/** Экран 08 «Приёмки» — сводка месяца, фильтры, группировка по дням. */
@Composable
fun HistoryScreen(
    onBack: () -> Unit,
    viewModel: HistoryViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Приёмки", onBack = onBack)

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    SummaryCard(state.count, state.purchased, state.paid, state.debt)
                    Spacer(Modifier.height(4.dp))
                }
                item {
                    FilterChips(state.filter, viewModel::setFilter)
                    Spacer(Modifier.height(4.dp))
                }
                state.groups.forEach { group ->
                    item(key = "h_${group.dayKey}") {
                        Text(
                            group.dayLabel,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = ZakupColors.TextTertiary,
                            modifier = Modifier.padding(start = 4.dp, top = 8.dp, bottom = 2.dp),
                        )
                    }
                    item(key = "g_${group.dayKey}") {
                        ZakupCard(Modifier.fillMaxWidth()) {
                            Column {
                                group.rows.forEachIndexed { i, row ->
                                    ReceiptRowView(row)
                                    if (i < group.rows.lastIndex) RowDivider()
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
private fun SummaryCard(count: Int, purchased: BigDecimal, paid: BigDecimal, debt: BigDecimal) {
    ZakupCard(Modifier.fillMaxWidth(), padding = 16) {
        Column {
            Text("$count приёмок", fontSize = 13.sp, color = ZakupColors.TextTertiary, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(12.dp))
            Row {
                Stat("Закуплено", purchased, ZakupColors.TextPrimary, Modifier.weight(1f))
                Stat("Оплачено", paid, ZakupColors.Primary, Modifier.weight(1f))
                Stat("Долг", debt, ZakupColors.Danger, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: BigDecimal, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Column(modifier) {
        Text(formatCompactMoney(value), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = color)
        Spacer(Modifier.height(2.dp))
        Text(label, fontSize = 11.5.sp, color = ZakupColors.TextTertiary)
    }
}

@Composable
private fun FilterChips(selected: HistoryFilter, onSelect: (HistoryFilter) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        HistoryFilter.entries.forEach { f ->
            val active = f == selected
            Surface(
                shape = RoundedCornerShape(ZakupRadius.pill),
                color = if (active) ZakupColors.TextPrimary else ZakupColors.Surface,
                border = if (active) null else BorderStroke(1.dp, ZakupColors.Border),
                modifier = Modifier.clickable { onSelect(f) },
            ) {
                Text(
                    f.label,
                    color = if (active) androidx.compose.ui.graphics.Color.White else ZakupColors.TextSecondary,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }
    }
}

@Composable
private fun ReceiptRowView(row: ReceiptRow) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(row.supplierName, style = MaterialTheme.typography.titleMedium, maxLines = 1)
            Spacer(Modifier.size(2.dp))
            val pos = row.lineCount?.let { " · $it поз." } ?: ""
            Text(row.dateLabel + pos, fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(formatMoney(row.amount, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.size(4.dp))
            StatusBadge(row.status.label, row.status.kind)
        }
    }
}
