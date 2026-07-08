package com.restos.core.events

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Транспорт SSE-событий между EventStreamClient и подписчиками (ViewModels).
 * extraBufferCapacity > 0 — чтобы emit'ы из IO-потока не блокировались.
 */
@Singleton
class EventBus @Inject constructor() {
    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    suspend fun emit(event: ServerEvent) = _events.emit(event)
}

sealed interface ServerEvent {
    /** «Полностью обновить состояние» — при reconnect/resync. */
    data object Resync : ServerEvent

    data class OrderCreated(val orderId: String, val waiterId: String?) : ServerEvent
    data class OrderUpdated(val orderId: String, val waiterId: String?, val status: String?) : ServerEvent
    data class TableUpdated(val tableId: String) : ServerEvent

    /** Повар сменил статус блюда (KDS). Несёт контекст для адресного алерта официанту. */
    data class KdsItemUpdated(
        val orderId: String,
        val waiterId: String?,
        val status: String?,
        val name: String?,
        val orderNumber: Int?,
    ) : ServerEvent

    /**
     * Позиция заказа отменена (order.item.voided). KDS держит её на доске
     * отдельной красной карточкой в «Новых», пока повар не закроет вручную,
     * и показывает баннер с названием блюда и номером заказа.
     */
    data class ItemVoided(
        val itemId: String?,
        val orderId: String?,
        val name: String?,
        val qty: String?,
        val orderNumber: Int?,
    ) : ServerEvent

    /** Любое другое событие — для логирования / будущих фич. */
    data class Other(val type: String) : ServerEvent
}
