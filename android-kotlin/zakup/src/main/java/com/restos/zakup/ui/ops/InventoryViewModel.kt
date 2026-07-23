package com.restos.zakup.ui.ops

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.stock.InventoryInput
import com.restos.zakup.data.stock.InventoryLineInput
import com.restos.zakup.data.stock.OperationsApi
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.WarehouseDto
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.ui.stock.WarehouseTab
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

data class InventoryLine(
    val id: String,
    val name: String,
    val unit: String?,
    val category: String,
    val warehouseId: String?,
    val systemQty: BigDecimal,
    val price: BigDecimal,
    val actual: String,
) {
    val diff: BigDecimal get() = actual.toDecimalOrZero() - systemQty
    val changed: Boolean get() = actual.isNotBlank() && diff.signum() != 0
}

data class InvResult(val applied: Int, val itemsWithDiff: Int, val surplus: Int, val shortageValue: BigDecimal)

data class InventoryUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val result: InvResult? = null,
    val query: String = "",
    val warehouses: List<WarehouseTab> = listOf(WarehouseTab(null, "Все склады")),
    val selectedWarehouse: String? = null,
    val categories: List<String> = listOf(ALL_CAT),
    val selectedCategory: String = ALL_CAT,
    val lines: List<InventoryLine> = emptyList(),
) {
    private val changed get() = lines.filter { it.changed }
    val changedCount: Int get() = changed.size
    val surplusCount: Int get() = changed.count { it.diff.signum() > 0 }
    val shortageValue: BigDecimal
        get() = changed.filter { it.diff.signum() < 0 }.fold(BigDecimal.ZERO) { a, l -> a + l.diff.abs() * l.price }
    val visible: List<InventoryLine>
        get() = lines.filter { l ->
            (selectedWarehouse == null || l.warehouseId == selectedWarehouse) &&
                (selectedCategory == ALL_CAT || l.category == selectedCategory) &&
                (query.isBlank() || l.name.contains(query.trim(), true))
        }
    val canSubmit: Boolean get() = !submitting && changed.isNotEmpty()

    companion object { const val ALL_CAT = "Все" }
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
                val whD = async { runCatching { stockApi.listWarehouses().data }.getOrDefault(emptyList()) }
                val catD = async { runCatching { stockApi.listCategories().data }.getOrDefault(emptyList()) }
                val ingD = async { stockApi.listAllIngredients() }
                Triple(whD.await(), catD.await(), ingD.await())
            }.onSuccess { (whs, cats, ings) ->
                val lines = ings.map { ing ->
                    val sys = ing.qty.toDecimalOrZero()
                    InventoryLine(
                        id = ing.id,
                        name = ing.name?.takeIf { it.isNotBlank() } ?: "—",
                        unit = ing.unit,
                        category = ing.category?.takeIf { it.isNotBlank() } ?: "—",
                        warehouseId = ing.warehouseId,
                        systemQty = sys,
                        price = ing.pricePerUnit.toDecimalOrZero(),
                        actual = sys.stripTrailingZeros().toPlainString(),
                    )
                }
                _state.update {
                    it.copy(
                        loading = false,
                        lines = lines,
                        warehouses = listOf(WarehouseTab(null, "Все склады")) + whs.map { w -> WarehouseTab(w.id, whName(w)) },
                        categories = listOf(InventoryUiState.ALL_CAT) + cats,
                    )
                }
            }.onFailure { e -> _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun setQuery(q: String) = _state.update { it.copy(query = q) }
    fun selectWarehouse(id: String?) = _state.update { it.copy(selectedWarehouse = id) }
    fun selectCategory(c: String) = _state.update { it.copy(selectedCategory = c) }
    fun setActual(id: String, v: String) = _state.update { s ->
        s.copy(lines = s.lines.map { if (it.id == id) it.copy(actual = v.opSanitize()) else it })
    }
    fun dismissResult() = _state.update { it.copy(result = null) }

    fun submit() {
        val s = _state.value
        val changed = s.lines.filter { it.changed }
        if (s.submitting || changed.isEmpty()) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                // Отправляем ТОЛЬКО изменённые позиции — меньше payload, корректная проводка.
                val check = opsApi.createInventory(InventoryInput(
                    lines = changed.map { InventoryLineInput(ingredientId = it.id, actualQty = it.actual.toDecimalOrZero().toPlainString()) },
                ))
                opsApi.applyInventory(check.id)
            }.onSuccess { applied ->
                _state.update {
                    it.copy(
                        submitting = false,
                        result = InvResult(
                            applied = applied.totalItems,
                            itemsWithDiff = applied.itemsWithDiff,
                            surplus = s.surplusCount,
                            shortageValue = s.shortageValue,
                        ),
                    )
                }
            }.onFailure { e ->
                val msg = (e as? ApiException)?.apiError?.message ?: e.message ?: "Не удалось применить инвентаризацию"
                _state.update { it.copy(submitting = false, submitError = msg) }
            }
        }
    }

    private fun whName(w: WarehouseDto) = w.name.ifBlank {
        when (w.kind) { "products" -> "Продукты"; "purchased" -> "Покупные"; "supplies" -> "Хозтовары"; else -> "Склад" }
    }
}
