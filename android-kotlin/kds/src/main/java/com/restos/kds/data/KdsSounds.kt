package com.restos.kds.data

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import com.restos.kds.R
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * KdsSounds — приятные, но громкие сигналы кухни. Пресеты — реальные WAV-чаймы
 * (колокол/маримба/динь-дон) из res/raw, проигрываются через SoundPool на потоке
 * ALARM (слышно даже в беззвучном/DND и на замьюченном планшете) с максимальной
 * громкостью. Если сэмпл ещё не догрузился — мягкий фолбэк на ToneGenerator,
 * чтобы сигнал не пропал.
 */
@Singleton
class KdsSounds @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    data class Preset(val name: String, val resId: Int, val fallbackTone: Int)

    // Порядок = id пресета (хранится в настройках).
    val presets = listOf(
        Preset("Нежный звон", R.raw.chime_soft, ToneGenerator.TONE_PROP_BEEP2),
        Preset("Динь-дон", R.raw.chime_ding, ToneGenerator.TONE_CDMA_ABBR_ALERT),
        Preset("Маримба", R.raw.chime_marimba, ToneGenerator.TONE_PROP_BEEP2),
        Preset("Колокольчик", R.raw.chime_bell, ToneGenerator.TONE_CDMA_HIGH_L),
        Preset("Тревога", R.raw.alarm_urgent, ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD),
    )

    private val main = Handler(Looper.getMainLooper())

    private val pool: SoundPool = SoundPool.Builder()
        .setMaxStreams(2)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        .build()

    // sampleId (из pool.load) → индекс пресета; и обратный маппинг.
    private val sampleIds = IntArray(presets.size)
    private val ready = ConcurrentHashMap<Int, Boolean>()

    init {
        pool.setOnLoadCompleteListener { _, sampleId, status ->
            if (status == 0) ready[sampleId] = true
        }
        presets.forEachIndexed { i, p ->
            sampleIds[i] = runCatching { pool.load(context, p.resId, 1) }.getOrDefault(0)
        }
    }

    /** Сигнал «новое блюдо» выбранным пресетом. */
    fun playNew(soundId: Int) = play(soundId)

    /** Превью пресета (кнопка ▶ в настройках). */
    fun preview(soundId: Int) = play(soundId)

    /** Отмена — всегда «Тревога», отдельно от выбранного. */
    fun playCancel() = play(presets.lastIndex)

    private fun play(soundId: Int) {
        val idx = soundId.coerceIn(0, presets.lastIndex)
        val sampleId = sampleIds[idx]
        if (sampleId != 0 && ready[sampleId] == true) {
            // Полная громкость; повторов нет; rate 1.0.
            pool.play(sampleId, 1f, 1f, 1, 0, 1f)
        } else {
            // Сэмпл ещё грузится (первые ~секунды после старта) — фолбэк на тон.
            playFallbackTone(presets[idx].fallbackTone)
        }
    }

    private fun playFallbackTone(tone: Int) {
        runCatching {
            val tg = ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME)
            tg.startTone(tone, 800)
            main.postDelayed({ runCatching { tg.release() } }, 1200)
        }
    }
}
