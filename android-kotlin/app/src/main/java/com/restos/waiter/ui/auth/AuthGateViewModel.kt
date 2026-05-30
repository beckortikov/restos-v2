package com.restos.waiter.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.config.ServerConfigStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

enum class AuthStatus { Unknown, NeedsOnboarding, LoggedIn, LoggedOut }

@HiltViewModel
class AuthGateViewModel @Inject constructor(
    authRepo: AuthRepository,
    serverConfig: ServerConfigStore,
) : ViewModel() {
    val status: StateFlow<AuthStatus> = combine(
        authRepo.isLoggedIn,
        serverConfig.baseUrlFlow,
    ) { loggedIn, baseUrl ->
        when {
            baseUrl.isNullOrBlank() -> AuthStatus.NeedsOnboarding
            loggedIn -> AuthStatus.LoggedIn
            else -> AuthStatus.LoggedOut
        }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, AuthStatus.Unknown)
}
