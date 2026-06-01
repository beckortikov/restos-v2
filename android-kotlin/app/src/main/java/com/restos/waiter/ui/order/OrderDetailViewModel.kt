package com.restos.waiter.ui.order

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.events.EventBus
import com.restos.waiter.data.events.ServerEvent
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.data.net.ApiException
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
    val busy: Boolean = false,
    val error: String? = null,
    val toast: String? = null,
    val itemReasons: List<CancelReasons.Reason> = emptyList(),
    val orderReasons: List<CancelReasons.Reason> = emptyList(),
)

sealed interface OrderDetailDialog {
    data object None : OrderDetailDialog
    data class CancelItem(val item: OrderItemDto) : OrderDetailDialog
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
                    else -> Unit
                }
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

    fun openCancelItem(item: OrderItemDto) {
        _dialog.value = OrderDetailDialog.CancelItem(item)
    }

    fun openCancelOrder() { _dialog.value = OrderDetailDialog.CancelOrder }
    fun openTransferTable() { _dialog.value = OrderDetailDialog.TransferTable }
    fun openAssignWaiter() { _dialog.value = OrderDetailDialog.AssignWaiter }
    fun openEditNote(item: OrderItemDto) { _dialog.value = OrderDetailDialog.EditNote(item) }
    fun dismissDialog() { _dialog.value = OrderDetailDialog.None }

    fun saveItemNote(item: OrderItemDto, note: String) {
        // TODO(v4-port): сервер не поддерживает set_item_note — обновляем
        // только локально в UI, чтобы пользователь видел свою заметку.
        runAction(busyToast = if (note.isBlank()) "Комментарий очищен" else "Комментарий сохранён локально") {
            _state.update { s ->
                val o = s.order ?: return@update s
                s.copy(order = o.copy(items = o.items.map {
                    if (it.id == item.id) it.copy(note = note) else it
                }))
            }
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

    fun cancelItem(item: OrderItemDto, reason: String) {
        runAction(busyToast = "Позиция отменена") {
            val updated = repo.cancelItem(orderId, item.id, reason)
            _state.update { it.copy(order = updated) }
            _dialog.value = OrderDetailDialog.None
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
