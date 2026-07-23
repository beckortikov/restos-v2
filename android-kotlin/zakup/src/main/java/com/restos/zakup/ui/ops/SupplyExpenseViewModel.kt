package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.OperationsApi
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.SupplyExpenseInput
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.util.formatQty
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ExpenseLine(val id: String, val name: String, val unit: String?, val stock: String, val qty: String = "")

data class SupplyExpenseUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val reason: String = REASONS.first(),
    val issuedTo: String = "",
    val available: List<IngredientDto> = emptyList(),
    val lines: List<ExpenseLine> = emptyList(),
) {
    val canSubmit: Boolean
        get() = !submitting && lines.isNotEmpty() && lines.all { it.qty.toDecimalOrZero().signum() > 0 }

    companion object {
        // Зеркало SUPPLY_EXPENSE_REASONS (lib/types.ts).
        val REASONS = listOf("Выдано в зал", "Выдано на кухню", "Выдано на бар", "Хозяйственные нужды", "Порча / бой", "Прочее")
    }
}

@HiltViewModel
class SupplyExpenseViewModel @Inject constructor(
    private val stockApi: StockApi,
    private val opsApi: OperationsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(SupplyExpenseUiState())
    val state: StateFlow<SupplyExpenseUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            // Хозтовары = не-food ингредиенты.
            runCatching { stockApi.listAllIngredients().filter { !it.isFood } }
                .onSuccess { items -> _state.update { it.copy(loading = false, available = items) } }
                .onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun pickItems(): List<PickItem> = _state.value.available.map { ing ->
        PickItem(
            id = ing.id,
            name = ing.name?.takeIf { it.isNotBlank() } ?: "—",
            unit = ing.unit,
            secondary = "остаток ${formatQty(ing.qty.toDecimalOrZero(), ing.unit)}",
        )
    }

    fun setReason(r: String) = _state.update { it.copy(reason = r) }
    fun setIssuedTo(v: String) = _state.update { it.copy(issuedTo = v) }

    fun toggle(item: PickItem) = _state.update { s ->
        if (s.lines.any { it.id == item.id }) s.copy(lines = s.lines.filterNot { it.id == item.id })
        else {
            val ing = s.available.first { it.id == item.id }
            s.copy(lines = s.lines + ExpenseLine(ing.id, item.name, ing.unit, formatQty(ing.qty.toDecimalOrZero(), ing.unit)))
        }
    }

    fun isAdded(id: String) = _state.value.lines.any { it.id == id }
    fun setQty(id: String, qty: String) = _state.update { s -> s.copy(lines = s.lines.map { if (it.id == id) it.copy(qty = qty.opSanitize()) else it }) }
    fun remove(id: String) = _state.update { s -> s.copy(lines = s.lines.filterNot { it.id == id }) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                // API принимает по одной позиции — шлём последовательно.
                s.lines.forEach { line ->
                    opsApi.createSupplyExpense(
                        SupplyExpenseInput(
                            ingredientId = line.id,
                            qty = line.qty.toDecimalOrZero().toPlainString(),
                            unit = line.unit,
                            reason = s.reason,
                            issuedTo = s.issuedTo.takeIf { it.isNotBlank() },
                        ),
                    )
                }
            }.onSuccess { _state.update { it.copy(submitting = false, done = true) } }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось оформить расход"
                    _state.update { it.copy(submitting = false, submitError = msg) }
                }
        }
    }
}
