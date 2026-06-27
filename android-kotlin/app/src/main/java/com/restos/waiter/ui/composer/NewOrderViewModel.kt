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
import java.math.RoundingMode
import java.util.UUID
import javax.inject.Inject

data class CartLine(
    val menuItemId: String,
    val name: String,
    val price: String,
    val qty: Int,
    // Весовые блюда: unit "g"/"kg", weightQty — выбранный вес (decimal-строка).
    // Для штучных weightQty == null и сумма считается по qty.
    val unit: String = "piece",
    val unitSize: String = "1",
    val weightQty: String? = null,
) {
    val isWeight: Boolean get() = weightQty != null
}

/** Весовое блюдо — продаётся по граммам/кг, а не поштучно. */
fun MenuItemDto.isWeighed(): Boolean = unit.isNotBlank() && unit != "piece"

/**
 * Сумма одной строки: вес → price * (вес/unitSize) * порции; штука → price * qty.
 * Для весовой строки `qty` = число порций (например «3 по 100г»), `weightQty` —
 * вес ОДНОЙ порции.
 */
fun CartLine.lineTotal(): BigDecimal {
    val p = runCatching { BigDecimal(price) }.getOrDefault(BigDecimal.ZERO)
    if (!isWeight) return p * qty.toBigDecimal()
    val w = runCatching { BigDecimal(weightQty) }.getOrDefault(BigDecimal.ZERO)
    val size = runCatching { BigDecimal(unitSize) }.getOrDefault(BigDecimal.ONE)
        .let { if (it <= BigDecimal.ZERO) BigDecimal.ONE else it }
    val onePortion = p.multiply(w.divide(size, 4, RoundingMode.HALF_EVEN))
    return onePortion.multiply(qty.coerceAtLeast(1).toBigDecimal())
}

/**
 * Список категорий для чипов — ВСЕГДА по именам (selectedCategoryId хранит имя),
 * т.к. menu_items.category на бэке — это имя, а не id. Берём имена API-категорий
 * (по sortOrder), плюс любые категории, встречающиеся в блюдах. Если записей
 * категорий нет (старый импорт) — выводим уникальные категории из самих блюд.
 */
private fun buildCategories(apiCats: List<CategoryDto>, items: List<MenuItemDto>): List<CategoryDto> {
    val names = LinkedHashSet<String>()
    apiCats.sortedBy { it.sortOrder }.forEach { c -> c.name.trim().takeIf { it.isNotEmpty() }?.let(names::add) }
    if (names.isEmpty()) {
        items.mapNotNull { it.category?.trim()?.takeIf { c -> c.isNotEmpty() } }
            .distinct()
            .sortedWith(String.CASE_INSENSITIVE_ORDER)
            .forEach(names::add)
    } else {
        items.forEach { it.category?.trim()?.takeIf { c -> c.isNotEmpty() }?.let(names::add) }
    }
    return names.mapIndexed { i, n -> CategoryDto(id = n, name = n, sortOrder = i) }
}

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
    // Когда != null — открыт диалог ввода веса для этого блюда.
    val weightItem: MenuItemDto? = null,
    // Живой остаток заготовок: menu_item_id → доступно сейчас (порц.).
    val batchAvail: Map<String, Int> = emptyMap(),
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
                    categories = buildCategories(cachedCats, cachedItems),
                    items = cachedItems,
                    selectedCategoryId = null,
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
            val batchAvail = runCatching {
                menuApi.batchAvailability().data.associate { it.menuItemId to it.available }
            }.getOrNull() ?: emptyMap()
            _state.update {
                it.copy(
                    loading = false,
                    table = table,
                    categories = buildCategories(cats, items),
                    items = items,
                    selectedCategoryId = null,
                    batchAvail = batchAvail,
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
        val cart = draft.lines.map {
            CartLine(it.menuItemId, it.nameAtAdd, it.price, it.qty, it.unit, it.unitSize, it.weightQty)
        }
        _state.update {
            it.copy(cart = cart, guests = draft.guestsCount, guestsConfirmed = true)
        }
    }

    fun setSearch(q: String) { _state.update { it.copy(search = q) } }
    fun selectCategory(id: String?) { _state.update { it.copy(selectedCategoryId = id) } }
    fun setGuests(n: Int) {
        _state.update { it.copy(guests = n.coerceIn(1, 99), guestsConfirmed = true) }
    }

    /**
     * Тап по блюду. Весовое (unit != piece) → открываем диалог ввода веса.
     * Штучное → сразу +1 в корзину.
     */
    fun pick(item: MenuItemDto) {
        if (!item.isAvailable) return
        if (item.isWeighed()) {
            _state.update { it.copy(weightItem = item) }
        } else {
            addToCart(item)
        }
    }

    fun dismissWeight() { _state.update { it.copy(weightItem = null) } }

    /**
     * Подтверждение из диалога веса: вес ОДНОЙ порции + число порций.
     * Создаём/заменяем весовую строку (qty = порции, weightQty = вес порции).
     */
    fun confirmWeight(grams: BigDecimal, portions: Int) {
        val item = _state.value.weightItem ?: return
        if (grams <= BigDecimal.ZERO) { dismissWeight(); return }
        val w = grams.stripTrailingZeros().toPlainString()
        val p = portions.coerceAtLeast(1)
        _state.update { s ->
            val existing = s.cart.find { it.menuItemId == item.id && it.isWeight }
            val newCart = if (existing != null) {
                s.cart.map { if (it.menuItemId == item.id && it.isWeight) it.copy(weightQty = w, qty = p) else it }
            } else {
                s.cart + CartLine(
                    menuItemId = item.id,
                    name = item.name,
                    price = item.price,
                    qty = p,
                    unit = item.unit,
                    unitSize = item.unitSize,
                    weightQty = w,
                )
            }
            // Очищаем поиск — удобно искать следующее блюдо.
            s.copy(cart = newCart, weightItem = null, search = "")
        }
        persistDraft()
    }

    /** Текущий вес одной порции в корзине (для предзаполнения диалога), либо null. */
    fun currentWeight(menuItemId: String): String? =
        _state.value.cart.firstOrNull { it.menuItemId == menuItemId && it.isWeight }?.weightQty

    /** Текущее число порций весовой строки (для предзаполнения диалога). */
    fun currentPortions(menuItemId: String): Int =
        _state.value.cart.firstOrNull { it.menuItemId == menuItemId && it.isWeight }?.qty ?: 1

    fun addToCart(item: MenuItemDto) {
        if (!item.isAvailable) return
        _state.update { s ->
            val existing = s.cart.find { it.menuItemId == item.id && !it.isWeight }
            val newCart = if (existing != null) {
                s.cart.map {
                    if (it.menuItemId == item.id && !it.isWeight) it.copy(qty = it.qty + 1) else it
                }
            } else {
                s.cart + CartLine(item.id, item.name, item.price, qty = 1)
            }
            // Очищаем поиск после добавления — удобно вводить следующее блюдо.
            s.copy(cart = newCart, search = "")
        }
        persistDraft()
    }

    fun increment(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.map {
                if (it.menuItemId == menuItemId && !it.isWeight) it.copy(qty = it.qty + 1) else it
            })
        }
        persistDraft()
    }

    fun decrement(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.mapNotNull {
                if (it.menuItemId != menuItemId || it.isWeight) it
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

    fun cartTotal(): BigDecimal =
        _state.value.cart.fold(BigDecimal.ZERO) { acc, line -> acc + line.lineTotal() }

    fun submit() {
        val s = _state.value
        if (s.busy || s.cart.isEmpty()) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val idemKey = pendingIdemKey
                ?: UUID.randomUUID().toString().also { pendingIdemKey = it }
            try {
                val items = s.cart.flatMap { line ->
                    if (line.isWeight) {
                        // «N по 100г» → N отдельных позиций по весу одной порции.
                        // unit/unit_size делают каждую позицию НЕсливаемой на бэке
                        // (иначе iiko-pre-merge схлопнул бы их в одну 0.3кг).
                        List(line.qty.coerceAtLeast(1)) {
                            NewOrderItem(
                                menuItemId = line.menuItemId,
                                qty = line.weightQty!!,
                                unit = line.unit,
                                unitSize = line.unitSize,
                            )
                        }
                    } else {
                        listOf(NewOrderItem(menuItemId = line.menuItemId, qty = line.qty))
                    }
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
                            DraftLine(
                                menuItemId = it.menuItemId,
                                nameAtAdd = it.name,
                                price = it.price,
                                qty = it.qty,
                                unit = it.unit,
                                unitSize = it.unitSize,
                                weightQty = it.weightQty,
                            )
                        },
                    ),
                )
            }
        }
    }

    private fun errorMessage(e: Throwable, fallback: String): String =
        (e as? ApiException)?.apiError?.message ?: fallback
}
