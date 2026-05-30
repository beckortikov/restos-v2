package com.restos.waiter.ui.tables

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.orders.OrderDto
import com.restos.waiter.data.tables.TableDto
import com.restos.waiter.data.tables.TablesRepository
import com.restos.waiter.data.tables.ZoneDto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SelectTableUiState(
    val loading: Boolean = true,
    val tables: List<TableDto> = emptyList(),
    val zones: List<ZoneDto> = emptyList(),
    val orders: List<OrderDto> = emptyList(),
)

@HiltViewModel
class SelectTableViewModel @Inject constructor(
    private val repo: TablesRepository,
    private val auth: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SelectTableUiState())
    val state: StateFlow<SelectTableUiState> = _state.asStateFlow()

    var myUserId: String? = null
        private set

    init {
        viewModelScope.launch {
            myUserId = auth.me().getOrNull()?.user?.id
            runCatching {
                val snapshot = repo.loadSnapshot()
                _state.value = SelectTableUiState(
                    loading = false,
                    tables = snapshot.tables,
                    zones = snapshot.zones,
                    orders = snapshot.orders,
                )
            }.onFailure {
                _state.value = _state.value.copy(loading = false)
            }
        }
    }
}
