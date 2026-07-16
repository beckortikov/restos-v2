package com.restos.waiter.ui.update

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.update.AppUpdateManager
import com.restos.waiter.data.update.UpdateCheck
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class AppUpdateViewModel @Inject constructor(
    private val updater: AppUpdateManager,
) : ViewModel() {

    data class UiState(
        val installedName: String = "",
        val checking: Boolean = false,
        val check: UpdateCheck? = null,
        val downloading: Boolean = false,
        val progress: Float = 0f,
        val error: String? = null,
        // Показать подсказку «разрешите установку из этого источника».
        val needPermissionHint: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState(installedName = updater.installedVersionName))
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Проверить наличие новой версии на кассе. */
    fun check() {
        if (_state.value.checking || _state.value.downloading) return
        _state.update { it.copy(checking = true, error = null) }
        viewModelScope.launch {
            runCatching { updater.check() }
                .onSuccess { c ->
                    _state.update {
                        it.copy(checking = false, check = c, installedName = c.installedVersionName)
                    }
                }
                .onFailure {
                    _state.update { it.copy(checking = false, error = "Не удалось проверить обновление") }
                }
        }
    }

    /** Скачать и запустить установку. Если нет права — ведём в настройки. */
    fun update() {
        val s = _state.value
        if (s.downloading) return
        if (!updater.canInstall()) {
            updater.requestInstallPermission()
            _state.update { it.copy(needPermissionHint = true) }
            return
        }
        _state.update { it.copy(downloading = true, progress = 0f, error = null, needPermissionHint = false) }
        viewModelScope.launch {
            runCatching { updater.download { p -> _state.update { it.copy(progress = p) } } }
                .onSuccess { file ->
                    _state.update { it.copy(downloading = false) }
                    updater.install(file)
                }
                .onFailure {
                    _state.update { it.copy(downloading = false, error = "Не удалось скачать обновление") }
                }
        }
    }
}
