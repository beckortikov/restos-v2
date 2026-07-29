package com.restos.zakup.ui.stock

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.WarehouseDto
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.ui.live.observeStockEvents
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

enum class StockLevel { Ok, Low, Out }

enum class StockStatusFilter(val label: String) { All("Все"), Low("Мало"), Out("Нет") }

data class WarehouseTab(val id: String?, val name: String)

data class StockRow(
    val id: String,
    val name: String,
    val category: String,
    val warehouseId: String?,
    val qty: BigDecimal,
    val unit: String?,
    val minQty: BigDecimal,
    val price: BigDecimal,
    val level: StockLevel,
) {
    val value: BigDecimal get() = qty * price
}

data class StockUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val warehouses: List<WarehouseTab> = listOf(WarehouseTab(null, "Все склады")),
    val selectedWarehouse: String? = null,
    val status: StockStatusFilter = StockStatusFilter.All,
    val query: String = "",
    val rows: List<StockRow> = emptyList(),
    val lowCount: Int = 0,
    val outCount: Int = 0,
    /** Стоимость остатков выбранного склада (#4) — сумма qty×цена, независимо от поиска/статус-фильтра. */
    val warehouseValue: BigDecimal = BigDecimal.ZERO,
)

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
                val whD = async { runCatching { api.listWarehouses().data }.getOrDefault(emptyList()) }
                val ingD = async { api.listAllIngredients() }
                whD.await() to ingD.await()
            }.onSuccess { (warehouses, items) ->
                all = items.map { it.toRow() }
                val tabs = listOf(WarehouseTab(null, "Все склады")) +
                    warehouses.map { WarehouseTab(it.id, warehouseName(it)) }
                _state.update {
                    it.copy(
                        loading = false,
                        warehouses = tabs,
                        rows = apply(it.selectedWarehouse, it.status, it.query),
                        lowCount = all.count { r -> r.level == StockLevel.Low },
                        outCount = all.count { r -> r.level == StockLevel.Out },
                        warehouseValue = warehouseValue(it.selectedWarehouse),
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить склад") }
            }
        }
    }

    fun selectWarehouse(id: String?) = _state.update {
        it.copy(selectedWarehouse = id, rows = apply(id, it.status, it.query), warehouseValue = warehouseValue(id))
    }
    fun setStatus(s: StockStatusFilter) = _state.update { it.copy(status = s, rows = apply(it.selectedWarehouse, s, it.query)) }
    fun setQuery(q: String) = _state.update { it.copy(query = q, rows = apply(it.selectedWarehouse, it.status, q)) }

    /** Нет/мало остатка — всегда в начале списка (#2), внутри группы — как пришло с бэка. */
    private fun apply(warehouse: String?, status: StockStatusFilter, query: String): List<StockRow> {
        val q = query.trim().lowercase()
        return all.filter { row ->
            (warehouse == null || row.warehouseId == warehouse) &&
                (q.isEmpty() || row.name.lowercase().contains(q)) &&
                when (status) {
                    StockStatusFilter.All -> true
                    StockStatusFilter.Low -> row.level == StockLevel.Low
                    StockStatusFilter.Out -> row.level == StockLevel.Out
                }
        }.sortedBy { row ->
            when (row.level) { StockLevel.Out -> 0; StockLevel.Low -> 1; StockLevel.Ok -> 2 }
        }
    }

    /** Стоимость остатков склада (#4) — независимо от поиска/статус-фильтра. */
    private fun warehouseValue(warehouse: String?): BigDecimal =
        all.filter { warehouse == null || it.warehouseId == warehouse }.fold(BigDecimal.ZERO) { a, r -> a + r.value }

    private fun warehouseName(w: WarehouseDto): String = w.name.ifBlank {
        when (w.kind) {
            "products" -> "Продукты"; "purchased" -> "Покупные"; "supplies" -> "Хозтовары"; else -> "Склад"
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
            warehouseId = warehouseId,
            qty = q,
            unit = unit,
            minQty = min,
            price = pricePerUnit.toDecimalOrZero(),
            level = level,
        )
    }
}
