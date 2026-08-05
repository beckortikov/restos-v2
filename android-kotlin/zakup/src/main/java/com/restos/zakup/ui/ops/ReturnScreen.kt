package com.restos.zakup.ui.ops

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.outlined.ReceiptLong
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.ConfirmDialog
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.IconTile
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero
import java.math.BigDecimal

/** Экран 09 «Возврат поставщику». */
@Composable
fun ReturnScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: ReturnViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var confirmSubmit by remember { mutableStateOf(false) }
    LaunchedEffectDone(state.done, onDone)

    if (confirmSubmit) {
        ConfirmDialog(
            title = "Оформить возврат?",
            message = "Возврат на сумму ${formatMoney(state.total)}. Остатки уменьшатся, действие нельзя отменить.",
            confirmLabel = "Оформить",
            danger = true,
            onConfirm = { confirmSubmit = false; viewModel.submit() },
            onDismiss = { confirmSubmit = false },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Возврат поставщику", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconTile(icon = Icons.Outlined.ReceiptLong, tint = ZakupColors.TextSecondary, bg = ZakupColors.SurfaceMuted, size = 38)
                                Spacer(Modifier.size(12.dp))
                                Column {
                                    Text("Накладная", style = MaterialTheme.typography.titleMedium)
                                    Spacer(Modifier.size(2.dp))
                                    Text("${state.supplierName} · ${state.receiptDate}", fontSize = 12.5.sp, color = ZakupColors.TextTertiary)
                                }
                            }
                        }
                    }

                    item { OpLabel("Причина возврата") }
                    item {
                        ReasonChips(
                            reasons = ReturnReason.entries.map { it.label },
                            selected = state.reason.label,
                            onSelect = { lbl -> ReturnReason.entries.firstOrNull { it.label == lbl }?.let(viewModel::setReason) },
                            activeColor = ZakupColors.Danger,
                        )
                    }

                    item { OpLabel("Что возвращаем") }
                    items(state.lines, key = { it.receiptLineId }) { line ->
                        val qty = line.qty.toDecimalOrZero()
                        val checked = qty.signum() > 0
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(line.name, style = MaterialTheme.typography.titleMedium)
                                    Spacer(Modifier.size(2.dp))
                                    Text(
                                        "макс ${formatQty(line.available, line.unit)} · ${formatMoney(line.price, "")}/${line.unit ?: ""}",
                                        fontSize = 12.sp,
                                        color = ZakupColors.TextTertiary,
                                    )
                                }
                                CheckStepperRow(
                                    checked = checked,
                                    qtyText = line.qty,
                                    unit = line.unit,
                                    checkedColor = ZakupColors.Danger,
                                    onToggle = {
                                        viewModel.setQty(line.receiptLineId, if (checked) "0" else line.available.stripTrailingZeros().toPlainString())
                                    },
                                    onDec = {
                                        val next = (qty - BigDecimal.ONE).coerceAtLeast(BigDecimal.ZERO)
                                        viewModel.setQty(line.receiptLineId, next.stripTrailingZeros().toPlainString())
                                    },
                                    onInc = {
                                        val next = (qty + BigDecimal.ONE).coerceAtMost(line.available)
                                        viewModel.setQty(line.receiptLineId, next.stripTrailingZeros().toPlainString())
                                    },
                                    onQtyText = { viewModel.setQty(line.receiptLineId, it) },
                                )
                            }
                        }
                    }

                    item { OpLabel("Возврат средств") }
                    item {
                        Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.SurfaceMuted, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(4.dp)) {
                                RefundSeg("В счёт долга", state.refund == RefundType.Debt, Modifier.weight(1f)) { viewModel.setRefund(RefundType.Debt) }
                                RefundSeg("Деньгами", state.refund == RefundType.Money, Modifier.weight(1f)) { viewModel.setRefund(RefundType.Money) }
                            }
                        }
                    }
                    item {
                        val note = if (state.refund == RefundType.Debt) "Долг поставщику уменьшится на сумму возврата."
                        else "Деньги вернутся на выбранный счёт."
                        Text(note, fontSize = 12.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(start = 4.dp))
                    }
                    if (state.refund == RefundType.Money) {
                        items(state.accounts, key = { it.id }) { acc ->
                            val selected = acc.id == state.accountId
                            Surface(
                                shape = RoundedCornerShape(ZakupRadius.tile),
                                color = if (selected) ZakupColors.PrimarySoft else ZakupColors.Surface,
                                border = BorderStroke(1.dp, if (selected) ZakupColors.Primary else ZakupColors.Border),
                                modifier = Modifier.fillMaxWidth().clickable { viewModel.selectAccount(acc.id) },
                            ) {
                                Text(acc.name.ifBlank { acc.type }, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.padding(14.dp))
                            }
                        }
                    }
                    if (state.submitError != null) item { Text(state.submitError!!, color = ZakupColors.Danger, fontSize = 13.sp) }
                    item { Spacer(Modifier.height(96.dp)) }
                }
                OpSubmitBar(
                    totalLabel = "Сумма возврата",
                    totalValue = formatMoney(state.total),
                    totalColor = ZakupColors.Danger,
                    button = "Оформить возврат",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = { confirmSubmit = true },
                    modifier = Modifier.align(Alignment.BottomCenter),
                    accentColor = ZakupColors.Danger,
                    icon = Icons.AutoMirrored.Outlined.KeyboardReturn,
                )
            }
        }
    }
}

@Composable
private fun RefundSeg(label: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(ZakupRadius.small),
        color = if (active) ZakupColors.Surface else Color.Transparent,
        modifier = modifier.height(40.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, color = if (active) ZakupColors.TextPrimary else ZakupColors.TextSecondary)
        }
    }
}
