package com.restos.zakup.ui.ops

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
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
import com.restos.zakup.ui.components.RowDivider
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero

/** Экран 15 «Начальный остаток» — заводится один раз, взнос собственника. */
@Composable
fun OpeningBalanceScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: OpeningBalanceViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showPicker by remember { mutableStateOf(false) }
    var confirmSubmit by remember { mutableStateOf(false) }
    var expandedLineId by remember { mutableStateOf<String?>(null) }
    LaunchedEffectDone(state.done, onDone)

    if (showPicker) {
        IngredientPickerOverlay(
            title = "Добавить в остаток",
            items = viewModel.pickItems(),
            isAdded = viewModel::isAdded,
            onToggle = viewModel::toggle,
            onClose = { showPicker = false },
        )
        return
    }

    if (confirmSubmit) {
        ConfirmDialog(
            title = "Провести начальный остаток?",
            message = "${state.lines.size} поз. на сумму ${formatMoney(state.total)}, взнос собственника. Действие нельзя отменить.",
            confirmLabel = "Провести",
            onConfirm = { confirmSubmit = false; viewModel.submit() },
            onDismiss = { confirmSubmit = false },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Начальный остаток", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.InfoSoft, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.Info, contentDescription = null, tint = ZakupColors.InfoText, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.size(8.dp))
                                Text("Заводится один раз при запуске. Проводится как взнос собственника.", fontSize = 12.5.sp, color = ZakupColors.InfoText)
                            }
                        }
                    }
                    if (state.lines.isNotEmpty()) {
                        item {
                            ZakupCard(Modifier.fillMaxWidth()) {
                                Column {
                                    state.lines.forEachIndexed { i, line ->
                                        OpeningLineRow(
                                            line = line,
                                            expanded = line.id == expandedLineId,
                                            onToggle = { expandedLineId = if (expandedLineId == line.id) null else line.id },
                                            onQty = { viewModel.setQty(line.id, it) },
                                            onPrice = { viewModel.setPrice(line.id, it) },
                                            onRemove = { viewModel.remove(line.id) },
                                        )
                                        if (i < state.lines.lastIndex) RowDivider()
                                    }
                                }
                            }
                        }
                    }
                    item { AddBtn("Добавить ингредиент в остаток") { showPicker = true } }
                    if (state.submitError != null) item { Text(state.submitError!!, color = ZakupColors.Danger, fontSize = 13.sp) }
                    item { Spacer(Modifier.height(96.dp)) }
                }
                OpSubmitBar(
                    totalLabel = "Стоимость остатка · ${state.lines.size} поз.",
                    totalValue = formatMoney(state.total),
                    totalColor = ZakupColors.TextPrimary,
                    button = "Провести остаток",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = { confirmSubmit = true },
                    modifier = Modifier.align(Alignment.BottomCenter),
                    hint = state.validationHint,
                )
            }
        }
    }
}

/** Компактная строка позиции — тап разворачивает кол-во/цену (тот же приём, что в 05). */
@Composable
private fun OpeningLineRow(
    line: OpeningLine,
    expanded: Boolean,
    onToggle: () -> Unit,
    onQty: (String) -> Unit,
    onPrice: (String) -> Unit,
    onRemove: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 14.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(line.name, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, color = ZakupColors.TextPrimary, maxLines = 1)
                Spacer(Modifier.size(2.dp))
                val hasQty = line.qty.toDecimalOrZero().signum() > 0
                if (hasQty) {
                    Text(
                        "${formatQty(line.qty.toDecimalOrZero(), line.unit)} × ${formatMoney(line.price.toDecimalOrZero(), "")}",
                        fontSize = 12.5.sp,
                        color = ZakupColors.TextTertiary,
                    )
                } else {
                    Text("Укажите кол-во и цену", fontSize = 12.5.sp, color = ZakupColors.Warn)
                }
            }
            Text(formatMoney(line.lineValue, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
        }
        if (expanded) {
            Row(
                Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OpNumField(line.qty, onQty, "кол-во", line.unit, Modifier.weight(1f))
                Text("×", fontSize = 15.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(horizontal = 10.dp))
                OpNumField(line.price, onPrice, "цена", "сум", Modifier.weight(1.3f))
                Spacer(Modifier.size(8.dp))
                RemoveBtn(onRemove)
            }
        }
    }
}
