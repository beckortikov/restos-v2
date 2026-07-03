package com.restos.kds.data

import android.content.Context
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * KdsSounds — системные звуковые сигналы кухни.
 *  - новое блюдо: короткий notification-сигнал;
 *  - отмена: тревожный alarm-сигнал (громче, отдельный поток), гасится через 2с.
 * Использует системные рингтоны (настройка громкости — системная, «системный + настройка»).
 */
@Singleton
class KdsSounds @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val main = Handler(Looper.getMainLooper())
    private var alarm: Ringtone? = null

    fun playNew() {
        // USAGE_ALARM → играет даже в «беззвучном»/DND режиме (кухонный планшет
        // часто замьючен). Звук — notification-рингтон (короткий), но на alarm-потоке.
        val r = play(RingtoneManager.TYPE_NOTIFICATION, AudioAttributes.USAGE_ALARM) ?: return
        main.postDelayed({ runCatching { r.stop() } }, 3000)
    }

    fun playCancel() {
        val r = play(RingtoneManager.TYPE_ALARM, AudioAttributes.USAGE_ALARM) ?: return
        alarm = r
        // Не даём alarm-рингтону звучать бесконечно — гасим через 2 секунды.
        main.postDelayed({ runCatching { r.stop() } }, 2000)
    }

    private fun play(type: Int, usage: Int): Ringtone? = runCatching {
        val uri = RingtoneManager.getActualDefaultRingtoneUri(context, type)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val r = RingtoneManager.getRingtone(context, uri) ?: return null
        r.audioAttributes = AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        r.play()
        r
    }.getOrNull()
}
