package com.restos.kds.data

import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import javax.inject.Inject
import javax.inject.Singleton

/**
 * KdsSounds — громкие сигналы кухни на потоке ALARM (слышно даже в беззвучном/DND
 * режиме и на замьюченном планшете). Несколько пресетов на выбор — синтез через
 * ToneGenerator, без бинарных ассетов. Громкость — максимальная для alarm-потока.
 */
@Singleton
class KdsSounds @Inject constructor() {

    data class Preset(val name: String, private val tone: Int, val durationMs: Int) {
        val toneType get() = tone
    }

    // Порядок = id пресета (хранится в настройках).
    val presets = listOf(
        Preset("Двойной бип", ToneGenerator.TONE_PROP_BEEP2, 700),
        Preset("Длинный сигнал", ToneGenerator.TONE_CDMA_HIGH_L, 1300),
        Preset("Тревога", ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 1500),
        Preset("Звонок", ToneGenerator.TONE_CDMA_ABBR_ALERT, 1000),
        Preset("Сирена", ToneGenerator.TONE_CDMA_ABBR_REORDER, 1500),
    )

    private val main = Handler(Looper.getMainLooper())

    /** Сигнал «новое блюдо» выбранным пресетом. */
    fun playNew(soundId: Int) = playTone(soundId)

    /** Превью пресета (кнопка ▶ в настройках). */
    fun preview(soundId: Int) = playTone(soundId)

    /** Отмена — всегда тревожный пресет, отдельно от выбранного. */
    fun playCancel() = playTone(2)

    private fun playTone(soundId: Int) {
        val p = presets.getOrElse(soundId) { presets.first() }
        runCatching {
            val tg = ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME)
            tg.startTone(p.toneType, p.durationMs)
            main.postDelayed({ runCatching { tg.release() } }, (p.durationMs + 400).toLong())
        }
    }
}
