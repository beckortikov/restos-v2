package com.restos.zakup.ui.stock

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.util.toDecimalOrZero
import com.restos.zakup.ui.live.observeStockEvents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

enum class StockLevel { Ok, Low, Out }

data class StockRow(
    val id: String,
    val name: String,
    val category: String,
    val qty: BigDecimal,
    val unit: String?,
    val minQty: BigDecimal,
    val level: StockLevel,
)

data class StockUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val categories: List<String> = listOf(ALL),
    val selected: String = ALL,
    val query: String = "",
    val rows: List<StockRow> = emptyList(),
) {
    companion object { const val ALL = "Все" }
}

@HiltViewModel
class StockViewModel @Inject constructor(
    private val api: StockApi,
    eventBus: com.restos.core.events.EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(StockUiState())
    val state: StateFlow<StockUiState> = _state.asStateFlow()

    private var all: List<StockRow> = emptyList()

    init {
        load()
        observeStockEvents(eventBus, ::load)
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val cats = runCatching { api.listCategories().data }.getOrDefault(emptyList())
                val items = api.listAllIngredients()
                cats to items
            }.onSuccess { (cats, items) ->
                all = items.map { it.toRow() }
                _state.update {
                    it.copy(
                        loading = false,
                        categories = listOf(StockUiState.ALL) + cats,
                        rows = applyFilters(it.selected, it.query),
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить склад") }
            }
        }
    }

    fun selectCategory(cat: String) {
        _state.update { it.copy(selected = cat, rows = applyFilters(cat, it.query)) }
    }

    fun setQuery(q: String) {
        _state.update { it.copy(query = q, rows = applyFilters(it.selected, q)) }
    }

    private fun applyFilters(cat: String, query: String): List<StockRow> {
        val q = query.trim().lowercase()
        return all.filter { row ->
            (cat == StockUiState.ALL || row.category == cat) &&
                (q.isEmpty() || row.name.lowercase().contains(q))
        }
    }

    private fun IngredientDto.toRow(): StockRow {
        val q = qty.toDecimalOrZero()
        val min = minQty.toDecimalOrZero()
        val level = when {
            q <= BigDecimal.ZERO -> StockLevel.Out
            min > BigDecimal.ZERO && q <= min -> StockLevel.Low
            else -> StockLevel.Ok
        }
        return StockRow(
            id = id,
            name = name?.takeIf { it.isNotBlank() } ?: "—",
            category = category?.takeIf { it.isNotBlank() } ?: "—",
            qty = q,
            unit = unit,
            minQty = min,
            level = level,
        )
    }
}
