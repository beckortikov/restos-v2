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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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

/** Экран 16 «Расход хозтоваров». */
@Composable
fun SupplyExpenseScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: SupplyExpenseViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showPicker by remember { mutableStateOf(false) }
    var confirmSubmit by remember { mutableStateOf(false) }
    LaunchedEffectDone(state.done, onDone)

    if (showPicker) {
        IngredientPickerOverlay(
            title = "Хозтовары",
            items = viewModel.pickItems(),
            isAdded = viewModel::isAdded,
            onToggle = viewModel::toggle,
            onClose = { showPicker = false },
        )
        return
    }

    if (confirmSubmit) {
        ConfirmDialog(
            title = "Оформить расход?",
            message = "${state.lines.size} поз. хозтоваров будет списано. Действие нельзя отменить.",
            confirmLabel = "Оформить",
            onConfirm = { confirmSubmit = false; viewModel.submit() },
            onDismiss = { confirmSubmit = false },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Расход хозтоваров", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item { OpLabel("Основание") }
                    item { ReasonChips(SupplyExpenseUiState.REASONS, state.reason, viewModel::setReason) }
                    item { OpLabel("Кому выдано") }
                    item {
                        Surface(shape = RoundedCornerShape(ZakupRadius.tile), color = ZakupColors.Surface, border = androidx.compose.foundation.BorderStroke(1.dp, ZakupColors.Border), modifier = Modifier.fillMaxWidth()) {
                            TextField(
                                value = state.issuedTo,
                                onValueChange = viewModel::setIssuedTo,
                                placeholder = { Text("Напр. Повар · Ойбек", color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                                colors = TextFieldDefaults.colors(
                                    focusedContainerColor = Color.Transparent,
                                    unfocusedContainerColor = Color.Transparent,
                                    focusedIndicatorColor = Color.Transparent,
                                    unfocusedIndicatorColor = Color.Transparent,
                                    focusedTextColor = ZakupColors.TextPrimary,
                                    unfocusedTextColor = ZakupColors.TextPrimary,
                                ),
                            )
                        }
                    }
                    item { OpLabel("Хозтовары · ${state.lines.size}") }
                    items(state.lines, key = { it.id }) { line ->
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(line.name, style = MaterialTheme.typography.titleMedium)
                                        Spacer(Modifier.size(2.dp))
                                        Text("остаток ${line.stock}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
                                    }
                                    RemoveBtn { viewModel.remove(line.id) }
                                }
                                Spacer(Modifier.size(10.dp))
                                OpNumField(line.qty, { viewModel.setQty(line.id, it) }, "кол-во", line.unit, Modifier.fillMaxWidth())
                            }
                        }
                    }
                    item { AddBtn("Добавить хозтовар") { showPicker = true } }
                    if (state.submitError != null) item { Text(state.submitError!!, color = ZakupColors.Danger, fontSize = 13.sp) }
                    item { Spacer(Modifier.height(96.dp)) }
                }
                OpSubmitBar(
                    totalLabel = "Позиций",
                    totalValue = "${state.lines.size}",
                    totalColor = ZakupColors.TextPrimary,
                    button = "Оформить расход · ${state.lines.size} поз.",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = { confirmSubmit = true },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}
