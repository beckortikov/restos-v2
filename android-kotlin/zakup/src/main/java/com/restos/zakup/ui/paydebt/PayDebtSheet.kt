package com.restos.zakup.ui.paydebt

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.ui.components.Avatar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.initialsOf
import java.math.BigDecimal

/** Экран 12 «Погашение долга» — bottom-sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PayDebtSheet(
    supplierId: String,
    supplierName: String,
    debt: BigDecimal,
    onDismiss: () -> Unit,
    onPaid: () -> Unit,
    viewModel: PayDebtViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(supplierId) { viewModel.start(supplierId, supplierName, debt) }
    LaunchedEffect(state.done) { if (state.done) onPaid() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ZakupColors.Surface,
        shape = RoundedCornerShape(topStart = ZakupRadius.sheet, topEnd = ZakupRadius.sheet),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 12.dp)
                .navigationBarsPadding(),
        ) {
            Text("Погасить долг", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
            Spacer(Modifier.height(14.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(initialsOf(state.supplierName))
                Spacer(Modifier.size(12.dp))
                Column {
                    Text(state.supplierName, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary)
                    Text("Текущий долг ${formatMoney(state.debt)}", fontSize = 13.sp, color = ZakupColors.TextTertiary)
                }
            }

            Spacer(Modifier.height(18.dp))

            if (state.loading) {
                Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ZakupColors.Primary)
                }
            } else {
                Text("Сумма погашения", fontSize = 13.sp, color = ZakupColors.TextSecondary)
                Spacer(Modifier.height(6.dp))
                Surface(
                    shape = RoundedCornerShape(ZakupRadius.tile),
                    color = ZakupColors.SurfaceMuted,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            formatMoney(state.amount, ""),
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = ZakupColors.TextPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        Text("сум", fontSize = 13.sp, color = ZakupColors.TextTertiary)
                    }
                }

                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PresetChip("25%", Modifier.weight(1f)) { viewModel.setFraction(0.25) }
                    PresetChip("50%", Modifier.weight(1f)) { viewModel.setFraction(0.5) }
                    PresetChip("Весь долг", Modifier.weight(1f)) { viewModel.setAllDebt() }
                }

                Spacer(Modifier.height(16.dp))
                Text("Счёт списания", fontSize = 13.sp, color = ZakupColors.TextSecondary)
                Spacer(Modifier.height(6.dp))
                state.accounts.forEach { acc ->
                    val selected = acc.id == state.accountId
                    Surface(
                        shape = RoundedCornerShape(ZakupRadius.tile),
                        color = if (selected) ZakupColors.PrimarySoft else ZakupColors.Surface,
                        border = BorderStroke(1.dp, if (selected) ZakupColors.Primary else ZakupColors.Border),
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { viewModel.selectAccount(acc.id) },
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(acc.name.ifBlank { acc.type }, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, modifier = Modifier.weight(1f))
                            Text("Остаток ${formatMoney(acc.balance.toBigDecimalOrDefault())}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    "Останется долг ${formatMoney(state.remaining)}",
                    fontSize = 13.sp,
                    color = ZakupColors.TextSecondary,
                )

                if (state.error != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(state.error!!, color = ZakupColors.Danger, fontSize = 13.sp)
                }

                Spacer(Modifier.height(16.dp))
                Surface(
                    onClick = viewModel::submit,
                    enabled = state.canSubmit,
                    shape = RoundedCornerShape(ZakupRadius.button),
                    color = if (state.canSubmit) ZakupColors.Primary else ZakupColors.Primary.copy(alpha = 0.4f),
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                ) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (state.submitting) {
                            CircularProgressIndicator(color = ZakupColors.OnPrimary, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        } else {
                            Text("Погасить ${formatMoney(state.amount, "")}", color = ZakupColors.OnPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PresetChip(label: String, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(ZakupRadius.chip),
        color = ZakupColors.Surface,
        border = BorderStroke(1.dp, ZakupColors.Border),
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Box(Modifier.padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
            Text(label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextSecondary, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

private fun String.toBigDecimalOrDefault(): BigDecimal = trim().toBigDecimalOrNull() ?: BigDecimal.ZERO
