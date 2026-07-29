package com.restos.zakup.ui.ops

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.finance.FinanceApi
import com.restos.zakup.data.finance.AccountDto
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.stock.OperationsApi
import com.restos.zakup.data.stock.ReturnInput
import com.restos.zakup.data.stock.ReturnLineInput
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

enum class ReturnReason(val api: String, val label: String) {
    Spoilage("spoilage", "Порча"), Breakage("breakage", "Бой"),
    Expired("expired", "Просрочка"), Other("other", "Другое"),
}

enum class RefundType(val api: String, val label: String) {
    Debt("debt", "В счёт долга"), Money("money", "Деньгами"),
}

data class ReturnLine(
    val receiptLineId: String,
    val name: String,
    val unit: String?,
    val price: BigDecimal,
    val available: BigDecimal, // макс к возврату по строке
    val qty: String = "",
) {
    val lineTotal: BigDecimal get() = qty.toDecimalOrZero() * price
}

data class ReturnUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val supplierName: String = "",
    val receiptDate: String = "",
    val hasDebt: Boolean = false,
    val reason: ReturnReason = ReturnReason.Spoilage,
    val refund: RefundType = RefundType.Debt,
    val accounts: List<AccountDto> = emptyList(),
    val accountId: String? = null,
    val lines: List<ReturnLine> = emptyList(),
) {
    val total: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineTotal }
    val canSubmit: Boolean
        get() = !submitting &&
            lines.any { it.qty.toDecimalOrZero().signum() > 0 } &&
            lines.all { it.qty.toDecimalOrZero() <= it.available } &&
            (refund == RefundType.Debt || accountId != null)
}

@HiltViewModel
class ReturnViewModel @Inject constructor(
    private val receiptsApi: ReceiptsApi,
    private val financeApi: FinanceApi,
    private val opsApi: OperationsApi,
    savedState: SavedStateHandle,
) : ViewModel() {

    private val receiptId: String = savedState.get<String>("receiptId").orEmpty()

    private val _state = MutableStateFlow(ReturnUiState())
    val state: StateFlow<ReturnUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            runCatching {
                val recD = async { receiptsApi.listReceipts(include = "lines", limit = 200).data.firstOrNull { it.id == receiptId } }
                val accD = async { financeApi.listAccounts().data }
                recD.await() to accD.await()
            }.onSuccess { (receipt, accounts) ->
                if (receipt == null) {
                    _state.update { it.copy(loading = false, loadError = "Накладная не найдена") }
                    return@onSuccess
                }
                val hasDebt = receipt.debtAmount.toDecimalOrZero().signum() > 0
                val lines = (receipt.lines ?: emptyList()).mapNotNull { l ->
                    val id = l.id ?: return@mapNotNull null
                    val avail = l.availableToReturn?.toDecimalOrZero() ?: l.qty.toDecimalOrZero()
                    if (avail.signum() <= 0) return@mapNotNull null
                    ReturnLine(
                        receiptLineId = id,
                        name = l.name ?: "—",
                        unit = l.unit,
                        price = l.pricePerUnit.toDecimalOrZero(),
                        available = avail,
                    )
                }
                _state.update {
                    it.copy(
                        loading = false,
                        supplierName = receipt.supplierName ?: "Поставщик",
                        receiptDate = receipt.date ?: "",
                        hasDebt = hasDebt,
                        // Ветку диктует остаток долга: есть долг → в счёт долга, иначе деньгами.
                        refund = if (hasDebt) RefundType.Debt else RefundType.Money,
                        accounts = accounts,
                        accountId = accounts.firstOrNull()?.id,
                        lines = lines,
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, loadError = e.message ?: "Ошибка загрузки") }
            }
        }
    }

    fun setReason(r: ReturnReason) = _state.update { it.copy(reason = r) }
    fun setRefund(r: RefundType) = _state.update { it.copy(refund = r) }
    fun selectAccount(id: String) = _state.update { it.copy(accountId = id) }
    fun setQty(lineId: String, v: String) = _state.update { s ->
        s.copy(lines = s.lines.map { if (it.receiptLineId == lineId) it.copy(qty = v.opSanitize()) else it })
    }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                opsApi.createReturn(ReturnInput(
                    receiptId = receiptId,
                    reason = s.reason.api,
                    refundType = s.refund.api,
                    accountId = if (s.refund == RefundType.Money) s.accountId else null,
                    lines = s.lines.filter { it.qty.toDecimalOrZero().signum() > 0 }
                        .map { ReturnLineInput(receiptLineId = it.receiptLineId, qty = it.qty.toDecimalOrZero().toPlainString()) },
                ))
            }.onSuccess { _state.update { it.copy(submitting = false, done = true) } }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось оформить возврат"
                    _state.update { it.copy(submitting = false, submitError = msg) }
                }
        }
    }
}
