package com.restos.zakup.data.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import javax.inject.Inject
import javax.inject.Singleton

/** Результат сверки установленной версии с той, что раздаёт касса. */
data class UpdateCheck(
    val available: Boolean,
    val serverVersionCode: Int,
    val serverVersionName: String,
    val installedVersionCode: Long,
    val installedVersionName: String,
) {
    val updateAvailable: Boolean get() = available && serverVersionCode > installedVersionCode
}

/**
 * LAN-автообновление приложения закупщика (зеркало официанта): сверяем версию с
 * кассой, качаем APK по LAN и запускаем системную установку (в один тап).
 */
@Singleton
class AppUpdateManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: ZakupAppApi,
) {
    val installedVersionName: String
        get() = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull() ?: ""

    val installedVersionCode: Long
        get() = runCatching {
            val pi = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode
            else @Suppress("DEPRECATION") pi.versionCode.toLong()
        }.getOrDefault(0L)

    suspend fun check(): UpdateCheck = withContext(Dispatchers.IO) {
        val info = api.info()
        UpdateCheck(
            available = info.available,
            serverVersionCode = info.versionCode,
            serverVersionName = info.version,
            installedVersionCode = installedVersionCode,
            installedVersionName = installedVersionName,
        )
    }

    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun requestInstallPermission() {
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    suspend fun download(onProgress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val body = api.downloadApk()
        val total = body.contentLength()
        val file = File(context.cacheDir, "zakup-update.apk")
        body.byteStream().use { input ->
            FileOutputStream(file).use { output ->
                val buf = ByteArray(64 * 1024)
                var downloaded = 0L
                while (true) {
                    val read = input.read(buf)
                    if (read < 0) break
                    output.write(buf, 0, read)
                    downloaded += read
                    if (total > 0) onProgress((downloaded.toFloat() / total).coerceIn(0f, 1f))
                }
            }
        }
        file
    }

    fun install(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
    }
}
