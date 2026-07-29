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
import com.restos.zakup.data.stock.StockReturnDto
import com.restos.zakup.ui.components.BadgeKind
import com.restos.zakup.ui.components.EmptyState
import com.restos.zakup.ui.components.ErrorState
import com.restos.zakup.ui.components.LoadingState
import com.restos.zakup.ui.components.StatusBadge
import com.restos.zakup.ui.components.ZakupCard
import com.restos.zakup.ui.components.ZakupTopBar
import com.restos.zakup.ui.theme.ZakupColors
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

data class ReturnListRow(
    val id: String,
    val supplierName: String,
    val dateLabel: String,
    val reasonLabel: String,
    val amount: BigDecimal,
    val cancelled: Boolean,
)

data class ReturnsListUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val rows: List<ReturnListRow> = emptyList(),
)

@HiltViewModel
class ReturnsListViewModel @Inject constructor(private val api: StockApi) : ViewModel() {
    private val _state = MutableStateFlow(ReturnsListUiState())
    val state: StateFlow<ReturnsListUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.listReturns(limit = 100).data.map { it.toRow() } }
                .onSuccess { rows -> _state.update { it.copy(loading = false, rows = rows) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }

    private fun StockReturnDto.toRow() = ReturnListRow(
        id = id,
        supplierName = supplierName?.takeIf { it.isNotBlank() } ?: "Поставщик",
        dateLabel = (date ?: createdAt)?.take(10) ?: "",
        reasonLabel = reasonLabel(reason),
        amount = totalAmount.toDecimalOrZero(),
        cancelled = cancelledAt != null,
    )
}

private fun reasonLabel(r: String): String = when (r) {
    "spoilage" -> "Порча"
    "breakage" -> "Бой"
    "expired" -> "Просрочка"
    "other" -> "Другое"
    else -> r
}

/** Экран «Возвраты поставщикам» (список, из «Ещё»). */
@Composable
fun ReturnsListScreen(onBack: () -> Unit, viewModel: ReturnsListViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZakupTopBar("Возвраты поставщикам", onBack = onBack)
        when {
            state.loading -> LoadingState()
            state.error != null -> ErrorState(state.error!!, onRetry = viewModel::load)
            state.rows.isEmpty() -> EmptyState("Возвратов пока нет")
            else -> LazyColumn(
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.rows, key = { it.id }) { row ->
                    ZakupCard(Modifier.fillMaxWidth(), padding = 14) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(row.supplierName, style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.size(2.dp))
                                Text("${row.reasonLabel} · ${row.dateLabel}", fontSize = 12.sp, color = ZakupColors.TextTertiary)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    formatMoney(row.amount, ""),
                                    fontSize = 14.5.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (row.cancelled) ZakupColors.TextTertiary else ZakupColors.TextPrimary,
                                )
                                Spacer(Modifier.size(4.dp))
                                if (row.cancelled) StatusBadge("Отменён", BadgeKind.Neutral)
                                else StatusBadge("Возврат", BadgeKind.Success)
                            }
                        }
                    }
                }
            }
        }
    }
}
