package com.restos.kiosk.ui.confirm

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.kiosk.data.orders.CreateOrderApi
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

private val CLOSED_STATUSES = setOf("closed", "refunded", "cancelled")

data class ConfirmUiState(
    val orderNumber: Int? = null,
    val closed: Boolean = false,
)

/**
 * Экран «Оплатите на кассе» держится, пока заказ реально не закрыт/оплачен
 * кассиром — не по таймеру. Поллим GET /orders/{id} (SSE в :core сделан под
 * событийную модель заказов кухни/меню, не под point-статус одного заказа —
 * поллинг раз в 4с проще и достаточно для одного открытого экрана).
 */
@HiltViewModel
class ConfirmViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val ordersApi: CreateOrderApi,
) : ViewModel() {

    private val orderId: String? = savedStateHandle.get<String>("orderId")?.takeIf { it.isNotBlank() }

    private val _state = MutableStateFlow(
        ConfirmUiState(orderNumber = savedStateHandle.get<String>("orderNumber")?.toIntOrNull()),
    )
    val state: StateFlow<ConfirmUiState> = _state.asStateFlow()

    init {
        if (orderId == null) {
            // Нет id (навигация без параметра) — не блокируем терминал молча.
            _state.update { it.copy(closed = true) }
        } else {
            pollUntilClosed(orderId)
        }
    }

    private fun pollUntilClosed(id: String) {
        viewModelScope.launch {
            while (true) {
                val status = runCatching { ordersApi.get(id).order.status }.getOrNull()
                if (status != null && status in CLOSED_STATUSES) {
                    _state.update { it.copy(closed = true) }
                    return@launch
                }
                delay(4_000)
            }
        }
    }
}
