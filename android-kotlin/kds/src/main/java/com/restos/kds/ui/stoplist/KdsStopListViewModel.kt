package com.restos.kds.ui.stoplist

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.kds.data.KdsRepository
import com.restos.kds.data.KdsSettingsStore
import com.restos.kds.data.MenuItemDto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Стоп-лист на кухне: повар отмечает блюдо «закончилось» → оно уходит в стоп-лист
 * и касса/официант не могут его пробить (бэк отдаёт ITEM_STOPPED).
 *
 * Управляем ТОЛЬКО ручным override (POST /stop-list/{id}/override). Стоп по
 * галочке в меню (is_available=false) и авто-стоп по остаткам показываем, но
 * снять их с кухни нельзя — это не зона повара.
 */
@HiltViewModel
class KdsStopListViewModel @Inject constructor(
    private val repo: KdsRepository,
    private val settings: KdsSettingsStore,
) : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val error: String? = null,
        val items: List<MenuItemDto> = emptyList(),
        val query: String = "",
        // id блюд, по которым сейчас идёт запрос — блокируем повторные тапы.
        val busy: Set<String> = emptySet(),
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    fun setQuery(v: String) = _state.update { it.copy(query = v) }

    fun load() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val stations = runCatching { settings.stationsFlow.first() }.getOrDefault(emptyList())
            runCatching { repo.menuItems() }
                .onSuccess { all ->
                    // Пусто = все станции (как на доске).
                    val mine = if (stations.isEmpty()) all
                    else all.filter { it.station != null && it.station in stations }
                    _state.update {
                        it.copy(
                            loading = false,
                            error = null,
                            items = mine.sortedWith(
                                compareBy({ it.category ?: "" }, { it.name ?: "" }),
                            ),
                        )
                    }
                }
                .onFailure { e ->
                    _state.update { it.copy(loading = false, error = e.message ?: "Не удалось загрузить меню") }
                }
        }
    }

    /**
     * Переключить «есть / закончилось». Оптимистично меняем локально, при ошибке
     * возвращаем как было и показываем текст ошибки.
     */
    fun toggle(item: MenuItemDto) {
        if (item.id in _state.value.busy) return
        val target = !item.stopped
        _state.update { s ->
            s.copy(
                busy = s.busy + item.id,
                items = s.items.map { if (it.id == item.id) it.copy(stopListOverride = target) else it },
            )
        }
        viewModelScope.launch {
            runCatching { repo.setStopOverride(item.id, target) }
                .onSuccess { updated ->
                    _state.update { s ->
                        s.copy(
                            busy = s.busy - item.id,
                            items = s.items.map { if (it.id == item.id) merge(it, updated) else it },
                        )
                    }
                }
                .onFailure { e ->
                    _state.update { s ->
                        s.copy(
                            busy = s.busy - item.id,
                            // Откат оптимистичного изменения.
                            items = s.items.map { if (it.id == item.id) it.copy(stopListOverride = item.stopListOverride) else it },
                            error = e.message ?: "Не удалось изменить стоп-лист",
                        )
                    }
                }
        }
    }

    fun dismissError() = _state.update { it.copy(error = null) }

    /** Сервер вернул обновлённое блюдо — берём из него флаги, имя оставляем своё. */
    private fun merge(local: MenuItemDto, fresh: MenuItemDto): MenuItemDto = local.copy(
        stopListOverride = fresh.stopListOverride,
        isAvailable = fresh.isAvailable ?: local.isAvailable,
    )
}
