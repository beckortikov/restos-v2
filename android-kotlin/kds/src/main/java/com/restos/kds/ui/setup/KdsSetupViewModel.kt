package com.restos.kds.ui.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.config.ServerConfigStore
import com.restos.core.onboarding.MachineInfoProbe
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class KdsSetupViewModel @Inject constructor(
    private val serverConfig: ServerConfigStore,
    private val probe: MachineInfoProbe,
    private val auth: AuthRepository,
) : ViewModel() {

    data class UiState(
        val url: String = "",
        val pin: String = "",
        val busy: Boolean = false,
        val error: String? = null,
        val connected: Boolean = false,          // касса подтверждена (есть restaurant_id)
        val restaurantName: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    fun setUrl(v: String) = _state.update { it.copy(url = v, error = null) }
    fun setPin(v: String) = _state.update { it.copy(pin = v.filter { c -> c.isDigit() }.take(8), error = null) }

    /** QR из кассы: содержит адрес сервера — вытаскиваем origin и подключаемся. */
    fun onQrScanned(raw: String) {
        val cleaned = raw.trim()
        if (cleaned.isBlank()) return
        val origin = runCatching {
            val uri = java.net.URI(if (cleaned.contains("://")) cleaned else "http://$cleaned")
            val port = if (uri.port > 0) ":${uri.port}" else ""
            "${uri.scheme ?: "http"}://${uri.host}$port/"
        }.getOrNull() ?: cleaned
        _state.update { it.copy(url = origin, error = null) }
        connect()
    }

    /** Проверить адрес кассы и получить restaurant_id (public/machine-info). */
    fun connect() {
        val raw = _state.value.url
        if (!ServerConfigStore.isValid(raw)) {
            _state.update { it.copy(error = "Введите корректный адрес кассы") }
            return
        }
        val url = ServerConfigStore.normalize(raw)
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            probe.probe(url)
                .onSuccess { info ->
                    serverConfig.save(url, info.restaurantId, info.restaurantName)
                    _state.update { it.copy(busy = false, connected = true, restaurantName = info.restaurantName) }
                }
                .onFailure { e ->
                    _state.update { it.copy(busy = false, error = e.message ?: "Не удалось подключиться") }
                }
        }
    }

    /** Вход по PIN (касса уже подтверждена). */
    fun login(onDone: () -> Unit) {
        val pin = _state.value.pin
        if (pin.length < 4) {
            _state.update { it.copy(error = "PIN не короче 4 цифр") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            auth.loginWithPin(pin)
                .onSuccess { _state.update { it.copy(busy = false) }; onDone() }
                .onFailure { e -> _state.update { it.copy(busy = false, error = e.message ?: "Ошибка входа") } }
        }
    }

    /** Сменить кассу — вернуться к вводу адреса. */
    fun reset() = _state.update { UiState() }
}
