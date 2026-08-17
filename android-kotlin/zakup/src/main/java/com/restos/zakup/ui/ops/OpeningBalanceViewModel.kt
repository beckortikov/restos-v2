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
import kotlinx.coroutines.async
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
    val warehouseKind: Map<String, String> = emptyMap(), // warehouseId -> products|purchased|supplies
    val lines: List<OpeningLine> = emptyList(),
) {
    val total: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineValue }
    val validationHint: String?
        get() = when {
            lines.isEmpty() -> "Добавьте ингредиенты в остаток"
            lines.any { it.qty.toDecimalOrZero().signum() <= 0 } -> "Укажите количество для всех позиций"
            else -> null
        }
    val canSubmit: Boolean get() = !submitting && validationHint == null
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
            runCatching {
                val whD = async { runCatching { stockApi.listWarehouses().data }.getOrDefault(emptyList()) }
                val ingD = async { stockApi.listAllIngredients() }
                whD.await() to ingD.await()
            }.onSuccess { (warehouses, items) ->
                _state.update {
                    it.copy(
                        loading = false,
                        available = items,
                        warehouseKind = warehouses.associate { w -> w.id to w.kind },
                    )
                }
            }.onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    // Продукт/Покупной/Хозтовар — та же логика, что в WriteoffViewModel/NewReceiptViewModel.
    private fun kindLabel(ing: IngredientDto): String = when {
        !ing.isFood -> "Хозтовар"
        _state.value.warehouseKind[ing.warehouseId] == "purchased" -> "Покупной"
        else -> "Продукт"
    }

    fun pickItems(): List<PickItem> = _state.value.available.map { ing ->
        val secondary = if (ing.category.isNullOrBlank()) kindLabel(ing) else "${kindLabel(ing)} · ${ing.category}"
        PickItem(ing.id, ing.name?.takeIf { it.isNotBlank() } ?: "—", ing.unit, secondary)
    }

    fun toggle(item: PickItem) = _state.update { s ->
        if (s.lines.any { it.id == item.id }) s.copy(lines = s.lines.filterNot { it.id == item.id })
        else {
            val ing = s.available.first { it.id == item.id }
            val price = ing.pricePerUnit.toDecimalOrZero()
            // qty=1 по умолчанию (сразу валидно; правится в развёрнутой строке), цена — из меню.
            s.copy(lines = s.lines + OpeningLine(ing.id, item.name, ing.unit, qty = "1", price = if (price.signum() > 0) price.stripTrailingZeros().toPlainString() else ""))
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
