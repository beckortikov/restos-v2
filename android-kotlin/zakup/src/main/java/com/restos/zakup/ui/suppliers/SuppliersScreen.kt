package com.restos.zakup.ui.suppliers

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.restos.zakup.ui.components.Avatar
import com.restos.zakup.ui.components.BadgeKind
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.StatusBadge
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatCompactMoney
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.initialsOf

/** Экран 04 «Поставщики» — общий долг + карточки поставщиков. */
@Composable
fun SuppliersScreen(
    onOpenSupplier: (String) -> Unit = {},
    viewModel: SuppliersViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(title = "Поставщики")

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    DebtSummaryCard(
                        total = state.totalDebt,
                        count = state.count,
                        withDebt = state.withDebt,
                    )
                    Spacer(Modifier.height(6.dp))
                }
                items(state.rows, key = { it.id }) { row ->
                    SupplierCard(row, onClick = { onOpenSupplier(row.id) })
                }
            }
        }
    }
}

@Composable
private fun DebtSummaryCard(total: java.math.BigDecimal, count: Int, withDebt: Int) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.Primary,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp)) {
            Text("Общий долг поставщикам", color = ZakupColors.OnPrimary.copy(alpha = 0.85f), fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(6.dp))
            Text(formatCompactMoney(total), color = ZakupColors.OnPrimary, fontSize = 27.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(2.dp))
            Text("сум", color = ZakupColors.OnPrimary.copy(alpha = 0.85f), fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            Text(
                "$count поставщиков · $withDebt с долгом",
                color = ZakupColors.OnPrimary.copy(alpha = 0.9f),
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

@Composable
private fun SupplierCard(row: SupplierRow, onClick: () -> Unit) {
    ZakupCard(Modifier.fillMaxWidth().clickable(onClick = onClick), padding = 14) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(initialsOf(row.name))
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(row.name, style = MaterialTheme.typography.titleMedium)
                val sub = listOfNotNull(row.contact, row.phone).joinToString(" · ")
                if (sub.isNotBlank()) {
                    Spacer(Modifier.size(2.dp))
                    Text(sub, fontSize = 12.5.sp, color = ZakupColors.TextTertiary, maxLines = 1)
                }
                if (row.categories.isNotEmpty()) {
                    Spacer(Modifier.size(6.dp))
                    Text(row.categories.joinToString(" · "), fontSize = 11.5.sp, color = ZakupColors.TextSecondary)
                }
            }
            Spacer(Modifier.size(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                if (row.debt.signum() > 0) {
                    Text("− ${formatMoney(row.debt)}", color = ZakupColors.Danger, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.size(4.dp))
                    StatusBadge("Долг", BadgeKind.Danger)
                } else {
                    StatusBadge("Без долга", BadgeKind.Success)
                }
            }
        }
    }
}
