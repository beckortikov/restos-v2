package com.restos.kiosk

import android.app.Application
import com.restos.core.auth.TokenStore
import com.restos.core.events.EventStreamClient
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class KioskApp : Application() {

    @Inject lateinit var tokenStore: TokenStore
    @Inject lateinit var eventStream: EventStreamClient

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        // SSE-стрим (/api/v1/events) держим, пока терминал активирован — чтобы
        // стоп-лист/меню на экране гостя не расходились с кассой без ручного
        // рестарта приложения.
        scope.launch {
            tokenStore.tokenFlow.collectLatest { token ->
                if (token == null) eventStream.stop() else eventStream.start()
            }
        }
    }
}
