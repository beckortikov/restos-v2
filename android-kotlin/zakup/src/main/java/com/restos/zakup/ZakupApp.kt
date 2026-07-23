package com.restos.zakup

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

// SSE (EventStreamClient из :core) и live-инвалидация подключаются в Ф4 —
// в каркасе (Ф0) приложение обходится обычными запросами.
@HiltAndroidApp
class ZakupApp : Application()
