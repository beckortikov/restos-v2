package com.restos.waiter.data.update

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.ResponseBody
import retrofit2.http.GET
import retrofit2.http.Streaming

/**
 * API раздачи APK официанта кассой (см. server: handlers/waiter_app.go).
 * - info: какая версия сейчас лежит на кассе (для сравнения при автообновлении).
 * - downloadApk: сам файл (публичный путь вне /api/v1; host подставит
 *   HostRedirectInterceptor). @Streaming — качаем в файл с прогрессом.
 */
interface WaiterAppApi {
    @GET("api/v1/waiter-app")
    suspend fun info(): WaiterAppInfoDto

    @Streaming
    @GET("download/waiter.apk")
    suspend fun downloadApk(): ResponseBody
}

@Serializable
data class WaiterAppInfoDto(
    val available: Boolean = false,
    val version: String = "",
    @SerialName("version_code") val versionCode: Int = 0,
    @SerialName("file_name") val fileName: String = "",
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("uploaded_at") val uploadedAt: String? = null,
    @SerialName("download_path") val downloadPath: String = "",
)
