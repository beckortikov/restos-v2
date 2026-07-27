package com.restos.zakup.ui.shell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.auth.MeData
import com.restos.core.auth.TokenStore
import com.restos.core.config.ServerConfigStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ZakupShellViewModel @Inject constructor(
    tokenStore: TokenStore,
    private val authRepo: AuthRepository,
    private val config: ServerConfigStore,
) : ViewModel() {

    val me: StateFlow<MeData?> = tokenStore.meFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            authRepo.logout()
            onDone()
        }
    }

    /** Пересканировать сервер из профиля — тот же сброс, что и «Сбросить
     *  сервер» на PIN-экране: сессия и привязка к кассе теряют смысл при
     *  смене сервера, поэтому выходим из аккаунта и чистим ServerConfigStore. */
    fun resetServer(onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { authRepo.logout() }
            config.clear()
            onDone()
        }
    }
}
