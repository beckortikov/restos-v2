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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.restos.zakup.ui.theme.ZakupRadius
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
import java.math.BigDecimal

/** Экран 11 «Инвентаризация» — факт vs учёт, расхождение считается на лету. */
@Composable
fun InventoryScreen(
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: InventoryViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffectDone(state.done, onDone)

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Инвентаризация", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.loadError != null -> ErrorState(state.loadError!!, onRetry = viewModel::load)
            else -> Box(Modifier.weight(1f)) {
                Column {
                    SummaryRow(state.lines.size, state.surplusCount, state.shortageValue)
                    Spacer(Modifier.height(8.dp))
                    TextField(
                        value = state.query,
                        onValueChange = viewModel::setQuery,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
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
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(state.visible, key = { it.id }) { line -> InventoryRow(line, viewModel::setActual) }
                        item { Spacer(Modifier.height(96.dp)) }
                    }
                }
                OpSubmitBar(
                    totalLabel = "Черновик",
                    totalValue = "${state.lines.size} поз.",
                    totalColor = ZakupColors.TextPrimary,
                    button = "Применить",
                    enabled = state.canSubmit,
                    submitting = state.submitting,
                    onSubmit = viewModel::submit,
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
                if (state.submitError != null) {
                    Text(
                        state.submitError!!,
                        color = ZakupColors.Danger,
                        fontSize = 13.sp,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 90.dp, start = 20.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SummaryRow(total: Int, surplus: Int, shortage: BigDecimal) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Stat("$total", "позиций", ZakupColors.TextPrimary, Modifier.weight(1f))
        Stat("+$surplus", "излишки", ZakupColors.Primary, Modifier.weight(1f))
        Stat("−${formatMoney(shortage, "")}", "недостача", ZakupColors.Danger, Modifier.weight(1f))
    }
}

@Composable
private fun Stat(value: String, label: String, color: Color, modifier: Modifier) {
    ZakupCard(modifier, padding = 12) {
        Column {
            Text(value, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = color)
            Spacer(Modifier.size(2.dp))
            Text(label, fontSize = 11.sp, color = ZakupColors.TextTertiary)
        }
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
            if (diff.signum() != 0) {
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
