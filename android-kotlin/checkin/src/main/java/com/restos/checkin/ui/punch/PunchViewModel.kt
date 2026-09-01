package com.restos.checkin.ui.punch

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.checkin.camera.SelfieShot
import com.restos.checkin.data.attendance.AttendanceApi
import com.restos.checkin.data.attendance.AttendancePunchDto
import com.restos.checkin.data.attendance.OnShiftRowDto
import com.restos.checkin.data.attendance.PinBody
import com.restos.checkin.data.attendance.PunchBody
import com.restos.checkin.data.attendance.UndoBody
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
 * Шаг терминала: ввод PIN → отметка → итог. Два шага, не три.
 *
 * Подтверждения «это точно вы?» больше нет: у входа очередь, и лишний тап на
 * каждого человека дважды в день — это и есть та мелочь, из-за которой
 * терминалом перестают пользоваться. Цена решения — возможность промаха,
 * поэтому итоговый экран даёт отменить отметку (сервер разрешает это первые
 * три минуты).
 */
sealed interface PunchStep {
    /** Ввод PIN. */
    data object Pin : PunchStep

    /** PIN принят: делаем снимок и отправляем отметку. */
    data object Working : PunchStep

    /**
     * Кадр сделан, но лица в нём нет. Снимок без человека не доказывает
     * ничего — им можно «отметить» кого угодно, просто закрыв камеру, — но и
     * держать смену заложником камеры нельзя: свет у входа бывает плохой.
     * Поэтому отдаём решение человеку: встать в кадр или отметиться без фото.
     */
    data class NoFace(val pin: String) : PunchStep

    /** Крупный итог отметки, гаснет сам. */
    data class Done(val result: AttendancePunchDto) : PunchStep
}

data class PunchUiState(
    val step: PunchStep = PunchStep.Pin,
    val pin: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    /**
     * Не всякий отказ — ошибка. «Отметка уже принята в 09:03» это
     * подтверждение, и красная плашка тут вредна: человек решает, что не
     * отметился, и тычет PIN снова, пока сервер держит паузу.
     */
    val errorIsWarning: Boolean = false,
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

    /**
     * Поставщик кадра. Ставится экраном (камера живёт в его жизненном цикле),
     * поэтому это лямбда, а не зависимость Hilt: ViewModel переживает поворот
     * и не должна держать привязанную к экрану камеру.
     */
    private var photoProvider: (suspend () -> SelfieShot?)? = null

    fun bindCamera(provider: suspend () -> SelfieShot?) {
        photoProvider = provider
    }

    fun unbindCamera() {
        photoProvider = null
    }

    init {
        refreshOnShift()
    }

    // ─── Ввод PIN ──────────────────────────────────────────────────────────

    fun appendDigit(digit: Char) {
        if (_state.value.loading) return
        val next = (_state.value.pin + digit).take(PIN_LENGTH)
        _state.update { it.copy(pin = next, error = null) }
        // Отправка на четвёртой цифре: длина PIN фиксирована, и кнопка «Далее»
        // была бы лишним тапом на каждого человека.
        if (next.length == PIN_LENGTH) punch(next)
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

    /**
     * Отметка одним шагом: снимаем кадр и сразу отправляем PIN. Приход это или
     * уход, решает сервер — терминалу знать неоткуда, а спрашивать человека
     * значит возвращать тот самый лишний тап.
     */
    private fun punch(pin: String, requirePhoto: Boolean = true) {
        _state.update { it.copy(loading = true, error = null, step = PunchStep.Working) }
        viewModelScope.launch {
            // Снимок делаем ДО отметки, но его отсутствие её не отменяет:
            // сломанная камера не повод не пустить человека на смену.
            val shot = runCatching { photoProvider?.invoke() }.getOrNull()
            if (requirePhoto && shot != null && !shot.faceFound) {
                // Камера работает, а лица нет — почти всегда человек стоит
                // боком или слишком далеко. Просим встать в кадр, а не
                // отмечаем молча негодным снимком.
                _state.update { it.copy(loading = false, step = PunchStep.NoFace(pin)) }
                return@launch
            }
            val photo = shot?.photoBase64
            runCatching { api.punch(PunchBody(pin = pin, photo = photo)) }
                .recoverCatching { e ->
                    // Касса старее приложения. APK ставят вручную, а бэк
                    // обновляется автоапдейтом — рассинхрон здесь норма, и
                    // до v3.16.373 сервер не умел решать сам, приход это или
                    // уход: он отвечал «action должен быть in или out».
                    // Спрашиваем его и повторяем — для сотрудника у стойки
                    // ничего не меняется.
                    if (e is ApiException && e.apiError.code == "VALIDATION") {
                        val who = api.lookup(PinBody(pin))
                        api.punch(PunchBody(pin = pin, action = who.nextAction, photo = photo))
                    } else {
                        throw e
                    }
                }
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

    /** Ещё раз: человек встал в кадр и просит переснять. */
    fun retryWithPhoto() {
        val step = _state.value.step
        if (step is PunchStep.NoFace) punch(step.pin)
    }

    /** Отметиться без снимка — осознанный выбор, когда камера не видит лица. */
    fun punchWithoutPhoto() {
        val step = _state.value.step
        if (step is PunchStep.NoFace) punch(step.pin, requirePhoto = false)
    }

    /** Вернуться к вводу PIN. */
    fun cancel() {
        resetJob?.cancel()
        _state.update { it.copy(step = PunchStep.Pin, pin = "", error = null, errorIsWarning = false, loading = false) }
    }

    /**
     * Отменить только что поставленную отметку — «это не я нажал».
     * Сервер разрешает отмену первые три минуты; дальше правит управляющий в
     * табеле, где действие видно и логируется.
     */
    fun undo() {
        val step = _state.value.step
        if (step !is PunchStep.Done) return
        val entryId = step.result.entryId
        resetJob?.cancel()
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            runCatching { api.undo(UndoBody(entryId)) }
                .onSuccess {
                    _state.update {
                        it.copy(loading = false, pin = "", step = PunchStep.Pin, error = "Отметка отменена", errorIsWarning = true)
                    }
                    refreshOnShift()
                }
                .onFailure { e ->
                    val msg = when (e) {
                        is ApiException -> e.apiError.message
                        else -> "Не удалось отменить — обратитесь к управляющему"
                    }
                    _state.update { it.copy(loading = false, error = msg) }
                    scheduleReset()
                }
        }
    }

    /** Ручное закрытие итогового экрана, не дожидаясь автосброса. */
    fun dismissResult() = cancel()

    private fun failWithPinReset(e: Throwable) {
        val api = e as? ApiException
        val msg = api?.apiError?.message ?: "Нет связи с кассой — отметка не сохранена"
        // CONFLICT приходит на повторное прикладывание и на «уже отмечено» —
        // это состояние, а не поломка.
        val warning = api?.apiError?.code == "CONFLICT"
        // PIN всегда стираем: оставленные на экране цифры чужого неудачного
        // ввода — это подсказка следующему в очереди.
        _state.update {
            it.copy(loading = false, pin = "", step = PunchStep.Pin, error = msg, errorIsWarning = warning)
        }
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
