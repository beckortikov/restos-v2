package com.restos.checkin

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * Терминал учёта рабочего времени.
 *
 * SSE-стрим из :core здесь НЕ поднимается (в отличие от :kiosk): терминалу
 * нечего слушать — он не показывает меню и стоп-листы, а сам является
 * источником событий. Лишний висящий коннект на планшете у входа — только
 * расход батареи и лог ошибок при разрыве Wi-Fi.
 */
@HiltAndroidApp
class CheckinApp : Application()
