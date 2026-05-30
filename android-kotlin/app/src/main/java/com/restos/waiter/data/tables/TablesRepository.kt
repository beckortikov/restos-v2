package com.restos.waiter.data.tables

import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.cache.AppCache
import com.restos.waiter.data.drafts.WaiterDraft
import com.restos.waiter.data.drafts.WaiterDraftStore
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.users.UsersApi
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TablesRepository @Inject constructor(
    private val tablesApi: TablesApi,
    private val ordersApi: OrdersApi,
    private val usersApi: UsersApi,
    private val draftStore: WaiterDraftStore,
    private val cache: AppCache,
) {
    suspend fun loadSnapshot(): TablesSnapshot = coroutineScope {
        val tablesDef = async {
            runCatching { tablesApi.listTables().data }.getOrNull()
        }
        val zonesDef = async {
            runCatching { tablesApi.listZones().data }.getOrNull()
        }
        val ordersDef = async {
            runCatching {
                ordersApi.listOrders(createdAtFrom = startOfTodayIso()).data
            }.getOrDefault(emptyList())
        }
        val usersDef = async {
            runCatching { usersApi.listUsers().data }.getOrNull()
        }
        val drafts = draftStore.current()

        val tables = tablesDef.await()?.also { cache.setTables(it) } ?: cache.tables.value
        val zones = zonesDef.await()?.also { cache.setZones(it) } ?: cache.zones.value
        val users = usersDef.await()?.also { cache.setUsers(it) } ?: cache.users.value
        val orders = ordersDef.await().also { cache.putOrders(it) }

        TablesSnapshot(
            tables = tables,
            zones = zones,
            orders = orders,
            users = users,
            drafts = drafts,
        )
    }

    suspend fun pruneStaleDrafts(freeTableIds: Set<String>) {
        draftStore.pruneByFreeTables(freeTableIds)
    }

    /**
     * Старт сегодняшнего дня в локальной TZ, отформатированный как строгий
     * RFC3339 с обязательными `:ss` секундами (`2026-05-30T00:00:00+05:00`).
     * Go-бэк (`time.Parse(time.RFC3339, ...)`) отвергает форму без секунд,
     * которую возвращает OffsetDateTime.toString() при нулевых секундах,
     * и вернёт 400 → весь tables-snapshot падает в пустой список.
     */
    private fun startOfTodayIso(): String =
        LocalDate.now(ZoneId.systemDefault())
            .atStartOfDay(ZoneId.systemDefault())
            .toOffsetDateTime()
            .format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX"))
}

data class TablesSnapshot(
    val tables: List<TableDto>,
    val zones: List<ZoneDto>,
    val orders: List<OrderDto>,
    val users: List<UserDto>,
    val drafts: List<WaiterDraft>,
) {
    fun buildCards(currentUserId: String?): List<TableCardSnapshot> {
        val zonesById = zones.associateBy { it.id }
        val usersById = users.associateBy { it.id }
        val draftByTable = drafts.associateBy { it.tableId }
        val activeOrdersByTable: Map<String, List<OrderDto>> = orders
            .filter { it.table != null && OrderStatus.isActive(it.status) }
            .groupBy { it.table!! }
            .mapValues { (_, list) -> list.sortedBy { it.createdAt } }

        return tables
            .filter { activeOrdersByTable.containsKey(it.id) || draftByTable.containsKey(it.id) }
            .map { table ->
                val ordersHere = activeOrdersByTable[table.id].orEmpty()
                val draft = draftByTable[table.id]
                val waiter = when {
                    draft != null && draft.waiterId == currentUserId ->
                        usersById[draft.waiterId]
                    ordersHere.isNotEmpty() ->
                        ordersHere.last().waiter?.let(usersById::get)
                    else ->
                        table.waiter?.let(usersById::get)
                }
                TableCardSnapshot(
                    table = table,
                    zone = table.zone?.let(zonesById::get),
                    orders = ordersHere,
                    draft = draft,
                    waiter = waiter,
                )
            }
            .sortedWith(
                compareBy<TableCardSnapshot> { it.table.number }
                    .thenBy { it.table.name },
            )
    }
}
