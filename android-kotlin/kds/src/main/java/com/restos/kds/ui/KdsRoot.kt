package com.restos.kds.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restos.core.auth.AuthRepository
import com.restos.kds.ui.board.KdsBoardScreen
import com.restos.kds.ui.setup.KdsSetupScreen
import com.restos.kds.ui.theme.KdsColors
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class KdsRootViewModel @Inject constructor(auth: AuthRepository) : ViewModel() {
    // null = ещё грузим, true/false = вошёл/нет.
    val loggedIn: StateFlow<Boolean?> =
        auth.isLoggedIn.map { it as Boolean? }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)
}

@Composable
fun KdsRoot(vm: KdsRootViewModel = hiltViewModel()) {
    val loggedIn by vm.loggedIn.collectAsStateWithLifecycle()
    when (loggedIn) {
        null -> Box(Modifier.fillMaxSize().background(KdsColors.Bg), Alignment.Center) {
            CircularProgressIndicator(color = KdsColors.New)
        }
        false -> KdsSetupScreen(onDone = {})
        true -> KdsBoardScreen()
    }
}
