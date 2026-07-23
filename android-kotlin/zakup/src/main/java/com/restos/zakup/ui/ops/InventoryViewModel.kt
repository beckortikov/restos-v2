package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.stock.InventoryInput
import com.restos.zakup.data.stock.InventoryLineInput
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

data class InventoryLine(
    val id: String,
    val name: String,
    val unit: String?,
    val systemQty: BigDecimal,
    val price: BigDecimal,
    val actual: String,
) {
    val diff: BigDecimal get() = actual.toDecimalOrZero() - systemQty
}

data class InventoryUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val query: String = "",
    val lines: List<InventoryLine> = emptyList(),
) {
    val surplusCount: Int get() = lines.count { it.diff.signum() > 0 }
    val shortageValue: BigDecimal
        get() = lines.filter { it.diff.signum() < 0 }.fold(BigDecimal.ZERO) { a, l -> a + l.diff.abs() * l.price }
    val visible: List<InventoryLine>
        get() = if (query.isBlank()) lines else lines.filter { it.name.contains(query.trim(), true) }
    val canSubmit: Boolean get() = !submitting && lines.isNotEmpty()
}

@HiltViewModel
class InventoryViewModel @Inject constructor(
    private val stockApi: StockApi,
    private val opsApi: OperationsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(InventoryUiState())
    val state: StateFlow<InventoryUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            runCatching {
                stockApi.listAllIngredients().map { ing ->
                    val sys = ing.qty.toDecimalOrZero()
                    InventoryLine(
                        id = ing.id,
                        name = ing.name?.takeIf { it.isNotBlank() } ?: "—",
                        unit = ing.unit,
                        systemQty = sys,
                        price = ing.pricePerUnit.toDecimalOrZero(),
                        actual = sys.stripTrailingZeros().toPlainString(),
                    )
                }
            }.onSuccess { lines -> _state.update { it.copy(loading = false, lines = lines) } }
                .onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun setQuery(q: String) = _state.update { it.copy(query = q) }
    fun setActual(id: String, v: String) = _state.update { s ->
        s.copy(lines = s.lines.map { if (it.id == id) it.copy(actual = v.opSanitize()) else it })
    }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                val check = opsApi.createInventory(InventoryInput(
                    lines = s.lines.map { InventoryLineInput(ingredientId = it.id, actualQty = it.actual.toDecimalOrZero().toPlainString()) },
                ))
                opsApi.applyInventory(check.id)
            }.onSuccess { _state.update { it.copy(submitting = false, done = true) } }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось применить инвентаризацию"
                    _state.update { it.copy(submitting = false, submitError = msg) }
                }
        }
    }
}
