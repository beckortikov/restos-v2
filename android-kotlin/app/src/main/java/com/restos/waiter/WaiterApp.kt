package com.restos.waiter

import android.app.Application
import com.restos.core.auth.TokenStore
import com.restos.core.events.EventStreamClient
import com.restos.core.net.NetworkProbe
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class WaiterApp : Application() {

    @Inject lateinit var tokenStore: TokenStore
    @Inject lateinit var eventStream: EventStreamClient
    @Inject lateinit var networkProbe: NetworkProbe

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        // SSE + LAN-probe запускаем когда есть токены, останавливаем при logout.
        scope.launch {
            tokenStore.tokenFlow.collectLatest { token ->
                if (token == null) {
                    eventStream.stop()
                    networkProbe.stop()
                } else {
                    eventStream.start()
                    networkProbe.start()
                }
            }
        }
    }
}
