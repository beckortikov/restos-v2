package com.restos.zakup.ui.suppliers

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.Avatar
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.RowDivider
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.shell.ZakupScreenHeader
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatCompactMoney
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.initialsOf
import java.math.BigDecimal

/** Экран 04 «Поставщики» — тёмная карта общего долга + карточки поставщиков. */
@Composable
fun SuppliersScreen(
    onOpenSupplier: (String) -> Unit = {},
    viewModel: SuppliersViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var payFor by remember { mutableStateOf<SupplierRow?>(null) }

    payFor?.let { row ->
        com.restos.zakup.ui.paydebt.PayDebtSheet(
            supplierId = row.id,
            supplierName = row.name,
            debt = row.debt,
            onDismiss = { payFor = null },
            onPaid = { payFor = null; viewModel.load() },
        )
    }

    Column(Modifier.fillMaxSize()) {
        ZakupScreenHeader(title = "Поставщики")

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    DebtSummaryCard(
                        total = state.totalDebt,
                        count = state.count,
                        withDebt = state.withDebt,
                        overdue = state.overdueCount,
                        onPay = { state.topDebtor?.let { payFor = it } },
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
private fun DebtSummaryCard(total: BigDecimal, count: Int, withDebt: Int, overdue: Int, onPay: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.SurfaceDark,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text("Общий долг поставщикам", color = ZakupColors.OnDarkMuted, fontSize = 13.sp)
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(formatMoney(total, ""), color = ZakupColors.OnDark, fontSize = 27.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.size(6.dp))
                        Text("сум", color = ZakupColors.OnDarkMuted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 4.dp))
                    }
                }
                if (withDebt > 0) {
                    Surface(onClick = onPay, shape = RoundedCornerShape(ZakupRadius.chip), color = ZakupColors.Primary) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.AccountBalanceWallet, contentDescription = null, tint = ZakupColors.OnPrimary, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.size(6.dp))
                            Text("Погасить", color = ZakupColors.OnPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DarkTile("$count", "поставщиков", Modifier.weight(1f))
                DarkTile("$withDebt", "с долгом", Modifier.weight(1f))
                DarkTile("$overdue", "просрочен", Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun DarkTile(value: String, label: String, modifier: Modifier) {
    Box(modifier.background(ZakupColors.DarkTile, RoundedCornerShape(ZakupRadius.tile)).padding(vertical = 12.dp, horizontal = 12.dp)) {
        Column {
            Text(value, color = ZakupColors.OnDark, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(2.dp))
            Text(label, color = ZakupColors.OnDarkMuted, fontSize = 11.5.sp)
        }
    }
}

@Composable
private fun SupplierCard(row: SupplierRow, onClick: () -> Unit) {
    ZakupCard(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(initialsOf(row.name))
                Spacer(Modifier.size(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(row.name, style = MaterialTheme.typography.titleMedium)
                    val sub = listOfNotNull(row.contact, row.phone).joinToString(" · ")
                    if (sub.isNotBlank()) {
                        Spacer(Modifier.size(2.dp))
                        Text(sub, fontSize = 12.5.sp, color = ZakupColors.TextTertiary, maxLines = 1)
                    }
                }
            }
            RowDivider(0)
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                if (row.categories.isEmpty()) {
                    Text("—", fontSize = 11.5.sp, color = ZakupColors.TextSecondary, modifier = Modifier.weight(1f))
                } else {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        row.categories.forEach { cat ->
                            Surface(shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.SurfaceMuted) {
                                Text(cat, fontSize = 11.5.sp, color = ZakupColors.TextSecondary, modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp))
                            }
                        }
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    if (row.debt.signum() > 0) {
                        Text("− ${formatMoney(row.debt, "")}", color = ZakupColors.Danger, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.size(2.dp))
                        val label = when {
                            row.overdue -> "Просрочен"
                            row.agingDays != null -> "Долг · ${row.agingDays} дней"
                            else -> "Долг"
                        }
                        Text(label, fontSize = 11.5.sp, color = ZakupColors.TextTertiary)
                    } else {
                        Text("Без долга", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = ZakupColors.Primary)
                    }
                }
            }
        }
    }
}
