package com.restos.kds.ui.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.config.ServerConfigStore
import com.restos.kds.data.BootstrapApi
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class KdsSetupViewModel @Inject constructor(
    private val serverConfig: ServerConfigStore,
    private val bootstrap: BootstrapApi,
    private val auth: AuthRepository,
) : ViewModel() {

    data class UiState(
        val url: String = "http://192.168.1.100:3001/",
        val pin: String = "",
        val busy: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    fun setUrl(v: String) = _state.update { it.copy(url = v, error = null) }
    fun setPin(v: String) = _state.update { it.copy(pin = v.filter { c -> c.isDigit() }.take(8), error = null) }

    /**
     * Онбординг KDS: сохраняем host → тянем /bootstrap/status → выбираем ресторан
     * (единственный автоматически, иначе первый) → логинимся по PIN.
     */
    fun submit(onDone: () -> Unit) {
        val s = _state.value
        if (s.pin.length < 4) {
            _state.update { it.copy(error = "PIN не короче 4 цифр") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val url = s.url.trim()
                // Сначала host без ресторана — чтобы bootstrap-запрос попал на нужный сервер.
                serverConfig.save(url, restaurantId = "", restaurantName = null)
                val st = bootstrap.status()
                val r = st.restaurants.firstOrNull()
                    ?: throw IllegalStateException("На сервере нет ресторанов")
                serverConfig.save(url, restaurantId = r.id, restaurantName = r.name)
                auth.loginWithPin(s.pin).getOrThrow()
            }.onSuccess {
                _state.update { it.copy(busy = false) }
                onDone()
            }.onFailure { e ->
                _state.update { it.copy(busy = false, error = e.message ?: "Ошибка подключения") }
            }
        }
    }
}
