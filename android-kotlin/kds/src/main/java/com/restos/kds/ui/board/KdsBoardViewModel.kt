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
        // Момент (по монотонным часам планшета), когда пришёл текущий список.
        // Возраст блюда = item.ageSeconds (серверный) + (сейчас - fetchedAtMs).
        val fetchedAtMs: Long = 0,
        // Отменённые блюда — держим отдельно от активной доски, чтобы refresh()
        // (перечитывающий только items) их не стирал. Показываются красными
        // карточками сверху «Новых», пока повар не закроет вручную.
        val cancelledItems: List<KdsItemDto> = emptyList(),
        val soundEnabled: Boolean = true,
        val soundId: Int = 0,
        val cancelAlert: String? = null,
        // id блюд, по которым только что вызвали официанта — колокольчик зеленеет
        // «Вызван» на несколько секунд.
        val calledItems: Set<String> = emptySet(),
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
            settings.soundIdFlow.collect { id -> _state.update { it.copy(soundId = id) } }
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
        if (evt is ServerEvent.ItemVoided) {
            handleVoided(evt)
            // Подтянуть остальную доску (сервер уже не вернёт отменённую позицию).
            refresh()
            return
        }
        // Вызов официанта — это событие ДЛЯ официанта, кухне доску обновлять не надо.
        if (evt is ServerEvent.WaiterCalled) return
        // Новое блюдо — по дифу в refresh (надёжнее, чем гадать по типу события).
        refresh()
    }

    /**
     * Повар нажал колокольчик — зовём официанта заказа на кухню. Оптимистично
     * помечаем блюдо «Вызван» на 5с; при ошибке снимаем метку и показываем баннер.
     */
    fun callWaiter(item: KdsItemDto) {
        _state.update { it.copy(calledItems = it.calledItems + item.id) }
        viewModelScope.launch {
            runCatching { repo.callWaiter(item.id) }
                .onFailure {
                    _state.update {
                        it.copy(
                            calledItems = it.calledItems - item.id,
                            cancelAlert = "Не удалось вызвать официанта",
                        )
                    }
                }
            delay(5000)
            _state.update { it.copy(calledItems = it.calledItems - item.id) }
        }
    }

    /**
     * Блюдо отменили: держим его красной карточкой в «Новых» (повар закроет сам),
     * играем сигнал и показываем баннер с названием и номером заказа.
     */
    private fun handleVoided(evt: ServerEvent.ItemVoided) {
        // Показываем отмену ТОЛЬКО если блюдо есть на ЭТОЙ доске (нужная станция).
        // Событие order.item.voided broadcast'ится по всему ресторану, поэтому без
        // этой проверки холодный цех сигналил бы об отмене ГОРЯЧЕГО блюда (и наоборот).
        val itemId = evt.itemId ?: return
        val onBoard = _state.value.items.firstOrNull { it.id == itemId } ?: return

        if (_state.value.soundEnabled) sounds.playCancel()

        val card = onBoard.copy(cancelled = true, stationStatus = "pending")
        val name = onBoard.name.takeIf { it.isNotBlank() } ?: evt.name
        val num = onBoard.orderNumber.takeIf { it > 0 } ?: evt.orderNumber?.takeIf { it > 0 }
        val alert = when {
            !name.isNullOrBlank() && num != null -> "Блюдо «$name» отменено · Заказ #$num"
            !name.isNullOrBlank() -> "Блюдо «$name» отменено"
            else -> "Блюдо отменено"
        }

        _state.update { s ->
            val already = s.cancelledItems.any { it.id == card.id }
            s.copy(
                cancelledItems = if (already) s.cancelledItems else s.cancelledItems + card,
                // Убираем из активной доски сразу, чтобы блюдо не мигало в своей
                // колонке до следующего refresh.
                items = s.items.filterNot { it.id == card.id },
                cancelAlert = alert,
            )
        }
    }

    /** Повар нажал «ЗАКРЫТЬ» на отменённой карточке — убираем её с доски. */
    fun closeCancelled(id: String) {
        _state.update { it.copy(cancelledItems = it.cancelledItems.filterNot { c -> c.id == id }) }
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
                    _state.update {
                        it.copy(
                            loading = false, error = null, items = list,
                            // Те же часы, что тикают на экране (System.currentTimeMillis):
                            // считаем ТОЛЬКО дельту с момента загрузки, поэтому кривой
                            // абсолютный сдвиг часов планшета не важен.
                            fetchedAtMs = System.currentTimeMillis(),
                        )
                    }
                    // Пришло новое блюдо на доску → сигнал (если звук вкл).
                    if (ring && _state.value.soundEnabled) sounds.playNew(_state.value.soundId)
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

    /** Названия пресетов звука для настроек. */
    val soundNames: List<String> get() = sounds.presets.map { it.name }

    fun setSoundId(id: Int) {
        viewModelScope.launch { settings.setSoundId(id) }
    }

    /** Проиграть превью пресета (кнопка в настройках). */
    fun previewSound(id: Int) = sounds.preview(id)

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
