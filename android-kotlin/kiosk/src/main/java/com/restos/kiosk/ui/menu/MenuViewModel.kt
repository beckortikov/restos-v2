package com.restos.kiosk.ui.menu

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.events.EventBus
import com.restos.core.events.ServerEvent
import com.restos.core.net.ApiException
import com.restos.kiosk.data.menu.CategoryDto
import com.restos.kiosk.data.menu.MenuApi
import com.restos.kiosk.data.menu.MenuItemDto
import com.restos.kiosk.data.menu.listAllItems
import com.restos.kiosk.data.orders.CreateOrderApi
import com.restos.kiosk.data.orders.CreateOrderRequest
import com.restos.kiosk.data.orders.NewOrderItem
import com.restos.kiosk.data.orders.OrderDto
import com.restos.kiosk.data.shifts.ShiftsApi
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import retrofit2.HttpException
import java.math.BigDecimal
import java.util.UUID
import javax.inject.Inject

data class CartLine(
    val menuItemId: String,
    val name: String,
    val price: String,
    val qty: Int,
)

fun CartLine.lineTotal(): BigDecimal =
    runCatching { BigDecimal(price) }.getOrDefault(BigDecimal.ZERO) * qty.toBigDecimal()

/**
 * Список категорий для чипов — по именам (как на кассе/официанте):
 * menu_items.category на бэке — имя, а не id.
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

data class MenuUiState(
    val loading: Boolean = true,
    val categories: List<CategoryDto> = emptyList(),
    val items: List<MenuItemDto> = emptyList(),
    val selectedCategoryId: String? = null,
    val search: String = "",
    val cart: List<CartLine> = emptyList(),
    val showPreview: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    val createdOrder: OrderDto? = null,
)

@HiltViewModel
class MenuViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val menuApi: MenuApi,
    private val createOrderApi: CreateOrderApi,
    private val shiftsApi: ShiftsApi,
    private val eventBus: EventBus,
) : ViewModel() {

    val orderType: String = savedStateHandle.get<String>("orderType") ?: "takeaway"

    private val _state = MutableStateFlow(MenuUiState())
    val state: StateFlow<MenuUiState> = _state.asStateFlow()

    private var pendingIdemKey: String? = null

    init {
        viewModelScope.launch { loadInitial() }
        viewModelScope.launch {
            eventBus.events.collect { evt ->
                // Повар/менеджер поставил стоп на кухне — перечитываем меню, чтобы
                // гость не заказал то, чего уже нет (терминал без присмотра).
                if (evt is ServerEvent.StopListUpdated || evt is ServerEvent.Resync) reloadMenu()
            }
        }
    }

    private suspend fun loadInitial() {
        try {
            val cats = runCatching { menuApi.listCategories().data }.getOrDefault(emptyList())
            // Весовые блюда (unit != piece) на терминале самозаказа не продаём —
            // нет диалога взвешивания, только штучные позиции быстрого питания.
            val items = runCatching { menuApi.listAllItems(isAvailable = true) }
                .getOrDefault(emptyList())
                .filter { it.unit == "piece" && !it.isDeleted }
            _state.update {
                it.copy(
                    loading = false,
                    categories = buildCategories(cats, items),
                    items = items,
                )
            }
        } catch (e: Throwable) {
            _state.update { it.copy(loading = false, error = errorMessage(e, "Не удалось загрузить меню")) }
        }
    }

    private suspend fun reloadMenu() {
        val cats = runCatching { menuApi.listCategories().data }.getOrNull() ?: _state.value.categories
        val items = runCatching { menuApi.listAllItems(isAvailable = true) }.getOrNull()
            ?.filter { it.unit == "piece" && !it.isDeleted } ?: return
        val availableIds = items.map { it.id }.toSet()
        _state.update {
            it.copy(
                items = items,
                categories = buildCategories(cats, items),
                // Позиция ушла в стоп — убираем из корзины, чтобы не улетела в заказ.
                cart = it.cart.filter { line -> line.menuItemId in availableIds },
            )
        }
    }

    fun selectCategory(id: String?) {
        _state.update { it.copy(selectedCategoryId = id) }
    }

    fun setSearch(q: String) {
        _state.update { it.copy(search = q) }
    }

    fun addToCart(item: MenuItemDto) {
        _state.update { s ->
            val existing = s.cart.find { it.menuItemId == item.id }
            val newCart = if (existing != null) {
                s.cart.map { if (it.menuItemId == item.id) it.copy(qty = it.qty + 1) else it }
            } else {
                s.cart + CartLine(item.id, item.name, item.price, qty = 1)
            }
            s.copy(cart = newCart)
        }
    }

    fun increment(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.map { if (it.menuItemId == menuItemId) it.copy(qty = it.qty + 1) else it })
        }
    }

    fun decrement(menuItemId: String) {
        _state.update { s ->
            s.copy(cart = s.cart.mapNotNull {
                if (it.menuItemId != menuItemId) it
                else if (it.qty <= 1) null
                else it.copy(qty = it.qty - 1)
            })
        }
    }

    fun remove(menuItemId: String) {
        _state.update { s -> s.copy(cart = s.cart.filterNot { it.menuItemId == menuItemId }) }
    }

    fun qtyInCart(menuItemId: String): Int = _state.value.cart.firstOrNull { it.menuItemId == menuItemId }?.qty ?: 0

    fun cartCount(): Int = _state.value.cart.sumOf { it.qty }

    fun cartTotal(): BigDecimal = _state.value.cart.fold(BigDecimal.ZERO) { acc, line -> acc + line.lineTotal() }

    /** Открыть/закрыть превью заказа (список позиций перед отправкой). */
    fun openPreview() {
        if (_state.value.cart.isEmpty()) return
        _state.update { it.copy(showPreview = true) }
    }

    fun dismissPreview() {
        _state.update { it.copy(showPreview = false) }
    }

    fun submit() {
        val s = _state.value
        if (s.busy || s.cart.isEmpty()) return
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val idemKey = pendingIdemKey ?: UUID.randomUUID().toString().also { pendingIdemKey = it }
            try {
                // shift_id ОБЯЗАТЕЛЕН на создании — бэк не проставляет его сам
                // (нет server-side fallback на активную смену открытия). Без
                // него заказ создаётся, но невидим для кассы: не найти в
                // списке "Заказы" (строгий скоуп по shift_id), нельзя ни
                // открыть, ни отменить, ни закрыть.
                val shift = try {
                    shiftsApi.active()
                } catch (e: HttpException) {
                    if (e.code() == 404) {
                        _state.update {
                            it.copy(
                                busy = false,
                                showPreview = false,
                                error = "Касса ещё не открыла смену. Обратитесь к сотруднику.",
                            )
                        }
                        return@launch
                    }
                    throw e
                }
                val resp = createOrderApi.create(
                    idemKey = idemKey,
                    body = CreateOrderRequest(
                        orderType = orderType,
                        shiftId = shift.id,
                        items = s.cart.map { NewOrderItem(menuItemId = it.menuItemId, qty = it.qty) },
                    ),
                )
                pendingIdemKey = null
                _state.update { it.copy(busy = false, showPreview = false, cart = emptyList(), createdOrder = resp) }
            } catch (e: Throwable) {
                _state.update { it.copy(busy = false, error = errorMessage(e, "Не удалось создать заказ")) }
            }
        }
    }

    fun consumeError() {
        _state.update { it.copy(error = null) }
    }

    private fun errorMessage(e: Throwable, fallback: String): String =
        (e as? ApiException)?.apiError?.message ?: fallback
}
