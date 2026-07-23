package com.restos.zakup.data.update

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.ResponseBody
import retrofit2.http.GET
import retrofit2.http.Streaming

/**
 * API раздачи APK закупщика кассой (server: handlers/app_dist.go).
 * - info: версия, лежащая на кассе (для сравнения при автообновлении).
 * - downloadApk: файл (публичный путь вне /api/v1; host подставит
 *   HostRedirectInterceptor). @Streaming — качаем в файл с прогрессом.
 */
interface ZakupAppApi {
    @GET("api/v1/zakup-app")
    suspend fun info(): ZakupAppInfoDto

    @Streaming
    @GET("download/zakup.apk")
    suspend fun downloadApk(): ResponseBody
}

@Serializable
data class ZakupAppInfoDto(
    val available: Boolean = false,
    val version: String = "",
    @SerialName("version_code") val versionCode: Int = 0,
    @SerialName("file_name") val fileName: String = "",
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("uploaded_at") val uploadedAt: String? = null,
    @SerialName("download_path") val downloadPath: String = "",
)
