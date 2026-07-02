package com.restos.kds.ui.board

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.events.EventBus
import com.restos.core.events.EventStreamClient
import com.restos.kds.data.KdsItemDto
import com.restos.kds.data.KdsRepository
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
) : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val error: String? = null,
        val items: List<KdsItemDto> = emptyList(),
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    // Следующий статус по кнопке на карточке.
    private fun next(status: String): String? = when (status) {
        "pending" -> "cooking"
        "cooking" -> "ready"
        "ready" -> "served"
        else -> null
    }

    init {
        eventStream.start()
        refresh()
        // Мгновенные обновления: любое SSE-событие → перезагрузка доски.
        viewModelScope.launch {
            eventBus.events.collect { refresh() }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            runCatching { repo.list(emptyList(), emptyList()) }
                .onSuccess { list -> _state.update { it.copy(loading = false, error = null, items = list) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.message ?: "Ошибка загрузки") } }
        }
    }

    /** Кнопка на карточке — перевести блюдо в следующий статус. */
    fun advance(item: KdsItemDto) {
        val target = next(item.stationStatus) ?: return
        // Оптимистично: убираем/сдвигаем сразу, затем подтверждаем сервером.
        _state.update { s ->
            s.copy(items = s.items.map { if (it.id == item.id) it.copy(stationStatus = target) else it })
        }
        viewModelScope.launch {
            runCatching { repo.setStatus(item.id, target) }
                .onSuccess { refresh() }
                .onFailure { refresh() }
        }
    }

    override fun onCleared() {
        eventStream.stop()
        super.onCleared()
    }
}
