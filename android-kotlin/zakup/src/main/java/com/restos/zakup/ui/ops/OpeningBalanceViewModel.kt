package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.OpeningBalanceInput
import com.restos.zakup.data.stock.OpeningBalanceLineInput
import com.restos.zakup.data.stock.OperationsApi
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

data class OpeningLine(
    val id: String,
    val name: String,
    val unit: String?,
    val qty: String = "",
    val price: String,
) {
    val lineValue: BigDecimal get() = qty.toDecimalOrZero() * price.toDecimalOrZero()
}

data class OpeningBalanceUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val available: List<IngredientDto> = emptyList(),
    val lines: List<OpeningLine> = emptyList(),
) {
    val total: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineValue }
    val canSubmit: Boolean
        get() = !submitting && lines.isNotEmpty() && lines.all { it.qty.toDecimalOrZero().signum() > 0 }
}

@HiltViewModel
class OpeningBalanceViewModel @Inject constructor(
    private val stockApi: StockApi,
    private val opsApi: OperationsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(OpeningBalanceUiState())
    val state: StateFlow<OpeningBalanceUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            runCatching { stockApi.listAllIngredients() }
                .onSuccess { items -> _state.update { it.copy(loading = false, available = items) } }
                .onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun pickItems(): List<PickItem> = _state.value.available.map { ing ->
        PickItem(ing.id, ing.name?.takeIf { it.isNotBlank() } ?: "—", ing.unit, ing.category)
    }

    fun toggle(item: PickItem) = _state.update { s ->
        if (s.lines.any { it.id == item.id }) s.copy(lines = s.lines.filterNot { it.id == item.id })
        else {
            val ing = s.available.first { it.id == item.id }
            val price = ing.pricePerUnit.toDecimalOrZero()
            s.copy(lines = s.lines + OpeningLine(ing.id, item.name, ing.unit, price = if (price.signum() > 0) price.stripTrailingZeros().toPlainString() else ""))
        }
    }

    fun isAdded(id: String) = _state.value.lines.any { it.id == id }
    fun setQty(id: String, v: String) = updateLine(id) { it.copy(qty = v.opSanitize()) }
    fun setPrice(id: String, v: String) = updateLine(id) { it.copy(price = v.opSanitize()) }
    fun remove(id: String) = _state.update { s -> s.copy(lines = s.lines.filterNot { it.id == id }) }
    private fun updateLine(id: String, f: (OpeningLine) -> OpeningLine) =
        _state.update { s -> s.copy(lines = s.lines.map { if (it.id == id) f(it) else it }) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                opsApi.openingBalance(OpeningBalanceInput(
                    lines = s.lines.map {
                        val p = it.price.toDecimalOrZero()
                        OpeningBalanceLineInput(
                            ingredientId = it.id,
                            qty = it.qty.toDecimalOrZero().toPlainString(),
                            // Пустую/нулевую цену не шлём — бэк оставит текущую цену ингредиента.
                            price = if (p.signum() > 0) p.toPlainString() else null,
                        )
                    },
                ))
            }.onSuccess { _state.update { it.copy(submitting = false, done = true) } }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message ?: e.message ?: "Не удалось провести остаток"
                    _state.update { it.copy(submitting = false, submitError = msg) }
                }
        }
    }
}
