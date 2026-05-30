package com.restos.waiter.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.net.ApiException
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

@HiltViewModel
class PinLoginViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(PinLoginUiState())
    val state: StateFlow<PinLoginUiState> = _state.asStateFlow()

    fun appendDigit(digit: Char) {
        if (_state.value.loading) return
        _state.update { s ->
            if (s.pin.length >= MAX_PIN) s else s.copy(pin = s.pin + digit, error = null)
        }
        if (_state.value.pin.length >= MIN_PIN_SUBMIT) {
            // Не автосабмитим: пользователь сам жмёт "Войти" — но если хотим
            // авто-submit на 4 цифрах, раскомментировать:
            // submit()
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

    fun submit(onSuccess: () -> Unit) {
        val pin = _state.value.pin
        if (pin.length < MIN_PIN_SUBMIT) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = repo.loginWithPin(pin)
            result
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
        const val MAX_PIN = 6
        const val MIN_PIN_SUBMIT = 4
    }
}
