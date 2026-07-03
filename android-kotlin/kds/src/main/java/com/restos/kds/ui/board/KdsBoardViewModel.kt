package com.restos.kds.ui.board

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.events.EventBus
import com.restos.core.events.EventStreamClient
import com.restos.core.events.ServerEvent
import com.restos.kds.data.KdsItemDto
import com.restos.kds.data.KdsRepository
import com.restos.kds.data.KdsSettingsStore
import com.restos.kds.data.KdsSounds
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class KdsBoardViewModel @Inject constructor(
    private val repo: KdsRepository,
    private val eventStream: EventStreamClient,
    private val eventBus: EventBus,
    private val sounds: KdsSounds,
    private val settings: KdsSettingsStore,
) : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val error: String? = null,
        val items: List<KdsItemDto> = emptyList(),
        val soundEnabled: Boolean = true,
        val cancelAlert: String? = null,
        val stations: List<String> = emptyList(),          // выбранные; пусто = все
        val availableStations: List<String> = emptyList(), // все станции ресторана (из API)
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    private fun next(status: String): String? = when (status) {
        "pending" -> "cooking"
        "cooking" -> "ready"
        "ready" -> "served"
        else -> null
    }

    init {
        eventStream.start()
        refresh()
        viewModelScope.launch {
            runCatching { repo.stations() }.onSuccess { st ->
                _state.update { it.copy(availableStations = st) }
            }
        }
        viewModelScope.launch {
            settings.soundEnabledFlow.collect { on -> _state.update { it.copy(soundEnabled = on) } }
        }
        viewModelScope.launch {
            settings.stationsFlow.collect { st ->
                _state.update { it.copy(stations = st) }
                refresh()
            }
        }
        viewModelScope.launch {
            eventBus.events.collect { evt -> onEvent(evt) }
        }
        // Fallback-поллинг: SSE иногда теряет/задерживает события (реконнект,
        // сетевая задержка заказа официанта по WiFi). Периодический refresh
        // гарантирует, что доска не отстаёт больше чем на ~7с (диф всё равно
        // не даст задвоить звук/карточки).
        viewModelScope.launch {
            while (true) {
                delay(7_000)
                refresh()
            }
        }
    }

    private var loaded = false
    private var knownIds: Set<String> = emptySet()

    private suspend fun onEvent(evt: ServerEvent) {
        // Отмена — по событию (блюдо уже уходит с доски, дифом не поймать).
        if (evt is ServerEvent.Other && evt.type == "order.item.voided") {
            if (_state.value.soundEnabled) sounds.playCancel()
            _state.update { it.copy(cancelAlert = "Блюдо отменено") }
        }
        // Новое блюдо — по дифу в refresh (надёжнее, чем гадать по типу события).
        refresh()
    }

    fun refresh() {
        val stations = _state.value.stations
        viewModelScope.launch {
            runCatching { repo.list(stations, emptyList()) }
                .onSuccess { list ->
                    val newIds = list.mapTo(HashSet()) { it.id }
                    val added = newIds - knownIds
                    val ring = loaded && added.isNotEmpty()
                    knownIds = newIds
                    loaded = true
                    _state.update { it.copy(loading = false, error = null, items = list) }
                    // Пришло новое блюдо на доску → сигнал (если звук вкл).
                    if (ring && _state.value.soundEnabled) sounds.playNew()
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }

    fun advance(item: KdsItemDto) {
        val target = next(item.stationStatus) ?: return
        _state.update { s ->
            s.copy(items = s.items.map { if (it.id == item.id) it.copy(stationStatus = target) else it })
        }
        viewModelScope.launch {
            runCatching { repo.setStatus(item.id, target) }
                .onSuccess { refresh() }
                .onFailure { refresh() }
        }
    }

    fun toggleSound() {
        viewModelScope.launch { settings.setSoundEnabled(!_state.value.soundEnabled) }
    }

    fun setStations(stations: List<String>) {
        viewModelScope.launch { settings.setStations(stations) }
    }

    fun dismissCancelAlert() {
        _state.update { it.copy(cancelAlert = null) }
    }

    override fun onCleared() {
        eventStream.stop()
        super.onCleared()
    }
}
