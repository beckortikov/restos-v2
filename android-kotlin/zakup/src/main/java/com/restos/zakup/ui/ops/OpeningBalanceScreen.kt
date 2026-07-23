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
import androidx.compose.material3.MaterialTheme
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
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.util.formatMoney

/** Экран 15 «Начальный остаток» — заводится один раз, взнос собственника. */
@Composable
fun OpeningBalanceScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: OpeningBalanceViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showPicker by remember { mutableStateOf(false) }
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

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Начальный остаток", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Text("Заводится один раз при запуске. Проводится как взнос собственника.", fontSize = 12.5.sp, color = ZakupColors.TextSecondary)
                        }
                    }
                    items(state.lines, key = { it.id }) { line ->
                        ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(line.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                    Text(formatMoney(line.lineValue, ""), fontSize = 14.5.sp, fontWeight = FontWeight.Bold, color = ZakupColors.TextPrimary)
                                    Spacer(Modifier.size(8.dp))
                                    RemoveBtn { viewModel.remove(line.id) }
                                }
                                Spacer(Modifier.size(10.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    OpNumField(line.qty, { viewModel.setQty(line.id, it) }, "кол-во", line.unit, Modifier.weight(1f))
                                    Text("×", fontSize = 15.sp, color = ZakupColors.TextTertiary, modifier = Modifier.padding(horizontal = 10.dp))
                                    OpNumField(line.price, { viewModel.setPrice(line.id, it) }, "цена", "с.", Modifier.weight(1.3f))
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
                    onSubmit = viewModel::submit,
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}
