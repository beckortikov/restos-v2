package com.restos.zakup.ui.suppliers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.suppliers.SupplierDto
import com.restos.zakup.data.suppliers.SuppliersApi
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
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import javax.inject.Inject

data class SupplierRow(
    val id: String,
    val name: String,
    val contact: String?,
    val phone: String?,
    val categories: List<String>,
    val debt: BigDecimal,
    val overdue: Boolean,
    val agingDays: Int?, // дней с самой ранней неоплаченной due_date
)

data class SuppliersUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val totalDebt: BigDecimal = BigDecimal.ZERO,
    val count: Int = 0,
    val withDebt: Int = 0,
    val overdueCount: Int = 0,
    val rows: List<SupplierRow> = emptyList(),
) {
    val topDebtor: SupplierRow? get() = rows.firstOrNull { it.debt.signum() > 0 }
}

@HiltViewModel
class SuppliersViewModel @Inject constructor(
    private val api: SuppliersApi,
    private val receiptsApi: ReceiptsApi,
    eventBus: com.restos.core.events.EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(SuppliersUiState())
    val state: StateFlow<SuppliersUiState> = _state.asStateFlow()

    init {
        load()
        observeStockEvents(eventBus, ::load)
    }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val supD = async { api.listSuppliers().data }
                // Неоплаченные накладные — для расчёта просрочки/возраста долга по поставщику.
                val recD = async { runCatching { receiptsApi.listReceipts(limit = 200).data }.getOrDefault(emptyList()) }
                supD.await() to recD.await()
            }.onSuccess { (suppliers, receipts) ->
                val today = LocalDate.now()
                // По поставщику: самая ранняя due_date среди накладных с долгом.
                val earliestDueBySupplier = receipts
                    .filter { it.debtAmount.toDecimalOrZero().signum() > 0 }
                    .mapNotNull { r -> r.supplierId?.let { sid -> sid to parseDate(r.dueDate) } }
                    .filter { it.second != null }
                    .groupBy({ it.first }, { it.second!! })
                    .mapValues { (_, dues) -> dues.min() }

                val rows = suppliers.map { s ->
                    val debt = s.currentDebt.toDecimalOrZero()
                    val due = earliestDueBySupplier[s.id]
                    val overdue = debt.signum() > 0 && due != null && due.isBefore(today)
                    val aging = if (debt.signum() > 0 && due != null) ChronoUnit.DAYS.between(due, today).toInt().coerceAtLeast(0) else null
                    s.toRow(debt, overdue, aging)
                }.sortedByDescending { it.debt }

                _state.update {
                    it.copy(
                        loading = false,
                        rows = rows,
                        count = rows.size,
                        withDebt = rows.count { r -> r.debt.signum() > 0 },
                        overdueCount = rows.count { r -> r.overdue },
                        totalDebt = rows.fold(BigDecimal.ZERO) { acc, r -> acc + r.debt },
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить поставщиков") }
            }
        }
    }

    private fun SupplierDto.toRow(debt: BigDecimal, overdue: Boolean, aging: Int?) = SupplierRow(
        id = id,
        name = name.ifBlank { "—" },
        contact = contactPerson?.takeIf { it.isNotBlank() },
        phone = phone?.takeIf { it.isNotBlank() },
        categories = categories,
        debt = debt,
        overdue = overdue,
        agingDays = aging,
    )

    private fun parseDate(s: String?): LocalDate? =
        s?.take(10)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
}
