package com.restos.waiter.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.auth.AuthRepository
import com.restos.waiter.data.net.ApiException
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface HomeUiState {
    data object Loading : HomeUiState
    data class Ready(val userName: String, val restaurantName: String?) : HomeUiState
    data class Error(val message: String) : HomeUiState
}

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {

    private val _state = MutableStateFlow<HomeUiState>(HomeUiState.Loading)
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    init { load() }

    private fun load() {
        viewModelScope.launch {
            repo.me()
                .onSuccess { me ->
                    _state.value = HomeUiState.Ready(
                        userName = me.user.displayName,
                        restaurantName = me.restaurant?.name,
                    )
                }
                .onFailure { e ->
                    val msg = (e as? ApiException)?.apiError?.message
                        ?: "Ошибка загрузки профиля"
                    _state.value = HomeUiState.Error(msg)
                }
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            repo.logout()
            onDone()
        }
    }
}
