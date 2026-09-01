package com.restos.checkin.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.config.ServerConfigStore
import com.restos.core.net.ApiException
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PinLoginUiState(
    val pin: String = "",
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * Активация терминала учёта времени по PIN.
 *
 * Это НЕ вход сотрудника на смену (как в :app/:zakup) и не отметка прихода —
 * это разовая активация устройства, как в :kiosk: планшет вешают у входа, один
 * раз активируют и больше к нему не возвращаются. Отметки сотрудников пойдут
 * СЛЕДУЮЩИМ экраном, поверх этого же токена устройства, и сессию менять не
 * будут — иначе терминал разлогинивался бы после каждого прихода.
 *
 * Роль активирующего ограничена [ALLOWED_ROLES]. Терминал стоит без присмотра:
 * оставить на нём токен официанта (тем более владельца) — значит подарить
 * доступ к кассе вместе с украденным планшетом. Штатный вариант — отдельная
 * учётка с ролью «Терминал учёта времени» (`checkin`), у которой прав нет
 * вообще; owner/manager разрешены как аварийный вход, чтобы активировать точку
 * до того, как такая учётка заведена.
 *
 * Проверка клиентская и не заменяет серверный гвард: она лишь не даёт по
 * ошибке активировать терминал не тем PIN-ом. Настоящее ограничение появится
 * на эндпоинтах отметок вместе с ними.
 */
@HiltViewModel
class PinLoginViewModel @Inject constructor(
    private val repo: AuthRepository,
    private val config: ServerConfigStore,
) : ViewModel() {

    private val _state = MutableStateFlow(PinLoginUiState())
    val state: StateFlow<PinLoginUiState> = _state.asStateFlow()

    /** Название ресторана из онбординга — подсказка «куда привязан планшет». */
    val restaurantName: StateFlow<String?> = config.restaurantNameFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

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
                .onSuccess { user ->
                    if (user.role !in ALLOWED_ROLES) {
                        // Токен уже сохранён AuthRepository — снимаем его, иначе
                        // на планшете останется живая чужая сессия при отказе.
                        repo.logout()
                        _state.update {
                            it.copy(
                                loading = false,
                                pin = "",
                                error = "PIN сотрудника «${user.displayName}» не подходит " +
                                    "для активации. Нужен PIN учётки с ролью " +
                                    "«Терминал учёта времени» или управляющего.",
                            )
                        }
                        return@onSuccess
                    }
                    onSuccess()
                }
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

        /** Кто может активировать терминал (см. комментарий класса). */
        val ALLOWED_ROLES = setOf("checkin", "manager", "owner")
    }
}
