package com.restos.waiter.ui.lan

import androidx.lifecycle.ViewModel
import com.restos.waiter.data.net.NetworkProbe
import com.restos.waiter.data.net.NetworkStatus
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

@HiltViewModel
class LanGuardViewModel @Inject constructor(
    private val probe: NetworkProbe,
) : ViewModel() {
    val status: StateFlow<NetworkStatus> = probe.status

    fun probeNow() = probe.probeNow()
}
