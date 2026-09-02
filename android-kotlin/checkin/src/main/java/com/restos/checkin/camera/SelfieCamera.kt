package com.restos.checkin.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Base64
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/** Результат съёмки: снимок и то, нашлось ли на нём лицо. */
data class SelfieShot(
    /** JPEG в base64 (~640px). null — кадр не получился. */
    val photoBase64: String?,
    /** true — в кадре есть лицо достаточного размера. */
    val faceFound: Boolean,
)

/**
 * Фронтальная камера терминала: кадр в момент отметки + проверка, что в нём
 * есть человек.
 *
 * Детекция лица, НЕ распознавание личности. Мы не отвечаем на вопрос «кто
 * это» — только «в кадре кто-то есть». Этого достаточно, чтобы снимок работал
 * доказательством: закрыть камеру пальцем и отметить за товарища больше не
 * получится, а кто на снимке — видно человеку в перекличке.
 *
 * Камера привязана к жизненному циклу экрана и держится открытой, пока экран
 * жив: биндить провайдер на каждую отметку значило бы ждать 1–2 секунды
 * инициализации ровно в тот момент, когда человек уже ввёл PIN.
 */
class SelfieCamera(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var capture: ImageCapture? = null
    private var bound = false

    private val _faceInFrame = MutableStateFlow(false)

    /**
     * Есть ли лицо в кадре ПРЯМО СЕЙЧАС — по потоку с камеры, а не по
     * сделанному снимку. Экран показывает это человеку до отметки: иначе он
     * узнаёт, что не попал в кадр, уже после нажатия, и всё начинается
     * заново.
     */
    val faceInFrame: StateFlow<Boolean> = _faceInFrame.asStateFlow()

    /** PreviewView для экрана — человек должен видеть, попал ли он в кадр. */
    val previewView: PreviewView by lazy {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    // Детектор в режиме FAST: нам нужен факт присутствия лица, а не контуры и
    // мимика — точная модель тратила бы сотни миллисекунд на каждую отметку.
    private val detector by lazy {
        FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                // Лицо должно занимать хотя бы 15% кадра: так отсекается
                // человек, случайно попавший в кадр в глубине коридора, —
                // отмечается тот, кто стоит у планшета.
                .setMinFaceSize(0.15f)
                .build(),
        )
    }

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
                    // Просим у камеры МАЛЕНЬКИЙ кадр. Без этого планшет отдаёт
                    // максимум своей матрицы (8–12 Мп), и один только Bitmap
                    // такого кадра — десятки мегабайт: на дешёвом устройстве
                    // это OutOfMemory прямо в потоке камеры, то есть падение
                    // всего приложения, а не отказ снимка.
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(
                                    Size(960, 1280),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                                ),
                            )
                            .build(),
                    )
                    .build()
                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }
                // Анализ потока для живого статуса «лицо в кадре».
                // KEEP_ONLY_LATEST: детектор медленнее камеры, и очередь
                // кадров означала бы, что индикатор показывает прошлое.
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(
                                    Size(480, 640),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                                ),
                            )
                            .build(),
                    )
                    .build()
                    .also { it.setAnalyzer(analysisExecutor, ::analyzeFrame) }
                provider.unbindAll()
                provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_FRONT_CAMERA,
                    imageCapture,
                    preview,
                    analysis,
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
        }, ContextCompat.getMainExecutor(context))
    }

    /**
     * Анализ одного кадра потока. Состояние меняем только когда результат
     * повторился [FACE_STABLE_FRAMES] раз подряд: детектор на дешёвой камере
     * иногда «моргает», и без сглаживания индикатор дёргался бы между «лицо
     * в кадре» и «нет» несколько раз в секунду.
     */
    @androidx.camera.core.ExperimentalGetImage
    private fun analyzeFrame(proxy: ImageProxy) {
        val media = proxy.image
        if (media == null) { proxy.close(); return }
        val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        detector.process(input)
            .addOnSuccessListener { faces -> onFaceResult(faces.isNotEmpty()) }
            .addOnCompleteListener { proxy.close() }
    }

    private var stableCount = 0
    private var lastSeen = false

    private fun onFaceResult(found: Boolean) {
        if (found == lastSeen) {
            stableCount++
        } else {
            lastSeen = found
            stableCount = 1
        }
        if (stableCount >= FACE_STABLE_FRAMES && _faceInFrame.value != found) {
            _faceInFrame.value = found
        }
    }

    fun stop() {
        runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        capture = null
        bound = false
        _faceInFrame.value = false
    }

    /**
     * Снимок с проверкой лица. Возвращает null, если камера недоступна: это не
     * отменяет отметку — сломанная камера не повод не пустить человека на смену.
     */
    suspend fun capture(): SelfieShot? {
        val imageCapture = capture ?: return null
        // Явный тип: без него компилятор выводит Nothing? по первому
        // resume(null) в onError и ломается на resume(bitmap).
        // Таймаут: при закрытом объективе камера может уйти в бесконечный
        // перебор экспозиции и не вернуть кадр вовсе. Лучше отметить без
        // снимка, чем оставить человека смотреть на «Отмечаем…».
        val bitmap = withTimeoutOrNull(CAPTURE_TIMEOUT_MS) {
            suspendCancellableCoroutine<Bitmap?> { cont ->
                // Колбэки приходят в поток камеры. Любое исключение там — не
                // пойманная ошибка в чужом потоке, то есть падение процесса,
                // поэтому ловим ВСЁ, включая OutOfMemoryError, и резюмим один
                // раз: повторный resume сам по себе бросает IllegalState.
                val done = AtomicBoolean(false)
                fun finish(value: Bitmap?) {
                    if (done.compareAndSet(false, true) && cont.isActive) cont.resume(value) {}
                }
                runCatching {
                    imageCapture.takePicture(
                        executor,
                        object : ImageCapture.OnImageCapturedCallback() {
                            override fun onCaptureSuccess(image: ImageProxy) {
                                val bmp = try {
                                    image.toUprightBitmap()
                                } catch (t: Throwable) {
                                    null
                                } finally {
                                    runCatching { image.close() }
                                }
                                finish(bmp)
                            }

                            override fun onError(exception: ImageCaptureException) {
                                finish(null)
                            }
                        },
                    )
                }.onFailure { finish(null) }
            }
        } ?: return null

        val faceFound = try {
            detectFace(bitmap)
        } catch (t: Throwable) {
            true // своя поломка не должна мешать человеку отметиться
        }
        val encoded = try {
            bitmap.toJpegBase64()
        } catch (t: Throwable) {
            null
        }
        return SelfieShot(photoBase64 = encoded, faceFound = faceFound)
    }

    /** Есть ли в кадре лицо. Ошибка детектора трактуется как «есть»: своя
     *  поломка не должна мешать человеку отметиться. */
    private suspend fun detectFace(bitmap: Bitmap): Boolean =
        withTimeoutOrNull(DETECT_TIMEOUT_MS) {
            suspendCancellableCoroutine<Boolean> { cont ->
                val done = AtomicBoolean(false)
                fun finish(found: Boolean) {
                    if (done.compareAndSet(false, true) && cont.isActive) cont.resume(found) {}
                }
                runCatching {
                    detector.process(InputImage.fromBitmap(bitmap, 0))
                        .addOnSuccessListener { faces -> finish(faces.isNotEmpty()) }
                        .addOnFailureListener { finish(true) }
                }.onFailure { finish(true) }
            }
        } ?: true
}

/**
 * ImageProxy → Bitmap нужного размера и ориентации.
 *
 * Сжимаем на устройстве, а не на сервере: по LAN и так летит base64 (+33% к
 * размеру), слать полный кадр камеры было бы расточительно. Доворот
 * обязателен — фронтальная камера отдаёт кадр повёрнутым по ориентации
 * устройства, и без него лица в ленте лежали бы на боку (а детектор их не
 * находил бы вовсе).
 */
private fun ImageProxy.toUprightBitmap(): Bitmap? {
    val buffer = planes[0].buffer
    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }

    // Декодируем СРАЗУ уменьшенным (inSampleSize), а не «полный кадр, потом
    // ужмём»: полноразмерный Bitmap на планшете — десятки мегабайт, и OOM
    // случается именно на этом шаге.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE * 2) sample *= 2

    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null

    val scale = MAX_SIDE.toFloat() / maxOf(raw.width, raw.height).toFloat()
    val scaled = if (scale >= 1f) raw else Bitmap.createScaledBitmap(
        raw,
        (raw.width * scale).toInt().coerceAtLeast(1),
        (raw.height * scale).toInt().coerceAtLeast(1),
        true,
    )

    val rotation = imageInfo.rotationDegrees
    return if (rotation == 0) scaled else Bitmap.createBitmap(
        scaled, 0, 0, scaled.width, scaled.height,
        Matrix().apply { postRotate(rotation.toFloat()) },
        true,
    )
}

private fun Bitmap.toJpegBase64(): String {
    val out = ByteArrayOutputStream()
    compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

private const val MAX_SIDE = 640
private const val JPEG_QUALITY = 60

/** Сколько ждём кадр. При закрытом объективе камера может не вернуть его вовсе. */
private const val CAPTURE_TIMEOUT_MS = 6_000L

/** Детекция на 640px укладывается в десятки миллисекунд; секунда — это уже сбой. */
private const val DETECT_TIMEOUT_MS = 2_500L

/**
 * Сколько одинаковых результатов подряд нужно, чтобы поменять индикатор.
 * Два кадра — это ~150 мс: достаточно, чтобы убрать мигание, и незаметно для
 * человека, который просто встал перед планшетом.
 */
private const val FACE_STABLE_FRAMES = 2
