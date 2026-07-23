package com.restos.zakup.ui.supplier

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Message
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Place
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.Avatar
import com.restos.zakup.ui.components.BadgeKind
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
import com.restos.zakup.util.initialsOf

/** Экран 07 «Поставщик» — контакты, долг, обороты, накладные. */
@Composable
fun SupplierDetailScreen(
    onBack: () -> Unit,
    viewModel: SupplierDetailViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var showPay by remember { mutableStateOf(false) }

    if (showPay && state.debt.signum() > 0) {
        com.restos.zakup.ui.paydebt.PayDebtSheet(
            supplierId = state.supplierId,
            supplierName = state.name,
            debt = state.debt,
            onDismiss = { showPay = false },
            onPaid = {
                showPay = false
                viewModel.load()
            },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Поставщик", onBack = onBack)

        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    ZakupCard(Modifier.fillMaxWidth(), padding = 16) {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Avatar(initialsOf(state.name), size = 52)
                                Spacer(Modifier.size(12.dp))
                                Column {
                                    Text(state.name, style = MaterialTheme.typography.titleLarge)
                                    val sub = state.contact ?: "—"
                                    Text(sub, fontSize = 13.sp, color = ZakupColors.TextTertiary)
                                }
                            }
                            Spacer(Modifier.height(14.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                ContactAction("Позвонить", Icons.Outlined.Call, enabled = state.phone != null, modifier = Modifier.weight(1f)) {
                                    state.phone?.let { context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$it"))) }
                                }
                                ContactAction("SMS", Icons.AutoMirrored.Outlined.Message, enabled = state.phone != null, modifier = Modifier.weight(1f)) {
                                    state.phone?.let { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("smsto:$it"))) }
                                }
                                ContactAction("На карте", Icons.Outlined.Place, enabled = true, modifier = Modifier.weight(1f)) {
                                    val q = Uri.encode(state.name)
                                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$q"))) }
                                }
                            }
                        }
                    }
                }

                item { DebtCard(state, onPay = { showPay = true }) }

                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        StatCard("${state.receiptsCount}", "приёмок", Modifier.weight(1f))
                        StatCard(formatCompactMoney(state.turnover), "оборот", Modifier.weight(1f))
                        val cat = state.categories.firstOrNull() ?: "—"
                        val extra = if (state.categories.size > 1) "+${state.categories.size - 1} кат." else "категория"
                        StatCard(cat, extra, Modifier.weight(1f))
                    }
                }

                item {
                    Text(
                        "Накладные",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = ZakupColors.TextPrimary,
                        modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                    )
                }
                if (state.receipts.isEmpty()) {
                    item { ZakupCard(Modifier.fillMaxWidth(), padding = 16) { Text("Накладных нет", fontSize = 13.sp, color = ZakupColors.TextTertiary) } }
                } else {
                    item {
                        ZakupCard(Modifier.fillMaxWidth()) {
                            Column {
                                state.receipts.forEachIndexed { i, row ->
                                    InvoiceRow(row)
                                    if (i < state.receipts.lastIndex) RowDivider()
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
private fun ContactAction(label: String, icon: ImageVector, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(ZakupRadius.tile),
        color = ZakupColors.SurfaceMuted,
        modifier = modifier.height(44.dp),
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = if (enabled) ZakupColors.Primary else ZakupColors.TextTertiary, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(6.dp))
            Text(label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = if (enabled) ZakupColors.TextPrimary else ZakupColors.TextTertiary)
        }
    }
}

@Composable
private fun DebtCard(state: SupplierDetailUiState, onPay: () -> Unit) {
    val hasDebt = state.debt.signum() > 0
    if (!hasDebt) {
        // Без долга — светлая карточка.
        ZakupCard(Modifier.fillMaxWidth(), padding = 18) {
            Column {
                Text("Текущий долг", color = ZakupColors.TextTertiary, fontSize = 13.sp)
                Spacer(Modifier.height(6.dp))
                Text("Без долга", color = ZakupColors.TextPrimary, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            }
        }
        return
    }
    // Есть долг — тёмная карта (как в макете).
    Surface(
        shape = RoundedCornerShape(ZakupRadius.card),
        color = ZakupColors.SurfaceDark,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text("Текущий долг", color = ZakupColors.OnDarkMuted, fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text(formatMoney(state.debt, ""), color = ZakupColors.OnDark, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.size(6.dp))
                        Text("с.", color = ZakupColors.OnDarkMuted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 3.dp))
                    }
                }
                if (state.agingDays != null) {
                    StatusBadge("${state.agingDays} дней", BadgeKind.Danger)
                }
            }
            Spacer(Modifier.height(12.dp))
            androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().height(1.dp).background(ZakupColors.DarkTile))
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Лимит ${formatMoney(state.creditLimit, "")} · отсрочка ${state.termsDays} дн",
                    color = ZakupColors.OnDarkMuted,
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                Surface(onClick = onPay, shape = RoundedCornerShape(ZakupRadius.chip), color = ZakupColors.Primary) {
                    Text("Погасить", color = ZakupColors.OnPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
                }
            }
        }
    }
}

@Composable
private fun StatCard(value: String, label: String, modifier: Modifier) {
    ZakupCard(modifier, padding = 16) {
        Column {
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.height(2.dp))
            Text(label, fontSize = 12.sp, color = ZakupColors.TextTertiary)
        }
    }
}

@Composable
private fun InvoiceRow(row: ReceiptRow) {
    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(row.dateLabel, style = MaterialTheme.typography.titleMedium)
            row.lineCount?.let {
                Spacer(Modifier.size(2.dp))
                Text("$it позиций", fontSize = 12.sp, color = ZakupColors.TextTertiary)
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(formatMoney(row.amount, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.size(4.dp))
            StatusBadge(row.status.label, row.status.kind)
        }
    }
}
