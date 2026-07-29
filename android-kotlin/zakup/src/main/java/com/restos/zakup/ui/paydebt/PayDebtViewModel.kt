package com.restos.zakup.ui.paydebt

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.finance.AccountDto
import com.restos.zakup.data.finance.FinanceApi
import com.restos.zakup.data.suppliers.PayDebtInput
import com.restos.zakup.data.suppliers.SuppliersApi
import com.restos.zakup.util.toDecimalOrZero
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.math.RoundingMode
import javax.inject.Inject

data class PayDebtUiState(
    val loading: Boolean = true,
    val submitting: Boolean = false,
    val error: String? = null,
    val supplierId: String = "",
    val supplierName: String = "",
    val debt: BigDecimal = BigDecimal.ZERO,
    val accounts: List<AccountDto> = emptyList(),
    val accountId: String? = null,
    val amount: BigDecimal = BigDecimal.ZERO,
    val done: Boolean = false,
) {
    val remaining: BigDecimal get() = (debt - amount).max(BigDecimal.ZERO)
    val canSubmit: Boolean
        get() = !submitting && accountId != null && amount.signum() > 0 && amount <= debt
}

@HiltViewModel
class PayDebtViewModel @Inject constructor(
    private val financeApi: FinanceApi,
    private val suppliersApi: SuppliersApi,
) : ViewModel() {

    private val _state = MutableStateFlow(PayDebtUiState())
    val state: StateFlow<PayDebtUiState> = _state.asStateFlow()

    /** Открыть шит для поставщика: подгружает счета, ставит сумму = весь долг. */
    fun start(supplierId: String, supplierName: String, debt: BigDecimal) {
        _state.value = PayDebtUiState(
            loading = true,
            supplierId = supplierId,
            supplierName = supplierName,
            debt = debt,
            amount = debt,
        )
        viewModelScope.launch {
            runCatching { financeApi.listAccounts().data }
                .onSuccess { accounts ->
                    _state.update {
                        it.copy(loading = false, accounts = accounts, accountId = accounts.firstOrNull()?.id)
                    }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить счета") }
                }
        }
    }

    fun setAmount(value: BigDecimal) {
        val clamped = value.max(BigDecimal.ZERO).min(_state.value.debt)
        _state.update { it.copy(amount = clamped, error = null) }
    }

    fun setFraction(fraction: Double) {
        val v = _state.value.debt.multiply(BigDecimal(fraction)).setScale(0, RoundingMode.HALF_UP)
        setAmount(v)
    }

    fun setAllDebt() = setAmount(_state.value.debt)

    fun selectAccount(id: String) = _state.update { it.copy(accountId = id) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            runCatching {
                suppliersApi.payDebt(
                    id = s.supplierId,
                    body = PayDebtInput(amount = s.amount.toPlainString(), accountId = s.accountId!!),
                )
            }.onSuccess {
                _state.update { it.copy(submitting = false, done = true) }
            }.onFailure { e ->
                val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось провести платёж"
                _state.update { it.copy(submitting = false, error = msg) }
            }
        }
    }
}

fun String.parseAmount(): BigDecimal = filter { it.isDigit() }.toDecimalOrZero()
