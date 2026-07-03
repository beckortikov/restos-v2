package com.restos.waiter.ui.order

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.UserDto
import com.restos.core.events.EventBus
import com.restos.core.events.ServerEvent
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.core.net.ApiException
import com.restos.waiter.data.orders.CancelReasons
import com.restos.waiter.data.orders.NewOrderItem
import com.restos.waiter.data.orders.OrderDetailRepository
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderItemDto
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.tables.TableDto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class OrderDetailUiState(
    val loading: Boolean = true,
    val order: OrderDto? = null,
    val tables: List<TableDto> = emptyList(),
    val menu: List<MenuItemDto> = emptyList(),
    val waiters: List<UserDto> = emptyList(),
    val groups: List<OrderDto> = emptyList(),
    val search: String = "",
    // Имя выбранной категории в дозаказ-поиске (null = «Все»).
    val selectedCategoryId: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
    val itemReasons: List<CancelReasons.Reason> = emptyList(),
    val orderReasons: List<CancelReasons.Reason> = emptyList(),
    // Права из матрицы доступов (по умолчанию запрещено, пока не загрузим профиль).
    val canVoid: Boolean = false,   // orders.void — отмена позиции
    val canCancel: Boolean = false, // orders.cancel — отмена заказа целиком
)

sealed interface OrderDetailDialog {
    data object None : OrderDetailDialog
    // groupIds непуст → отменяем всю весовую группу «100г × N» (все строки).
    data class CancelItem(val item: OrderItemDto, val groupIds: List<String> = emptyList()) : OrderDetailDialog
    data class EditNote(val item: OrderItemDto) : OrderDetailDialog
    data object CancelOrder : OrderDetailDialog
    data object TransferTable : OrderDetailDialog
    data object AssignWaiter : OrderDetailDialog
}

@HiltViewModel
class OrderDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repo: OrderDetailRepository,
    private val eventBus: EventBus,
    private val auth: com.restos.core.auth.AuthRepository,
    private val chime: com.restos.core.sound.Chime,
) : ViewModel() {

    val orderId: String = checkNotNull(savedStateHandle.get<String>("orderId")) {
        "orderId missing in nav args"
    }

    private val _state = MutableStateFlow(OrderDetailUiState())
    val state: StateFlow<OrderDetailUiState> = _state.asStateFlow()

    private val _dialog = MutableStateFlow<OrderDetailDialog>(OrderDetailDialog.None)
    val dialog: StateFlow<OrderDetailDialog> = _dialog.asStateFlow()

    private val _finished = MutableStateFlow(false)
    val finished: StateFlow<Boolean> = _finished.asStateFlow()

    init {
        val cachedOrder = repo.cachedOrder(orderId)
        val cachedMenu = repo.cachedMenu
        val cachedTables = repo.cachedTables
        val cachedWaiters = repo.cachedWaiters
        if (cachedOrder != null || cachedMenu.isNotEmpty() || cachedTables.isNotEmpty()) {
            _state.update {
                it.copy(
                    order = cachedOrder ?: it.order,
                    loading = cachedOrder == null,
                    menu = cachedMenu,
                    tables = cachedTables,
                    waiters = cachedWaiters,
                )
            }
        }
        _state.update {
            it.copy(
                itemReasons = repo.loadCancelReasons("item"),
                orderReasons = repo.loadCancelReasons("order"),
            )
        }
        // Права матрицы доступов текущего пользователя (из кэша login).
        viewModelScope.launch {
            val me = auth.me().getOrNull()?.user
            _state.update {
                it.copy(
                    canVoid = me?.can("orders.void") == true,
                    canCancel = me?.can("orders.cancel") == true,
                )
            }
        }
        viewModelScope.launch {
            try {
                val bundle = repo.loadInitial(orderId)
                _state.update {
                    it.copy(
                        loading = false,
                        order = bundle.order,
                        menu = bundle.menu,
                        tables = bundle.tables,
                        waiters = bundle.waiters,
                        groups = bundle.groups,
                    )
                }
            } catch (e: Throwable) {
                _state.update {
                    it.copy(loading = false, error = errorMessage(e, "Не удалось загрузить заказ"))
                }
            }
        }
        viewModelScope.launch {
            eventBus.events.collect { evt ->
                when (evt) {
                    is ServerEvent.OrderUpdated -> if (evt.orderId == orderId) refreshOrderQuiet()
                    ServerEvent.Resync -> refreshOrderQuiet()
                    // Повар сменил статус блюда (KDS) — обновляем и звеним,
                    // если у ЭТОГО заказа появилось готовое блюдо.
                    is ServerEvent.KdsItemUpdated -> if (evt.orderId == orderId) onKdsUpdate()
                    else -> Unit
                }
            }
        }
    }

    /** kds.item.updated: обновить заказ и звякнуть при новом готовом блюде. */
    private fun onKdsUpdate() {
        viewModelScope.launch {
            val before = _state.value.order?.items
                ?.filter { it.kitchenStatus == "ready" }?.map { it.id }?.toSet() ?: emptySet()
            runCatching { repo.refreshOrder(orderId) }.onSuccess { fresh ->
                _state.update { it.copy(order = fresh) }
                val nowReady = fresh.items.filter { it.kitchenStatus == "ready" }.map { it.id }.toSet()
                if ((nowReady - before).isNotEmpty()) chime.playReady()
            }
        }
    }

    private fun refreshOrderQuiet() {
        viewModelScope.launch {
            runCatching { repo.refreshOrder(orderId) }
                .onSuccess { fresh ->
                    _state.update { it.copy(order = fresh) }
                    if (fresh.status == OrderStatus.DONE ||
                        fresh.status == OrderStatus.CANCELLED
                    ) {
                        _finished.value = true
                    }
                }
        }
    }

    fun setSearch(query: String) { _state.update { it.copy(search = query) } }
    fun selectCategory(name: String?) { _state.update { it.copy(selectedCategoryId = name) } }

    fun openCancelItem(item: OrderItemDto) {
        if (!_state.value.canVoid) {
            _state.update { it.copy(toast = "Нет прав на отмену позиции") }
            return
        }
        _dialog.value = OrderDetailDialog.CancelItem(item)
    }

    fun openCancelOrder() {
        if (!_state.value.canCancel) {
            _state.update { it.copy(toast = "Нет прав на отмену заказа") }
            return
        }
        _dialog.value = OrderDetailDialog.CancelOrder
    }
    fun openTransferTable() { _dialog.value = OrderDetailDialog.TransferTable }
    fun openAssignWaiter() { _dialog.value = OrderDetailDialog.AssignWaiter }
    fun openEditNote(item: OrderItemDto) { _dialog.value = OrderDetailDialog.EditNote(item) }
    fun dismissDialog() { _dialog.value = OrderDetailDialog.None }

    fun saveItemNote(item: OrderItemDto, note: String) {
        // Бэкенд поддерживает PATCH /orders/{id}/items/{itemId}/note — сохраняем
        // на сервере (раньше был local-only stub, комментарий терялся на SSE-refresh).
        runAction(busyToast = if (note.isBlank()) "Комментарий очищен" else "Комментарий сохранён") {
            val updated = repo.setItemNote(orderId, item.id, note)
            _state.update { it.copy(order = updated) }
            _dialog.value = OrderDetailDialog.None
        }
    }

    fun consumeToast() { _state.update { it.copy(toast = null, error = null) } }

    fun addItem(menuItem: MenuItemDto) {
        if (_state.value.busy) return
        runAction(busyToast = "+ ${menuItem.name}") {
            val updated = repo.addItem(
                orderId,
                NewOrderItem(menuItemId = menuItem.id, qty = 1),
            )
            _state.update { it.copy(order = updated, search = "") }
        }
    }

    /**
     * iiko-style +1 на позиции. Если у строки есть menuItem — отправляем
     * addItems с тем же menu_item_id; бэк сам merge'нёт в существующую строку.
     */
    fun incrementItem(item: OrderItemDto) {
        val menuItemId = item.menuItem ?: return
        if (_state.value.busy) return
        runAction(busyToast = "+1 ${item.nameAtOrder}") {
            val updated = repo.incrementItem(orderId, menuItemId)
            _state.update { it.copy(order = updated) }
        }
    }

    /**
     * iiko-style −1. Если qty>1 — partial-cancel (бэк сплитит строку).
     * Если qty=1 — открываем обычный диалог с причиной.
     */
    fun decrementItem(item: OrderItemDto) {
        if (item.qty <= 1) {
            openCancelItem(item)
            return
        }
        if (_state.value.busy) return
        runAction(busyToast = "−1 ${item.nameAtOrder}") {
            val updated = repo.decrementItem(orderId, item.id)
            _state.update { it.copy(order = updated) }
        }
    }

    fun cancelItem(item: OrderItemDto, reason: String, groupIds: List<String> = emptyList()) {
        runAction(busyToast = "Позиция отменена") {
            val ids = if (groupIds.isNotEmpty()) groupIds else listOf(item.id)
            var updated: OrderDto? = null
            for (id in ids) updated = repo.cancelItem(orderId, id, reason)
            if (updated != null) _state.update { it.copy(order = updated) }
            _dialog.value = OrderDetailDialog.None
        }
    }

    /** Отмена всей весовой группы (открывает диалог причины со всеми ids). */
    fun openCancelGroup(item: OrderItemDto, ids: List<String>) {
        if (!_state.value.canVoid) {
            _state.update { it.copy(toast = "Нет прав на отмену позиции") }
            return
        }
        _dialog.value = OrderDetailDialog.CancelItem(item, ids)
    }

    /** «+ порция»: добавить ещё одну такую же весовую порцию. */
    fun addPortion(rep: OrderItemDto) {
        val menuId = rep.menuItem ?: return
        if (_state.value.busy) return
        runAction(busyToast = "+ ${rep.nameAtOrder}") {
            val updated = repo.addItem(
                orderId,
                NewOrderItem(menuItemId = menuId, qty = rep.qtyDec, unit = rep.unit, unitSize = rep.unitSize),
            )
            _state.update { it.copy(order = updated) }
        }
    }

    /** «− порция»: убрать одну порцию (полная отмена одной строки группы). */
    fun removePortion(itemId: String) {
        if (_state.value.busy) return
        runAction(busyToast = "− порция") {
            val updated = repo.cancelItem(orderId, itemId, "Уменьшение порций")
            _state.update { it.copy(order = updated) }
        }
    }

    fun cancelOrder(reason: String) {
        runAction(busyToast = "Заказ отменён") {
            repo.cancelOrder(orderId, reason)
            _dialog.value = OrderDetailDialog.None
            _finished.value = true
        }
    }

    fun transferTo(table: TableDto) {
        runAction(busyToast = "Перенесён на ${table.name}") {
            val updated = repo.transfer(orderId, table.id)
            _state.update { it.copy(order = updated) }
            _dialog.value = OrderDetailDialog.None
        }
    }

    fun assignWaiterTo(user: UserDto) {
        runAction(busyToast = "Передан ${user.displayName}") {
            val updated = repo.assignWaiter(orderId, user.id)
            _state.update { it.copy(order = updated) }
            _dialog.value = OrderDetailDialog.None
        }
    }

    fun requestBill() {
        // TODO(v4-port): нет серверного эндпоинта — баннер показывается из
        // локального state (см. OrderDetailRepository.requestBill()).
        runAction(busyToast = "Счёт запрошен (локально)") {
            val updated = repo.requestBill(orderId)
            _state.update { it.copy(order = updated) }
        }
    }

    fun printPreBill() {
        runAction(busyToast = "Пре-чек отправлен на печать") {
            val updated = repo.printPreBill(orderId)
            _state.update { it.copy(order = updated) }
        }
    }

    fun toggleServed(item: OrderItemDto) {
        val isServed = item.servedAt != null || item.kitchenStatus == "served"
        viewModelScope.launch {
            val optimistic = item.copy(
                kitchenStatus = if (isServed) "ready" else "served",
                servedAt = if (isServed) null else java.time.Instant.now().toString(),
            )
            _state.update { s ->
                val o = s.order ?: return@update s
                s.copy(order = o.copy(items = o.items.map { if (it.id == item.id) optimistic else it }))
            }
            val result = runCatching {
                if (isServed) repo.unmarkServed(orderId, item.id)
                else repo.markServed(orderId, item.id)
            }
            if (result.isFailure) {
                _state.update { it.copy(toast = "Не удалось отметить «подано»") }
            }
            runCatching { repo.refreshOrder(orderId) }
                .onSuccess { fresh -> _state.update { it.copy(order = fresh) } }
        }
    }

    private fun runAction(busyToast: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                block()
                _state.update { it.copy(busy = false, toast = busyToast) }
            } catch (e: Throwable) {
                _state.update { it.copy(busy = false, error = errorMessage(e, "Ошибка")) }
            }
        }
    }

    private fun errorMessage(e: Throwable, fallback: String): String =
        (e as? ApiException)?.apiError?.message ?: fallback
}
