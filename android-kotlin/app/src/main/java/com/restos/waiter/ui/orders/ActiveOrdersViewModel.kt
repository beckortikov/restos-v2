package com.restos.waiter.ui.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.events.EventBus
import com.restos.waiter.data.events.ServerEvent
import com.restos.waiter.data.net.ApiException
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.preferences.TablesTab
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.data.preferences.WaiterPrefsStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ActiveOrdersUiState(
    val loading: Boolean = true,
    val orders: List<OrderDto> = emptyList(),
    val tab: TablesTab = TablesTab.Mine,
    val error: String? = null,
)

@HiltViewModel
class ActiveOrdersViewModel @Inject constructor(
    private val ordersApi: OrdersApi,
    private val auth: AuthRepository,
    private val prefs: WaiterPrefsStore,
    private val eventBus: EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(ActiveOrdersUiState())
    val state: StateFlow<ActiveOrdersUiState> = _state.asStateFlow()

    private var myUserId: String? = null
    private var pollJob: Job? = null

    val tab: StateFlow<TablesTab> = prefs.tablesTab
        .stateIn(viewModelScope, SharingStarted.Eagerly, TablesTab.Mine)

    val viewMode: StateFlow<ViewMode> = prefs.viewMode
        .stateIn(viewModelScope, SharingStarted.Eagerly, ViewMode.List)

    init {
        viewModelScope.launch {
            myUserId = auth.me().getOrNull()?.user?.id
            refresh(initial = true)
            startPolling()
        }
        viewModelScope.launch {
            tab.collect { t -> _state.update { it.copy(tab = t) } }
        }
        viewModelScope.launch {
            eventBus.events.collect { evt ->
                when (evt) {
                    ServerEvent.Resync,
                    is ServerEvent.OrderCreated,
                    is ServerEvent.OrderUpdated -> refresh()
                    else -> Unit
                }
            }
        }
    }

    fun setTab(t: TablesTab) {
        viewModelScope.launch { prefs.setTablesTab(t) }
    }

    fun refresh(initial: Boolean = false) {
        viewModelScope.launch {
            if (initial) _state.update { it.copy(loading = true, error = null) }
            try {
                // v4 backend has 7 active statuses (open/new/cooking/ready/served/bill_requested).
                // Запрашиваем всё и фильтруем клиентом через OrderStatus.isActive — проще,
                // чем делать 6 параллельных запросов на каждый статус.
                val list = ordersApi.listOrders(status = null, limit = 200).data
                    .filter { OrderStatus.isActive(it.status) }
                _state.update {
                    it.copy(
                        loading = false,
                        orders = list.sortedByDescending { o -> o.createdAt },
                        error = null,
                    )
                }
            } catch (e: Throwable) {
                _state.update {
                    it.copy(
                        loading = false,
                        error = (e as? ApiException)?.apiError?.message
                            ?: "Не удалось загрузить заказы",
                    )
                }
            }
        }
    }

    fun visible(): List<OrderDto> {
        val all = _state.value.orders
        val me = myUserId
        return if (_state.value.tab == TablesTab.All || me == null) all
        else all.filter { it.waiter == me }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                delay(POLL_INTERVAL_MS)
                refresh()
            }
        }
    }

    private companion object {
        const val POLL_INTERVAL_MS = 60_000L
    }
}
