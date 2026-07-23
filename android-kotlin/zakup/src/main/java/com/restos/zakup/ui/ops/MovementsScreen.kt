package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.StockMovementDto
import com.restos.zakup.ui.components.EmptyState
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.OffsetDateTime
import javax.inject.Inject

data class MovementRow(
    val id: String,
    val title: String,
    val kindLabel: String,
    val dateLabel: String,
    val qtyText: String,
    val positive: Boolean,
)

data class MovementsUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val rows: List<MovementRow> = emptyList(),
)

@HiltViewModel
class MovementsViewModel @Inject constructor(private val api: StockApi) : ViewModel() {
    private val _state = MutableStateFlow(MovementsUiState())
    val state: StateFlow<MovementsUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.listMovements(limit = 100).data.map { it.toRow() } }
                .onSuccess { rows -> _state.update { it.copy(loading = false, rows = rows) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }

    private fun StockMovementDto.toRow(): MovementRow {
        val q = qty.toDecimalOrZero()
        val positive = q.signum() >= 0
        return MovementRow(
            id = id,
            title = ingredientName?.takeIf { it.isNotBlank() } ?: description?.takeIf { it.isNotBlank() } ?: "—",
            kindLabel = kindLabel(type),
            dateLabel = dateLabel(createdAt),
            qtyText = (if (positive) "+" else "−") + formatQty(q.abs(), unit),
            positive = positive,
        )
    }
}

private fun kindLabel(type: String): String = when (type) {
    "receipt" -> "Приёмка"
    "writeoff" -> "Списание"
    "return_supplier" -> "Возврат поставщику"
    "transfer" -> "Перемещение"
    "order_deduct" -> "Продажа"
    "inventory" -> "Инвентаризация"
    "opening" -> "Начальный остаток"
    "supply_expense" -> "Расход хозтоваров"
    else -> type
}

private val monthsMov = listOf("янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")
private fun dateLabel(createdAt: String?): String {
    val dt = createdAt?.let { runCatching { OffsetDateTime.parse(it) }.getOrNull() } ?: return ""
    val d = dt.toLocalDate()
    val today = LocalDate.now()
    val t = dt.toLocalTime().toString().take(5)
    return when (d) {
        today -> "Сегодня, $t"
        today.minusDays(1) -> "Вчера, $t"
        else -> "${d.dayOfMonth} ${monthsMov[d.monthValue - 1]}, $t"
    }
}

/** Экран «Движения склада» (из «Ещё»). */
@Composable
fun MovementsScreen(onBack: () -> Unit, viewModel: MovementsViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Движения склада", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.rows.isEmpty() -> EmptyState("Движений пока нет")
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.rows, key = { it.id }) { row ->
                    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(row.title, style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.size(2.dp))
                                Text("${row.kindLabel} · ${row.dateLabel}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
                            }
                            Text(
                                row.qtyText,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (row.positive) ZakupColors.Primary else ZakupColors.Danger,
                            )
                        }
                    }
                }
            }
        }
    }
}
