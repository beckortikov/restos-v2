package com.restos.waiter.data.orders

import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.cache.AppCache
import com.restos.waiter.data.kitchen.KitchenApi
import com.restos.waiter.data.menu.MenuApi
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.data.tables.AssignWaiterRequest
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.data.tables.TablesApi
import com.restos.waiter.data.users.UsersApi
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class OrderDetailRepository @Inject constructor(
    private val ordersApi: OrdersApi,
    private val menuApi: MenuApi,
    private val tablesApi: TablesApi,
    private val kitchenApi: KitchenApi,
    private val usersApi: UsersApi,
    private val cache: AppCache,
) {
    val cachedMenu: List<MenuItemDto> get() = cache.menuItems.value
    val cachedTables: List<TableDto> get() = cache.tables.value
    val cachedWaiters: List<UserDto> get() = cache.users.value.filter { it.role == "waiter" }

    suspend fun loadInitial(orderId: String): OrderDetailBundle = coroutineScope {
        val orderDef = async { ordersApi.retrieve(orderId) }
        val menuDef = async { runCatching { menuApi.listItems().data }.getOrNull() }
        val tablesDef = async { runCatching { tablesApi.listTables().data }.getOrNull() }
        val waitersDef = async {
            runCatching { usersApi.listUsers().data }.getOrNull()
        }
        val groupsDef = async {
            // Все активные заказы — нужны чтобы посчитать «группы» на одном столе.
            runCatching { ordersApi.listOrders().data }.getOrDefault(emptyList())
        }
        val order = orderDef.await().also { cache.putOrder(it) }
        val allActive = groupsDef.await()
            .also { cache.putOrders(it) }
            .filter { OrderStatus.isActive(it.status) }
        val groups = if (order.table != null) {
            allActive.filter { it.table == order.table }.sortedBy { it.createdAt }
        } else listOf(order)

        val menu = menuDef.await()?.also { cache.setMenu(it) } ?: cache.menuItems.value
        val tables = tablesDef.await()?.also { cache.setTables(it) } ?: cache.tables.value
        val waitersAll = waitersDef.await()?.also { cache.setUsers(it) } ?: cache.users.value
        val waiters = waitersAll.filter { it.role == "waiter" }

        OrderDetailBundle(
            order = order,
            menu = menu,
            tables = tables,
            waiters = waiters,
            groups = groups,
        )
    }

    suspend fun refreshOrder(orderId: String): OrderDto =
        ordersApi.retrieve(orderId).also { cache.putOrder(it) }

    fun cachedOrder(orderId: String): OrderDto? = cache.getOrder(orderId)

    suspend fun addItem(orderId: String, item: NewOrderItem): OrderDto =
        ordersApi.addItems(orderId, AddItemsRequest(listOf(item)))

    suspend fun cancelItem(orderId: String, itemId: String, reason: String): OrderDto =
        ordersApi.cancelItem(orderId, itemId, CancelItemRequest(reason))

    suspend fun cancelOrder(orderId: String, reason: String): OrderDto =
        ordersApi.cancelOrder(orderId, CancelOrderRequest(reason))

    suspend fun transfer(orderId: String, newTableId: String): OrderDto =
        ordersApi.transfer(orderId, TransferRequest(newTableId))

    // TODO(v4-port): /orders/{id}/request_bill — нет в v4. UI обновляем
    // локально (показываем баннер «Кассир принимает оплату»), но без
    // серверной отметки. Когда бэк добавит status PATCH — заменить.
    suspend fun requestBill(orderId: String): OrderDto {
        val current = cache.getOrder(orderId) ?: ordersApi.retrieve(orderId)
        return current.copy(status = OrderStatus.BILL_REQUESTED)
            .also { cache.putOrder(it) }
    }

    /**
     * v4: POST /orders/{id}/print-pre-bill — кладёт PrintJob в очередь.
     * Возвращает свежее состояние заказа (заказ не меняется, но UI
     * полезно обновить — например, можно показать timestamp последней
     * печати из print_jobs позже).
     */
    suspend fun printPreBill(orderId: String): OrderDto {
        ordersApi.printPreBill(orderId)
        return ordersApi.retrieve(orderId).also { cache.putOrder(it) }
    }

    /** v4: hardcoded reasons (см. CancelReasons), бэк не имеет CRUD. */
    fun loadCancelReasons(kind: String): List<CancelReasons.Reason> =
        if (kind == "item") CancelReasons.list(CancelReasons.Kind.Item)
        else CancelReasons.list(CancelReasons.Kind.Order)

    suspend fun markServed(orderId: String, itemId: String) {
        kitchenApi.markServed(orderId, itemId)
    }

    suspend fun unmarkServed(orderId: String, itemId: String) {
        kitchenApi.unmarkServed(orderId, itemId)
    }

    /**
     * v4: переназначение официанта — на уровне стола, не заказа. Берём
     * tableId из текущего заказа (для takeaway вернёт исходный заказ).
     */
    suspend fun assignWaiter(orderId: String, waiterId: String): OrderDto {
        val order = cache.getOrder(orderId) ?: ordersApi.retrieve(orderId)
        val tableId = order.table
        if (tableId != null) {
            tablesApi.assignWaiter(tableId, AssignWaiterRequest(waiterId = waiterId))
        }
        // Перетягиваем актуальный заказ — бэк проставит waiter автоматически.
        return ordersApi.retrieve(orderId).also { cache.putOrder(it) }
    }

    /**
     * v4: PATCH /orders/{id}/items/{itemId}/note — комментарий к позиции.
     * Пустая строка → очищает.
     */
    suspend fun setItemNote(orderId: String, itemId: String, note: String): OrderDto {
        val payload = note.trim().ifEmpty { null }
        ordersApi.setItemNote(orderId, itemId, SetItemNoteRequest(payload))
        return ordersApi.retrieve(orderId).also { cache.putOrder(it) }
    }
}

data class OrderDetailBundle(
    val order: OrderDto,
    val menu: List<MenuItemDto>,
    val tables: List<TableDto>,
    val waiters: List<UserDto> = emptyList(),
    val groups: List<OrderDto> = emptyList(),
)
