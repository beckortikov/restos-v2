package com.restos.zakup.ui.newreceipt

import androidx.lifecycle.SavedStateHandle
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
    val stock: BigDecimal,
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
    // Создание нового товара из поиска
    val creatingItem: Boolean = false,
    val newItemError: String? = null,
) {
    val total: BigDecimal get() = lines.fold(BigDecimal.ZERO) { a, l -> a + l.lineTotal }

    /** Причина, по которой приёмку ещё нельзя провести (для подсказки под кнопкой). null = всё готово. */
    val validationHint: String?
        get() = when {
            supplierId == null -> "Выберите поставщика"
            lines.isEmpty() -> "Добавьте хотя бы одну позицию"
            lines.any { it.qty.toDecimalOrZero().signum() <= 0 } -> "Укажите количество для всех позиций"
            payment == PaymentType.Paid && accountId == null -> "Выберите счёт оплаты или переключитесь на «В долг»"
            else -> null
        }

    /** Первая позиция без количества — её разворачиваем при попытке провести. */
    val firstLineMissingQty: String? get() = lines.firstOrNull { it.qty.toDecimalOrZero().signum() <= 0 }?.ingredientId

    val canSubmit: Boolean get() = !submitting && validationHint == null
}

@HiltViewModel
class NewReceiptViewModel @Inject constructor(
    private val suppliersApi: SuppliersApi,
    private val financeApi: FinanceApi,
    private val stockApi: StockApi,
    private val receiptsApi: ReceiptsApi,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    private val _state = MutableStateFlow(NewReceiptUiState())
    val state: StateFlow<NewReceiptUiState> = _state.asStateFlow()

    private var kindByWarehouse: Map<String, WarehouseKind> = emptyMap()
    private val prefillIngredientIds: List<String> =
        savedStateHandle.get<String>("ingredientId")?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() } ?: emptyList()

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
                prefillIngredientIds.forEach { id -> _state.value.searchItems.find { it.id == id }?.let { addItem(it) } }
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
    fun clearNewItemError() = _state.update { it.copy(newItemError = null) }

    /**
     * Создать новый товар (продукт/хозтовар) и сразу добавить в приёмку.
     * Склад бэк назначит по is_food (еда→Продукты, не-еда→Хозтовары).
     */
    fun createIngredient(name: String, unit: String?, isFood: Boolean, price: String?, onCreated: () -> Unit) {
        if (_state.value.creatingItem) return
        _state.update { it.copy(creatingItem = true, newItemError = null) }
        viewModelScope.launch {
            runCatching {
                stockApi.createIngredient(
                    com.restos.zakup.data.stock.IngredientInput(
                        name = name.trim(),
                        unit = unit?.trim()?.takeIf { it.isNotEmpty() },
                        isFood = isFood,
                        pricePerUnit = price?.trim()?.takeIf { it.isNotEmpty() },
                    ),
                )
            }.onSuccess { dto ->
                val item = dto.toSearchItem()
                _state.update { s -> s.copy(creatingItem = false, searchItems = s.searchItems + item) }
                addItem(item) // сразу в приёмку с qty=1
                onCreated()
            }.onFailure { e ->
                val msg = (e as? ApiException)?.apiError?.message ?: e.message ?: "Не удалось создать товар"
                _state.update { it.copy(creatingItem = false, newItemError = msg) }
            }
        }
    }

    fun addItem(item: SearchItem) {
        _state.update { s ->
            if (s.lines.any { it.ingredientId == item.id }) return@update s
            // qty по умолчанию = 1 (позиция сразу валидна, как «добавить в корзину»); цену тянем из меню.
            s.copy(lines = s.lines + DraftLine(item.id, item.name, item.unit, qty = "1", price = item.price.toPlainStringOrEmpty()))
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
        stock = qty.toDecimalOrZero(),
        // Хозтовары определяем ЕДИНО по is_food=false — так же, как экран «Расход хозтоваров»,
        // и как трактует бэк (BeforeCreate: не-еда → склад supplies). Продукты/Покупные (оба еда)
        // разделяем по виду склада. Так вкладка «Хозтовары» в приёмке = список Расхода хозтоваров.
        kind = when {
            !isFood -> WarehouseKind.Supplies
            warehouseId?.let { kindByWarehouse[it] } == WarehouseKind.Purchased -> WarehouseKind.Purchased
            else -> WarehouseKind.Products
        },
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
