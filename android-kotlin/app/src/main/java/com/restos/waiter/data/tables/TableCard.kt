package com.restos.waiter.data.tables

import com.restos.waiter.data.auth.UserDto
import com.restos.waiter.data.drafts.WaiterDraft
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderStatus
import java.math.BigDecimal

/**
 * Готовая для отрисовки модель карточки стола: всё что показывает TableCard
 * в React-референсе.
 */
data class TableCardSnapshot(
    val table: TableDto,
    val zone: ZoneDto?,
    val orders: List<OrderDto>,
    val draft: WaiterDraft?,
    val waiter: UserDto?,
) {
    val hasReady: Boolean = false  // TODO: KitchenStatus per-item, когда заведём kitchen API
    val hasBillRequested: Boolean = orders.any { it.status == OrderStatus.BILL_REQUESTED }
    val isDraftOnly: Boolean = draft != null && orders.isEmpty()

    val totalOpen: BigDecimal = if (isDraftOnly) {
        draft?.lines.orEmpty().fold(BigDecimal.ZERO) { acc, l ->
            acc + (l.price.toBigDecimalOrZero() * l.qty.toBigDecimal())
        }
    } else {
        orders.fold(BigDecimal.ZERO) { acc, o -> acc + o.total.toBigDecimalOrZero() }
    }

    val itemsCount: Int = if (isDraftOnly) {
        draft?.lines?.size ?: 0
    } else {
        orders.sumOf { it.items.count { item -> item.cancelledAt == null } }
    }

    /** Самое старое время — для "X мин назад" в углу карточки. */
    val oldestEpochMillis: Long? = if (isDraftOnly) {
        draft?.updatedAt
    } else {
        orders.minOfOrNull { parseIsoToEpoch(it.createdAt) ?: Long.MAX_VALUE }
            ?.takeIf { it != Long.MAX_VALUE }
    }

    private fun parseIsoToEpoch(iso: String): Long? = runCatching {
        java.time.Instant.parse(iso).toEpochMilli()
    }.getOrNull()

    private fun String.toBigDecimalOrZero(): BigDecimal =
        runCatching { BigDecimal(this) }.getOrDefault(BigDecimal.ZERO)
}
