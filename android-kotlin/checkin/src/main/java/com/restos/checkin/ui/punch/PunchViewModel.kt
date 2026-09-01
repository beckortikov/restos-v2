package com.restos.checkin.ui.punch

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.checkin.data.attendance.AttendanceApi
import com.restos.checkin.data.attendance.AttendanceLookupDto
import com.restos.checkin.data.attendance.AttendancePunchDto
import com.restos.checkin.data.attendance.OnShiftRowDto
import com.restos.checkin.data.attendance.PinBody
import com.restos.checkin.data.attendance.PunchBody
import com.restos.core.auth.AuthRepository
import com.restos.core.config.ServerConfigStore
import com.restos.core.net.ApiException
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Шаг терминала. Ввод PIN → подтверждение с именем → результат.
 *
 * Подтверждение обязательно: без него промах по клавише молча ставил бы чужой
 * приход, и разбираться пришлось бы в конце месяца по табелю.
 */
sealed interface PunchStep {
    /** Ввод PIN. */
    data object Pin : PunchStep

    /** «Вы — Далер, отметить приход?» */
    data class Confirm(val who: AttendanceLookupDto) : PunchStep

    /** Крупный итог отметки, гаснет сам. */
    data class Done(val result: AttendancePunchDto) : PunchStep
}

data class PunchUiState(
    val step: PunchStep = PunchStep.Pin,
    val pin: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val onShift: List<OnShiftRowDto> = emptyList(),
)

@HiltViewModel
class PunchViewModel @Inject constructor(
    private val api: AttendanceApi,
    private val auth: AuthRepository,
    config: ServerConfigStore,
) : ViewModel() {

    private val _state = MutableStateFlow(PunchUiState())
    val state: StateFlow<PunchUiState> = _state.asStateFlow()

    val restaurantName: StateFlow<String?> = config.restaurantNameFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private var resetJob: Job? = null

    init {
        refreshOnShift()
    }

    // ─── Ввод PIN ──────────────────────────────────────────────────────────

    fun appendDigit(digit: Char) {
        if (_state.value.loading) return
        val next = (_state.value.pin + digit).take(PIN_LENGTH)
        _state.update { it.copy(pin = next, error = null) }
        // Автоотправка на четвёртой цифре: отдельная кнопка «Далее» здесь
        // лишняя — длина PIN фиксирована, и лишний тап у входа в час пик
        // раздражает больше, чем помогает.
        if (next.length == PIN_LENGTH) lookup(next)
    }

    fun backspace() {
        if (_state.value.loading) return
        _state.update { s ->
            if (s.pin.isEmpty()) s else s.copy(pin = s.pin.dropLast(1), error = null)
        }
    }

    fun clear() {
        if (_state.value.loading) return
        _state.update { it.copy(pin = "", error = null) }
    }

    // ─── Шаги ──────────────────────────────────────────────────────────────

    private fun lookup(pin: String) {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.lookup(PinBody(pin)) }
                .onSuccess { who ->
                    _state.update { it.copy(loading = false, step = PunchStep.Confirm(who)) }
                }
                .onFailure { e -> failWithPinReset(e) }
        }
    }

    /** Подтверждение: отправляем PIN ещё раз — сервер не доверяет user_id с клиента. */
    fun confirm() {
        val step = _state.value.step
        if (step !is PunchStep.Confirm) return
        val pin = _state.value.pin
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            runCatching { api.punch(PunchBody(pin = pin, action = step.who.nextAction)) }
                .onSuccess { res ->
                    _state.update {
                        it.copy(loading = false, pin = "", step = PunchStep.Done(res))
                    }
                    refreshOnShift()
                    scheduleReset()
                }
                .onFailure { e -> failWithPinReset(e) }
        }
    }

    /** Отмена подтверждения — «это не я». */
    fun cancel() {
        resetJob?.cancel()
        _state.update { it.copy(step = PunchStep.Pin, pin = "", error = null, loading = false) }
    }

    /** Ручное закрытие итогового экрана, не дожидаясь автосброса. */
    fun dismissResult() = cancel()

    private fun failWithPinReset(e: Throwable) {
        val msg = when (e) {
            is ApiException -> e.apiError.message
            else -> "Нет связи с кассой — отметка не сохранена"
        }
        // PIN всегда стираем: оставленные на экране цифры чужого неудачного
        // ввода — это подсказка следующему в очереди.
        _state.update { it.copy(loading = false, pin = "", step = PunchStep.Pin, error = msg) }
    }

    /**
     * Итог гаснет сам: у входа очередь, и никто не станет закрывать чужой
     * экран. Без автосброса следующий сотрудник упирался бы в чужую фамилию.
     */
    private fun scheduleReset() {
        resetJob?.cancel()
        resetJob = viewModelScope.launch {
            delay(RESULT_VISIBLE_MS)
            _state.update { it.copy(step = PunchStep.Pin, pin = "", error = null) }
        }
    }

    // ─── «Кто на смене» ────────────────────────────────────────────────────

    fun refreshOnShift() {
        viewModelScope.launch {
            runCatching { api.onShift() }
                .onSuccess { env -> _state.update { it.copy(onShift = env.data) } }
            // Ошибку списка намеренно глотаем: это справочный блок, и красная
            // плашка из-за него поверх рабочего экрана только мешала бы
            // отмечаться.
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            auth.logout()
            onDone()
        }
    }

    companion object {
        const val PIN_LENGTH = 4
        private const val RESULT_VISIBLE_MS = 4_000L
    }
}
