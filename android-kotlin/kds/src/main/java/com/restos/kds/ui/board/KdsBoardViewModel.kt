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
        val stations: List<String> = emptyList(), // выбранные; пусто = все
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
    }

    private suspend fun onEvent(evt: ServerEvent) {
        val soundOn = _state.value.soundEnabled
        when (evt) {
            is ServerEvent.OrderCreated -> if (soundOn) sounds.playNew()
            is ServerEvent.Other -> when (evt.type) {
                "order.item.added" -> if (soundOn) sounds.playNew()
                "order.item.voided" -> {
                    if (soundOn) sounds.playCancel()
                    _state.update { it.copy(cancelAlert = "Блюдо отменено") }
                }
            }
            else -> {}
        }
        refresh()
    }

    fun refresh() {
        val stations = _state.value.stations
        viewModelScope.launch {
            runCatching { repo.list(stations, emptyList()) }
                .onSuccess { list -> _state.update { it.copy(loading = false, error = null, items = list) } }
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
