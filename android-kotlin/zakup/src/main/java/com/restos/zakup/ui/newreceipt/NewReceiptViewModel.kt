package com.restos.zakup.ui.newreceipt

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.net.ApiException
import com.restos.zakup.data.finance.AccountDto
import com.restos.zakup.data.finance.FinanceApi
import com.restos.zakup.data.receipts.ReceiptInput
import com.restos.zakup.data.receipts.ReceiptLineInput
import com.restos.zakup.data.receipts.ReceiptsApi
import com.restos.zakup.data.stock.IngredientDto
import com.restos.zakup.data.stock.StockApi
import com.restos.zakup.data.stock.WarehouseDto
import com.restos.zakup.data.stock.listAllIngredients
import com.restos.zakup.data.suppliers.SupplierDto
import com.restos.zakup.data.suppliers.SuppliersApi
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

enum class PaymentType { Paid, Credit }

/** Позиция черновика приёмки. qty/price — строки для редактирования. */
data class DraftLine(
    val ingredientId: String,
    val name: String,
    val unit: String?,
    val qty: String,
    val price: String,
) {
    val lineTotal: BigDecimal get() = qty.toDecimalOrZero() * price.toDecimalOrZero()
}

/** Категория позиции по складу для вкладок поиска (14). */
enum class WarehouseKind(val label: String) {
    Products("Продукты"), Purchased("Покупные"), Supplies("Хозтовары"), Other("Прочее")
}

data class SearchItem(
    val id: String,
    val name: String,
    val unit: String?,
    val price: BigDecimal,
    val kind: WarehouseKind,
)

data class NewReceiptUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val submitting: Boolean = false,
    val submitError: String? = null,
    val done: Boolean = false,
    val suppliers: List<SupplierDto> = emptyList(),
    val accounts: List<AccountDto> = emptyList(),
    val supplierId: String? = null,
    val supplierName: String? = null,
    val supplierDebt: BigDecimal = BigDecimal.ZERO,
    val supplierCategories: List<String> = emptyList(),
    val lines: List<DraftLine> = emptyList(),
    val payment: PaymentType = PaymentType.Paid,
    val accountId: String? = null,
    // Поиск позиций (14)
    val searchItems: List<SearchItem> = emptyList(),
    val searchQuery: String = "",
    val searchTab: WarehouseKind? = null, // null = Все
) {
    val total: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineTotal }
    val canSubmit: Boolean
        get() = !submitting && supplierId != null && lines.isNotEmpty() &&
            lines.all { it.qty.toDecimalOrZero().signum() > 0 } &&
            (payment == PaymentType.Credit || accountId != null)
}

@HiltViewModel
class NewReceiptViewModel @Inject constructor(
    private val suppliersApi: SuppliersApi,
    private val financeApi: FinanceApi,
    private val stockApi: StockApi,
    private val receiptsApi: ReceiptsApi,
) : ViewModel() {

    private val _state = MutableStateFlow(NewReceiptUiState())
    val state: StateFlow<NewReceiptUiState> = _state.asStateFlow()

    private var kindByWarehouse: Map<String, WarehouseKind> = emptyMap()

    init { load() }

    fun load() {
        _state.update { it.copy(loading = true, loadError = null) }
        viewModelScope.launch {
            runCatching {
                val supD = async { suppliersApi.listSuppliers().data }
                val accD = async { financeApi.listAccounts().data }
                val whD = async { stockApi.listWarehouses().data }
                val ingD = async { stockApi.listAllIngredients() }
                Quad(supD.await(), accD.await(), whD.await(), ingD.await())
            }.onSuccess { (suppliers, accounts, warehouses, ingredients) ->
                kindByWarehouse = warehouses.associate { it.id to it.kind.toKind() }
                _state.update {
                    it.copy(
                        loading = false,
                        suppliers = suppliers,
                        accounts = accounts,
                        accountId = accounts.firstOrNull()?.id,
                        searchItems = ingredients.map { ing -> ing.toSearchItem() },
                    )
                }
            }.onFailure { e ->
                _state.update { it.copy(loading = false, loadError = e.message ?: "Не удалось загрузить данные") }
            }
        }
    }

    fun selectSupplier(s: SupplierDto) {
        _state.update {
            it.copy(
                supplierId = s.id,
                supplierName = s.name,
                supplierDebt = s.currentDebt.toDecimalOrZero(),
                supplierCategories = s.categories,
            )
        }
    }

    fun setSearchQuery(q: String) = _state.update { it.copy(searchQuery = q) }
    fun setSearchTab(kind: WarehouseKind?) = _state.update { it.copy(searchTab = kind) }

    fun addItem(item: SearchItem) {
        _state.update { s ->
            if (s.lines.any { it.ingredientId == item.id }) return@update s
            s.copy(lines = s.lines + DraftLine(item.id, item.name, item.unit, qty = "", price = item.price.toPlainStringOrEmpty()))
        }
    }

    fun isAdded(id: String): Boolean = _state.value.lines.any { it.ingredientId == id }

    fun removeLine(id: String) = _state.update { s -> s.copy(lines = s.lines.filterNot { it.ingredientId == id }) }

    fun setQty(id: String, qty: String) = updateLine(id) { it.copy(qty = qty.sanitizeNumber()) }
    fun setPrice(id: String, price: String) = updateLine(id) { it.copy(price = price.sanitizeNumber()) }

    private fun updateLine(id: String, f: (DraftLine) -> DraftLine) {
        _state.update { s -> s.copy(lines = s.lines.map { if (it.ingredientId == id) f(it) else it }) }
    }

    fun setPayment(p: PaymentType) = _state.update { it.copy(payment = p) }
    fun selectAccount(id: String) = _state.update { it.copy(accountId = id) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(submitting = true, submitError = null) }
        viewModelScope.launch {
            runCatching {
                val paid = s.payment == PaymentType.Paid
                receiptsApi.createReceipt(
                    ReceiptInput(
                        supplierId = s.supplierId,
                        supplierName = s.supplierName,
                        paymentType = if (paid) "paid" else "credit",
                        paidAmount = if (paid) s.total.toPlainString() else null,
                        accountId = if (paid) s.accountId else null,
                        paid = paid,
                        lines = s.lines.map {
                            ReceiptLineInput(
                                ingredientId = it.ingredientId,
                                name = it.name,
                                qty = it.qty.toDecimalOrZero().toPlainString(),
                                unit = it.unit,
                                pricePerUnit = it.price.toDecimalOrZero().toPlainString(),
                            )
                        },
                    ),
                )
            }.onSuccess {
                _state.update { it.copy(submitting = false, done = true) }
            }.onFailure { e ->
                val msg = (e as? ApiException)?.apiError?.message ?: "Не удалось провести приёмку"
                _state.update { it.copy(submitting = false, submitError = msg) }
            }
        }
    }

    private fun IngredientDto.toSearchItem() = SearchItem(
        id = id,
        name = name?.takeIf { it.isNotBlank() } ?: "—",
        unit = unit,
        price = pricePerUnit.toDecimalOrZero(),
        kind = warehouseId?.let { kindByWarehouse[it] } ?: if (!isFood) WarehouseKind.Supplies else WarehouseKind.Products,
    )
}

private fun String.toKind(): WarehouseKind = when (this) {
    "products" -> WarehouseKind.Products
    "purchased" -> WarehouseKind.Purchased
    "supplies" -> WarehouseKind.Supplies
    else -> WarehouseKind.Other
}

private fun BigDecimal.toPlainStringOrEmpty(): String =
    if (signum() == 0) "" else stripTrailingZeros().toPlainString()

private fun String.sanitizeNumber(): String =
    filter { it.isDigit() || it == '.' || it == ',' }.replace(',', '.')

private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)
