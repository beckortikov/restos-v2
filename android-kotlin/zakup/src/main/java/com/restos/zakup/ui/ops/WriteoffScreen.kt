package com.restos.zakup.ui.ops

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.WarningAmber
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
import com.restos.zakup.ui.components.ConfirmDialog
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero
import java.math.BigDecimal

/** Экран 10 «Списание» — убыток, для брака от поставщика — возврат. */
@Composable
fun WriteoffScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: WriteoffViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showPicker by remember { mutableStateOf(false) }
    var confirmSubmit by remember { mutableStateOf(false) }

    LaunchedEffectDone(state.done, onDone)

    if (showPicker) {
        IngredientPickerOverlay(
            title = "Позиции к списанию",
            items = viewModel.pickItems(),
            isAdded = viewModel::isAdded,
            onToggle = viewModel::toggle,
            onClose = { showPicker = false },
        )
        return
    }

    if (confirmSubmit) {
        ConfirmDialog(
            title = "Списать позиции?",
            message = "${state.lines.size} поз. на сумму ${formatMoney(state.loss)}. Остатки уменьшатся, действие нельзя отменить.",
            confirmLabel = "Списать",
            danger = true,
            onConfirm = { confirmSubmit = false; viewModel.submit() },
            onDismiss = { confirmSubmit = false },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Списание", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.DangerSoft, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = ZakupColors.DangerText, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(8.dp))
                                Text(
                                    "Списание — это убыток. Для брака от поставщика оформите возврат.",
                                    fontSize = 12.5.sp,
                                    color = ZakupColors.DangerText,
                                )
                            }
                        }
                    }
                    item { OpLabel("Причина") }
                    item { ReasonChips(WriteoffUiState.REASONS, state.reason, viewModel::setReason) }

                    if (state.warehouses.size > 1) {
                        item { OpLabel("Склад") }
                        item { WarehouseSelectorRow(state.warehouses, state.selectedWarehouse, viewModel::selectWarehouse) }
                    }

                    item { OpLabel("Позиции к списанию · ${state.lines.size}") }
                    items(state.lines, key = { it.id }) { line ->
                        val qty = line.qty.toDecimalOrZero()
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(line.name, style = MaterialTheme.typography.titleMedium)
                                    Spacer(Modifier.size(2.dp))
                                    Text(
                                        "остаток ${formatQty(line.stock, line.unit)} · ${formatMoney(line.cost, "")}/${line.unit ?: ""}",
                                        fontSize = 12.sp,
                                        color = ZakupColors.TextTertiary,
                                    )
                                }
                                CheckStepperRow(
                                    checked = true,
                                    qtyLabel = formatQty(qty, line.unit),
                                    checkedColor = ZakupColors.Danger,
                                    onToggle = { viewModel.remove(line.id) },
                                    onDec = {
                                        val next = (qty - BigDecimal.ONE).coerceAtLeast(BigDecimal.ZERO)
                                        viewModel.setQty(line.id, next.stripTrailingZeros().toPlainString())
                                    },
                                    onInc = {
                                        val next = (qty + BigDecimal.ONE).coerceAtMost(line.stock)
                                        viewModel.setQty(line.id, next.stripTrailingZeros().toPlainString())
                                    },
                                )
                            }
                        }
                    }
                    item { AddBtn("Добавить позицию") { showPicker = true } }
                    if (state.submitError != null) item { Text(state.submitError!!, color = ZakupColors.Danger, fontSize = 13.sp) }
                    item { Spacer(Modifier.height(96.dp)) }
                }
                OpSubmitBar(
                    totalLabel = "Убыток",
                    totalValue = formatMoney(state.loss),
                    totalColor = ZakupColors.Danger,
                    button = "Списать",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = { confirmSubmit = true },
                    modifier = Modifier.align(Alignment.BottomCenter),
                    accentColor = ZakupColors.Danger,
                    icon = Icons.Outlined.DeleteOutline,
                    hint = state.validationHint,
                )
            }
        }
    }
}

@Composable
fun OpLabel(text: String) {
    Text(text, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextTertiary, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
}

@Composable
fun RemoveBtn(onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(ZakupRadius.badge), color = ZakupColors.SurfaceMuted, modifier = Modifier.size(28.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Close, contentDescription = "Убрать", tint = ZakupColors.TextTertiary, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
fun AddBtn(label: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(ZakupRadius.button),
        color = ZakupColors.Surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border),
        modifier = Modifier.fillMaxWidth().height(50.dp),
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = ZakupColors.Primary)
            Spacer(Modifier.size(8.dp))
            Text(label, color = ZakupColors.Primary, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun LaunchedEffectDone(done: Boolean, onDone: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(done) { if (done) onDone() }
}
