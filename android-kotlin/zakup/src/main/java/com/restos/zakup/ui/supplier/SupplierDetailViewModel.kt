package com.restos.zakup.ui.supplier

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.suppliers.SupplierDto
import com.restos.zakup.data.suppliers.SuppliersApi
import com.restos.zakup.ui.receipts.ReceiptRow
import com.restos.zakup.ui.receipts.toReceiptRow
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

data class SupplierDetailUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val supplierId: String = "",
    val name: String = "",
    val contact: String? = null,
    val phone: String? = null,
    val categories: List<String> = emptyList(),
    val debt: BigDecimal = BigDecimal.ZERO,
    val creditLimit: BigDecimal = BigDecimal.ZERO,
    val termsDays: Int = 0,
    val receiptsCount: Int = 0,
    val turnover: BigDecimal = BigDecimal.ZERO,
    val receipts: List<ReceiptRow> = emptyList(),
)

@HiltViewModel
class SupplierDetailViewModel @Inject constructor(
    private val suppliersApi: SuppliersApi,
    private val receiptsApi: ReceiptsApi,
    savedState: SavedStateHandle,
) : ViewModel() {

    private val supplierId: String = savedState.get<String>("id").orEmpty()

    private val _state = MutableStateFlow(SupplierDetailUiState())
    val state: StateFlow<SupplierDetailUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val supD = async { suppliersApi.listSuppliers().data.firstOrNull { it.id == supplierId } }
                val recD = async { receiptsApi.listReceipts(supplierId = supplierId, limit = 100).data }
                supD.await() to recD.await()
            }.onSuccess { (supplier, receipts) ->
                if (supplier == null) {
                    _state.update { it.copy(loading = false, error = "Поставщик не найден") }
                    return@onSuccess
                }
                val rows = receipts.map { it.toReceiptRow() }
                _state.update {
                    it.copy(
                        loading = false,
                        supplierId = supplier.id,
                        name = supplier.name.ifBlank { "—" },
                        contact = supplier.contactPerson?.takeIf { c -> c.isNotBlank() },
                        phone = supplier.phone?.takeIf { p -> p.isNotBlank() },
                        categories = supplier.categories,
                        debt = supplier.currentDebt.toDecimalOrZero(),
                        creditLimit = supplier.creditLimit.toDecimalOrZero(),
                        termsDays = supplier.paymentTermsDays,
                        receiptsCount = rows.size,
                        turnover = rows.fold(BigDecimal.ZERO) { a, r -> a + r.amount },
                        receipts = rows,
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить поставщика") }
            }
        }
    }
}
