package com.restos.zakup.ui.overview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.receipts.StockReceiptDto
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.data.suppliers.SuppliersApi
import com.restos.zakup.ui.receipts.ReceiptRow
import com.restos.zakup.ui.receipts.toReceiptRow
import com.restos.zakup.util.toDecimalOrZero
import com.restos.zakup.ui.live.observeStockEvents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

enum class BuyUrgency { Low, Out }

data class ToBuyRow(
    val id: String,
    val name: String,
    val qty: BigDecimal,
    val minQty: BigDecimal,
    val unit: String?,
    val urgency: BuyUrgency,
)

data class OverviewUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val lowCount: Int = 0,
    val totalDebt: BigDecimal = BigDecimal.ZERO,
    val toBuy: List<ToBuyRow> = emptyList(),
    val recent: List<ReceiptRow> = emptyList(),
)

@HiltViewModel
class OverviewViewModel @Inject constructor(
    private val stockApi: StockApi,
    private val suppliersApi: SuppliersApi,
    private val receiptsApi: ReceiptsApi,
    eventBus: com.restos.core.events.EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(OverviewUiState())
    val state: StateFlow<OverviewUiState> = _state.asStateFlow()

    init {
        load()
        observeStockEvents(eventBus, ::load)
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val lowD = async { stockApi.listAllIngredients(low = true) }
                val supD = async { suppliersApi.listSuppliers().data }
                val recD = async { receiptsApi.listReceipts(limit = 5).data }
                Triple(lowD.await(), supD.await(), recD.await())
            }.onSuccess { (low, suppliers, receipts) ->
                val toBuy = low.map { it.toBuyRow() }.sortedBy { it.urgency == BuyUrgency.Low }
                val debt = suppliers.fold(BigDecimal.ZERO) { acc, s -> acc + s.currentDebt.toDecimalOrZero() }
                _state.update {
                    it.copy(
                        loading = false,
                        lowCount = low.size,
                        totalDebt = debt,
                        toBuy = toBuy.take(3),
                        recent = receipts.take(3).map(StockReceiptDto::toReceiptRow),
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить обзор") }
            }
        }
    }

    private fun IngredientDto.toBuyRow(): ToBuyRow {
        val q = qty.toDecimalOrZero()
        return ToBuyRow(
            id = id,
            name = name?.takeIf { it.isNotBlank() } ?: "—",
            qty = q,
            minQty = minQty.toDecimalOrZero(),
            unit = unit,
            urgency = if (q <= BigDecimal.ZERO) BuyUrgency.Out else BuyUrgency.Low,
        )
    }
}
