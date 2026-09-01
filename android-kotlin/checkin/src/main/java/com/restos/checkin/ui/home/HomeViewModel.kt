package com.restos.checkin.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.core.auth.AuthRepository
import com.restos.core.auth.MeData
import com.restos.core.auth.TokenStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Состояние активированного терминала. Профиль берём из локального кэша
 * TokenStore — в v4 нет `/auth/me`, и дёргать сеть ради имени активировавшего
 * незачем.
 */
@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repo: AuthRepository,
    tokenStore: TokenStore,
) : ViewModel() {

    val me: StateFlow<MeData?> = tokenStore.meFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /** Деактивация терминала — возврат на PIN-экран. */
    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            repo.logout()
            onDone()
        }
    }
}
