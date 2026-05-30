package com.restos.waiter.ui.shell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.auth.MeData
import com.restos.waiter.data.events.EventBus
import com.restos.waiter.data.events.ServerEvent
import com.restos.waiter.data.net.NetworkProbe
import com.restos.waiter.data.net.NetworkStatus
import com.restos.waiter.data.orders.OrdersApi
import com.restos.waiter.data.orders.OrderStatus
import com.restos.waiter.data.orders.WaiterTodayStats
import com.restos.waiter.data.preferences.HomeScreen
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.data.preferences.WaiterPrefsStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import javax.inject.Inject

data class ShellUiState(
    val me: MeData? = null,
    val todayStats: WaiterTodayStats? = null,
    val todayLoading: Boolean = false,
)

@HiltViewModel
class WaiterShellViewModel @Inject constructor(
    private val auth: AuthRepository,
    private val prefs: WaiterPrefsStore,
    private val ordersApi: OrdersApi,
    private val eventBus: EventBus,
    networkProbe: NetworkProbe,
) : ViewModel() {

    private val _state = MutableStateFlow(ShellUiState())
    val state: StateFlow<ShellUiState> = _state.asStateFlow()

    val networkStatus: StateFlow<NetworkStatus> = networkProbe.status

    val viewMode: StateFlow<ViewMode> = prefs.viewMode
        .stateIn(viewModelScope, SharingStarted.Eagerly, ViewMode.List)

    val homeScreen: StateFlow<HomeScreen> = prefs.homeScreen
        .stateIn(viewModelScope, SharingStarted.Eagerly, HomeScreen.Tables)

    init {
        viewModelScope.launch {
            auth.me().onSuccess { me -> _state.update { it.copy(me = me) } }
        }
        viewModelScope.launch {
            eventBus.events.collect { evt ->
                if (evt is ServerEvent.OrderCreated ||
                    evt is ServerEvent.OrderUpdated ||
                    evt is ServerEvent.Resync
                ) {
                    if (_state.value.todayStats != null) loadTodayStats()
                }
            }
        }
    }

    /**
     * v4: эндпоинта `/orders/me/stats/today` нет — считаем на клиенте через
     * листинг сегодняшних заказов своего официанта. См. CLAUDE.md в
     * android-kotlin/.
     *
     * TODO(v4-port): перенести на бэк-эндпоинт, когда он появится.
     */
    fun loadTodayStats() {
        if (_state.value.todayLoading) return
        val me = _state.value.me?.user ?: return
        viewModelScope.launch {
            _state.update { it.copy(todayLoading = true) }
            runCatching {
                val today = startOfTodayIso()
                val list = ordersApi.listOrders(
                    createdAtFrom = today,
                    waiterId = me.id,
                ).data
                val closed = list.filter { it.status == OrderStatus.DONE }
                val totalSum = closed.fold(BigDecimal.ZERO) { acc, o ->
                    acc + (runCatching { BigDecimal(o.total) }.getOrDefault(BigDecimal.ZERO))
                }
                val serviceSum = closed.fold(BigDecimal.ZERO) { acc, o ->
                    acc + (runCatching { BigDecimal(o.serviceChargeAmount) }.getOrDefault(BigDecimal.ZERO))
                }
                val tipSum = closed.fold(BigDecimal.ZERO) { acc, o ->
                    acc + (runCatching { BigDecimal(o.tipAmount) }.getOrDefault(BigDecimal.ZERO))
                }
                WaiterTodayStats(
                    ordersCount = closed.size,
                    total = totalSum.toPlainString(),
                    serviceCharge = serviceSum.toPlainString(),
                    tip = tipSum.toPlainString(),
                )
            }
                .onSuccess { stats ->
                    _state.update { it.copy(todayStats = stats, todayLoading = false) }
                }
                .onFailure { _state.update { it.copy(todayLoading = false) } }
        }
    }

    fun setViewMode(mode: ViewMode) { viewModelScope.launch { prefs.setViewMode(mode) } }
    fun setHomeScreen(screen: HomeScreen) { viewModelScope.launch { prefs.setHomeScreen(screen) } }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            auth.logout()
            onDone()
        }
    }

    private fun startOfTodayIso(): String =
        java.time.LocalDate.now(java.time.ZoneId.systemDefault())
            .atStartOfDay(java.time.ZoneId.systemDefault())
            .toOffsetDateTime()
            .toString()
}
