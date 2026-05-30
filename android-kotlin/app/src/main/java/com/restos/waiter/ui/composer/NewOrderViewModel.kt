package com.restos.waiter.ui.composer

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.cache.AppCache
import com.restos.waiter.data.drafts.DraftLine
import com.restos.waiter.data.drafts.WaiterDraft
import com.restos.waiter.data.drafts.WaiterDraftStore
import com.restos.waiter.data.menu.CategoryDto
import com.restos.waiter.data.menu.MenuApi
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.data.net.ApiException
import com.restos.waiter.data.orders.AddItemsRequest
import com.restos.waiter.data.orders.CreateOrderApi
import com.restos.waiter.data.orders.CreateOrderRequest
import com.restos.waiter.data.orders.NewOrderItem
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.data.tables.TablesApi
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.util.UUID
import javax.inject.Inject

data class CartLine(
    val menuItemId: String,
    val name: String,
    val price: String,
    val qty: Int,
)

data class NewOrderUiState(
    val loading: Boolean = true,
    val table: TableDto? = null,
    val categories: List<CategoryDto> = emptyList(),
    val items: List<MenuItemDto> = emptyList(),
    val selectedCategoryId: String? = null,
    val search: String = "",
    val cart: List<CartLine> = emptyList(),
    val guests: Int = 1,
    val guestsConfirmed: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val createdOrderId: String? = null,
)

@HiltViewModel
class NewOrderViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val menuApi: MenuApi,
    private val tablesApi: TablesApi,
    private val createOrderApi: CreateOrderApi,
    private val ordersApi: OrdersApi,
    private val draftStore: WaiterDraftStore,
    private val auth: AuthRepository,
    private val cache: AppCache,
) : ViewModel() {

    /** UUID-строка либо null, если пришёл sentinel "" / отсутствует. */
    val tableId: String? = savedStateHandle.get<String>("tableId")?.takeIf { it.isNotBlank() }

    /** Если задан — режим «добавить позиции к существующему заказу». */
    val appendToOrderId: String? = savedStateHandle.get<String>("orderId")?.takeIf { it.isNotBlank() }
    val isAppendMode: Boolean get() = appendToOrderId != null

    private val _state = MutableStateFlow(NewOrderUiState())
    val state: StateFlow<NewOrderUiState> = _state.asStateFlow()

    private var myUserId: String? = null

    /**
     * Sticky idempotency key для текущего submit-цикла. Генерится один раз
     * на одну логическую операцию (создать заказ ИЛИ добавить позиции).
     * Сбрасывается ТОЛЬКО после успешного ответа сервера; на network-сбое
     * пользователь жмёт «Создать заказ» повторно — летит тот же ключ, бэк
     * возвращает закэшированный ответ из idempotency_keys.
     */
    private var pendingIdemKey: String? = null

    init {
        if (tableId == null || isAppendMode) {
            _state.update { it.copy(guestsConfirmed = true) }
        }
        val cachedCats = cache.categories.value
        val cachedItems = cache.menuItems.value
        if (cachedItems.isNotEmpty() || cachedCats.isNotEmpty()) {
            _state.update {
                it.copy(
                    loading = false,
                    categories = cachedCats.sortedBy { c -> c.sortOrder },
                    items = cachedItems,
                    selectedCategoryId = cachedCats.firstOrNull()?.id,
                )
            }
        }
        viewModelScope.launch {
            myUserId = auth.me().getOrNull()?.user?.id
            loadInitial()
            if (!isAppendMode) tableId?.let { restoreDraft(it) }
        }
    }

    private suspend fun loadInitial() {
        try {
            val cats = runCatching { menuApi.listCategories().data }.getOrNull()
                ?.also { cache.setCategories(it) }
                ?: cache.categories.value
            val items = runCatching {
                menuApi.listItems(isAvailable = null).data
            }.getOrNull()
                ?.also { cache.setMenu(it) }
                ?: cache.menuItems.value
            val tables = runCatching { tablesApi.listTables().data }.getOrNull()
                ?.also { cache.setTables(it) }
                ?: cache.tables.value
            val table = tableId?.let { id -> tables.firstOrNull { it.id == id } }
            _state.update {
                it.copy(
                    loading = false,
                    table = table,
                    categories = cats.sortedBy { c -> c.sortOrder },
                    items = items,
                    selectedCategoryId = cats.firstOrNull()?.id,
                )
            }
        } catch (e: Throwable) {
            _state.update {
                it.copy(loading = false, error = errorMessage(e, "Не удалось загрузить меню"))
            }
        }
    }

    private suspend fun restoreDraft(tableId: String) {
        val me = myUserId ?: return
        val draft = draftStore.current().firstOrNull {
            it.tableId == tableId && it.waiterId == me
        } ?: return
        val cart = draft.lines.map { CartLine(it.menuItemId, it.nameAtAdd, it.price, it.qty) }
        _state.update {
            it.copy(cart = cart, guests = draft.guestsCount, guestsConfirmed = true)
        }
    }

    fun setSearch(q: String) { _state.update { it.copy(search = q) } }
    fun selectCategory(id: String?) { _state.update { it.copy(selectedCategoryId = id) } }
    fun setGuests(n: Int) {
        _state.update { it.copy(guests = n.coerceIn(1, 99), guestsConfirmed = true) }
    }

    fun addToCart(item: MenuItemDto) {
        if (!item.isAvailable) return
        _state.update { s ->
            val existing = s.cart.find { it.menuItemId == item.id }
            val newCart = if (existing != null) {
                s.cart.map { if (it.menuItemId == item.id) it.copy(qty = it.qty + 1) else it }
            } else {
                s.cart + CartLine(item.id, item.name, item.price, qty = 1)
            }
            s.copy(cart = newCart)
        }
        persistDraft()
    }

    fun increment(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.map {
                if (it.menuItemId == menuItemId) it.copy(qty = it.qty + 1) else it
            })
        }
        persistDraft()
    }

    fun decrement(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.mapNotNull {
                if (it.menuItemId != menuItemId) it
                else if (it.qty <= 1) null
                else it.copy(qty = it.qty - 1)
            })
        }
        persistDraft()
    }

    fun remove(menuItemId: String) {
        _state.update { s -> s.copy(cart = s.cart.filterNot { it.menuItemId == menuItemId }) }
        persistDraft()
    }

    fun cartTotal(): BigDecimal = _state.value.cart.fold(BigDecimal.ZERO) { acc, line ->
        val price = runCatching { BigDecimal(line.price) }.getOrDefault(BigDecimal.ZERO)
        acc + price * line.qty.toBigDecimal()
    }

    fun submit() {
        val s = _state.value
        if (s.busy || s.cart.isEmpty()) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val idemKey = pendingIdemKey
                ?: UUID.randomUUID().toString().also { pendingIdemKey = it }
            try {
                val items = s.cart.map {
                    NewOrderItem(menuItemId = it.menuItemId, qty = it.qty)
                }
                val resultOrderId: String = if (isAppendMode) {
                    val resp = ordersApi.addItems(
                        id = appendToOrderId!!,
                        idemKey = idemKey,
                        body = AddItemsRequest(items),
                    )
                    resp.id
                } else {
                    val orderType = if (tableId != null) "hall" else "takeaway"
                    val resp = createOrderApi.create(
                        idemKey = idemKey,
                        body = CreateOrderRequest(
                            orderType = orderType,
                            tableId = tableId,
                            waiterId = myUserId,
                            guestsCount = s.guests,
                            items = items,
                        ),
                    )
                    resp.id
                }
                // Успех — следующий submit это новая операция.
                pendingIdemKey = null
                tableId?.let { tid ->
                    myUserId?.let { uid -> draftStore.delete(tid, uid) }
                }
                _state.update {
                    it.copy(busy = false, cart = emptyList(), createdOrderId = resultOrderId)
                }
            } catch (e: Throwable) {
                // НЕ сбрасываем pendingIdemKey — если пользователь нажмёт
                // «Создать» ещё раз, нужно слать ТОТ ЖЕ ключ.
                val msg = if (isAppendMode) "Не удалось добавить позиции"
                else "Не удалось создать заказ"
                _state.update { it.copy(busy = false, error = errorMessage(e, msg)) }
            }
        }
    }

    fun consumeError() { _state.update { it.copy(error = null) } }

    private fun persistDraft() {
        if (isAppendMode) return
        val tid = tableId ?: return
        val uid = myUserId ?: return
        val current = _state.value
        viewModelScope.launch {
            if (current.cart.isEmpty()) {
                draftStore.delete(tid, uid)
            } else {
                draftStore.upsert(
                    WaiterDraft(
                        tableId = tid,
                        waiterId = uid,
                        guestsCount = current.guests,
                        lines = current.cart.map {
                            DraftLine(it.menuItemId, it.name, it.price, it.qty)
                        },
                    ),
                )
            }
        }
    }

    private fun errorMessage(e: Throwable, fallback: String): String =
        (e as? ApiException)?.apiError?.message ?: fallback
}
