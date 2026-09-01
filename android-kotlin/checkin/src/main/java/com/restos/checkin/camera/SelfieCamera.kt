package com.restos.checkin.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Base64
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * Фронтальная камера терминала: один кадр в момент подтверждения отметки.
 *
 * Превью на экран НЕ выводим сознательно. Терминал висит у входа, сотрудник
 * подтверждает своё имя и уходит — окно с собственным лицом только замедляло
 * бы очередь и провоцировало позировать. Снимок — доказательство постфактум,
 * а не селфи-режим.
 *
 * Камера привязывается к жизненному циклу экрана и держится открытой, пока
 * экран жив: биндить провайдер на каждую отметку значило бы ждать 1–2 секунды
 * инициализации ровно в тот момент, когда человек уже нажал кнопку.
 */
class SelfieCamera(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private var capture: ImageCapture? = null
    private var bound = false

    /** true — камера готова снимать. */
    val isReady: Boolean get() = capture != null

    fun start(onReady: (Boolean) -> Unit = {}) {
        if (bound) { onReady(isReady); return }
        bound = true
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val ok = runCatching {
                val provider = future.get()
                val imageCapture = ImageCapture.Builder()
                    // Скорость важнее качества: кадр всё равно ужимается до
                    // 640px, а человек не должен ждать у планшета.
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                provider.unbindAll()
                provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_FRONT_CAMERA,
                    imageCapture,
                )
                capture = imageCapture
                true
            }.getOrElse {
                // Нет фронтальной камеры / занята другим приложением — терминал
                // продолжает принимать отметки без снимков.
                capture = null
                false
            }
            onReady(ok)
        }, androidx.core.content.ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        capture = null
        bound = false
    }

    /**
     * Снимок в base64 JPEG (~640px). null, если камера недоступна или кадр не
     * получился: отметку это не отменяет.
     */
    suspend fun capture(): String? {
        val imageCapture = capture ?: return null
        return suspendCoroutine { cont ->
            imageCapture.takePicture(
                executor,
                object : ImageCapture.OnImageCapturedCallback() {
                    override fun onCaptureSuccess(image: ImageProxy) {
                        val encoded = runCatching { image.toCompressedBase64() }.getOrNull()
                        image.close()
                        cont.resume(encoded)
                    }

                    override fun onError(exception: ImageCaptureException) {
                        cont.resume(null)
                    }
                },
            )
        }
    }
}

/**
 * ImageProxy → JPEG base64, сторона не больше [MAX_SIDE], качество
 * [JPEG_QUALITY]. Сжимаем на устройстве, а не на сервере: по LAN и так летит
 * base64 (+33% к размеру), и слать полный кадр камеры было бы расточительно.
 */
private fun ImageProxy.toCompressedBase64(): String? {
    val buffer = planes[0].buffer
    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
    val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null

    val scale = MAX_SIDE.toFloat() / maxOf(raw.width, raw.height).toFloat()
    val scaled = if (scale >= 1f) raw else Bitmap.createScaledBitmap(
        raw,
        (raw.width * scale).toInt().coerceAtLeast(1),
        (raw.height * scale).toInt().coerceAtLeast(1),
        true,
    )

    // Фронтальная камера отдаёт кадр повёрнутым по ориентации устройства —
    // без доворота лица в ленте лежали бы на боку.
    val rotation = imageInfo.rotationDegrees
    val upright = if (rotation == 0) scaled else Bitmap.createBitmap(
        scaled, 0, 0, scaled.width, scaled.height,
        Matrix().apply { postRotate(rotation.toFloat()) },
        true,
    )

    val out = ByteArrayOutputStream()
    upright.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

private const val MAX_SIDE = 640
private const val JPEG_QUALITY = 60
