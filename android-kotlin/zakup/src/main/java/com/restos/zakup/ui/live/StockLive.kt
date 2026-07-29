package com.restos.zakup.ui.live

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.events.EventBus
import com.restos.core.events.ServerEvent
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Тип SSE-события склада (эмитит бэк на приёмке/списании/возврате). */
private const val STOCK_MOVEMENT = "stock.movement"

/**
 * Подписка ViewModel'а на складские SSE-события: при `stock.movement` или
 * `Resync` (реконнект) вызывает [reload]. Ошибочный `reload` не критичен —
 * это лишь инвалидация кэша экрана. Дедуп/дебаунс не нужен: reload сам
 * выставляет loading и заменяет данные.
 */
fun ViewModel.observeStockEvents(bus: EventBus, reload: () -> Unit) {
    viewModelScope.launch {
        bus.events.collect { e ->
            val relevant = e is ServerEvent.Resync ||
                (e is ServerEvent.Other && e.type == STOCK_MOVEMENT)
            if (relevant) reload()
        }
    }
}
