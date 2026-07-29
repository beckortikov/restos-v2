package com.restos.zakup.ui.history

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.ui.receipts.ReceiptRow
import com.restos.zakup.ui.receipts.ReceiptStatus
import com.restos.zakup.ui.receipts.toReceiptRow
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

enum class HistoryFilter(val label: String) { All("Все"), Debt("С долгом"), Paid("Оплаченные") }

data class HistoryUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val purchased: BigDecimal = BigDecimal.ZERO,
    val paid: BigDecimal = BigDecimal.ZERO,
    val debt: BigDecimal = BigDecimal.ZERO,
    val count: Int = 0,
    val filter: HistoryFilter = HistoryFilter.All,
    val groups: List<HistoryGroup> = emptyList(),
)

data class HistoryGroup(val dayKey: String, val dayLabel: String, val rows: List<ReceiptRow>)

@HiltViewModel
class HistoryViewModel @Inject constructor(
    private val api: ReceiptsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(HistoryUiState())
    val state: StateFlow<HistoryUiState> = _state.asStateFlow()

    private var all: List<ReceiptRow> = emptyList()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.listReceipts(include = "lines", limit = 200).data.map { it.toReceiptRow() } }
                .onSuccess { rows ->
                    all = rows
                    val purchased = rows.fold(BigDecimal.ZERO) { a, r -> a + r.amount }
                    // paid/debt по строкам приёмок: paid = total где Оплачено, иначе оценка.
                    _state.update {
                        it.copy(
                            loading = false,
                            count = rows.size,
                            purchased = purchased,
                            debt = rows.filter { r -> r.status != ReceiptStatus.Paid }.fold(BigDecimal.ZERO) { a, r -> a + r.amount },
                            paid = rows.filter { r -> r.status == ReceiptStatus.Paid }.fold(BigDecimal.ZERO) { a, r -> a + r.amount },
                            groups = group(rows, it.filter),
                        )
                    }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить историю") }
                }
        }
    }

    fun setFilter(f: HistoryFilter) {
        _state.update { it.copy(filter = f, groups = group(all, f)) }
    }

    private fun group(rows: List<ReceiptRow>, filter: HistoryFilter): List<HistoryGroup> {
        val filtered = when (filter) {
            HistoryFilter.All -> rows
            HistoryFilter.Debt -> rows.filter { it.status != ReceiptStatus.Paid }
            HistoryFilter.Paid -> rows.filter { it.status == ReceiptStatus.Paid }
        }
        return filtered
            .sortedByDescending { it.dayKey }
            .groupBy { it.dayKey }
            .map { (key, list) -> HistoryGroup(key, list.first().dateLabel.substringBefore(","), list) }
    }
}
