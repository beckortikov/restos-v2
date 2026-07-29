package com.restos.zakup.ui.tobuy

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

data class BuyItem(
    val id: String,
    val name: String,
    val qty: BigDecimal,
    val minQty: BigDecimal,
    val unit: String?,
    val suggested: BigDecimal,
    val isOut: Boolean,
)

data class ToBuyUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val items: List<BuyItem> = emptyList(),
    val selected: Set<String> = emptySet(),
)

@HiltViewModel
class ToBuyViewModel @Inject constructor(
    private val api: StockApi,
    eventBus: com.restos.core.events.EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(ToBuyUiState())
    val state: StateFlow<ToBuyUiState> = _state.asStateFlow()

    init {
        load()
        observeStockEvents(eventBus, ::load)
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.listAllIngredients(low = true).map { it.toBuyItem() } }
                .onSuccess { items ->
                    val sorted = items.sortedByDescending { i -> i.isOut }
                    _state.update { it.copy(loading = false, items = sorted, selected = sorted.map { i -> i.id }.toSet()) }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить список") }
                }
        }
    }

    /** Выбор позиций для будущей приёмки (чекбокс в строке) — по умолчанию выбраны все. */
    fun toggleSelected(id: String) = _state.update {
        it.copy(selected = if (id in it.selected) it.selected - id else it.selected + id)
    }

    private fun IngredientDto.toBuyItem(): BuyItem {
        val q = qty.toDecimalOrZero()
        val min = minQty.toDecimalOrZero()
        // Предложенный объём — сколько нужно докупить до минимума (не меньше 0).
        val suggested = (min - q).max(BigDecimal.ZERO)
        return BuyItem(
            id = id,
            name = name?.takeIf { it.isNotBlank() } ?: "—",
            qty = q,
            minQty = min,
            unit = unit,
            suggested = if (suggested.signum() > 0) suggested else min,
            isOut = q <= BigDecimal.ZERO,
        )
    }
}
