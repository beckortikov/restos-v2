package com.restos.waiter.data.cache

import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.menu.CategoryDto
import com.restos.waiter.data.menu.MenuItemDto
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.data.tables.ZoneDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * In-memory snapshot последних загрузок — чтобы экраны открывались
 * мгновенно с прошлыми данными, а свежий запрос шёл фоном.
 *
 * Сохраняется только в памяти процесса; на kill приложения сбрасывается —
 * это даже хорошо: следующий login получит свежие данные.
 */
@Singleton
class AppCache @Inject constructor() {
    private val _menuItems = MutableStateFlow<List<MenuItemDto>>(emptyList())
    val menuItems: StateFlow<List<MenuItemDto>> = _menuItems.asStateFlow()

    private val _categories = MutableStateFlow<List<CategoryDto>>(emptyList())
    val categories: StateFlow<List<CategoryDto>> = _categories.asStateFlow()

    private val _tables = MutableStateFlow<List<TableDto>>(emptyList())
    val tables: StateFlow<List<TableDto>> = _tables.asStateFlow()

    private val _zones = MutableStateFlow<List<ZoneDto>>(emptyList())
    val zones: StateFlow<List<ZoneDto>> = _zones.asStateFlow()

    private val _users = MutableStateFlow<List<UserDto>>(emptyList())
    val users: StateFlow<List<UserDto>> = _users.asStateFlow()

    // Кэш заказов по id — чтобы OrderDetail открывался мгновенно из последнего
    // снимка, пока полный запрос идёт фоном.
    private val _ordersById = MutableStateFlow<Map<String, OrderDto>>(emptyMap())
    val ordersById: StateFlow<Map<String, OrderDto>> = _ordersById.asStateFlow()

    fun setMenu(items: List<MenuItemDto>) { _menuItems.value = items }
    fun setCategories(list: List<CategoryDto>) { _categories.value = list }
    fun setTables(list: List<TableDto>) { _tables.value = list }
    fun setZones(list: List<ZoneDto>) { _zones.value = list }
    fun setUsers(list: List<UserDto>) { _users.value = list }

    fun putOrders(list: List<OrderDto>) {
        if (list.isEmpty()) return
        _ordersById.value = _ordersById.value + list.associateBy { it.id }
    }

    fun putOrder(order: OrderDto) {
        _ordersById.value = _ordersById.value + (order.id to order)
    }

    fun getOrder(id: String): OrderDto? = _ordersById.value[id]

    fun clear() {
        _menuItems.value = emptyList()
        _categories.value = emptyList()
        _tables.value = emptyList()
        _zones.value = emptyList()
        _users.value = emptyList()
        _ordersById.value = emptyMap()
    }
}
