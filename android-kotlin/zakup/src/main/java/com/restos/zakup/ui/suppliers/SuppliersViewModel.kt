package com.restos.zakup.ui.suppliers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.zakup.data.suppliers.SupplierDto
import com.restos.zakup.data.suppliers.SuppliersApi
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

data class SupplierRow(
    val id: String,
    val name: String,
    val contact: String?,
    val phone: String?,
    val categories: List<String>,
    val debt: BigDecimal,
)

data class SuppliersUiState(
    val loading: Boolean = true,
    val error: String? = null,
    val totalDebt: BigDecimal = BigDecimal.ZERO,
    val count: Int = 0,
    val withDebt: Int = 0,
    val rows: List<SupplierRow> = emptyList(),
)

@HiltViewModel
class SuppliersViewModel @Inject constructor(
    private val api: SuppliersApi,
) : ViewModel() {

    private val _state = MutableStateFlow(SuppliersUiState())
    val state: StateFlow<SuppliersUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.listSuppliers().data.map { it.toRow() } }
                .onSuccess { rows ->
                    val sorted = rows.sortedByDescending { it.debt }
                    _state.update {
                        it.copy(
                            loading = false,
                            rows = sorted,
                            count = sorted.size,
                            withDebt = sorted.count { r -> r.debt.signum() > 0 },
                            totalDebt = sorted.fold(BigDecimal.ZERO) { acc, r -> acc + r.debt },
                        )
                    }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить поставщиков") }
                }
        }
    }

    private fun SupplierDto.toRow() = SupplierRow(
        id = id,
        name = name.ifBlank { "—" },
        contact = contactPerson?.takeIf { it.isNotBlank() },
        phone = phone?.takeIf { it.isNotBlank() },
        categories = categories,
        debt = currentDebt.toDecimalOrZero(),
    )
}
