package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.OperationsApi
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.WarehouseDto
import com.restos.zakup.data.stock.WriteoffInput
import com.restos.zakup.data.stock.WriteoffLineInput
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.ui.stock.WarehouseTab
import com.restos.zakup.util.formatMoney
import com.restos.zakup.util.formatQty
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

data class WriteoffLine(
    val id: String,
    val name: String,
    val unit: String?,
    val cost: BigDecimal,   // себестоимость за единицу (из price_per_unit)
    val stock: BigDecimal,
    val qty: String = "",
) {
    val lineLoss: BigDecimal get() = qty.toDecimalOrZero() * cost
}

data class WriteoffUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val reason: String = REASONS.first(),
    val available: List<IngredientDto> = emptyList(),
    val warehouses: List<WarehouseTab> = listOf(WarehouseTab(null, "Все склады")),
    val selectedWarehouse: String? = null,
    val lines: List<WriteoffLine> = emptyList(),
) {
    val loss: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineLoss }
    val validationHint: String?
        get() = when {
            lines.isEmpty() -> "Добавьте позиции к списанию"
            lines.any { it.qty.toDecimalOrZero().signum() <= 0 } -> "Укажите количество для всех позиций"
            else -> null
        }
    val canSubmit: Boolean get() = !submitting && validationHint == null

    companion object { val REASONS = listOf("Порча", "Просрочка", "Бой", "Другое") }
}

@HiltViewModel
class WriteoffViewModel @Inject constructor(
    private val stockApi: StockApi,
    private val opsApi: OperationsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(WriteoffUiState())
    val state: StateFlow<WriteoffUiState> = _state.asStateFlow()

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
                        warehouses = listOf(WarehouseTab(null, "Все склады")) + warehouses.map { w -> WarehouseTab(w.id, whName(w)) },
                    )
                }
            }.onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun selectWarehouse(id: String?) = _state.update { it.copy(selectedWarehouse = id) }

    fun pickItems(): List<PickItem> = _state.value.available
        .filter { _state.value.selectedWarehouse == null || it.warehouseId == _state.value.selectedWarehouse }
        .map { ing ->
            val stock = ing.qty.toDecimalOrZero()
            val price = ing.pricePerUnit.toDecimalOrZero()
            PickItem(
                id = ing.id,
                name = ing.name?.takeIf { it.isNotBlank() } ?: "—",
                unit = ing.unit,
                secondary = "остаток ${formatQty(stock, ing.unit)} · ${formatMoney(price, "")}/${ing.unit ?: ""}",
            )
        }

    private fun whName(w: WarehouseDto) = w.name.ifBlank {
        when (w.kind) { "products" -> "Продукты"; "purchased" -> "Покупные"; "supplies" -> "Хозтовары"; else -> "Склад" }
    }

    fun setReason(r: String) = _state.update { it.copy(reason = r) }

    fun toggle(item: PickItem) {
        _state.update { s ->
            if (s.lines.any { it.id == item.id }) {
                s.copy(lines = s.lines.filterNot { it.id == item.id })
            } else {
                val ing = s.available.first { it.id == item.id }
                s.copy(lines = s.lines + WriteoffLine(
                    id = ing.id,
                    name = item.name,
                    unit = ing.unit,
                    cost = ing.pricePerUnit.toDecimalOrZero(),
                    stock = ing.qty.toDecimalOrZero(),
                    qty = "1", // сразу валидно (списываем 1 ед.), пользователь правит степпером
                ))
            }
        }
    }

    fun isAdded(id: String) = _state.value.lines.any { it.id == id }
    /** Свободный ввод: клэмпим к остатку — так же, как +/- (нельзя списать больше, чем есть). */
    fun setQty(id: String, qty: String) = _state.update { s ->
        s.copy(lines = s.lines.map { line ->
            if (line.id != id) return@map line
            val sanitized = qty.opSanitize()
            val clamped = sanitized.toDecimalOrZero().let { v ->
                if (v > line.stock) line.stock.stripTrailingZeros().toPlainString() else sanitized
            }
            line.copy(qty = clamped)
        })
    }
    fun remove(id: String) = _state.update { s -> s.copy(lines = s.lines.filterNot { it.id == id }) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                opsApi.createWriteoff(WriteoffInput(
                    reason = s.reason,
                    lines = s.lines.map {
                        WriteoffLineInput(
                            ingredientId = it.id,
                            name = it.name,
                            qty = it.qty.toDecimalOrZero().toPlainString(),
                            unit = it.unit,
                            cost = it.cost.toPlainString(),
                        )
                    },
                ))
            }.onSuccess { _state.update { it.copy(submitting = false, done = true) } }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось списать"
                    _state.update { it.copy(submitting = false, submitError = msg) }
                }
        }
    }
}

fun String.opSanitize(): String = filter { it.isDigit() || it == '.' || it == ',' }.replace(',', '.')
