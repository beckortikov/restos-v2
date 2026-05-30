package com.restos.waiter.ui.tables

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.events.EventBus
import com.restos.waiter.data.events.ServerEvent
import com.restos.waiter.data.net.ApiException
import com.restos.waiter.data.preferences.TablesTab
import com.restos.waiter.data.preferences.ViewMode
import com.restos.waiter.data.preferences.WaiterPrefsStore
import com.restos.waiter.data.tables.TableCardSnapshot
import com.restos.waiter.data.tables.TablesRepository
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

data class TablesUiState(
    val loading: Boolean = true,
    val cards: List<TableCardSnapshot> = emptyList(),
    val tab: TablesTab = TablesTab.Mine,
    val viewMode: ViewMode = ViewMode.List,
    val error: String? = null,
    val refreshing: Boolean = false,
)

@HiltViewModel
class TablesViewModel @Inject constructor(
    private val repo: TablesRepository,
    private val auth: AuthRepository,
    private val prefs: WaiterPrefsStore,
    private val eventBus: EventBus,
) : ViewModel() {

    private val _state = MutableStateFlow(TablesUiState())
    val state: StateFlow<TablesUiState> = _state.asStateFlow()

    private var currentUserId: String? = null
    private var pollJob: Job? = null

    val viewMode: StateFlow<ViewMode> = prefs.viewMode
        .stateIn(viewModelScope, SharingStarted.Eagerly, ViewMode.List)
    val tab: StateFlow<TablesTab> = prefs.tablesTab
        .stateIn(viewModelScope, SharingStarted.Eagerly, TablesTab.Mine)

    init {
        viewModelScope.launch {
            currentUserId = auth.me().getOrNull()?.user?.id
            refresh(initial = true)
            startPolling()
        }
        viewModelScope.launch {
            tab.collect { t -> _state.update { it.copy(tab = t) } }
        }
        viewModelScope.launch {
            viewMode.collect { v -> _state.update { it.copy(viewMode = v) } }
        }
        viewModelScope.launch {
            eventBus.events.collect { evt ->
                when (evt) {
                    ServerEvent.Resync,
                    is ServerEvent.OrderCreated,
                    is ServerEvent.OrderUpdated,
                    is ServerEvent.TableUpdated -> refresh()
                    is ServerEvent.Other -> Unit
                }
            }
        }
    }

    fun setTab(tab: TablesTab) {
        viewModelScope.launch { prefs.setTablesTab(tab) }
    }

    fun setViewMode(mode: ViewMode) {
        viewModelScope.launch { prefs.setViewMode(mode) }
    }

    fun refresh(initial: Boolean = false) {
        viewModelScope.launch {
            if (initial) _state.update { it.copy(loading = true, error = null) }
            else _state.update { it.copy(refreshing = true, error = null) }
            try {
                val snapshot = repo.loadSnapshot()
                val cards = snapshot.buildCards(currentUserId)
                _state.update {
                    it.copy(loading = false, refreshing = false, cards = cards, error = null)
                }
                // Подчищаем черновики, чьи столы в БД free.
                val freeIds = snapshot.tables
                    .filter { it.status == "free" }
                    .map { it.id }
                    .toSet()
                repo.pruneStaleDrafts(freeIds)
            } catch (e: Throwable) {
                val msg = (e as? ApiException)?.apiError?.message
                    ?: "Не удалось загрузить столы"
                _state.update {
                    it.copy(loading = false, refreshing = false, error = msg)
                }
            }
        }
    }

    val myUserId: String? get() = currentUserId

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
        // SSE подтягивает изменения мгновенно. Поллинг — fallback если SSE-
        // коннект упал; 10 сек чтобы пользователь не ждал 60 после создания
        // заказа на телефоне.
        const val POLL_INTERVAL_MS = 10_000L
    }
}
