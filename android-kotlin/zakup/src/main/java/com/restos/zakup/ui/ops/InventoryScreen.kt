package com.restos.zakup.ui.ops

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.restos.zakup.ui.stock.WarehouseTab
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import java.math.BigDecimal

/** Экран 11 «Инвентаризация» — факт vs учёт, фильтры склад/категория. */
@Composable
fun InventoryScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: InventoryViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var confirmSubmit by remember { mutableStateOf(false) }

    if (confirmSubmit) {
        ConfirmDialog(
            title = "Применить инвентаризацию?",
            message = "Изменится ${state.changedCount} позиций. Остатки будут приведены к фактическим — действие нельзя отменить.",
            confirmLabel = "Применить",
            onConfirm = { confirmSubmit = false; viewModel.submit() },
            onDismiss = { confirmSubmit = false },
        )
    }

    state.result?.let { r ->
        AlertDialog(
            onDismissRequest = { viewModel.dismissResult(); onDone() },
            confirmButton = { TextButton(onClick = { viewModel.dismissResult(); onDone() }) { Text("Готово") } },
            title = { Text("Инвентаризация применена", fontWeight = FontWeight.Bold) },
            text = {
                Column {
                    Text("Позиций в проверке: ${r.applied}", fontSize = 14.sp, color = ZakupColors.TextSecondary)
                    Text("С расхождением: ${r.itemsWithDiff}", fontSize = 14.sp, color = ZakupColors.TextSecondary)
                    Spacer(Modifier.height(4.dp))
                    Text("Излишки: +${r.surplus}", fontSize = 14.sp, color = ZakupColors.Primary)
                    Text("Недостача: −${formatMoney(r.shortageValue)}", fontSize = 14.sp, color = ZakupColors.Danger)
                }
            },
        )
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Инвентаризация", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                Column {
                    SummaryRow(state.visible.size, state.surplusCount, state.shortageValue)
                    Text(
                        "Внесите фактический остаток — расхождение считается автоматически.",
                        fontSize = 12.sp,
                        color = ZakupColors.TextTertiary,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                    Spacer(Modifier.height(4.dp))
                    TextField(
                        value = state.query,
                        onValueChange = viewModel::setQuery,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        placeholder = { Text("Поиск ингредиента", color = ZakupColors.TextTertiary, fontSize = 14.sp) },
                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = ZakupColors.TextTertiary) },
                        singleLine = true,
                        shape = RoundedCornerShape(ZakupRadius.tile),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = ZakupColors.Surface,
                            unfocusedContainerColor = ZakupColors.Surface,
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            focusedTextColor = ZakupColors.TextPrimary,
                            unfocusedTextColor = ZakupColors.TextPrimary,
                        ),
                    )
                    Spacer(Modifier.height(8.dp))
                    if (state.warehouses.size > 1) {
                        Chips(state.warehouses.map { it.name }, state.warehouses.firstOrNull { it.id == state.selectedWarehouse }?.name ?: "Все склады") { label ->
                            viewModel.selectWarehouse(state.warehouses.firstOrNull { it.name == label }?.id)
                        }
                        Spacer(Modifier.height(6.dp))
                    }
                    if (state.categories.size > 1) {
                        Chips(state.categories, state.selectedCategory) { viewModel.selectCategory(it) }
                        Spacer(Modifier.height(6.dp))
                    }
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.visible, key = { it.id }) { line -> InventoryRow(line, viewModel::setActual) }
                        // Отступ, чтобы нижняя плашка не перекрывала последние позиции (#8).
                        item { Spacer(Modifier.height(150.dp)) }
                    }
                }
                OpSubmitBar(
                    totalLabel = "Изменено позиций",
                    totalValue = "${state.changedCount}",
                    totalColor = ZakupColors.TextPrimary,
                    button = "Применить",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = { confirmSubmit = true },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
                if (state.submitError != null) {
                    Text(
                        state.submitError!!,
                        color = ZakupColors.Danger,
                        fontSize = 13.sp,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp, start = 20.dp, end = 20.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Chips(items: List<String>, selected: String, onSelect: (String) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(items, key = { it }) { c ->
            val active = c == selected
            Surface(
                shape = RoundedCornerShape(ZakupRadius.pill),
                color = if (active) ZakupColors.TextPrimary else ZakupColors.Surface,
                border = if (active) null else BorderStroke(1.dp, ZakupColors.Border),
                modifier = Modifier.clickable { onSelect(c) },
            ) {
                Text(
                    c,
                    color = if (active) Color.White else ZakupColors.TextSecondary,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }
    }
}

@Composable
private fun SummaryRow(total: Int, surplus: Int, shortage: BigDecimal) {
    ZakupCard(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row {
            Stat("$total", "позиций", ZakupColors.TextPrimary, Modifier.weight(1f))
            Box(Modifier.width(1.dp).height(36.dp).background(ZakupColors.Border))
            Stat("+$surplus", "излишки", ZakupColors.Primary, Modifier.weight(1f))
            Box(Modifier.width(1.dp).height(36.dp).background(ZakupColors.Border))
            Stat("−${formatMoney(shortage, "")}", "недостача", ZakupColors.Danger, Modifier.weight(1f))
        }
    }
}

@Composable
private fun Stat(value: String, label: String, color: Color, modifier: Modifier) {
    Column(modifier.padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = color)
        Spacer(Modifier.size(2.dp))
        Text(label, fontSize = 11.sp, color = ZakupColors.TextTertiary)
    }
}

@Composable
private fun InventoryRow(line: InventoryLine, onActual: (String, String) -> Unit) {
    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(line.name, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.size(2.dp))
                Text("Учёт ${formatQty(line.systemQty, line.unit)}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
            }
            val diff = line.diff
            if (line.changed) {
                val sign = if (diff.signum() > 0) "+" else "−"
                Text(
                    "$sign${formatQty(diff.abs(), null)}",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (diff.signum() > 0) ZakupColors.Primary else ZakupColors.Danger,
                )
                Spacer(Modifier.size(10.dp))
            }
            OpNumField(line.actual, { onActual(line.id, it) }, "факт", line.unit, Modifier.width(120.dp))
        }
    }
}
