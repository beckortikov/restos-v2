package com.restos.core.net

import com.restos.core.BuildConfig
import com.restos.core.auth.AuthApi
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import javax.inject.Singleton

/**
 * CoreNetworkModule — общая сетевая инфраструктура для всех приложений
 * (официант :app, кухня :kds): Json, OkHttp с интерцепторами, Retrofit, AuthApi.
 *
 * Реальный host подменяется HostRedirectInterceptor из ServerConfigStore —
 * baseUrl здесь плейсхолдер только для инициализации Retrofit.
 *
 * Провайдеры доменных API (Orders/Menu/Tables/KDS…) живут в своих app-модулях
 * и создаются из этого Retrofit.
 */
@Module
@InstallIn(SingletonComponent::class)
object CoreNetworkModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    @Provides
    @Singleton
    fun provideNetworkConfig(): NetworkConfig =
        NetworkConfig(baseUrl = "http://placeholder.invalid/")

    @Provides
    @Singleton
    fun provideOkHttpClient(
        hostRedirect: HostRedirectInterceptor,
        authInterceptor: AuthInterceptor,
        idempotencyInterceptor: IdempotencyInterceptor,
    ): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }
        return OkHttpClient.Builder()
            .addInterceptor(hostRedirect)
            .addInterceptor(authInterceptor)
            .addInterceptor(idempotencyInterceptor)
            .addInterceptor(logging)
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(client: OkHttpClient, json: Json, config: NetworkConfig): Retrofit {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            .baseUrl(config.baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    @Provides
    @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)
}
