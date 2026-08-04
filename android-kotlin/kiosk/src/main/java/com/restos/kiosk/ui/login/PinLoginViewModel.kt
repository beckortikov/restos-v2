package com.restos.kiosk.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.config.ServerConfigStore
import com.restos.core.net.ApiException
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PinLoginUiState(
    val pin: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * PIN-активация терминала. В отличие от :app/:zakup это НЕ вход конкретного
 * сотрудника на смену — это разовая активация устройства (сотрудник с ролью
 * "kiosk" вводит PIN один раз при установке/после сброса), дальше терминал
 * остаётся залогинен и работает автономно для гостей.
 */
@HiltViewModel
class PinLoginViewModel @Inject constructor(
    private val repo: AuthRepository,
    private val config: ServerConfigStore,
) : ViewModel() {

    private val _state = MutableStateFlow(PinLoginUiState())
    val state: StateFlow<PinLoginUiState> = _state.asStateFlow()

    fun appendDigit(digit: Char) {
        if (_state.value.loading) return
        _state.update { s ->
            if (s.pin.length >= MAX_PIN) s else s.copy(pin = s.pin + digit, error = null)
        }
    }

    fun backspace() {
        _state.update { s ->
            if (s.pin.isEmpty()) s else s.copy(pin = s.pin.dropLast(1), error = null)
        }
    }

    fun clear() {
        _state.update { it.copy(pin = "", error = null) }
    }

    /** Сброс привязки к серверу (ре-онбординг). */
    fun resetServer(onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { repo.logout() }
            config.clear()
            _state.update { PinLoginUiState() }
            onDone()
        }
    }

    fun submit(onSuccess: () -> Unit) {
        val pin = _state.value.pin
        if (pin.length < MIN_PIN_SUBMIT) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            repo.loginWithPin(pin)
                .onSuccess { onSuccess() }
                .onFailure { e ->
                    val msg = when (e) {
                        is ApiException -> e.apiError.message
                        else -> "Нет соединения с сервером"
                    }
                    _state.update { it.copy(loading = false, pin = "", error = msg) }
                }
        }
    }

    companion object {
        const val MAX_PIN = 4
        const val MIN_PIN_SUBMIT = 4
    }
}
