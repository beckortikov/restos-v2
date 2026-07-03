package com.restos.core.sound

import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Chime — короткий системный сигнал уведомления (переиспользуется приложениями).
 * Например: у официанта — когда повар отметил блюдо готовым.
 */
@Singleton
class Chime @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun playReady() = runCatching {
        val uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_NOTIFICATION)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val r = RingtoneManager.getRingtone(context, uri) ?: return@runCatching
        r.audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        r.play()
    }
}
